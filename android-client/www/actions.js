/* 0.2.4.16: one delegated listener replaces every inline on*="..." attribute, so the field app's CSP can forbid
   inline script ('unsafe-inline' gone from script-src). Markup names a global function and its arguments as data:
     <button data-act="navigateToMenu" data-args='["log"]'>          click (default)
     <input  data-act="filterLogRecords" data-on="input">            other event types
     "$this" in data-args is the element, "$event" the event; data-stop stops the event at this element.
   Like inline handlers, an inner action runs first and outer actions follow unless propagation was stopped. */
(function installJagaActions(root) {
  'use strict';
  const resolve = path => path.split('.').reduce((object, key) => (object == null ? undefined : object[key]), root);
  const owner = path => { const i = path.lastIndexOf('.'); return i < 0 ? root : resolve(path.slice(0, i)); };
  function run(el, event) {
    const name = el.getAttribute('data-act') || '';
    const fn = resolve(name);
    if (typeof fn !== 'function') {
      if (root.JagaErrorReport) root.JagaErrorReport.report('error', 'Aksi tidak dikenal: ' + name, 'actions.js', null);
      return;
    }
    let args = [];
    const raw = el.getAttribute('data-args');
    if (raw) { try { args = JSON.parse(raw); } catch (_) { args = []; } }
    args = args.map(arg => (arg === '$this' ? el : arg === '$event' ? event : arg));
    if (el.hasAttribute('data-stop')) event.stopPropagation();
    return fn.apply(owner(name), args);
  }
  for (const type of ['click', 'change', 'input']) {
    root.document.addEventListener(type, event => {
      let el = event.target && event.target.closest ? event.target.closest('[data-act]') : null;
      while (el) {
        if ((el.getAttribute('data-on') || 'click') === type && !el.disabled) run(el, event);
        if (event.cancelBubble) break;
        el = el.parentElement ? el.parentElement.closest('[data-act]') : null;
      }
    });
  }
  root.JagaActions = { run, resolve };

  /* Named extension points (0.2.4.16, audit F10). workflow-ui.js used to re-assign app.js functions to add its
     own steps; now the owning function runs a hook and later scripts register for it. Order is registration order. */
  const hooks = Object.create(null);
  root.JagaHooks = {
    on(name, fn) { (hooks[name] || (hooks[name] = [])).push(fn); },
    run(name, ...args) { for (const fn of hooks[name] || []) fn(...args); },
    async runAsync(name, ...args) { for (const fn of hooks[name] || []) await fn(...args); },
  };
})(window);
