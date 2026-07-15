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

/**
 * Calcula quitação em dinheiro: troco, valor exato ou restante (opcionalmente no fiado).
 * amountReceivedCents null → assume pagamento integral (compatível com fluxo antigo).
 */
function calcCashSettlement(totalCents, amountReceivedCents, { remainderAsCredit = false, customer = null } = {}) {
  if (amountReceivedCents == null) {
    return {
      amount_paid_cents: totalCents,
      change_cents: 0,
      credit_cents: 0,
      payment_status: 'paid',
    };
  }

  const received = Math.round(Number(amountReceivedCents));
  if (!Number.isFinite(received) || received < 0) {
    throw new Error('Valor em dinheiro inválido.');
  }

  if (received >= totalCents) {
    return {
      amount_paid_cents: totalCents,
      change_cents: received - totalCents,
      credit_cents: 0,
      payment_status: 'paid',
    };
  }

  const remainder = totalCents - received;
  if (!remainderAsCredit) {
    throw new Error(
      `Valor insuficiente. Faltam ${(remainder / 100).toLocaleString('pt-BR', {
        style: 'currency',
        currency: 'BRL',
      })}.`
    );
  }

  assertCreditSaleAllowed(customer);

  return {
    amount_paid_cents: received,
    change_cents: 0,
    credit_cents: remainder,
    payment_status: received > 0 ? 'partial' : 'credit',
  };
}

function chargeCustomerCredit(db, { customerId, saleId, amountCents, notes, sellerId }) {
  if (!amountCents || amountCents <= 0) return;

  let account = db.prepare('SELECT * FROM credit_accounts WHERE customer_id = ?').get(customerId);
  if (!account) {
    db.prepare('INSERT INTO credit_accounts (customer_id, balance_cents) VALUES (?, 0)').run(customerId);
    account = { balance_cents: 0 };
  }

  const newBalance = account.balance_cents + amountCents;
  db.prepare(
    `UPDATE credit_accounts SET balance_cents = ?, updated_at = datetime('now', 'localtime') WHERE customer_id = ?`
  ).run(newBalance, customerId);

  db.prepare(
    `INSERT INTO credit_ledger (
      customer_id, sale_id, entry_type, amount_cents, payment_method, balance_after_cents, notes, created_by
    ) VALUES (?, ?, 'charge', ?, NULL, ?, ?, ?)`
  ).run(customerId, saleId, amountCents, newBalance, notes, sellerId);
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
 * Em dinheiro: aceita valor recebido para calcular troco ou lançar restante no fiado (membro).
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
    amountReceivedCents = null,
    remainderAsCredit = false,
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

  const tx = db.transaction(() => {
    // Resolve preços e estoque no servidor (o front envia só product_id + quantity)
    const resolvedItems = [];
    for (const item of items) {
      const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(item.product_id);
      if (!product) throw new Error(`Produto ${item.product_id} indisponível.`);

      const qty = Number(item.quantity);
      if (!qty || qty < 1) throw new Error('Quantidade inválida.');

      if (product.stock_qty !== null && product.stock_qty < qty) {
        throw new Error(`Estoque insuficiente para ${product.name}.`);
      }

      resolvedItems.push({
        product,
        quantity: qty,
        unit_price_cents: product.price_cents,
      });
    }

    const totals = buildSaleTotals(resolvedItems, discountCents);

    let paymentStatus;
    let amountPaid;
    let changeCents = 0;
    let creditCents = 0;
    let storedPaymentMethod = paymentMethod;

    if (paymentMethod === 'credit') {
      paymentStatus = 'credit';
      amountPaid = 0;
      creditCents = totals.total_cents;
    } else if (paymentMethod === 'cash') {
      const settlement = calcCashSettlement(totals.total_cents, amountReceivedCents, {
        remainderAsCredit,
        customer,
      });
      paymentStatus = settlement.payment_status;
      amountPaid = settlement.amount_paid_cents;
      changeCents = settlement.change_cents;
      creditCents = settlement.credit_cents;
      // Restante no fiado: forma principal permanece dinheiro; status partial/credit
      if (creditCents > 0 && amountPaid === 0) {
        storedPaymentMethod = 'credit';
      }
    } else {
      paymentStatus = 'paid';
      amountPaid = totals.total_cents;
    }

    const saleNumber = nextSaleNumber(db);

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
        storedPaymentMethod,
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

    for (const row of resolvedItems) {
      const { product, quantity, unit_price_cents } = row;
      insertItem.run(
        saleId,
        product.id,
        product.name,
        unit_price_cents,
        quantity,
        unit_price_cents * quantity
      );

      if (product.stock_qty !== null) {
        db.prepare('UPDATE products SET stock_qty = stock_qty - ?, updated_at = datetime(\'now\', \'localtime\') WHERE id = ?').run(
          quantity,
          product.id
        );
      }
    }

    if (creditCents > 0) {
      chargeCustomerCredit(db, {
        customerId,
        saleId,
        amountCents: creditCents,
        notes,
        sellerId,
      });
    }

    return {
      saleId,
      saleNumber,
      ...totals,
      payment_status: paymentStatus,
      amount_paid_cents: amountPaid,
      change_cents: changeCents,
      credit_cents: creditCents,
    };
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
  calcCashSettlement,
  nextSaleNumber,
  createSale,
  registerCreditPayment,
};
