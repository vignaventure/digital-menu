// An older SQLite database must copy into MongoDB with ids, logins and payment status intact.
const os = require('os');
const fs = require('fs');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'menucard-mig-'));
process.env.DATA_DIR = dir;
process.env.ADMIN_PASSWORD = 'AdminPass123';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { startMongo } = require('./helpers');

let mongo, db;
test.before(async () => { mongo = await startMongo(); db = require('../lib/db'); await db.init({ seed: false }); });
test.after(async () => { await db.close(); await mongo.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

test('legacy SQLite database is copied into MongoDB, and copying twice changes nothing', async () => {
  const file = path.join(dir, 'app.db');
  // the oldest layout this app ever had: no mobile, no profile columns, no paid flag
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE restaurants (id INTEGER PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
      price_paid REAL DEFAULT 0, plan_expires TEXT, active INTEGER DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      role TEXT NOT NULL, restaurant_id INTEGER);
    CREATE TABLE categories (id INTEGER PRIMARY KEY, restaurant_id INTEGER NOT NULL, name TEXT NOT NULL, sort INTEGER DEFAULT 0);
    CREATE TABLE items (id INTEGER PRIMARY KEY, restaurant_id INTEGER NOT NULL, category_id INTEGER NOT NULL,
      name TEXT NOT NULL, description TEXT, price REAL NOT NULL, image TEXT, available INTEGER DEFAULT 1);
    INSERT INTO restaurants (id,name,slug,price_paid,active) VALUES (1,'Old Cafe','old-cafe',500,1),(7,'Free Cafe','free-cafe',0,0);
    INSERT INTO users (id,email,password_hash,role,restaurant_id) VALUES (1,'root@x.com','h','admin',NULL),(2,'old@cafe.com','h2','owner',1);
    INSERT INTO categories (id,restaurant_id,name,sort) VALUES (3,1,'Mains',2);
    INSERT INTO items (id,restaurant_id,category_id,name,description,price,image,available) VALUES (9,1,3,'Dal','tasty',80,'dal.jpg',0);`);
  old.close();

  const { migrate } = require('../scripts/migrate-sqlite-to-mongo');
  const first = await migrate(file, () => {});
  assert.deepEqual(Object.fromEntries(Object.entries(first).map(([k, v]) => [k, v.added])), { restaurants: 2, users: 2, categories: 1, items: 1 });

  const r1 = await db.cols.restaurants.findOne({ _id: 1 });
  assert.equal(r1.paid, true);                 // a price > 0 used to mean "paid"
  assert.equal(r1.theme_color, '#d9480f');
  assert.equal(r1.owner, '');
  assert.equal((await db.cols.restaurants.findOne({ _id: 7 })).active, false);
  assert.equal((await db.cols.restaurants.findOne({ _id: 7 })).paid, false);
  const owner = await db.cols.users.findOne({ _id: 2 });
  assert.deepEqual([owner.email, owner.mobile, owner.restaurant_id, owner.password_hash], ['old@cafe.com', null, 1, 'h2']);
  const item = await db.cols.items.findOne({ _id: 9 });
  assert.deepEqual([item.name, item.price, item.image, item.available, item.category_id], ['Dal', 80, 'dal.jpg', false, 3]);

  // running it again copies nothing new
  const second = await migrate(file, () => {});
  assert.ok(Object.values(second).every(v => v.added === 0));
  assert.equal(await db.cols.restaurants.countDocuments(), 2);

  // new records continue after the highest copied id, and the migrated admin is kept (no second admin appears)
  const svc = require('../lib/service');
  const made = await svc.createRestaurant({ name: 'New Place', mobile: '9000000001', password: 'secret12' });
  assert.equal(made.id, 8);
  await db.init({ seed: true });
  assert.equal(await db.cols.users.countDocuments({ role: 'admin' }), 1);

  // a null mobile (legacy owner) and a null email don't collide on the unique indexes
  await db.cols.users.insertOne({ _id: 50, email: null, mobile: null, password_hash: 'x', role: 'owner', restaurant_id: 1 });
  await db.cols.users.insertOne({ _id: 51, email: null, mobile: null, password_hash: 'x', role: 'owner', restaurant_id: 1 });
  await assert.rejects(db.cols.users.insertOne({ _id: 52, mobile: '9000000001', password_hash: 'x', role: 'owner' }), /duplicate key/);
});
