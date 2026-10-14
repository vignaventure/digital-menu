const path = require('path');

const isProd = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
// One directory holds everything that must persist (database + uploaded images): mount a volume here.
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const SESSION_SECRET = process.env.SESSION_SECRET || (isProd ? '' : 'dev-secret-change-me');

if (isProd) {
  const missing = [];
  if (SESSION_SECRET.length < 32) missing.push('SESSION_SECRET (min 32 chars)');
  if (!process.env.BASE_URL && !process.env.RENDER_EXTERNAL_URL) missing.push('BASE_URL (public https URL, used in QR codes)');
  if (missing.length) {
    console.error('Missing/invalid required env in production: ' + missing.join(', '));
    process.exit(1);
  }
}

module.exports = { isProd, PORT, BASE_URL, DATA_DIR, UPLOAD_DIR, SESSION_SECRET };
