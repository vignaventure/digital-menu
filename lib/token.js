const crypto = require('crypto');

// Minimal HMAC-signed bearer token: base64url(payload).signature
const mac = (body, secret) => crypto.createHmac('sha256', secret).update(body).digest('base64url');

function sign(payload, secret, ttlSec = 12 * 3600) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec })).toString('base64url');
  return `${body}.${mac(body, secret)}`;
}

function verify(token, secret) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const a = Buffer.from(sig), b = Buffer.from(mac(body, secret));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url'));
    return p.exp > Date.now() / 1000 ? p : null;
  } catch { return null; }
}

module.exports = { sign, verify };
