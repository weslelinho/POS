const express = require('express');
const bcrypt = require('bcryptjs');
const { requireAuth, requireAdmin, requireSellerOrAdmin } = require('../middleware/auth');
const { createSale, registerCreditPayment } = require('../services/saleService');

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
  router.get('/users', requireAdmin, (req, res) => {
    const users = db
      .prepare('SELECT id, name, username, role, active, created_at FROM users ORDER BY name')
      .all();
    res.render('users/index', { title: 'Usuários', users });
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

  // ---- Produtos ----
  router.get('/products', requireSellerOrAdmin, (req, res) => {
    const products = db.prepare('SELECT * FROM products ORDER BY name COLLATE NOCASE').all();
    res.render('products/index', { title: 'Produtos', products });
  });

  router.get('/products/new', requireAdmin, (req, res) => {
    res.render('products/form', { title: 'Novo produto', product: null, error: null });
  });

  router.post('/products', requireAdmin, (req, res) => {
    try {
      const { name, description, price, category, stock_qty } = req.body;
      if (!name?.trim()) throw new Error('Nome é obrigatório.');
      const priceCents = Math.round(Number(String(price).replace(',', '.')) * 100);
      if (Number.isNaN(priceCents) || priceCents < 0) throw new Error('Preço inválido.');

      const stock = stock_qty === '' || stock_qty == null ? null : Number(stock_qty);

      db.prepare(
        `INSERT INTO products (name, description, price_cents, category, stock_qty)
         VALUES (?, ?, ?, ?, ?)`
      ).run(name.trim(), description || null, priceCents, category || null, stock);

      res.redirect('/products');
    } catch (err) {
      res.status(400).render('products/form', {
        title: 'Novo produto',
        product: req.body,
        error: err.message,
      });
    }
  });

  router.post('/products/:id', requireAdmin, (req, res) => {
    const productId = Number(req.params.id);
    const products = () => db.prepare('SELECT * FROM products ORDER BY name COLLATE NOCASE').all();

    try {
      const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
      if (!existing) throw new Error('Produto não encontrado.');

      const { name, description, price, category, stock_qty, active } = req.body;
      if (!name?.trim()) throw new Error('Nome é obrigatório.');
      const priceCents = Math.round(Number(String(price).replace(',', '.')) * 100);
      if (Number.isNaN(priceCents) || priceCents < 0) throw new Error('Preço inválido.');

      const stock = stock_qty === '' || stock_qty == null ? null : Number(stock_qty);
      const isActive = active === '0' || active === 0 ? 0 : 1;

      db.prepare(
        `UPDATE products
         SET name = ?, description = ?, price_cents = ?, category = ?, stock_qty = ?,
             active = ?, updated_at = datetime('now', 'localtime')
         WHERE id = ?`
      ).run(
        name.trim(),
        description || null,
        priceCents,
        category || null,
        stock,
        isActive,
        productId
      );

      res.redirect('/products');
    } catch (err) {
      res.status(400).render('products/index', {
        title: 'Produtos',
        products: products(),
        editError: err.message,
        editProductId: productId,
        editProduct: { id: productId, ...req.body },
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
      const { payment_method, customer_id, notes } = req.body;
      let items = req.body.items;

      if (typeof items === 'string') {
        items = items.trim() ? JSON.parse(items) : [];
      }
      if (!Array.isArray(items)) {
        throw new Error('Itens da venda inválidos.');
      }

      const result = createSale(db, {
        customerId: customer_id ? Number(customer_id) : null,
        sellerId: req.session.user.id,
        paymentMethod: payment_method,
        items,
        notes: notes || null,
      });

      const totalLabel = (Number(result.total_cents || 0) / 100).toLocaleString('pt-BR', {
        style: 'currency',
        currency: 'BRL',
      });
      req.session.flash = {
        success: `Venda ${result.saleNumber} registrada. Total: ${totalLabel}`,
      };
      return res.redirect('/sales/new');
    } catch (err) {
      console.error('[POST /sales]', err);
      req.session.flash = { error: err.message || 'Não foi possível registrar a venda.' };
      return res.redirect('/sales/new');
    }
  });

  router.get('/sales', requireSellerOrAdmin, (req, res) => {
    const sales = db
      .prepare(
        `SELECT s.*, u.name AS seller_name, c.name AS customer_name
         FROM sales s
         JOIN users u ON u.id = s.seller_id
         LEFT JOIN customers c ON c.id = s.customer_id
         WHERE s.status = 'completed'
         ORDER BY s.sold_at DESC
         LIMIT 100`
      )
      .all();
    res.render('sales/index', { title: 'Vendas', sales });
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
    const ledger = db
      .prepare(
        `SELECT * FROM credit_ledger WHERE customer_id = ? ORDER BY created_at DESC LIMIT 50`
      )
      .all(customerId);

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
      const ledger = db
        .prepare(`SELECT * FROM credit_ledger WHERE customer_id = ? ORDER BY created_at DESC LIMIT 50`)
        .all(customerId);

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

  return router;
}

module.exports = { createRouter };
