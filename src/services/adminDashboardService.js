/**
 * Dashboard administrativo: vendas por data das últimas aberturas de caixa.
 */

const { listRecentSessions } = require('./cashService');
const { consolidateSales } = require('./salesReportService');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function formatDateLabel(dateStr) {
  const [y, m, d] = String(dateStr).split('-');
  if (!y || !m || !d) return dateStr;
  return `${d}/${m}`;
}

function formatDateFull(dateStr) {
  const [y, m, d] = String(dateStr).split('-');
  if (!y || !m || !d) return dateStr;
  return `${d}/${m}/${y}`;
}

/**
 * Extrai as datas distintas de abertura das sessões mais recentes (mais nova primeiro).
 */
function listRecentOpeningDates(db, limit = 14) {
  const fetchLimit = Math.max(limit * 3, 40);
  const sessions = listRecentSessions(db, fetchLimit);
  const dates = [];
  const seen = new Set();

  for (const session of sessions) {
    const date = String(session.opened_at || '').slice(0, 10);
    if (!DATE_RE.test(date) || seen.has(date)) continue;
    seen.add(date);
    dates.push(date);
    if (dates.length >= limit) break;
  }

  return { dates, sessions };
}

/**
 * Agrega vendas concluídas por dia de abertura de caixa (últimos N dias com abertura).
 */
function getSalesByRecentOpeningDays(db, { limit = 14 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 14, 1), 60);
  const { dates, sessions } = listRecentOpeningDates(db, safeLimit);

  // Gráfico em ordem cronológica (mais antiga à esquerda).
  const chronological = [...dates].reverse();

  const points = chronological.map((date) => {
    const fromAt = `${date} 00:00:00`;
    const toAt = `${date} 23:59:59`;
    const summary = consolidateSales(db, fromAt, toAt);
    const daySessions = sessions.filter(
      (s) => String(s.opened_at || '').slice(0, 10) === date
    );

    return {
      date,
      label: formatDateLabel(date),
      label_full: formatDateFull(date),
      sessions_count: daySessions.length,
      has_open_session: daySessions.some((s) => s.status === 'open'),
      sales_count: summary.sales_count,
      total_cents: summary.total_cents,
      pix_cents: summary.pix_cents,
      cash_cents: summary.cash_cents,
      credit_cents: summary.credit_cents,
    };
  });

  const totals = points.reduce(
    (acc, p) => {
      acc.sales_count += p.sales_count;
      acc.total_cents += p.total_cents;
      acc.pix_cents += p.pix_cents;
      acc.cash_cents += p.cash_cents;
      acc.credit_cents += p.credit_cents;
      acc.days_count += 1;
      return acc;
    },
    {
      sales_count: 0,
      total_cents: 0,
      pix_cents: 0,
      cash_cents: 0,
      credit_cents: 0,
      days_count: 0,
    }
  );

  return {
    limit: safeLimit,
    points,
    totals,
  };
}

module.exports = {
  getSalesByRecentOpeningDays,
  listRecentOpeningDates,
  formatDateLabel,
  formatDateFull,
};
