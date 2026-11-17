'use strict';
/* JagaKebond — Konsol Admin (0.2.2.0; registration inbox 0.2.3.0)
 *
 * The page runs under a strict CSP (script-src 'self'): there is no inline script and no inline
 * event handler anywhere. Everything is wired with addEventListener and data-action / data-id
 * attributes (one delegated listener per event type), which also removes the old
 * inline-handler string-building pattern (a handler attribute built from an id).
 *
 * A few names stay global on purpose because the browser harnesses call them:
 * ME, ACCOUNTS, SETTINGS, openModal, closeModal, createAccount, editAccount, renderAccounts, switchTab.
 */

let ME = null;
let SETTINGS = [];
let ACCOUNTS = [];
const SETTINGS_META = { encryption: null, routerHosts: [] };
const ACCOUNTS_PAGE = { total: null, next: null, query: '', filter: '', loading: false, error: '', seq: 0 };
const QUEUE = { jobs: [], depth: 0, byStatus: {}, filter: '', limit: 50, auto: true, loading: false, error: '', seq: 0, html: '' };
const AUDIT = { items: [], next: null, action: '', routine: false, query: '', loading: false, error: '', seq: 0 };
const OVERVIEW = { data: null, at: 0, seq: 0, inventory: null, inventoryBusy: false };
const REGS = { items: [], enabled: false, pending: 0, loading: false, error: '', seq: 0 };
const TABS = ['overview', 'accounts', 'settings', 'queue', 'audit'];
const ACCOUNTS_PAGE_SIZE = 25;
const POLL = { queue: null, overview: null };
let ACTIVE_TAB = 'overview';
let TOAST_TIMER = null;
let SEARCH_TIMER = null;
let AUDIT_TIMER = null;

/* ------------------------------- helpers -------------------------------- */
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v === null || v === undefined ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const icon = (name) => '<i data-lucide="' + name + '" aria-hidden="true"></i>';
function icons() { try { if (window.lucide) window.lucide.createIcons(); } catch (e) { /* icons are decoration only */ } }

function readCookie(name) {
  const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

const NUMBER = new Intl.NumberFormat('id-ID');
const num = (n) => NUMBER.format(Number(n) || 0);
const fmtBytes = (n) => {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = Number(n);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(i ? 1 : 0).replace('.', ',') + ' ' + units[i];
};
const fmtTime = (ms) => ms ? new Date(ms).toLocaleString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
function fmtAgo(ms) {
  if (!ms) return 'belum pernah';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'baru saja';
  if (s < 3600) return Math.round(s / 60) + ' menit lalu';
  if (s < 86400) return Math.round(s / 3600) + ' jam lalu';
  return Math.round(s / 86400) + ' hari lalu';
}

const ROLE_LABEL = { user: 'Normal', priority: 'Prioritas', admin: 'Admin' };
const ROLE_BADGE = { user: 'badge-unknown', priority: 'badge-unknown', admin: 'badge-info' };
const STATUS_LABEL = { queued: 'Menunggu', claimed: 'Dikerjakan', done: 'Selesai', rejected: 'Ditolak', failed: 'Gagal', cancelled: 'Dibatalkan' };
const STATUS_BADGE = { queued: 'badge-unknown', claimed: 'badge-moderate', done: 'badge-healthy', rejected: 'badge-severe', failed: 'badge-severe', cancelled: 'badge-unknown' };
const STAGE_LABEL = {
  'triage:start': 'triase mulai', 'triage:http': 'panggilan router (triase)', 'triage:done': 'triase selesai',
  'diagnose:start': 'diagnosis mulai', 'diagnose:http': 'panggilan router (diagnosis)',
  'diagnose:done': 'diagnosis selesai', 'result:posted': 'hasil dikirim',
};
const AUDIT_LABEL = {
  'account.create': 'Akun dibuat', 'account.update': 'Akun diubah', 'account.reset_password': 'Kata sandi diatur ulang',
  'account.delete': 'Akun dihapus', 'account.login': 'Masuk', 'account.logout': 'Keluar', 'account.register': 'Pendaftaran',
  'account.password': 'Kata sandi diganti pemiliknya', 'account.revoke_sessions': 'Sesi dicabut', 'account.login_failed': 'Gagal masuk',
  'setting.update': 'Setelan diubah', 'setting.clear': 'Kunci dihapus', 'setting.test_router': 'Uji router',
  'queue.requeue': 'Pekerjaan diulang', 'queue.cancel': 'Pekerjaan dibatalkan', 'job.view': 'Detail pekerjaan dilihat',
  'storage.inventory': 'Pemeriksaan foto tanpa catatan', 'reauth.failed': 'Konfirmasi kata sandi gagal',
  'registration.request': 'Permintaan masuk (Google)', 'registration.approve': 'Pendaftaran disetujui', 'registration.reject': 'Pendaftaran ditolak',
  'client.error': 'Kesalahan aplikasi', 'record.correct': 'Data tanaman dikoreksi',
};
const AUDIT_FILTERS = [
  ['', 'Semua aksi'], ['account.*', 'Akun (semua)'], ['account.create', 'Akun dibuat'], ['account.update', 'Akun diubah'],
  ['account.reset_password', 'Kata sandi diatur ulang'], ['account.delete', 'Akun dihapus'], ['setting.*', 'Setelan (semua)'],
  ['setting.test_router', 'Uji router'], ['queue.*', 'Antrean (semua)'], ['job.view', 'Detail pekerjaan dilihat'],
  ['storage.*', 'Penyimpanan foto'], ['reauth.failed', 'Konfirmasi kata sandi gagal'], ['registration.*', 'Pendaftaran Google'],
  ['client.error', 'Kesalahan aplikasi'], ['record.correct', 'Data tanaman dikoreksi'], ['account.login', 'Masuk'], ['account.logout', 'Keluar'],
];
/* Audit details are stored as short key=value notes; show them as words (0.2.4.15). */
const ROLE_WORD = { user: 'Normal', priority: 'Prioritas', admin: 'Admin' };
function auditDetail(text) {
  return String(text || '').replace(/\bperan=(\w+)/g, (_, role) => 'Peran: ' + (ROLE_WORD[role] || role))
    .replace(/\b(\w+)=([^;·]+)/g, (_, key, value) => key.charAt(0).toUpperCase() + key.slice(1) + ': ' + value.trim())
    .replace(/;\s*/g, ' · ');
}
const TIER_NOTE = 'Analisis cepat per hari: Normal 20, Prioritas 50, Admin tanpa batas. Mulai lagi pukul 00:00 WIB. Setelah jatah habis, foto tetap dianalisis lewat antrean biasa.';

/* --------------------------------- API ---------------------------------- */
class ApiError extends Error {
  constructor(message, status, code) { super(message); this.name = 'ApiError'; this.status = status || 0; this.code = code || ''; }
}
const NETWORK_MESSAGE = 'Tidak dapat menghubungi server. Periksa sambungan internet lalu coba lagi.';

function detailText(payload, status) {
  const detail = payload && payload.detail;
  if (typeof detail === 'string' && detail) return detail;
  if (Array.isArray(detail) && detail.length) return 'Isian belum benar. Periksa lagi lalu coba kembali.';
  if (status >= 500) return 'Terjadi kesalahan di server (HTTP ' + status + '). Coba lagi sebentar lagi.';
  return 'Permintaan gagal (HTTP ' + status + ').';
}

async function api(path, options = {}) {
  const method = options.method || 'GET';
  const headers = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') {
    const csrf = readCookie('jk_csrf');
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  // Lets the server refuse the call when the signed-in account changed in another tab.
  if (ME && ME.id && !options.auth) headers['X-JK-Account'] = ME.id;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 30000);
  let response, text;
  try {
    response = await fetch(path, {
      method, headers, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    text = await response.text();
  } catch (error) {
    const timedOut = error && error.name === 'AbortError';
    throw new ApiError(timedOut ? 'Server tidak menjawab. Coba lagi sebentar lagi.' : NETWORK_MESSAGE, 0, timedOut ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }
  let payload = null;
  if (text) { try { payload = JSON.parse(text); } catch (e) { payload = null; } }
  if (response.status === 401 && !options.auth) {
    expireSession('Sesi Anda berakhir. Silakan masuk lagi.');
    throw new ApiError('Sesi berakhir', 401, 'session_expired');
  }
  if (response.status === 409 && payload && payload.code === 'account_mismatch') {
    expireSession(payload.detail || 'Akun di browser ini sudah berganti. Silakan masuk lagi.');
    throw new ApiError('Akun berganti', 409, 'account_mismatch');
  }
  if (!response.ok) throw new ApiError(detailText(payload, response.status), response.status, payload && payload.code);
  return payload;
}

/* ------------------------- small UI primitives -------------------------- */
function toast(message, kind) {
  const region = $('toast-region');
  clearTimeout(TOAST_TIMER);
  const cls = kind === 'error' ? ' toast-error' : kind === 'warn' ? ' toast-warn' : kind === 'ok' ? ' toast-ok' : '';
  region.innerHTML = '<div class="toast' + cls + '"' + (kind === 'error' ? ' role="alert"' : '') + '>' + esc(message) + '</div>';
  TOAST_TIMER = setTimeout(() => { region.innerHTML = ''; }, kind === 'error' ? 9000 : 4500);
}

async function withBusy(button, task) {
  if (button && button.dataset.busy === '1') return undefined;
  if (button) { button.dataset.busy = '1'; button.disabled = true; button.setAttribute('aria-busy', 'true'); }
  try { return await task(); } finally {
    if (button && button.isConnected) { delete button.dataset.busy; button.disabled = false; button.removeAttribute('aria-busy'); }
  }
}

function setHtml(el, html) {
  if (!el) return false;
  if (el.dataset.sig === html) return false;
  el.innerHTML = html;
  el.dataset.sig = html;
  return true;
}

/** Re-render a region without losing the keyboard focus the user is on. */
function keepFocus(container, render) {
  const active = document.activeElement;
  let key = null;
  if (active && container && container.contains(active) && active !== container) {
    key = { id: active.id, action: active.dataset.action, rid: active.dataset.id, status: active.dataset.status };
  }
  render();
  if (!key) return;
  let selector = '';
  if (key.id) selector = '#' + (window.CSS && CSS.escape ? CSS.escape(key.id) : key.id);
  else if (key.action) {
    selector = '[data-action="' + key.action + '"]' + (key.rid ? '[data-id="' + String(key.rid).replace(/"/g, '\\"') + '"]' : '')
      + (key.status !== undefined ? '[data-status="' + key.status + '"]' : '');
  }
  const next = selector ? container.querySelector(selector) : null;
  if (next && next !== document.activeElement) next.focus({ preventScroll: true });
}

function loadingBlock(label) {
  return '<div class="card" role="status"><span class="sr-only">' + esc(label || 'Memuat…') + '</span>'
    + '<div class="skeleton sk"></div><div class="skeleton sk-lg"></div><div class="skeleton sk"></div></div>';
}
function errorBlock(message, action) {
  return '<div class="card a-stack"><div class="notice notice-error" role="alert">' + icon('circle-alert') + '<span>' + esc(message) + '</span></div>'
    + (action ? '<button type="button" class="btn btn-secondary" data-action="' + action + '">' + icon('refresh-cw') + '<span class="btn-label">Coba lagi</span></button>' : '') + '</div>';
}
function emptyBlock(text) { return '<div class="card t-body t-muted">' + esc(text) + '</div>'; }
function badge(text, kind) { return '<span class="badge ' + (kind || 'badge-unknown') + '">' + esc(text) + '</span>'; }
function tile(label, value, sub, word) {
  return '<div class="card"><span class="t-meta">' + esc(label) + '</span><span class="tile-value' + (word ? ' tile-word' : '') + '">' + esc(value) + '</span>'
    + (sub ? '<span class="t-meta">' + esc(sub) + '</span>' : '') + '</div>';
}
function kv(rows) {
  return '<dl class="kv">' + rows.map((r) => '<div><dt>' + esc(r[0]) + '</dt><dd' + (r[2] ? ' class="mono"' : '') + '>' + (r[3] ? r[1] : esc(r[1])) + '</dd></div>').join('') + '</dl>';
}

/* ------------------------------ dialogs --------------------------------- */
const MODAL = { opener: null, openerKey: null, dismissOnBackdrop: true, resolve: null };

function focusable(root) {
  return Array.from(root.querySelectorAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'))
    .filter((el) => !el.disabled && !el.hidden && el.offsetParent !== null && el.type !== 'hidden');
}

function openModal(html, options = {}) {
  const host = $('modal');
  MODAL.opener = document.activeElement;
  MODAL.openerKey = MODAL.opener && MODAL.opener.dataset ? { action: MODAL.opener.dataset.action, id: MODAL.opener.dataset.id, elId: MODAL.opener.id } : null;
  MODAL.dismissOnBackdrop = options.dismissOnBackdrop !== false;
  host.innerHTML = '<div class="dialog card" role="' + (options.role || 'dialog') + '" aria-modal="true" aria-labelledby="modal-title" tabindex="-1">' + html + '</div>';
  host.hidden = false;
  const app = $('app');
  if (app) app.inert = true;
  document.body.classList.add('modal-open');
  icons();
  const dialog = host.firstElementChild;
  const first = dialog.querySelector('[data-autofocus]') || dialog.querySelector('input:not([type=hidden]), select, textarea') || dialog.querySelector('button:not([data-action="close-modal"])') || dialog;
  first.focus();
  return dialog;
}

function closeModal() {
  const host = $('modal');
  if (!host) return;
  const resolve = MODAL.resolve;
  MODAL.resolve = null;
  host.hidden = true;
  host.innerHTML = '';
  const app = $('app');
  if (app) app.inert = false;
  document.body.classList.remove('modal-open');
  if (resolve) resolve(false);
  let target = MODAL.opener && MODAL.opener.isConnected ? MODAL.opener : null;
  const key = MODAL.openerKey;
  if (!target && key) {
    if (key.elId) target = $(key.elId);
    if (!target && key.action) target = document.querySelector('[data-action="' + key.action + '"]' + (key.id ? '[data-id="' + String(key.id).replace(/"/g, '\\"') + '"]' : ''));
  }
  MODAL.opener = null; MODAL.openerKey = null;
  if (target && target.focus && !(app && app.hidden)) target.focus({ preventScroll: true });
}

function modalOpen() { const host = $('modal'); return !!host && !host.hidden; }

function confirmDialog({ title, body, confirmLabel, danger }) {
  return new Promise((resolve) => {
    openModal('<h2 id="modal-title" class="t-title">' + esc(title) + '</h2><div class="t-body mt3">' + body + '</div>'
      + '<div class="dialog-actions mt6"><button type="button" class="btn btn-secondary" data-action="confirm-no">Batal</button>'
      + '<button type="button" class="btn ' + (danger ? 'btn-danger-solid' : 'btn-primary') + '" data-action="confirm-yes" data-autofocus>' + esc(confirmLabel || 'Ya') + '</button></div>',
    { role: 'alertdialog', dismissOnBackdrop: false });
    MODAL.resolve = resolve;
  });
}
function answerConfirm(yes) {
  const resolve = MODAL.resolve;
  MODAL.resolve = null;
  closeModal();
  if (resolve) resolve(yes);
}

function showModalError(message, fieldId) {
  const box = $('modal-error');
  if (box) { box.textContent = message; box.hidden = false; }
  const field = fieldId ? $(fieldId) : null;
  if (field) field.focus();
}
function clearModalError() { const box = $('modal-error'); if (box) { box.hidden = true; box.textContent = ''; } }

/* form field builders (markup uses the shared ui-kit classes) */
function field(o) {
  const hint = o.hint ? '<p class="hint" id="' + o.id + '-hint">' + esc(o.hint) + '</p>' : '';
  return '<div><label class="label" for="' + o.id + '">' + esc(o.label) + '</label>'
    + '<input id="' + o.id + '" class="input" type="' + (o.type || 'text') + '" value="' + esc(o.value || '') + '"'
    + (o.autocomplete ? ' autocomplete="' + o.autocomplete + '"' : '') + (o.maxlength ? ' maxlength="' + o.maxlength + '"' : '')
    + (o.inputmode ? ' inputmode="' + o.inputmode + '"' : '') + (o.hint ? ' aria-describedby="' + o.id + '-hint"' : '') + ' autocapitalize="off" spellcheck="false">'
    + hint + '</div>';
}
function passwordField(o) {
  return '<div><label class="label" for="' + o.id + '">' + esc(o.label) + '</label>'
    + '<div class="pw-row"><input id="' + o.id + '" class="input" type="password" autocomplete="' + (o.autocomplete || 'new-password') + '"'
    + (o.hint ? ' aria-describedby="' + o.id + '-hint"' : '') + '>'
    + '<button type="button" class="btn btn-secondary" data-action="toggle-password" data-target="' + o.id + '" aria-controls="' + o.id + '" aria-pressed="false">Tampilkan</button></div>'
    + (o.hint ? '<p class="hint" id="' + o.id + '-hint">' + esc(o.hint) + '</p>' : '') + '</div>';
}
function newPasswordFields(prefix, minimum) {
  return passwordField({ id: prefix + '-password', label: 'Kata sandi baru', hint: 'Minimal ' + minimum + ' karakter.' })
    + passwordField({ id: prefix + '-password2', label: 'Ulangi kata sandi' })
    + '<div class="btn-row"><button type="button" class="btn btn-secondary btn-sm" data-action="gen-password" data-prefix="' + prefix + '">' + icon('key-round') + '<span class="btn-label">Buat acak</span></button>'
    + '<button type="button" class="btn btn-secondary btn-sm" data-action="copy-password" data-prefix="' + prefix + '">' + icon('copy') + '<span class="btn-label">Salin</span></button></div>';
}
function reauthBox(id, text) {
  return '<div id="' + id + '-box" hidden>' + passwordField({ id, label: 'Kata sandi Anda (konfirmasi)', autocomplete: 'current-password', hint: text || 'Diminta untuk tindakan yang sensitif.' }) + '</div>';
}
function dialogButtons(submitLabel, danger) {
  return '<div class="dialog-actions mt2"><button type="button" class="btn btn-secondary" data-action="close-modal">Batal</button>'
    + '<button type="submit" class="btn ' + (danger ? 'btn-danger-solid' : 'btn-primary') + '">' + esc(submitLabel) + '</button></div>';
}

function generatePassword(length) {
  const sets = ['abcdefghjkmnpqrstuvwxyz', 'ABCDEFGHJKMNPQRSTUVWXYZ', '23456789'];
  const all = sets.join('');
  const rnd = (n) => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; };
  const chars = [];
  for (let i = 0; i < length; i++) chars.push(i < sets.length ? sets[i][rnd(sets[i].length)] : all[rnd(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) { const j = rnd(i + 1); const t = chars[i]; chars[i] = chars[j]; chars[j] = t; }
  return chars.join('');
}
async function copyText(text, sourceInput) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall through */ }
  try {
    if (sourceInput) { sourceInput.type = 'text'; sourceInput.select(); return document.execCommand('copy'); }
  } catch (e) { /* ignore */ }
  return false;
}

/* ---------------------------------- views ------------------------------- */
function setView(name) {
  ['boot', 'login', 'denied', 'console'].forEach((key) => { const el = $(key + '-view'); if (el) el.hidden = key !== name; });
}
function showLogin(message) {
  ME = null;
  stopPolling();
  setView('login');
  const notice = $('login-notice');
  if (notice) { notice.hidden = !message; notice.textContent = message || ''; }
  const err = $('login-error'); if (err) { err.hidden = true; err.textContent = ''; }
  icons();
  const email = $('login-email');
  if (email && !modalOpen()) email.focus({ preventScroll: true });
}
function showDenied() { setView('denied'); icons(); }
function showConsole() {
  setView('console');
  $('me-label').textContent = ME.email + ' · ' + (ROLE_LABEL[ME.role] || ME.role);
  $('me-label').title = ME.email;   // the line is shortened with "…" on phones
  icons();
}

function resetState() {
  ME = null; SETTINGS = []; ACCOUNTS = [];
  SETTINGS_META.encryption = null;
  Object.assign(ACCOUNTS_PAGE, { total: null, next: null, query: '', filter: '', loading: false, error: '', seq: ACCOUNTS_PAGE.seq + 1 });
  Object.assign(QUEUE, { jobs: [], depth: 0, byStatus: {}, filter: '', limit: 50, loading: false, error: '', seq: QUEUE.seq + 1, html: '' });
  Object.assign(AUDIT, { items: [], next: null, action: '', routine: false, query: '', loading: false, error: '', seq: AUDIT.seq + 1 });
  Object.assign(OVERVIEW, { data: null, at: 0, seq: OVERVIEW.seq + 1, inventory: null, inventoryBusy: false });
  Object.assign(REGS, { items: [], enabled: false, pending: 0, loading: false, error: '', seq: REGS.seq + 1 });
  TABS.forEach((key) => { const panel = $('panel-' + key); if (panel) { panel.innerHTML = ''; delete panel.dataset.sig; } });
  if (modalOpen()) { const host = $('modal'); MODAL.resolve = null; host.hidden = true; host.innerHTML = ''; $('app').inert = false; document.body.classList.remove('modal-open'); }
  const toastRegion = $('toast-region'); if (toastRegion) toastRegion.innerHTML = '';
  ['login-password'].forEach((id) => { const el = $(id); if (el) el.value = ''; });
}
function expireSession(message) {
  resetState();
  showLogin(message);
}

async function submitLogin(form) {
  const email = $('login-email').value.trim();
  const password = $('login-password').value;
  const err = $('login-error');
  err.hidden = true;
  if (!email || !password) { err.textContent = 'Isi email dan kata sandi.'; err.hidden = false; return; }
  $('login-notice').hidden = true;
  await withBusy(form.querySelector('[type="submit"]'), async () => {
    try {
      const payload = await api('/api/auth/login', { method: 'POST', body: { email, password }, auth: true });
      ME = payload.account;
      $('login-password').value = '';
      if (!ME || ME.role !== 'admin') { showDenied(); return; }
      showConsole();
      await switchTab('overview');
    } catch (error) {
      err.textContent = error.message;
      err.hidden = false;
    }
  });
}

async function logout(button) {
  await withBusy(button, async () => { try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch (e) { /* signed out locally anyway */ } });
  resetState();
  showLogin('Anda sudah keluar.');
}

async function switchTab(name) {
  if (TABS.indexOf(name) < 0) name = 'overview';
  ACTIVE_TAB = name;
  TABS.forEach((key) => {
    const tab = $('tab-' + key), panel = $('panel-' + key), on = key === name;
    if (tab) { tab.setAttribute('aria-selected', on ? 'true' : 'false'); tab.tabIndex = on ? 0 : -1; }
    if (panel) panel.hidden = !on;
  });
  syncPolling();
  if (name === 'overview') await loadOverview();
  if (name === 'accounts') await loadAccounts();
  if (name === 'settings') await loadSettings();
  if (name === 'queue') await loadQueue();
  if (name === 'audit') await loadAudit();
  icons();
}

/* ------------------------------ polling --------------------------------- */
function stopPolling() {
  Object.keys(POLL).forEach((key) => { if (POLL[key]) { clearInterval(POLL[key]); POLL[key] = null; } });
}
function syncPolling() {
  stopPolling();
  if (!ME || document.hidden) return;   // nothing is polled while the tab is in the background
  if (ACTIVE_TAB === 'queue' && QUEUE.auto) POLL.queue = setInterval(() => { loadQueue({ silent: true }); }, 10000);
  if (ACTIVE_TAB === 'overview') POLL.overview = setInterval(() => { loadOverview({ silent: true }); }, 30000);
}

/* ------------------------------- overview ------------------------------- */
async function loadOverview(opts = {}) {
  const panel = $('panel-overview');
  if (!OVERVIEW.data && !opts.silent) panel.innerHTML = loadingBlock('Memuat ringkasan…');
  const seq = ++OVERVIEW.seq;
  try {
    const [overview, health, storage, accounts] = await Promise.all([
      api('/api/admin/overview'), api('/api/admin/health'),
      api('/api/admin/storage').catch((error) => (ME ? { unavailable: true, error: error.message } : null)),
      api('/api/admin/accounts?limit=6').catch(() => null),
    ]);
    if (seq !== OVERVIEW.seq || !ME) return;
    const quotaAccounts = Array.isArray(accounts) ? accounts : ((accounts && accounts.items) || []);
    OVERVIEW.data = { overview: overview || {}, health: health || {}, storage: storage || { unavailable: true }, quotaAccounts };
    OVERVIEW.at = Date.now();
    renderOverview();
  } catch (error) {
    if (seq !== OVERVIEW.seq || !ME) return;
    if (opts.silent && OVERVIEW.data) return;
    delete panel.dataset.sig;
    panel.innerHTML = errorBlock(error.message, 'overview-refresh');
    icons();
  }
}

function issueAction(issue) {
  if (issue.action === 'settings') return '<button type="button" class="btn btn-secondary btn-sm" data-action="goto-tab" data-tab="settings">Buka Setelan</button>';
  if (issue.action === 'queue') return '<button type="button" class="btn btn-secondary btn-sm" data-action="goto-tab" data-tab="queue">Buka Antrean</button>';
  if (issue.action === 'storage') return '<button type="button" class="btn btn-secondary btn-sm" data-action="scroll-storage">Lihat penyimpanan</button>';
  return '';
}

function workerCard(o) {
  const w = o.worker;
  let status, rows;
  if (!w) {
    status = badge('Belum ada data', 'badge-unknown');
    rows = [['Terakhir terlihat', 'Server belum melaporkan status worker']];
  } else {
    status = w.authFailing ? badge('Ditolak router', 'badge-severe') : w.stale ? badge('Tidak terlihat', 'badge-severe') : badge('Aktif', 'badge-healthy');
    rows = [['Terakhir terlihat', fmtAgo(w.lastSeenMs)]];
    if (Array.isArray(w.workers)) w.workers.forEach(worker => {
      const state = worker.authFailing ? 'Autentikasi Ditolak' : worker.stale ? 'Tidak Terlihat' : worker.hasError ? 'Perlu Dicek' : 'Aktif';
      rows.push(['Jalur ' + (worker.lane || 'semua') + ' · ' + (worker.worker || 'worker'), state + ' · ' + fmtAgo(worker.lastSeenMs)]);
    });
    if (w.missingLanes?.length) rows.push(['Jalur Belum Melapor', w.missingLanes.join(', ')]);
    if (w.lastError) rows.push(['Kesalahan terakhir', String(w.lastError).slice(0, 160) + (w.lastErrorMs ? ' (' + fmtAgo(w.lastErrorMs) + ')' : '')]);
  }
  rows.push(['Token worker', o.workerTokenConfigured ? 'Sudah diatur' : 'Belum diatur']);
  return '<section class="card" aria-labelledby="card-worker"><div class="a-row a-between"><h3 id="card-worker" class="t-title">Worker AI</h3>' + status + '</div><div class="mt2">' + kv(rows) + '</div></section>';
}

/* Errors reported by farmers' phones in the last 24 hours (0.2.4.15). */
function errorsCard(o) {
  const count = Number(o.clientErrors24h || 0), recent = o.clientErrorsRecent || [];
  const status = count ? badge(num(count) + ' dalam 24 jam', count >= 10 ? 'badge-severe' : 'badge-moderate') : badge('Tidak ada', 'badge-healthy');
  const list = recent.map((r) => '<li class="mt2"><span class="t-meta">' + esc(fmtAgo(r.tsMs)) + ' · ' + esc(r.actor || '—') + '</span><br>'
    + '<span class="break">' + esc(String(r.detail || '').slice(0, 220)) + '</span></li>').join('');
  return '<section class="card" aria-labelledby="card-errors"><div class="a-row a-between"><h3 id="card-errors" class="t-title">Kesalahan Aplikasi</h3>' + status + '</div>'
    + (list ? '<ul class="mt2">' + list + '</ul>' : '<p class="t-body t-muted mt2">Belum ada laporan kesalahan dari HP pengguna.</p>')
    + (recent.length ? '<button type="button" class="btn btn-secondary btn-block mt3" data-action="audit-errors">' + icon('list') + '<span class="btn-label">Lihat Semua di Audit</span></button>' : '')
    + '</section>';
}

function routerCard(h) {
  return '<section class="card" aria-labelledby="card-router"><h3 id="card-router" class="t-title">Router dan Model</h3><div class="mt2">'
    + kv([['Alamat', h.routerUrl || '—', true], ['Kunci router', h.routerKeyConfigured ? 'Sudah diisi' : 'Belum diisi'],
      ['Model triase', h.triageModel || '—', true], ['Model diagnosis', h.diagnoseModel || '—', true]]) + '</div>'
    + (h.routerUrlProblem ? '<div class="notice notice-error mt3" role="alert">' + icon('circle-alert') + '<span>' + esc(h.routerUrlProblem) + '</span></div>' : '')
    + '<div id="overview-router-test" class="mt3" role="status" aria-live="polite"></div>'
    + '<button type="button" class="btn btn-secondary btn-block mt3" data-action="overview-test-router">' + icon('plug-zap') + '<span class="btn-label">Uji koneksi router</span></button></section>';
}

function queueCard(o) {
  const by = o.byStatus || {};
  const rows = [['Menunggu', num(by.queued || 0)], ['Sedang dikerjakan', num(by.claimed || 0)]];
  if (o.delayedJobs) rows.push(['Ditunda sementara', num(o.delayedJobs)]);
  rows.push(['Foto tertua menunggu', o.oldestQueuedMs ? fmtAgo(o.oldestQueuedMs).replace(' lalu', '') : 'tidak ada']);
  return '<section class="card" aria-labelledby="card-queue"><h3 id="card-queue" class="t-title">Antrean Analisis</h3><div class="mt2">' + kv(rows) + '</div>'
    + '<button type="button" class="btn btn-secondary btn-block mt3" data-action="goto-tab" data-tab="queue">Buka Antrean</button></section>';
}

function inventoryHtml(inv) {
  if (!inv) return '';
  if (inv.error) return '<div class="notice notice-error mt3" role="alert">' + icon('circle-alert') + '<span>' + esc(inv.error) + '</span></div>';
  const list = (inv.unreferenced || []).slice(0, 50).map((f) => '<li class="mt2"><span class="mono break">' + esc(f.name) + '</span><br><span class="t-meta">' + fmtBytes(f.size) + ' · diubah ' + fmtTime(f.mtimeMs) + '</span></li>').join('');
  const more = (inv.unreferencedCount || 0) > 50 ? '<p class="t-meta mt2">Menampilkan 50 dari ' + num(inv.unreferencedCount) + ' berkas.</p>' : '';
  return '<div class="notice notice-info mt3">' + icon('info') + '<span>Hanya laporan. Tidak ada berkas yang dihapus atau dipindahkan.</span></div>'
    + '<div class="mt3">' + kv([['Berkas di penyimpanan', num(inv.files)], ['Dipakai catatan', num(inv.referenced)], ['Tanpa catatan', num(inv.unreferencedCount) + ' · ' + fmtBytes(inv.unreferencedBytes)]]) + '</div>'
    + (list ? '<ul>' + list + '</ul>' + more : '<p class="t-body mt2">Tidak ada foto tanpa catatan.</p>');
}

function storageCard(s) {
  let body;
  if (!s || s.unavailable) {
    body = '<p class="t-body t-muted mt2">Status penyimpanan belum tersedia di server ini.' + (s && s.error ? '<br><span class="t-meta">' + esc(s.error) + '</span>' : '') + '</p>';
  } else {
    const rows = [['Menunggu dibersihkan', num(s.pending)], ['Perlu ditinjau', num(s.blocked)], ['Sudah bersih', num(s.done)]];
    if (s.oldestPendingMs) rows.push(['Tertua menunggu', fmtAgo(s.oldestPendingMs).replace(' lalu', '')]);
    rows.push(['Terakhir diproses', s.lastDrainMs ? fmtAgo(s.lastDrainMs) : 'belum pernah']);
    const reasons = Object.keys(s.blockedReasons || {}).map((k) => '<li class="t-meta">' + esc(k) + ': ' + num(s.blockedReasons[k]) + '</li>').join('');
    body = '<div class="mt2">' + kv(rows) + '</div>' + (reasons ? '<ul class="mt2">' + reasons + '</ul>' : '');
  }
  return '<section class="card" id="storage-card" tabindex="-1" aria-labelledby="card-storage"><h3 id="card-storage" class="t-title">Foto di Server</h3>' + body
    + '<button type="button" class="btn btn-secondary btn-block mt3" data-action="storage-inventory"' + (s && s.unavailable ? ' disabled' : '') + '>' + icon('folder-search') + '<span class="btn-label">Periksa foto tanpa catatan</span></button>'
    + '<div id="inventory-result" role="status" aria-live="polite">' + inventoryHtml(OVERVIEW.inventory) + '</div></section>';
}

function quotaBarHtml(a) {
  const used = Number.isFinite(a.fastUsed) ? a.fastUsed : 0;
  const quota = Number.isFinite(a.fastQuota) && a.fastQuota > 0 ? a.fastQuota : null;
  if (!quota) return '<span class="t-meta">' + esc(quotaText(a)) + '</span>';
  const pct = Math.max(0, Math.min(100, Math.round((used / quota) * 100)));
  const fillCls = pct >= 100 ? ' is-bad' : pct >= 80 ? ' is-warn' : '';
  return '<div class="quota-wrap"><div class="quota-track"><div class="quota-fill' + fillCls + '" style="width:' + pct + '%"></div></div>'
    + '<span class="t-meta tnum">' + esc(quotaText(a)) + '</span></div>';
}

function quotaOverviewCard(accounts) {
  if (!Array.isArray(accounts) || !accounts.length) return '';
  const rows = accounts.slice(0, 6).map((a) => '<tr role="row">'
    + '<td role="cell"><div class="bold break">' + esc(a.name || a.email) + '</div>'
    + (a.name ? '<div class="t-meta break">' + esc(a.email) + '</div>' : '') + '</td>'
    + '<td role="cell" class="fit">' + badge(ROLE_LABEL[a.role] || a.role, ROLE_BADGE[a.role]) + '</td>'
    + '<td role="cell">' + quotaBarHtml(a) + '</td>'
    + '<td role="cell" class="t-meta tnum">' + num(a.recordCount) + ' catatan · ' + num(a.jobCount) + ' foto</td></tr>').join('');
  return '<section class="card a-stack-16" aria-labelledby="card-quota-overview">'
    + '<div class="a-row a-between"><h3 id="card-quota-overview" class="t-title">Ringkasan Penggunaan Kuota Jalur Cepat</h3>'
    + '<button type="button" class="btn btn-secondary btn-sm" data-action="goto-tab" data-tab="accounts">Semua akun</button></div>'
    + '<table class="rtable" role="table"><caption class="sr-only">Penggunaan kuota jalur cepat</caption>'
    + '<thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col">Akun</th><th role="columnheader" scope="col">Peran</th><th role="columnheader" scope="col">Kuota Hari Ini</th><th role="columnheader" scope="col">Aktivitas</th></tr></thead>'
    + '<tbody role="rowgroup">' + rows + '</tbody></table></section>';
}

function renderOverview() {
  const d = OVERVIEW.data;
  if (!d) return;
  const o = d.overview, h = d.health;
  const pipe = o.pipeline || { level: 'ok', title: 'Semua berjalan baik', issues: [] };
  const level = pipe.level === 'bad' ? 'bad' : pipe.level === 'warn' ? 'warn' : 'ok';
  const bannerCls = level === 'bad' ? ' is-bad' : level === 'warn' ? ' is-warn' : '';
  const statusLabel = level === 'ok' ? 'Semua Layanan Sehat · Router AI Aktif' : level === 'warn' ? 'Peringatan Layanan' : 'Gangguan Layanan';
  const issues = (pipe.issues || []).map((i) => '<li><span class="t-body">' + esc(i.text) + '</span>' + issueAction(i) + '</li>').join('');
  const by = o.byStatus || {};
  const html = '<h2 class="sr-only">Beranda</h2>'
    + '<section class="health-banner' + bannerCls + '" aria-labelledby="health-title"><div class="health-banner-head">'
    + '<div class="a-grow"><span class="status-pill"><span class="dot"></span><span>' + esc(statusLabel) + '</span></span>'
    + '<h2 id="health-title">' + esc(pipe.title || '') + '</h2>'
    + '<p class="t-meta mt1">Diperbarui ' + fmtAgo(OVERVIEW.at) + ' · Worker aktif &amp; antrean terpantau</p></div>'
    + '<div class="a-row-8 a-none"><button type="button" class="btn btn-primary btn-sm" data-action="goto-tab" data-tab="accounts">' + icon('users') + '<span>Kelola Akun Petani</span></button>'
    + '<button type="button" class="btn btn-secondary btn-sm btn-icon" data-action="overview-refresh" aria-label="Muat ulang beranda">' + icon('refresh-cw') + '</button></div></div>'
    + (issues ? '<ul class="issues">' + issues + '</ul>' : '') + '</section>'
    + '<div class="kpi-grid tnum">'
    + '<div class="kpi-card"><span class="kpi-label">Akun Terdaftar</span><span class="kpi-val">' + num(o.accounts) + '</span><span class="kpi-sub">' + num(o.activeAccounts) + ' aktif · ' + num(o.activeSessions) + ' sesi</span></div>'
    + '<div class="kpi-card"><span class="kpi-label">Analisis 24 Jam</span><span class="kpi-val">' + num(o.jobs24h) + '</span><span class="kpi-sub">' + num(o.jobs24hDone) + ' selesai · ' + num(o.jobs24hRejected || 0) + ' ditolak</span></div>'
    + '<div class="kpi-card"><span class="kpi-label">Kesalahan Aplikasi</span><span class="kpi-val">' + num(o.clientErrors24h || 0) + '</span><span class="kpi-sub">Laporan HP dalam 24 jam</span></div>'
    + '<div class="kpi-card"><span class="kpi-label">Antrean &amp; Basis Data</span><span class="kpi-val">' + num((by.queued || 0) + (by.claimed || 0)) + '</span><span class="kpi-sub">' + esc(fmtBytes(o.dbBytes)) + ' · skema v' + esc(o.schemaVersion || '?') + '</span></div>'
    + '</div>'
    + quotaOverviewCard(d.quotaAccounts)
    + '<section class="card" aria-labelledby="quick-title"><h3 id="quick-title" class="section-title">Pekerjaan Cepat</h3>'
    + '<div class="btn-stack quick"><button type="button" class="btn btn-primary" data-action="quick-create-account">' + icon('user-plus') + '<span class="btn-label">Buat akun petani</span></button>'
    + '<button type="button" class="btn btn-secondary" data-action="quick-problem-queue">' + icon('rotate-ccw') + '<span class="btn-label">Lihat foto bermasalah</span></button>'
    + (o.pendingRegistrations ? '<button type="button" class="btn btn-secondary" data-action="goto-tab" data-tab="accounts">' + icon('user-check') + '<span class="btn-label">Pendaftaran menunggu: ' + num(o.pendingRegistrations) + '</span></button>' : '')
    + '</div></section>'
    + '<div class="a-cards">' + workerCard(o) + routerCard(h) + queueCard(o) + storageCard(d.storage) + errorsCard(o) + '</div>'
    + '<div><h3 class="section-title">Ringkasan 24 Jam</h3><div class="a-grid2 a-grid4">'
    + tile('Akun', num(o.accounts), num(o.activeAccounts) + ' aktif') + tile('Sesi aktif', num(o.activeSessions), 'sedang masuk')
    + tile('Foto 24 jam', num(o.jobs24h), num(o.jobs24hDone) + ' selesai') + tile('Ditolak', num(o.jobs24hRejected), Math.round((o.rejectRate || 0) * 100) + '% dari 24 jam')
    + tile('Basis data', fmtBytes(o.dbBytes), 'skema v' + (o.schemaVersion || '?')) + tile('Selesai (semua)', num(by.done || 0), num((by.rejected || 0) + (by.failed || 0)) + ' ditolak/gagal')
    + tile('Pendaftaran', o.registrationOpen ? 'Terbuka' : 'Tertutup', 'ubah di Setelan', true) + tile('Kesalahan aplikasi', num(o.clientErrors24h || 0), 'laporan dari HP, 24 jam', true)
    + '</div></div>';
  keepFocus($('panel-overview'), () => { if (setHtml($('panel-overview'), html)) icons(); });
}

async function testRouterStored(button) {
  const box = $('overview-router-test');
  if (box) box.innerHTML = '<p class="t-meta">Menguji…</p>';
  await withBusy(button, async () => {
    try { const r = await api('/api/admin/settings/test-router', { method: 'POST', body: {} }); if (box) { box.innerHTML = routerResultHtml(r); icons(); } }
    catch (error) { if (box) { box.innerHTML = '<div class="notice notice-error" role="alert">' + icon('circle-alert') + '<span>' + esc(error.message) + '</span></div>'; icons(); } }
  });
}

async function runInventory(button) {
  await withBusy(button, async () => {
    try { OVERVIEW.inventory = await api('/api/admin/storage/inventory', { method: 'POST', body: {}, timeout: 180000 }); }
    catch (error) { OVERVIEW.inventory = { error: error.message }; }
    const box = $('inventory-result');
    if (box) { box.innerHTML = inventoryHtml(OVERVIEW.inventory); icons(); }
    if (OVERVIEW.data) delete $('panel-overview').dataset.sig;
  });
}

function routerResultHtml(r) {
  const ok = !!r.ok;
  const lines = ['<div class="notice ' + (ok ? 'notice-ok' : 'notice-error') + '">' + icon(ok ? 'circle-check' : 'circle-alert') + '<span><b>' + esc(r.detail || '') + '</b></span></div>'];
  const facts = [];
  if (r.testedUrl) facts.push(['Yang diuji', r.testedUrl, true]);
  if (r.reachable !== undefined && !r.policy) facts.push(['Router terjangkau', r.reachable ? 'ya' : 'tidak']);
  if (r.authorised !== undefined && r.reachable && !r.policy) facts.push(['Kunci diterima', r.authorised ? 'ya' : 'tidak']);
  if (r.modelCount !== undefined) facts.push(['Jumlah model', num(r.modelCount)]);
  if (r.triageModel) facts.push(['Model triase', r.triageModel + (r.triageFound ? ' (ada)' : ' (TIDAK ada)'), true]);
  if (r.diagnoseModel) facts.push(['Model diagnosis', r.diagnoseModel + (r.diagnoseFound ? ' (ada)' : ' (TIDAK ada)'), true]);
  if (facts.length) lines.push('<div class="mt2">' + kv(facts) + '</div>');
  if (Array.isArray(r.probes)) lines.push('<ul class="issues">' + r.probes.map(p => '<li><b>' + esc(p.route) + '</b>: ' + esc(p.detail) + (p.resolvedModel ? ' (' + esc(p.resolvedModel) + ')' : '') + '<p class="hint">Gambar: ' + (p.visionMatch ? 'sesuai' : 'belum sesuai') + ' · JSON: ' + (p.schemaValid ? 'valid' : 'tidak valid') + ' · ' + num(p.latencyMs) + ' ms</p></li>').join('') + '</ul>');
  if (r.limitation) lines.push('<p class="hint">' + esc(r.limitation) + '</p>');
  return lines.join('');
}

/* ------------------------------- accounts ------------------------------- */
function ensureAccountsShell() {
  const panel = $('panel-accounts');
  if ($('accounts-list')) return;
  panel.innerHTML = '<h2 class="sr-only">Akun</h2><div id="registrations"></div><section class="card a-stack-16" aria-label="Daftar akun">'
    + '<div class="toolbar"><div><label class="sr-only" for="account-search">Cari akun</label>'
    + '<input id="account-search" class="input" type="search" placeholder="Cari nama atau email" autocomplete="off" enterkeyhint="search" data-input="account-search"></div>'
    + '<div><label class="sr-only" for="account-filter">Saring akun</label><select id="account-filter" class="input" data-change="account-filter">'
    + '<option value="">Semua akun</option><option value="user">Normal</option><option value="priority">Prioritas</option><option value="admin">Admin</option><option value="inactive">Nonaktif</option></select></div>'
    + '<button type="button" class="btn btn-primary" data-action="create-account">' + icon('user-plus') + '<span class="btn-label">Buat akun</span></button></div>'
    + '<p id="accounts-count" class="t-meta" aria-live="polite"></p><div id="accounts-list"></div><div id="accounts-more"></div></section>';
  icons();
}

async function loadAccounts(opts = {}) {
  ensureAccountsShell();
  if (!opts.append) loadRegistrations();
  const seq = ++ACCOUNTS_PAGE.seq;
  ACCOUNTS_PAGE.loading = true;
  ACCOUNTS_PAGE.error = '';
  if (!opts.append && !opts.silent && !ACCOUNTS.length) renderAccounts();
  const params = new URLSearchParams({ limit: String(ACCOUNTS_PAGE_SIZE) });
  if (ACCOUNTS_PAGE.query) params.set('q', ACCOUNTS_PAGE.query);
  if (ACCOUNTS_PAGE.filter === 'inactive') params.set('status', 'inactive');
  else if (ACCOUNTS_PAGE.filter) params.set('role', ACCOUNTS_PAGE.filter);
  if (opts.append && ACCOUNTS_PAGE.next) params.set('cursor', ACCOUNTS_PAGE.next);
  try {
    const payload = await api('/api/admin/accounts?' + params.toString());
    if (seq !== ACCOUNTS_PAGE.seq || !ME) return;
    const items = Array.isArray(payload) ? payload : ((payload && payload.items) || []);
    ACCOUNTS = opts.append ? ACCOUNTS.concat(items) : items;
    ACCOUNTS_PAGE.total = Array.isArray(payload) ? items.length : (payload && payload.total);
    ACCOUNTS_PAGE.next = Array.isArray(payload) ? null : ((payload && payload.next) || null);
  } catch (error) {
    if (seq !== ACCOUNTS_PAGE.seq || !ME) return;
    ACCOUNTS_PAGE.error = error.message;
  }
  ACCOUNTS_PAGE.loading = false;
  renderAccounts();
}

function quotaText(a) {
  const used = Number.isFinite(a.fastUsed) ? a.fastUsed : null;
  if (a.role === 'admin' && a.fastQuota === null) return (used === null ? '?' : num(used)) + ' dipakai, tanpa batas';
  if (Number.isFinite(a.fastQuota)) return (used === null ? '?' : num(used)) + ' dari ' + num(a.fastQuota);
  return 'Belum tersedia';
}

function accountRow(a) {
  const title = a.name || a.email;
  const who = esc(a.email);
  return '<tr role="row"><td role="cell"><div class="bold break">' + esc(title) + '</div>'
    + (a.name ? '<div class="t-meta break">' + who + '</div>' : '') + '</td>'
    + '<td role="cell" class="fit">' + badge(ROLE_LABEL[a.role] || a.role, ROLE_BADGE[a.role]) + (a.isActive === false ? ' ' + badge('Nonaktif', 'badge-severe') : '')
    + (a.googleLinked ? ' ' + badge('Google', 'badge-unknown') : '') + '</td>'
    + '<td role="cell"><span class="sm-only t-muted">Analisis cepat hari ini: </span>' + quotaBarHtml(a) + '</td>'
    + '<td role="cell" class="t-meta">' + num(a.recordCount) + ' catatan · ' + num(a.jobCount) + ' foto · ' + num(a.farmCount) + ' petak</td>'
    + '<td role="cell" class="t-meta"><span class="sm-only">Masuk terakhir </span>' + esc(a.lastLoginMs ? fmtAgo(a.lastLoginMs) : 'belum pernah') + ' · ' + num(a.sessionCount) + ' sesi</td>'
    + '<td role="cell" class="acts"><div class="btn-row">'
    + '<button type="button" class="btn btn-secondary btn-sm" data-action="edit-account" data-id="' + esc(a.id) + '" aria-label="Ubah akun ' + esc(a.email) + '">Ubah</button>'
    + '<button type="button" class="btn btn-secondary btn-sm" data-action="reset-password" data-id="' + esc(a.id) + '" aria-label="Atur ulang kata sandi ' + esc(a.email) + '">Sandi</button>'
    + '<button type="button" class="btn btn-danger btn-sm" data-action="delete-account" data-id="' + esc(a.id) + '" aria-label="Hapus akun ' + esc(a.email) + '">Hapus</button></div></td></tr>';
}

function renderAccounts() {
  ensureAccountsShell();
  let html;
  if (ACCOUNTS.length) {
    html = '<table class="rtable" role="table"><caption class="sr-only">Daftar akun</caption><thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col">Akun</th><th role="columnheader" scope="col">Peran</th>'
      + '<th role="columnheader" scope="col">Analisis cepat hari ini</th><th role="columnheader" scope="col">Data</th><th role="columnheader" scope="col">Aktivitas</th><th role="columnheader" scope="col"><span class="sr-only">Tindakan</span></th></tr></thead>'
      + '<tbody role="rowgroup">' + ACCOUNTS.map(accountRow).join('') + '</tbody></table>';
  } else if (ACCOUNTS_PAGE.loading) html = loadingBlock('Memuat akun…').replace('class="card"', 'class=""');
  else if (ACCOUNTS_PAGE.error) html = '<div class="notice notice-error" role="alert">' + icon('circle-alert') + '<span>' + esc(ACCOUNTS_PAGE.error) + '</span></div>'
    + '<button type="button" class="btn btn-secondary mt3" data-action="accounts-retry">Coba lagi</button>';
  else html = '<p class="t-body t-muted">' + (ACCOUNTS_PAGE.query || ACCOUNTS_PAGE.filter ? 'Tidak ada akun yang cocok.' : 'Belum ada akun.') + '</p>';
  keepFocus($('accounts-list'), () => setHtml($('accounts-list'), html));
  const shown = ACCOUNTS.length;
  const total = Number.isFinite(ACCOUNTS_PAGE.total) ? ACCOUNTS_PAGE.total : shown;
  $('accounts-count').textContent = shown ? 'Menampilkan ' + num(shown) + ' dari ' + num(total) + ' akun' : '';
  setHtml($('accounts-more'), ACCOUNTS_PAGE.next
    ? '<button type="button" class="btn btn-secondary btn-block mt3" data-action="accounts-more">Muat lebih banyak</button>' : '');
  icons();
}

/* ---------------------------- registration inbox ------------------------- */
/* People who asked to join with "Masuk dengan Google". Approving creates a farmer account (no password; Google signs
   it in); both decisions ask for the admin's own password and are audited on the server. */
async function loadRegistrations() {
  const seq = ++REGS.seq;
  REGS.loading = true;
  try {
    const payload = await api('/api/admin/registrations');
    if (seq !== REGS.seq || !ME) return;
    REGS.items = (payload && payload.items) || [];
    REGS.enabled = !!(payload && payload.enabled);
    REGS.pending = Number(payload && payload.pending) || REGS.items.length;
    REGS.error = '';
  } catch (error) {
    if (seq !== REGS.seq || !ME) return;
    REGS.error = error.message;
  }
  REGS.loading = false;
  renderRegistrations();
}

function registrationRow(r) {
  return '<li><div class="a-grow"><div class="bold break">' + esc(r.name || r.email) + '</div>'
    + '<div class="t-meta break">' + (r.name ? esc(r.email) + ' · ' : '') + 'minta masuk ' + esc(fmtTime(r.createdMs)) + '</div></div>'
    + '<div class="btn-row"><button type="button" class="btn btn-primary btn-sm" data-action="reg-approve" data-id="' + esc(r.id) + '" aria-label="Setujui ' + esc(r.email) + '">Setujui</button>'
    + '<button type="button" class="btn btn-danger btn-sm" data-action="reg-reject" data-id="' + esc(r.id) + '" aria-label="Tolak ' + esc(r.email) + '">Tolak</button></div></li>';
}

function renderRegistrations() {
  const host = $('registrations');
  if (!host) return;
  if (!REGS.enabled && !REGS.items.length && !REGS.error) { setHtml(host, ''); return; }
  let body;
  if (REGS.error) body = '<div class="notice notice-error" role="alert">' + icon('circle-alert') + '<span>' + esc(REGS.error) + '</span></div>';
  else if (REGS.items.length) body = '<ul class="reg-list">' + REGS.items.map(registrationRow).join('') + '</ul>';
  else body = '<p class="t-body t-muted">Tidak ada permintaan baru.</p>';
  const html = '<section class="card a-stack" aria-labelledby="regs-title"><div class="a-row a-between"><h3 id="regs-title" class="t-title">Pendaftaran</h3>'
    + (REGS.items.length ? badge(num(REGS.items.length) + ' menunggu', 'badge-moderate') : '') + '</div>'
    + '<p class="t-meta">Orang yang meminta akses lewat akun Google. Setujui untuk membuatkan akun petani.</p>' + body + '</section>';
  keepFocus(host, () => { if (setHtml(host, html)) icons(); });
}

function decideRegistration(id, decision) {
  const r = REGS.items.find((x) => x.id === id);
  if (!r) return;
  const approve = decision === 'approve';
  openModal('<form data-form="registration" data-id="' + esc(r.id) + '" data-decision="' + (approve ? 'approve' : 'reject') + '" class="a-stack-16" novalidate>'
    + '<h2 id="modal-title" class="t-title">' + (approve ? 'Setujui Pendaftaran?' : 'Tolak Pendaftaran?') + '</h2>'
    + '<div><p class="bold break">' + esc(r.email) + '</p>' + (r.name ? '<p class="t-meta break mt1">' + esc(r.name) + '</p>' : '') + '</div>'
    + '<p class="t-body">' + (approve ? 'Akun petani dibuat dan orang ini bisa langsung masuk dengan Google. Masuk dengan kata sandi baru bisa setelah Anda mengatur kata sandinya.'
      : 'Orang ini tidak bisa masuk dengan akun Google ini.') + '</p>'
    + passwordField({ id: 'rg-reauth', label: 'Kata sandi Anda (konfirmasi)', autocomplete: 'current-password', hint: 'Diminta untuk tindakan yang sensitif.' })
    + '<div id="modal-error" class="notice notice-error" role="alert" hidden></div>' + dialogButtons(approve ? 'Setujui' : 'Tolak', !approve) + '</form>', { dismissOnBackdrop: false });
}

async function submitRegistration(form) {
  clearModalError();
  const r = REGS.items.find((x) => x.id === form.dataset.id);
  if (!r) return closeModal();
  const approve = form.dataset.decision === 'approve';
  const reauth = $('rg-reauth').value;
  if (!reauth) return showModalError('Masukkan kata sandi Anda untuk melanjutkan.', 'rg-reauth');
  await withBusy(form.querySelector('[type="submit"]'), async () => {
    try {
      await api('/api/admin/registrations/' + encodeURIComponent(r.id) + '/' + (approve ? 'approve' : 'reject'), { method: 'POST', body: { currentPassword: reauth } });
      closeModal();
      toast(approve ? 'Disetujui. Akun dibuat untuk ' + r.email : 'Permintaan ' + r.email + ' ditolak.', 'ok');
      await loadAccounts({ silent: true });
    } catch (error) {
      if (error.code === 'registration_decided' || error.status === 404) { closeModal(); toast(error.message, 'warn'); loadRegistrations(); return; }
      showModalError(error.message, error.code && error.code.indexOf('reauth') === 0 ? 'rg-reauth' : null);
    }
  });
  return undefined;
}

function roleOptions(selected) {
  return ['user', 'priority', 'admin'].map((r) => '<option value="' + r + '"' + (r === selected ? ' selected' : '') + '>' + ROLE_LABEL[r] + '</option>').join('');
}
function passwordMinimum(role) { return role === 'admin' ? 12 : 8; }

function createAccount() {
  openModal('<form data-form="create-account" class="a-stack-16" novalidate><h2 id="modal-title" class="t-title">Buat Akun</h2>'
    + field({ id: 'na-email', label: 'Email', type: 'email', autocomplete: 'off', inputmode: 'email' })
    + field({ id: 'na-name', label: 'Nama', autocomplete: 'off', maxlength: 120 })
    + '<div><label class="label" for="na-role">Peran</label><select id="na-role" class="input" data-change="role-select" data-prefix="na">' + roleOptions('user') + '</select><p class="hint">' + esc(TIER_NOTE) + '</p></div>'
    + newPasswordFields('na', 8) + reauthBox('na-reauth', 'Membuat admin baru perlu kata sandi Anda.')
    + '<div id="modal-error" class="notice notice-error" role="alert" hidden></div>' + dialogButtons('Simpan') + '</form>', { dismissOnBackdrop: false });
}

function toggleReauth(prefix, needed) { const box = $(prefix + '-reauth-box'); if (box) box.hidden = !needed; }

async function submitCreateAccount(form) {
  clearModalError();
  const email = $('na-email').value.trim(), name = $('na-name').value.trim();
  const role = $('na-role').value, pw = $('na-password').value, pw2 = $('na-password2').value;
  const reauth = $('na-reauth') ? $('na-reauth').value : '';
  if (!/^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/.test(email)) return showModalError('Email belum benar. Contoh: nama@contoh.com', 'na-email');
  if (pw.length < passwordMinimum(role)) return showModalError('Kata sandi minimal ' + passwordMinimum(role) + ' karakter.', 'na-password');
  if (pw !== pw2) return showModalError('Kata sandi dan ulangannya tidak sama.', 'na-password2');
  if (role === 'admin' && !reauth) return showModalError('Masukkan kata sandi Anda untuk membuat admin.', 'na-reauth');
  await withBusy(form.querySelector('[type="submit"]'), async () => {
    try {
      const body = { email, name, password: pw, passwordConfirm: pw2, role };
      if (role === 'admin') body.currentPassword = reauth;
      await api('/api/admin/accounts', { method: 'POST', body });
      closeModal();
      toast('Akun dibuat: ' + email, 'ok');
      await loadAccounts({ silent: true });
    } catch (error) { showModalError(error.message, /sandi anda/i.test(error.message) || error.code && error.code.indexOf('reauth') === 0 ? 'na-reauth' : null); }
  });
}

function editAccount(id) {
  const a = ACCOUNTS.find((x) => x.id === id);
  if (!a) return;
  openModal('<form data-form="edit-account" data-id="' + esc(a.id) + '" class="a-stack-16" novalidate><h2 id="modal-title" class="t-title">Ubah Akun</h2>'
    + field({ id: 'ea-name', label: 'Nama', value: a.name || '', maxlength: 120, autocomplete: 'off' })
    + field({ id: 'ea-email', label: 'Email', type: 'email', value: a.email, autocomplete: 'off', inputmode: 'email' })
    + '<div><label class="label" for="ea-role">Peran</label><select id="ea-role" class="input" data-change="role-select" data-prefix="ea">' + roleOptions(a.role) + '</select><p class="hint">' + esc(TIER_NOTE) + '</p></div>'
    + '<label class="check"><input id="ea-active" type="checkbox"' + (a.isActive === false ? '' : ' checked') + '><span>Akun aktif</span></label>'
    + reauthBox('ea-reauth', 'Diperlukan untuk menjadikan akun ini admin atau mengubah email admin.')
    + '<div id="ea-summary" class="notice notice-warn" role="alert" hidden></div>'
    + '<div id="modal-error" class="notice notice-error" role="alert" hidden></div>' + dialogButtons('Simpan') + '</form>', { dismissOnBackdrop: false });
}

function editChanges(a) {
  const changes = [];
  const name = $('ea-name').value.trim(), email = $('ea-email').value.trim(), role = $('ea-role').value, active = $('ea-active').checked;
  if (name !== (a.name || '')) changes.push({ text: 'Nama menjadi "' + name + '"', risky: false });
  if (email !== a.email) changes.push({ text: 'Email menjadi ' + email, risky: a.role === 'admin' });
  if (role !== a.role) changes.push({ text: 'Peran menjadi ' + ROLE_LABEL[role] + (role === 'admin' ? ' (bisa mengelola semua akun dan pengaturan)' : ''), risky: true });
  if (active !== (a.isActive !== false)) changes.push({ text: active ? 'Akun diaktifkan lagi' : 'Akun dinonaktifkan (langsung dikeluarkan dari semua perangkat)', risky: !active });
  return { changes, name, email, role, active, grantsAdmin: role === 'admin' && a.role !== 'admin', retargetsAdmin: a.role === 'admin' && email.toLowerCase() !== a.email.toLowerCase() };
}

async function submitEditAccount(form) {
  clearModalError();
  const a = ACCOUNTS.find((x) => x.id === form.dataset.id);
  if (!a) return closeModal();
  const c = editChanges(a);
  if (!c.changes.length) { closeModal(); toast('Tidak ada perubahan.'); return undefined; }
  if (!/^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/.test(c.email)) return showModalError('Email belum benar. Contoh: nama@contoh.com', 'ea-email');
  const needReauth = c.grantsAdmin || c.retargetsAdmin;
  toggleReauth('ea', needReauth);
  const reauth = $('ea-reauth') ? $('ea-reauth').value : '';
  if (needReauth && !reauth) return showModalError('Masukkan kata sandi Anda untuk melanjutkan.', 'ea-reauth');
  if (c.changes.some((x) => x.risky) && form.dataset.confirmed !== '1') {
    const summary = $('ea-summary');
    summary.innerHTML = icon('triangle-alert') + '<span>Anda akan:<br>' + c.changes.map((x) => '• ' + esc(x.text)).join('<br>') + '<br><b>Tekan "Ya, simpan" untuk melanjutkan.</b></span>';
    summary.hidden = false;
    form.dataset.confirmed = '1';
    form.querySelector('[type="submit"]').textContent = 'Ya, simpan';
    icons();
    return undefined;
  }
  await withBusy(form.querySelector('[type="submit"]'), async () => {
    try {
      const body = { name: c.name, email: c.email, role: c.role, isActive: c.active };
      if (needReauth) body.currentPassword = reauth;
      await api('/api/admin/accounts/' + encodeURIComponent(a.id), { method: 'PUT', body });
      closeModal();
      toast('Akun diperbarui.', 'ok');
      await loadAccounts({ silent: true });
    } catch (error) { showModalError(error.message, error.code && error.code.indexOf('reauth') === 0 ? 'ea-reauth' : null); }
  });
  return undefined;
}

function resetPassword(id) {
  const a = ACCOUNTS.find((x) => x.id === id);
  if (!a) return;
  const own = ME && a.id === ME.id;
  const note = own ? 'Ini akun Anda sendiri. Anda tetap masuk di perangkat ini; perangkat lain akan keluar.'
    : 'Pemilik akun akan keluar dari semua perangkat dan harus masuk dengan kata sandi baru.';
  openModal('<form data-form="reset-password" data-id="' + esc(a.id) + '" class="a-stack-16" novalidate><h2 id="modal-title" class="t-title">Atur Ulang Kata Sandi</h2>'
    + '<div><p class="bold break">' + esc(a.email) + '</p><p class="t-meta mt1">' + esc(note) + '</p></div>'
    + newPasswordFields('rp', passwordMinimum(a.role)) + (a.role === 'admin' ? reauthBox('rp-reauth', 'Mengubah kata sandi admin perlu kata sandi Anda.') : '')
    + '<div id="modal-error" class="notice notice-error" role="alert" hidden></div>' + dialogButtons('Simpan') + '</form>', { dismissOnBackdrop: false });
  if (a.role === 'admin') toggleReauth('rp', true);
}

async function submitResetPassword(form) {
  clearModalError();
  const a = ACCOUNTS.find((x) => x.id === form.dataset.id);
  if (!a) return closeModal();
  const pw = $('rp-password').value, pw2 = $('rp-password2').value, reauth = $('rp-reauth') ? $('rp-reauth').value : '';
  if (pw.length < passwordMinimum(a.role)) return showModalError('Kata sandi minimal ' + passwordMinimum(a.role) + ' karakter.', 'rp-password');
  if (pw !== pw2) return showModalError('Kata sandi dan ulangannya tidak sama.', 'rp-password2');
  if (a.role === 'admin' && !reauth) return showModalError('Masukkan kata sandi Anda untuk melanjutkan.', 'rp-reauth');
  await withBusy(form.querySelector('[type="submit"]'), async () => {
    try {
      const body = { password: pw, passwordConfirm: pw2 };
      if (a.role === 'admin') body.currentPassword = reauth;
      const result = await api('/api/admin/accounts/' + encodeURIComponent(a.id) + '/password', { method: 'POST', body });
      closeModal();
      toast('Kata sandi diatur ulang. ' + num(result.revokedSessions) + ' sesi dikeluarkan.', 'ok');
      await loadAccounts({ silent: true });
    } catch (error) { showModalError(error.message, error.code && error.code.indexOf('reauth') === 0 ? 'rp-reauth' : null); }
  });
  return undefined;
}

function deleteAccount(id) {
  const a = ACCOUNTS.find((x) => x.id === id);
  if (!a) return;
  openModal('<form data-form="delete-account" data-id="' + esc(a.id) + '" class="a-stack-16" novalidate><h2 id="modal-title" class="t-title">Hapus Akun</h2>'
    + '<p class="t-body">Semua data akun ini akan dihapus permanen: ' + num(a.recordCount) + ' catatan, ' + num(a.jobCount) + ' foto analisis, ' + num(a.farmCount) + ' petak. Foto di server dibersihkan otomatis.</p>'
    + '<div><label class="label" for="del-confirm">Ketik <b class="break">' + esc(a.email) + '</b> untuk menghapus</label>'
    + '<input id="del-confirm" class="input" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="' + esc(a.email) + '" data-input="delete-confirm" data-email="' + esc(a.email) + '"></div>'
    + '<div id="modal-error" class="notice notice-error" role="alert" hidden></div>'
    + '<div class="dialog-actions"><button type="button" class="btn btn-secondary" data-action="close-modal">Batal</button>'
    + '<button type="submit" class="btn btn-danger-solid" id="del-submit" disabled>Hapus permanen</button></div></form>', { dismissOnBackdrop: false });
}

async function submitDeleteAccount(form) {
  clearModalError();
  const a = ACCOUNTS.find((x) => x.id === form.dataset.id);
  if (!a) return closeModal();
  if ($('del-confirm').value.trim() !== a.email) return showModalError('Email konfirmasi belum sama.', 'del-confirm');
  await withBusy($('del-submit'), async () => {
    try {
      const r = await api('/api/admin/accounts/' + encodeURIComponent(a.id), { method: 'DELETE' });
      closeModal();
      const p = r.photoCleanup;
      if (p) {
        const cleaned = Number(p.cleaned) || 0;
        const waiting = Math.max(0, (Number(p.queued) || 0) - cleaned);
        const review = Number(p.blocked) || 0;
        if (!(Number(p.queued) || 0) && !review) toast('Akun dihapus. Tidak ada foto di server yang perlu dibersihkan.', 'ok');
        else toast('Akun dihapus. Foto: ' + num(cleaned) + ' dibersihkan, ' + num(waiting) + ' menunggu, ' + num(review) + ' perlu ditinjau.', review ? 'warn' : 'ok');
      } else toast('Akun dihapus.', 'ok');
      await loadAccounts({ silent: true });
    } catch (error) { showModalError(error.message); }
  });
  return undefined;
}

/* ------------------------------- settings ------------------------------- */
async function loadSettings(opts = {}) {
  const panel = $('panel-settings');
  if (!SETTINGS.length && !opts.silent) panel.innerHTML = loadingBlock('Memuat setelan…');
  try {
    const payload = await api('/api/admin/settings');
    if (!ME) return;
    SETTINGS = (payload && payload.settings) || [];
    SETTINGS_META.encryption = payload && payload.encryption;
    SETTINGS_META.routerHosts = (payload && payload.routerHosts) || [];
    renderSettings();
  } catch (error) {
    if (!ME) return;
    panel.innerHTML = errorBlock(error.message, 'settings-retry');
    icons();
  }
}

const GROUP_LABEL = { router: ['Router dan model AI', 'cpu'], integrations: ['Layanan lain', 'plug-zap'], queue: ['Antrean dan batas', 'gauge'], accounts: ['Pendaftaran', 'users'] };

function settingField(item) {
  const id = 'set-' + item.key;
  const hintId = id + '-hint';
  const badges = (item.isSecret ? badge('rahasia', 'badge-unknown') + ' ' : '') + (item.hasEnvFallback ? badge('ada di .env', 'badge-unknown') : '');
  const label = '<label class="label" for="' + id + '">' + esc(item.label) + '</label>';
  const head = '<div class="a-row-8 a-wrapline">' + label.replace('class="label"', 'class="label" style="margin:0"') + badges + '</div>';
  const help = item.help ? '<p class="hint" id="' + hintId + '">' + esc(item.help) + '</p>' : '';
  let control;
  if (item.isSecret) {
    const state = item.isSet ? 'Sudah diisi (' + (item.hint || '••••') + ')' : 'Belum diisi';
    const clear = item.hasStored ? '<button type="button" class="btn btn-danger btn-sm" data-action="clear-secret" data-id="' + esc(item.key) + '" aria-label="Hapus ' + esc(item.label) + '">Hapus kunci</button>' : '';
    control = '<input id="' + id + '" type="password" class="input mt2" autocomplete="new-password" placeholder="Ketik kunci baru untuk mengganti" aria-describedby="' + hintId + ' ' + id + '-state" data-setting="' + esc(item.key) + '">'
      + '<div class="a-row a-between a-wrapline mt2"><p id="' + id + '-state" class="t-meta">' + esc(state) + (item.hasStored || !item.hasEnvFallback ? '' : ' (dari .env)') + '</p>' + clear + '</div>'
      + (item.broken ? '<p class="field-error">Nilai tersimpan tidak bisa dibaca (SECRET_KEY berubah). Isi ulang kuncinya.</p>' : '');
  } else if (item.type === 'bool') {
    const on = String(item.value) === '1' || item.value === true || String(item.value).toLowerCase() === 'true';
    control = '<label class="check mt2"><input id="' + id + '" type="checkbox"' + (on ? ' checked' : '') + ' data-setting="' + esc(item.key) + '" aria-describedby="' + hintId + '"><span>Aktif</span></label>';
  } else if (item.type === 'int') {
    control = '<input id="' + id + '" type="number" inputmode="numeric" class="input mt2" value="' + esc(item.value) + '"' + (item.min !== undefined ? ' min="' + item.min + '"' : '') + (item.max !== undefined ? ' max="' + item.max + '"' : '') + ' aria-describedby="' + hintId + '" data-setting="' + esc(item.key) + '">';
  } else {
    control = '<input id="' + id + '" type="text" class="input mt2" value="' + esc(item.value) + '" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="' + hintId + '" data-setting="' + esc(item.key) + '">';
  }
  return '<div class="setting">' + head + help + control + '</div>';
}

function renderSettings() {
  const groups = {};
  SETTINGS.forEach((item) => { (groups[item.group] = groups[item.group] || []).push(item); });
  const enc = SETTINGS_META.encryption;
  const sections = Object.keys(groups).map((group) => {
    const meta = GROUP_LABEL[group] || [group, 'settings'];
    const extra = group === 'router'
      ? '<div class="setting"><div id="router-test" role="status" aria-live="polite"></div>'
        + '<button type="button" class="btn btn-secondary btn-block mt3" data-action="test-router">' + icon('plug-zap') + '<span class="btn-label">Uji koneksi router</span></button>'
        + '<p class="hint">Uji kemampuan berikut mengirim gambar buatan, satu panggilan untuk setiap rute berbeda. Kuota atau biaya penyedia dapat terpakai.</p>'
        + '<button type="button" class="btn btn-secondary btn-block mt3" data-action="test-model-capability">' + icon('image') + '<span class="btn-label">Uji Gambar dan JSON</span></button>'
        + '<p class="hint">Yang diuji adalah isi formulir ini, termasuk yang belum disimpan.' + (SETTINGS_META.routerHosts.length ? ' Host yang diizinkan: ' + esc(SETTINGS_META.routerHosts.join(', ')) + '.' : '') + '</p></div>' : '';
    return '<section class="card" aria-labelledby="grp-' + group + '"><h3 id="grp-' + group + '" class="t-title">' + esc(meta[0]) + '</h3><div class="mt3">'
      + groups[group].map(settingField).join('') + extra + '</div></section>';
  }).join('');
  const html = '<h2 class="sr-only">Setelan</h2><form id="settings-form" data-form="settings" class="a-stack" novalidate>'
    + '<div class="notice ' + (enc && enc.available === false ? 'notice-warn' : 'notice-info') + '">' + icon(enc && enc.available === false ? 'triangle-alert' : 'shield-check') + '<span>' + esc(enc ? enc.detail : '') + '</span></div>'
    + sections
    + '<div class="card action-bar settings-bar"><div class="bar-fields a-stack-8"><p id="settings-status" class="t-body" role="status" aria-live="polite">Belum ada perubahan.</p>'
    + '<div id="settings-reauth-box" hidden>' + passwordField({ id: 'settings-reauth', label: 'Kata sandi Anda (konfirmasi)', autocomplete: 'current-password', hint: 'Diminta karena Anda mengubah alamat router atau sebuah kunci.' }) + '</div>'
    + '<div id="settings-error" class="notice notice-error" role="alert" hidden></div></div>'
    + '<button type="submit" id="settings-save" class="btn btn-primary" disabled>' + icon('save') + '<span class="btn-label">Simpan perubahan</span></button></div></form>';
  $('panel-settings').innerHTML = html;
  delete $('panel-settings').dataset.sig;
  icons();
  updateSettingsState();
}

/** Only what the operator actually changed. A blank secret means "leave the stored key alone". */
function collectSettingsPayload() {
  const payload = {};
  SETTINGS.forEach((item) => {
    const el = $('set-' + item.key);
    if (!el) return;
    if (item.isSecret) { if (el.value.trim() !== '') payload[item.key] = el.value.trim(); return; }
    if (item.type === 'bool') {
      const current = String(item.value) === '1' || item.value === true || String(item.value).toLowerCase() === 'true';
      if (el.checked !== current) payload[item.key] = el.checked;
      return;
    }
    const next = el.value.trim();
    if (next !== String(item.value === null || item.value === undefined ? '' : item.value)) payload[item.key] = next;
  });
  return payload;
}
function sensitiveKeys(payload) {
  return Object.keys(payload).filter((key) => { const item = SETTINGS.find((s) => s.key === key); return item && (item.isSecret || item.sensitive); });
}
function updateSettingsState() {
  const status = $('settings-status'), save = $('settings-save');
  if (!status || !save) return;
  const payload = collectSettingsPayload(), count = Object.keys(payload).length, sensitive = sensitiveKeys(payload).length > 0;
  status.textContent = count ? num(count) + ' perubahan belum disimpan.' : 'Belum ada perubahan.';
  save.disabled = !count;
  const box = $('settings-reauth-box'); if (box) box.hidden = !sensitive;
}

async function saveSettings(form) {
  const err = $('settings-error');
  err.hidden = true;
  const payload = collectSettingsPayload();
  if (!Object.keys(payload).length) return;
  const sensitive = sensitiveKeys(payload).length > 0;
  const reauth = $('settings-reauth') ? $('settings-reauth').value : '';
  if (sensitive && !reauth) { err.textContent = 'Masukkan kata sandi Anda untuk menyimpan alamat router atau kunci.'; err.hidden = false; $('settings-reauth').focus(); return; }
  await withBusy($('settings-save'), async () => {
    try {
      const body = { settings: payload };
      if (sensitive) body.currentPassword = reauth;
      const result = await api('/api/admin/settings', { method: 'PUT', body });
      toast('Setelan tersimpan (' + num((result.applied || []).length) + ' diubah).', 'ok');
      await loadSettings({ silent: true });
    } catch (error) {
      err.textContent = error.message; err.hidden = false;
      if (error.code && error.code.indexOf('reauth') === 0) $('settings-reauth').focus();
    }
  });
}

async function testRouter(button, probe = false) {
  const box = $('router-test');
  const draft = {};
  const url = $('set-NINEROUTER_URL'), key = $('set-NINEROUTER_KEY');
  if (url && url.value.trim()) draft.url = url.value.trim();
  if (key && key.value.trim()) draft.key = key.value.trim();
  const tri = $('set-GEMINI_TRIAGE_MODEL'), dia = $('set-GEMINI_DIAGNOSE_MODEL');
  if (tri && tri.value.trim()) draft.triageModel = tri.value.trim();
  if (dia && dia.value.trim()) draft.diagnoseModel = dia.value.trim();
  if (probe) {
    draft.probe = true;
    const fastTri = $('set-GEMINI_TRIAGE_MODEL_FAST'), fastDia = $('set-GEMINI_DIAGNOSE_MODEL_FAST');
    if (fastTri && fastTri.value.trim()) draft.fastTriageModel = fastTri.value.trim();
    if (fastDia && fastDia.value.trim()) draft.fastDiagnoseModel = fastDia.value.trim();
  }
  box.innerHTML = '<p class="t-meta">Menguji…</p>';
  await withBusy(button, async () => {
    try { box.innerHTML = routerResultHtml(await api('/api/admin/settings/test-router', { method: 'POST', body: draft, timeout: probe ? 150000 : 30000 })); }
    catch (error) { box.innerHTML = '<div class="notice notice-error" role="alert">' + icon('circle-alert') + '<span>' + esc(error.message) + '</span></div>'; }
    icons();
  });
}

function clearSecret(key) {
  const item = SETTINGS.find((s) => s.key === key);
  if (!item) return;
  const extra = key === 'NINEROUTER_KEY' ? ' Analisis AI berhenti sampai kunci baru diisi.' : '';
  openModal('<form data-form="clear-secret" data-id="' + esc(key) + '" class="a-stack-16" novalidate><h2 id="modal-title" class="t-title">Hapus ' + esc(item.label) + '?</h2>'
    + '<p class="t-body">Kunci yang tersimpan di konsol akan dihapus.' + esc(extra) + (item.hasEnvFallback ? ' Nilai di .env, jika ada, tetap dipakai.' : '') + '</p>'
    + passwordField({ id: 'cs-reauth', label: 'Kata sandi Anda (konfirmasi)', autocomplete: 'current-password' })
    + '<div id="modal-error" class="notice notice-error" role="alert" hidden></div>'
    + '<div class="dialog-actions"><button type="button" class="btn btn-secondary" data-action="close-modal">Batal</button><button type="submit" class="btn btn-danger-solid">Hapus kunci</button></div></form>', { dismissOnBackdrop: false });
}
async function submitClearSecret(form) {
  clearModalError();
  const reauth = $('cs-reauth').value;
  if (!reauth) return showModalError('Masukkan kata sandi Anda untuk melanjutkan.', 'cs-reauth');
  await withBusy(form.querySelector('[type="submit"]'), async () => {
    try {
      const r = await api('/api/admin/settings/' + encodeURIComponent(form.dataset.id) + '/clear', { method: 'POST', body: { currentPassword: reauth } });
      closeModal();
      toast(r.envFallback ? 'Kunci dihapus dari konsol. Nilai di .env masih dipakai.' : 'Kunci dihapus.', r.envFallback ? 'warn' : 'ok');
      await loadSettings({ silent: true });
    } catch (error) { showModalError(error.message, 'cs-reauth'); }
  });
  return undefined;
}

/* -------------------------------- queue --------------------------------- */
function ensureQueueShell() {
  const panel = $('panel-queue');
  if ($('queue-list')) return;
  const chip = (value, label) => '<button type="button" class="chip" data-action="queue-filter" data-status="' + value + '" aria-pressed="false">' + label + '</button>';
  panel.innerHTML = '<h2 class="sr-only">Antrean</h2><div id="queue-tiles" class="a-grid2 a-grid4"></div>'
    + '<section class="card a-stack-16" aria-label="Pekerjaan terbaru"><div class="chips" role="group" aria-label="Saring menurut status">'
    + chip('', 'Semua') + chip('queued', 'Menunggu') + chip('claimed', 'Dikerjakan') + chip('done', 'Selesai') + chip('problem', 'Bermasalah') + '</div>'
    + '<div class="a-row a-between a-wrapline"><label class="check"><input type="checkbox" id="queue-auto" data-change="queue-auto" checked><span>Segarkan otomatis</span></label>'
    + '<button type="button" class="btn btn-secondary btn-sm" data-action="queue-refresh">' + icon('refresh-cw') + '<span class="btn-label">Muat ulang</span></button></div>'
    + '<p id="queue-note" class="t-meta" aria-live="polite"></p><div id="queue-list"></div><div id="queue-more"></div></section>';
  icons();
}

async function loadQueue(opts = {}) {
  ensureQueueShell();
  const seq = ++QUEUE.seq;
  QUEUE.loading = true;
  if (!opts.silent && !QUEUE.jobs.length) renderQueue();
  try {
    const payload = await api('/api/admin/queue?limit=' + QUEUE.limit + (QUEUE.filter ? '&status=' + encodeURIComponent(QUEUE.filter) : ''));
    if (seq !== QUEUE.seq || !ME) return;
    QUEUE.jobs = (payload && payload.jobs) || [];
    QUEUE.depth = (payload && payload.depth) || 0;
    QUEUE.byStatus = (payload && payload.byStatus) || {};
    QUEUE.error = '';
  } catch (error) {
    if (seq !== QUEUE.seq || !ME) return;
    if (opts.silent) { QUEUE.loading = false; return; }   // keep the last good list on a failed background refresh
    QUEUE.error = error.message;
  }
  QUEUE.loading = false;
  renderQueue();
}

function traceSummary(job) {
  const last = job.lastEvent || (job.events || [])[job.events ? job.events.length - 1 : 0];
  if (!last) return '<span class="t-meta">belum ada</span>';
  const status = last.httpStatus !== null && last.httpStatus !== undefined ? ' · ' + last.httpStatus : '';
  const latency = last.latencyMs !== null && last.latencyMs !== undefined ? ' · ' + (last.latencyMs / 1000).toFixed(1).replace('.', ',') + ' dtk' : '';
  const bad = last.httpStatus && last.httpStatus !== 200;
  return '<span class="t-meta' + (bad ? ' t-bad' : '') + '">' + esc(STAGE_LABEL[last.stage] || last.stage) + esc(status + latency) + '</span>';
}

function jobRow(job) {
  const id = esc(job.id);
  const notes = [];
  if (job.error) notes.push('<span class="t-bad">' + esc(job.error) + '</span>');
  if (job.delayed) notes.push('Ditunda sampai ' + esc(fmtTime(job.notBeforeMs)));
  if (job.stale) notes.push('Macet: tidak ada kabar dari worker');
  if (job.releaseCount) notes.push('Dilepas ' + num(job.releaseCount) + '×');
  if (job.status === 'rejected' && !job.hasImage) notes.push('Foto sudah dibersihkan');
  const actions = '<button type="button" class="btn btn-secondary btn-sm" data-action="job-trace" data-id="' + id + '" aria-label="Lihat jejak pekerjaan ' + id + '">Jejak</button>'
    + (job.canRequeue ? '<button type="button" class="btn btn-secondary btn-sm" data-action="job-requeue" data-id="' + id + '" aria-label="Ulangi pekerjaan ' + id + '">Ulangi</button>' : '')
    + (job.canCancel ? '<button type="button" class="btn btn-danger btn-sm" data-action="job-cancel" data-id="' + id + '" aria-label="Batalkan pekerjaan ' + id + '">Batalkan</button>' : '');
  return '<tr role="row"><td role="cell"><div class="mono break">' + id + '</div><div class="t-meta break">' + esc(job.ownerEmail || job.accountId || '—') + '</div></td>'
    + '<td role="cell" class="fit">' + badge(STATUS_LABEL[job.status] || job.status, STATUS_BADGE[job.status]) + (job.tier === 'fast' ? ' ' + badge('Cepat', 'badge-moderate') : '') + '</td>'
    + '<td role="cell" class="t-meta">Percobaan ' + num(job.attempts) + ' · masuk ' + esc(fmtAgo(job.createdMs)) + '</td>'
    + '<td role="cell" class="t-meta">' + (notes.join('<br>') || '<span class="sm-only">Tidak ada catatan</span>') + '</td>'
    + '<td role="cell">' + traceSummary(job) + '</td>'
    + '<td role="cell" class="acts"><div class="btn-row">' + actions + '</div></td></tr>';
}

function renderQueue() {
  ensureQueueShell();
  const by = QUEUE.byStatus || {};
  const tiles = tile('Menunggu', num(by.queued || 0), 'siap diambil') + tile('Dikerjakan', num(by.claimed || 0), 'sedang diproses')
    + tile('Selesai', num(by.done || 0), 'berhasil') + tile('Bermasalah', num((by.rejected || 0) + (by.failed || 0)), 'ditolak atau gagal');
  setHtml($('queue-tiles'), tiles);
  document.querySelectorAll('#panel-queue [data-action="queue-filter"]').forEach((chip) => {
    const on = (chip.dataset.status || '') === QUEUE.filter;
    chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    chip.classList.toggle('is-active', on);
  });
  let html;
  if (QUEUE.jobs.length) {
    html = '<table class="rtable" role="table"><caption class="sr-only">Pekerjaan analisis terbaru</caption><thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col">Pekerjaan</th><th role="columnheader" scope="col">Status</th>'
      + '<th role="columnheader" scope="col">Waktu</th><th role="columnheader" scope="col">Catatan</th><th role="columnheader" scope="col">Router</th><th role="columnheader" scope="col"><span class="sr-only">Tindakan</span></th></tr></thead>'
      + '<tbody role="rowgroup">' + QUEUE.jobs.map(jobRow).join('') + '</tbody></table>';
  } else if (QUEUE.loading) html = '<div role="status"><span class="sr-only">Memuat antrean…</span><div class="skeleton sk-lg"></div></div>';
  else if (QUEUE.error) html = '<div class="notice notice-error" role="alert">' + icon('circle-alert') + '<span>' + esc(QUEUE.error) + '</span></div><button type="button" class="btn btn-secondary mt3" data-action="queue-refresh">Coba lagi</button>';
  else html = '<p class="t-body t-muted">' + (QUEUE.filter ? 'Tidak ada pekerjaan dengan status ini.' : 'Antrean kosong.') + '</p>';
  keepFocus($('queue-list'), () => { if (setHtml($('queue-list'), html)) icons(); });
  $('queue-note').textContent = QUEUE.jobs.length ? 'Menampilkan ' + num(QUEUE.jobs.length) + ' pekerjaan terbaru.' : '';
  setHtml($('queue-more'), QUEUE.jobs.length >= QUEUE.limit && QUEUE.limit < 200 ? '<button type="button" class="btn btn-secondary btn-block" data-action="queue-more">Tampilkan lebih banyak</button>' : '');
  const auto = $('queue-auto'); if (auto) auto.checked = QUEUE.auto;
}

function showJobTrace(jobId) {
  openModal('<h2 id="modal-title" class="t-title">Jejak Pekerjaan</h2><p class="t-meta mono break mt1">' + esc(jobId) + '</p>'
    + '<div id="trace-body" class="mt3" role="status"><p class="t-meta">Memuat…</p></div>'
    + '<div class="mt6"><button type="button" class="btn btn-secondary btn-block" data-action="close-modal">Tutup</button></div>');
  api('/api/admin/jobs/' + encodeURIComponent(jobId)).then((job) => {
    const events = job.events || [];
    const list = events.length ? events.map((e) => {
      const bad = e.httpStatus && e.httpStatus !== 200;
      return '<li class="mt3"><div class="a-row a-between a-start"><b class="' + (bad ? 't-bad' : '') + '">' + esc(STAGE_LABEL[e.stage] || e.stage) + '</b><span class="t-meta">' + esc(fmtTime(e.tsMs)) + '</span></div>'
        + '<div class="t-meta">HTTP ' + esc(e.httpStatus !== null && e.httpStatus !== undefined ? e.httpStatus : '—')
        + (e.latencyMs !== null && e.latencyMs !== undefined ? ' · ' + (e.latencyMs / 1000).toFixed(2).replace('.', ',') + ' dtk' : '') + (e.model ? ' · <span class="mono">' + esc(e.model) + '</span>' : '') + '</div>'
        + (e.detail ? '<div class="t-meta break">' + esc(String(e.detail).slice(0, 220)) + '</div>' : '') + '</li>';
    }).join('') : '<li class="t-body">Belum ada jejak. Worker belum pernah menyentuh pekerjaan ini.</li>';
    const body = $('trace-body');
    if (!body) return;
    body.innerHTML = kv([['Status', STATUS_LABEL[job.status] || job.status], ['Percobaan', num(job.attempts)], ['Worker', job.worker || '—'], ['Pemilik', job.ownerEmail || '—']])
      + (job.error ? '<div class="notice notice-error mt3">' + icon('circle-alert') + '<span>' + esc(job.error) + '</span></div>' : '') + '<ul>' + list + '</ul>';
    icons();
  }).catch((error) => { const body = $('trace-body'); if (body) body.innerHTML = '<div class="notice notice-error" role="alert">' + esc(error.message) + '</div>'; });
}

async function requeueJob(id) {
  const ok = await confirmDialog({ title: 'Ulangi analisis foto ini?', confirmLabel: 'Ulangi',
    body: '<p>Foto masuk antrean lagi dan memakai token AI sekali lagi. Hasil lama, jika ada, akan diganti.</p><p class="t-meta mt2 mono break">' + esc(id) + '</p>' });
  if (!ok) return;
  try { await api('/api/admin/queue/' + encodeURIComponent(id) + '/requeue', { method: 'POST', body: {} }); toast('Foto dikembalikan ke antrean.', 'ok'); await loadQueue({ silent: true }); }
  catch (error) { toast(error.message, 'error'); await loadQueue({ silent: true }); }
}

function cancelJob(id) {
  openModal('<form data-form="cancel-job" data-id="' + esc(id) + '" class="a-stack-16" novalidate><h2 id="modal-title" class="t-title">Batalkan Pekerjaan</h2>'
    + '<p class="t-meta mono break">' + esc(id) + '</p>'
    + '<div><label class="label" for="cancel-reason">Alasan (terlihat oleh pemilik)</label><input id="cancel-reason" class="input" maxlength="300" value="Dibatalkan oleh admin" autocomplete="off"><p class="hint">Maksimal 300 huruf.</p></div>'
    + '<div id="modal-error" class="notice notice-error" role="alert" hidden></div>'
    + '<div class="dialog-actions"><button type="button" class="btn btn-secondary" data-action="close-modal">Kembali</button><button type="submit" class="btn btn-danger-solid">Batalkan pekerjaan</button></div></form>', { dismissOnBackdrop: false });
}
async function submitCancelJob(form) {
  clearModalError();
  await withBusy(form.querySelector('[type="submit"]'), async () => {
    try {
      await api('/api/admin/queue/' + encodeURIComponent(form.dataset.id) + '/cancel', { method: 'POST', body: { reason: $('cancel-reason').value } });
      closeModal(); toast('Pekerjaan dibatalkan.', 'ok'); await loadQueue({ silent: true });
    } catch (error) { showModalError(error.message); await loadQueue({ silent: true }); }
  });
}

/* -------------------------------- audit --------------------------------- */
function ensureAuditShell() {
  const panel = $('panel-audit');
  if ($('audit-list')) return;
  panel.innerHTML = '<h2 class="sr-only">Audit</h2><section class="card a-stack-16" aria-label="Catatan audit"><div class="toolbar">'
    + '<div><label class="sr-only" for="audit-search">Cari di catatan</label><input id="audit-search" class="input" type="search" placeholder="Cari email, sasaran, atau isi" autocomplete="off" enterkeyhint="search" data-input="audit-search"></div>'
    + '<div><label class="sr-only" for="audit-action">Jenis aksi</label><select id="audit-action" class="input" data-change="audit-action">'
    + AUDIT_FILTERS.map((f) => '<option value="' + esc(f[0]) + '">' + esc(f[1]) + '</option>').join('') + '</select></div>'
    + '<button type="button" class="btn btn-secondary" data-action="audit-refresh">' + icon('refresh-cw') + '<span class="btn-label">Muat ulang</span></button></div>'
    + '<label class="check"><input type="checkbox" id="audit-routine" data-change="audit-routine"><span>Tampilkan juga masuk dan keluar</span></label>'
    + '<div id="audit-list"></div><div id="audit-more"></div></section>';
  icons();
}

async function loadAudit(opts = {}) {
  ensureAuditShell();
  const seq = ++AUDIT.seq;
  AUDIT.loading = true; AUDIT.error = '';
  if (!opts.append && !AUDIT.items.length) renderAudit();
  const params = new URLSearchParams({ limit: '50' });
  if (AUDIT.action) params.set('action', AUDIT.action);
  if (AUDIT.routine) params.set('routine', '1');
  if (AUDIT.query) params.set('q', AUDIT.query);
  if (opts.append && AUDIT.next) params.set('before', String(AUDIT.next));
  try {
    const payload = await api('/api/admin/audit/entries?' + params.toString());
    if (seq !== AUDIT.seq || !ME) return;
    AUDIT.items = opts.append ? AUDIT.items.concat(payload.items || []) : (payload.items || []);
    AUDIT.next = payload.next || null;
  } catch (error) {
    if (seq !== AUDIT.seq || !ME) return;
    AUDIT.error = error.message;
  }
  AUDIT.loading = false;
  renderAudit();
}

function auditRow(e) {
  return '<tr role="row"><td role="cell" class="t-meta">' + esc(fmtTime(e.tsMs)) + '</td><td role="cell" class="break">' + esc(e.actor || '—') + '</td>'
    + '<td role="cell" class="fit"><span class="badge badge-unknown" title="' + esc(e.action) + '">' + esc(AUDIT_LABEL[e.action] || e.action) + '</span></td>'
    + '<td role="cell" class="break mono">' + esc(e.target || '') + '</td><td role="cell" class="t-meta break">' + esc(e.action === 'client.error' ? (e.detail || '') : auditDetail(e.detail)) + '</td></tr>';
}

function renderAudit() {
  ensureAuditShell();
  let html;
  if (AUDIT.items.length) {
    html = '<table class="rtable" role="table"><caption class="sr-only">Catatan audit</caption><thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col">Waktu</th><th role="columnheader" scope="col">Pelaku</th>'
      + '<th role="columnheader" scope="col">Aksi</th><th role="columnheader" scope="col">Sasaran</th><th role="columnheader" scope="col">Detail</th></tr></thead><tbody role="rowgroup">'
      + AUDIT.items.map(auditRow).join('') + '</tbody></table>';
  } else if (AUDIT.loading) html = '<div role="status"><span class="sr-only">Memuat catatan…</span><div class="skeleton sk-lg"></div></div>';
  else if (AUDIT.error) html = '<div class="notice notice-error" role="alert">' + icon('circle-alert') + '<span>' + esc(AUDIT.error) + '</span></div><button type="button" class="btn btn-secondary mt3" data-action="audit-refresh">Coba lagi</button>';
  else html = '<p class="t-body t-muted">' + (AUDIT.action || AUDIT.query ? 'Tidak ada catatan yang cocok.' : 'Belum ada catatan.') + '</p>';
  keepFocus($('audit-list'), () => setHtml($('audit-list'), html));
  setHtml($('audit-more'), AUDIT.next ? '<button type="button" class="btn btn-secondary btn-block" data-action="audit-more">Muat lebih banyak</button>' : '');
}

/* --------------------------- events (delegated) -------------------------- */
const ACTIONS = {
  'tab': (el) => switchTab(el.dataset.tab),
  'goto-tab': (el) => switchTab(el.dataset.tab),
  'logout': (el) => logout(el),
  'close-modal': () => closeModal(),
  'confirm-yes': () => answerConfirm(true),
  'confirm-no': () => answerConfirm(false),
  'toggle-password': (el) => {
    const input = $(el.dataset.target);
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    el.textContent = show ? 'Sembunyikan' : 'Tampilkan';
    el.setAttribute('aria-pressed', show ? 'true' : 'false');
  },
  'gen-password': (el) => {
    const p = el.dataset.prefix, role = $('na-role') && p === 'na' ? $('na-role').value : (p === 'rp' ? ((ACCOUNTS.find((x) => x.id === (el.closest('form') || {}).dataset.id) || {}).role) : 'user');
    const pw = generatePassword(Math.max(14, passwordMinimum(role)));
    [p + '-password', p + '-password2'].forEach((id) => { const f = $(id); if (f) { f.value = pw; f.type = 'text'; } });
    toast('Kata sandi acak dibuat. Salin dan berikan ke pemiliknya.');
  },
  'copy-password': async (el) => {
    const input = $(el.dataset.prefix + '-password');
    if (!input || !input.value) { showModalError('Belum ada kata sandi untuk disalin.', el.dataset.prefix + '-password'); return; }
    toast(await copyText(input.value, input) ? 'Kata sandi disalin.' : 'Tidak bisa menyalin. Salin manual dari kolom.', 'ok');
  },
  'overview-refresh': (el) => withBusy(el, () => loadOverview()),
  'overview-test-router': (el) => testRouterStored(el),
  'storage-inventory': (el) => runInventory(el),
  'scroll-storage': () => { const c = $('storage-card'); if (c) { c.scrollIntoView({ block: 'center' }); c.focus({ preventScroll: true }); } },
  'quick-create-account': async () => { await switchTab('accounts'); createAccount(); },
  'quick-problem-queue': async () => { QUEUE.filter = 'problem'; await switchTab('queue'); },
  'audit-errors': async () => { AUDIT.action = 'client.error'; AUDIT.items = []; AUDIT.next = null; await switchTab('audit'); },
  'create-account': () => createAccount(),
  'edit-account': (el) => editAccount(el.dataset.id),
  'reset-password': (el) => resetPassword(el.dataset.id),
  'delete-account': (el) => deleteAccount(el.dataset.id),
  'accounts-more': (el) => withBusy(el, () => loadAccounts({ append: true })),
  'accounts-retry': () => loadAccounts(),
  'reg-approve': (el) => decideRegistration(el.dataset.id, 'approve'),
  'reg-reject': (el) => decideRegistration(el.dataset.id, 'reject'),
  'settings-retry': () => loadSettings(),
  'test-router': (el) => testRouter(el),
  'test-model-capability': (el) => testRouter(el, true),
  'clear-secret': (el) => clearSecret(el.dataset.id),
  'queue-filter': (el) => { QUEUE.filter = el.dataset.status || ''; QUEUE.limit = 50; QUEUE.jobs = []; return loadQueue(); },
  'queue-refresh': (el) => withBusy(el, () => loadQueue()),
  'queue-more': (el) => { QUEUE.limit = Math.min(200, QUEUE.limit + 50); return withBusy(el, () => loadQueue()); },
  'job-trace': (el) => showJobTrace(el.dataset.id),
  'job-requeue': (el) => requeueJob(el.dataset.id),
  'job-cancel': (el) => cancelJob(el.dataset.id),
  'audit-refresh': (el) => withBusy(el, () => loadAudit()),
  'audit-more': (el) => withBusy(el, () => loadAudit({ append: true })),
};

document.addEventListener('click', (event) => {
  const el = event.target.closest ? event.target.closest('[data-action]') : null;
  if (el && !el.disabled && ACTIONS[el.dataset.action]) {
    event.preventDefault();
    Promise.resolve(ACTIONS[el.dataset.action](el)).catch((error) => { if (error && error.code !== 'session_expired') toast(error.message || 'Terjadi kesalahan.', 'error'); });
    return;
  }
  if (event.target && event.target.id === 'modal' && MODAL.dismissOnBackdrop) closeModal();
});

const FORMS = {
  'login': submitLogin, 'create-account': submitCreateAccount, 'edit-account': submitEditAccount,
  'reset-password': submitResetPassword, 'delete-account': submitDeleteAccount, 'settings': saveSettings,
  'clear-secret': submitClearSecret, 'cancel-job': submitCancelJob, 'registration': submitRegistration,
};
document.addEventListener('submit', (event) => {
  const form = event.target.closest ? event.target.closest('form[data-form]') : null;
  if (!form || !FORMS[form.dataset.form]) return;
  event.preventDefault();
  Promise.resolve(FORMS[form.dataset.form](form)).catch((error) => { if (error && error.code !== 'session_expired') showModalError(error.message || 'Terjadi kesalahan.'); });
});

document.addEventListener('input', (event) => {
  const el = event.target;
  const kind = el.dataset ? el.dataset.input : '';
  if (kind === 'account-search') {
    clearTimeout(SEARCH_TIMER);
    SEARCH_TIMER = setTimeout(() => { ACCOUNTS_PAGE.query = el.value.trim(); loadAccounts({ silent: true }); }, 350);
  } else if (kind === 'audit-search') {
    clearTimeout(AUDIT_TIMER);
    AUDIT_TIMER = setTimeout(() => { AUDIT.query = el.value.trim(); AUDIT.items = []; AUDIT.next = null; loadAudit(); }, 350);
  } else if (kind === 'delete-confirm') {
    const button = $('del-submit');
    if (button) button.disabled = el.value.trim() !== el.dataset.email;
  } else if (el.closest && el.closest('#settings-form')) updateSettingsState();
  const form = el.closest ? el.closest('form[data-form="edit-account"]') : null;
  if (form && form.dataset.confirmed) {
    delete form.dataset.confirmed;
    const summary = $('ea-summary'); if (summary) summary.hidden = true;
    form.querySelector('[type="submit"]').textContent = 'Simpan';
  }
  if (el.id === 'ea-email') {
    const a = ACCOUNTS.find((x) => x.id === (form || {}).dataset.id);
    if (a) toggleReauth('ea', editChanges(a).grantsAdmin || editChanges(a).retargetsAdmin);
  }
});

document.addEventListener('change', (event) => {
  const el = event.target;
  const kind = el.dataset ? el.dataset.change : '';
  if (kind === 'account-filter') { ACCOUNTS_PAGE.filter = el.value; loadAccounts({ silent: true }); }
  else if (kind === 'audit-action') { AUDIT.action = el.value; AUDIT.items = []; AUDIT.next = null; loadAudit(); }
  else if (kind === 'audit-routine') { AUDIT.routine = el.checked; AUDIT.items = []; AUDIT.next = null; loadAudit(); }
  else if (kind === 'queue-auto') { QUEUE.auto = el.checked; syncPolling(); }
  else if (kind === 'role-select') {
    const prefix = el.dataset.prefix;
    if (prefix === 'na') toggleReauth('na', el.value === 'admin');
    if (prefix === 'ea') { const a = ACCOUNTS.find((x) => x.id === (el.closest('form') || {}).dataset.id); if (a) toggleReauth('ea', editChanges(a).grantsAdmin || editChanges(a).retargetsAdmin); }
    const hint = $(prefix + '-password-hint'); if (hint) hint.textContent = 'Minimal ' + passwordMinimum(el.value) + ' karakter.';
  } else if (el.closest && el.closest('#settings-form')) updateSettingsState();
  if (el.id === 'ea-active' || el.id === 'ea-role') {
    const form = el.closest('form');
    if (form && form.dataset.confirmed) { delete form.dataset.confirmed; const s = $('ea-summary'); if (s) s.hidden = true; form.querySelector('[type="submit"]').textContent = 'Simpan'; }
  }
});

document.addEventListener('keydown', (event) => {
  if (modalOpen()) {
    if (event.key === 'Escape') { event.preventDefault(); closeModal(); return; }
    if (event.key === 'Tab') {
      const dialog = $('modal').firstElementChild;
      const items = dialog ? focusable(dialog) : [];
      if (!items.length) { event.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    }
    return;
  }
  const tab = event.target.closest ? event.target.closest('[role="tab"]') : null;
  if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].indexOf(event.key) >= 0) {
    event.preventDefault();
    const tabs = Array.from(document.querySelectorAll('#tabs [role="tab"]'));
    let i = tabs.indexOf(tab);
    if (event.key === 'ArrowRight') i = (i + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') i = (i - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') i = 0; else i = tabs.length - 1;
    tabs[i].focus();
  }
});

document.addEventListener('visibilitychange', () => {
  syncPolling();
  if (!document.hidden && ME) {   // catch up once when the tab comes back
    if (ACTIVE_TAB === 'queue') loadQueue({ silent: true });
    if (ACTIVE_TAB === 'overview') loadOverview({ silent: true });
  }
});
// A page restored from the back/forward cache after sign-out must not show stale data.
window.addEventListener('pageshow', (event) => { if (event.persisted) boot(); });

/* ---------------------------------- boot --------------------------------- */
async function boot() {
  icons();
  try {
    const payload = await api('/api/auth/me', { auth: true });
    if (!payload || !payload.ok) { showLogin(); return; }
    ME = payload.account;
    if (ME.role !== 'admin') { showDenied(); return; }
    showConsole();
    await switchTab('overview');
  } catch (error) {
    showLogin(error.code === 'network' || error.code === 'timeout' ? error.message : '');
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
