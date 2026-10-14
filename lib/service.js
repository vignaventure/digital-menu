const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db } = require('./db');
const { removeImage, saveImageData } = require('./uploads');
const { encrypt, decrypt } = require('./vault');
const { BASE_URL } = require('./config');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const slugify = s => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const today = () => new Date().toISOString().slice(0, 10);
const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v));
const isEmail = v => /^\S+@\S+\.\S+$/.test(v);
// Mobile numbers are stored without spaces/dashes/brackets, e.g. "+919876543210". Returns null if invalid.
const normMobile = v => {
  const m = String(v || '').replace(/[\s\-().]/g, '');
  return /^\+?\d{7,15}$/.test(m) ? m : null;
};
const PW_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const generatePassword = (n = 12) => Array.from(crypto.randomBytes(n), b => PW_CHARS[b % PW_CHARS.length]).join('');
// Plan: 'one_time' never expires (stored as no date); 'limited' needs a valid-until date.
function parsePlan({ plan_type, plan_expires }) {
  const type = plan_type || (plan_expires ? 'limited' : 'one_time');
  if (type === 'one_time') return null;
  if (type !== 'limited') throw new HttpError(400, 'plan_type must be one_time or limited');
  if (!plan_expires || !isDate(plan_expires)) throw new HttpError(400, 'Valid until date is required for a limited plan (YYYY-MM-DD)');
  return plan_expires;
}
const cleanPrice = v => {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || !Number.isFinite(n) || n < 0 || n > 1e7) throw new HttpError(400, 'price must be a number between 0 and 10000000');
  return n;
};

// ---- serializers ----
const uploadPath = f => (f ? `/uploads/${f}` : null);
const isColor = c => /^#[0-9a-fA-F]{6}$/.test(c);
const publicUser = u => ({ id: u.id, email: u.email, mobile: u.mobile, role: u.role, restaurant_id: u.restaurant_id });
const itemOut = i => ({
  id: i.id, category_id: i.category_id, ...(i.category !== undefined && { category: i.category }),
  name: i.name, description: i.description || '', price: i.price, available: !!i.available,
  image: uploadPath(i.image), image_url: i.image ? `${BASE_URL}/uploads/${i.image}` : null,
});
const restaurantOut = r => ({
  id: r.id, name: r.name, slug: r.slug, active: !!r.active, owner: r.owner, city: r.city, address: r.address,
  tagline: r.tagline, theme_color: r.theme_color, logo: uploadPath(r.logo), contact_phone: r.contact_phone,
  price_paid: r.price_paid, paid: !!r.paid,
  plan_type: r.plan_expires ? 'limited' : 'one_time', plan_expires: r.plan_expires, created_at: r.created_at,
  owner_email: r.email, owner_mobile: r.mobile, ...(r.has_password !== undefined && { has_password: !!r.has_password }),
  ...(r.generated_password && { generated_password: r.generated_password }),
  menu_url: `${BASE_URL}/m/${r.slug}`,
  ...(r.item_count !== undefined && { item_count: r.item_count }),
});

// ---- auth ----
// identifier = email (contains @) or mobile number
function authenticate(identifier, password) {
  const id = String(identifier || '').trim();
  const u = id.includes('@')
    ? db.prepare('SELECT * FROM users WHERE email=?').get(id.toLowerCase())
    : normMobile(id) && db.prepare('SELECT * FROM users WHERE mobile=?').get(normMobile(id));
  if (!u || !bcrypt.compareSync(String(password || ''), u.password_hash)) throw new HttpError(401, 'Invalid email/mobile or password');
  if (u.role === 'owner' && !db.prepare('SELECT active FROM restaurants WHERE id=?').get(u.restaurant_id)?.active)
    throw new HttpError(403, 'Account inactive. Contact support.');
  return u;
}
function changePassword(userId, current, next) {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if (!bcrypt.compareSync(String(current || ''), u.password_hash)) throw new HttpError(400, 'Current password is incorrect');
  if (String(next || '').length < 6) throw new HttpError(400, 'New password must be at least 6 characters');
  db.prepare('UPDATE users SET password_hash=?, password_enc=NULL WHERE id=?').run(bcrypt.hashSync(next, 10), userId);  // owner took over: the admin copy is stale
}
function userIsActive(userId) {
  const u = db.prepare(`SELECT u.id,u.email,u.mobile,u.role,u.restaurant_id,r.active FROM users u
    LEFT JOIN restaurants r ON r.id=u.restaurant_id WHERE u.id=?`).get(userId);
  return u && (u.role === 'admin' || u.active) ? u : null;
}

// ---- restaurants (super admin) ----
const restaurantSelect = `SELECT r.*, u.email, u.mobile, (u.password_enc IS NOT NULL) AS has_password,
  (SELECT COUNT(*) FROM items i WHERE i.restaurant_id=r.id) AS item_count
  FROM restaurants r LEFT JOIN users u ON u.restaurant_id=r.id AND u.role='owner'`;
const listRestaurants = () => db.prepare(restaurantSelect + ' ORDER BY r.id DESC').all();
const getRestaurant = id => {
  const r = db.prepare(restaurantSelect + ' WHERE r.id=?').get(id);
  if (!r) throw new HttpError(404, 'Restaurant not found');
  return r;
};

// Validates owner login fields. `exceptUserId` lets an owner keep their own mobile/email when editing.
function cleanOwner({ mobile, email }, exceptUserId = 0, requireMobile = true) {
  const m = normMobile(mobile);
  if (!m && (requireMobile || mobile)) throw new HttpError(400, 'A valid mobile number is required (7-15 digits, optional leading +)');
  const e = String(email || '').trim().toLowerCase();
  if (e && !isEmail(e)) throw new HttpError(400, 'Email is not valid');
  if (m && db.prepare('SELECT 1 FROM users WHERE mobile=? AND id<>?').get(m, exceptUserId)) throw new HttpError(409, 'Mobile number already in use');
  if (e && db.prepare('SELECT 1 FROM users WHERE email=? AND id<>?').get(e, exceptUserId)) throw new HttpError(409, 'Email already in use');
  return { mobile: m, email: e || null };
}

const flag = v => v === true || v === 'true' || v === 1 || v === '1' || v === 'on';
const text = (v, max = 200) => String(v ?? '').trim().slice(0, max);

// A blank password means "generate one"; the generated password is returned once (and kept encrypted, see vault.js).
function createRestaurant(body) {
  const name = text(body.name);
  if (!name) throw new HttpError(400, 'Restaurant name is required');
  const owner = cleanOwner(body);
  let password = String(body.password || '');
  const generated = !password;
  if (generated) password = generatePassword();
  if (password.length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
  const plan_expires = parsePlan(body);
  const fee = Number(body.price_paid ?? 0);
  if (!Number.isFinite(fee) || fee < 0 || fee > 1e7) throw new HttpError(400, 'Onboarding price must be a number');
  let slug = slugify(name) || 'restaurant';
  while (db.prepare('SELECT 1 FROM restaurants WHERE slug=?').get(slug)) slug += '-' + crypto.randomInt(100, 999);
  db.exec('BEGIN');
  try {
    const r = db.prepare('INSERT INTO restaurants (name,slug,owner,city,price_paid,paid,plan_expires) VALUES (?,?,?,?,?,?,?)')
      .run(name, slug, text(body.owner), text(body.city), fee, flag(body.paid) ? 1 : 0, plan_expires);
    db.prepare("INSERT INTO users (email,mobile,password_hash,password_enc,role,restaurant_id) VALUES (?,?,?,?,'owner',?)")
      .run(owner.email, owner.mobile, bcrypt.hashSync(password, 10), encrypt(password), r.lastInsertRowid);
    db.exec('COMMIT');
    return { ...getRestaurant(r.lastInsertRowid), ...(generated && { generated_password: password }) };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Partial update: only keys present in `body` change. Covers the restaurant and its owner login.
function updateRestaurant(id, body) {
  const cur = getRestaurant(id);
  const owner = db.prepare("SELECT * FROM users WHERE restaurant_id=? AND role='owner'").get(id);
  const sets = [], vals = [];
  if (body.name !== undefined) {
    if (!String(body.name).trim()) throw new HttpError(400, 'name cannot be empty');
    sets.push('name=?'); vals.push(String(body.name).trim());
  }
  if (body.active !== undefined) { sets.push('active=?'); vals.push(flag(body.active) ? 1 : 0); }
  if (body.owner !== undefined) { sets.push('owner=?'); vals.push(text(body.owner)); }
  if (body.city !== undefined) { sets.push('city=?'); vals.push(text(body.city)); }
  if (body.paid !== undefined) { sets.push('paid=?'); vals.push(flag(body.paid) ? 1 : 0); }
  if (body.price_paid !== undefined) {
    if (!Number.isFinite(Number(body.price_paid))) throw new HttpError(400, 'price_paid must be a number');
    sets.push('price_paid=?'); vals.push(Number(body.price_paid));
  }
  if (body.plan_type !== undefined || body.plan_expires !== undefined) {
    sets.push('plan_expires=?'); vals.push(parsePlan(body));
  }
  // owner login: validate everything before writing anything
  let ownerChange = null;
  if (owner && (body.mobile !== undefined || body.email !== undefined || body.password)) {
    // legacy owners created before mobile existed may have none; only insist on one once it is supplied
    const next = cleanOwner({ mobile: body.mobile ?? cur.mobile, email: body.email ?? cur.email }, owner.id, body.mobile !== undefined || !!cur.mobile);
    if (body.password && String(body.password).length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
    ownerChange = { ...next, hash: body.password ? bcrypt.hashSync(String(body.password), 10) : owner.password_hash,
      enc: body.password ? encrypt(String(body.password)) : owner.password_enc };
  }
  db.exec('BEGIN');
  try {
    if (sets.length) db.prepare(`UPDATE restaurants SET ${sets.join(',')} WHERE id=?`).run(...vals, id);
    if (ownerChange) db.prepare('UPDATE users SET email=?, mobile=?, password_hash=?, password_enc=? WHERE id=?')
      .run(ownerChange.email, ownerChange.mobile, ownerChange.hash, ownerChange.enc, owner.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return getRestaurant(id);
}
// Super admin only: the password they set for this restaurant's owner, or null if unavailable.
function revealOwnerPassword(restaurantId) {
  getRestaurant(restaurantId);
  return decrypt(db.prepare("SELECT password_enc FROM users WHERE restaurant_id=? AND role='owner'").get(restaurantId)?.password_enc);
}
const toggleRestaurant = id => db.prepare('UPDATE restaurants SET active=1-active WHERE id=?').run(id);

function resetOwnerPassword(restaurantId, password) {
  getRestaurant(restaurantId);
  if (String(password || '').length < 6) throw new HttpError(400, 'password must be at least 6 characters');
  db.prepare("UPDATE users SET password_hash=?, password_enc=? WHERE restaurant_id=? AND role='owner'")
    .run(bcrypt.hashSync(password, 10), encrypt(password), restaurantId);
}

function deleteRestaurant(id) {
  getRestaurant(id);
  const imgs = db.prepare('SELECT image FROM items WHERE restaurant_id=? AND image IS NOT NULL').all(id);
  const logo = db.prepare('SELECT logo FROM restaurants WHERE id=?').get(id)?.logo;
  db.prepare('DELETE FROM restaurants WHERE id=?').run(id);
  imgs.forEach(i => removeImage(i.image));
  removeImage(logo);
}

// Admin dashboard numbers. "Inactive" = switched off by the admin; revenue counts only payments received.
function summary() {
  return db.prepare(`SELECT COUNT(*) AS restaurants,
    COALESCE(SUM(active),0) AS active, COUNT(*)-COALESCE(SUM(active),0) AS inactive,
    COALESCE(SUM(CASE WHEN paid=1 THEN price_paid END),0) AS revenue,
    COALESCE(SUM(CASE WHEN paid=0 THEN price_paid END),0) AS outstanding FROM restaurants`).get();
}

// The restaurant's own profile (branding + business info). Login mobile/email are changed by the admin only.
function updateProfile(rid, body) {
  const cur = db.prepare('SELECT * FROM restaurants WHERE id=?').get(rid);
  const name = text(body.name, 80);
  if (!name) throw new HttpError(400, 'Restaurant name is required');
  const color = text(body.theme_color ?? cur.theme_color, 7);
  if (!isColor(color)) throw new HttpError(400, 'Theme color must look like #aabbcc');
  let logo = cur.logo;
  const newLogo = body.logo ? saveImageData(body.logo) : null;
  if (newLogo) { removeImage(logo); logo = newLogo; }
  else if (flag(body.remove_logo)) { removeImage(logo); logo = null; }
  db.prepare('UPDATE restaurants SET name=?, owner=?, contact_phone=?, city=?, address=?, tagline=?, theme_color=?, logo=? WHERE id=?')
    .run(name, text(body.owner ?? cur.owner, 80), text(body.contact_phone ?? cur.contact_phone, 20), text(body.city ?? cur.city, 60),
      text(body.address ?? cur.address, 400), text(body.tagline ?? cur.tagline, 120), color, logo, rid);
  return getRestaurant(rid);
}

// ---- categories (owner) ----
const listCategories = rid => db.prepare(`SELECT c.id, c.name, c.sort, (SELECT COUNT(*) FROM items i WHERE i.category_id=c.id) AS items
  FROM categories c WHERE c.restaurant_id=? ORDER BY c.sort, c.id`).all(rid);
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
  if (!db.prepare('SELECT 1 FROM categories WHERE id=? AND restaurant_id=?').get(id, rid)) throw new HttpError(404, 'Category not found');
  if (db.prepare('SELECT 1 FROM items WHERE category_id=?').get(id)) throw new HttpError(409, 'This category still has items. Move or delete them first.');
  db.prepare('DELETE FROM categories WHERE id=?').run(id);
}

// ---- items (owner) ----
const listItems = (rid, categoryId) => db.prepare(`SELECT i.*, c.name AS category FROM items i JOIN categories c ON c.id=i.category_id
  WHERE i.restaurant_id=? ${categoryId ? 'AND i.category_id=?' : ''} ORDER BY c.sort,c.id,i.id`).all(...(categoryId ? [rid, categoryId] : [rid]));
const getItem = (rid, id) => {
  const i = db.prepare('SELECT * FROM items WHERE id=? AND restaurant_id=?').get(id, rid);
  if (!i) throw new HttpError(404, 'Item not found');
  return i;
};

// Create (no id) or update (id). `image` is a freshly saved file name or null; body.remove_image clears the current photo.
function saveItem(rid, { id, name, description, price, category_id, available, remove_image }, image) {
  try {
    name = text(name, 80);
    if (!name) throw new HttpError(400, 'name is required');
    price = cleanPrice(price);
    if (!db.prepare('SELECT 1 FROM categories WHERE id=? AND restaurant_id=?').get(category_id, rid))
      throw new HttpError(400, 'category_id is invalid');
    description = String(description || '').slice(0, 300);
    if (id) {
      const old = getItem(rid, id);
      const avail = available === undefined ? old.available : (available === false || available === 'false' || available === 0 || available === '0' ? 0 : 1);
      const dropImage = !image && flag(remove_image);
      db.prepare('UPDATE items SET name=?,description=?,price=?,category_id=?,available=?,image=? WHERE id=? AND restaurant_id=?')
        .run(name, description, price, category_id, avail, image || (dropImage ? null : old.image), id, rid);
      if (image || dropImage) removeImage(old.image);
      return getItem(rid, id);
    }
    const avail = available === false || available === 'false' || available === 0 || available === '0' ? 0 : 1;
    const r = db.prepare('INSERT INTO items (restaurant_id,category_id,name,description,price,image,available) VALUES (?,?,?,?,?,?,?)')
      .run(rid, category_id, name, description, price, image, avail);
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
  HttpError, generatePassword, saveImageData, publicUser, itemOut, restaurantOut,
  authenticate, changePassword, userIsActive,
  listRestaurants, getRestaurant, revealOwnerPassword, createRestaurant, updateRestaurant, toggleRestaurant, resetOwnerPassword, deleteRestaurant,
  summary, updateProfile,
  listCategories, createCategory, renameCategory, deleteCategory,
  listItems, getItem, saveItem, setItemAvailable, deleteItem, getMenu,
};
