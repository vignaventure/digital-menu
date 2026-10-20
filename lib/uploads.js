const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { UPLOAD_DIR } = require('./config');

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_, f, cb) => cb(null, crypto.randomUUID() + path.extname(f.originalname).toLowerCase()),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, f, cb) => cb(null, /^image\/(jpeg|png|webp|gif)$/.test(f.mimetype)),
});

// Delete an uploaded file (no-op if missing). basename() blocks path traversal.
function removeImage(name) {
  if (!name) return;
  fs.rm(path.join(UPLOAD_DIR, path.basename(name)), { force: true }, () => {});
}

// Photos the dashboard resizes in the browser arrive as data URLs; save them as files, return the file name.
function saveImageData(dataUrl) {
  const bad = msg => Object.assign(new Error(msg), { status: 400 });
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) throw bad('Image must be a PNG, JPEG or WebP file');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 1_500_000) throw bad('Image is too large (max about 1.5 MB)');
  const name = `${crypto.randomUUID()}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return name;
}

// Duplicate an uploaded photo under a new name (so deleting it in one restaurant never breaks another). Null if the file is gone.
function copyImage(name) {
  if (!name) return null;
  const src = path.join(UPLOAD_DIR, path.basename(name));
  if (!fs.existsSync(src)) return null;
  const copy = crypto.randomUUID() + path.extname(src);
  fs.copyFileSync(src, path.join(UPLOAD_DIR, copy));
  return copy;
}

module.exports = { upload, removeImage, saveImageData, copyImage };
