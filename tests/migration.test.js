// An older database (users.email NOT NULL, no mobile column, no profile columns) must upgrade in place without losing data.
const os = require('os');
const fs = require('fs');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'menucard-mig-'));
process.env.DATA_DIR = dir;
process.env.ADMIN_PASSWORD = 'AdminPass123';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('legacy database is migrated and keeps its rows', () => {
  const old = new DatabaseSync(path.join(dir, 'app.db'));
  old.exec(`
    CREATE TABLE restaurants (id INTEGER PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
      price_paid REAL DEFAULT 0, plan_expires TEXT, active INTEGER DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','owner')), restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE);
    INSERT INTO restaurants (id,name,slug,price_paid) VALUES (1,'Old Cafe','old-cafe',500),(2,'Free Cafe','free-cafe',0);
    INSERT INTO users (id,email,password_hash,role,restaurant_id) VALUES (1,'root@x.com','h','admin',NULL),(2,'old@cafe.com','h2','owner',1);`);
  old.close();

  const { db } = require('../lib/db');
  const cols = t => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
  for (const c of ['mobile', 'password_enc']) assert.ok(cols('users').includes(c), c);
  for (const c of ['owner', 'city', 'address', 'tagline', 'theme_color', 'logo', 'contact_phone', 'paid']) assert.ok(cols('restaurants').includes(c), c);

  const rows = db.prepare('SELECT id,email,mobile,role,restaurant_id FROM users ORDER BY id').all();
  assert.equal(rows.length, 2);
  assert.equal(rows[1].email, 'old@cafe.com');
  assert.equal(rows[1].mobile, null);
  assert.equal(rows[1].restaurant_id, 1);

  // a price > 0 used to mean "paid", so existing restaurants keep their payment status
  const rest = db.prepare('SELECT id,paid,theme_color,owner FROM restaurants ORDER BY id').all();
  assert.deepEqual(rest.map(r => r.paid), [1, 0]);
  assert.equal(rest[0].theme_color, '#d9480f');
  assert.equal(rest[0].owner, '');

  // email can now be NULL and mobile is unique
  db.prepare("INSERT INTO users (mobile,password_hash,role,restaurant_id) VALUES ('9000000001','h','owner',1)").run();
  assert.throws(() => db.prepare("INSERT INTO users (mobile,password_hash,role,restaurant_id) VALUES ('9000000001','h','owner',1)").run());
  db.close();
});
