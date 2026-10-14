// Themed confirmation popup. Any <form data-confirm="Title"> asks first.
// Optional: data-confirm-text, data-confirm-ok (button label), data-confirm-tone="danger"|"brand" (default brand).
(function () {
  let modal, okBtn, cancelBtn, pending, opener;

  function build() {
    modal = document.createElement('div');
    modal.className = 'modal';
    modal.hidden = true;
    modal.innerHTML =
      '<div class="modal-back" data-close></div>' +
      '<div class="modal-card" role="alertdialog" aria-modal="true" aria-labelledby="modal-title" aria-describedby="modal-text">' +
      '<div class="modal-icon" id="modal-icon" aria-hidden="true"></div>' +
      '<h3 id="modal-title"></h3><p id="modal-text"></p>' +
      '<div class="modal-actions"><button type="button" class="ghost" data-close>Cancel</button>' +
      '<button type="button" id="modal-ok"></button></div></div>';
    document.body.appendChild(modal);
    okBtn = modal.querySelector('#modal-ok');
    cancelBtn = modal.querySelector('.modal-actions .ghost');
    modal.addEventListener('click', e => { if (e.target.closest('[data-close]')) close(); });
    okBtn.addEventListener('click', () => { const f = pending; close(false); f.dataset.confirmed = '1'; f.submit(); });
    document.addEventListener('keydown', e => {
      if (modal.hidden) return;
      if (e.key === 'Escape') close();
      if (e.key === 'Tab') { // keep focus inside the dialog
        const els = [cancelBtn, okBtn], i = els.indexOf(document.activeElement);
        e.preventDefault();
        els[(i + (e.shiftKey ? -1 : 1) + els.length) % els.length].focus();
      }
    });
  }

  function open(form) {
    if (!modal) build();
    pending = form;
    opener = document.activeElement;
    const d = form.dataset, danger = d.confirmTone === 'danger';
    modal.querySelector('#modal-title').textContent = d.confirm;
    modal.querySelector('#modal-text').textContent = d.confirmText || '';
    modal.querySelector('#modal-icon').textContent = danger ? '!' : '?';
    modal.querySelector('#modal-icon').className = 'modal-icon ' + (danger ? 'danger' : '');
    okBtn.textContent = d.confirmOk || 'Confirm';
    okBtn.className = danger ? 'danger-solid' : '';
    modal.hidden = false;
    document.body.classList.add('modal-open');
    cancelBtn.focus();
  }

  function close(restoreFocus = true) {
    modal.hidden = true;
    document.body.classList.remove('modal-open');
    if (restoreFocus && opener) opener.focus();
    pending = null;
  }

  document.addEventListener('submit', e => {
    const f = e.target;
    if (!f.dataset || !f.dataset.confirm || f.dataset.confirmed) return;
    e.preventDefault();
    open(f);
  });
})();
