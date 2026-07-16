/**
 * Relatório de vendas por período com consolidação PIX / dinheiro / fiado.
 * Valores monetários sempre em centavos (INTEGER).
 *
 * Consolidação:
 *   PIX     → total_cents das vendas payment_method = pix
 *   Dinheiro → amount_paid_cents das vendas payment_method = cash
 *   Fiado   → total das vendas credit + restante (total - amount_paid) nas cash parciais
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayLocalDate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parsePeriod(fromRaw, toRaw) {
  const today = todayLocalDate();
  let fromDate = String(fromRaw || '').trim() || today;
  let toDate = String(toRaw || '').trim() || today;

  if (!DATE_RE.test(fromDate)) fromDate = today;
  if (!DATE_RE.test(toDate)) toDate = today;

  if (fromDate > toDate) {
    const tmp = fromDate;
    fromDate = toDate;
    toDate = tmp;
  }

  return {
    fromDate,
    toDate,
    fromAt: `${fromDate} 00:00:00`,
    toAt: `${toDate} 23:59:59`,
  };
}

function listSalesInPeriod(db, fromAt, toAt) {
  return db
    .prepare(
      `SELECT s.*, u.name AS seller_name, c.name AS customer_name
       FROM sales s
       JOIN users u ON u.id = s.seller_id
       LEFT JOIN customers c ON c.id = s.customer_id
       WHERE s.status = 'completed'
         AND s.sold_at >= ?
         AND s.sold_at <= ?
       ORDER BY s.sold_at DESC`
    )
    .all(fromAt, toAt);
}

/**
 * Consolida valores efetivos por forma de pagamento no período.
 * Trata venda mista (dinheiro + restante no fiado) sem dupla contagem.
 */
function consolidateSales(db, fromAt, toAt) {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS sales_count,
         COALESCE(SUM(total_cents), 0) AS total_cents,
         COALESCE(SUM(CASE WHEN payment_method = 'pix' THEN total_cents ELSE 0 END), 0) AS pix_cents,
         COALESCE(SUM(CASE WHEN payment_method = 'cash' THEN amount_paid_cents ELSE 0 END), 0) AS cash_cents,
         COALESCE(SUM(
           CASE
             WHEN payment_method = 'credit' THEN total_cents
             WHEN payment_method = 'cash' THEN (total_cents - amount_paid_cents)
             ELSE 0
           END
         ), 0) AS credit_cents
       FROM sales
       WHERE status = 'completed'
         AND sold_at >= ?
         AND sold_at <= ?`
    )
    .get(fromAt, toAt);

  return {
    sales_count: Number(row.sales_count) || 0,
    total_cents: Number(row.total_cents) || 0,
    pix_cents: Number(row.pix_cents) || 0,
    cash_cents: Number(row.cash_cents) || 0,
    credit_cents: Number(row.credit_cents) || 0,
  };
}

function getSalesReport(db, { from, to } = {}) {
  const period = parsePeriod(from, to);
  const sales = listSalesInPeriod(db, period.fromAt, period.toAt);
  const summary = consolidateSales(db, period.fromAt, period.toAt);
  return { period, sales, summary };
}

module.exports = {
  todayLocalDate,
  parsePeriod,
  listSalesInPeriod,
  consolidateSales,
  getSalesReport,
};
