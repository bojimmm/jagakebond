/* Native bridge adapter. Web builds use the same narrow API over fetch/IndexedDB. */
(function installJagaNative(root) {
  'use strict';
  const capacitor = root.Capacitor;
  const nativeHost = !!(root.androidBridge || (capacitor && typeof capacitor.isNativePlatform === 'function' && capacitor.isNativePlatform()));
  // Plain-script Android exports live in Plugins; registerPlugin belongs to the optional core runtime.
  const plugin = capacitor?.Plugins?.JagaSync || (capacitor && typeof capacitor.registerPlugin === 'function'
    ? capacitor.registerPlugin('JagaSync') : null);
  const allowed = /^\/api\/(?:auth\/(?:login|register|me|logout|password|google(?:\/(?:config|nonce))?)|records(?:\/[^/?#]+(?:\/reanalyze)?)?|farms(?:\/[^/?#]+)?|crops(?:\/[^/?#]+)?|photos(?:\/[^/?#]+(?:\/thumbnail)?)?|queue\/pending|analyze(?:\/[^/?#]+(?:\/(?:ack|cancel))?)?|weather|elevation|geocode|recommendations|client-errors|daily(?:\/[^/?#]+)?|telemetry|health)(?:\?[^#]*)?$/;
  function validatePath(path) {
    if (typeof path !== 'string' || !allowed.test(path) || path.includes('..') || /[\r\n#]/.test(path)) {
      const error = new Error('Rute API tidak diizinkan.');
      error.nonNetwork = true; // never shown as "offline" (audit M10)
      throw error;
    }
    return path;
  }
  /* The Android plugin rejects every failure with a short English phrase. Only a refused route or a malformed
     request is the app's own fault; everything else (timeouts, no signal, TLS) is a network failure. */
  function classifyNativeError(error) {
    const message = String((error && error.message) || error || '');
    if (/not allowed|json body required|invalid /i.test(message) && !/failed safely/i.test(message)) {
      if (error && typeof error === 'object') error.nonNetwork = true;
    }
    return error;
  }
  const imageUrls = new Map();
  const liveImageUrls = new Set();
  let imageGeneration = 0;
  const bridge = {
    isNative: () => nativeHost || !!plugin,
    async resolveImageUrl(url) {
      if (!plugin || typeof url !== 'string') return url;
      const match = url.match(/\/api\/photos\/([A-Za-z0-9_-]+)(?:\?.*)?$/);
      if (!match) return url;
      const path = '/api/photos/' + match[1];
      const mine = imageGeneration;
      if (imageUrls.has(path)) return imageUrls.get(path);
      const result = await bridge.request({ path, method: 'GET' });
      if (mine !== imageGeneration || result.status < 200 || result.status >= 300 || result.encoding !== 'base64') return '';
      const raw = atob(result.body);
      const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
      const blobUrl = URL.createObjectURL(new Blob([bytes], { type: result.headers && result.headers['content-type'] || 'image/jpeg' }));
      liveImageUrls.add(blobUrl);
      imageUrls.set(path, blobUrl);
      return blobUrl;
    },
    revokeImages() { imageGeneration++; liveImageUrls.forEach(url => URL.revokeObjectURL(url)); liveImageUrls.clear(); imageUrls.clear(); },
    async request({ path, method = 'GET', body }) {
      validatePath(path);
      if (nativeHost && !plugin) {
        const error = new Error('Jembatan Android belum tersedia. Tutup dan buka ulang aplikasi; jika tetap gagal, perbarui APK.');
        error.nativeBridge = true;
        throw error;
      }
      method = String(method).toUpperCase();
      if (!['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) throw new Error('Metode tidak diizinkan.');
      if (plugin) {
        let result;
        try { result = await plugin.request({ path, method, ...(body === undefined ? {} : { body }) }); }
        catch (error) { throw classifyNativeError(error); }
        if (typeof result.body === 'string') {
          try { return { ...result, body: JSON.parse(result.body) }; } catch (_) { /* native may return raw text */ }
        }
        return result;
      }
      const headers = {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (method !== 'GET') {
        const csrf = document.cookie.match(/(?:^|; )jk_csrf=([^;]*)/);
        if (csrf) headers['X-CSRF-Token'] = decodeURIComponent(csrf[1]);
      }
      const response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
      const text = await response.text();
      let parsed;
      try { parsed = text ? JSON.parse(text) : null; } catch (_) { parsed = text; }
      return { status: response.status, body: parsed, headers: { 'content-type': response.headers.get('content-type') || '' } };
    },
    enqueue(args) { if (plugin) return plugin.enqueue(args); return root.JagaOfflineStore.enqueue(args); },
    list(args) { if (plugin) return plugin.list(args); return root.JagaOfflineStore.list(args); },
    activate(args) { if (plugin) return plugin.activate(args); return Promise.resolve(root.JagaOfflineStore.activate(args.accountId)); },
    lock() { bridge.revokeImages(); if (plugin) return plugin.lock(); return Promise.resolve(root.JagaOfflineStore.lock()); },
    /* A deleted draft takes its private original with it (the browser store does that itself; on Android the
       encrypted photo file and its Keystore alias go through photoDelete when the APK has it). */
    async remove(args) {
      if (!plugin) return root.JagaOfflineStore.remove(args);
      const result = await plugin.remove(args);
      // APK 0.2.2.0 already deletes the draft's own photo inside remove(); photoDelete is idempotent, so calling it
      // again costs nothing and covers an APK whose remove() does not.
      if (typeof plugin.photoDelete === 'function' && args && args.clientRequestId) {
        try { await plugin.photoDelete({ accountId: args.accountId, photoId: args.clientRequestId }); } catch (_) { /* best effort */ }
      }
      return result;
    },
    /* Android: drafts the native store had to set aside (unreadable after an update / Keystore loss). The web
       shows one notice, then acknowledges so it is not repeated. Older APKs: no-op. */
    quarantineAck(args) {
      if (plugin && typeof plugin.quarantineAck === 'function') return plugin.quarantineAck(args);
      return Promise.resolve({ ok: true, unsupported: true });
    },
  };
  root.JagaNative = bridge;
  if (plugin && typeof MutationObserver !== 'undefined') {
    const resolving = new WeakMap();
    const resolve = img => {
      if (!(img instanceof HTMLImageElement) || !img.getAttribute('src')) return;
      const source = img.getAttribute('src');
      if (!source.startsWith('/api/photos/')) return;
      const generation = imageGeneration;
      const active = resolving.get(img);
      if (active && active.source === source && active.generation === generation) return;
      const request = { source, generation };
      resolving.set(img, request);
      bridge.resolveImageUrl(source).then(blobUrl => {
        if (resolving.get(img) === request) resolving.delete(img);
        if (blobUrl && img.isConnected && generation === imageGeneration && img.getAttribute('src') === source) img.src = blobUrl;
      }).catch(() => { if (resolving.get(img) === request) resolving.delete(img); });
    };
    new MutationObserver(records => records.forEach(record => {
      if (record.type === 'attributes') resolve(record.target);
      record.addedNodes.forEach(node => {
        resolve(node);
        if (node.querySelectorAll) node.querySelectorAll('img').forEach(resolve);
      });
    })).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
    document.querySelectorAll('img').forEach(resolve);
  }
})(window);
