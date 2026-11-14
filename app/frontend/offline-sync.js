/* Open-page web outbox sync. A service worker is not a closed-browser guarantee.
   Per draft: attempts + backoff, oldest first, one health check per pass, abortable, timeouts on every call,
   Bahasa messages. Only HTTP 401 means "signed out"; 403 first re-checks the session. */
(function installOfflineSync(root) {
  'use strict';
  function retryAfterDelayMs(value, nowMs = Date.now()) {
    if (value == null) return 60000;
    const text = String(value).trim();
    if (!/^[0-9]+$/.test(text)) {
      if (!/^(?:[A-Za-z]{3}, |[A-Za-z]+, |[A-Za-z]{3} [A-Za-z]{3} )/.test(text)) return 60000;
      const delay = Date.parse(text) - nowMs;
      return Number.isFinite(delay) && delay > 0 ? Math.min(delay, 86400000) : 60000;
    }
    const normalized = text.replace(/^0+/, '') || '0';
    if (normalized === '0') return 60000;
    if (normalized.length > 5 || Number(normalized) > 86400) return 24 * 60 * 60 * 1000;
    return Number(normalized) * 1000;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { retryAfterDelayMs };

  const API_TIMEOUT_MS = 20000;      // contract 5.9: JSON calls 20 s, uploads 90 s, health 10 s
  const UPLOAD_TIMEOUT_MS = 90000;
  const HEALTH_TIMEOUT_MS = 10000;
  const TICK_MS = 15000;
  const BACKOFF_MS = [30000, 60000, 120000, 300000, 600000, 900000];
  const MAX_SERVER_ATTEMPTS = 12;    // only server-caused failures (5xx) count towards giving up
  const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
  const inflight = new Map();        // clientRequestId -> { abort }
  let running = false;
  let runPromise = null;
  let timer = null;
  let generation = 0;
  let onlineHandler = null;
  let visibleHandler = null;
  let networkFailures = 0;
  let skipTicks = 0;

  const now = () => Date.now();
  const store = () => root.JagaOfflineStore;
  const isOnline = () => !(root.navigator && root.navigator.onLine === false);
  const isHidden = () => !!(root.document && root.document.hidden);
  function backoffMs(attempts) { return BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1]; }

  /* fetch with a timeout and an abort handle. The timer keeps running until `done()` so a stalled body also times out. */
  function timedFetch(url, options, ms, hooks) {
    let timedOut = false;
    let cancelled = false;
    let controller = null;
    let timerId = null;
    const init = { ...options };
    if (typeof AbortController === 'function') {
      controller = new AbortController();
      init.signal = controller.signal;
      if (typeof setTimeout === 'function') timerId = setTimeout(() => { timedOut = true; controller.abort(); }, ms);
      if (hooks) hooks.abort = () => { cancelled = true; controller.abort(); };
    }
    const done = () => { if (timerId !== null && typeof clearTimeout === 'function') clearTimeout(timerId); };
    return { promise: fetch(url, init).catch(error => { done(); throw networkFailure(error, timedOut, cancelled); }), done };
  }
  function networkFailure(error, timedOut, cancelled) {
    const wrapped = new Error(cancelled ? 'Pengiriman dibatalkan.'
      : timedOut ? 'Koneksi terlalu lambat. Dicoba lagi otomatis.'
      : 'Tidak ada sinyal. Foto dikirim otomatis saat sinyal ada.');
    wrapped.network = !cancelled;
    wrapped.timedOut = !!timedOut;
    wrapped.cancelled = !!cancelled;
    wrapped.cause = error;
    return wrapped;
  }
  function statusMessage(status, detail) {
    const text = typeof detail === 'string' && detail.trim() ? detail.trim() : '';
    if (status === 413) return 'Foto terlalu besar untuk server. Ambil ulang foto.';
    if (status === 422) return text || 'Foto atau datanya ditolak server. Ambil ulang foto.';
    if (status === 400) return text || 'Data foto ditolak server. Ambil ulang foto.';
    if (status === 404) return text || 'Tanaman atau petak tidak ditemukan di server.';
    if (status === 409) return 'Foto ini sudah pernah dikirim dengan data berbeda. Periksa di Riwayat.';
    if (status === 429) return text || 'Server sedang sibuk. Dicoba lagi otomatis.';
    if (status === 403) return 'Server menolak kiriman ini. Muat ulang aplikasi atau masuk lagi.';
    if (status >= 500) return 'Server sedang bermasalah. Dicoba lagi otomatis.';
    return text || 'Pengiriman ditolak server (kode ' + status + ').';
  }
  function flagged(message, flags) { return Object.assign(new Error(message), flags); }

  async function checkHealth() {
    const request = timedFetch('/api/health', { credentials: 'same-origin' }, HEALTH_TIMEOUT_MS);
    try {
      const response = await request.promise;
      if (!response.ok) throw flagged('Server belum bisa dicek. Dicoba lagi otomatis.', { transient: true, status: response.status });
      return await response.json();
    } finally { request.done(); }
  }
  function requireCompatible(health, draft) {
    const match = typeof health.version === 'string' && health.version.match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!match || Number(match[1]) !== 2 || Number(match[2]) < 1) {
      throw flagged('Server perlu diperbarui. Foto tetap tersimpan di HP.', { serverVersion: true, scope: 'all' });
    }
    if (draft.fields && draft.fields.cropId && !(health.capabilities && health.capabilities.treeContinuity === true)) {
      throw flagged('Server perlu diperbarui. Foto tetap tersimpan di HP.', { serverVersion: true, scope: 'draft' });
    }
  }
  /* A photo cannot be taken in the future. A wrong phone clock would make the server refuse the photo forever. */
  function outgoingFields(draft) {
    const fields = { ...(draft.fields || {}) };
    let clamped = false;
    if (fields.photoTimestampMs !== null && fields.photoTimestampMs !== undefined) {
      const stamp = Number(fields.photoTimestampMs);
      if (Number.isFinite(stamp) && stamp > now() + FUTURE_TOLERANCE_MS) { fields.photoTimestampMs = String(now()); clamped = true; }
    }
    return { fields, clamped };
  }
  async function sessionStillValid() {
    const request = timedFetch('/api/auth/me', { credentials: 'same-origin' }, API_TIMEOUT_MS);
    try { const response = await request.promise; return response.status !== 401; }
    catch (_) { return true; } // cannot tell: do not sign anyone out on a network error
    finally { request.done(); }
  }

  async function upload(accountId, draft, mine, options, stale) {
    const hooks = {};
    inflight.set(draft.clientRequestId, hooks);
    try {
      if (stale()) throw flagged('Akun berubah; pengiriman dibatalkan.', { stale: true });
      const db = store();
      if (db.draftClaim) {
        const claimed = await db.draftClaim({ accountId, clientRequestId: draft.clientRequestId, ignoreDeadline: !!options.manual });
        if (!claimed.claimed || stale()) throw flagged('Draf berubah; pengiriman dibatalkan.', { draftChanged: true });
      }
      let image = draft.imageBase64;
      if (!image && db.draftImage) image = await db.draftImage(accountId, draft.clientRequestId);
      if (!image) throw flagged('Foto draf tidak ditemukan di perangkat ini. Hapus draf lalu ambil ulang foto.', { permanent: true, status: 0 });
      let bytes;
      try { bytes = Uint8Array.from(atob(image), c => c.charCodeAt(0)); }
      catch (_) { throw flagged('Foto draf rusak. Hapus draf lalu ambil ulang foto.', { permanent: true, status: 0 }); }
      const outgoing = outgoingFields(draft);
      const form = new FormData();
      form.append('image', new Blob([bytes], { type: 'image/jpeg' }), 'foto.jpg');
      Object.entries(outgoing.fields).forEach(([name, value]) => {
        if (value !== null && value !== undefined) form.append(name, String(value));
      });
      form.append('clientRequestId', draft.clientRequestId);
      const headers = { 'X-CSRF-Token': sync.csrf() || '', 'X-JK-Account': accountId };
      const request = timedFetch('/api/analyze', { method: 'POST', body: form, credentials: 'same-origin', headers }, UPLOAD_TIMEOUT_MS, hooks);
      let response;
      let payload;
      try {
        response = await request.promise;
        if (response.status === 401) throw flagged('Sesi berakhir; foto tetap tersimpan dan menunggu masuk kembali.', { auth: true });
        if (response.status === 403 && !(await sessionStillValid())) throw flagged('Sesi berakhir; foto tetap tersimpan dan menunggu masuk kembali.', { auth: true });
        payload = await response.json().catch(() => ({}));
      } finally { request.done(); }
      if (response.status === 409 && payload && payload.code === 'account_mismatch') {
        throw flagged(typeof payload.detail === 'string' ? payload.detail : 'Akun di perangkat ini sudah berganti. Muat ulang aplikasi.', { accountMismatch: true });
      }
      if (response.status === 409) throw flagged(statusMessage(409), { conflict: true, status: 409 });
      if (!response.ok) {
        const error = flagged(statusMessage(response.status, payload && payload.detail), { status: response.status,
          serverCode: payload && typeof payload.code === 'string' ? payload.code : null });
        if (response.status === 429) error.retryAfterMs = retryAfterDelayMs(response.headers && response.headers.get('Retry-After'));
        throw error;
      }
      if (!payload || typeof payload.job_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.job_id)) {
        throw flagged('Tanda terima server tidak valid; foto tetap tersimpan dan dicoba lagi.', { transient: true });
      }
      if (outgoing.clamped && typeof root.onOfflineClockSkew === 'function') root.onOfflineClockSkew(draft);
      return payload;
    } finally { inflight.delete(draft.clientRequestId); }
  }

  async function failDraft(accountId, draft, changes) {
    try { await store().update(accountId, draft.clientRequestId, changes); } catch (_) { /* store locked or gone: nothing to record */ }
  }
  async function resetIfUploading(accountId, draft) {
    const db = store();
    if (!db.draftGet) return;
    try {
      const current = (await db.draftGet({ accountId, clientRequestId: draft.clientRequestId })).draft;
      if (current && current.status === 'uploading') await db.update(accountId, draft.clientRequestId, { status: 'pending' });
    } catch (_) { /* ignore: the stale-upload timeout recovers it */ }
  }

  async function pass(options) {
    const summary = { sent: 0, failed: 0, deferred: 0 };
    const account = root.JagaAppAccount && root.JagaAppAccount();
    if (!account || !store() || !isOnline()) return summary;
    const accountId = String(account.id);
    const mine = generation;
    const stale = () => mine !== generation || !root.JagaAppAccount() || String(root.JagaAppAccount().id) !== accountId;
    const notify = (error, draft) => { if (typeof root.onOfflineSyncError === 'function') root.onOfflineSyncError(error, draft); };
    try {
      let drafts = await store().pendingForSync(accountId);
      if (stale()) return summary;
      drafts = drafts.slice().sort((a, b) => {
        if (options.first) { if (a.clientRequestId === options.first) return -1; if (b.clientRequestId === options.first) return 1; }
        return (Number(a.createdMs) || 0) - (Number(b.createdMs) || 0);
      });
      let health = null;
      for (const draft of drafts) {
        if (stale()) return summary;
        if (options.only && draft.clientRequestId !== options.only) continue;
        if (!options.manual && Number(draft.nextAttemptAtMs) > now()) { summary.deferred += 1; continue; }
        try {
          if (!health) health = await checkHealth();
          requireCompatible(health, draft);
          const receipt = await upload(accountId, draft, mine, options, stale);
          if (stale()) return summary;
          networkFailures = 0;
          await store().update(accountId, draft.clientRequestId,
            { status: 'submitted', jobId: receipt.job_id, submittedMs: now(), error: null, errorCode: null, serverCode: null, attempts: 0, nextAttemptAtMs: 0 });
          summary.sent += 1;
          if (typeof root.onOfflineDraftSubmitted === 'function') root.onOfflineDraftSubmitted(draft, receipt);
        } catch (error) {
          if (stale()) return summary;
          if (error.draftChanged) continue;
          await resetIfUploading(accountId, draft);
          if (error.serverVersion) {
            notify(error, draft);
            if (error.scope === 'all') return summary;
            continue;
          }
          if (error.auth) {
            if (store()) await store().lock().catch(() => undefined);
            notify(error, draft);
            return summary;
          }
          if (error.accountMismatch) { notify(error, draft); return summary; }
          if (error.cancelled) { summary.deferred += 1; continue; }
          if (error.conflict) {
            await failDraft(accountId, draft, { status: 'conflict', error: error.message, errorCode: 'idempotency_conflict' });
            notify(error, draft);
            summary.failed += 1;
            continue;
          }
          const attempts = (Number(draft.attempts) || 0) + 1;
          if (error.transient) {
            // health check refused (status set) or a malformed receipt (no status): the draft itself is not at fault
            await failDraft(accountId, draft, { status: 'pending', error: error.message, lastAttemptMs: now(),
              errorCode: error.status ? 'health_http_' + error.status : 'transient' });
            notify(error, draft);
            if (error.status) return summary;
            continue;
          }
          if (error.network || error.timedOut) {
            networkFailures += 1;
            await failDraft(accountId, draft, { status: 'pending', error: error.message, errorCode: error.timedOut ? 'timeout' : 'network', lastAttemptMs: now() });
            notify(error, draft);
            return summary; // no signal: trying the next draft would only repeat the same failure
          }
          if (error.permanent || (error.status >= 400 && error.status < 500 && ![408, 425, 429].includes(error.status))) {
            await failDraft(accountId, draft, { status: 'failed', error: error.message, errorCode: 'http_' + (error.status || 0), attempts, lastAttemptMs: now() });
            notify(error, draft);
            summary.failed += 1;
            continue;
          }
          if (error.status === 429) {
            await failDraft(accountId, draft, { status: 'pending', error: error.message, errorCode: 'retry_after', serverCode: error.serverCode || null, attempts, lastAttemptMs: now(),
              nextAttemptAtMs: now() + (error.retryAfterMs || 60000) });
            notify(error, draft);
            summary.deferred += 1;
            continue;
          }
          // 5xx, 408, 425, bad receipt: back off per draft; a draft the server keeps failing on eventually stops.
          const giveUp = error.status >= 500 && attempts >= MAX_SERVER_ATTEMPTS;
          await failDraft(accountId, draft, giveUp
            ? { status: 'failed', error: 'Server gagal memproses foto ini berkali-kali. Coba kirim lagi nanti.', errorCode: 'http_' + error.status, attempts, lastAttemptMs: now() }
            : { status: 'pending', error: error.message, errorCode: error.status ? 'http_' + error.status : 'transient', attempts, lastAttemptMs: now(), nextAttemptAtMs: now() + backoffMs(attempts) });
          notify(error, draft);
          if (giveUp) summary.failed += 1; else summary.deferred += 1;
        }
      }
    } catch (error) {
      if (!stale()) {
        if (error && (error.network || error.timedOut)) networkFailures += 1;
        notify(error);
      }
    }
    return summary;
  }

  function stopListeners() {
    if (timer) clearInterval(timer);
    timer = null;
    if (onlineHandler && root.removeEventListener) root.removeEventListener('online', onlineHandler);
    onlineHandler = null;
    if (visibleHandler && root.document && root.document.removeEventListener) root.document.removeEventListener('visibilitychange', visibleHandler);
    visibleHandler = null;
  }

  const sync = {
    csrf() {
      const m = document.cookie.match(/(?:^|; )jk_csrf=([^;]*)/);
      return m ? decodeURIComponent(m[1]) : null;
    },
    /* options: manual (ignore deadlines), first (upload this draft first), only (upload only this draft) */
    async run(options = {}) {
      if (root.JagaNative?.isNative()) return { sent: 0, failed: 0, deferred: 0 };
      while (running) {
        await runPromise.catch(() => undefined);
        if (!(options.manual || options.first || options.only)) return { sent: 0, failed: 0, deferred: 0 };
      }
      running = true;
      runPromise = pass(options).finally(() => { running = false; });
      return runPromise;
    },
    /* "Batalkan" while a photo is still uploading: aborts that request. */
    cancelUpload(clientRequestId) {
      const hooks = inflight.get(clientRequestId);
      if (hooks && typeof hooks.abort === 'function') { hooks.abort(); return true; }
      return false;
    },
    isUploading(clientRequestId) { return inflight.has(clientRequestId); },
    start() {
      if (root.JagaNative?.isNative()) { sync.stop(); return; }
      stopListeners();
      networkFailures = 0;
      skipTicks = 0;
      onlineHandler = () => { networkFailures = 0; skipTicks = 0; sync.run(); };
      if (root.addEventListener) root.addEventListener('online', onlineHandler);
      visibleHandler = () => { if (!isHidden()) sync.run(); };
      if (root.document && root.document.addEventListener) root.document.addEventListener('visibilitychange', visibleHandler);
      timer = setInterval(() => {
        if (isHidden()) return;
        if (skipTicks > 0) { skipTicks -= 1; return; }
        // repeated network failures stretch the interval (15 s, 30 s, 60 s ... up to ~2 min)
        skipTicks = networkFailures > 0 ? Math.min(7, 2 ** Math.min(networkFailures, 3) - 1) : 0;
        sync.run();
      }, TICK_MS);
      sync.run();
    },
    stop() {
      generation += 1;
      stopListeners();
      inflight.forEach(hooks => { if (typeof hooks.abort === 'function') hooks.abort(); });
    },
  };
  root.JagaOfflineSync = sync;
})(typeof window !== 'undefined' ? window : globalThis);
