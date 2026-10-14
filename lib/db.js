const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { DatabaseSync } = require('node:sqlite');
const { DATA_DIR, UPLOAD_DIR, isProd } = require('./config');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS restaurants (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
  price_paid REAL DEFAULT 0, plan_expires TEXT, active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, email TEXT UNIQUE, mobile TEXT UNIQUE, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','owner')),
  restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY, restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name TEXT NOT NULL, sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY, restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  name TEXT NOT NULL, description TEXT, price REAL NOT NULL, image TEXT,
  available INTEGER DEFAULT 1);
CREATE INDEX IF NOT EXISTS idx_cat_rest ON categories(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_items_rest ON items(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_items_cat ON items(category_id);
`);

// Migration: older databases have users.email NOT NULL and no mobile column.
// SQLite can't alter constraints, so rebuild the table (keeps ids, so sessions and links stay valid).
if (!db.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'mobile')) {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE users_new (
        id INTEGER PRIMARY KEY, email TEXT UNIQUE, mobile TEXT UNIQUE, password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','owner')),
        restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE);
      INSERT INTO users_new (id,email,password_hash,role,restaurant_id)
        SELECT id,email,password_hash,role,restaurant_id FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;`);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  db.exec('PRAGMA foreign_keys = ON');
}
// password_enc: the owner password as set by the super admin, encrypted (see lib/vault.js). NULL = not viewable.
if (!db.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'password_enc')) {
  db.exec('ALTER TABLE users ADD COLUMN password_enc TEXT');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_users_rest ON users(restaurant_id)');

// First run: create the super admin.
if (!db.prepare("SELECT 1 FROM users WHERE role='admin'").get()) {
  const email = (process.env.ADMIN_EMAIL || 'admin@menucard.local').toLowerCase();
  let pass = process.env.ADMIN_PASSWORD;
  if (!pass) {
    if (isProd) {
      console.error('First run in production: set ADMIN_EMAIL and ADMIN_PASSWORD (min 8 chars).');
      process.exit(1);
    }
    pass = crypto.randomBytes(6).toString('hex');
    console.log(`\n>>> Super admin created: ${email} / ${pass}\n`);
  } else if (pass.length < 8) {
    console.error('ADMIN_PASSWORD must be at least 8 characters.');
    process.exit(1);
  }
  db.prepare("INSERT INTO users (email,password_hash,role) VALUES (?,?,'admin')").run(email, bcrypt.hashSync(pass, 10));
}

module.exports = { db };
