/**
 * Gera PDF do extrato de fiado de um cliente.
 */

const PDFDocument = require('pdfkit');
const { CLUB_NAME, drawLetterhead } = require('./pdfLetterhead');

function formatBrl(cents) {
  return (Number(cents || 0) / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}

function entryTypeLabel(type) {
  if (type === 'charge') return 'Cobrança';
  if (type === 'payment') return 'Pagamento';
  return 'Ajuste';
}

function paymentLabel(method) {
  if (!method) return '—';
  if (method === 'cash') return 'Dinheiro';
  if (method === 'pix') return 'PIX';
  if (method === 'credit') return 'Fiado';
  return String(method);
}

/**
 * Escreve o PDF no stream (ex.: res do Express).
 * @returns {PDFDocument}
 */
function writeCreditReportPdf(stream, { customer, account, ledger }) {
  const doc = new PDFDocument({
    margin: 48,
    size: 'A4',
    info: {
      Title: `Fiado — ${customer.name}`,
      Author: CLUB_NAME,
    },
  });

  doc.pipe(stream);

  const balanceCents = account?.balance_cents || 0;

  drawLetterhead(doc);
  doc.fontSize(14).text('Extrato de Fiado');
  doc.fontSize(10).fillColor('#444');
  doc.text(`Cliente: ${customer.name}`);
  if (customer.club_nickname) {
    doc.text(`Apelido: ${customer.club_nickname}`);
  }
  if (customer.phone) {
    doc.text(`Telefone: ${customer.phone}`);
  }
  doc.text(`Gerado em: ${new Date().toLocaleString('pt-BR')}`);
  doc.fillColor('#000');
  doc.moveDown(0.8);

  doc.fontSize(12).font('Helvetica-Bold').text(`Saldo em aberto: ${formatBrl(balanceCents)}`);
  doc.font('Helvetica');
  doc.moveDown(1);

  doc.fontSize(12).text('Extrato', { underline: true });
  doc.moveDown(0.6);

  if (!ledger.length) {
    doc.fontSize(10).fillColor('#666').text('Nenhum lançamento no extrato.');
    doc.fillColor('#000');
    doc.end();
    return doc;
  }

  const pageBottom = 780;
  const left = 48;
  const right = 547;

  function ensureSpace(needed) {
    if (doc.y + needed > pageBottom) {
      doc.addPage();
      drawLetterhead(doc);
    }
  }

  for (const entry of ledger) {
    ensureSpace(72);

    const dateStr = String(entry.created_at || '').slice(0, 16).replace('T', ' ');
    const type = entryTypeLabel(entry.entry_type);
    const amount = formatBrl(entry.amount_cents);
    const balanceAfter = formatBrl(entry.balance_after_cents);
    const payment = paymentLabel(entry.payment_method);

    doc.font('Helvetica-Bold').fontSize(10).fillColor('#000');
    doc.text(`${dateStr}  ·  ${type}`, left, doc.y, { width: right - left });

    doc.font('Helvetica').fontSize(9).fillColor('#333');
    doc.text(
      `Valor: ${amount}   ·   Pagamento: ${payment}   ·   Saldo após: ${balanceAfter}`,
      { width: right - left }
    );

    if (entry.notes) {
      doc.fillColor('#555').text(`Obs.: ${entry.notes}`, { width: right - left });
    }

    if (entry.entry_type === 'charge' && entry.items && entry.items.length) {
      doc.moveDown(0.25);
      const saleLabel = entry.sale?.sale_number
        ? `Itens da cobrança — ${entry.sale.sale_number}`
        : 'Itens da cobrança';
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#000').text(saleLabel);

      if (entry.sale) {
        let saleMeta = `Total venda: ${formatBrl(entry.sale.total_cents)}`;
        if (entry.sale.discount_cents > 0) {
          saleMeta += ` · Desconto: ${formatBrl(entry.sale.discount_cents)}`;
        }
        if (entry.sale.amount_paid_cents > 0) {
          saleMeta += ` · Pago na hora: ${formatBrl(entry.sale.amount_paid_cents)}`;
        }
        saleMeta += ` · Fiado: ${formatBrl(entry.amount_cents)}`;
        doc.font('Helvetica').fontSize(8).fillColor('#555').text(saleMeta);
      }

      doc.moveDown(0.15);
      const col = {
        product: left,
        qty: 320,
        unit: 380,
        total: 460,
      };
      let y = doc.y;

      doc.font('Helvetica-Bold').fontSize(8).fillColor('#000');
      doc.text('Produto', col.product, y, { width: 250 });
      doc.text('Qtd', col.qty, y, { width: 50 });
      doc.text('Unit.', col.unit, y, { width: 70, align: 'right' });
      doc.text('Total', col.total, y, { width: 80, align: 'right' });
      y += 12;
      doc
        .moveTo(left, y - 2)
        .lineTo(right, y - 2)
        .strokeColor('#ddd')
        .stroke();

      doc.font('Helvetica').fillColor('#000');
      for (const item of entry.items) {
        if (y > pageBottom - 20) {
          doc.addPage();
          y = drawLetterhead(doc);
        }
        doc.fontSize(8);
        doc.text(item.product_name || '', col.product, y, { width: 250, ellipsis: true });
        doc.text(String(item.quantity ?? ''), col.qty, y, { width: 50 });
        doc.text(formatBrl(item.unit_price_cents), col.unit, y, { width: 70, align: 'right' });
        doc.text(formatBrl(item.line_total_cents), col.total, y, { width: 80, align: 'right' });
        y += 12;
      }
      doc.y = y;
    } else if (entry.entry_type === 'charge' && entry.sale_id) {
      doc.font('Helvetica').fontSize(8).fillColor('#666');
      doc.text('Nenhum item encontrado para esta cobrança.');
    }

    doc.fillColor('#000');
    doc.moveDown(0.45);
    const dividerY = doc.y;
    doc
      .moveTo(left, dividerY)
      .lineTo(right, dividerY)
      .strokeColor('#eee')
      .stroke();
    doc.moveDown(0.45);
  }

  doc.end();
  return doc;
}

module.exports = {
  writeCreditReportPdf,
};
