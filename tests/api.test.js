// Run with: npm test   (uses a throwaway data dir, never touches your real database)
const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'menucard-test-'));
process.env.ADMIN_EMAIL = 'admin@test.com';
process.env.ADMIN_PASSWORD = 'AdminPass123';
process.env.BASE_URL = 'http://test.local';
process.env.LOGIN_RATE_LIMIT = '10000'; // tests log in far more often than the real limit (20 per 15 min)

const test = require('node:test');
const assert = require('node:assert/strict');
const { startMongo } = require('./helpers');

let base, server, mongo, db;
test.before(async () => {
  mongo = await startMongo();
  db = require('../lib/db');
  const app = require('../app'); // loaded after the env above so it connects to the test MongoDB
  await db.init();
  await new Promise(r => { server = app.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); }); });
});
test.after(async () => { server.close(); await db.close(); await mongo.stop(); fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

// token = bearer auth, cookie = dashboard login cookie
const call = async (method, url, { token, cookie, json, form, headers = {} } = {}) => {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (cookie) h.cookie = cookie;
  if (json) h['content-type'] = 'application/json';
  const res = await fetch(base + url, { method, headers: h, redirect: 'manual', body: json ? JSON.stringify(json) : form });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, type, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
};
const login = async (identifier, password) => (await call('POST', '/api/v1/auth/login', { json: { identifier, password } })).body.token;
const sessionLogin = async (identifier, password) => {
  const r = await call('POST', '/api/v1/auth/session', { json: { identifier, password } });
  return { ...r, cookie: r.headers.get('set-cookie')?.split(';')[0] };
};

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const PNG_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const uploadsDir = () => path.join(process.env.DATA_DIR, 'uploads');
const settle = () => new Promise(r => setTimeout(r, 100)); // file deletes are fire-and-forget

test('pages are served', async () => {
  const home = await call('GET', '/');
  assert.equal(home.status, 200);
  assert.match(home.body.toString(), /one <span>scan<\/span> away/);
  for (const p of ['/login', '/admin', '/dashboard']) {
    const r = await call('GET', p);
    assert.equal(r.status, 200, p);
    assert.match(r.type, /text\/html/);
  }
  assert.equal((await call('GET', '/m/does-not-exist')).status, 404);
  assert.equal((await call('GET', '/style.css')).status, 200);
  // scripts/pages are revalidated every time (no stale mix after a deploy); fonts are cached long
  for (const f of ['/app.js', '/style.css', '/admin.html']) assert.equal((await call('GET', f)).headers.get('cache-control'), 'no-cache', f);
  assert.match((await call('GET', '/fonts/inter-latin.woff2')).headers.get('cache-control'), /max-age=31536000/);
  assert.equal((await call('GET', '/fonts/inter-latin.woff2')).status, 200);
  const h = await call('GET', '/health');
  assert.equal(h.status, 200);
  assert.equal(h.body.status, 'ok');
});

test('cookie login, token login, logout and the cross-site check', async () => {
  assert.equal((await call('POST', '/api/v1/auth/login', { json: { identifier: 'admin@test.com', password: 'wrong' } })).status, 401);
  assert.equal((await call('GET', '/api/v1/admin/summary')).status, 401);

  const s = await sessionLogin('admin@test.com', 'AdminPass123');
  assert.equal(s.status, 200);
  assert.equal(s.body.role, 'admin');
  assert.match(s.headers.get('set-cookie'), /HttpOnly/i);
  assert.equal((await call('GET', '/api/v1/auth/me', { cookie: s.cookie })).body.user.role, 'admin');
  assert.equal((await call('GET', '/api/v1/admin/summary', { cookie: s.cookie })).status, 200);

  // a write coming from another site is refused even with a valid cookie
  const evil = await call('POST', '/api/v1/admin/restaurants', { cookie: s.cookie, headers: { origin: 'http://evil.example' }, json: { name: 'X', mobile: '9000000000' } });
  assert.equal(evil.status, 403);
  // ...while the same origin is fine
  const same = await call('PATCH', '/api/v1/admin/restaurants/999', { cookie: s.cookie, headers: { origin: base }, json: { name: 'x' } });
  assert.equal(same.status, 404);

  // logout kills the session
  assert.equal((await call('DELETE', '/api/v1/auth/session', { cookie: s.cookie })).status, 204);
  assert.equal((await call('GET', '/api/v1/auth/me', { cookie: s.cookie })).status, 401);
});

test('onboarding: validation, generated password, summary, login by mobile or email', async () => {
  const admin = await login('admin@test.com', 'AdminPass123');
  const post = json => call('POST', '/api/v1/admin/restaurants', { token: admin, json });

  assert.equal((await post({ name: 'No Mobile', email: 'a@b.com' })).status, 400);
  assert.equal((await post({ name: 'Bad Mobile', mobile: '12ab' })).status, 400);
  assert.equal((await post({ name: 'Short Pw', mobile: '9000000020', password: '1' })).status, 400);
  assert.equal((await post({ name: 'Bad Plan', mobile: '9000000021', plan_type: 'limited' })).status, 400);
  assert.equal((await post({ name: 'Bad Plan', mobile: '9000000021', plan_type: 'weekly' })).status, 400);

  // blank password => generated and returned once; owner/city/paid stored
  const a = await post({ name: 'Spice Garden', owner: 'Ravi', city: 'Chennai', mobile: '+91 98765-43210', email: 'Ravi@Spice.com', price_paid: 4999, paid: true });
  assert.equal(a.status, 201);
  assert.equal(a.body.slug, 'spice-garden');
  assert.equal(a.body.owner_mobile, '+919876543210');
  assert.equal(a.body.owner_email, 'ravi@spice.com');
  assert.equal(a.body.owner, 'Ravi');
  assert.equal(a.body.paid, true);
  assert.equal(a.body.plan_type, 'one_time');
  assert.ok(a.body.generated_password.length >= 10);
  assert.ok(await login('+919876543210', a.body.generated_password));       // by mobile
  assert.ok(await login('+91 98765 43210', a.body.generated_password));                      // formatting ignored
  assert.ok(await login('RAVI@spice.com', a.body.generated_password));                        // by email
  assert.equal((await call('GET', `/api/v1/admin/restaurants/${a.body.id}`, { token: admin })).body.generated_password, undefined);

  // email optional; limited plan with a date; unpaid
  const b = await post({ name: 'Green Bowl', mobile: '9000000002', password: 'secret12', price_paid: 2999, plan_type: 'limited', plan_expires: '2099-12-31' });
  assert.equal(b.status, 201);
  assert.equal(b.body.owner_email, null);
  assert.equal(b.body.plan_type, 'limited');
  assert.equal(b.body.paid, false);
  assert.equal(b.body.generated_password, undefined);

  // duplicates
  assert.equal((await post({ name: 'Dup', mobile: '9000000002' })).status, 409);
  assert.equal((await post({ name: 'Dup', mobile: '9000000099', email: 'ravi@spice.com' })).status, 409);

  // numbers for the admin dashboard: revenue counts only payments received
  const sum = (await call('GET', '/api/v1/admin/summary', { token: admin })).body;
  assert.deepEqual({ r: sum.restaurants, a: sum.active, i: sum.inactive, rev: sum.revenue, out: sum.outstanding }, { r: 2, a: 2, i: 0, rev: 4999, out: 2999 });

  // edit: rename, move mobile/email, flip payment + plan
  const upd = await call('PATCH', `/api/v1/admin/restaurants/${b.body.id}`, { token: admin, json: { name: 'Green Bowl Cafe', owner: 'Anita', city: 'Pune', mobile: '9000000012', email: 'gb@x.com', paid: true, plan_type: 'one_time' } });
  assert.equal(upd.status, 200);
  assert.deepEqual([upd.body.name, upd.body.owner, upd.body.city, upd.body.paid, upd.body.plan_expires, upd.body.owner_mobile], ['Green Bowl Cafe', 'Anita', 'Pune', true, null, '9000000012']);
  assert.equal((await call('POST', '/api/v1/auth/login', { json: { identifier: '9000000002', password: 'secret12' } })).status, 401); // old mobile dead
  assert.ok(await login('gb@x.com', 'secret12'));
  assert.equal((await call('PATCH', `/api/v1/admin/restaurants/${b.body.id}`, { token: admin, json: { mobile: '+919876543210' } })).status, 409);
  assert.equal((await call('PATCH', `/api/v1/admin/restaurants/${b.body.id}`, { token: admin, json: { plan_type: 'limited' } })).status, 400);
  assert.equal((await call('PATCH', `/api/v1/admin/restaurants/${b.body.id}`, { token: admin, json: { mobile: 'abc' } })).status, 400);
  const sum2 = (await call('GET', '/api/v1/admin/summary', { token: admin })).body;
  assert.equal(sum2.revenue, 7998);
  assert.equal(sum2.outstanding, 0);
});

test('owner menu: categories, items with photos, availability, profile, public menu', async () => {
  const admin = await login('admin@test.com', 'AdminPass123');
  const r = (await call('POST', '/api/v1/admin/restaurants', { token: admin, json: { name: 'Menu Test Cafe', mobile: '9111100001', password: 'secret12' } })).body;
  const owner = await login('9111100001', 'secret12');
  const other = await call('POST', '/api/v1/admin/restaurants', { token: admin, json: { name: 'Other Cafe', mobile: '9111100002', password: 'secret12' } });
  const owner2 = await login('9111100002', 'secret12');

  // role separation
  assert.equal((await call('GET', '/api/v1/admin/restaurants', { token: owner })).status, 403);
  assert.equal((await call('GET', '/api/v1/categories', { token: admin })).status, 403);

  // categories
  const cat = (await call('POST', '/api/v1/categories', { token: owner, json: { name: 'Starters' } })).body;
  assert.ok(cat.id);
  assert.equal((await call('PUT', `/api/v1/categories/${cat.id}`, { token: owner, json: { name: 'Starters & Snacks' } })).status, 200);
  assert.equal((await call('POST', '/api/v1/categories', { token: owner, json: { name: '  ' } })).status, 400);

  // item with a photo sent as a data URL (what the dashboard does)
  const made = await call('POST', '/api/v1/items', { token: owner, json: { name: 'Paneer Tikka', description: 'Smoky', price: '199.5', category_id: cat.id, available: true, image: PNG_URL } });
  assert.equal(made.status, 201);
  assert.match(made.body.image, /^\/uploads\/.+\.png$/);
  assert.match(made.body.image_url, /^http:\/\/test\.local\/uploads\/.+\.png$/);
  assert.equal(made.body.price, 199.5);
  const file1 = path.join(uploadsDir(), path.basename(made.body.image));
  assert.ok(fs.existsSync(file1));
  assert.equal((await call('GET', made.body.image)).status, 200);

  // bad image / bad data
  assert.equal((await call('POST', '/api/v1/items', { token: owner, json: { name: 'Bad', price: 5, category_id: cat.id, image: 'data:text/html;base64,PGI+' } })).status, 400);
  assert.equal((await call('POST', '/api/v1/items', { token: owner, json: { name: 'Bad', price: -1, category_id: cat.id } })).status, 400);
  assert.equal((await call('POST', '/api/v1/items', { token: owner, json: { name: 'Bad', price: 5, category_id: 99999 } })).status, 400);
  assert.equal((await call('POST', '/api/v1/items', { token: owner, json: { name: '', price: 5, category_id: cat.id } })).status, 400);

  // multipart upload still works, and replacing a photo deletes the old file
  const form = new FormData();
  form.set('name', 'Spring Rolls'); form.set('price', '149'); form.set('category_id', String(cat.id));
  form.set('image', new Blob([GIF], { type: 'image/gif' }), 'a.gif');
  const rolls = await call('POST', '/api/v1/items', { token: owner, form });
  assert.equal(rolls.status, 201);
  const replaced = await call('PUT', `/api/v1/items/${made.body.id}`, { token: owner, json: { name: 'Paneer Tikka', price: 210, category_id: cat.id, image: PNG_URL } });
  assert.equal(replaced.body.price, 210);
  await settle();
  assert.ok(!fs.existsSync(file1));                                  // old photo gone
  assert.ok(fs.existsSync(path.join(uploadsDir(), path.basename(replaced.body.image))));

  // remove_image clears the photo; omitting image keeps it
  const keep = await call('PUT', `/api/v1/items/${rolls.body.id}`, { token: owner, json: { name: 'Spring Rolls', price: 149, category_id: cat.id } });
  assert.ok(keep.body.image);
  const rm = await call('PUT', `/api/v1/items/${rolls.body.id}`, { token: owner, json: { name: 'Spring Rolls', price: 149, category_id: cat.id, remove_image: true } });
  assert.equal(rm.body.image, null);

  // hidden items disappear from the public menu; the category now reports its item count
  assert.equal((await call('GET', '/api/v1/categories', { token: owner })).body.categories[0].items, 2);
  await call('PATCH', `/api/v1/items/${rolls.body.id}/availability`, { token: owner, json: { available: false } });
  const pub = (await call('GET', `/api/v1/public/menu/${r.slug}`)).body;
  assert.deepEqual(pub.categories[0].items.map(i => i.name), ['Paneer Tikka']);
  assert.equal((await call('GET', `/m/${r.slug}`)).status, 200);

  // tenant isolation
  assert.equal((await call('DELETE', `/api/v1/items/${made.body.id}`, { token: owner2 })).status, 404);
  assert.equal((await call('PUT', `/api/v1/items/${made.body.id}`, { token: owner2, json: { name: 'x', price: 1, category_id: cat.id } })).status, 400);
  assert.equal((await call('DELETE', `/api/v1/categories/${cat.id}`, { token: owner2 })).status, 404);

  // a category that still has items can't be deleted; an empty one can
  assert.equal((await call('DELETE', `/api/v1/categories/${cat.id}`, { token: owner })).status, 409);
  const empty = (await call('POST', '/api/v1/categories', { token: owner, json: { name: 'Empty' } })).body;
  assert.equal((await call('DELETE', `/api/v1/categories/${empty.id}`, { token: owner })).status, 204);

  // profile + branding, with a logo sent as a data URL
  assert.equal((await call('PATCH', '/api/v1/restaurant', { token: owner, json: { name: 'Menu Test Cafe', theme_color: 'red' } })).status, 400);
  const prof = await call('PATCH', '/api/v1/restaurant', { token: owner, json: { name: 'Menu Test Cafe', owner: 'Sam', city: 'Goa', address: '1 Beach Rd', tagline: 'Fresh daily', theme_color: '#0f766e', contact_phone: '9000011111', logo: PNG_URL } });
  assert.equal(prof.status, 200);
  assert.deepEqual([prof.body.tagline, prof.body.theme_color, prof.body.city, prof.body.contact_phone], ['Fresh daily', '#0f766e', 'Goa', '9000011111']);
  assert.match(prof.body.logo, /^\/uploads\//);
  const logoFile = path.join(uploadsDir(), path.basename(prof.body.logo));
  const pub2 = (await call('GET', `/api/v1/public/menu/${r.slug}`)).body.restaurant;
  assert.deepEqual([pub2.tagline, pub2.theme_color, pub2.phone, pub2.logo], ['Fresh daily', '#0f766e', '9000011111', prof.body.logo]);
  const noLogo = await call('PATCH', '/api/v1/restaurant', { token: owner, json: { name: 'Menu Test Cafe', remove_logo: true } });
  assert.equal(noLogo.body.logo, null);
  await settle();
  assert.ok(!fs.existsSync(logoFile));

  // QR code
  const qr = await call('GET', '/api/v1/qr.png?size=300', { token: owner });
  assert.equal(qr.status, 200);
  assert.equal(qr.type, 'image/png');

  // deleting an item or the whole restaurant removes the photo files
  const photoFile = path.join(uploadsDir(), path.basename(replaced.body.image));
  assert.equal((await call('DELETE', `/api/v1/items/${made.body.id}`, { token: owner })).status, 204);
  await settle();
  assert.ok(!fs.existsSync(photoFile));
  assert.equal((await call('DELETE', `/api/v1/admin/restaurants/${other.body.id}`, { token: admin })).status, 204);
  assert.equal((await call('GET', '/api/v1/categories', { token: owner2 })).status, 401);   // owner of a deleted restaurant is gone
});

test('active/inactive and plan expiry hide the menu and lock the owner out', async () => {
  const admin = await login('admin@test.com', 'AdminPass123');
  const r = (await call('POST', '/api/v1/admin/restaurants', { token: admin, json: { name: 'Switch Cafe', mobile: '9222200001', password: 'secret12' } })).body;
  const owner = await login('9222200001', 'secret12');
  const sess = await sessionLogin('9222200001', 'secret12');
  const cat = (await call('POST', '/api/v1/categories', { token: owner, json: { name: 'Mains' } })).body;
  await call('POST', '/api/v1/items', { token: owner, json: { name: 'Dal', price: 80, category_id: cat.id } });
  assert.equal((await call('GET', `/api/v1/public/menu/${r.slug}`)).status, 200);

  await call('PATCH', `/api/v1/admin/restaurants/${r.id}`, { token: admin, json: { active: false } });
  assert.equal((await call('GET', '/api/v1/categories', { token: owner })).status, 401);          // token dead at once
  assert.equal((await call('GET', '/api/v1/restaurant', { cookie: sess.cookie })).status, 401);   // so is the cookie session
  const again = await call('POST', '/api/v1/auth/session', { json: { identifier: '9222200001', password: 'secret12' } });
  assert.equal(again.status, 403);
  assert.equal((await call('GET', `/api/v1/public/menu/${r.slug}`)).status, 404);
  assert.equal((await call('GET', `/m/${r.slug}`)).status, 404);
  assert.equal((await call('GET', '/api/v1/admin/summary', { token: admin })).body.inactive, 1);

  await call('PATCH', `/api/v1/admin/restaurants/${r.id}`, { token: admin, json: { active: true } });
  assert.equal((await call('GET', `/api/v1/public/menu/${r.slug}`)).status, 200);

  await call('PATCH', `/api/v1/admin/restaurants/${r.id}`, { token: admin, json: { plan_type: 'limited', plan_expires: '2000-01-01' } });
  assert.equal((await call('GET', `/api/v1/public/menu/${r.slug}`)).status, 404);                 // expired
});

test('super admin can view the password it set (encrypted at rest); owner changes clear it', async () => {
  const admin = await login('admin@test.com', 'AdminPass123');
  const reveal = (id, opts = { token: admin }) => call('POST', `/api/v1/admin/restaurants/${id}/reveal-password`, opts);

  const r = await call('POST', '/api/v1/admin/restaurants', { token: admin, json: { name: 'Vault Cafe', mobile: '9000000055', password: 'Vault#Pass1' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.has_password, true);
  const shown = await reveal(r.body.id);
  assert.equal(shown.body.password, 'Vault#Pass1');
  assert.equal(shown.headers.get('cache-control'), 'no-store');

  // never stored as plain text in the database; login still uses a bcrypt hash
  const row = await db.cols.users.findOne({ mobile: '9000000055' });
  assert.ok(row.password_enc && !row.password_enc.includes('Vault#Pass1'));
  assert.ok(row.password_hash.startsWith('$2'));

  // admin only
  assert.equal((await call('POST', `/api/v1/admin/restaurants/${r.body.id}/reveal-password`)).status, 401);
  const owner = await login('9000000055', 'Vault#Pass1');
  assert.equal((await reveal(r.body.id, { token: owner })).status, 403);

  // admin changes it => the new one is shown; reset generates one that works and is shown
  await call('PATCH', `/api/v1/admin/restaurants/${r.body.id}`, { token: admin, json: { password: 'Second#Pass2' } });
  assert.equal((await reveal(r.body.id)).body.password, 'Second#Pass2');
  const reset = await call('POST', `/api/v1/admin/restaurants/${r.body.id}/reset-password`, { token: admin });
  assert.ok(reset.body.password.length >= 10);
  assert.equal(reset.body.mobile, '9000000055');
  assert.equal((await call('POST', '/api/v1/auth/login', { json: { identifier: '9000000055', password: 'Second#Pass2' } })).status, 401);
  assert.ok(await login('9000000055', reset.body.password));
  assert.equal((await reveal(r.body.id)).body.password, reset.body.password);

  // once the owner picks their own password, the admin copy is cleared (it would be stale)
  const owner2 = await login('9000000055', reset.body.password);
  assert.equal((await call('POST', '/api/v1/auth/password', { token: owner2, json: { current_password: 'wrong', new_password: 'OwnerChose3' } })).status, 400);
  assert.equal((await call('POST', '/api/v1/auth/password', { token: owner2, json: { current_password: reset.body.password, new_password: 'OwnerChose3' } })).status, 204);
  assert.equal((await reveal(r.body.id)).body.password, null);
  const list = (await call('GET', '/api/v1/admin/restaurants', { token: admin })).body.restaurants.find(x => x.id === r.body.id);
  assert.equal(list.has_password, false);
  assert.ok(!JSON.stringify(list).includes('OwnerChose3'));
  assert.ok(await login('9000000055', 'OwnerChose3'));
});

test('admin can manage any restaurant\'s menu from the admin console', async () => {
  const admin = await login('admin@test.com', 'AdminPass123');
  const A = (method, url, json) => call(method, '/api/v1/admin/restaurants' + url, { token: admin, json });
  const r1 = (await call('POST', '/api/v1/admin/restaurants', { token: admin, json: { name: 'Managed Cafe', mobile: '9333300001', password: 'secret12' } })).body;
  const r2 = (await call('POST', '/api/v1/admin/restaurants', { token: admin, json: { name: 'Other Managed', mobile: '9333300002', password: 'secret12' } })).body;
  const owner1 = await login('9333300001', 'secret12');

  // add a category and a dish (with a photo) for restaurant 1 without using its login
  const cat = await A('POST', `/${r1.id}/categories`, { name: 'Starters' });
  assert.equal(cat.status, 201);
  const dish = await A('POST', `/${r1.id}/items`, { name: 'Paneer Tikka', price: 199, category_id: cat.body.id, image: PNG_URL });
  assert.equal(dish.status, 201);
  assert.match(dish.body.image, /^\/uploads\//);
  assert.equal((await A('GET', `/${r1.id}/categories`)).body.categories[0].items, 1);

  // the owner sees exactly what the admin added; so do guests
  assert.deepEqual((await call('GET', '/api/v1/items', { token: owner1 })).body.items.map(i => i.name), ['Paneer Tikka']);
  assert.equal((await call('GET', `/api/v1/public/menu/${r1.slug}`)).body.categories[0].items[0].name, 'Paneer Tikka');

  // edit, hide and filter
  assert.equal((await A('PUT', `/${r1.id}/items/${dish.body.id}`, { name: 'Paneer Tikka', price: 220, category_id: cat.body.id })).body.price, 220);
  assert.equal((await A('PATCH', `/${r1.id}/items/${dish.body.id}/availability`, { available: false })).body.available, false);
  assert.equal((await call('GET', `/api/v1/public/menu/${r1.slug}`)).body.categories.length, 0);
  assert.equal((await A('GET', `/${r1.id}/items?category_id=${cat.body.id}`)).body.items.length, 1);

  // restaurants stay separate: another restaurant's path can't reach this restaurant's data
  assert.equal((await A('GET', `/${r2.id}/items`)).body.items.length, 0);
  assert.equal((await A('PUT', `/${r2.id}/items/${dish.body.id}`, { name: 'x', price: 1, category_id: cat.body.id })).status, 400); // category belongs to restaurant 1
  assert.equal((await A('DELETE', `/${r2.id}/items/${dish.body.id}`)).status, 404);
  assert.equal((await A('POST', `/${r2.id}/items`, { name: 'Sneaky', price: 5, category_id: cat.body.id })).status, 400);
  assert.equal((await A('GET', '/999999/items')).status, 404);                                     // unknown restaurant

  // access rules: not for owners, not for anonymous callers
  assert.equal((await call('GET', `/api/v1/admin/restaurants/${r1.id}/items`, { token: owner1 })).status, 403);
  assert.equal((await call('GET', `/api/v1/admin/restaurants/${r1.id}/items`)).status, 401);

  // a category with dishes can't be deleted; remove the dish first
  assert.equal((await A('DELETE', `/${r1.id}/categories/${cat.body.id}`)).status, 409);
  assert.equal((await A('DELETE', `/${r1.id}/items/${dish.body.id}`)).status, 204);
  assert.equal((await A('DELETE', `/${r1.id}/categories/${cat.body.id}`)).status, 204);

  // the admin list still reports item counts the table shows
  assert.equal((await call('GET', `/api/v1/admin/restaurants/${r1.id}`, { token: admin })).body.item_count, 0);
});

test('Add menu: browse other restaurants, copy dishes and categories into mine', async () => {
  const admin = await login('admin@test.com', 'AdminPass123');
  const mk = async (name, mobile, extra = {}) => (await call('POST', '/api/v1/admin/restaurants', { token: admin, json: { name, mobile, password: 'secret12', ...extra } })).body;
  const me = await mk('Lib Target', '9444400001'), src = await mk('Lib Source', '9444400002');
  const off = await mk('Lib Inactive', '9444400003'), old = await mk('Lib Expired', '9444400004', { plan_type: 'limited', plan_expires: '2000-01-01' });
  const [meT, srcT, offT, oldT] = await Promise.all(['9444400001', '9444400002', '9444400003', '9444400004'].map(m => login(m, 'secret12')));
  const add = async (t, cat, name, price, extra = {}) => {
    const c = (await call('GET', '/api/v1/categories', { token: t })).body.categories.find(x => x.name === cat) || (await call('POST', '/api/v1/categories', { token: t, json: { name: cat } })).body;
    return (await call('POST', '/api/v1/items', { token: t, json: { name, price, category_id: c.id, description: `${name} desc`, ...extra } })).body;
  };
  const tikka = await add(srcT, 'Starters', 'Paneer Tikka', 199, { image: PNG_URL });
  const roll = await add(srcT, 'Starters', 'Veg Roll', 99);
  const lassi = await add(srcT, 'Drinks', 'Sweet Lassi', 60);
  await call('PATCH', `/api/v1/items/${lassi.id}/availability`, { token: srcT, json: { available: false } }); // hidden: must not be offered
  const ghost = await add(offT, 'Starters', 'Inactive Special', 50);                                      // inactive restaurant
  const stale = await add(oldT, 'Starters', 'Expired Special', 50);                                       // expired plan
  await call('PATCH', `/api/v1/admin/restaurants/${off.id}`, { token: admin, json: { active: false } });
  const mine = await add(meT, 'Starters', 'My Own Dish', 10);

  // catalogue: only visible dishes of live restaurants, never my own
  const cats = (await call('GET', '/api/v1/library/categories', { token: meT })).body.categories;
  assert.deepEqual(cats.map(c => [c.restaurant, c.name, c.items]), [['Lib Source', 'Starters', 2]]);   // Drinks has no visible dish
  const all = (await call('GET', '/api/v1/library/items', { token: meT })).body;
  assert.deepEqual(all.items.map(i => i.name), ['Paneer Tikka', 'Veg Roll']);
  assert.equal(all.total, 2);
  assert.equal(all.items[0].restaurant, 'Lib Source');
  const get = q => call('GET', `/api/v1/library/items?${q}`, { token: meT }).then(r => r.body);
  assert.deepEqual((await get('q=TIKKA')).items.map(i => i.name), ['Paneer Tikka']);                 // search, case-insensitive
  assert.deepEqual((await get('category=starters')).items.length, 2);                                 // category by name
  assert.equal((await get('category=drinks')).total, 0);
  assert.equal((await get(`restaurant_id=${off.id}`)).total, 0);
  const page = await get('limit=1&offset=1');
  assert.deepEqual([page.items.map(i => i.name), page.total], [['Veg Roll'], 2]);                      // paging
  assert.equal((await get('q=.*')).total, 0);                                                         // search text is not a regex

  // copy one dish: category is created, the photo is copied (own file), the source is untouched
  const one = await call('POST', '/api/v1/library/import', { token: meT, json: { items: [tikka.id] } });
  assert.deepEqual(one.body, { added_items: 1, skipped_items: 0, added_categories: 0 });               // "Starters" already existed
  const myItems = (await call('GET', '/api/v1/items', { token: meT })).body.items;
  const copy = myItems.find(i => i.name === 'Paneer Tikka');
  assert.deepEqual([copy.price, copy.description, copy.category, copy.available], [199, 'Paneer Tikka desc', 'Starters', true]);
  assert.notEqual(copy.image, tikka.image);
  assert.ok(fs.existsSync(path.join(uploadsDir(), path.basename(copy.image))));

  // same dish again is skipped
  assert.deepEqual((await call('POST', '/api/v1/library/import', { token: meT, json: { items: [tikka.id] } })).body, { added_items: 0, skipped_items: 1, added_categories: 0 });

  // a whole category with its dishes: only the missing dish is added
  const withItems = await call('POST', '/api/v1/library/import', { token: meT, json: { categories: [{ category_id: cats[0].category_id, with_items: true }] } });
  assert.deepEqual(withItems.body, { added_items: 1, skipped_items: 1, added_categories: 0 });
  assert.deepEqual((await call('GET', '/api/v1/items', { token: meT })).body.items.map(i => i.name).sort(), ['My Own Dish', 'Paneer Tikka', 'Veg Roll']);

  // a category alone (no dishes) creates just the category, named like the source
  const srcDrinks = (await call('GET', '/api/v1/categories', { token: srcT })).body.categories.find(c => c.name === 'Drinks');
  assert.equal((await call('POST', '/api/v1/library/import', { token: meT, json: { categories: [{ category_id: srcDrinks.id }] } })).body.added_categories, 1);
  assert.ok((await call('GET', '/api/v1/categories', { token: meT })).body.categories.some(c => c.name === 'Drinks' && c.items === 0));

  // things that must never be copied: hidden dishes, inactive/expired restaurants, my own dishes
  const refused = await call('POST', '/api/v1/library/import', { token: meT, json: { items: [lassi.id, ghost.id, stale.id, mine.id] } });
  assert.deepEqual(refused.body, { added_items: 0, skipped_items: 4, added_categories: 0 });
  assert.equal((await call('POST', '/api/v1/library/import', { token: meT, json: {} })).status, 400);
  assert.equal((await call('POST', '/api/v1/library/import', { token: meT, json: { items: Array.from({ length: 301 }, (_, i) => i + 1) } })).status, 400);

  // deleting my copy leaves the source's photo alone
  await call('DELETE', `/api/v1/items/${copy.id}`, { token: meT });
  await settle();
  assert.ok(fs.existsSync(path.join(uploadsDir(), path.basename(tikka.image))));

  // the admin can do the same for a restaurant ("Manage menu" -> "Add menu"); owners of other restaurants can't
  const viaAdmin = await call('POST', `/api/v1/admin/restaurants/${me.id}/library/import`, { token: admin, json: { items: [tikka.id] } });
  assert.deepEqual(viaAdmin.body, { added_items: 1, skipped_items: 0, added_categories: 0 });
  assert.equal((await call('GET', `/api/v1/admin/restaurants/${me.id}/library/items`, { token: admin })).body.items.some(i => i.restaurant_id === me.id), false);
  assert.equal((await call('GET', `/api/v1/admin/restaurants/${me.id}/library/items`, { token: srcT })).status, 403);
  assert.equal((await call('GET', '/api/v1/library/items')).status, 401);
});

test('QR code: error-correction level can be raised for a logo', async () => {
  const admin = await login('admin@test.com', 'AdminPass123');
  await call('POST', '/api/v1/admin/restaurants', { token: admin, json: { name: 'Qr Cafe', mobile: '9555500099', password: 'secret12' } });
  const t = await login('9555500099', 'secret12');
  const png = async q => (await call('GET', `/api/v1/qr.png?size=400${q}`, { token: t })).body;
  const plain = await png(''), high = await png('&level=H'), bogus = await png('&level=Z');
  assert.equal(plain[1], 0x50);                         // a PNG
  assert.notDeepEqual(plain, high);                     // level H draws a denser code
  assert.deepEqual(bogus, plain);                       // unknown levels fall back to the default
});
