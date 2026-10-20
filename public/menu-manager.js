// Menu editor for the admin console ("Manage menu"): categories, dishes and photos for one restaurant.
// MenuManager.mount(container, { base, themeColor, onChange }) draws into `container` and talks to `base`
// (e.g. /api/v1/admin/restaurants/2). Needs app.js (api, $, esc, rupees, toast, openModal, closeModal, confirmDialog, resizeImage, ico).
window.MenuManager = (() => {
  function mount(el, { base, themeColor = '#d9480f', onChange } = {}) {
    let categories = [], items = [];
    const q = (s, root = el) => root.querySelector(s);
    el.innerHTML = `
      <div class="stats" data-stats>${skelStats(4)}</div>
      <div class="toolbar">
        <div class="filters"><input type="search" data-q placeholder="Search items…" aria-label="Search items"><select data-cat aria-label="Filter by category"><option value="">All categories</option></select></div>
        <div class="actions"><div data-view></div><button class="ghost" data-cats>${ico('tag')} Categories</button><button class="ghost" data-library>${ico('store')} Add menu</button><button data-add>${ico('plus')} Add item</button></div>
      </div>
      <div class="items" data-list>${skelCards(4)}</div>`;

    const thumb = (img, name) => img ? `<img src="${esc(img)}" alt="" loading="lazy">` : esc((name || '?').trim().charAt(0).toUpperCase());

    function paint() {
      const on = items.filter((i) => i.available).length;
      q('[data-stats]').innerHTML = [['Total items', items.length, 'hl big'], ['Available', on], ['Hidden', items.length - on], ['Categories', categories.length]]
        .map(([l, v, c]) => `<div class="stat ${c || ''}"><span>${l}</span><b>${v}</b></div>`).join('');
      const cur = q('[data-cat]').value;
      q('[data-cat]').innerHTML = '<option value="">All categories</option>' + categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
      q('[data-cat]').value = cur;

      const term = q('[data-q]').value.trim().toLowerCase(), cat = q('[data-cat]').value;
      const rows = items.filter((i) => (!cat || String(i.category_id) === cat) && (!term || i.name.toLowerCase().includes(term) || i.description.toLowerCase().includes(term)));
      q('[data-list]').innerHTML = rows.length ? rows.map((i) => `<div class="item ${i.available ? '' : 'off'}" style="--tc:${esc(themeColor)}">
        <div class="thumb">${thumb(i.image, i.name)}</div>
        <div class="item-body"><div class="nm">${esc(i.name)}</div><div><span class="pill">${esc(i.category)}</span> ${i.available ? '' : '<span class="pill warn">Hidden</span>'}</div>
          <div class="ds">${esc(i.description)}</div><div class="price">${rupees(i.price)}</div>
          <div class="item-foot"><button class="sm ghost" data-act="edit" data-id="${i.id}">Edit</button><button class="sm ghost" data-act="toggle" data-id="${i.id}">${i.available ? 'Hide' : 'Show'}</button><button class="sm danger" data-act="del" data-id="${i.id}">Delete</button></div></div></div>`).join('')
        : `<div class="card empty" style="grid-column:1/-1">${items.length ? 'No items match your search.' : 'No items yet. Click “Add item” to create the first dish.'}</div>`;
    }
    async function reload() {
      q('[data-list]').classList.add('is-busy');
      try {
        const [c, i] = await Promise.all([api(`${base}/categories`), api(`${base}/items`)]);
        categories = c.categories; items = i.items; paint();
      } finally { q('[data-list]').classList.remove('is-busy'); }
    }
    const changed = async () => { await reload(); onChange?.(); };

    // ---------- add / edit a dish ----------
    function itemModal(item) {
      if (!categories.length) { toast('Create a category first'); categoriesModal(); return; }
      let image, removeImg = false;
      const m = openModal({ title: item ? 'Edit item' : 'Add item', wide: true, html: `
        <form data-itemform>
          <div class="img-pick"><div class="thumb" data-prev style="--tc:${esc(themeColor)}">${thumb(item?.image, item?.name || '?')}</div>
            <div><input type="file" data-file accept="image/png,image/jpeg,image/webp"><button type="button" class="ghost sm" data-rm style="margin-top:8px">Remove image</button><div class="small muted" style="margin-top:6px">Photos are resized automatically.</div></div></div>
          <label>Item name</label><input name="name" required maxlength="80" value="${esc(item?.name || '')}">
          <div class="row">
            <div><label>Price (₹)</label><input name="price" type="number" min="0" step="0.01" inputmode="decimal" required value="${item ? item.price : ''}"></div>
            <div><label>Category</label><select name="category_id" required>${categories.map((c) => `<option value="${c.id}" ${item?.category_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
          </div>
          <label>Description</label><textarea name="description" maxlength="300" placeholder="What is in it? Any note for guests?">${esc(item?.description || '')}</textarea>
          <label class="check"><input type="checkbox" name="available" ${!item || item.available ? 'checked' : ''}> Show this item on the menu</label>
          <div class="err" data-err role="alert"></div>
          <div class="card-foot"><button type="button" class="ghost" data-close>Cancel</button><button data-save>${item ? 'Save changes' : 'Add item'}</button></div>
        </form>` });
      const prev = q('[data-prev]', m);
      q('[data-file]', m).addEventListener('change', async (e) => {
        const f = e.target.files[0]; if (!f) return;
        try { image = await resizeImage(f); removeImg = false; prev.innerHTML = `<img src="${image}" alt="">`; } catch (er) { q('[data-err]', m).textContent = er.message; }
      });
      q('[data-rm]', m).addEventListener('click', () => { image = undefined; removeImg = true; prev.textContent = (q('[name=name]', m).value || '?').trim().charAt(0).toUpperCase(); q('[data-file]', m).value = ''; });
      q('[data-itemform]', m).addEventListener('submit', async (e) => {
        e.preventDefault(); q('[data-err]', m).textContent = ''; q('[data-save]', m).disabled = true;
        const f = e.target.elements;
        const body = { name: f.name.value, price: f.price.value, category_id: f.category_id.value, description: f.description.value, available: f.available.checked, image, remove_image: removeImg };
        try { await api(item ? `${base}/items/${item.id}` : `${base}/items`, item ? 'PUT' : 'POST', body); closeModal(); toast(item ? 'Item saved' : 'Item added'); await changed(); }
        catch (er) { q('[data-err]', m).textContent = er.message; q('[data-save]', m).disabled = false; }
      });
    }

    // ---------- categories (add, rename, delete) ----------
    function categoriesModal() {
      const m = openModal({ title: 'Categories', sub: 'Group the dishes, for example Starters or Drinks.', html: `
        <form data-catform class="actions"><input name="name" placeholder="New category, e.g. Starters" maxlength="40" required style="flex:1;min-width:180px" aria-label="Category name"><button>Add</button></form>
        <div class="err" data-err role="alert"></div><div data-catlist style="margin-top:6px"></div>
        <div class="card-foot"><button type="button" class="ghost" data-close>Done</button></div>` });
      const list = q('[data-catlist]', m);
      const draw = () => {
        list.innerHTML = categories.length ? `<table><thead><tr><th>Category</th><th>Items</th><th></th></tr></thead><tbody>${categories.map((c) => `<tr><td><b>${esc(c.name)}</b></td><td>${c.items}</td>
          <td><div class="actions"><button class="sm ghost" data-catren="${c.id}">Rename</button><button class="sm danger" data-catdel="${c.id}">Delete</button></div></td></tr>`).join('')}</tbody></table>`
          : '<p class="empty">No categories yet. Add the first one above.</p>';
      };
      draw();
      q('[data-catform]', m).addEventListener('submit', async (e) => {
        e.preventDefault(); q('[data-err]', m).textContent = '';
        try { await api(`${base}/categories`, 'POST', { name: e.target.elements.name.value }); e.target.reset(); await changed(); draw(); toast('Category added'); }
        catch (er) { q('[data-err]', m).textContent = er.message; }
      });
      list.addEventListener('click', async (e) => {
        const ren = e.target.closest('[data-catren]'), del = e.target.closest('[data-catdel]');
        try {
          if (ren) {
            const c = categories.find((x) => x.id == ren.dataset.catren);
            const r = openModal({ title: 'Rename category', html: `<form data-renform><label style="margin-top:0">Name</label><input name="name" value="${esc(c.name)}" maxlength="40" required><div class="err" data-err role="alert"></div><div class="card-foot"><button type="button" class="ghost" data-close>Cancel</button><button>Save</button></div></form>` });
            q('[data-renform]', r).addEventListener('submit', async (ev) => {
              ev.preventDefault();
              try { await api(`${base}/categories/${c.id}`, 'PUT', { name: ev.target.elements.name.value }); await changed(); closeModal(); categoriesModal(); toast('Category renamed'); }
              catch (er) { q('[data-err]', r).textContent = er.message; }
            });
          } else if (del) {
            const c = categories.find((x) => x.id == del.dataset.catdel);
            if (await confirmDialog({ title: `Delete ${c.name}?`, message: 'The category will be removed. A category that still has items cannot be deleted.', confirmText: 'Delete category', danger: true })) {
              await api(`${base}/categories/${c.id}`, 'DELETE'); await changed(); draw(); toast('Category deleted');
            }
          }
        } catch (er) { toast(er.message); }
      });
    }

    // ---------- wiring ----------
    ['input', 'change'].forEach((ev) => { q('[data-q]').addEventListener(ev, paint); q('[data-cat]').addEventListener(ev, paint); });
    q('[data-add]').addEventListener('click', () => itemModal(null));
    q('[data-cats]').addEventListener('click', categoriesModal);
    q('[data-library]').addEventListener('click', () => (window.MenuLibrary ? MenuLibrary.open({ base, onDone: changed }) : toast('Please refresh the page and try again')));
    q('[data-list]').addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      const i = items.find((x) => x.id == b.dataset.id);
      try {
        if (b.dataset.act === 'edit') itemModal(i);
        else if (b.dataset.act === 'toggle') { await api(`${base}/items/${i.id}/availability`, 'PATCH', { available: !i.available }); await changed(); toast(i.available ? 'Item hidden from menu' : 'Item is visible again'); }
        else if (await confirmDialog({ title: 'Delete this item?', message: `"${i.name}" will be removed from the menu. This can't be undone.`, confirmText: 'Delete item', danger: true })) { await api(`${base}/items/${i.id}`, 'DELETE'); await changed(); toast('Item deleted'); }
      } catch (er) { toast(er.message); }
    });

    const loaded = reload().then(() => ({ reload })); // load the menu first: nothing below may be able to block it
    // grid/list switch (same saved preference as the restaurant dashboard); optional, so a stale cached app.js can't break the editor
    if (typeof viewToggle === 'function') viewToggle(q('[data-view]'), 'dm_view_items', (m) => q('[data-list]').classList.toggle('as-list', m === 'list'));
    return loaded;
  }
  return { mount };
})();
