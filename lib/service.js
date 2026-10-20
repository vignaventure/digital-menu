// Business logic shared by the API routes. Everything here talks to MongoDB, so every function is async.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { cols, nextId, isDuplicate } = require('./db');
const { removeImage, saveImageData, copyImage } = require('./uploads');
const { encrypt, decrypt } = require('./vault');
const { BASE_URL } = require('./config');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const slugify = s => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const today = () => new Date().toISOString().slice(0, 10);
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19); // "2026-10-15 09:30:00" (UTC)
const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v));
const isEmail = v => /^\S+@\S+\.\S+$/.test(v);
const flag = v => v === true || v === 'true' || v === 1 || v === '1' || v === 'on';
const text = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const withId = d => (d ? { ...d, id: d._id } : null); // API objects expose `id`; MongoDB stores it as `_id`
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
const isColor = c => /^#[0-9a-fA-F]{6}$/.test(c);

// ---- serializers ----
const uploadPath = f => (f ? `/uploads/${f}` : null);
const publicUser = u => ({ id: u.id, email: u.email ?? null, mobile: u.mobile ?? null, role: u.role, restaurant_id: u.restaurant_id ?? null });
const itemOut = i => ({
  id: i.id, category_id: i.category_id, ...(i.category !== undefined && { category: i.category }),
  name: i.name, description: i.description || '', price: i.price, available: !!i.available,
  image: uploadPath(i.image), image_url: i.image ? `${BASE_URL}/uploads/${i.image}` : null,
});
const restaurantOut = r => ({
  id: r.id, name: r.name, slug: r.slug, active: !!r.active, owner: r.owner, city: r.city, address: r.address,
  tagline: r.tagline, theme_color: r.theme_color, logo: uploadPath(r.logo), contact_phone: r.contact_phone,
  price_paid: r.price_paid, paid: !!r.paid,
  plan_type: r.plan_expires ? 'limited' : 'one_time', plan_expires: r.plan_expires ?? null, created_at: r.created_at,
  owner_email: r.email ?? null, owner_mobile: r.mobile ?? null, ...(r.has_password !== undefined && { has_password: !!r.has_password }),
  ...(r.generated_password && { generated_password: r.generated_password }),
  menu_url: `${BASE_URL}/m/${r.slug}`,
  ...(r.item_count !== undefined && { item_count: r.item_count }),
});

// ---- auth ----
// identifier = email (contains @) or mobile number
async function authenticate(identifier, password) {
  const id = String(identifier || '').trim();
  const m = id.includes('@') ? null : normMobile(id);
  const u = id.includes('@') ? withId(await cols.users.findOne({ email: id.toLowerCase() })) : m ? withId(await cols.users.findOne({ mobile: m })) : null;
  if (!u || !bcrypt.compareSync(String(password || ''), u.password_hash)) throw new HttpError(401, 'Invalid email/mobile or password');
  if (u.role === 'owner' && !(await cols.restaurants.findOne({ _id: u.restaurant_id }))?.active)
    throw new HttpError(403, 'Account inactive. Contact support.');
  return u;
}
async function changePassword(userId, current, next) {
  const u = await cols.users.findOne({ _id: userId });
  if (!bcrypt.compareSync(String(current || ''), u.password_hash)) throw new HttpError(400, 'Current password is incorrect');
  if (String(next || '').length < 6) throw new HttpError(400, 'New password must be at least 6 characters');
  // owner took over: the admin's encrypted copy is stale
  await cols.users.updateOne({ _id: userId }, { $set: { password_hash: bcrypt.hashSync(next, 10), password_enc: null } });
}
// The logged-in user if their account still works (restaurant not deactivated/deleted), else null.
async function userIsActive(userId) {
  const u = withId(await cols.users.findOne({ _id: Number(userId) }));
  if (!u) return null;
  if (u.role === 'admin') return u;
  const r = await cols.restaurants.findOne({ _id: u.restaurant_id });
  return r?.active ? u : null;
}

// ---- restaurants (super admin) ----
// A "row" is the restaurant plus its owner login and item count, the shape restaurantOut() expects.
function toRow(r, owner, itemCount) {
  return { ...withId(r), email: owner?.email ?? null, mobile: owner?.mobile ?? null, has_password: !!owner?.password_enc, item_count: itemCount };
}
async function listRestaurants() {
  const [rs, owners, counts] = await Promise.all([
    cols.restaurants.find().sort({ _id: -1 }).toArray(),
    cols.users.find({ role: 'owner' }).toArray(),
    cols.items.aggregate([{ $group: { _id: '$restaurant_id', n: { $sum: 1 } } }]).toArray(),
  ]);
  const byRest = new Map(owners.map(u => [u.restaurant_id, u]));
  const n = new Map(counts.map(c => [c._id, c.n]));
  return rs.map(r => toRow(r, byRest.get(r._id), n.get(r._id) || 0));
}
async function getRestaurant(id) {
  const r = await cols.restaurants.findOne({ _id: Number(id) });
  if (!r) throw new HttpError(404, 'Restaurant not found');
  const [owner, count] = await Promise.all([cols.users.findOne({ restaurant_id: r._id, role: 'owner' }), cols.items.countDocuments({ restaurant_id: r._id })]);
  return toRow(r, owner, count);
}

// Validates owner login fields. `exceptUserId` lets an owner keep their own mobile/email when editing.
async function cleanOwner({ mobile, email }, exceptUserId = 0, requireMobile = true) {
  const m = normMobile(mobile);
  if (!m && (requireMobile || mobile)) throw new HttpError(400, 'A valid mobile number is required (7-15 digits, optional leading +)');
  const e = String(email || '').trim().toLowerCase();
  if (e && !isEmail(e)) throw new HttpError(400, 'Email is not valid');
  if (m && await cols.users.findOne({ mobile: m, _id: { $ne: exceptUserId } })) throw new HttpError(409, 'Mobile number already in use');
  if (e && await cols.users.findOne({ email: e, _id: { $ne: exceptUserId } })) throw new HttpError(409, 'Email already in use');
  return { mobile: m, email: e || null };
}
const dupError = e => (isDuplicate(e) ? new HttpError(409, 'Mobile number or email already in use') : e);

// A blank password means "generate one"; the generated password is returned once (and kept encrypted, see vault.js).
async function createRestaurant(body) {
  const name = text(body.name);
  if (!name) throw new HttpError(400, 'Restaurant name is required');
  const owner = await cleanOwner(body);
  let password = String(body.password || '');
  const generated = !password;
  if (generated) password = generatePassword();
  if (password.length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
  const plan_expires = parsePlan(body);
  const fee = Number(body.price_paid ?? 0);
  if (!Number.isFinite(fee) || fee < 0 || fee > 1e7) throw new HttpError(400, 'Onboarding price must be a number');

  let slug = slugify(name) || 'restaurant';
  while (await cols.restaurants.findOne({ slug }, { projection: { _id: 1 } })) slug += '-' + crypto.randomInt(100, 999);
  const id = await nextId('restaurants');
  await cols.restaurants.insertOne({
    _id: id, name, slug, owner: text(body.owner), city: text(body.city), address: '', tagline: '', theme_color: '#d9480f', logo: null,
    contact_phone: '', price_paid: fee, paid: flag(body.paid), plan_expires, active: true, created_at: stamp(),
  });
  try {
    await cols.users.insertOne({
      _id: await nextId('users'), email: owner.email, mobile: owner.mobile, password_hash: bcrypt.hashSync(password, 10),
      password_enc: encrypt(password), role: 'owner', restaurant_id: id,
    });
  } catch (e) {
    await cols.restaurants.deleteOne({ _id: id }); // no transaction needed: undo the restaurant if the login could not be created
    throw dupError(e);
  }
  return { ...(await getRestaurant(id)), ...(generated && { generated_password: password }) };
}

// Partial update: only keys present in `body` change. Covers the restaurant and its owner login.
async function updateRestaurant(id, body) {
  const cur = await getRestaurant(id);
  const owner = await cols.users.findOne({ restaurant_id: cur.id, role: 'owner' });
  const set = {};
  if (body.name !== undefined) {
    if (!String(body.name).trim()) throw new HttpError(400, 'name cannot be empty');
    set.name = String(body.name).trim();
  }
  if (body.active !== undefined) set.active = flag(body.active);
  if (body.owner !== undefined) set.owner = text(body.owner);
  if (body.city !== undefined) set.city = text(body.city);
  if (body.paid !== undefined) set.paid = flag(body.paid);
  if (body.price_paid !== undefined) {
    if (!Number.isFinite(Number(body.price_paid))) throw new HttpError(400, 'price_paid must be a number');
    set.price_paid = Number(body.price_paid);
  }
  if (body.plan_type !== undefined || body.plan_expires !== undefined) set.plan_expires = parsePlan(body);

  // owner login: validate everything before writing anything
  let ownerSet = null;
  if (owner && (body.mobile !== undefined || body.email !== undefined || body.password)) {
    // legacy owners created before mobile existed may have none; only insist on one once it is supplied
    const next = await cleanOwner({ mobile: body.mobile ?? cur.mobile, email: body.email ?? cur.email }, owner._id, body.mobile !== undefined || !!cur.mobile);
    if (body.password && String(body.password).length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
    ownerSet = { email: next.email, mobile: next.mobile };
    if (body.password) { ownerSet.password_hash = bcrypt.hashSync(String(body.password), 10); ownerSet.password_enc = encrypt(String(body.password)); }
  }
  if (Object.keys(set).length) await cols.restaurants.updateOne({ _id: cur.id }, { $set: set });
  if (ownerSet) { try { await cols.users.updateOne({ _id: owner._id }, { $set: ownerSet }); } catch (e) { throw dupError(e); } }
  return getRestaurant(id);
}
// Super admin only: the password they set for this restaurant's owner, or null if unavailable.
async function revealOwnerPassword(restaurantId) {
  await getRestaurant(restaurantId);
  return decrypt((await cols.users.findOne({ restaurant_id: Number(restaurantId), role: 'owner' }))?.password_enc);
}
async function resetOwnerPassword(restaurantId, password) {
  await getRestaurant(restaurantId);
  if (String(password || '').length < 6) throw new HttpError(400, 'password must be at least 6 characters');
  await cols.users.updateOne({ restaurant_id: Number(restaurantId), role: 'owner' }, { $set: { password_hash: bcrypt.hashSync(password, 10), password_enc: encrypt(password) } });
}

async function deleteRestaurant(id) {
  const r = await getRestaurant(id);
  const imgs = await cols.items.find({ restaurant_id: r.id, image: { $ne: null } }, { projection: { image: 1 } }).toArray();
  await Promise.all([cols.items.deleteMany({ restaurant_id: r.id }), cols.categories.deleteMany({ restaurant_id: r.id }), cols.users.deleteMany({ restaurant_id: r.id })]);
  await cols.restaurants.deleteOne({ _id: r.id });
  imgs.forEach(i => removeImage(i.image));
  removeImage(r.logo);
}

// Admin dashboard numbers. "Inactive" = switched off by the admin; revenue counts only payments received.
async function summary() {
  const rs = await cols.restaurants.find({}, { projection: { active: 1, paid: 1, price_paid: 1 } }).toArray();
  const active = rs.filter(r => r.active).length;
  const sum = list => list.reduce((s, r) => s + (r.price_paid || 0), 0);
  return { restaurants: rs.length, active, inactive: rs.length - active, revenue: sum(rs.filter(r => r.paid)), outstanding: sum(rs.filter(r => !r.paid)) };
}

// The restaurant's own profile (branding + business info). Login mobile/email are changed by the admin only.
async function updateProfile(rid, body) {
  const cur = await cols.restaurants.findOne({ _id: rid });
  const name = text(body.name, 80);
  if (!name) throw new HttpError(400, 'Restaurant name is required');
  const color = text(body.theme_color ?? cur.theme_color, 7);
  if (!isColor(color)) throw new HttpError(400, 'Theme color must look like #aabbcc');
  let logo = cur.logo;
  const newLogo = body.logo ? saveImageData(body.logo) : null;
  if (newLogo) { removeImage(logo); logo = newLogo; }
  else if (flag(body.remove_logo)) { removeImage(logo); logo = null; }
  await cols.restaurants.updateOne({ _id: rid }, { $set: {
    name, owner: text(body.owner ?? cur.owner, 80), contact_phone: text(body.contact_phone ?? cur.contact_phone, 20), city: text(body.city ?? cur.city, 60),
    address: text(body.address ?? cur.address, 400), tagline: text(body.tagline ?? cur.tagline, 120), theme_color: color, logo,
  } });
  return getRestaurant(rid);
}

// ---- categories (owner) ----
async function listCategories(rid) {
  const [cats, counts] = await Promise.all([
    cols.categories.find({ restaurant_id: rid }).sort({ sort: 1, _id: 1 }).toArray(),
    cols.items.aggregate([{ $match: { restaurant_id: rid } }, { $group: { _id: '$category_id', n: { $sum: 1 } } }]).toArray(),
  ]);
  const n = new Map(counts.map(c => [c._id, c.n]));
  return cats.map(c => ({ id: c._id, name: c.name, sort: c.sort, items: n.get(c._id) || 0 }));
}
async function createCategory(rid, name) {
  name = String(name || '').trim();
  if (!name) throw new HttpError(400, 'name is required');
  const last = await cols.categories.find({ restaurant_id: rid }).sort({ sort: -1 }).limit(1).next();
  const sort = (last?.sort ?? 0) + 1, id = await nextId('categories');
  await cols.categories.insertOne({ _id: id, restaurant_id: rid, name, sort });
  return { id, name, sort };
}
async function renameCategory(rid, id, name) {
  name = String(name || '').trim();
  if (!name) throw new HttpError(400, 'name is required');
  const r = await cols.categories.updateOne({ _id: Number(id), restaurant_id: rid }, { $set: { name } });
  if (!r.matchedCount) throw new HttpError(404, 'Category not found');
  return { id: Number(id), name };
}
async function deleteCategory(rid, id) {
  id = Number(id);
  if (!await cols.categories.findOne({ _id: id, restaurant_id: rid })) throw new HttpError(404, 'Category not found');
  if (await cols.items.findOne({ category_id: id })) throw new HttpError(409, 'This category still has items. Move or delete them first.');
  await cols.categories.deleteOne({ _id: id });
}

// ---- items (owner) ----
async function listItems(rid, categoryId) {
  const [cats, items] = await Promise.all([
    cols.categories.find({ restaurant_id: rid }).toArray(),
    cols.items.find({ restaurant_id: rid, ...(categoryId && { category_id: categoryId }) }).toArray(),
  ]);
  const cat = new Map(cats.map(c => [c._id, c]));
  return items
    .filter(i => cat.has(i.category_id))
    .map(i => ({ ...withId(i), category: cat.get(i.category_id).name }))
    .sort((a, b) => cat.get(a.category_id).sort - cat.get(b.category_id).sort || a.category_id - b.category_id || a.id - b.id);
}
async function getItem(rid, id) {
  const i = await cols.items.findOne({ _id: Number(id), restaurant_id: rid });
  if (!i) throw new HttpError(404, 'Item not found');
  return withId(i);
}

// Create (no id) or update (id). `image` is a freshly saved file name or null; body.remove_image clears the current photo.
async function saveItem(rid, { id, name, description, price, category_id, available, remove_image }, image) {
  try {
    name = text(name, 80);
    if (!name) throw new HttpError(400, 'name is required');
    price = cleanPrice(price);
    category_id = Number(category_id);
    if (!await cols.categories.findOne({ _id: category_id, restaurant_id: rid })) throw new HttpError(400, 'category_id is invalid');
    description = String(description || '').slice(0, 300);
    const off = available === false || available === 'false' || available === 0 || available === '0';
    if (id) {
      const old = await getItem(rid, id);
      const dropImage = !image && flag(remove_image);
      await cols.items.updateOne({ _id: old.id }, { $set: {
        name, description, price, category_id, available: available === undefined ? !!old.available : !off,
        image: image || (dropImage ? null : old.image),
      } });
      if (image || dropImage) removeImage(old.image);
      return getItem(rid, id);
    }
    const newId = await nextId('items');
    await cols.items.insertOne({ _id: newId, restaurant_id: rid, category_id, name, description, price, image: image || null, available: !off, created_at: stamp() });
    return getItem(rid, newId);
  } catch (e) {
    removeImage(image); // don't orphan the upload when validation fails
    throw e;
  }
}
async function setItemAvailable(rid, id, available) {
  const i = await getItem(rid, id);
  await cols.items.updateOne({ _id: i.id }, { $set: { available: available === undefined ? !i.available : !!available } });
  return getItem(rid, id);
}
async function deleteItem(rid, id) {
  const i = await getItem(rid, id);
  await cols.items.deleteOne({ _id: i.id });
  removeImage(i.image);
}

// ---- library: copy dishes/categories from other restaurants' menus ----
// Only what guests can already see is offered: dishes that are shown, from restaurants that are active and not expired.
const isLive = r => r.active && !(r.plan_expires && r.plan_expires < today());
async function libraryScope(excludeRid) {
  return (await cols.restaurants.find({ active: true }).toArray()).filter(r => isLive(r) && r._id !== excludeRid);
}

// Categories that have at least one visible dish, with the restaurant they belong to.
async function libraryCategories(excludeRid) {
  const rs = await libraryScope(excludeRid), ids = rs.map(r => r._id);
  const [cats, counts] = await Promise.all([
    cols.categories.find({ restaurant_id: { $in: ids } }).sort({ sort: 1, _id: 1 }).toArray(),
    cols.items.aggregate([{ $match: { restaurant_id: { $in: ids }, available: true } }, { $group: { _id: '$category_id', n: { $sum: 1 } } }]).toArray(),
  ]);
  const n = new Map(counts.map(c => [c._id, c.n])), rname = new Map(rs.map(r => [r._id, r.name]));
  return cats.filter(c => n.get(c._id))
    .map(c => ({ category_id: c._id, name: c.name, restaurant_id: c.restaurant_id, restaurant: rname.get(c.restaurant_id), items: n.get(c._id) }));
}

// Searchable list of visible dishes. Filters: q (name/description), category (name), restaurant_id. Paged.
async function libraryItems(excludeRid, { q, category, restaurant_id, limit = 40, offset = 0 } = {}) {
  const rs = await libraryScope(excludeRid);
  const ids = rs.map(r => r._id).filter(id => !restaurant_id || id === Number(restaurant_id));
  const cats = await cols.categories.find({ restaurant_id: { $in: ids } }).toArray();
  const wanted = category ? cats.filter(c => c.name.toLowerCase() === String(category).trim().toLowerCase()) : cats;
  const filter = { restaurant_id: { $in: ids }, available: true, category_id: { $in: wanted.map(c => c._id) } };
  const term = String(q || '').trim().slice(0, 60);
  if (term) { const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); filter.$or = [{ name: re }, { description: re }]; }
  limit = Math.min(Math.max(Number(limit) || 40, 1), 100); offset = Math.max(Number(offset) || 0, 0);
  const [rows, total] = await Promise.all([
    cols.items.find(filter).sort({ name: 1, _id: 1 }).skip(offset).limit(limit).toArray(), cols.items.countDocuments(filter)]);
  const cname = new Map(cats.map(c => [c._id, c.name])), rname = new Map(rs.map(r => [r._id, r.name]));
  return {
    total,
    items: rows.map(i => ({ id: i._id, name: i.name, description: i.description || '', price: i.price, image: uploadPath(i.image),
      category: cname.get(i.category_id), restaurant_id: i.restaurant_id, restaurant: rname.get(i.restaurant_id) })),
  };
}

// Copy chosen dishes (`items`: ids) and categories (`categories`: [{category_id, with_items}]) into restaurant `rid`.
// Categories are matched by name (created when missing), dishes already in the same category are skipped, photos are copied.
const IMPORT_MAX = 300;
async function importFromLibrary(rid, body = {}) {
  const wantItems = [...new Set((Array.isArray(body.items) ? body.items : []).map(Number).filter(Number.isInteger))];
  const wantCats = (Array.isArray(body.categories) ? body.categories : []).filter(c => Number.isInteger(Number(c?.category_id)));
  if (!wantItems.length && !wantCats.length) throw new HttpError(400, 'Choose at least one dish or category');
  if (wantItems.length > IMPORT_MAX || wantCats.length > 50) throw new HttpError(400, `Too many at once (max ${IMPORT_MAX} dishes, 50 categories). Choose fewer.`);
  const live = new Map((await libraryScope(rid)).map(r => [r._id, r]));

  const srcCats = await cols.categories.find({ _id: { $in: [...wantCats.map(c => Number(c.category_id))] } }).toArray();
  const srcCatsOk = srcCats.filter(c => live.has(c.restaurant_id));
  let srcItems = wantItems.length ? await cols.items.find({ _id: { $in: wantItems } }).toArray() : [];
  for (const spec of wantCats) {
    const c = srcCatsOk.find(x => x._id === Number(spec.category_id));
    if (c && flag(spec.with_items)) srcItems.push(...await cols.items.find({ category_id: c._id, available: true }).toArray());
  }
  const seen = new Set();
  const candidates = srcItems.filter(i => !seen.has(i._id) && seen.add(i._id));
  if (candidates.length > IMPORT_MAX) throw new HttpError(400, `Too many dishes at once (max ${IMPORT_MAX}). Choose fewer.`);
  const usable = candidates.filter(i => i.available && live.has(i.restaurant_id));

  // category names of the sources, and this restaurant's own categories (matched by name, case-insensitive)
  const srcCatName = new Map((await cols.categories.find({ _id: { $in: [...new Set(usable.map(i => i.category_id))] } }).toArray()).map(c => [c._id, c.name]));
  const mine = new Map((await cols.categories.find({ restaurant_id: rid }).toArray()).map(c => [c.name.toLowerCase(), c._id]));
  let nextSort = ((await cols.categories.find({ restaurant_id: rid }).sort({ sort: -1 }).limit(1).next())?.sort ?? 0) + 1;
  let addedCategories = 0;
  const ensureCategory = async name => {
    const key = name.toLowerCase();
    if (mine.has(key)) return mine.get(key);
    const id = await nextId('categories');
    await cols.categories.insertOne({ _id: id, restaurant_id: rid, name, sort: nextSort++ });
    mine.set(key, id); addedCategories++;
    return id;
  };
  for (const c of srcCatsOk) await ensureCategory(c.name); // selected categories are added even if no dish is copied

  const have = new Set((await cols.items.find({ restaurant_id: rid }).toArray()).map(i => `${i.category_id}|${i.name.toLowerCase()}`));
  let addedItems = 0;
  for (const i of usable) {
    const catId = await ensureCategory(srcCatName.get(i.category_id) || 'Menu');
    const key = `${catId}|${i.name.toLowerCase()}`;
    if (have.has(key)) continue;
    have.add(key);
    await cols.items.insertOne({
      _id: await nextId('items'), restaurant_id: rid, category_id: catId, name: i.name, description: i.description || '',
      price: i.price, image: copyImage(i.image), available: true, created_at: stamp(),
    });
    addedItems++;
  }
  const requested = new Set([...wantItems, ...usable.map(i => i._id)]).size;
  return { added_items: addedItems, skipped_items: Math.max(requested - addedItems, 0), added_categories: addedCategories };
}

// ---- public menu ----
async function getMenu(slug) {
  const r = await cols.restaurants.findOne({ slug: String(slug) });
  if (!r || !r.active || (r.plan_expires && r.plan_expires < today())) return null;
  const [cats, items] = await Promise.all([listCategories(r._id), cols.items.find({ restaurant_id: r._id, available: true }).sort({ _id: 1 }).toArray()]);
  const sections = cats
    .map(c => ({ ...c, items: items.filter(i => i.category_id === c.id).map(withId) }))
    .filter(c => c.items.length);
  return { restaurant: r, sections };
}

module.exports = {
  HttpError, generatePassword, saveImageData, publicUser, itemOut, restaurantOut,
  authenticate, changePassword, userIsActive,
  listRestaurants, getRestaurant, revealOwnerPassword, createRestaurant, updateRestaurant, resetOwnerPassword, deleteRestaurant,
  summary, updateProfile,
  listCategories, createCategory, renameCategory, deleteCategory,
  listItems, getItem, saveItem, setItemAvailable, deleteItem, getMenu,
  libraryCategories, libraryItems, importFromLibrary,
};
