const os = require('os');
const path = require('path');

const isProd = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 3000;
// Public address encoded in QR codes. In development, with nothing configured, use the Wi-Fi address
// so a phone on the same network can scan the QR (localhost would mean the phone itself).
const lanIp = () => Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal)?.address;
const BASE_URL = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL
  || `http://${(!isProd && lanIp()) || 'localhost'}:${PORT}`).replace(/\/+$/, '');
// Uploaded photos live here (the database is MongoDB): mount a persistent volume on this directory.
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const SESSION_SECRET = process.env.SESSION_SECRET || (isProd ? '' : 'dev-secret-change-me');

// MongoDB connection. Set MONGODB_URI (e.g. mongodb+srv://user:pass@cluster.mongodb.net/), or the separate
// MONGODB_USER / MONGODB_PASSWORD / MONGODB_HOST variables. The database is kept apart from any other project's data.
const MONGODB_DB = process.env.MONGODB_DB || 'digitalmenu';
let MONGODB_URI = process.env.MONGODB_URI || '';
if (!MONGODB_URI && process.env.MONGODB_USER && process.env.MONGODB_PASSWORD && process.env.MONGODB_HOST) {
  MONGODB_URI = `mongodb+srv://${encodeURIComponent(process.env.MONGODB_USER)}:${encodeURIComponent(process.env.MONGODB_PASSWORD)}@${process.env.MONGODB_HOST}/?retryWrites=true&w=majority`;
}
if (!MONGODB_URI) {
  console.error('MONGODB_URI is not set. Example: MONGODB_URI="mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/" (see .env.example)');
  process.exit(1);
}

if (isProd) {
  const missing = [];
  if (SESSION_SECRET.length < 32) missing.push('SESSION_SECRET (min 32 chars)');
  if (!process.env.BASE_URL && !process.env.RENDER_EXTERNAL_URL) missing.push('BASE_URL (public https URL, used in QR codes)');
  if (missing.length) {
    console.error('Missing/invalid required env in production: ' + missing.join(', '));
    process.exit(1);
  }
}

module.exports = { isProd, PORT, BASE_URL, DATA_DIR, UPLOAD_DIR, SESSION_SECRET, MONGODB_URI, MONGODB_DB };
