// The API description must stay true to the real routes: every documented operation has to exist.
const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'menucard-oas-'));
process.env.ADMIN_EMAIL = 'admin@test.com';
process.env.ADMIN_PASSWORD = 'AdminPass123';
process.env.BASE_URL = 'http://test.local';
process.env.LOGIN_RATE_LIMIT = '10000';

const test = require('node:test');
const assert = require('node:assert/strict');
const spec = require('../lib/openapi');
const { startMongo } = require('./helpers');

let base, server, mongo, db;
test.before(async () => {
  mongo = await startMongo();
  db = require('../lib/db');
  const app = require('../app');
  await db.init();
  await new Promise(r => { server = app.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); }); });
});
test.after(async () => { server.close(); await db.close(); await mongo.stop(); fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

const call = async (method, url, { token, json } = {}) => {
  const res = await fetch(base + url, { method, headers: { ...(token && { authorization: `Bearer ${token}` }), ...(json && { 'content-type': 'application/json' }) }, body: json ? JSON.stringify(json) : undefined });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, type, body: type.includes('json') ? await res.json() : null };
};

test('the docs page, viewer files and spec are served', async () => {
  const page = await fetch(base + '/api/docs');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /openapi\.json/);
  assert.equal((await fetch(base + '/api/docs/assets/swagger-ui-bundle.js')).status, 200);
  assert.equal((await fetch(base + '/api/docs/assets/swagger-ui.css')).status, 200);
  const s = await call('GET', '/api/v1/openapi.json');
  assert.equal(s.status, 200);
  assert.equal(s.body.openapi, '3.0.3');
  assert.ok(Object.keys(s.body.paths).length >= 15);
});

test('the spec is well formed: every $ref resolves and every operation documents responses', () => {
  const text = JSON.stringify(spec);
  for (const [, name] of text.matchAll(/#\/components\/schemas\/(\w+)/g)) assert.ok(spec.components.schemas[name], `missing schema ${name}`);
  for (const [p, ops] of Object.entries(spec.paths)) {
    for (const [method, o] of Object.entries(ops)) {
      assert.ok(o.summary && o.tags?.length, `${method} ${p} needs a summary and tag`);
      assert.ok(Object.keys(o.responses).length, `${method} ${p} needs responses`);
      for (const [, name] of p.matchAll(/\{(\w+)\}/g)) assert.ok(o.parameters?.some(x => x.name === name && x.in === 'path'), `${method} ${p} documents {${name}}`);
    }
  }
});

test('every documented operation is a real route', async () => {
  const admin = (await call('POST', '/api/v1/auth/login', { json: { identifier: 'admin@test.com', password: 'AdminPass123' } })).body.token;
  await call('POST', '/api/v1/admin/restaurants', { token: admin, json: { name: 'Docs Cafe', mobile: '9000000042', password: 'secret12' } });
  const owner = (await call('POST', '/api/v1/auth/login', { json: { identifier: '9000000042', password: 'secret12' } })).body.token;

  let checked = 0;
  for (const [p, ops] of Object.entries(spec.paths)) {
    for (const [method, o] of Object.entries(ops)) {
      const url = '/api/v1' + p.replace('{slug}', 'no-such-menu').replace(/\{\w+\}/g, '999999');
      const token = o.tags[0] === 'Admin' ? admin : o.tags[0] === 'Restaurant' ? owner : undefined;
      const r = await call(method.toUpperCase(), url, { token, json: ['post', 'put', 'patch'].includes(method) ? {} : undefined });
      // an unknown route answers {"error":"Not found"}; real routes answer with their own status/message
      assert.ok(!(r.status === 404 && r.body?.error === 'Not found'), `${method.toUpperCase()} ${p} is documented but not implemented`);
      assert.notEqual(r.status, 500, `${method.toUpperCase()} ${p} crashed`);
      checked++;
    }
  }
  assert.ok(checked >= 44, `only ${checked} operations checked`);
});
