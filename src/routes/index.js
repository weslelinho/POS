const express = require('express');
const bcrypt = require('bcryptjs');
const { requireAuth, requireAdmin, requireSellerOrAdmin } = require('../middleware/auth');
const { createSale, registerCreditPayment } = require('../services/saleService');
const {
  getOpenSession,
  getSessionSummary,
  openSession,
  addSupply,
  addBleed,
  closeSession,
  listRecentSessions,
} = require('../services/cashService');
const { getSalesReport } = require('../services/salesReportService');
const { writeSalesReportPdf } = require('../services/pdfSalesReport');
const { writeCreditReportPdf } = require('../services/pdfCreditReport');
const {
  upload,
  finalizeProductImage,
  discardTempUpload,
} = require('../services/productImage');

/** Converte valor BR (ex.: 10,50 ou 1.234,56) em centavos. */
function parseMoneyToCents(raw, { allowZero = false } = {}) {
  const text = String(raw ?? '').trim();
  if (!text) throw new Error('Informe um valor.');
  const normalized = text.includes(',')
    ? text.replace(/\./g, '').replace(',', '.')
    : text;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error('Valor inválido.');
  }
  const cents = Math.round(parsed * 100);
  if (!allowZero && cents <= 0) throw new Error('Informe um valor maior que zero.');
  return cents;
}

function loadCreditLedgerWithItems(db, customerId) {
  const ledger = db
    .prepare(
      `SELECT * FROM credit_ledger WHERE customer_id = ? ORDER BY created_at DESC LIMIT 50`
    )
    .all(customerId);

  const saleIds = [...new Set(ledger.map((row) => row.sale_id).filter(Boolean))];
  const salesById = {};
  const itemsBySaleId = {};

  if (saleIds.length) {
    const placeholders = saleIds.map(() => '?').join(',');
    const sales = db
      .prepare(
        `SELECT id, sale_number, subtotal_cents, discount_cents, total_cents,
                amount_paid_cents, payment_status, payment_method, sold_at
         FROM sales WHERE id IN (${placeholders})`
      )
      .all(...saleIds);
    for (const sale of sales) {
      salesById[sale.id] = sale;
      itemsBySaleId[sale.id] = [];
    }

    const items = db
      .prepare(
        `SELECT sale_id, product_name, unit_price_cents, quantity, line_total_cents
         FROM sale_items
         WHERE sale_id IN (${placeholders})
         ORDER BY id ASC`
      )
      .all(...saleIds);
    for (const item of items) {
      if (!itemsBySaleId[item.sale_id]) itemsBySaleId[item.sale_id] = [];
      itemsBySaleId[item.sale_id].push(item);
    }
  }

  return ledger.map((row) => ({
    ...row,
    sale: row.sale_id ? salesById[row.sale_id] || null : null,
    items: row.sale_id ? itemsBySaleId[row.sale_id] || [] : [],
  }));
}

function createRouter(db) {
  const router = express.Router();

  router.get('/', (req, res) => {
    if (req.session?.user) return res.redirect('/dashboard');
    return res.redirect('/login');
  });

  router.get('/login', (req, res) => {
    if (req.session?.user) return res.redirect('/dashboard');
    res.render('login', { title: 'Login', error: null });
  });

  router.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = db
      .prepare('SELECT * FROM users WHERE username = ? AND active = 1')
      .get(String(username || '').trim());

    if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
      return res.status(401).render('login', {
        title: 'Login',
        error: 'Usuário ou senha inválidos.',
      });
    }

    req.session.user = {
      id: user.id,
      name: user.name,
      username: user.username,
      role: user.role,
    };

    return res.redirect('/dashboard');
  });

  router.post('/logout', requireAuth, (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
  });

  router.get('/dashboard', requireAuth, (req, res) => {
    const openCash = getOpenSession(db);
    const cashSummary = openCash ? getSessionSummary(db, openCash) : null;

    const stats = {
      salesToday: db
        .prepare(
          `SELECT COUNT(*) AS c, COALESCE(SUM(total_cents), 0) AS total
           FROM sales WHERE status = 'completed' AND date(sold_at) = date('now', 'localtime')`
        )
        .get(),
      creditOpen: db
        .prepare(`SELECT COALESCE(SUM(balance_cents), 0) AS total FROM credit_accounts WHERE balance_cents > 0`)
        .get(),
      products: db.prepare(`SELECT COUNT(*) AS c FROM products WHERE active = 1`).get(),
      members: db.prepare(`SELECT COUNT(*) AS c FROM customers WHERE customer_type = 'member' AND active = 1`).get(),
      cashOpen: !!openCash,
      cashExpected: cashSummary?.totals.expected_cents ?? null,
    };

    res.render('dashboard', { title: 'Painel', stats });
  });

  // ---- Bases (chapters) ----
  router.get('/bases', requireSellerOrAdmin, (req, res) => {
    const bases = db
      .prepare('SELECT * FROM bases ORDER BY name COLLATE NOCASE')
      .all();
    res.render('bases/index', { title: 'Bases', bases });
  });

  router.get('/bases/new', requireSellerOrAdmin, (req, res) => {
    res.render('bases/form', { title: 'Nova base', base: null, error: null });
  });

  router.post('/bases', requireSellerOrAdmin, (req, res) => {
    const { name, city, state, notes } = req.body;
    try {
      if (!name?.trim()) throw new Error('Nome é obrigatório.');

      db.prepare(
        `INSERT INTO bases (name, city, state, notes) VALUES (?, ?, ?, ?)`
      ).run(name.trim(), city || null, state || null, notes || null);

      res.redirect('/bases');
    } catch (err) {
      res.status(400).render('bases/form', {
        title: 'Nova base',
        base: req.body,
        error: err.message,
      });
    }
  });

  // ---- Clientes ----
  function loadActiveBases() {
    return db
      .prepare(`SELECT id, name FROM bases WHERE active = 1 ORDER BY name COLLATE NOCASE`)
      .all();
  }

  function loadCustomers() {
    return db
      .prepare(
        `SELECT c.*, b.name AS base_name
         FROM customers c
         LEFT JOIN bases b ON b.id = c.base_id
         ORDER BY c.name COLLATE NOCASE`
      )
      .all();
  }

  function resolveCustomerPayload(body) {
    const { name, phone, document, customer_type, club_nickname, base_id, notes, active } = body;

    if (!name?.trim()) throw new Error('Nome é obrigatório.');
    if (!['member', 'external'].includes(customer_type)) {
      throw new Error('Tipo de cliente inválido.');
    }

    let resolvedBaseId = null;
    if (base_id) {
      resolvedBaseId = Number(base_id);
      const base = db.prepare('SELECT id FROM bases WHERE id = ? AND active = 1').get(resolvedBaseId);
      if (!base) throw new Error('Base inválida.');
    }

    const activeValue = active === undefined || active === null || active === ''
      ? 1
      : Number(active) === 1
        ? 1
        : 0;

    return {
      name: name.trim(),
      phone: phone || null,
      document: document || null,
      customer_type,
      club_nickname: club_nickname || null,
      base_id: resolvedBaseId,
      notes: notes || null,
      active: activeValue,
    };
  }

  router.get('/customers', requireSellerOrAdmin, (req, res) => {
    res.render('customers/index', {
      title: 'Clientes',
      customers: loadCustomers(),
      bases: loadActiveBases(),
      editError: null,
      editCustomerId: null,
    });
  });

  router.get('/customers/new', requireSellerOrAdmin, (req, res) => {
    res.render('customers/form', { title: 'Novo cliente', customer: null, bases: loadActiveBases(), error: null });
  });

  router.post('/customers', requireSellerOrAdmin, (req, res) => {
    const bases = loadActiveBases();

    try {
      const data = resolveCustomerPayload(req.body);

      const result = db
        .prepare(
          `INSERT INTO customers (name, phone, document, customer_type, club_nickname, base_id, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          data.name,
          data.phone,
          data.document,
          data.customer_type,
          data.club_nickname,
          data.base_id,
          data.notes
        );

      if (data.customer_type === 'member') {
        db.prepare('INSERT INTO credit_accounts (customer_id, balance_cents) VALUES (?, 0)').run(result.lastInsertRowid);
      }

      res.redirect('/customers');
    } catch (err) {
      res.status(400).render('customers/form', {
        title: 'Novo cliente',
        customer: req.body,
        bases,
        error: err.message,
      });
    }
  });

  router.post('/customers/:id', requireSellerOrAdmin, (req, res) => {
    const customerId = Number(req.params.id);
    const bases = loadActiveBases();

    try {
      const existing = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
      if (!existing) throw new Error('Cliente não encontrado.');

      const data = resolveCustomerPayload(req.body);

      db.prepare(
        `UPDATE customers
         SET name = ?, phone = ?, document = ?, customer_type = ?, club_nickname = ?,
             base_id = ?, notes = ?, active = ?, updated_at = datetime('now', 'localtime')
         WHERE id = ?`
      ).run(
        data.name,
        data.phone,
        data.document,
        data.customer_type,
        data.club_nickname,
        data.base_id,
        data.notes,
        data.active,
        customerId
      );

      if (data.customer_type === 'member') {
        const account = db.prepare('SELECT customer_id FROM credit_accounts WHERE customer_id = ?').get(customerId);
        if (!account) {
          db.prepare('INSERT INTO credit_accounts (customer_id, balance_cents) VALUES (?, 0)').run(customerId);
        }
      }

      res.redirect('/customers');
    } catch (err) {
      res.status(400).render('customers/index', {
        title: 'Clientes',
        customers: loadCustomers(),
        bases,
        editError: err.message,
        editCustomerId: customerId,
        editCustomer: { id: customerId, ...req.body },
      });
    }
  });

  // ---- Usuários (admin) ----
  function listUsers() {
    return db
      .prepare('SELECT id, name, username, role, active, created_at FROM users ORDER BY name')
      .all();
  }

  function countActiveAdmins(excludeId = null) {
    if (excludeId == null) {
      return db
        .prepare(`SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND active = 1`)
        .get().total;
    }
    return db
      .prepare(
        `SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND active = 1 AND id != ?`
      )
      .get(excludeId).total;
  }

  router.get('/users', requireAdmin, (req, res) => {
    res.render('users/index', { title: 'Usuários', users: listUsers() });
  });

  router.get('/users/new', requireAdmin, (req, res) => {
    res.render('users/form', { title: 'Novo usuário', userForm: null, error: null });
  });

  router.post('/users', requireAdmin, (req, res) => {
    const { name, username, password, role } = req.body;
    try {
      if (!name?.trim() || !username?.trim() || !password) {
        throw new Error('Preencha nome, usuário e senha.');
      }
      if (!['admin', 'seller'].includes(role)) throw new Error('Perfil inválido.');

      const hash = bcrypt.hashSync(password, 10);
      db.prepare(
        `INSERT INTO users (name, username, password_hash, role) VALUES (?, ?, ?, ?)`
      ).run(name.trim(), username.trim(), hash, role);

      res.redirect('/users');
    } catch (err) {
      res.status(400).render('users/form', {
        title: 'Novo usuário',
        userForm: req.body,
        error: err.message.includes('UNIQUE') ? 'Nome de usuário já existe.' : err.message,
      });
    }
  });

  router.post('/users/:id', requireAdmin, (req, res) => {
    const userId = Number(req.params.id);
    const { name, username, password, role, active } = req.body;

    try {
      const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      if (!existing) throw new Error('Usuário não encontrado.');

      if (!name?.trim() || !username?.trim()) {
        throw new Error('Preencha nome e usuário.');
      }
      if (!['admin', 'seller'].includes(role)) throw new Error('Perfil inválido.');

      const isActive = active === '0' || active === 0 ? 0 : 1;
      const wasActiveAdmin = existing.role === 'admin' && existing.active === 1;
      const willBeActiveAdmin = role === 'admin' && isActive === 1;

      if (wasActiveAdmin && !willBeActiveAdmin && countActiveAdmins(userId) === 0) {
        throw new Error('É necessário manter ao menos um administrador ativo.');
      }

      if (password) {
        const hash = bcrypt.hashSync(password, 10);
        db.prepare(
          `UPDATE users
           SET name = ?, username = ?, password_hash = ?, role = ?, active = ?,
               updated_at = datetime('now', 'localtime')
           WHERE id = ?`
        ).run(name.trim(), username.trim(), hash, role, isActive, userId);
      } else {
        db.prepare(
          `UPDATE users
           SET name = ?, username = ?, role = ?, active = ?,
               updated_at = datetime('now', 'localtime')
           WHERE id = ?`
        ).run(name.trim(), username.trim(), role, isActive, userId);
      }

      if (req.session?.user?.id === userId) {
        if (!isActive) {
          return req.session.destroy(() => res.redirect('/login'));
        }
        req.session.user = {
          id: userId,
          name: name.trim(),
          username: username.trim(),
          role,
        };
      }

      res.redirect('/users');
    } catch (err) {
      res.status(400).render('users/index', {
        title: 'Usuários',
        users: listUsers(),
        editError: err.message.includes('UNIQUE') ? 'Nome de usuário já existe.' : err.message,
        editUserId: userId,
        editUser: { id: userId, ...req.body },
      });
    }
  });

  // ---- Produtos ----
  function listProducts() {
    return db.prepare('SELECT * FROM products ORDER BY name COLLATE NOCASE').all();
  }

  function handleProductImageUpload(req, res, next) {
    upload.single('image')(req, res, (err) => {
      if (!err) return next();
      const message =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'A imagem deve ter no máximo 2 MB.'
          : err.message || 'Falha no envio da imagem.';

      if (req.params?.id) {
        const productId = Number(req.params.id);
        const row = db.prepare('SELECT image_path FROM products WHERE id = ?').get(productId);
        return res.status(400).render('products/index', {
          title: 'Produtos',
          products: listProducts(),
          editError: message,
          editProductId: productId,
          editProduct: {
            id: productId,
            ...(req.body || {}),
            image_path: row?.image_path || '',
          },
        });
      }

      return res.status(400).render('products/form', {
        title: 'Novo produto',
        product: req.body || {},
        error: message,
      });
    });
  }

  router.get('/products', requireSellerOrAdmin, (req, res) => {
    res.render('products/index', { title: 'Produtos', products: listProducts() });
  });

  router.get('/products/new', requireAdmin, (req, res) => {
    res.render('products/form', { title: 'Novo produto', product: null, error: null });
  });

  router.post('/products', requireAdmin, handleProductImageUpload, (req, res) => {
    try {
      const { name, description, price, category, stock_qty } = req.body;
      if (!name?.trim()) throw new Error('Nome é obrigatório.');
      const priceCents = Math.round(Number(String(price).replace(',', '.')) * 100);
      if (Number.isNaN(priceCents) || priceCents < 0) throw new Error('Preço inválido.');

      const stock = stock_qty === '' || stock_qty == null ? null : Number(stock_qty);

      const result = db
        .prepare(
          `INSERT INTO products (name, description, price_cents, category, stock_qty)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(name.trim(), description || null, priceCents, category || null, stock);

      const productId = Number(result.lastInsertRowid);
      if (req.file) {
        const imagePath = finalizeProductImage(productId, req.file, null);
        db.prepare(
          `UPDATE products
           SET image_path = ?, updated_at = datetime('now', 'localtime')
           WHERE id = ?`
        ).run(imagePath, productId);
      }

      res.redirect('/products');
    } catch (err) {
      discardTempUpload(req.file);
      res.status(400).render('products/form', {
        title: 'Novo produto',
        product: req.body,
        error: err.message,
      });
    }
  });

  router.post('/products/:id', requireAdmin, handleProductImageUpload, (req, res) => {
    const productId = Number(req.params.id);
    let existingImagePath = '';

    try {
      const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
      if (!existing) throw new Error('Produto não encontrado.');
      existingImagePath = existing.image_path || '';

      const { name, description, price, category, stock_qty, active } = req.body;
      if (!name?.trim()) throw new Error('Nome é obrigatório.');
      const priceCents = Math.round(Number(String(price).replace(',', '.')) * 100);
      if (Number.isNaN(priceCents) || priceCents < 0) throw new Error('Preço inválido.');

      const stock = stock_qty === '' || stock_qty == null ? null : Number(stock_qty);
      const isActive = active === '0' || active === 0 ? 0 : 1;
      const imagePath = req.file
        ? finalizeProductImage(productId, req.file, existing.image_path)
        : existing.image_path;

      db.prepare(
        `UPDATE products
         SET name = ?, description = ?, price_cents = ?, category = ?, stock_qty = ?,
             image_path = ?, active = ?, updated_at = datetime('now', 'localtime')
         WHERE id = ?`
      ).run(
        name.trim(),
        description || null,
        priceCents,
        category || null,
        stock,
        imagePath || null,
        isActive,
        productId
      );

      res.redirect('/products');
    } catch (err) {
      discardTempUpload(req.file);
      if (!existingImagePath) {
        const row = db.prepare('SELECT image_path FROM products WHERE id = ?').get(productId);
        existingImagePath = row?.image_path || '';
      }
      res.status(400).render('products/index', {
        title: 'Produtos',
        products: listProducts(),
        editError: err.message,
        editProductId: productId,
        editProduct: { id: productId, ...req.body, image_path: existingImagePath },
      });
    }
  });

  // ---- PDV / Nova venda ----
  function loadSaleFormData() {
    return {
      products: db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY name').all(),
      members: db
        .prepare(`SELECT * FROM customers WHERE active = 1 AND customer_type = 'member' ORDER BY name`)
        .all(),
      externals: db
        .prepare(`SELECT * FROM customers WHERE active = 1 AND customer_type = 'external' ORDER BY name`)
        .all(),
    };
  }

  router.get('/sales/new', requireSellerOrAdmin, (req, res) => {
    const flash = req.session.flash || {};
    delete req.session.flash;

    res.render('sales/new', {
      title: 'Nova venda',
      ...loadSaleFormData(),
      error: flash.error || null,
      success: flash.success || null,
    });
  });

  router.post('/sales', requireSellerOrAdmin, (req, res) => {
    try {
      const { payment_method, customer_id, notes, cash_received, remainder_as_credit } = req.body;
      let items = req.body.items;

      if (typeof items === 'string') {
        items = items.trim() ? JSON.parse(items) : [];
      }
      if (!Array.isArray(items)) {
        throw new Error('Itens da venda inválidos.');
      }

      let amountReceivedCents = null;
      if (payment_method === 'cash' && cash_received != null && String(cash_received).trim() !== '') {
        const raw = String(cash_received).trim();
        const normalized = raw.includes(',')
          ? raw.replace(/\./g, '').replace(',', '.')
          : raw;
        const parsed = Number(normalized);
        if (!Number.isFinite(parsed) || parsed < 0) {
          throw new Error('Valor em dinheiro inválido.');
        }
        amountReceivedCents = Math.round(parsed * 100);
      }

      const result = createSale(db, {
        customerId: customer_id ? Number(customer_id) : null,
        sellerId: req.session.user.id,
        paymentMethod: payment_method,
        items,
        notes: notes || null,
        amountReceivedCents,
        remainderAsCredit: remainder_as_credit === '1' || remainder_as_credit === 'on',
      });

      const formatBrl = (cents) =>
        (Number(cents || 0) / 100).toLocaleString('pt-BR', {
          style: 'currency',
          currency: 'BRL',
        });

      let success = `Venda ${result.saleNumber} registrada. Total: ${formatBrl(result.total_cents)}`;
      if (result.change_cents > 0) {
        success += ` · Troco: ${formatBrl(result.change_cents)}`;
      }
      if (result.credit_cents > 0) {
        success += ` · Fiado: ${formatBrl(result.credit_cents)}`;
      }

      req.session.flash = { success };
      return res.redirect('/sales/new');
    } catch (err) {
      console.error('[POST /sales]', err);
      req.session.flash = { error: err.message || 'Não foi possível registrar a venda.' };
      return res.redirect('/sales/new');
    }
  });

  router.get('/sales', requireSellerOrAdmin, (req, res) => {
    const report = getSalesReport(db, { from: req.query.from, to: req.query.to });
    res.render('sales/index', {
      title: 'Vendas',
      sales: report.sales,
      summary: report.summary,
      fromDate: report.period.fromDate,
      toDate: report.period.toDate,
    });
  });

  router.get('/sales/export.pdf', requireSellerOrAdmin, (req, res) => {
    const report = getSalesReport(db, { from: req.query.from, to: req.query.to });
    const filename = `vendas_${report.period.fromDate}_${report.period.toDate}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    writeSalesReportPdf(res, report);
  });

  // ---- Fiado ----
  router.get('/credit', requireSellerOrAdmin, (req, res) => {
    const accounts = db
      .prepare(
        `SELECT ca.*, c.name, c.club_nickname, c.phone
         FROM credit_accounts ca
         JOIN customers c ON c.id = ca.customer_id
         WHERE ca.balance_cents > 0
         ORDER BY ca.balance_cents DESC`
      )
      .all();
    res.render('credit/index', { title: 'Fiado em aberto', accounts, error: null, success: null });
  });

  router.get('/credit/:customerId', requireSellerOrAdmin, (req, res) => {
    const customerId = Number(req.params.customerId);
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    const account = db.prepare('SELECT * FROM credit_accounts WHERE customer_id = ?').get(customerId);
    const ledger = loadCreditLedgerWithItems(db, customerId);

    if (!customer) return res.status(404).render('error', { title: 'Não encontrado', message: 'Cliente não encontrado.' });

    res.render('credit/detail', {
      title: `Fiado — ${customer.name}`,
      customer,
      account,
      ledger,
      error: null,
      success: null,
    });
  });

  router.get('/credit/:customerId/export.pdf', requireSellerOrAdmin, (req, res) => {
    const customerId = Number(req.params.customerId);
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    if (!customer) {
      return res.status(404).render('error', { title: 'Não encontrado', message: 'Cliente não encontrado.' });
    }

    const account = db.prepare('SELECT * FROM credit_accounts WHERE customer_id = ?').get(customerId);
    const ledger = loadCreditLedgerWithItems(db, customerId);
    const safeName = String(customer.name || 'cliente')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 40) || 'cliente';
    const filename = `fiado_${safeName}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    writeCreditReportPdf(res, { customer, account, ledger });
  });

  router.post('/credit/:customerId/pay', requireSellerOrAdmin, (req, res) => {
    const customerId = Number(req.params.customerId);
    try {
      const amountCents = Math.round(Number(String(req.body.amount).replace(',', '.')) * 100);
      registerCreditPayment(db, {
        customerId,
        amountCents,
        paymentMethod: req.body.payment_method,
        userId: req.session.user.id,
        notes: req.body.notes || null,
      });
      res.redirect(`/credit/${customerId}`);
    } catch (err) {
      const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
      const account = db.prepare('SELECT * FROM credit_accounts WHERE customer_id = ?').get(customerId);
      const ledger = loadCreditLedgerWithItems(db, customerId);

      res.status(400).render('credit/detail', {
        title: `Fiado — ${customer?.name || ''}`,
        customer,
        account,
        ledger,
        error: err.message,
        success: null,
      });
    }
  });

  // ---- Caixa (fundo de troco / sangria / suprimento) ----
  function renderCashPage(res, { error = null, success = null, status = 200 } = {}) {
    const open = getOpenSession(db);
    const summary = open ? getSessionSummary(db, open) : null;
    const recent = listRecentSessions(db, 15);

    return res.status(status).render('cash/index', {
      title: 'Caixa',
      summary,
      recent,
      error,
      success,
    });
  }

  router.get('/cash', requireSellerOrAdmin, (req, res) => {
    const flash = req.session.flash || {};
    delete req.session.flash;
    return renderCashPage(res, {
      error: flash.error || null,
      success: flash.success || null,
    });
  });

  router.post('/cash/open', requireSellerOrAdmin, (req, res) => {
    try {
      const openingFloatCents = parseMoneyToCents(req.body.opening_float, { allowZero: true });
      openSession(db, {
        userId: req.session.user.id,
        openingFloatCents,
        notes: req.body.notes?.trim() || null,
      });
      req.session.flash = { success: 'Caixa aberto com fundo de troco.' };
      return res.redirect('/cash');
    } catch (err) {
      return renderCashPage(res, { error: err.message, status: 400 });
    }
  });

  router.post('/cash/supply', requireSellerOrAdmin, (req, res) => {
    try {
      const amountCents = parseMoneyToCents(req.body.amount);
      addSupply(db, {
        userId: req.session.user.id,
        amountCents,
        notes: req.body.notes?.trim() || null,
      });
      req.session.flash = { success: 'Suprimento registrado.' };
      return res.redirect('/cash');
    } catch (err) {
      return renderCashPage(res, { error: err.message, status: 400 });
    }
  });

  router.post('/cash/bleed', requireSellerOrAdmin, (req, res) => {
    try {
      const amountCents = parseMoneyToCents(req.body.amount);
      addBleed(db, {
        userId: req.session.user.id,
        amountCents,
        notes: req.body.notes?.trim() || null,
      });
      req.session.flash = { success: 'Sangria registrada.' };
      return res.redirect('/cash');
    } catch (err) {
      return renderCashPage(res, { error: err.message, status: 400 });
    }
  });

  router.post('/cash/close', requireSellerOrAdmin, (req, res) => {
    try {
      let countedCents = null;
      if (req.body.counted_amount != null && String(req.body.counted_amount).trim() !== '') {
        countedCents = parseMoneyToCents(req.body.counted_amount, { allowZero: true });
      }

      const closed = closeSession(db, {
        userId: req.session.user.id,
        countedCents,
        notes: req.body.notes?.trim() || null,
      });

      const formatBrl = (cents) =>
        (Number(cents || 0) / 100).toLocaleString('pt-BR', {
          style: 'currency',
          currency: 'BRL',
        });

      let success = `Caixa fechado. Esperado: ${formatBrl(closed.totals.expected_cents)}`;
      if (closed.totals.closing_counted_cents != null) {
        success += ` · Contado: ${formatBrl(closed.totals.closing_counted_cents)}`;
        const diff = closed.totals.difference_cents;
        if (diff !== 0) {
          success += ` · Diferença: ${formatBrl(diff)}`;
        }
      }

      req.session.flash = { success };
      return res.redirect('/cash');
    } catch (err) {
      return renderCashPage(res, { error: err.message, status: 400 });
    }
  });

  return router;
}

module.exports = { createRouter };
