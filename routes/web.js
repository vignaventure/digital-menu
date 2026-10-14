const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const QRCode = require('qrcode');
const { db } = require('../lib/db');
const { BASE_URL } = require('../lib/config');
const { upload } = require('../lib/uploads');
const svc = require('../lib/service');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => res.status(429).render('login', { error: 'Too many attempts. Try again in 15 minutes.' }),
});
const msg = e => encodeURIComponent(e instanceof svc.HttpError ? e.message : 'Something went wrong');

const need = role => (req, res, next) => {
  const s = req.session.user;
  if (!s) return res.redirect('/login');
  const u = svc.userIsActive(s.id); // re-check on every request so disabling an account takes effect immediately
  if (!u) return req.session.destroy(() => res.redirect('/login'));
  if (u.role !== role) return res.redirect(u.role === 'admin' ? '/admin' : '/dashboard');
  req.user = u;
  next();
};

// ---------- Auth ----------
router.get('/', (req, res) => res.render('landing', { contact: process.env.CONTACT_EMAIL || '' }));
router.get('/login', (req, res) => res.render('login', { error: null }));
router.post('/login', loginLimiter, (req, res, next) => {
  let u;
  try { u = svc.authenticate(req.body.identifier ?? req.body.email, req.body.password); }
  catch (e) { return e instanceof svc.HttpError ? res.status(e.status).render('login', { error: e.message }) : next(e); }
  req.session.regenerate(err => {
    if (err) return next(err);
    req.session.user = { id: u.id };
    res.redirect(u.role === 'admin' ? '/admin' : '/dashboard');
  });
});
router.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

// ---------- Super admin ----------
// `form` re-fills the form after a validation error; `editId` switches the form to edit mode.
function adminPage(req, res, { status = 200, error, ok, editId = req.query.edit, form } = {}) {
  let edit = null;
  if (editId) try { edit = svc.getRestaurant(Number(editId)); } catch {}
  // one-time login details (set after create / password change); shown once, then discarded
  const credentials = req.session.credentials || null;
  delete req.session.credentials;
  res.status(status).render('admin', {
    rows: svc.listRestaurants(), edit, form: form || null, credentials,
    error: error ?? req.query.error, ok: ok ?? req.query.ok, base: BASE_URL,
  });
}
function fail(req, res, e, extra) {
  if (!(e instanceof svc.HttpError)) throw e;
  adminPage(req, res, { status: e.status, error: e.message, ...extra });
}

router.get('/admin', need('admin'), (req, res) => adminPage(req, res));
router.post('/admin/restaurants', need('admin'), (req, res) => {
  try {
    const r = svc.createRestaurant(req.body);
    req.session.credentials = { title: 'Restaurant created', name: r.name, mobile: r.mobile, email: r.email, password: req.body.password };
    res.redirect('/admin');
  } catch (e) { fail(req, res, e, { form: req.body }); }
});
router.post('/admin/restaurants/:id', need('admin'), (req, res) => {
  try {
    const b = { ...req.body };
    if (!b.password) delete b.password; // blank = keep current password
    const r = svc.updateRestaurant(Number(req.params.id), b);
    if (b.password) req.session.credentials = { title: 'Password changed', name: r.name, mobile: r.mobile, email: r.email, password: b.password };
    res.redirect('/admin?ok=Changes+saved');
  } catch (e) { fail(req, res, e, { editId: req.params.id, form: req.body }); }
});
router.post('/admin/restaurants/:id/toggle', need('admin'), (req, res) => {
  svc.toggleRestaurant(req.params.id); res.redirect('/admin');
});
router.post('/admin/restaurants/:id/reset-password', need('admin'), (req, res) => {
  try {
    const r = svc.getRestaurant(Number(req.params.id));
    const password = svc.generatePassword();
    svc.resetOwnerPassword(r.id, password);
    req.session.credentials = { title: 'New password generated', name: r.name, mobile: r.mobile, email: r.email, password };
    res.redirect('/admin');
  } catch (e) { res.redirect('/admin?error=' + msg(e)); }
});
router.post('/admin/restaurants/:id/delete', need('admin'), (req, res) => {
  try { svc.deleteRestaurant(req.params.id); res.redirect('/admin?ok=Restaurant+deleted'); }
  catch (e) { res.redirect('/admin?error=' + msg(e)); }
});

// ---------- Restaurant dashboard ----------
const rid = req => req.user.restaurant_id;

router.get('/dashboard', need('owner'), (req, res) => {
  const r = db.prepare('SELECT * FROM restaurants WHERE id=?').get(rid(req));
  const items = svc.listItems(rid(req));
  res.render('dashboard', {
    r, categories: svc.listCategories(rid(req)), items,
    edit: req.query.edit ? items.find(i => i.id == req.query.edit) : null,
    error: req.query.error, ok: req.query.ok, base: BASE_URL,
  });
});
router.post('/dashboard/categories', need('owner'), (req, res) => {
  try { svc.createCategory(rid(req), req.body.name); res.redirect('/dashboard'); }
  catch (e) { res.redirect('/dashboard?error=' + msg(e)); }
});
router.post('/dashboard/categories/:id/delete', need('owner'), (req, res) => {
  try { svc.deleteCategory(rid(req), req.params.id); } catch {}
  res.redirect('/dashboard');
});
router.post('/dashboard/items', need('owner'), upload.single('image'), (req, res) => {
  try { svc.saveItem(rid(req), req.body, req.file?.filename || null); res.redirect('/dashboard#items'); }
  catch (e) { res.redirect('/dashboard?error=' + msg(e)); }
});
router.post('/dashboard/items/:id/toggle', need('owner'), (req, res) => {
  try { svc.setItemAvailable(rid(req), req.params.id); } catch {}
  res.redirect('/dashboard#items');
});
router.post('/dashboard/items/:id/delete', need('owner'), (req, res) => {
  try { svc.deleteItem(rid(req), req.params.id); } catch {}
  res.redirect('/dashboard#items');
});
router.post('/dashboard/password', need('owner'), (req, res) => {
  try { svc.changePassword(req.user.id, req.body.current_password, req.body.new_password); res.redirect('/dashboard?ok=Password+changed'); }
  catch (e) { res.redirect('/dashboard?error=' + msg(e)); }
});
router.get('/dashboard/qr.png', need('owner'), async (req, res, next) => {
  try {
    const r = db.prepare('SELECT slug FROM restaurants WHERE id=?').get(rid(req));
    res.type('png').set('Content-Disposition', req.query.download ? 'attachment; filename="menu-qr.png"' : 'inline');
    res.send(await QRCode.toBuffer(`${BASE_URL}/m/${r.slug}`, { width: 800, margin: 2 }));
  } catch (e) { next(e); }
});

// ---------- Public menu (what customers see after scanning) ----------
router.get('/m/:slug', (req, res) => {
  const m = svc.getMenu(req.params.slug);
  if (!m) return res.status(404).render('unavailable');
  res.render('menu', { r: m.restaurant, sections: m.sections });
});

module.exports = router;
