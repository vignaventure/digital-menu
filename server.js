const express = require('express');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const crypto = require('crypto');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ---------- DB ----------
const db = new DatabaseSync(path.join(__dirname, 'data', 'app.db'));
db.exec(`
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS restaurants (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
  price_paid REAL DEFAULT 0, plan_expires TEXT, active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','owner')),
  restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY, restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name TEXT NOT NULL, sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY, restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  name TEXT NOT NULL, description TEXT, price REAL NOT NULL, image TEXT,
  available INTEGER DEFAULT 1);
`);

// Seed super admin on first run (change via env, then change password after login)
if (!db.prepare("SELECT 1 FROM users WHERE role='admin'").get()) {
  const email = process.env.ADMIN_EMAIL || 'admin@menucard.local';
  const pass = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString('hex');
  db.prepare("INSERT INTO users (email,password_hash,role) VALUES (?,?,'admin')")
    .run(email, bcrypt.hashSync(pass, 10));
  console.log(`\n>>> Super admin created: ${email} / ${pass}\n`);
}

// ---------- App ----------
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 12 },
}));

const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, 'uploads'),
    filename: (_, f, cb) => cb(null, crypto.randomUUID() + path.extname(f.originalname).toLowerCase()),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, f, cb) => cb(null, /^image\/(jpeg|png|webp|gif)$/.test(f.mimetype)),
});

const slugify = s => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const need = role => (req, res, next) => {
  const u = req.session.user;
  if (!u) return res.redirect('/login');
  if (u.role !== role) return res.redirect(u.role === 'admin' ? '/admin' : '/dashboard');
  next();
};

// ---------- Auth ----------
app.get('/', (req, res) => res.redirect('/login'));
app.get('/login', (req, res) => res.render('login', { error: null }));
app.post('/login', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE email=?').get((req.body.email || '').trim().toLowerCase());
  if (!u || !bcrypt.compareSync(req.body.password || '', u.password_hash))
    return res.status(401).render('login', { error: 'Invalid email or password' });
  if (u.role === 'owner') {
    const r = db.prepare('SELECT * FROM restaurants WHERE id=?').get(u.restaurant_id);
    if (!r.active) return res.status(403).render('login', { error: 'Account disabled. Contact support.' });
  }
  req.session.user = { id: u.id, role: u.role, restaurant_id: u.restaurant_id };
  res.redirect(u.role === 'admin' ? '/admin' : '/dashboard');
});
app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

// ---------- Super admin: onboarding ----------
app.get('/admin', need('admin'), (req, res) => {
  const rows = db.prepare(`SELECT r.*, u.email,
    (SELECT COUNT(*) FROM items i WHERE i.restaurant_id=r.id) AS item_count
    FROM restaurants r LEFT JOIN users u ON u.restaurant_id=r.id ORDER BY r.id DESC`).all();
  res.render('admin', { rows, error: req.query.error, base: BASE_URL });
});
app.post('/admin/restaurants', need('admin'), (req, res) => {
  const { name, email, password, price_paid, plan_expires } = req.body;
  if (!name || !email || !password || password.length < 6)
    return res.redirect('/admin?error=' + encodeURIComponent('Name, email and password (min 6 chars) required'));
  let slug = slugify(name) || 'restaurant';
  while (db.prepare('SELECT 1 FROM restaurants WHERE slug=?').get(slug)) slug += '-' + crypto.randomInt(100, 999);
  try {
    db.exec('BEGIN');
    const r = db.prepare('INSERT INTO restaurants (name,slug,price_paid,plan_expires) VALUES (?,?,?,?)')
      .run(name.trim(), slug, Number(price_paid) || 0, plan_expires || null);
    db.prepare("INSERT INTO users (email,password_hash,role,restaurant_id) VALUES (?,?, 'owner', ?)")
      .run(email.trim().toLowerCase(), bcrypt.hashSync(password, 10), r.lastInsertRowid);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return res.redirect('/admin?error=' + encodeURIComponent('Email already in use'));
  }
  res.redirect('/admin');
});
app.post('/admin/restaurants/:id/toggle', need('admin'), (req, res) => {
  db.prepare('UPDATE restaurants SET active=1-active WHERE id=?').run(req.params.id);
  res.redirect('/admin');
});
app.post('/admin/restaurants/:id/password', need('admin'), (req, res) => {
  if ((req.body.password || '').length >= 6)
    db.prepare("UPDATE users SET password_hash=? WHERE restaurant_id=? AND role='owner'")
      .run(bcrypt.hashSync(req.body.password, 10), req.params.id);
  res.redirect('/admin');
});

// ---------- Restaurant dashboard ----------
const rid = req => req.session.user.restaurant_id;

app.get('/dashboard', need('owner'), (req, res) => {
  const r = db.prepare('SELECT * FROM restaurants WHERE id=?').get(rid(req));
  const categories = db.prepare('SELECT * FROM categories WHERE restaurant_id=? ORDER BY sort,id').all(rid(req));
  const items = db.prepare(`SELECT i.*, c.name AS category FROM items i JOIN categories c ON c.id=i.category_id
    WHERE i.restaurant_id=? ORDER BY c.sort,c.id,i.id`).all(rid(req));
  const edit = req.query.edit ? items.find(i => i.id == req.query.edit) : null;
  res.render('dashboard', { r, categories, items, edit, error: req.query.error, base: BASE_URL });
});
app.post('/dashboard/categories', need('owner'), (req, res) => {
  const name = (req.body.name || '').trim();
  if (name) db.prepare('INSERT INTO categories (restaurant_id,name,sort) VALUES (?,?,?)')
    .run(rid(req), name, db.prepare('SELECT COALESCE(MAX(sort),0)+1 n FROM categories WHERE restaurant_id=?').get(rid(req)).n);
  res.redirect('/dashboard');
});
app.post('/dashboard/categories/:id/delete', need('owner'), (req, res) => {
  db.prepare('DELETE FROM categories WHERE id=? AND restaurant_id=?').run(req.params.id, rid(req));
  res.redirect('/dashboard');
});
app.post('/dashboard/items', need('owner'), upload.single('image'), (req, res) => {
  const { id, name, description, price, category_id } = req.body;
  const cat = db.prepare('SELECT 1 FROM categories WHERE id=? AND restaurant_id=?').get(category_id, rid(req));
  if (!name?.trim() || !(Number(price) >= 0) || price === '' || !cat)
    return res.redirect('/dashboard?error=' + encodeURIComponent('Name, price and category are required'));
  const image = req.file ? req.file.filename : null;
  if (id) {
    db.prepare(`UPDATE items SET name=?,description=?,price=?,category_id=?,image=COALESCE(?,image)
      WHERE id=? AND restaurant_id=?`).run(name.trim(), description || '', Number(price), category_id, image, id, rid(req));
  } else {
    db.prepare('INSERT INTO items (restaurant_id,category_id,name,description,price,image) VALUES (?,?,?,?,?,?)')
      .run(rid(req), category_id, name.trim(), description || '', Number(price), image);
  }
  res.redirect('/dashboard#items');
});
app.post('/dashboard/items/:id/toggle', need('owner'), (req, res) => {
  db.prepare('UPDATE items SET available=1-available WHERE id=? AND restaurant_id=?').run(req.params.id, rid(req));
  res.redirect('/dashboard#items');
});
app.post('/dashboard/items/:id/delete', need('owner'), (req, res) => {
  db.prepare('DELETE FROM items WHERE id=? AND restaurant_id=?').run(req.params.id, rid(req));
  res.redirect('/dashboard#items');
});

// QR code (PNG) for the logged-in restaurant
app.get('/dashboard/qr.png', need('owner'), async (req, res) => {
  const r = db.prepare('SELECT slug FROM restaurants WHERE id=?').get(rid(req));
  res.type('png').set('Content-Disposition', req.query.download ? 'attachment; filename="menu-qr.png"' : 'inline');
  res.send(await QRCode.toBuffer(`${BASE_URL}/m/${r.slug}`, { width: 800, margin: 2 }));
});

// ---------- Public menu (what customers see after scanning) ----------
app.get('/m/:slug', (req, res) => {
  const r = db.prepare('SELECT * FROM restaurants WHERE slug=?').get(req.params.slug);
  if (!r || !r.active || (r.plan_expires && r.plan_expires < new Date().toISOString().slice(0, 10)))
    return res.status(404).render('unavailable');
  const cats = db.prepare('SELECT * FROM categories WHERE restaurant_id=? ORDER BY sort,id').all(r.id);
  const items = db.prepare('SELECT * FROM items WHERE restaurant_id=? AND available=1 ORDER BY id').all(r.id);
  res.render('menu', { r, sections: cats.map(c => ({ ...c, items: items.filter(i => i.category_id === c.id) })).filter(c => c.items.length) });
});

app.use((err, req, res, next) => { console.error(err); res.status(500).send('Something went wrong'); });
app.listen(PORT, () => console.log(`Menu Card running at ${BASE_URL}`));
