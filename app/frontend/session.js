/* Session, API client and service-worker plumbing for the field app.
   Audit items: H1 offline cold start, H2 cache purge, H4 offline logout, H5 account binding, M1/M3 only 401 = signed out
   and timeouts, M10 non-network errors are not "offline", M16 update prompt, L5 no raw English errors.

   Globals owned here: api, boot, afterSignIn, forceSignOut, logout, purgeCaches, registerServiceWorker.
   It relies on state declared in app.js (currentAccount, accountGeneration, farmRecords, ...). */

const API_TIMEOUT_MS = 20000;            // contract 5.9: JSON calls 20 s
const CLOCK_WARN_MS = 10 * 60 * 1000;
const jkTabId = 'tab_' + Math.random().toString(36).slice(2, 10);
const jkAccountChannel = (typeof BroadcastChannel === 'function') ? new BroadcastChannel('jk-account') : null;
let offlineMode = false;                 // the account was opened from the local marker without a server check
let swRegistration = null;
let serverClockOffsetMs = 0;
let clockWarned = false;
let mismatchHandled = false;
let revalidating = false;              // lastDataRefreshMs is declared in app.js next to refreshAllData()

const isNativeApp = () => !!(window.JagaNative && window.JagaNative.isNative());

/* ---------------------------------------------------------------- messages */
function httpMessage(status, detail) {
  if (typeof detail === 'string' && detail.trim()) return detail.trim();
  if (status === 401) return 'Sesi berakhir. Silakan masuk lagi.';
  if (status === 403) return 'Akses ditolak.';
  if (status === 404) return 'Data tidak ditemukan.';
  if (status === 409) return 'Data bentrok dengan perubahan lain. Muat ulang lalu coba lagi.';
  if (status === 413) return 'Berkas terlalu besar.';
  if (status === 422 || status === 400) return 'Data yang dikirim tidak lengkap atau tidak valid.';
  if (status === 429) return 'Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.';
  if (status >= 500) return 'Server sedang bermasalah. Coba lagi nanti.';
  return 'Permintaan gagal (kode ' + status + ').';
}
function networkProblem(timedOut) {
  const error = new Error(timedOut ? 'Koneksi terlalu lambat. Coba lagi.' : 'Tidak dapat menghubungi server. Periksa koneksi Anda.');
  error.offline = true;
  error.timedOut = !!timedOut;
  return error;
}
/* Anything shown to a farmer: keep our own Bahasa text, replace raw English platform errors (audit L5). */
function userMessage(error, fallback) {
  const generic = fallback || 'Terjadi masalah. Coba lagi.';
  if (!error) return generic;
  const text = String(error.message || error);
  if (error.reason === 'quota' || error.name === 'QuotaExceededError' || /quota/i.test(text)) return 'Penyimpanan HP penuh. Hapus foto lama atau kirim foto yang menunggu, lalu coba lagi.';
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return 'Koneksi terlalu lambat. Coba lagi.';
  if (error.offline) return text;
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(text)) return 'Tidak dapat menghubungi server. Periksa koneksi Anda.';
  const english = /\b(the|failed|error|cannot|unable|undefined|null|invalid|unexpected|network|request|response|timeout|denied|not found|permission)\b/i.test(text);
  const bahasa = /\b(tidak|gagal|foto|akun|server|sinyal|coba|tanaman|draf|perlu|silakan|petak|lokasi|kamera|masuk|keluar|simpan|hapus)\b/i.test(text);
  return english && !bahasa ? generic : text;
}

/* ---------------------------------------------------------------- API client */
async function api(path, options = {}) {
  const requestGeneration = accountGeneration;
  const method = options.method || 'GET';
  const headers = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') {
    const csrf = readCookie('jk_csrf');
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  const native = isNativeApp();
  // Contract 5.2: tell the server which account this tab believes is active, except for login/register/health.
  let accountHeader = options.accountHeader || null;
  if (!accountHeader && currentAccount && !/^\/api\/(?:auth\/(?:login|register)|health)(?:\?|$)/.test(path)) accountHeader = String(currentAccount.id);
  if (accountHeader && !native) headers['X-JK-Account'] = accountHeader;
  const timeoutMs = options.timeoutMs || API_TIMEOUT_MS;
  let response;
  let payload = null;
  let timedOut = false;
  let timerId = null;
  try {
    if (native) {
      const call = window.JagaNative.request({ path, method, body: options.body });
      const limit = new Promise((_, reject) => { timerId = setTimeout(() => { timedOut = true; reject(networkProblem(true)); }, timeoutMs); });
      const result = await Promise.race([call, limit]);
      response = { status: result.status, ok: result.status >= 200 && result.status < 300, headers: null };
      payload = result.body;
    } else {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      if (controller) timerId = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      response = await fetch(path, { method, headers, signal: controller ? controller.signal : undefined,
        body: options.body === undefined ? undefined : JSON.stringify(options.body) });
      const text = await response.text();
      if (text) { try { payload = JSON.parse(text); } catch (e) { payload = null; } }
      noteServerClock(response);
    }
  } catch (networkError) {
    // Only genuine network failures read as "offline"; a refused route or a bridge problem keeps its own message.
    if (networkError && (networkError.nativeBridge || networkError.nonNetwork)) throw networkError;
    if (networkError && networkError.offline) throw networkError;
    throw networkProblem(timedOut);
  } finally {
    if (timerId !== null) clearTimeout(timerId);
  }
  if (!options.anonymous && requestGeneration !== accountGeneration) {
    const error = new Error('Akun berubah; respons lama diabaikan.');
    error.stale = true;
    throw error;
  }
  if (response.status === 409 && payload && payload.code === 'account_mismatch' && !options.ignoreMismatch) {
    handleAccountMismatch(payload.detail);
    const error = new Error(typeof payload.detail === 'string' ? payload.detail : 'Akun di perangkat ini sudah berganti. Muat ulang aplikasi.');
    error.accountMismatch = true;
    error.stale = true;
    error.status = 409;
    throw error;
  }
  // Only 401 means "signed out" (audit M1). A 403 is an ordinary refusal for that one request.
  if (response.status === 401 && !options.anonymous) {
    forceSignOut('Sesi Anda berakhir. Silakan masuk lagi.');
    throw new Error('Sesi berakhir');
  }
  if (!response.ok) {
    const error = new Error(httpMessage(response.status, payload && payload.detail));
    error.status = response.status;
    if (payload && typeof payload.code === 'string') error.code = payload.code;
    const retryAfter = response.headers && response.headers.get && response.headers.get('Retry-After');
    if (retryAfter) error.retryAfter = retryAfter;
    throw error;
  }
  if (method === 'POST' && /^\/api\/auth\/(login|register)$/.test(path) &&
      (!payload || typeof payload !== 'object' || !payload.account ||
       typeof payload.account.id !== 'string' || !payload.account.id)) {
    throw new Error('Respons masuk dari server tidak valid. Periksa koneksi atau perbarui aplikasi; akun belum dibuka.');
  }
  return payload;
}

/* A phone with a wrong clock files photos on the wrong day and, if it is ahead, cannot send them at all. */
function noteServerClock(response) {
  try {
    const header = response && response.headers && response.headers.get && response.headers.get('Date');
    const server = header ? Date.parse(header) : NaN;
    if (!Number.isFinite(server)) return;
    serverClockOffsetMs = server - Date.now();
    if (!clockWarned && Math.abs(serverClockOffsetMs) > CLOCK_WARN_MS) {
      clockWarned = true;
      showToast('Jam di HP Anda berbeda dari jam server. Periksa tanggal dan jam di pengaturan HP.');
    }
  } catch (_) { /* informational only */ }
}
window.JagaClockOffset = () => serverClockOffsetMs;
window.onOfflineClockSkew = function () {
  if (clockWarned) return;
  clockWarned = true;
  showToast('Jam di HP Anda sepertinya salah. Periksa tanggal dan jam di pengaturan HP.');
};

/* ---------------------------------------------------------------- account markers (non-secret, IndexedDB meta) */
function metaStore() { return window.JagaOfflineStore && window.JagaOfflineStore.getMeta ? window.JagaOfflineStore : null; }
async function metaGet(name) { try { const store = metaStore(); return store ? await store.getMeta(name) : null; } catch (_) { return null; } }
async function metaSet(name, value) { try { const store = metaStore(); if (store) await store.setMeta(name, value); } catch (_) { /* best effort */ } }
async function metaDelete(name) { try { const store = metaStore(); if (store) await store.deleteMeta(name); } catch (_) { /* best effort */ } }
function rememberAccount(account) {
  const keep = ['id', 'name', 'email', 'role', 'fastQuota', 'fastUsed', 'fastRemaining', 'resetAt'];
  const marker = {};
  keep.forEach(name => { if (account && account[name] !== undefined) marker[name] = account[name]; });
  return metaSet('lastAccount', { ...marker, savedMs: Date.now() });
}
function announceAccount(type, accountId) {
  try { if (jkAccountChannel) jkAccountChannel.postMessage({ type, accountId: accountId === undefined ? null : String(accountId), tab: jkTabId, ts: Date.now() }); }
  catch (_) { /* channel closed */ }
}
if (jkAccountChannel) {
  jkAccountChannel.onmessage = event => {
    const message = event.data || {};
    if (message.tab === jkTabId) return;
    if (message.type === 'logout' && currentAccount) {
      forceSignOut('Anda sudah keluar di jendela lain.', { broadcast: false });
    } else if (message.type === 'login') {
      if (currentAccount && String(message.accountId) !== String(currentAccount.id)) {
        forceSignOut('Akun di perangkat ini sudah berganti. Muat ulang aplikasi.', { broadcast: false });
        setTimeout(() => { try { location.reload(); } catch (_) { /* ignore */ } }, 1500);
      } else if (!currentAccount) {
        const gate = document.getElementById('auth-gate');
        if (gate && !gate.classList.contains('hidden')) { try { location.reload(); } catch (_) { /* ignore */ } }
      }
    }
  };
}
function handleAccountMismatch(detail) {
  if (mismatchHandled) return;
  mismatchHandled = true;
  forceSignOut(typeof detail === 'string' && detail ? detail : 'Akun di perangkat ini sudah berganti. Muat ulang aplikasi.', { broadcast: false });
  setTimeout(() => { try { location.reload(); } catch (_) { /* ignore */ } }, 1500);
}
window.JagaAccountMismatch = handleAccountMismatch;

/* ---------------------------------------------------------------- service worker */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  let reloadRequested = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (reloadRequested) location.reload(); });
  navigator.serviceWorker.register('/sw.js').then(registration => {
    swRegistration = registration;
    const offer = worker => {
      if (!worker || !navigator.serviceWorker.controller) return; // first install: nothing is running under the page yet
      document.dispatchEvent(new CustomEvent('jk-update-ready', { detail: { apply() {
        reloadRequested = true;
        worker.postMessage({ type: 'jk-skip-waiting' });
        setTimeout(() => { if (reloadRequested) location.reload(); }, 4000);
      } } }));
    };
    if (registration.waiting) offer(registration.waiting);
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      if (worker) worker.addEventListener('statechange', () => { if (worker.state === 'installed') offer(registration.waiting || worker); });
    });
    // Look for a new version when the app comes back to the foreground (at most once an hour).
    let lastCheck = Date.now();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden || Date.now() - lastCheck < 3600000) return;
      lastCheck = Date.now();
      registration.update().catch(() => undefined);
    });
  }).catch(err => { console.warn('Service worker not registered:', err); });
}
/* The worker owns the cache names; ask it to drop everything except the app shell (audit H2). */
function purgeCaches() {
  if (!('serviceWorker' in navigator)) return Promise.resolve();
  const target = navigator.serviceWorker.controller || (swRegistration && swRegistration.active);
  if (!target) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(resolve, 3000);
    try {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => { clearTimeout(timer); resolve(); };
      target.postMessage({ type: 'jk-purge-caches' }, [channel.port2]);
    } catch (_) { clearTimeout(timer); resolve(); }
  });
}

/* ---------------------------------------------------------------- sign in / out */
async function afterSignIn(account, options = {}) {
  const offline = !!options.offline;
  window.JagaTour?.reset();
  currentAccount = account;
  accountGeneration += 1;
  offlineMode = offline;
  mismatchHandled = false;
  renderFastQuota();
  if (window.JagaNative) {
    try { await window.JagaNative.activate({ accountId: String(account.id) }); }
    catch (error) { if (offline) throw error; showToast(userMessage(error)); }
  }
  if (!isNativeApp()) {
    if (window.JagaOfflineStore) {
      try { await window.JagaOfflineStore.activate(String(account.id)); }
      catch (error) { if (offline) throw error; showToast(userMessage(error)); }
    }
  }
  hideAuthGate();
  if (typeof startLiveLocationWatcher === 'function') startLiveLocationWatcher();   // GPS only once signed in
  const chip = document.getElementById('account-chip-label');
  if (chip) chip.innerText = account.name || String(account.email || 'Akun').split('@')[0];
  if (typeof syncSidebarAccountUi === 'function') syncSidebarAccountUi();
  loadedOnce = false;
  expandedCropId = null;
  if (!offline) {
    rememberAccount(account);
    metaDelete('pendingLogout');
    announceAccount('login', account.id);
  }
  await refreshAllData();
  // A previous session may have ended while an analysis was still running.
  if (!offline) await recoverPendingAnalyses();
  if (window.JagaOfflineSync && !isNativeApp()) window.JagaOfflineSync.start();
  if (window.JagaShell) { window.JagaShell.onSignedIn(); window.JagaShell.refresh(); }
  checkStorageHealth();
  icons();
  // Test and diagnostics hook: the whole sign-in sequence (data, recovery, sync, GPS) has run for this account.
  document.documentElement.dataset.session = 'ready:' + String(account.id);
  window.JagaTour?.onSignedIn();
}

/* Local sign-out: locks the stores and shows the login screen. It never talks to the server and never deletes drafts. */
function forceSignOut(message, options = {}) {
  accountGeneration += 1;
  const previous = currentAccount;
  offlineMode = false;
  if (window.JagaOfflineSync) window.JagaOfflineSync.stop();
  if (window.JagaOfflineStore) window.JagaOfflineStore.lock().catch(() => undefined);
  if (window.JagaNative && window.JagaNative.isNative()) window.JagaNative.lock().catch(() => undefined);
  if (typeof stopLiveLocationWatcher === 'function') stopLiveLocationWatcher();
  if (window.JagaShell) window.JagaShell.onSignedOut();
  resetAccountUiState();
  currentAccount = null;
  farmRecords = [];
  dailyRecommendations = [];
  refreshAllHistoryViews();
  purgeCaches();
  showAuthGate(message);
  document.documentElement.dataset.session = 'signed-out';
  if (previous && options.broadcast !== false) announceAccount('logout', previous.id);
}

/* "Keluar". The local sign-out is immediate; if the server cannot be reached the intent is remembered
   (a durable "signed out" flag) and finished as soon as there is signal, so a shared phone never falls back into
   the previous account (audit H4). options.wipe also deletes this account's data from the phone (audit M9). */
async function logout(options = {}) {
  const account = currentAccount;
  const accountId = account ? String(account.id) : null;
  const flag = accountId && !isNativeApp() && metaStore()
    ? metaSet('pendingLogout', { accountId, ts: Date.now() }) : Promise.resolve();
  if (accountId) metaDelete('lastAccount');
  const endingSession = api('/api/auth/logout', { method: 'POST', body: {}, anonymous: true })
    .then(() => true, error => !!(error && error.status === 401));
  forceSignOut('');
  await flag;
  const done = await endingSession;
  if (done || isNativeApp()) await metaDelete('pendingLogout');
  else showToast('Anda sudah keluar di HP ini. Sesi di server ditutup otomatis saat ada sinyal.');
  if (options.wipe && accountId) {
    try {
      if (isNativeApp()) await wipeNativeAccount(accountId);
      else if (metaStore()) await window.JagaOfflineStore.wipeAccount(accountId);
    } catch (error) { showToast('Data di HP belum bisa dihapus: ' + userMessage(error)); }
  }
}
/* The account sheet's two buttons. Unsent photos are never lost silently: a plain logout keeps them on the phone
   (they go out after the next sign-in with the same account); "hapus data" says how many will be deleted. */
async function confirmLogout(wipe) {
  const account = currentAccount;
  if (!account) { showAuthGate(''); return; }
  let unsent = 0;
  try {
    const drafts = (await window.JagaNative.list({ accountId: String(account.id) })).drafts || [];
    unsent = drafts.filter(d => d.status !== 'submitted').length;
  } catch (_) { /* store locked: count unknown */ }
  const same = () => !!currentAccount && String(currentAccount.id) === String(account.id);   // the quota refresh replaces the object
  if (!same()) return;
  let ok = true;
  if (wipe) {
    ok = await confirmAction({ title: 'Keluar dan hapus data HP?',
      message: (unsent ? unsent + ' foto belum terkirim akan ikut terhapus. ' : '') + 'Foto, draf dan data akun ini dihapus dari HP ini. Data di server tetap aman.',
      okLabel: 'Hapus dan keluar' });
  } else if (unsent) {
    ok = await confirmAction({ title: 'Keluar dari akun?',
      message: unsent + ' foto belum terkirim. Foto tetap tersimpan di HP ini dan dikirim setelah Anda masuk lagi dengan akun yang sama.',
      okLabel: 'Keluar', danger: false });
  }
  if (!ok || !same()) return;
  if (typeof closeAccountModal === 'function') closeAccountModal();
  await logout({ wipe: !!wipe });
}

/* Native drafts live in the Android store; removing them one by one keeps the plugin API unchanged. */
async function wipeNativeAccount(accountId) {
  try {
    await window.JagaNative.activate({ accountId });
    const drafts = (await window.JagaNative.list({ accountId })).drafts || [];
    for (const draft of drafts) await window.JagaNative.remove({ accountId, clientRequestId: draft.clientRequestId });
  } finally { await window.JagaNative.lock().catch(() => undefined); }
}
/* After an offline logout, finish it once the network is back. Returns true when the server session is closed. */
async function finishPendingLogout(pending) {
  if (!pending || isNativeApp()) { await metaDelete('pendingLogout'); return true; }
  let me;
  try { me = await api('/api/auth/me', { anonymous: true }); }
  catch (error) {
    if (error && error.offline) return false;
    if (error && error.status === 401) { await metaDelete('pendingLogout'); return true; }
    return false;
  }
  if (!me || !me.ok || !me.account) { await metaDelete('pendingLogout'); return true; }
  if (String(me.account.id) !== String(pending.accountId)) { await metaDelete('pendingLogout'); return true; } // someone else signed in since
  // The header makes the server refuse (409) if the cookie has meanwhile become another account's session.
  try { await api('/api/auth/logout', { method: 'POST', body: {}, anonymous: true, accountHeader: String(pending.accountId), ignoreMismatch: true }); }
  catch (error) { if (!(error && (error.status === 401 || error.status === 409))) return false; }
  await metaDelete('pendingLogout');
  return true;
}

/* ---------------------------------------------------------------- boot */
async function boot() {
  showAuthTab('login');
  const pending = await metaGet('pendingLogout');
  try {
    // Not signed in yet is the normal case on a first visit, so a 401 here must not read as a session expiry.
    const payload = await api('/api/auth/me', { anonymous: true });
    if (payload && payload.ok && payload.account) {
      if (pending && !isNativeApp()) {
        if (String(pending.accountId) === String(payload.account.id)) {
          const closed = await finishPendingLogout(pending);
          showAuthGate(closed ? '' : 'Anda sudah keluar di HP ini. Masuk lagi saat ada sinyal.');
          return;
        }
        await metaDelete('pendingLogout');
      }
      await afterSignIn(payload.account);
      return;
    }
    if (pending) await metaDelete('pendingLogout');
  } catch (error) {
    if (error && error.offline) {
      if (pending && !isNativeApp()) { showAuthGate('Anda sudah keluar di HP ini. Masuk lagi saat ada sinyal.'); return; }
      if (await openOfflineFromMarker()) return;
      showAuthGate('Tidak dapat menghubungi server. Periksa koneksi lalu muat ulang.');
      return;
    }
  }
  showAuthGate('');
}

/* Offline cold start (audit H1): no signal and nobody signed out, so reopen the last account from its marker.
   Capture and drafts work; the session is checked again as soon as the network returns. */
async function openOfflineFromMarker() {
  const marker = await metaGet('lastAccount');
  if (!marker || !marker.id) return false;
  try {
    await afterSignIn({ ...marker, offlineMarker: true }, { offline: true });
    return true;
  } catch (error) {
    forceSignOut('Tidak ada sinyal dan akun belum bisa dibuka. Masuk saat sinyal tersedia; foto di HP tetap aman.', { broadcast: false });
    return true;
  }
}
/* Back online after an offline start: confirm the session. 401 or another account signs out locally, drafts stay. */
async function revalidateSession() {
  if (!currentAccount || !offlineMode || revalidating) return;
  revalidating = true;
  const owner = String(currentAccount.id), generation = accountGeneration;
  try {
    const me = await api('/api/auth/me', { anonymous: true });
    if (generation !== accountGeneration) return;
    if (me && me.ok && me.account && String(me.account.id) === owner) {
      currentAccount = me.account;
      offlineMode = false;
      rememberAccount(me.account);
      renderFastQuota();
      announceAccount('login', me.account.id);
      await refreshAllData();
      await recoverPendingAnalyses();
      if (window.JagaOfflineSync) window.JagaOfflineSync.run();
      if (window.JagaShell) window.JagaShell.refresh();
    } else if (me && me.ok && me.account) {
      forceSignOut('Akun di perangkat ini sudah berganti. Masuk lagi; foto yang belum terkirim tetap tersimpan.');
    } else {
      forceSignOut('Sesi Anda berakhir. Masuk lagi; foto yang belum terkirim tetap tersimpan.');
    }
  } catch (error) {
    if (generation === accountGeneration && error && error.status === 401) {
      forceSignOut('Sesi Anda berakhir. Masuk lagi; foto yang belum terkirim tetap tersimpan.');
    }
    // still offline or the server hiccuped: stay in offline mode, try again on the next "online" event
  } finally { revalidating = false; }
}
window.addEventListener('online', () => {
  revalidateSession();
  metaGet('pendingLogout').then(pending => { if (pending && !currentAccount) finishPendingLogout(pending); });
});

/* Reading screens refetch at most once a minute (audit M5); `force` is for pull-to-refresh style buttons. */
function refreshAllDataIfStale(maxAgeMs = 60000) {
  if (!currentAccount || offlineMode) return Promise.resolve();
  if (loadedOnce && Date.now() - lastDataRefreshMs < maxAgeMs) return Promise.resolve();
  return refreshAllData();
}

/* ---------------------------------------------------------------- storage health */
async function checkStorageHealth() {
  const store = window.JagaOfflineStore;
  if (!store || !store.requestPersistence) return;
  try {
    await store.requestPersistence();
    const estimate = await store.storageEstimate();
    if (!window.JagaShell) return;
    if (estimate && estimate.ratio > 0.8) {
      window.JagaShell.setAttention('storage', 'Penyimpanan HP hampir penuh (' + Math.round(estimate.ratio * 100) + '%). Kirim foto yang menunggu atau hapus foto lama.', { tone: 'warn' });
    } else window.JagaShell.clearAttention('storage');
  } catch (_) { /* informational */ }
}
