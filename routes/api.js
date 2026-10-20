// JSON API used by the dashboards (login cookie) and by external clients (bearer token).
// Handlers are async (MongoDB); Express 5 sends any thrown error to the error handler in app.js.
const express = require('express');
const rateLimit = require('express-rate-limit');
const QRCode = require('qrcode');
const { BASE_URL, SESSION_SECRET } = require('../lib/config');
const { upload } = require('../lib/uploads');
const { sign, verify } = require('../lib/token');
const svc = require('../lib/service');
const { HttpError } = svc;

const router = express.Router();
router.use(express.json({ limit: '3mb' })); // photos arrive as base64 data URLs (resized in the browser first)

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: Number(process.env.LOGIN_RATE_LIMIT) || 20, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in 15 minutes.' },
});

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const sameOrigin = req => {
  const o = req.get('origin');
  if (!o) return true;
  try { return new URL(o).host === req.get('host'); } catch { return false; }
};

// Accepts either "Authorization: Bearer <token>" (API clients) or the login cookie (the dashboards).
// role: 'admin' | 'owner'
const auth = role => async (req, res, next) => {
  let u = null, viaCookie = false;
  const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
  if (m) {
    const p = verify(m[1], SESSION_SECRET);
    u = p && await svc.userIsActive(p.uid);
  } else if (req.session?.user) {
    u = await svc.userIsActive(req.session.user.id);
    viaCookie = !!u;
  }
  if (!u) throw new HttpError(401, 'Missing, invalid or expired login');
  // cookie-authenticated writes must come from this site (defence in depth on top of SameSite=Lax)
  if (viaCookie && !SAFE.has(req.method) && !sameOrigin(req)) throw new HttpError(403, 'Cross-site request blocked');
  if (role && u.role !== role) throw new HttpError(403, 'Forbidden');
  req.user = u;
  next();
};
const rid = req => req.user.restaurant_id;
const id = req => Number(req.params.id);
// A photo is either a multipart upload (field "image") or a base64 data URL in the JSON body.
const photo = req => req.file?.filename || (typeof req.body.image === 'string' && req.body.image.startsWith('data:') ? svc.saveImageData(req.body.image) : null);

// ---- docs ----
router.get('/openapi.json', (req, res) => res.json(require('../lib/openapi')));

// ---- public ----
router.get('/public/menu/:slug', async (req, res) => {
  const m = await svc.getMenu(req.params.slug);
  if (!m) throw new HttpError(404, 'Menu not available');
  const r = m.restaurant;
  res.set('Cache-Control', 'public, max-age=30');
  res.json({
    restaurant: {
      name: r.name, slug: r.slug, tagline: r.tagline, theme_color: r.theme_color, city: r.city, address: r.address,
      phone: r.contact_phone, logo: r.logo ? `/uploads/${r.logo}` : null,
    },
    categories: m.sections.map(s => ({ id: s.id, name: s.name, items: s.items.map(svc.itemOut) })),
  });
});

// ---- auth ----
// Token login for API clients. `identifier` = email or mobile number (`email` accepted as an alias).
router.post('/auth/login', loginLimiter, async (req, res) => {
  const u = await svc.authenticate(req.body.identifier ?? req.body.email, req.body.password);
  res.json({ token: sign({ uid: u.id }, SESSION_SECRET), expires_in: 12 * 3600, user: svc.publicUser(u) });
});
// Cookie login for the dashboards.
router.post('/auth/session', loginLimiter, async (req, res, next) => {
  const u = await svc.authenticate(req.body.identifier ?? req.body.email, req.body.password);
  req.session.regenerate(err => {
    if (err) return next(err);
    req.session.user = { id: u.id };
    res.json({ role: u.role, user: svc.publicUser(u) });
  });
});
router.delete('/auth/session', (req, res) => {
  const done = () => { res.clearCookie('sid'); res.status(204).end(); };
  req.session ? req.session.destroy(done) : done();
});
router.get('/auth/me', auth(), (req, res) => res.json({ user: svc.publicUser(req.user) }));
router.post('/auth/password', auth(), async (req, res) => {
  await svc.changePassword(req.user.id, req.body.current_password, req.body.new_password);
  res.status(204).end();
});

// Categories and items: the same operations for an owner (their own restaurant) and for the admin (any restaurant,
// under /admin/restaurants/:id). `restaurantOf(req)` says which restaurant the request is about.
function menuRoutes(r, restaurantOf) {
  const ref = req => Number(req.params.ref);
  r.get('/categories', async (req, res) => res.json({ categories: await svc.listCategories(restaurantOf(req)) }));
  r.post('/categories', async (req, res) => res.status(201).json(await svc.createCategory(restaurantOf(req), req.body.name)));
  r.put('/categories/:ref', async (req, res) => res.json(await svc.renameCategory(restaurantOf(req), ref(req), req.body.name)));
  r.delete('/categories/:ref', async (req, res) => { await svc.deleteCategory(restaurantOf(req), ref(req)); res.status(204).end(); });

  // Items accept JSON (photo as a data URL) or multipart/form-data (field "image").
  r.get('/items', async (req, res) => res.json({ items: (await svc.listItems(restaurantOf(req), Number(req.query.category_id) || null)).map(svc.itemOut) }));
  r.post('/items', upload.single('image'), async (req, res) =>
    res.status(201).json(svc.itemOut(await svc.saveItem(restaurantOf(req), req.body, photo(req)))));
  r.get('/items/:ref', async (req, res) => res.json(svc.itemOut(await svc.getItem(restaurantOf(req), ref(req)))));
  r.put('/items/:ref', upload.single('image'), async (req, res) =>
    res.json(svc.itemOut(await svc.saveItem(restaurantOf(req), { ...req.body, id: ref(req) }, photo(req)))));
  r.patch('/items/:ref/availability', async (req, res) => {
    const a = req.body.available;
    res.json(svc.itemOut(await svc.setItemAvailable(restaurantOf(req), ref(req), a === undefined ? undefined : (a === true || a === 'true' || a === 1 || a === '1'))));
  });
  r.delete('/items/:ref', async (req, res) => { await svc.deleteItem(restaurantOf(req), ref(req)); res.status(204).end(); });

  // "Add menu": browse what other restaurants publish and copy dishes / categories into this one
  r.get('/library/categories', async (req, res) => res.json({ categories: await svc.libraryCategories(restaurantOf(req)) }));
  r.get('/library/items', async (req, res) => res.json(await svc.libraryItems(restaurantOf(req), req.query)));
  r.post('/library/import', async (req, res) => res.json(await svc.importFromLibrary(restaurantOf(req), req.body)));
}

// ---- super admin ----
const admin = express.Router();
admin.use(auth('admin'));
admin.get('/summary', async (req, res) => res.json(await svc.summary()));
admin.get('/restaurants', async (req, res) => res.json({ restaurants: (await svc.listRestaurants()).map(svc.restaurantOut) }));
admin.post('/restaurants', async (req, res) => res.status(201).json(svc.restaurantOut(await svc.createRestaurant(req.body))));
admin.get('/restaurants/:id', async (req, res) => res.json(svc.restaurantOut(await svc.getRestaurant(id(req)))));
admin.patch('/restaurants/:id', async (req, res) => res.json(svc.restaurantOut(await svc.updateRestaurant(id(req), req.body))));
admin.post('/restaurants/:id/password', async (req, res) => { await svc.resetOwnerPassword(id(req), req.body.password); res.status(204).end(); });
// Generate a fresh password for the owner and return it (the only time it is returned unprompted).
admin.post('/restaurants/:id/reset-password', async (req, res) => {
  const r = await svc.getRestaurant(id(req));
  const password = svc.generatePassword();
  await svc.resetOwnerPassword(r.id, password);
  res.json({ mobile: r.mobile, email: r.email, password });
});
// The password the admin set for this owner (stored encrypted); null if the owner changed it themselves.
admin.post('/restaurants/:id/reveal-password', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ password: await svc.revealOwnerPassword(id(req)) });
});
admin.delete('/restaurants/:id', async (req, res) => { await svc.deleteRestaurant(id(req)); res.status(204).end(); });
// Manage a restaurant's menu on its behalf (what the "Manage menu" button in the admin console uses).
const adminMenu = express.Router({ mergeParams: true });
adminMenu.use(async (req, res, next) => { await svc.getRestaurant(Number(req.params.id)); next(); }); // 404 for an unknown restaurant
menuRoutes(adminMenu, req => Number(req.params.id));
admin.use('/restaurants/:id', adminMenu);
router.use('/admin', admin);

// ---- restaurant owner ----
const owner = express.Router();
owner.use(auth('owner'));
owner.get('/restaurant', async (req, res) => res.json(svc.restaurantOut(await svc.getRestaurant(rid(req)))));
owner.patch('/restaurant', async (req, res) => res.json(svc.restaurantOut(await svc.updateProfile(rid(req), req.body))));

menuRoutes(owner, rid);

owner.get('/qr.png', async (req, res) => {
  const r = await svc.getRestaurant(rid(req));
  res.type('png').set('Content-Disposition', req.query.download ? `attachment; filename="${r.slug}-menu-qr.png"` : 'inline');
  // level H survives ~30% damage: use it when a logo will cover the middle of the code
  const level = ['L', 'M', 'Q', 'H'].includes(String(req.query.level).toUpperCase()) ? String(req.query.level).toUpperCase() : 'M';
  res.send(await QRCode.toBuffer(`${BASE_URL}/m/${r.slug}`, { width: Math.min(Math.max(Number(req.query.size) || 800, 128), 2048), margin: 2, errorCorrectionLevel: level }));
});
router.use('/', owner);

router.use((req, res) => res.status(404).json({ error: 'Not found' }));

module.exports = router;
