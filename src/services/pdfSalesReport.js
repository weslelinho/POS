/**
 * Gera PDF do relatório de vendas com consolidação PIX / dinheiro / fiado.
 */

const PDFDocument = require('pdfkit');

function formatBrl(cents) {
  return (Number(cents || 0) / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}

function paymentLabel(method) {
  if (method === 'cash') return 'Dinheiro';
  if (method === 'pix') return 'PIX';
  return 'Fiado';
}

function paymentStatusLabel(status) {
  if (status === 'paid') return 'Pago';
  if (status === 'credit') return 'Em aberto';
  return 'Parcial';
}

function formatPeriodLabel(fromDate, toDate) {
  const [fy, fm, fd] = fromDate.split('-');
  const [ty, tm, td] = toDate.split('-');
  const fromBr = `${fd}/${fm}/${fy}`;
  const toBr = `${td}/${tm}/${ty}`;
  return fromDate === toDate ? fromBr : `${fromBr} a ${toBr}`;
}

/**
 * Escreve o PDF no stream (ex.: res do Express).
 * @returns {PDFDocument}
 */
function writeSalesReportPdf(stream, { period, sales, summary }) {
  const doc = new PDFDocument({
    margin: 48,
    size: 'A4',
    info: {
      Title: 'Relatório de Vendas',
      Author: 'POS Motoclube',
    },
  });

  doc.pipe(stream);

  const periodLabel = formatPeriodLabel(period.fromDate, period.toDate);

  doc.fontSize(18).text('POS Motoclube', { align: 'left' });
  doc.moveDown(0.3);
  doc.fontSize(14).text('Relatório de Vendas');
  doc.fontSize(10).fillColor('#444').text(`Período: ${periodLabel}`);
  doc.text(`Gerado em: ${new Date().toLocaleString('pt-BR')}`);
  doc.fillColor('#000');
  doc.moveDown(1);

  doc.fontSize(12).text('Consolidação por forma de pagamento', { underline: true });
  doc.moveDown(0.5);
  doc.fontSize(11);
  doc.text(`PIX:        ${formatBrl(summary.pix_cents)}`);
  doc.text(`Dinheiro:   ${formatBrl(summary.cash_cents)}`);
  doc.text(`Fiado:      ${formatBrl(summary.credit_cents)}`);
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').text(`Total:      ${formatBrl(summary.total_cents)}`);
  doc.font('Helvetica').text(`Qtd. vendas: ${summary.sales_count}`);
  doc.moveDown(1.2);

  doc.fontSize(12).text('Detalhamento das vendas', { underline: true });
  doc.moveDown(0.6);

  if (!sales.length) {
    doc.fontSize(10).fillColor('#666').text('Nenhuma venda no período.');
    doc.fillColor('#000');
    doc.end();
    return doc;
  }

  const col = {
    num: 48,
    date: 130,
    customer: 230,
    method: 360,
    total: 450,
  };
  const rowH = 16;
  let y = doc.y;

  function drawHeader() {
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#000');
    doc.text('Nº', col.num, y, { width: 75 });
    doc.text('Data', col.date, y, { width: 90 });
    doc.text('Cliente', col.customer, y, { width: 120 });
    doc.text('Pagamento', col.method, y, { width: 80 });
    doc.text('Total', col.total, y, { width: 90, align: 'right' });
    y += rowH;
    doc
      .moveTo(48, y - 4)
      .lineTo(547, y - 4)
      .strokeColor('#ccc')
      .stroke();
    doc.font('Helvetica').fillColor('#000');
  }

  drawHeader();

  for (const sale of sales) {
    if (y > 760) {
      doc.addPage();
      y = 48;
      drawHeader();
    }

    const dateStr = String(sale.sold_at || '').slice(0, 16).replace('T', ' ');
    doc.fontSize(8);
    doc.text(sale.sale_number || '', col.num, y, { width: 75, ellipsis: true });
    doc.text(dateStr, col.date, y, { width: 90, ellipsis: true });
    doc.text(sale.customer_name || 'Avulso', col.customer, y, { width: 120, ellipsis: true });
    doc.text(
      `${paymentLabel(sale.payment_method)} (${paymentStatusLabel(sale.payment_status)})`,
      col.method,
      y,
      { width: 85, ellipsis: true }
    );
    doc.text(formatBrl(sale.total_cents), col.total, y, { width: 90, align: 'right' });
    y += rowH;
  }

  doc.end();
  return doc;
}

module.exports = {
  writeSalesReportPdf,
  formatPeriodLabel,
};
