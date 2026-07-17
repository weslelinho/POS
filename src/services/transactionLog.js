/**
 * Log de transações em arquivo texto, com rotação por tamanho (15 MB → ZIP).
 * Nome dos arquivos: transactions_YYYY-MM-DD_NNN.log / .zip
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MAX_LOG_BYTES = 15 * 1024 * 1024;
const LOG_DIR = path.join(__dirname, '../../data/logs');
const FILE_RE = /^transactions_(\d{4}-\d{2}-\d{2})_(\d{3})\.(log|zip)$/;

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function padSeq(n) {
  return String(n).padStart(3, '0');
}

function todayDateStr(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatTimestamp(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}.${ms}`;
}

/** CRC-32 (IEEE) para cabeçalhos ZIP. */
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
  }
  return ~c >>> 0;
}

/**
 * Cria um ZIP com um único arquivo (deflate).
 * Evita dependência externa (archiver etc.).
 */
function createSingleFileZip(entryName, contentBuf) {
  const nameBuf = Buffer.from(entryName, 'utf8');
  const compressed = zlib.deflateRawSync(contentBuf);
  const crc = crc32(contentBuf);
  const now = new Date();
  const dosTime =
    (now.getSeconds() >> 1) |
    (now.getMinutes() << 5) |
    (now.getHours() << 11);
  const dosDate =
    now.getDate() |
    ((now.getMonth() + 1) << 5) |
    ((now.getFullYear() - 1980) << 9);

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(8, 8); // deflate
  localHeader.writeUInt16LE(dosTime, 10);
  localHeader.writeUInt16LE(dosDate, 12);
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(contentBuf.length, 22);
  localHeader.writeUInt16LE(nameBuf.length, 26);
  localHeader.writeUInt16LE(0, 28);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0, 8);
  centralHeader.writeUInt16LE(8, 10);
  centralHeader.writeUInt16LE(dosTime, 12);
  centralHeader.writeUInt16LE(dosDate, 14);
  centralHeader.writeUInt32LE(crc, 16);
  centralHeader.writeUInt32LE(compressed.length, 20);
  centralHeader.writeUInt32LE(contentBuf.length, 24);
  centralHeader.writeUInt16LE(nameBuf.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(0, 42); // offset do local header

  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(1, 8);
  endRecord.writeUInt16LE(1, 10);
  const centralSize = centralHeader.length + nameBuf.length;
  const centralOffset = localHeader.length + nameBuf.length + compressed.length;
  endRecord.writeUInt32LE(centralSize, 12);
  endRecord.writeUInt32LE(centralOffset, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([
    localHeader,
    nameBuf,
    compressed,
    centralHeader,
    nameBuf,
    endRecord,
  ]);
}

function parseLogFiles() {
  ensureLogDir();
  const entries = [];
  for (const name of fs.readdirSync(LOG_DIR)) {
    const m = name.match(FILE_RE);
    if (!m) continue;
    entries.push({
      name,
      date: m[1],
      seq: Number(m[2]),
      ext: m[3],
      fullPath: path.join(LOG_DIR, name),
    });
  }
  return entries;
}

function nextSequenceForDate(dateStr) {
  const files = parseLogFiles().filter((f) => f.date === dateStr);
  if (!files.length) return 1;
  return Math.max(...files.map((f) => f.seq)) + 1;
}

function buildLogFileName(dateStr, seq) {
  return `transactions_${dateStr}_${padSeq(seq)}.log`;
}

/** Retorna o .log ativo (maior data/seq), ou cria o primeiro do dia. */
function resolveActiveLogPath() {
  ensureLogDir();
  const logs = parseLogFiles().filter((f) => f.ext === 'log');
  if (logs.length) {
    logs.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return b.seq - a.seq;
    });
    return logs[0].fullPath;
  }

  const dateStr = todayDateStr();
  const seq = nextSequenceForDate(dateStr);
  const filePath = path.join(LOG_DIR, buildLogFileName(dateStr, seq));
  fs.writeFileSync(filePath, '', 'utf8');
  return filePath;
}

function rotateLog(logPath) {
  const base = path.basename(logPath, '.log');
  const zipPath = path.join(LOG_DIR, `${base}.zip`);
  const content = fs.readFileSync(logPath);
  const zipBuf = createSingleFileZip(`${base}.log`, content);
  fs.writeFileSync(zipPath, zipBuf);
  fs.unlinkSync(logPath);

  const dateStr = todayDateStr();
  const seq = nextSequenceForDate(dateStr);
  const newPath = path.join(LOG_DIR, buildLogFileName(dateStr, seq));
  fs.writeFileSync(newPath, '', 'utf8');
  return newPath;
}

function serializeDetails(details) {
  if (details == null) return '';
  if (typeof details === 'string') return details;
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}

/**
 * Registra uma linha de log de transação.
 * @param {object} opts
 * @param {string} opts.login - username da sessão
 * @param {string} opts.type - sale | credit_payment | cash_open | cash_supply | cash_bleed | cash_close
 * @param {object} [opts.details] - dados da transação
 */
function logTransaction({ login, type, details = null }) {
  try {
    ensureLogDir();
    let logPath = resolveActiveLogPath();
    const line =
      `${formatTimestamp()} | login=${login || '?'} | type=${type}` +
      (details != null ? ` | ${serializeDetails(details)}` : '') +
      '\n';

    fs.appendFileSync(logPath, line, 'utf8');

    const size = fs.statSync(logPath).size;
    if (size >= MAX_LOG_BYTES) {
      rotateLog(logPath);
    }
  } catch (err) {
    console.error('[transactionLog]', err.message || err);
  }
}

module.exports = {
  logTransaction,
  LOG_DIR,
  MAX_LOG_BYTES,
};
