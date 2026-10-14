// JSON API used by the dashboards (login cookie) and by external clients (bearer token).
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
const auth = role => (req, res, next) => {
  let u = null, viaCookie = false;
  const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
  if (m) {
    const p = verify(m[1], SESSION_SECRET);
    u = p && svc.userIsActive(p.uid);
  } else if (req.session?.user) {
    u = svc.userIsActive(req.session.user.id);
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

// ---- public ----
router.get('/public/menu/:slug', (req, res) => {
  const m = svc.getMenu(req.params.slug);
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
router.post('/auth/login', loginLimiter, (req, res) => {
  const u = svc.authenticate(req.body.identifier ?? req.body.email, req.body.password);
  res.json({ token: sign({ uid: u.id }, SESSION_SECRET), expires_in: 12 * 3600, user: svc.publicUser(u) });
});
// Cookie login for the dashboards.
router.post('/auth/session', loginLimiter, (req, res, next) => {
  const u = svc.authenticate(req.body.identifier ?? req.body.email, req.body.password);
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
router.post('/auth/password', auth(), (req, res) => {
  svc.changePassword(req.user.id, req.body.current_password, req.body.new_password);
  res.status(204).end();
});

// ---- super admin ----
const admin = express.Router();
admin.use(auth('admin'));
admin.get('/summary', (req, res) => res.json(svc.summary()));
admin.get('/restaurants', (req, res) => res.json({ restaurants: svc.listRestaurants().map(svc.restaurantOut) }));
admin.post('/restaurants', (req, res) => res.status(201).json(svc.restaurantOut(svc.createRestaurant(req.body))));
admin.get('/restaurants/:id', (req, res) => res.json(svc.restaurantOut(svc.getRestaurant(id(req)))));
admin.patch('/restaurants/:id', (req, res) => res.json(svc.restaurantOut(svc.updateRestaurant(id(req), req.body))));
admin.post('/restaurants/:id/password', (req, res) => { svc.resetOwnerPassword(id(req), req.body.password); res.status(204).end(); });
// Generate a fresh password for the owner and return it (the only time it is returned unprompted).
admin.post('/restaurants/:id/reset-password', (req, res) => {
  const r = svc.getRestaurant(id(req));
  const password = svc.generatePassword();
  svc.resetOwnerPassword(r.id, password);
  res.json({ mobile: r.mobile, email: r.email, password });
});
// The password the admin set for this owner (stored encrypted); null if the owner changed it themselves.
admin.post('/restaurants/:id/reveal-password', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ password: svc.revealOwnerPassword(id(req)) });
});
admin.delete('/restaurants/:id', (req, res) => { svc.deleteRestaurant(id(req)); res.status(204).end(); });
router.use('/admin', admin);

// ---- restaurant owner ----
const owner = express.Router();
owner.use(auth('owner'));
owner.get('/restaurant', (req, res) => res.json(svc.restaurantOut(svc.getRestaurant(rid(req)))));
owner.patch('/restaurant', (req, res) => res.json(svc.restaurantOut(svc.updateProfile(rid(req), req.body))));

owner.get('/categories', (req, res) => res.json({ categories: svc.listCategories(rid(req)) }));
owner.post('/categories', (req, res) => res.status(201).json(svc.createCategory(rid(req), req.body.name)));
owner.put('/categories/:id', (req, res) => res.json(svc.renameCategory(rid(req), id(req), req.body.name)));
owner.delete('/categories/:id', (req, res) => { svc.deleteCategory(rid(req), id(req)); res.status(204).end(); });

// Items accept JSON (photo as a data URL) or multipart/form-data (field "image").
owner.get('/items', (req, res) => res.json({ items: svc.listItems(rid(req), Number(req.query.category_id) || null).map(svc.itemOut) }));
owner.post('/items', upload.single('image'), (req, res) =>
  res.status(201).json(svc.itemOut(svc.saveItem(rid(req), req.body, photo(req)))));
owner.get('/items/:id', (req, res) => res.json(svc.itemOut(svc.getItem(rid(req), id(req)))));
owner.put('/items/:id', upload.single('image'), (req, res) =>
  res.json(svc.itemOut(svc.saveItem(rid(req), { ...req.body, id: id(req) }, photo(req)))));
owner.patch('/items/:id/availability', (req, res) => {
  const a = req.body.available;
  res.json(svc.itemOut(svc.setItemAvailable(rid(req), id(req), a === undefined ? undefined : (a === true || a === 'true' || a === 1 || a === '1'))));
});
owner.delete('/items/:id', (req, res) => { svc.deleteItem(rid(req), id(req)); res.status(204).end(); });

owner.get('/qr.png', async (req, res) => {
  const r = svc.getRestaurant(rid(req));
  res.type('png').set('Content-Disposition', req.query.download ? `attachment; filename="${r.slug}-menu-qr.png"` : 'inline');
  res.send(await QRCode.toBuffer(`${BASE_URL}/m/${r.slug}`, { width: Math.min(Math.max(Number(req.query.size) || 800, 128), 2048), margin: 2, errorCorrectionLevel: 'M' }));
});
router.use('/', owner);

router.use((req, res) => res.status(404).json({ error: 'Not found' }));

module.exports = router;
