#!/usr/bin/env node
// One-off: copy the data from an older SQLite database (app.db) into MongoDB.
//   MONGODB_URI=... node scripts/migrate-sqlite-to-mongo.js [path/to/app.db]
// Ids are kept, so photos, menu links and QR codes keep working. Safe to run twice (existing ids are skipped).
// Login sessions are not copied: everyone logs in again once. Photos stay where they are (DATA_DIR/uploads).
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../lib/config');
const db = require('../lib/db');

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const all = (sqlite, table) => { try { return sqlite.prepare(`SELECT * FROM ${table}`).all(); } catch { return []; } }; // older files lack newer tables/columns

async function migrate(file, log = console.log) {
  const sqlite = new DatabaseSync(file, { readOnly: true });
  const counts = {};
  const put = async (name, docs) => {
    let added = 0, skipped = 0;
    for (const d of docs) {
      try {
        const r = await db.cols[name].updateOne({ _id: d._id }, { $setOnInsert: d }, { upsert: true });
        r.upsertedCount ? added++ : skipped++;
      } catch (e) {
        if (!db.isDuplicate(e)) throw e;
        skipped++; log(`  skipped ${name} #${d._id}: already used by another record (${String(e.message).slice(0, 70)})`);
      }
    }
    counts[name] = { added, skipped };
    // keep the id counters ahead of everything copied, so new records never clash
    const max = docs.reduce((m, d) => Math.max(m, d._id), 0);
    if (max) await db.cols.counters.updateOne({ _id: name }, { $max: { seq: max } }, { upsert: true });
  };

  await put('restaurants', all(sqlite, 'restaurants').map(r => ({
    _id: r.id, name: r.name, slug: r.slug, owner: r.owner || '', city: r.city || '', address: r.address || '', tagline: r.tagline || '',
    theme_color: r.theme_color || '#d9480f', logo: r.logo || null, contact_phone: r.contact_phone || '',
    price_paid: r.price_paid || 0, paid: r.paid === undefined || r.paid === null ? (r.price_paid || 0) > 0 : !!r.paid,
    plan_expires: r.plan_expires || null, active: r.active === undefined || r.active === null ? true : !!r.active, created_at: r.created_at || stamp(),
  })));
  await put('users', all(sqlite, 'users').map(u => ({
    _id: u.id, email: u.email || null, mobile: u.mobile || null, password_hash: u.password_hash, password_enc: u.password_enc || null,
    role: u.role, restaurant_id: u.restaurant_id ?? null,
  })));
  await put('categories', all(sqlite, 'categories').map(c => ({ _id: c.id, restaurant_id: c.restaurant_id, name: c.name, sort: c.sort || 0 })));
  await put('items', all(sqlite, 'items').map(i => ({
    _id: i.id, restaurant_id: i.restaurant_id, category_id: i.category_id, name: i.name, description: i.description || '',
    price: i.price, image: i.image || null, available: i.available === undefined || i.available === null ? true : !!i.available,
    created_at: stamp(),
  })));
  sqlite.close();
  return counts;
}

module.exports = { migrate };

if (require.main === module) {
  (async () => {
    const file = path.resolve(process.argv[2] || path.join(config.DATA_DIR, 'app.db'));
    if (!fs.existsSync(file)) { console.error(`SQLite file not found: ${file}`); process.exit(1); }
    console.log(`Copying ${file}\n   into MongoDB database "${config.MONGODB_DB}" ...`);
    await db.init({ seed: false }); // no new admin: the migrated one is used
    const counts = await migrate(file);
    for (const [name, c] of Object.entries(counts)) console.log(`  ${name.padEnd(12)} ${c.added} copied, ${c.skipped} already there`);
    await db.close();
    console.log('Done. Start the app; everyone logs in again once.');
  })().catch(e => { console.error('Migration failed:', e.message); process.exit(1); });
}
