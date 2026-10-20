// "Add menu" popup: browse what other restaurants publish (search, category and restaurant filters) and copy
// dishes or whole categories into this restaurant's menu. Used by the restaurant dashboard and the admin's Manage menu.
// MenuLibrary.open({ base, onDone }): base is '/api/v1' (owner) or '/api/v1/admin/restaurants/:id' (admin).
// Needs app.js (api, esc, rupees, toast, openModal, closeModal).
window.MenuLibrary = (() => {
  function open({ base, onDone } = {}) {
    const dishes = new Map(), categories = new Map(); // selected: dish id -> dish, category id -> category
    let rows = [], total = 0, catalog = [], timer;
    const filter = { q: '', category: '', restaurant_id: '' };

    const m = openModal({ title: 'Add menu', sub: 'Copy dishes or whole categories from other restaurants into this menu. Photos are copied too.', wide: true, html: `
      <div class="subtabs" style="margin-bottom:12px"><button type="button" data-t="items" class="on">Dishes</button><button type="button" data-t="cats">Categories</button></div>
      <div data-p="items">
        <div class="filters lib-filters"><input type="search" data-q placeholder="Search dishes from all restaurants…" aria-label="Search dishes"><select data-rest aria-label="Restaurant"><option value="">All restaurants</option></select></div>
        <div class="lib-chips" data-chips></div>
        <div class="lib-list" data-list>${skelRows(5)}</div>
        <div class="actions" style="justify-content:center;margin-top:10px"><button type="button" class="ghost sm hidden" data-more>Load more</button></div>
      </div>
      <div data-p="cats" class="hidden">
        <label class="check" style="margin-top:0"><input type="checkbox" data-with checked> Also add all the dishes in the categories I select</label>
        <div class="lib-list" data-catlist style="margin-top:10px">${skelRows(4)}</div>
      </div>
      <div class="err" data-err role="alert"></div>
      <div class="card-foot lib-foot"><span class="muted small" data-count></span><button type="button" class="ghost" data-close>Cancel</button><button type="button" data-add disabled>Add selected</button></div>` });
    m.querySelector('.modal-box').style.maxWidth = '780px';
    const q = (s) => m.querySelector(s);

    const letter = (n) => esc((n || '?').trim().charAt(0).toUpperCase());
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    function counter() {
      const a = dishes.size, b = categories.size;
      q('[data-count]').textContent = [a && plural(a, 'dish', 'dishes'), b && plural(b, 'category', 'categories')].filter(Boolean).join(' · ') || 'Nothing selected yet';
      q('[data-add]').disabled = !(a || b);
    }

    // ---- filters built from the catalogue ----
    function drawFilters() {
      const byName = new Map(), rests = new Map();
      for (const c of catalog) {
        const k = c.name.toLowerCase(), e = byName.get(k) || { name: c.name, n: 0 };
        e.n += c.items; byName.set(k, e); rests.set(c.restaurant_id, c.restaurant);
      }
      q('[data-chips]').innerHTML = `<button type="button" class="lib-chip ${filter.category ? '' : 'on'}" data-c="">All</button>` +
        [...byName.values()].map((e) => `<button type="button" class="lib-chip ${filter.category.toLowerCase() === e.name.toLowerCase() ? 'on' : ''}" data-c="${esc(e.name)}">${esc(e.name)} <span class="muted">${e.n}</span></button>`).join('');
      q('[data-rest]').innerHTML = '<option value="">All restaurants</option>' + [...rests].sort((a, b) => a[1].localeCompare(b[1])).map(([id, n]) => `<option value="${id}" ${String(id) === filter.restaurant_id ? 'selected' : ''}>${esc(n)}</option>`).join('');
    }

    // ---- dishes ----
    function drawDishes() {
      q('[data-list]').innerHTML = rows.length ? rows.map((d) => `<label class="lib-row ${dishes.has(d.id) ? 'sel' : ''}">
        <input type="checkbox" data-id="${d.id}" ${dishes.has(d.id) ? 'checked' : ''}>
        <div class="lib-thumb">${d.image ? `<img src="${esc(d.image)}" alt="" loading="lazy">` : letter(d.name)}</div>
        <div class="lib-main"><b>${esc(d.name)}</b><div class="muted small">${esc(d.restaurant)} · ${esc(d.category)}</div>${d.description ? `<div class="muted small ds">${esc(d.description)}</div>` : ''}</div>
        <div class="lib-price">${rupees(d.price)}</div></label>`).join('')
        : `<p class="empty">${catalog.length ? 'No dishes match your search.' : 'No other restaurant has a published menu yet.'}</p>`;
      q('[data-more]').classList.toggle('hidden', rows.length >= total);
    }
    async function loadDishes(append = false) {
      const p = new URLSearchParams({ limit: 30, offset: append ? rows.length : 0 });
      for (const k of ['q', 'category', 'restaurant_id']) if (filter[k]) p.set(k, filter[k]);
      q('[data-list]').classList.add('is-busy');
      try {
        const r = await api(`${base}/library/items?${p}`);
        rows = append ? rows.concat(r.items) : r.items; total = r.total; drawDishes();
      } catch (er) { q('[data-err]').textContent = er.message; }
      finally { q('[data-list]').classList.remove('is-busy'); }
    }

    // ---- categories ----
    function drawCats() {
      q('[data-catlist]').innerHTML = catalog.length ? catalog.map((c) => `<label class="lib-row cat ${categories.has(c.category_id) ? 'sel' : ''}">
        <input type="checkbox" data-cid="${c.category_id}" ${categories.has(c.category_id) ? 'checked' : ''}>
        <div class="lib-main"><b>${esc(c.name)}</b><div class="muted small">from ${esc(c.restaurant)}</div></div>
        <div class="muted small">${plural(c.items, 'dish', 'dishes')}</div></label>`).join('')
        : '<p class="empty">No other restaurant has a published menu yet.</p>';
    }

    // ---- wiring ----
    m.addEventListener('click', (e) => {
      const t = e.target.closest('[data-t]');
      if (t) {
        m.querySelectorAll('[data-t]').forEach((b) => b.classList.toggle('on', b === t));
        q('[data-p=items]').classList.toggle('hidden', t.dataset.t !== 'items'); q('[data-p=cats]').classList.toggle('hidden', t.dataset.t !== 'cats');
      }
      const chip = e.target.closest('[data-c]');
      if (chip) { filter.category = chip.dataset.c; drawFilters(); loadDishes(); }
    });
    q('[data-q]').addEventListener('input', (e) => { filter.q = e.target.value.trim(); clearTimeout(timer); timer = setTimeout(() => loadDishes(), 250); });
    q('[data-rest]').addEventListener('change', (e) => { filter.restaurant_id = e.target.value; loadDishes(); });
    q('[data-more]').addEventListener('click', () => loadDishes(true));
    q('[data-list]').addEventListener('change', (e) => {
      const cb = e.target.closest('[data-id]'); if (!cb) return;
      const d = rows.find((x) => x.id == cb.dataset.id);
      cb.checked ? dishes.set(d.id, d) : dishes.delete(d.id);
      cb.closest('.lib-row').classList.toggle('sel', cb.checked); counter();
    });
    q('[data-catlist]').addEventListener('change', (e) => {
      const cb = e.target.closest('[data-cid]'); if (!cb) return;
      const id = Number(cb.dataset.cid);
      cb.checked ? categories.set(id, catalog.find((c) => c.category_id === id)) : categories.delete(id);
      cb.closest('.lib-row').classList.toggle('sel', cb.checked); counter();
    });
    q('[data-add]').addEventListener('click', async () => {
      q('[data-err]').textContent = ''; q('[data-add]').disabled = true;
      try {
        const withItems = q('[data-with]').checked;
        const r = await api(`${base}/library/import`, 'POST', { items: [...dishes.keys()], categories: [...categories.keys()].map((category_id) => ({ category_id, with_items: withItems })) });
        closeModal();
        toast([`Added ${plural(r.added_items, 'dish', 'dishes')}`, r.added_categories && `${plural(r.added_categories, 'new category', 'new categories')}`, r.skipped_items && `${r.skipped_items} skipped (already in this menu)`].filter(Boolean).join(', '));
        await onDone?.();
      } catch (er) { q('[data-err]').textContent = er.message; q('[data-add]').disabled = false; }
    });

    counter();
    api(`${base}/library/categories`).then((r) => { catalog = r.categories; drawFilters(); drawCats(); return loadDishes(); })
      .catch((er) => { q('[data-list]').innerHTML = `<p class="err">${esc(er.message)}</p>`; });
  }
  return { open };
})();
