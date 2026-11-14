/* "Masuk dengan Google" (0.2.3.0). Nothing is shown unless GET /api/auth/google/config says enabled.
   Web: the Google Identity Services button, loaded lazily from accounts.google.com/gsi/client only while the
   sign-in screen is open. Android app: Credential Manager through JagaSync.googleSignIn, because Google blocks
   its web sign-in inside a WebView. Either way the ID token carries a single-use server nonce and goes to
   POST /api/auth/google; the answer is a session (signed in), registration_pending or a refusal.

   Uses api(), afterSignIn() and userMessage() from session.js at call time. Publishes window.JagaGoogle. */
(function installJagaGoogle(root) {
  'use strict';
  const GSI_SRC = 'https://accounts.google.com/gsi/client';
  const GSI_TIMEOUT_MS = 15000;
  const NONCE_REFRESH_MS = 8 * 60 * 1000;   // server nonces live 10 minutes
  const TEXT = {
    checking: 'Memeriksa akun Google…',
    pending: 'Permintaan masuk sudah dikirim. Tunggu persetujuan admin.',
    rejected: 'Permintaan masuk Anda ditolak admin. Hubungi admin bila ini keliru.',
    inactive: 'Akun dinonaktifkan. Hubungi admin.',
    failed: 'Masuk dengan Google gagal. Coba lagi.',
    noAccount: 'Belum ada akun Google di HP ini. Tambahkan akun Google di Setelan HP, lalu coba lagi.',
    unavailable: 'Masuk dengan Google belum bisa di HP ini. Masuk dengan email dan kata sandi.',
  };
  const state = { config: null, configLoading: null, gsi: null, nonce: null, nonceAt: 0, timer: null, busy: false, gateOpen: false };

  const $ = id => document.getElementById(id);
  const isNative = () => !!(root.Capacitor && typeof root.Capacitor.isNativePlatform === 'function' && root.Capacitor.isNativePlatform());
  function nativePlugin() {
    const plugin = root.Capacitor && root.Capacitor.Plugins && root.Capacitor.Plugins.JagaSync;
    return plugin && typeof plugin.googleSignIn === 'function' ? plugin : null;
  }

  function notice(kind, text) {
    const box = $('google-notice');
    if (!box) return;
    box.className = 'notice ' + (kind === 'info' ? 'notice-info' : kind === 'ok' ? 'notice-ok' : 'notice-error');
    box.textContent = text || '';
    box.hidden = !text;
  }
  function setVisible(on) {
    const block = $('google-signin');
    if (block) block.hidden = !on;
  }
  function setBusy(on) {
    state.busy = on;
    const button = $('google-native-button');
    if (button) { button.disabled = on; button.setAttribute('aria-busy', on ? 'true' : 'false'); }
    if (on) notice('info', TEXT.checking);
  }

  async function loadConfig() {
    if (state.config) return state.config;
    if (!state.configLoading) {
      state.configLoading = api('/api/auth/google/config', { anonymous: true })
        .then(config => { state.config = config && config.enabled && config.clientId ? config : { enabled: false }; return state.config; })
        .catch(() => null)   // offline or an older server: try again next time the sign-in screen opens
        .finally(() => { state.configLoading = null; });
    }
    return state.configLoading;
  }

  async function freshNonce() {
    const reply = await api('/api/auth/google/nonce', { method: 'POST', body: {}, anonymous: true });
    if (!reply || typeof reply.nonce !== 'string') throw new Error(TEXT.failed);
    state.nonce = reply.nonce;
    state.nonceAt = Date.now();
    return reply.nonce;
  }

  /* ------------------------------------------------------------ web: Google Identity Services */
  function loadGsi() {
    if (root.google && root.google.accounts && root.google.accounts.id) return Promise.resolve(root.google.accounts.id);
    if (state.gsi) return state.gsi;
    state.gsi = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const timer = setTimeout(() => reject(new Error('gsi timeout')), GSI_TIMEOUT_MS);
      script.src = GSI_SRC;
      script.async = true;
      script.onload = () => {
        clearTimeout(timer);
        if (root.google && root.google.accounts && root.google.accounts.id) resolve(root.google.accounts.id);
        else reject(new Error('gsi missing'));
      };
      script.onerror = () => { clearTimeout(timer); reject(new Error('gsi blocked')); };
      document.head.appendChild(script);
    }).catch(error => { state.gsi = null; throw error; });
    return state.gsi;
  }

  /* GIS takes the nonce at initialize(), before the click: after every attempt, and before the server forgets it,
     the button is set up again with a new one. */
  async function renderWebButton() {
    const host = $('google-button');
    if (!host || !state.gateOpen) return;
    const gsi = await loadGsi();
    const nonce = await freshNonce();
    if (!state.gateOpen) return;
    gsi.initialize({ client_id: state.config.clientId, nonce, callback: response => submit(response && response.credential, nonce),
      auto_select: false, cancel_on_tap_outside: true, context: 'signin', ux_mode: 'popup' });
    host.textContent = '';
    const width = Math.max(200, Math.min(400, Math.round(host.clientWidth || 320)));
    gsi.renderButton(host, { type: 'standard', theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill',
      logo_alignment: 'center', width, locale: 'id' });
    scheduleRefresh();
  }
  function scheduleRefresh() {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => { if (state.gateOpen && !state.busy) renderWebButton().catch(hideOnError); }, NONCE_REFRESH_MS);
  }
  function hideOnError() { setVisible(false); }

  /* ------------------------------------------------------------ Android: Credential Manager */
  async function nativeSignIn() {
    const plugin = nativePlugin();
    if (!plugin || state.busy) return;
    setBusy(true);
    let idToken = null, nonce = null;
    try {
      nonce = await freshNonce();
      const result = await plugin.googleSignIn({ serverClientId: state.config.clientId, nonce });
      idToken = result && result.idToken;
    } catch (error) {
      setBusy(false);
      const code = error && error.code;
      if (code === 'google_cancelled') { notice('', ''); return; }
      notice('error', code === 'google_no_credential' ? TEXT.noAccount : code === 'google_unavailable' ? TEXT.unavailable
        : userMessage(error, TEXT.failed));
      return;
    }
    setBusy(false);
    await submit(idToken, nonce);
  }

  /* ------------------------------------------------------------ both: hand the token to the server */
  async function submit(credential, nonce) {
    if (!credential || state.busy) return;
    if (nonce === state.nonce) state.nonce = null;   // single use, whatever the answer
    setBusy(true);
    let signedIn = false;
    try {
      const payload = await api('/api/auth/google', { method: 'POST', body: { credential, nonce }, anonymous: true });
      if (payload && payload.account && typeof payload.account.id === 'string' && payload.account.id) {
        notice('', '');
        signedIn = true;
        await afterSignIn(payload.account);
      } else if (payload && payload.code === 'registration_pending') {
        notice('info', TEXT.pending);
      } else {
        notice('error', TEXT.failed);
      }
    } catch (error) {
      const code = error && error.code;
      notice('error', code === 'registration_rejected' ? TEXT.rejected : code === 'account_inactive' ? TEXT.inactive
        : userMessage(error, TEXT.failed));
    } finally {
      state.busy = false;
      const button = $('google-native-button');
      if (button) { button.disabled = false; button.setAttribute('aria-busy', 'false'); }
      if (!signedIn && !isNative() && state.gateOpen) renderWebButton().catch(hideOnError);
    }
  }

  /* ------------------------------------------------------------ lifecycle (called by showAuthGate / hideAuthGate) */
  async function onGate(open) {
    state.gateOpen = !!open;
    if (!open) { clearTimeout(state.timer); return; }
    // Let the caller finish first (a sign-out sends its own request); the Google check is never urgent.
    await new Promise(resolve => setTimeout(resolve, 0));
    if (!state.gateOpen) return;
    const config = await loadConfig();
    if (!state.gateOpen) return;
    if (!config || !config.enabled) { setVisible(false); return; }
    if (isNative()) {
      const usable = !!nativePlugin();
      setVisible(usable);
      const button = $('google-native-button');
      if (button) button.hidden = !usable;
      return;
    }
    setVisible(true);
    if (!state.nonce || Date.now() - state.nonceAt > NONCE_REFRESH_MS) {
      try { await renderWebButton(); } catch (_) { hideOnError(); }
    }
  }

  function wire() {
    const button = $('google-native-button');
    if (button) button.addEventListener('click', () => { nativeSignIn(); });
    root.addEventListener('online', () => { if (state.gateOpen && !state.config) onGate(true); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();

  root.JagaGoogle = { onGate, submit };
})(window);
