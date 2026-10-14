const crypto = require('crypto');
const { SESSION_SECRET } = require('./config');

// Reversible encryption (AES-256-GCM) for the password the super admin set for an owner, so it can be
// shown again on request. The key is derived from SESSION_SECRET: rotating that secret makes stored
// copies unreadable (they then show as unavailable until the password is reset). Login still uses the bcrypt hash.
const key = Buffer.from(crypto.hkdfSync('sha256', SESSION_SECRET, 'menucard', 'password-vault', 32));

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

function decrypt(blob) {
  if (!blob) return null;
  try {
    const b = Buffer.from(blob, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch { return null; }
}

module.exports = { encrypt, decrypt };
