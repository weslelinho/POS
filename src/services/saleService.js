/**
 * Regras de negócio de venda e fiado.
 * Valores monetários sempre em centavos (INTEGER).
 */

function assertCreditSaleAllowed(customer) {
  if (!customer) {
    throw new Error('Venda fiado exige cliente cadastrado.');
  }
  if (customer.customer_type !== 'member') {
    throw new Error('Venda fiado permitida apenas para membros do motoclube.');
  }
  if (!customer.active) {
    throw new Error('Cliente inativo não pode comprar a fiado.');
  }
}

function buildSaleTotals(items, discountCents = 0) {
  const subtotal = items.reduce((sum, item) => sum + item.unit_price_cents * item.quantity, 0);
  const discount = Math.max(0, Math.min(discountCents, subtotal));
  const total = subtotal - discount;
  return { subtotal_cents: subtotal, discount_cents: discount, total_cents: total };
}

function nextSaleNumber(db, date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const prefix = `V${y}${m}${d}-`;

  const row = db
    .prepare(`SELECT sale_number FROM sales WHERE sale_number LIKE ? ORDER BY id DESC LIMIT 1`)
    .get(`${prefix}%`);

  let seq = 1;
  if (row?.sale_number) {
    const part = Number(row.sale_number.split('-')[1]);
    if (!Number.isNaN(part)) seq = part + 1;
  }

  return `${prefix}${String(seq).padStart(4, '0')}`;
}

/**
 * Registra venda à vista (cash/pix) ou fiado (credit).
 * Em fiado: cria/atualiza credit_accounts e lança charge no credit_ledger.
 */
function createSale(db, payload) {
  const {
    customerId = null,
    sellerId,
    paymentMethod,
    items,
    discountCents = 0,
    notes = null,
  } = payload;

  if (!items?.length) {
    throw new Error('A venda precisa de ao menos um item.');
  }
  if (!['cash', 'pix', 'credit'].includes(paymentMethod)) {
    throw new Error('Forma de pagamento inválida.');
  }

  let customer = null;
  if (customerId) {
    customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    if (!customer) throw new Error('Cliente não encontrado.');
  }

  if (paymentMethod === 'credit') {
    assertCreditSaleAllowed(customer);
  }

  const totals = buildSaleTotals(items, discountCents);
  const paymentStatus = paymentMethod === 'credit' ? 'credit' : 'paid';
  const amountPaid = paymentMethod === 'credit' ? 0 : totals.total_cents;
  const saleNumber = nextSaleNumber(db);

  const tx = db.transaction(() => {
    const saleResult = db
      .prepare(
        `INSERT INTO sales (
          sale_number, customer_id, seller_id, payment_method, status, payment_status,
          subtotal_cents, discount_cents, total_cents, amount_paid_cents, notes
        ) VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?)`
      )
      .run(
        saleNumber,
        customerId,
        sellerId,
        paymentMethod,
        paymentStatus,
        totals.subtotal_cents,
        totals.discount_cents,
        totals.total_cents,
        amountPaid,
        notes
      );

    const saleId = saleResult.lastInsertRowid;
    const insertItem = db.prepare(
      `INSERT INTO sale_items (
        sale_id, product_id, product_name, unit_price_cents, quantity, line_total_cents
      ) VALUES (?, ?, ?, ?, ?, ?)`
    );

    for (const item of items) {
      const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(item.product_id);
      if (!product) throw new Error(`Produto ${item.product_id} indisponível.`);

      const qty = Number(item.quantity);
      if (!qty || qty < 1) throw new Error('Quantidade inválida.');

      if (product.stock_qty !== null && product.stock_qty < qty) {
        throw new Error(`Estoque insuficiente para ${product.name}.`);
      }

      const unit = product.price_cents;
      insertItem.run(saleId, product.id, product.name, unit, qty, unit * qty);

      if (product.stock_qty !== null) {
        db.prepare('UPDATE products SET stock_qty = stock_qty - ?, updated_at = datetime(\'now\', \'localtime\') WHERE id = ?').run(
          qty,
          product.id
        );
      }
    }

    if (paymentMethod === 'credit') {
      let account = db.prepare('SELECT * FROM credit_accounts WHERE customer_id = ?').get(customerId);
      if (!account) {
        db.prepare('INSERT INTO credit_accounts (customer_id, balance_cents) VALUES (?, 0)').run(customerId);
        account = { balance_cents: 0 };
      }

      const newBalance = account.balance_cents + totals.total_cents;
      db.prepare(
        `UPDATE credit_accounts SET balance_cents = ?, updated_at = datetime('now', 'localtime') WHERE customer_id = ?`
      ).run(newBalance, customerId);

      db.prepare(
        `INSERT INTO credit_ledger (
          customer_id, sale_id, entry_type, amount_cents, payment_method, balance_after_cents, notes, created_by
        ) VALUES (?, ?, 'charge', ?, NULL, ?, ?, ?)`
      ).run(customerId, saleId, totals.total_cents, newBalance, notes, sellerId);
    }

    return { saleId, saleNumber, ...totals, payment_status: paymentStatus };
  });

  return tx();
}

/**
 * Quitação (total ou parcial) de fiado.
 */
function registerCreditPayment(db, { customerId, amountCents, paymentMethod, userId, notes = null, saleId = null }) {
  if (!['cash', 'pix'].includes(paymentMethod)) {
    throw new Error('Quitação de fiado apenas em dinheiro ou PIX.');
  }
  if (!amountCents || amountCents <= 0) {
    throw new Error('Valor de pagamento inválido.');
  }

  const tx = db.transaction(() => {
    const account = db.prepare('SELECT * FROM credit_accounts WHERE customer_id = ?').get(customerId);
    if (!account || account.balance_cents <= 0) {
      throw new Error('Cliente sem saldo em aberto.');
    }
    if (amountCents > account.balance_cents) {
      throw new Error('Valor maior que o saldo em aberto.');
    }

    const newBalance = account.balance_cents - amountCents;
    db.prepare(
      `UPDATE credit_accounts SET balance_cents = ?, updated_at = datetime('now', 'localtime') WHERE customer_id = ?`
    ).run(newBalance, customerId);

    db.prepare(
      `INSERT INTO credit_ledger (
        customer_id, sale_id, entry_type, amount_cents, payment_method, balance_after_cents, notes, created_by
      ) VALUES (?, ?, 'payment', ?, ?, ?, ?, ?)`
    ).run(customerId, saleId, amountCents, paymentMethod, newBalance, notes, userId);

    if (saleId) {
      const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
      if (sale) {
        const paid = sale.amount_paid_cents + amountCents;
        const status = paid >= sale.total_cents ? 'paid' : 'partial';
        db.prepare(
          `UPDATE sales SET amount_paid_cents = ?, payment_status = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`
        ).run(paid, status, saleId);
      }
    }

    return { balance_cents: newBalance };
  });

  return tx();
}

module.exports = {
  assertCreditSaleAllowed,
  buildSaleTotals,
  nextSaleNumber,
  createSale,
  registerCreditPayment,
};
