const express = require('express');
const rateLimit = require('express-rate-limit');
const QRCode = require('qrcode');
const { BASE_URL, SESSION_SECRET } = require('../lib/config');
const { upload } = require('../lib/uploads');
const { sign, verify } = require('../lib/token');
const svc = require('../lib/service');
const { HttpError } = svc;

const router = express.Router();
router.use(express.json({ limit: '100kb' }));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in 15 minutes.' },
});

// role: 'admin' | 'owner'
const auth = role => (req, res, next) => {
  const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
  const p = m && verify(m[1], SESSION_SECRET);
  const u = p && svc.userIsActive(p.uid);
  if (!u) throw new HttpError(401, 'Missing, invalid or expired token');
  if (role && u.role !== role) throw new HttpError(403, 'Forbidden');
  req.user = u;
  next();
};
const rid = req => req.user.restaurant_id;
const id = req => Number(req.params.id);

// ---- public ----
router.get('/public/menu/:slug', (req, res) => {
  const m = svc.getMenu(req.params.slug);
  if (!m) throw new HttpError(404, 'Menu not available');
  res.set('Cache-Control', 'public, max-age=30');
  res.json({
    restaurant: { name: m.restaurant.name, slug: m.restaurant.slug },
    categories: m.sections.map(s => ({ id: s.id, name: s.name, items: s.items.map(svc.itemOut) })),
  });
});

// ---- auth ----
router.post('/auth/login', loginLimiter, (req, res) => {
  const u = svc.authenticate(req.body.email, req.body.password);
  res.json({ token: sign({ uid: u.id }, SESSION_SECRET), expires_in: 12 * 3600, user: svc.publicUser(u) });
});
router.get('/auth/me', auth(), (req, res) => res.json({ user: svc.publicUser(req.user) }));
router.post('/auth/password', auth(), (req, res) => {
  svc.changePassword(req.user.id, req.body.current_password, req.body.new_password);
  res.status(204).end();
});

// ---- super admin: onboarding ----
const admin = express.Router();
admin.use(auth('admin'));
admin.get('/restaurants', (req, res) => res.json({ restaurants: svc.listRestaurants().map(svc.restaurantOut) }));
admin.post('/restaurants', (req, res) => res.status(201).json(svc.restaurantOut(svc.createRestaurant(req.body))));
admin.get('/restaurants/:id', (req, res) => res.json(svc.restaurantOut(svc.getRestaurant(id(req)))));
admin.patch('/restaurants/:id', (req, res) => res.json(svc.restaurantOut(svc.updateRestaurant(id(req), req.body))));
admin.post('/restaurants/:id/password', (req, res) => { svc.resetOwnerPassword(id(req), req.body.password); res.status(204).end(); });
admin.delete('/restaurants/:id', (req, res) => { svc.deleteRestaurant(id(req)); res.status(204).end(); });
router.use('/admin', admin);

// ---- restaurant owner: menu management ----
const owner = express.Router();
owner.use(auth('owner'));
owner.get('/restaurant', (req, res) => res.json(svc.restaurantOut(svc.getRestaurant(rid(req)))));

owner.get('/categories', (req, res) => res.json({ categories: svc.listCategories(rid(req)) }));
owner.post('/categories', (req, res) => res.status(201).json(svc.createCategory(rid(req), req.body.name)));
owner.put('/categories/:id', (req, res) => res.json(svc.renameCategory(rid(req), id(req), req.body.name)));
owner.delete('/categories/:id', (req, res) => { svc.deleteCategory(rid(req), id(req)); res.status(204).end(); });

// Items accept JSON or multipart/form-data (field "image" for the photo).
owner.get('/items', (req, res) => res.json({ items: svc.listItems(rid(req), Number(req.query.category_id) || null).map(svc.itemOut) }));
owner.post('/items', upload.single('image'), (req, res) =>
  res.status(201).json(svc.itemOut(svc.saveItem(rid(req), req.body, req.file?.filename || null))));
owner.get('/items/:id', (req, res) => res.json(svc.itemOut(svc.getItem(rid(req), id(req)))));
owner.put('/items/:id', upload.single('image'), (req, res) =>
  res.json(svc.itemOut(svc.saveItem(rid(req), { ...req.body, id: id(req) }, req.file?.filename || null))));
owner.patch('/items/:id/availability', (req, res) => {
  const a = req.body.available;
  res.json(svc.itemOut(svc.setItemAvailable(rid(req), id(req), a === undefined ? undefined : (a === true || a === 'true' || a === 1 || a === '1'))));
});
owner.delete('/items/:id', (req, res) => { svc.deleteItem(rid(req), id(req)); res.status(204).end(); });

owner.get('/qr.png', async (req, res) => {
  const r = svc.getRestaurant(rid(req));
  res.type('png').set('Content-Disposition', req.query.download ? 'attachment; filename="menu-qr.png"' : 'inline');
  res.send(await QRCode.toBuffer(`${BASE_URL}/m/${r.slug}`, { width: Math.min(Number(req.query.size) || 800, 2000), margin: 2 }));
});
router.use('/', owner);

router.use((req, res) => res.status(404).json({ error: 'Not found' }));

module.exports = router;
