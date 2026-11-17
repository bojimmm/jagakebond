/* Small compatibility shims for older Android WebViews. Loaded before every other app script.
   Minimum supported engine: Chrome / Android System WebView 80 (the app uses `?.` and `??`, which cannot be
   polyfilled). Between 80 and 103 the missing built-ins below are what used to hang the login screen. */
(function installPolyfills(root) {
  'use strict';
  function define(target, name, value) {
    try { Object.defineProperty(target, name, { value, configurable: true, writable: true }); }
    catch (_) { /* frozen host object: nothing to do */ }
  }
  if (typeof Object.hasOwn !== 'function') {
    define(Object, 'hasOwn', function hasOwn(object, key) { return Object.prototype.hasOwnProperty.call(object, key); });
  }
  function at(index) {
    const length = this.length >>> 0;
    let n = Math.trunc(Number(index)) || 0;
    if (n < 0) n += length;
    return n < 0 || n >= length ? undefined : this[n];
  }
  if (!Array.prototype.at) define(Array.prototype, 'at', at);
  if (!String.prototype.at) define(String.prototype, 'at', at);
  if (typeof Uint8Array !== 'undefined' && !Uint8Array.prototype.at) define(Uint8Array.prototype, 'at', at);
  if (!root.crypto) { try { root.crypto = {}; } catch (_) { /* read-only window.crypto: leave it */ } }
  if (root.crypto && typeof root.crypto.randomUUID !== 'function') {
    define(root.crypto, 'randomUUID', function randomUUID() {
      const bytes = new Uint8Array(16);
      if (typeof root.crypto.getRandomValues === 'function') root.crypto.getRandomValues(bytes);
      else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
      return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
    });
  }
  if (typeof root.AbortController === 'function' && root.AbortSignal && typeof root.AbortSignal.timeout !== 'function') {
    define(root.AbortSignal, 'timeout', function timeout(ms) {
      const controller = new root.AbortController();
      setTimeout(() => {
        try { controller.abort(new root.DOMException('The operation timed out.', 'TimeoutError')); }
        catch (_) { controller.abort(); }
      }, Math.max(0, Number(ms) || 0));
      return controller.signal;
    });
  }
  if (typeof Promise.allSettled !== 'function') {
    define(Promise, 'allSettled', function allSettled(items) {
      return Promise.all(Array.from(items, item => Promise.resolve(item).then(
        value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }))));
    });
  }
})(typeof window !== 'undefined' ? window : globalThis);
