/**
 * Papel timbrado compartilhado dos PDFs exportados.
 */

const fs = require('fs');
const path = require('path');

const CLUB_NAME = 'Esquadrão de Cristo Motoclube';
const LOGO_PATH = path.join(__dirname, '../../public/img/logo.png');
const MARGIN = 48;
const CONTENT_RIGHT = 547;
const LOGO_SIZE = 52;

/**
 * Desenha logotipo + nome do motoclube no topo da página atual.
 * @returns {number} posição Y após o cabeçalho (para continuar o conteúdo)
 */
function drawLetterhead(doc) {
  const top = MARGIN;
  const hasLogo = fs.existsSync(LOGO_PATH);

  if (hasLogo) {
    doc.image(LOGO_PATH, MARGIN, top, {
      width: LOGO_SIZE,
      height: LOGO_SIZE,
      fit: [LOGO_SIZE, LOGO_SIZE],
    });
  }

  const textX = hasLogo ? MARGIN + LOGO_SIZE + 14 : MARGIN;
  const textWidth = CONTENT_RIGHT - textX;
  const nameY = top + (hasLogo ? Math.max(0, (LOGO_SIZE - 18) / 2) : 0);

  doc
    .font('Helvetica-Bold')
    .fontSize(14)
    .fillColor('#111')
    .text(CLUB_NAME, textX, nameY, {
      width: textWidth,
      align: 'left',
      lineBreak: false,
    });

  const lineY = top + (hasLogo ? LOGO_SIZE : 18) + 10;
  doc
    .moveTo(MARGIN, lineY)
    .lineTo(CONTENT_RIGHT, lineY)
    .strokeColor('#bbbbbb')
    .lineWidth(1)
    .stroke();

  doc.x = MARGIN;
  doc.y = lineY + 14;
  doc.fillColor('#000');
  doc.font('Helvetica');

  return doc.y;
}

module.exports = {
  CLUB_NAME,
  MARGIN,
  CONTENT_RIGHT,
  drawLetterhead,
};
