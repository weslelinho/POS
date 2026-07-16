const path = require('path');
const fs = require('fs');
const multer = require('multer');

const PRODUCTS_IMG_DIR = path.join(__dirname, '../../public/img/products');
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

function ensureProductsImgDir() {
  fs.mkdirSync(PRODUCTS_IMG_DIR, { recursive: true });
}

function extensionFor(file) {
  const fromName = path.extname(file.originalname || '').toLowerCase();
  if (ALLOWED_EXT.has(fromName)) {
    return fromName === '.jpeg' ? '.jpg' : fromName;
  }
  switch (file.mimetype) {
    case 'image/png':
      return '.png';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    default:
      return '.jpg';
  }
}

const upload = multer({
  storage: multer.diskStorage({
    destination(_req, _file, cb) {
      try {
        ensureProductsImgDir();
        cb(null, PRODUCTS_IMG_DIR);
      } catch (err) {
        cb(err);
      }
    },
    filename(_req, file, cb) {
      const ext = extensionFor(file);
      const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      cb(null, `tmp-${token}${ext}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      cb(new Error('Use uma imagem JPG, PNG, WEBP ou GIF.'));
      return;
    }
    cb(null, true);
  },
});

function absoluteFromPublicRelative(imagePath) {
  if (!imagePath) return null;
  const normalized = String(imagePath).replace(/^[/\\]+/, '').replace(/\\/g, '/');
  if (!normalized.startsWith('img/products/')) return null;
  return path.join(__dirname, '../../public', normalized);
}

function removeStoredImage(imagePath) {
  const abs = absoluteFromPublicRelative(imagePath);
  if (abs && fs.existsSync(abs)) {
    fs.unlinkSync(abs);
  }
}

/**
 * Move o arquivo temporário do multer para o nome definitivo do produto.
 * Retorna o caminho relativo a public/ (ex.: img/products/12.jpg).
 */
function finalizeProductImage(productId, uploadedFile, previousImagePath = null) {
  if (!uploadedFile) return previousImagePath || null;

  ensureProductsImgDir();
  const ext = path.extname(uploadedFile.filename).toLowerCase() || '.jpg';
  const finalName = `${Number(productId)}${ext === '.jpeg' ? '.jpg' : ext}`;
  const tempAbs = path.join(PRODUCTS_IMG_DIR, uploadedFile.filename);
  const finalAbs = path.join(PRODUCTS_IMG_DIR, finalName);

  if (previousImagePath) {
    const prevAbs = absoluteFromPublicRelative(previousImagePath);
    if (prevAbs && fs.existsSync(prevAbs) && path.resolve(prevAbs) !== path.resolve(finalAbs)) {
      fs.unlinkSync(prevAbs);
    }
  }

  if (fs.existsSync(finalAbs) && path.resolve(tempAbs) !== path.resolve(finalAbs)) {
    fs.unlinkSync(finalAbs);
  }

  fs.renameSync(tempAbs, finalAbs);
  return `img/products/${finalName}`;
}

function discardTempUpload(uploadedFile) {
  if (!uploadedFile?.filename) return;
  const tempAbs = path.join(PRODUCTS_IMG_DIR, uploadedFile.filename);
  if (fs.existsSync(tempAbs)) fs.unlinkSync(tempAbs);
}

module.exports = {
  upload,
  finalizeProductImage,
  removeStoredImage,
  discardTempUpload,
  ensureProductsImgDir,
  PRODUCTS_IMG_DIR,
};
