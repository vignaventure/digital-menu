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
const app = require('../app');

let base, server;
test.before(() => new Promise(r => { server = app.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); }); }));
test.after(() => { server.close(); fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

const call = async (method, url, { token, json, form } = {}) => {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (json) headers['content-type'] = 'application/json';
  const res = await fetch(base + url, { method, headers, body: json ? JSON.stringify(json) : form });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), type };
};
const login = async (email, password) => (await call('POST', '/api/v1/auth/login', { json: { email, password } })).body.token;

// 1x1 transparent GIF
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

test('landing page is served at /', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /one <span>scan<\/span> away/);
});

test('health check', async () => {
  const r = await call('GET', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'ok');
});

test('full flow: onboard → manage menu → public menu → QR', async () => {
  // auth
  assert.equal((await call('POST', '/api/v1/auth/login', { json: { email: 'admin@test.com', password: 'wrong' } })).status, 401);
  assert.equal((await call('GET', '/api/v1/admin/restaurants')).status, 401);
  const admin = await login('admin@test.com', 'AdminPass123');

  // onboard
  const created = await call('POST', '/api/v1/admin/restaurants', {
    token: admin, json: { name: 'Spice Villa', mobile: '+91 98765-43210', email: 'Owner@Spice.com', password: 'secret12', price_paid: 999, plan_type: 'limited', plan_expires: '2099-01-01' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.slug, 'spice-villa');
  assert.equal(created.body.menu_url, 'http://test.local/m/spice-villa');
  assert.equal((await call('POST', '/api/v1/admin/restaurants', { token: admin, json: { name: 'X', mobile: '9000000009', email: 'owner@spice.com', password: 'secret12' } })).status, 409);
  assert.equal((await call('POST', '/api/v1/admin/restaurants', { token: admin, json: { name: 'X', mobile: '+919876543210', password: 'secret12' } })).status, 409); // same mobile, different formatting
  assert.equal((await call('POST', '/api/v1/admin/restaurants', { token: admin, json: { name: 'X', email: 'bad', password: '1' } })).status, 400);

  // owner can't use admin API; admin can't use owner API
  const owner = await login('owner@spice.com', 'secret12');
  assert.equal((await call('GET', '/api/v1/admin/restaurants', { token: owner })).status, 403);
  assert.equal((await call('GET', '/api/v1/categories', { token: admin })).status, 403);

  // categories
  const cat = (await call('POST', '/api/v1/categories', { token: owner, json: { name: 'Starters' } })).body;
  assert.ok(cat.id);
  assert.equal((await call('PUT', `/api/v1/categories/${cat.id}`, { token: owner, json: { name: 'Starters & Snacks' } })).status, 200);

  // item with image (multipart)
  const form = new FormData();
  form.set('name', 'Paneer Tikka'); form.set('description', 'Smoky'); form.set('price', '199.5'); form.set('category_id', String(cat.id));
  form.set('image', new Blob([GIF], { type: 'image/gif' }), 'a.gif');
  const item = await call('POST', '/api/v1/items', { token: owner, form });
  assert.equal(item.status, 201);
  assert.match(item.body.image_url, /^http:\/\/test\.local\/uploads\/.+\.gif$/);
  const file = path.join(process.env.DATA_DIR, 'uploads', path.basename(item.body.image_url));
  assert.ok(fs.existsSync(file));

  // validation
  assert.equal((await call('POST', '/api/v1/items', { token: owner, json: { name: 'Bad', price: -1, category_id: cat.id } })).status, 400);
  assert.equal((await call('POST', '/api/v1/items', { token: owner, json: { name: 'Bad', price: 5, category_id: 9999 } })).status, 400);

  // image is served
  assert.equal((await call('GET', new URL(item.body.image_url).pathname)).status, 200);

  // public menu shows it; hiding removes it
  let menu = await call('GET', '/api/v1/public/menu/spice-villa');
  assert.equal(menu.body.categories[0].items[0].name, 'Paneer Tikka');
  assert.equal((await call('GET', '/m/spice-villa')).status, 200);
  await call('PATCH', `/api/v1/items/${item.body.id}/availability`, { token: owner, json: { available: false } });
  assert.equal((await call('GET', '/api/v1/public/menu/spice-villa')).body.categories.length, 0);

  // tenant isolation: another restaurant can't touch this item
  await call('POST', '/api/v1/admin/restaurants', { token: admin, json: { name: 'Other Cafe', mobile: '9000000002', email: 'o2@cafe.com', password: 'secret12' } });
  const owner2 = await login('o2@cafe.com', 'secret12');
  assert.equal((await call('DELETE', `/api/v1/items/${item.body.id}`, { token: owner2 })).status, 404);

  // QR
  const qr = await call('GET', '/api/v1/qr.png', { token: owner });
  assert.equal(qr.status, 200);
  assert.equal(qr.type, 'image/png');

  // password change
  assert.equal((await call('POST', '/api/v1/auth/password', { token: owner, json: { current_password: 'nope', new_password: 'newsecret1' } })).status, 400);
  assert.equal((await call('POST', '/api/v1/auth/password', { token: owner, json: { current_password: 'secret12', new_password: 'newsecret1' } })).status, 204);
  await login('owner@spice.com', 'newsecret1');

  // delete item removes the file
  assert.equal((await call('DELETE', `/api/v1/items/${item.body.id}`, { token: owner })).status, 204);
  await new Promise(r => setTimeout(r, 100));
  assert.ok(!fs.existsSync(file));

  // disabling a restaurant locks out the owner immediately and hides the menu
  await call('POST', '/api/v1/categories', { token: owner, json: { name: 'Mains' } });
  assert.equal((await call('PATCH', `/api/v1/admin/restaurants/${created.body.id}`, { token: admin, json: { active: false } })).status, 200);
  assert.equal((await call('GET', '/api/v1/categories', { token: owner })).status, 401);
  assert.equal((await call('POST', '/api/v1/auth/login', { json: { email: 'owner@spice.com', password: 'newsecret1' } })).status, 403);
  assert.equal((await call('GET', '/api/v1/public/menu/spice-villa')).status, 404);
  assert.equal((await call('GET', '/m/spice-villa')).status, 404);

  // expired plan hides the menu
  await call('PATCH', `/api/v1/admin/restaurants/${created.body.id}`, { token: admin, json: { active: true, plan_expires: '2000-01-01' } });
  assert.equal((await call('GET', '/api/v1/public/menu/spice-villa')).status, 404);

  // delete restaurant
  assert.equal((await call('DELETE', `/api/v1/admin/restaurants/${created.body.id}`, { token: admin })).status, 204);
  assert.equal((await call('GET', `/api/v1/admin/restaurants/${created.body.id}`, { token: admin })).status, 404);
});

test('owner/mobile rules, login by email or mobile, plan types, edit, generated password', async () => {
  const admin = await login('admin@test.com', 'AdminPass123');
  const post = json => call('POST', '/api/v1/admin/restaurants', { token: admin, json });

  // mobile mandatory, email optional
  assert.equal((await post({ name: 'No Mobile', email: 'a@b.com', password: 'secret12' })).status, 400);
  assert.equal((await post({ name: 'Bad Mobile', mobile: '12ab', password: 'secret12' })).status, 400);
  const noEmail = await post({ name: 'Mobile Only', mobile: '(900) 000-0011', password: 'secret12' });
  assert.equal(noEmail.status, 201);
  assert.equal(noEmail.body.owner_mobile, '9000000011');
  assert.equal(noEmail.body.owner_email, null);
  assert.equal(noEmail.body.plan_type, 'one_time');
  assert.equal(noEmail.body.plan_expires, null);

  // login accepts mobile (any formatting) or email
  assert.ok(await login('9000000011', 'secret12'));
  assert.ok(await login('900 000 0011', 'secret12'));
  assert.equal((await call('POST', '/api/v1/auth/login', { json: { identifier: '9000000011', password: 'nope' } })).status, 401);
  assert.equal((await call('POST', '/api/v1/auth/login', { json: { identifier: '9999999999', password: 'secret12' } })).status, 401);

  // limited plan needs a date; one_time clears it
  assert.equal((await post({ name: 'Lim', mobile: '9000000012', password: 'secret12', plan_type: 'limited' })).status, 400);
  assert.equal((await post({ name: 'Lim', mobile: '9000000012', password: 'secret12', plan_type: 'weekly' })).status, 400);
  const lim = await post({ name: 'Lim', mobile: '9000000012', password: 'secret12', plan_type: 'limited', plan_expires: '2099-12-31' });
  assert.equal(lim.body.plan_type, 'limited');
  const back = await call('PATCH', `/api/v1/admin/restaurants/${lim.body.id}`, { token: admin, json: { plan_type: 'one_time' } });
  assert.equal(back.body.plan_expires, null);
  assert.equal((await call('PATCH', `/api/v1/admin/restaurants/${lim.body.id}`, { token: admin, json: { plan_type: 'limited' } })).status, 400);

  // server-side generated password is returned once and works
  const gen = await post({ name: 'Gen Pw', mobile: '9000000013', generate_password: true });
  assert.equal(gen.status, 201);
  assert.ok(gen.body.generated_password.length >= 10);
  assert.ok(await login('9000000013', gen.body.generated_password));
  assert.equal((await call('GET', `/api/v1/admin/restaurants/${gen.body.id}`, { token: admin })).body.generated_password, undefined);

  // edit: change mobile + email + password; old login stops working; duplicates rejected
  const upd = await call('PATCH', `/api/v1/admin/restaurants/${lim.body.id}`, { token: admin, json: { name: 'Lim Renamed', mobile: '9000000099', email: 'lim@x.com', password: 'brandnew1' } });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.name, 'Lim Renamed');
  assert.ok(await login('9000000099', 'brandnew1'));
  assert.ok(await login('lim@x.com', 'brandnew1'));
  assert.equal((await call('POST', '/api/v1/auth/login', { json: { identifier: '9000000012', password: 'secret12' } })).status, 401);
  assert.equal((await call('PATCH', `/api/v1/admin/restaurants/${lim.body.id}`, { token: admin, json: { mobile: '9000000011' } })).status, 409);
  assert.equal((await call('PATCH', `/api/v1/admin/restaurants/${lim.body.id}`, { token: admin, json: { mobile: 'abc' } })).status, 400);
  // keeping own mobile on edit is fine
  assert.equal((await call('PATCH', `/api/v1/admin/restaurants/${lim.body.id}`, { token: admin, json: { mobile: '9000000099' } })).status, 200);
});

test('web login + dashboard pages render', async () => {
  const res = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=admin@test.com&password=AdminPass123' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/admin');
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const page = await fetch(base + '/admin', { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Onboard restaurant/);
  assert.equal((await fetch(base + '/admin', { redirect: 'manual' })).status, 302);
});

test('owner dashboard, admin list and public menu pages render', async () => {
  const admin = await login('admin@test.com', 'AdminPass123');
  await call('POST', '/api/v1/admin/restaurants', { token: admin, json: { name: 'Page Test', mobile: '9000000003', email: 'pt@x.com', password: 'secret12' } });
  const owner = await login('pt@x.com', 'secret12');
  const cat = (await call('POST', '/api/v1/categories', { token: owner, json: { name: 'Mains' } })).body;
  await call('POST', '/api/v1/items', { token: owner, json: { name: 'Dal', price: 80, category_id: cat.id } });

  const loginRes = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'identifier=9000000003&password=secret12' });
  assert.equal(loginRes.headers.get('location'), '/dashboard');
  const cookie = loginRes.headers.get('set-cookie').split(';')[0];
  const dash = await (await fetch(base + '/dashboard', { headers: { cookie } })).text();
  assert.match(dash, /Dal/);
  assert.match(dash, /Change password/);
  assert.equal((await fetch(base + '/dashboard/qr.png', { headers: { cookie } })).headers.get('content-type'), 'image/png');
  assert.equal((await fetch(base + '/admin', { headers: { cookie }, redirect: 'manual' })).status, 302); // owner can't open admin

  const adminLogin = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=admin@test.com&password=AdminPass123' });
  const list = await (await fetch(base + '/admin', { headers: { cookie: adminLogin.headers.get('set-cookie').split(';')[0] } })).text();
  assert.match(list, /Page Test/);

  const menu = await (await fetch(base + '/m/page-test')).text();
  assert.match(menu, /Dal/);
  assert.match(menu, /name="viewport"/);
});

test('one-time login details after create and reset; hash never exposed', async () => {
  const adminLogin = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'identifier=admin@test.com&password=AdminPass123' });
  const cookie = adminLogin.headers.get('set-cookie').split(';')[0];
  const form = body => ({ method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body });
  const page = async () => (await fetch(base + '/admin', { headers: { cookie } })).text();

  const created = await fetch(base + '/admin/restaurants', form('name=Creds+Cafe&mobile=9000000077&email=&password=Sh0wMe0nce&price_paid=1&plan_type=one_time&plan_expires='));
  assert.equal(created.status, 302);
  const first = await page();
  assert.match(first, /Sh0wMe0nce/);          // shown once...
  assert.match(first, /9000000077/);
  assert.ok(!(await page()).includes('Sh0wMe0nce')); // ...then gone

  const id = (await call('POST', '/api/v1/auth/login', { json: { identifier: '9000000077', password: 'Sh0wMe0nce' } })).body.user.restaurant_id;
  const reset = await fetch(base + `/admin/restaurants/${id}/reset-password`, form(''));
  assert.equal(reset.status, 302);
  const shown = /id="c-pass" class="mono">([^<]+)</.exec(await page());
  assert.ok(shown && shown[1].length >= 10);
  assert.equal((await call('POST', '/api/v1/auth/login', { json: { identifier: '9000000077', password: 'Sh0wMe0nce' } })).status, 401); // old password dead
  assert.ok(await login('9000000077', shown[1]));                                                                                       // new one works

  // API responses never include the hash
  const admin = await login('admin@test.com', 'AdminPass123');
  assert.ok(!JSON.stringify((await call('GET', '/api/v1/admin/restaurants', { token: admin })).body).includes('password_hash'));
});

test('super admin can view the password it set (stored encrypted); owner changes clear it', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const adminLogin = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'identifier=admin@test.com&password=AdminPass123' });
  const cookie = adminLogin.headers.get('set-cookie').split(';')[0];
  const admin = await login('admin@test.com', 'AdminPass123');
  const reveal = (id, c = cookie) => fetch(base + `/admin/restaurants/${id}/reveal-password`, { method: 'POST', redirect: 'manual', headers: { cookie: c } });

  const r = await call('POST', '/api/v1/admin/restaurants', { token: admin, json: { name: 'Vault Cafe', mobile: '9000000055', password: 'Vault#Pass1' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const ok = await reveal(r.body.id);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.equal((await ok.json()).password, 'Vault#Pass1');

  // stored encrypted, never as plain text
  const raw = new DatabaseSync(path.join(process.env.DATA_DIR, 'app.db'), { readOnly: true });
  const row = raw.prepare("SELECT password_hash, password_enc FROM users WHERE mobile='9000000055'").get();
  raw.close();
  assert.ok(row.password_enc && !row.password_enc.includes('Vault#Pass1'));
  assert.ok(row.password_hash.startsWith('$2'));

  // admin-only: not available to anonymous users or restaurant owners
  assert.equal((await fetch(base + `/admin/restaurants/${r.body.id}/reveal-password`, { method: 'POST', redirect: 'manual' })).status, 302);
  const ownerLogin = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'identifier=9000000055&password=Vault%23Pass1' });
  assert.equal((await reveal(r.body.id, ownerLogin.headers.get('set-cookie').split(';')[0])).status, 302);

  // admin edit with a new password updates what is shown
  await call('PATCH', `/api/v1/admin/restaurants/${r.body.id}`, { token: admin, json: { password: 'Second#Pass2' } });
  assert.equal((await (await reveal(r.body.id)).json()).password, 'Second#Pass2');

  // once the owner picks their own password the admin copy is cleared (it would be stale)
  const owner = await login('9000000055', 'Second#Pass2');
  assert.equal((await call('POST', '/api/v1/auth/password', { token: owner, json: { current_password: 'Second#Pass2', new_password: 'OwnerChose3' } })).status, 204);
  assert.equal((await (await reveal(r.body.id)).json()).password, null);
  assert.ok(!(await (await fetch(base + '/admin', { headers: { cookie } })).text()).includes('OwnerChose3'));

  // the page never embeds passwords; the eye only shows for restaurants with a stored copy
  const r2 = await call('POST', '/api/v1/admin/restaurants', { token: admin, json: { name: 'Eye Cafe', mobile: '9000000056', password: 'Eye#Pass44' } });
  const html = await (await fetch(base + '/admin', { headers: { cookie } })).text();
  assert.ok(!html.includes('Eye#Pass44'));
  assert.match(html, new RegExp(`id="pw-${r2.body.id}"`));
  assert.doesNotMatch(html, new RegExp(`id="pw-${r.body.id}"`));
});
