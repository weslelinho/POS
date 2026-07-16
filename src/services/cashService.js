/**
 * Sessão de caixa: fundo de troco, suprimento, sangria e saldo esperado.
 * Valores monetários sempre em centavos (INTEGER).
 *
 * Saldo esperado na gaveta:
 *   fundo abertura
 *   + suprimentos
 *   + vendas em dinheiro (amount_paid) no intervalo da sessão
 *   + quitações de fiado em dinheiro no intervalo
 *   − sangrias
 *
 * Troco de venda já está líquido em amount_paid_cents (entrou recebido, saiu troco).
 */

function getOpenSession(db) {
  return db
    .prepare(
      `SELECT cs.*, u.name AS opened_by_name
       FROM cash_sessions cs
       JOIN users u ON u.id = cs.opened_by
       WHERE cs.status = 'open'
       ORDER BY cs.id DESC
       LIMIT 1`
    )
    .get();
}

function requireOpenSession(db) {
  const session = getOpenSession(db);
  if (!session) {
    throw new Error('Não há caixa aberto. Abra o caixa com o fundo de troco.');
  }
  return session;
}

function parsePositiveCents(amountCents, { allowZero = false } = {}) {
  const cents = Math.round(Number(amountCents));
  if (!Number.isFinite(cents)) {
    throw new Error('Valor inválido.');
  }
  if (allowZero) {
    if (cents < 0) throw new Error('Valor não pode ser negativo.');
  } else if (cents <= 0) {
    throw new Error('Informe um valor maior que zero.');
  }
  return cents;
}

/**
 * Totais de dinheiro de vendas e fiado no intervalo [fromAt, toAt].
 * toAt null → até agora (sem teto).
 */
function cashCollectedInRange(db, fromAt, toAt = null) {
  const salesRow = toAt
    ? db
        .prepare(
          `SELECT COALESCE(SUM(amount_paid_cents), 0) AS total
           FROM sales
           WHERE status = 'completed'
             AND payment_method = 'cash'
             AND amount_paid_cents > 0
             AND sold_at >= ?
             AND sold_at <= ?`
        )
        .get(fromAt, toAt)
    : db
        .prepare(
          `SELECT COALESCE(SUM(amount_paid_cents), 0) AS total
           FROM sales
           WHERE status = 'completed'
             AND payment_method = 'cash'
             AND amount_paid_cents > 0
             AND sold_at >= ?`
        )
        .get(fromAt);

  const creditRow = toAt
    ? db
        .prepare(
          `SELECT COALESCE(SUM(amount_cents), 0) AS total
           FROM credit_ledger
           WHERE entry_type = 'payment'
             AND payment_method = 'cash'
             AND created_at >= ?
             AND created_at <= ?`
        )
        .get(fromAt, toAt)
    : db
        .prepare(
          `SELECT COALESCE(SUM(amount_cents), 0) AS total
           FROM credit_ledger
           WHERE entry_type = 'payment'
             AND payment_method = 'cash'
             AND created_at >= ?`
        )
        .get(fromAt);

  return {
    sales_cash_cents: salesRow.total,
    credit_cash_cents: creditRow.total,
  };
}

function movementTotals(db, sessionId) {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN movement_type = 'supply' THEN amount_cents ELSE 0 END), 0) AS supply_cents,
         COALESCE(SUM(CASE WHEN movement_type = 'bleed' THEN amount_cents ELSE 0 END), 0) AS bleed_cents
       FROM cash_movements
       WHERE session_id = ?`
    )
    .get(sessionId);

  return {
    supply_cents: row.supply_cents,
    bleed_cents: row.bleed_cents,
  };
}

function computeExpectedCents(session, movements, collected) {
  return (
    session.opening_float_cents +
    movements.supply_cents +
    collected.sales_cash_cents +
    collected.credit_cash_cents -
    movements.bleed_cents
  );
}

function listMovements(db, sessionId) {
  return db
    .prepare(
      `SELECT cm.*, u.name AS created_by_name
       FROM cash_movements cm
       JOIN users u ON u.id = cm.created_by
       WHERE cm.session_id = ?
       ORDER BY cm.created_at DESC, cm.id DESC`
    )
    .all(sessionId);
}

/**
 * Resumo completo da sessão (aberta ou fechada).
 */
function getSessionSummary(db, session) {
  const toAt = session.status === 'closed' ? session.closed_at : null;
  const movements = movementTotals(db, session.id);
  const collected = cashCollectedInRange(db, session.opened_at, toAt);
  const expected_cents = computeExpectedCents(session, movements, collected);
  const movementRows = listMovements(db, session.id);

  return {
    session,
    movements: movementRows,
    totals: {
      opening_float_cents: session.opening_float_cents,
      supply_cents: movements.supply_cents,
      bleed_cents: movements.bleed_cents,
      sales_cash_cents: collected.sales_cash_cents,
      credit_cash_cents: collected.credit_cash_cents,
      expected_cents,
      closing_counted_cents: session.closing_counted_cents,
      difference_cents:
        session.closing_counted_cents != null
          ? session.closing_counted_cents - (session.expected_cents ?? expected_cents)
          : null,
    },
  };
}

function openSession(db, { userId, openingFloatCents, notes = null }) {
  const floatCents = parsePositiveCents(openingFloatCents, { allowZero: true });

  const tx = db.transaction(() => {
    const open = getOpenSession(db);
    if (open) {
      throw new Error('Já existe um caixa aberto. Feche-o antes de abrir outro.');
    }

    const result = db
      .prepare(
        `INSERT INTO cash_sessions (opened_by, opening_float_cents, notes, status)
         VALUES (?, ?, ?, 'open')`
      )
      .run(userId, floatCents, notes);

    return getOpenSession(db) || { id: result.lastInsertRowid };
  });

  return tx();
}

function addMovement(db, { userId, movementType, amountCents, notes = null }) {
  if (!['supply', 'bleed'].includes(movementType)) {
    throw new Error('Tipo de movimento inválido.');
  }

  const cents = parsePositiveCents(amountCents);

  const tx = db.transaction(() => {
    const session = requireOpenSession(db);

    if (movementType === 'bleed') {
      const summary = getSessionSummary(db, session);
      if (cents > summary.totals.expected_cents) {
        throw new Error(
          `Sangria maior que o saldo esperado em caixa (${(summary.totals.expected_cents / 100).toLocaleString(
            'pt-BR',
            { style: 'currency', currency: 'BRL' }
          )}).`
        );
      }
    }

    const result = db
      .prepare(
        `INSERT INTO cash_movements (session_id, movement_type, amount_cents, notes, created_by)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(session.id, movementType, cents, notes, userId);

    return {
      id: result.lastInsertRowid,
      session_id: session.id,
      movement_type: movementType,
      amount_cents: cents,
    };
  });

  return tx();
}

function addSupply(db, payload) {
  return addMovement(db, { ...payload, movementType: 'supply' });
}

function addBleed(db, payload) {
  return addMovement(db, { ...payload, movementType: 'bleed' });
}

function closeSession(db, { userId, countedCents = null, notes = null }) {
  let counted = null;
  if (countedCents != null && String(countedCents).trim() !== '') {
    counted = parsePositiveCents(countedCents, { allowZero: true });
  }

  const tx = db.transaction(() => {
    const session = requireOpenSession(db);
    const summary = getSessionSummary(db, session);
    const expected = summary.totals.expected_cents;

    const closedNotes = [session.notes, notes].filter(Boolean).join(' | ') || null;

    db.prepare(
      `UPDATE cash_sessions
       SET status = 'closed',
           closed_by = ?,
           closed_at = datetime('now', 'localtime'),
           closing_counted_cents = ?,
           expected_cents = ?,
           notes = ?
       WHERE id = ? AND status = 'open'`
    ).run(userId, counted, expected, closedNotes, session.id);

    return getSessionSummary(db, {
      ...session,
      status: 'closed',
      closed_by: userId,
      closed_at: db.prepare(`SELECT closed_at FROM cash_sessions WHERE id = ?`).get(session.id).closed_at,
      closing_counted_cents: counted,
      expected_cents: expected,
      notes: closedNotes,
    });
  });

  return tx();
}

function listRecentSessions(db, limit = 10) {
  return db
    .prepare(
      `SELECT cs.*,
              ou.name AS opened_by_name,
              cu.name AS closed_by_name
       FROM cash_sessions cs
       JOIN users ou ON ou.id = cs.opened_by
       LEFT JOIN users cu ON cu.id = cs.closed_by
       ORDER BY cs.opened_at DESC
       LIMIT ?`
    )
    .all(limit);
}

module.exports = {
  getOpenSession,
  getSessionSummary,
  openSession,
  addSupply,
  addBleed,
  closeSession,
  listRecentSessions,
};
