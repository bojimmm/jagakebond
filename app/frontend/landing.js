/* Public sign-in conveniences; no credentials or account data are persisted here. */
(() => {
  'use strict';
  const wire = () => {
    const button = document.getElementById('auth-toggle-password');
    const field = document.getElementById('auth-password');
    if (button && field) button.addEventListener('click', () => {
      const shown = field.type === 'password';
      field.type = shown ? 'text' : 'password';
      button.textContent = shown ? 'Tutup' : 'Lihat';
      button.setAttribute('aria-pressed', String(shown));
      button.setAttribute('aria-label', shown ? 'Sembunyikan kata sandi' : 'Tampilkan kata sandi');
    });
    const register = document.getElementById('auth-tab-register');
    // The existing API wrapper selects the real backend on Android; a relative
    // fetch would incorrectly contact Capacitor's local static-file server.
    if (register && typeof api === 'function') api('/api/auth/options', { anonymous: true })
      .then(options => {
        const open = !!(options && options.passwordRegistration === true);
        register.hidden = !open;
        const hint = document.getElementById('auth-hint');
        if (open && hint) hint.textContent = 'Baru di JagaKebond? Buat akun untuk mulai mencatat.';
      }).catch(() => { /* Closed by default when offline or on an older server. */ });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
})();
