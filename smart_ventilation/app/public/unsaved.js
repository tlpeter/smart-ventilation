'use strict';

// Unsaved changes guard. The same file is used by Smart Charging Planner,
// Smart Heating Planner and Smart Ventilation; keep the copies the same.
//
// What it does:
// - It notices when you change a setting (typing, ticking, choosing).
// - While there are unsaved changes, an orange bar shows Save and Discard.
// - Leaving the page (another tab, another charger, …) first asks:
//   save, discard or stay.
// - A change only counts as saved when the app's server said so. When saving
//   fails, the bar stays and shows why.
//
// How an app uses it:
//   unsavedGuard.init({
//     nav: '#main-nav .tab, …',            // buttons that leave the page
//     scope: (el) => true/false,           // which forms count (default all)
//   });
//   - Forms are tracked by themselves. Saving = submitting the form.
//   - A part that is not a form gets data-guard="Name" and its save button
//     data-guard-save. Saving = clicking that button.
//   - The app's api() calls unsavedGuard.writeDone(true) after a write that
//     worked and unsavedGuard.writeDone(false, message) after one that failed.
//   - Something with its own "dirty" state (a draft) is added with
//     unsavedGuard.addSource({ name, root, isDirty, save, discard }).
//   - unsavedGuard.isDirty(element) tells an automatic refresh to wait.
//   - unsavedGuard.markDirty(element) marks a change made with a button.
//   - init({ onDiscard(group) }) puts a group back after Discard (a form is
//     reset by itself first).

(function () {
  const dirty = new Map(); // element -> { error }
  const sources = [];
  let opts = { nav: '', scope: () => true };
  let pending = null; // { groups, timer } while a save is on its way
  let afterSave = null; // a navigation that waits for the save
  let bypass = false;
  let bar = null;
  let dialog = null;

  // ------------------------------------------------------------------ look
  const CSS = `
    .ug-bar { position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%); z-index: 1000;
      width: min(760px, calc(100% - 24px)); display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
      padding: 10px 12px 10px 16px; border-radius: 16px; background: #c9781b; color: #fff;
      box-shadow: 0 6px 24px rgba(0,0,0,.25); font: inherit; font-size: 14px; }
    .ug-bar[hidden], .ug-overlay[hidden], .ug-bar .ug-err[hidden] { display: none !important; }
    body.ug-room { padding-bottom: 96px; }
    .ug-bar .ug-text { flex: 1; min-width: 160px; }
    .ug-bar .ug-text b { display: block; }
    .ug-bar .ug-err { display: block; margin-top: 2px; font-size: 13px; background: rgba(0,0,0,.18); padding: 4px 8px; border-radius: 8px; }
    .ug-btn { font: inherit; font-size: 14px; border: 0; border-radius: 999px; padding: 8px 16px; cursor: pointer; }
    .ug-btn.ug-save { background: #fff; color: #7a4508; font-weight: 600; }
    .ug-btn.ug-discard { background: rgba(255,255,255,.18); color: #fff; }
    .ug-btn.ug-stay { background: transparent; color: inherit; text-decoration: underline; }
    .ug-overlay { position: fixed; inset: 0; z-index: 1001; background: rgba(0,0,0,.45);
      display: flex; align-items: center; justify-content: center; padding: 16px; }
    .ug-dialog { background: var(--card, #fff); color: var(--text, #222); border-radius: 18px; padding: 20px;
      width: min(420px, 100%); box-shadow: 0 12px 40px rgba(0,0,0,.3); font: inherit; }
    .ug-dialog h3 { margin: 0 0 8px; font-size: 17px; }
    .ug-dialog p { margin: 0 0 16px; font-size: 14px; }
    .ug-dialog .ug-row { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    .ug-dialog .ug-save { background: #c9781b; color: #fff; }
    .ug-dialog .ug-discard { background: rgba(127,127,127,.18); color: inherit; }
  `;

  function build() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    bar = document.createElement('div');
    bar.className = 'ug-bar';
    bar.hidden = true;
    bar.setAttribute('role', 'status');
    bar.innerHTML = '<div class="ug-text"><b>Unsaved changes</b><span class="ug-where"></span><span class="ug-err" hidden></span></div>'
      + '<button type="button" class="ug-btn ug-discard">Discard</button><button type="button" class="ug-btn ug-save">Save</button>';
    document.body.appendChild(bar);
    bar.querySelector('.ug-save').addEventListener('click', () => saveVisible());
    bar.querySelector('.ug-discard').addEventListener('click', () => { discardVisible(); update(); });
    dialog = document.createElement('div');
    dialog.className = 'ug-overlay';
    dialog.hidden = true;
    dialog.innerHTML = '<div class="ug-dialog" role="dialog" aria-modal="true"><h3>Unsaved changes</h3><p class="ug-msg"></p>'
      + '<div class="ug-row"><button type="button" class="ug-btn ug-stay">Stay</button><button type="button" class="ug-btn ug-discard">Discard</button><button type="button" class="ug-btn ug-save">Save</button></div></div>';
    document.body.appendChild(dialog);
  }

  // ------------------------------------------------------------- tracking
  function visible(el) {
    if (!el || !el.isConnected) return false;
    for (let x = el; x; x = x.parentElement) {
      if (x.hidden || (x.classList && x.classList.contains('hidden'))) return false;
    }
    return true;
  }

  function groupOf(target) {
    if (!target || !target.closest || target.closest('[data-guard-ignore]')) return null;
    const g = target.closest('[data-guard]');
    if (g) return g;
    const f = target.closest('form');
    if (f && !f.hasAttribute('data-guard-off') && opts.scope(f)) return f;
    return null;
  }

  function nameOf(g) {
    if (g.dataset && g.dataset.guard) return g.dataset.guard;
    const h = g.querySelector('h2, h3, legend');
    return h ? h.textContent.trim() : '';
  }

  function onEdit(e) {
    if (!e.isTrusted || bypass) return;
    const t = e.target;
    if (!t || !('value' in t) || t.type === 'button' || t.type === 'submit' || t.type === 'file') return;
    const g = groupOf(t);
    if (!g) return;
    dirty.set(g, { error: null });
    update();
  }

  // Groups with unsaved changes. visibleOnly: only on the page shown now.
  function dirtyGroups(visibleOnly) {
    for (const g of [...dirty.keys()]) if (!g.isConnected) dirty.delete(g);
    return [...dirty.keys()].filter((g) => !visibleOnly || visible(g));
  }

  function dirtySources(visibleOnly) {
    return sources.filter((s) => {
      try { return s.isDirty() && (!visibleOnly || visible(s.root())); } catch { return false; }
    });
  }

  function anyVisible() {
    return dirtyGroups(true).length > 0 || dirtySources(true).length > 0;
  }

  function update() {
    if (!bar) return;
    const groups = dirtyGroups(true);
    const own = dirtySources(true).filter((s) => s.bar !== false);
    const show = groups.length > 0 || own.length > 0;
    bar.hidden = !show;
    // Room at the bottom, so the bar does not hide the end of the page.
    document.body.classList.toggle('ug-room', show);
    if (!show) return;
    const names = [...groups.map(nameOf), ...own.map((s) => s.name || '')].filter(Boolean);
    bar.querySelector('.ug-where').textContent = names.length ? names.join(', ') : '';
    const err = groups.map((g) => dirty.get(g).error).find(Boolean);
    const e = bar.querySelector('.ug-err');
    e.hidden = !err;
    e.textContent = err ? `Not saved: ${err}` : '';
    bar.querySelector('.ug-save').disabled = !!pending;
    bar.querySelector('.ug-save').textContent = pending ? 'Saving…' : 'Save';
  }

  // --------------------------------------------------------------- saving
  function saveGroup(g) {
    if (g.tagName === 'FORM') {
      if (typeof g.requestSubmit === 'function') g.requestSubmit();
      else g.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    } else {
      const btn = g.querySelector('[data-guard-save]') || document.querySelector(g.dataset.guardSaveButton || '#none');
      if (btn) btn.click();
    }
  }

  function startPending(groups) {
    if (pending) clearTimeout(pending.timer);
    // No answer from the server within 20 s: give up waiting, keep them dirty.
    pending = { groups: new Set(groups), timer: setTimeout(() => { pending = null; update(); }, 20000) };
    update();
  }

  // Called by the app's api() after every write.
  // A source (addSource) calls it too, after its own save finished.
  function writeDone(ok, message) {
    if (pending) {
      clearTimeout(pending.timer);
      const groups = pending.groups;
      pending = null;
      for (const g of groups) {
        if (ok) dirty.delete(g);
        else if (dirty.has(g)) dirty.set(g, { error: message || 'saving failed' });
      }
    }
    update();
    if (!afterSave) return;
    if (!ok) { afterSave = null; return; }
    if (!anyVisible()) { const go = afterSave; afterSave = null; go(); }
  }

  function saveVisible() {
    const groups = dirtyGroups(true);
    if (groups.length) {
      startPending(groups);
      groups.forEach(saveGroup);
    }
    for (const s of dirtySources(true)) s.save();
  }

  function discardVisible() {
    bypass = true;
    try {
      for (const g of dirtyGroups(true)) {
        if (g.tagName === 'FORM') g.reset();
        if (typeof opts.onDiscard === 'function') opts.onDiscard(g);
        dirty.delete(g);
      }
      for (const s of dirtySources(true)) s.discard();
    } finally {
      bypass = false;
    }
  }

  // Saving by hand (the form's own Save button) also waits for the answer.
  function onSubmit(e) {
    const g = groupOf(e.target);
    if (g && dirty.has(g)) startPending([g]);
  }

  function onClick(e) {
    const saveBtn = e.target.closest && e.target.closest('[data-guard-save]');
    if (saveBtn) {
      const g = saveBtn.closest('[data-guard]');
      if (g && dirty.has(g)) startPending([g]);
      return;
    }
    if (!opts.nav || bypass) return;
    const nav = e.target.closest && e.target.closest(opts.nav);
    if (!nav || nav.classList.contains('active') || nav.getAttribute('aria-selected') === 'true') return;
    if (!anyVisible()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    ask(() => { bypass = true; try { nav.click(); } finally { bypass = false; } update(); });
  }

  function ask(go) {
    const names = [...dirtyGroups(true).map(nameOf), ...dirtySources(true).map((s) => s.name || '')].filter(Boolean);
    dialog.querySelector('.ug-msg').textContent = `You changed ${names.length ? names.join(', ') : 'settings'} on this page without saving.`;
    dialog.hidden = false;
    const close = () => { dialog.hidden = true; };
    dialog.querySelector('.ug-stay').onclick = () => { close(); afterSave = null; };
    dialog.querySelector('.ug-discard').onclick = () => { close(); discardVisible(); go(); };
    dialog.querySelector('.ug-save').onclick = () => { close(); afterSave = go; saveVisible(); };
    dialog.querySelector('.ug-save').focus();
  }

  // ----------------------------------------------------------------- start
  function init(o) {
    opts = { ...opts, ...(o || {}) };
    if (!bar) build();
    document.addEventListener('input', onEdit, true);
    document.addEventListener('change', onEdit, true);
    document.addEventListener('submit', onSubmit, true);
    document.addEventListener('click', onClick, true);
    window.addEventListener('beforeunload', (e) => {
      if (dirtyGroups(false).length || dirtySources(false).length) { e.preventDefault(); e.returnValue = ''; }
    });
    // Pages are shown and hidden by the app: check the bar now and then.
    setInterval(update, 1000);
  }

  function addSource(s) { sources.push({ root: () => document.body, ...s }); update(); }

  // True when something inside root (or anywhere) has unsaved changes.
  function isDirty(root) {
    const inRoot = (el) => !root || root.contains(el);
    return dirtyGroups(false).some(inRoot) || dirtySources(false).some((s) => inRoot(s.root()));
  }

  function markSaved(el) { dirty.delete(el); update(); }

  // For changes made with a button (add a row, copy a day, …): mark the
  // group of that element as changed.
  function markDirty(el) {
    const g = el && (el.closest('[data-guard]') || el.closest('form'));
    if (g) { dirty.set(g, { error: null }); update(); }
  }

  window.unsavedGuard = { init, writeDone, isDirty, addSource, markSaved, markDirty, update };
})();
