// Shared helpers for the login, admin, dashboard and menu pages (talks to /api/v1 with the login cookie).
// ---- loading feedback: a progress bar while any request runs, a spinner on the button that was pressed ----
let inflight = 0, apiStarts = 0, barTimer;
const loadStart = () => { inflight++; apiStarts++; clearTimeout(barTimer); barTimer = setTimeout(() => document.documentElement.classList.add('is-loading'), 120); }; // short requests never flash the bar
const loadEnd = () => { inflight = Math.max(0, inflight - 1); if (!inflight) { clearTimeout(barTimer); document.documentElement.classList.remove('is-loading'); document.dispatchEvent(new Event('api-idle')); } };
document.body.insertAdjacentHTML('beforeend', '<div class="loadbar" aria-hidden="true"></div>');
// Any form submit: show a spinner on its button until the request(s) it started finish.
document.addEventListener('submit', (e) => {
  const btn = e.submitter || e.target.querySelector('button:not([type=button])');
  if (!btn || btn.classList.contains('btn-loading')) return;
  const before = apiStarts, timers = [];
  const done = () => { btn.classList.remove('btn-loading'); document.removeEventListener('api-idle', onIdle); timers.forEach(clearTimeout); };
  const onIdle = () => { if (apiStarts > before) done(); };
  btn.classList.add('btn-loading'); document.addEventListener('api-idle', onIdle);
  timers.push(setTimeout(() => { if (apiStarts === before) done(); }, 700), setTimeout(done, 30000)); // nothing was sent (e.g. a client-side check failed) / safety net
}, true);
// grey placeholder shapes shown while a screen's data is on its way
const skelRows = (n = 5) => Array.from({ length: n }, () => '<div class="skel skel-row"></div>').join('');
const skelCards = (n = 6) => Array.from({ length: n }, () => '<div class="skel skel-card"></div>').join('');
const skelStats = (n = 4) => Array.from({ length: n }, () => '<div class="skel skel-stat"></div>').join('');

function api(path, method = 'GET', body) { loadStart(); return rawApi(path, method, body).finally(loadEnd); }
async function rawApi(path, method = 'GET', body) {
  const res = await fetch(path, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // session ended (logged out elsewhere, or the restaurant was deactivated): go back to the login page
    if (res.status === 401 && !path.includes('/auth/session') && !path.includes('/public/')) location.href = '/login';
    const e = new Error(data.error || 'Request failed'); e.status = res.status; throw e;
  }
  return data;
}
const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// prices are rupees: 249.5 -> ₹249.50, 250 -> ₹250
const rupees = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: Number(n) % 1 ? 2 : 0, maximumFractionDigits: 2 });
const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');

function toast(msg) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 2600);
}
async function requireRole(role) {
  try { const { user } = await api('/api/v1/auth/me'); if (user.role !== role) throw new Error('role'); return user; }
  catch { location.href = '/login'; await new Promise(() => {}); }
}
async function logout() { try { await api('/api/v1/auth/session', 'DELETE'); } catch {} location.href = '/login'; }

function tabs(root, onChange) {
  const buttons = [...root.querySelectorAll('[data-tab]')];
  const show = (name) => {
    buttons.forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    const on = buttons.find((b) => b.dataset.tab === name);
    $('#pageTitle').textContent = on.dataset.title || on.textContent.trim(); $('#pageSub').textContent = on.dataset.sub || '';
    document.querySelectorAll('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== name));
    onChange?.(name);
  };
  buttons.forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
  show(buttons[0].dataset.tab);
  return show;
}
// sub tabs inside a section: <div class="subtabs"> with [data-subtab], panels [data-subpanel]
function subTabs() {
  document.querySelectorAll('.subtabs').forEach((bar) => bar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-subtab]'); if (!b) return;
    const section = bar.closest('section');
    section.querySelectorAll('[data-subtab]').forEach((x) => x.classList.toggle('on', x === b));
    section.querySelectorAll('[data-subpanel]').forEach((p) => p.classList.toggle('hidden', p.dataset.subpanel !== b.dataset.subtab));
  }));
}

// Generic popup. openModal({title, sub, html}) -> element; closeModal() removes it.
let modalEl = null;
function openModal({ title, sub = '', html, wide = false }) {
  closeModal();
  modalEl = document.createElement('div'); modalEl.className = 'modal'; modalEl.setAttribute('role', 'dialog'); modalEl.setAttribute('aria-modal', 'true');
  modalEl.innerHTML = `<div class="modal-box" style="${wide ? 'max-width:680px' : ''}"><div class="modal-head"><div><h3 style="margin:0">${esc(title)}</h3>${sub ? `<p class="small muted" style="margin:2px 0 0">${esc(sub)}</p>` : ''}</div><button class="ghost sm" data-close aria-label="Close">✕</button></div><div data-body>${html}</div></div>`;
  modalEl.addEventListener('click', (e) => { if (e.target === modalEl || e.target.closest('[data-close]')) closeModal(); });
  document.body.appendChild(modalEl); document.body.style.overflow = 'hidden';
  return modalEl;
}
function closeModal() { if (modalEl) { modalEl.remove(); modalEl = null; document.body.style.overflow = ''; } }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

function confirmDialog({ title, message, confirmText = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const el = document.createElement('div'); el.className = 'modal'; el.setAttribute('role', 'alertdialog');
    el.innerHTML = `<div class="modal-box confirm-box"><div class="confirm-ico ${danger ? 'danger' : ''}">${ico(danger ? 'trash' : 'check')}</div><h3>${esc(title)}</h3><p class="muted">${esc(message)}</p>
      <div class="confirm-actions"><button class="ghost" data-r="0">Cancel</button><button class="${danger ? 'danger-solid' : ''}" data-r="1">${esc(confirmText)}</button></div></div>`;
    const done = (v) => { document.removeEventListener('keydown', onKey); el.remove(); document.body.style.overflow = ''; resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') done(false); };
    el.addEventListener('click', (e) => { if (e.target === el) done(false); const b = e.target.closest('[data-r]'); if (b) done(b.dataset.r === '1'); });
    document.addEventListener('keydown', onKey); document.body.appendChild(el); document.body.style.overflow = 'hidden'; el.querySelector('[data-r="0"]').focus();
  });
}

// Resize an image file in the browser before upload so phone photos stay small. Returns a data URL.
function resizeImage(file, { max = 900, type = 'image/jpeg', quality = 0.82 } = {}) {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return reject(new Error('Choose a PNG, JPEG or WebP image'));
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      const g = c.getContext('2d'); if (type === 'image/jpeg') { g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); }
      g.drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); resolve(c.toDataURL(type, quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image')); };
    img.src = url;
  });
}
const copyText = async (t) => { try { await navigator.clipboard.writeText(t); toast('Copied'); } catch { toast('Copy failed'); } };
// Passwords for new owners: easy to read out (no 0/O/1/l/I)
const genPassword = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789', a = new Uint32Array(12); crypto.getRandomValues(a);
  return Array.from(a, (n) => chars[n % chars.length]).join('');
};

// Grid / list switch (two icon buttons). Remembers the choice on this device under `key`.
// apply('grid' | 'list') is called straight away and on every change.
function viewToggle(root, key, apply) {
  let mode = 'grid';
  try { mode = localStorage.getItem(key) === 'list' ? 'list' : 'grid'; } catch {}
  root.classList.add('vtoggle'); root.setAttribute('role', 'group'); root.setAttribute('aria-label', 'Layout');
  root.innerHTML = `<button type="button" data-layout="grid" aria-label="Grid view" title="Grid view">${ico('grid')}</button><button type="button" data-layout="list" aria-label="List view" title="List view">${ico('list')}</button>`;
  const set = (m) => {
    mode = m; try { localStorage.setItem(key, m); } catch {}
    root.querySelectorAll('button').forEach((b) => { const on = b.dataset.layout === m; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
    apply(m);
  };
  root.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => set(b.dataset.layout)));
  set(mode);
}

const ICONS = {
  menu: '<path d="M4 6h16M4 12h16M4 18h10"/>', tag: '<path d="M3 12V3h9l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.5"/>', list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h3M20 17v4"/>',
  store: '<path d="M3 9l1.5-5h15L21 9"/><path d="M4 9v11h16V9"/><path d="M9 20v-6h6v6"/>', plus: '<path d="M12 5v14M5 12h14"/>', key: '<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2L21 2M16 7l3 3M14 9l2 2"/>',
  logout: '<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/>', check: '<path d="M20 6L9 17l-5-5"/>', trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>', home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24M1 1l22 22"/>',
};
const ico = (n) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n]}</svg>`;
document.querySelectorAll('[data-ico]').forEach((el) => el.insertAdjacentHTML('afterbegin', ico(el.dataset.ico)));
