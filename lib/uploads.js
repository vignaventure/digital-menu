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

module.exports = { upload, removeImage };
