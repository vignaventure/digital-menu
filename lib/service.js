const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db } = require('./db');
const { removeImage } = require('./uploads');
const { BASE_URL } = require('./config');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const slugify = s => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const today = () => new Date().toISOString().slice(0, 10);
const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v));
const isEmail = v => /^\S+@\S+\.\S+$/.test(v);
const cleanPrice = v => {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || !Number.isFinite(n) || n < 0 || n > 1e7) throw new HttpError(400, 'price must be a number between 0 and 10000000');
  return n;
};

// ---- serializers ----
const publicUser = u => ({ id: u.id, email: u.email, role: u.role, restaurant_id: u.restaurant_id });
const itemOut = i => ({
  id: i.id, category_id: i.category_id, name: i.name, description: i.description || '',
  price: i.price, available: !!i.available, image_url: i.image ? `${BASE_URL}/uploads/${i.image}` : null,
});
const restaurantOut = r => ({
  id: r.id, name: r.name, slug: r.slug, active: !!r.active, price_paid: r.price_paid,
  plan_expires: r.plan_expires, created_at: r.created_at, owner_email: r.email,
  menu_url: `${BASE_URL}/m/${r.slug}`,
  ...(r.item_count !== undefined && { item_count: r.item_count }),
});

// ---- auth ----
function authenticate(email, password) {
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(email || '').trim().toLowerCase());
  if (!u || !bcrypt.compareSync(String(password || ''), u.password_hash)) throw new HttpError(401, 'Invalid email or password');
  if (u.role === 'owner' && !db.prepare('SELECT active FROM restaurants WHERE id=?').get(u.restaurant_id)?.active)
    throw new HttpError(403, 'Account disabled. Contact support.');
  return u;
}
function changePassword(userId, current, next) {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if (!bcrypt.compareSync(String(current || ''), u.password_hash)) throw new HttpError(400, 'Current password is incorrect');
  if (String(next || '').length < 6) throw new HttpError(400, 'New password must be at least 6 characters');
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(next, 10), userId);
}
function userIsActive(userId) {
  const u = db.prepare(`SELECT u.id,u.email,u.role,u.restaurant_id,r.active FROM users u
    LEFT JOIN restaurants r ON r.id=u.restaurant_id WHERE u.id=?`).get(userId);
  return u && (u.role === 'admin' || u.active) ? u : null;
}

// ---- restaurants (super admin) ----
const restaurantSelect = `SELECT r.*, u.email,
  (SELECT COUNT(*) FROM items i WHERE i.restaurant_id=r.id) AS item_count
  FROM restaurants r LEFT JOIN users u ON u.restaurant_id=r.id`;
const listRestaurants = () => db.prepare(restaurantSelect + ' ORDER BY r.id DESC').all();
const getRestaurant = id => {
  const r = db.prepare(restaurantSelect + ' WHERE r.id=?').get(id);
  if (!r) throw new HttpError(404, 'Restaurant not found');
  return r;
};

function createRestaurant({ name, email, password, price_paid, plan_expires }) {
  name = String(name || '').trim();
  email = String(email || '').trim().toLowerCase();
  if (!name || !isEmail(email) || String(password || '').length < 6)
    throw new HttpError(400, 'name, a valid email and a password (min 6 chars) are required');
  if (plan_expires && !isDate(plan_expires)) throw new HttpError(400, 'plan_expires must be YYYY-MM-DD');
  let slug = slugify(name) || 'restaurant';
  while (db.prepare('SELECT 1 FROM restaurants WHERE slug=?').get(slug)) slug += '-' + crypto.randomInt(100, 999);
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw new HttpError(409, 'Email already in use');
  db.exec('BEGIN');
  try {
    const r = db.prepare('INSERT INTO restaurants (name,slug,price_paid,plan_expires) VALUES (?,?,?,?)')
      .run(name, slug, Number(price_paid) || 0, plan_expires || null);
    db.prepare("INSERT INTO users (email,password_hash,role,restaurant_id) VALUES (?,?,'owner',?)")
      .run(email, bcrypt.hashSync(password, 10), r.lastInsertRowid);
    db.exec('COMMIT');
    return getRestaurant(r.lastInsertRowid);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function updateRestaurant(id, body) {
  getRestaurant(id);
  const sets = [], vals = [];
  if (body.name !== undefined) {
    if (!String(body.name).trim()) throw new HttpError(400, 'name cannot be empty');
    sets.push('name=?'); vals.push(String(body.name).trim());
  }
  if (body.active !== undefined) { sets.push('active=?'); vals.push(body.active ? 1 : 0); }
  if (body.price_paid !== undefined) {
    if (!Number.isFinite(Number(body.price_paid))) throw new HttpError(400, 'price_paid must be a number');
    sets.push('price_paid=?'); vals.push(Number(body.price_paid));
  }
  if (body.plan_expires !== undefined) {
    if (body.plan_expires && !isDate(body.plan_expires)) throw new HttpError(400, 'plan_expires must be YYYY-MM-DD or null');
    sets.push('plan_expires=?'); vals.push(body.plan_expires || null);
  }
  if (sets.length) db.prepare(`UPDATE restaurants SET ${sets.join(',')} WHERE id=?`).run(...vals, id);
  return getRestaurant(id);
}
const toggleRestaurant = id => db.prepare('UPDATE restaurants SET active=1-active WHERE id=?').run(id);

function resetOwnerPassword(restaurantId, password) {
  getRestaurant(restaurantId);
  if (String(password || '').length < 6) throw new HttpError(400, 'password must be at least 6 characters');
  db.prepare("UPDATE users SET password_hash=? WHERE restaurant_id=? AND role='owner'").run(bcrypt.hashSync(password, 10), restaurantId);
}

function deleteRestaurant(id) {
  getRestaurant(id);
  const imgs = db.prepare('SELECT image FROM items WHERE restaurant_id=? AND image IS NOT NULL').all(id);
  db.prepare('DELETE FROM restaurants WHERE id=?').run(id);
  imgs.forEach(i => removeImage(i.image));
}

// ---- categories (owner) ----
const listCategories = rid => db.prepare('SELECT id,name,sort FROM categories WHERE restaurant_id=? ORDER BY sort,id').all(rid);
function createCategory(rid, name) {
  name = String(name || '').trim();
  if (!name) throw new HttpError(400, 'name is required');
  const sort = db.prepare('SELECT COALESCE(MAX(sort),0)+1 n FROM categories WHERE restaurant_id=?').get(rid).n;
  const r = db.prepare('INSERT INTO categories (restaurant_id,name,sort) VALUES (?,?,?)').run(rid, name, sort);
  return { id: Number(r.lastInsertRowid), name, sort };
}
function renameCategory(rid, id, name) {
  name = String(name || '').trim();
  if (!name) throw new HttpError(400, 'name is required');
  const r = db.prepare('UPDATE categories SET name=? WHERE id=? AND restaurant_id=?').run(name, id, rid);
  if (!r.changes) throw new HttpError(404, 'Category not found');
  return { id: Number(id), name };
}
function deleteCategory(rid, id) {
  const imgs = db.prepare('SELECT image FROM items WHERE category_id=? AND restaurant_id=? AND image IS NOT NULL').all(id, rid);
  const r = db.prepare('DELETE FROM categories WHERE id=? AND restaurant_id=?').run(id, rid);
  if (!r.changes) throw new HttpError(404, 'Category not found');
  imgs.forEach(i => removeImage(i.image));
}

// ---- items (owner) ----
const listItems = (rid, categoryId) => db.prepare(`SELECT i.*, c.name AS category FROM items i JOIN categories c ON c.id=i.category_id
  WHERE i.restaurant_id=? ${categoryId ? 'AND i.category_id=?' : ''} ORDER BY c.sort,c.id,i.id`).all(...(categoryId ? [rid, categoryId] : [rid]));
const getItem = (rid, id) => {
  const i = db.prepare('SELECT * FROM items WHERE id=? AND restaurant_id=?').get(id, rid);
  if (!i) throw new HttpError(404, 'Item not found');
  return i;
};

// Create (no id) or update (id). `image` is a freshly uploaded filename or null.
function saveItem(rid, { id, name, description, price, category_id }, image) {
  try {
    name = String(name || '').trim();
    if (!name) throw new HttpError(400, 'name is required');
    price = cleanPrice(price);
    if (!db.prepare('SELECT 1 FROM categories WHERE id=? AND restaurant_id=?').get(category_id, rid))
      throw new HttpError(400, 'category_id is invalid');
    description = String(description || '').slice(0, 1000);
    if (id) {
      const old = getItem(rid, id);
      db.prepare('UPDATE items SET name=?,description=?,price=?,category_id=?,image=COALESCE(?,image) WHERE id=? AND restaurant_id=?')
        .run(name, description, price, category_id, image, id, rid);
      if (image) removeImage(old.image);
      return getItem(rid, id);
    }
    const r = db.prepare('INSERT INTO items (restaurant_id,category_id,name,description,price,image) VALUES (?,?,?,?,?,?)')
      .run(rid, category_id, name, description, price, image);
    return getItem(rid, r.lastInsertRowid);
  } catch (e) {
    removeImage(image); // don't orphan the upload when validation fails
    throw e;
  }
}
function setItemAvailable(rid, id, available) {
  const i = getItem(rid, id);
  db.prepare('UPDATE items SET available=? WHERE id=?').run((available === undefined ? !i.available : available) ? 1 : 0, id);
  return getItem(rid, id);
}
function deleteItem(rid, id) {
  const i = getItem(rid, id);
  db.prepare('DELETE FROM items WHERE id=?').run(id);
  removeImage(i.image);
}

// ---- public menu ----
function getMenu(slug) {
  const r = db.prepare('SELECT * FROM restaurants WHERE slug=?').get(slug);
  if (!r || !r.active || (r.plan_expires && r.plan_expires < today())) return null;
  const items = db.prepare('SELECT * FROM items WHERE restaurant_id=? AND available=1 ORDER BY id').all(r.id);
  const sections = listCategories(r.id)
    .map(c => ({ ...c, items: items.filter(i => i.category_id === c.id) }))
    .filter(c => c.items.length);
  return { restaurant: r, sections };
}

module.exports = {
  HttpError, publicUser, itemOut, restaurantOut,
  authenticate, changePassword, userIsActive,
  listRestaurants, getRestaurant, createRestaurant, updateRestaurant, toggleRestaurant, resetOwnerPassword, deleteRestaurant,
  listCategories, createCategory, renameCategory, deleteCategory,
  listItems, getItem, saveItem, setItemAvailable, deleteItem, getMenu,
};
