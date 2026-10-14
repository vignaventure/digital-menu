// MongoDB connection and collections. Ids stay small integers (see nextId) so the API shapes did not change.
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { MongoClient } = require('mongodb');
const { UPLOAD_DIR, MONGODB_URI, MONGODB_DB, isProd } = require('./config');

fs.mkdirSync(UPLOAD_DIR, { recursive: true }); // photos stay on disk (DATA_DIR/uploads); everything else is in MongoDB

const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
const cols = {}; // filled in by init(): restaurants, users, categories, items, sessions, counters

// Auto-increment ids per collection (restaurants, users, categories, items).
async function nextId(name) {
  const r = await cols.counters.findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
  return r.seq;
}
const isDuplicate = e => e?.code === 11000;

async function seedAdmin() {
  if (await cols.users.findOne({ role: 'admin' })) return;
  const email = (process.env.ADMIN_EMAIL || 'admin@menucard.local').toLowerCase();
  let pass = process.env.ADMIN_PASSWORD;
  if (!pass) {
    if (isProd) throw new Error('First run in production: set ADMIN_EMAIL and ADMIN_PASSWORD (min 8 chars).');
    pass = crypto.randomBytes(6).toString('hex');
    console.log(`\n>>> Super admin created: ${email} / ${pass}\n`);
  } else if (pass.length < 8) {
    throw new Error('ADMIN_PASSWORD must be at least 8 characters.');
  }
  await cols.users.insertOne({ _id: await nextId('users'), email, mobile: null, password_hash: bcrypt.hashSync(pass, 10), password_enc: null, role: 'admin', restaurant_id: null });
}

// Connect, create indexes (safe to repeat) and make sure a super admin exists.
async function init({ seed = true } = {}) {
  try {
    await client.connect();
  } catch (e) {
    const msg = String(e.message).split('\n')[0].slice(0, 200);
    // a wrong login reaches Atlas fine (so the network rule is OK); a blocked IP shows up as a TLS/timeout error
    const hint = /bad auth|authentication failed/i.test(msg)
      ? '  -> The username or password in MONGODB_URI is wrong. Symbols in the password (@ : / # ?) must be URL-encoded, or use a simpler password.'
      : '  -> Atlas: Security > Network Access must allow this server\'s IP address (and check the host in MONGODB_URI).';
    throw new Error(`Could not connect to MongoDB: ${msg}\n${hint}`);
  }
  const d = client.db(MONGODB_DB);
  for (const n of ['restaurants', 'users', 'categories', 'items', 'sessions', 'counters']) cols[n] = d.collection(n);
  await Promise.all([
    cols.restaurants.createIndex({ slug: 1 }, { unique: true }),
    // partial indexes: owners without an email (or legacy ones without a mobile) don't collide on null
    cols.users.createIndex({ mobile: 1 }, { unique: true, partialFilterExpression: { mobile: { $type: 'string' } } }),
    cols.users.createIndex({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } }),
    cols.users.createIndex({ restaurant_id: 1 }),
    cols.categories.createIndex({ restaurant_id: 1, sort: 1 }),
    cols.items.createIndex({ restaurant_id: 1, category_id: 1 }),
    cols.sessions.createIndex({ expires: 1 }, { expireAfterSeconds: 0 }), // MongoDB deletes expired sessions itself
  ]);
  if (seed) await seedAdmin();
}

const ping = () => client.db('admin').command({ ping: 1 });
const close = () => client.close();

module.exports = { client, cols, init, nextId, isDuplicate, ping, close };
