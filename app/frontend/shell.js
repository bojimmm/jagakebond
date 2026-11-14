/* App shell extras for the field app: header status chip, attention strip, Riwayat badge, "new version" prompt,
   Android back button, and the adaptive background poller for submitted analyses.
   Everything is attached to existing elements at load time, so markup edits elsewhere cannot break it. */
(function installShell(root) {
  'use strict';
  const doc = root.document;
  const attention = new Map();            // key -> { message, tone, label, onClick }
  const ATTENTION_ORDER = ['auth', 'server', 'quarantine', 'storage', 'clock'];
  let draftState = { label: '', attention: false, counts: { unsent: 0, processing: 0, failed: 0, active: 0 }, uploading: 0 };
  let chip = null;
  let updateBar = null;
  let pollTimer = null;
  let polling = false;
  let unseen = new Set();
  let unseenKey = null;

  const el = id => doc.getElementById(id);
  const plural = (n, one) => n + ' ' + one;
  function icon(name) { const i = doc.createElement('i'); i.setAttribute('data-lucide', name); i.setAttribute('aria-hidden', 'true'); return i; }

  /* ------------------------------------------------------------------ header chip */
  function ensureChip() {
    if (chip) return chip;
    const header = doc.querySelector('#app-shell > header');
    if (!header) return null;
    chip = doc.createElement('button');
    chip.type = 'button';
    chip.id = 'status-chip';
    chip.className = 'status-chip hidden';
    chip.setAttribute('aria-live', 'polite');
    chip.addEventListener('click', onChipTap);
    const account = header.querySelector('button[data-act="openAccountModal"]');
    if (account) header.insertBefore(chip, account); else header.append(chip);
    return chip;
  }
  function isOffline() { return (root.navigator && root.navigator.onLine === false) || (typeof offlineMode !== 'undefined' && offlineMode); }
  function chipModel() {
    const c = draftState.counts || {};
    const unsent = Number(c.unsent) || 0;
    const failed = Number(c.failed) || 0;
    const processing = Number(c.processing) || 0;
    // Short visible text (the phone header is narrow); the full sentence is the accessible label.
    if (isOffline()) return { tone: 'offline', icon: 'wifi-off', text: unsent ? 'Offline · ' + unsent : 'Offline',
      hint: 'Offline' + (unsent ? ', ' + plural(unsent, 'foto menunggu') : '') + '. Foto tetap tersimpan di HP dan dikirim saat ada sinyal.' };
    if (failed) return { tone: 'bad', icon: 'alert-triangle', text: failed + ' gagal', hint: plural(failed, 'foto gagal terkirim atau gagal dianalisis') + '. Ketuk untuk melihat.' };
    if (draftState.uploading) return { tone: 'busy', icon: 'upload-cloud', text: 'Mengirim…', hint: 'Sedang mengirim ' + plural(draftState.uploading, 'foto') + '.' };
    if (unsent) return { tone: 'warn', icon: 'upload-cloud', text: unsent + ' belum terkirim', hint: plural(unsent, 'foto belum terkirim') + '. Ketuk untuk melihat dan mengirim sekarang.' };
    if (processing) return { tone: 'busy', icon: 'loader', text: processing + ' dianalisis', hint: plural(processing, 'foto sedang dianalisis') + '. Hasilnya masuk ke Riwayat.' };
    return null;
  }
  let chipKey = '';
  function renderChip() {
    const target = ensureChip();
    if (!target) return;
    const signedIn = typeof currentAccount !== 'undefined' && !!currentAccount;
    const model = signedIn ? chipModel() : null;
    const logView = el('view-log');
    const draftsStrip = el('offline-drafts');
    const mobileLog = (root.matchMedia && root.matchMedia('(max-width: 767px)').matches) ||
      (!root.matchMedia && Number(root.innerWidth) <= 767);
    const processingAlreadyShown = !!model && model.text.endsWith(' dianalisis') && mobileLog &&
      logView && !logView.classList.contains('hidden') && draftsStrip && !draftsStrip.hidden;
    const visibleModel = processingAlreadyShown ? null : model;
    const key = visibleModel ? visibleModel.tone + '|' + visibleModel.text + '|' + visibleModel.hint : '';
    if (key === chipKey) return;               // nothing changed: no DOM work, no icon re-scan
    chipKey = key;
    doc.body.classList.toggle('has-status-chip', !!visibleModel);
    if (!visibleModel) { target.classList.add('hidden'); target.removeAttribute('data-tone'); return; }
    target.classList.remove('hidden');
    target.dataset.tone = visibleModel.tone;
    target.setAttribute('aria-label', visibleModel.hint);
    target.title = visibleModel.hint;
    target.replaceChildren(icon(visibleModel.icon), Object.assign(doc.createElement('span'), { textContent: visibleModel.text, id: 'status-chip-text' }));
    if (typeof icons === 'function') icons();
  }
  // View changes and phone rotation can make the Riwayat strip duplicate (or stop duplicating) this chip.
  doc.addEventListener('jaga-menu-changed', renderChip);
  root.addEventListener('resize', renderChip, { passive: true });
  function onChipTap() {
    const c = draftState.counts || {};
    if ((Number(c.unsent) || 0) + (Number(c.failed) || 0) + (Number(c.processing) || 0) > 0) shell.openDrafts();
    else if (typeof showToast === 'function') showToast(chipModel() ? chipModel().hint : 'Semua foto sudah terkirim.');
  }

  /* ------------------------------------------------------------------ attention strip (the old sync banner) */
  function renderBanner() {
    const banner = doc.querySelector('.sync-banner');
    if (!banner) return;
    let shown = null;
    for (const key of ATTENTION_ORDER) if (attention.has(key)) { shown = attention.get(key); break; }
    const status = el('sync-status');
    if (status) {
      // The draft label stays in the DOM (tests and screen readers read it); the strip only shows when something needs the farmer.
      status.textContent = draftState.attention || !shown ? draftState.label || (shown ? shown.message : '') : shown.message;
    }
    const retry = el('sync-retry');
    if (retry) retry.textContent = shown && shown.label && !draftState.attention ? shown.label : 'Kirim sekarang';
    const count = el('sync-pending-count');
    if (count) count.textContent = String(Number(draftState.counts.unsent) || 0);
    banner.hidden = !(draftState.attention || shown);
    banner.dataset.tone = shown && shown.tone ? shown.tone : (draftState.attention ? 'warn' : '');
  }

  /* ------------------------------------------------------------------ Riwayat badge */
  function badgeTargets() {
    return [el('nav-btn-log'), doc.querySelector('#desktop-nav [data-view="log"]')].filter(Boolean);
  }
  function renderBadge() {
    const c = draftState.counts || {};
    const failed = Number(c.failed) || 0;
    const pending = (Number(c.unsent) || 0) + failed;
    const count = unseen.size + pending;
    badgeTargets().forEach(button => {
      let badge = button.querySelector('.nav-badge');
      if (!count) { if (badge) badge.remove(); button.removeAttribute('data-has-badge'); return; }
      if (!badge) { badge = doc.createElement('span'); badge.className = 'nav-badge'; button.append(badge); }
      badge.textContent = count > 9 ? '9+' : String(count);
      badge.dataset.tone = failed ? 'bad' : (pending ? 'warn' : 'new');
      badge.setAttribute('role', 'img');
      badge.setAttribute('aria-label', unseen.size ? unseen.size + ' hasil baru' + (pending ? ', ' + pending + ' foto menunggu' : '') : pending + ' foto menunggu');
      button.dataset.hasBadge = 'true';
    });
  }
  function unseenStorageKey() {
    const account = typeof currentAccount !== 'undefined' && currentAccount ? String(currentAccount.id) : '';
    return account ? 'jk-unseen-' + account : null;
  }
  function loadUnseen() {
    unseenKey = unseenStorageKey();
    unseen = new Set();
    try { if (unseenKey) JSON.parse(root.localStorage.getItem(unseenKey) || '[]').forEach(id => unseen.add(String(id))); } catch (_) { /* storage blocked */ }
  }
  function saveUnseen() {
    try { if (unseenKey) root.localStorage.setItem(unseenKey, JSON.stringify([...unseen].slice(-50))); } catch (_) { /* per-viewer convenience only */ }
  }

  /* ------------------------------------------------------------------ "new version" prompt */
  function showUpdate(apply) {
    if (!updateBar) {
      updateBar = doc.createElement('section');
      updateBar.id = 'update-banner';
      updateBar.className = 'update-banner';
      updateBar.setAttribute('role', 'status');
      const text = doc.createElement('span');
      text.textContent = 'Versi baru tersedia';
      const button = doc.createElement('button');
      button.type = 'button';
      button.id = 'update-reload';
      button.className = 'btn btn-primary btn-sm';
      button.textContent = 'Muat ulang';
      updateBar.append(text, button);
      const header = doc.querySelector('#app-shell > header');
      if (header && header.parentNode) header.parentNode.insertBefore(updateBar, header.nextSibling); else doc.body.prepend(updateBar);
    }
    updateBar.hidden = false;
    const button = updateBar.querySelector('button');
    button.onclick = async () => {
      // A photo that is still on screen has not been saved anywhere yet: do not throw it away silently.
      if (typeof selectedImageBase64 !== 'undefined' && selectedImageBase64 && typeof confirmAction === 'function') {
        const ok = await confirmAction({ title: 'Muat ulang sekarang?', message: 'Foto yang belum dianalisis akan hilang. Kirim dulu atau ketuk Lanjut untuk memuat ulang.', okLabel: 'Lanjut' });
        if (!ok) return;
      }
      button.disabled = true;
      apply();
    };
  }
  doc.addEventListener('jk-update-ready', event => showUpdate(event.detail && event.detail.apply ? event.detail.apply : () => root.location.reload()));

  /* ------------------------------------------------------------------ Android back button (the native side dispatches `jagaBack`) */
  function visible(node) { return !!node && !node.classList.contains('hidden') && !node.hidden && node.getClientRects().length > 0; }
  function handleBack() {
    if (typeof activeDialog !== 'undefined' && activeDialog && !activeDialog.classList.contains('hidden')) {
      doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      return true;
    }
    const sheet = el('map-bottom-sheet');
    if (sheet && sheet.classList.contains('translate-y-0') && typeof closeBottomSheet === 'function') { closeBottomSheet(); return true; }
    if (visible(el('farm-sheet')) && typeof closeFarmPanel === 'function') { closeFarmPanel(); return true; }
    if (visible(el('farm-crops-sheet')) && typeof closeFarmCrops === 'function') { closeFarmCrops(); return true; }
    const viewer = el('photo-viewer');
    if (visible(viewer) && typeof closePhotoViewer === 'function') { closePhotoViewer(); return true; }
    if (root.JagaUx && typeof root.JagaUx.handleBack === 'function' && root.JagaUx.handleBack()) return true; // e.g. an open tree timeline
    if (typeof editingFarmId !== 'undefined' && (editingFarmId || (typeof gpsTraceWatchId !== 'undefined' && gpsTraceWatchId !== null) ||
        (typeof mapInstance !== 'undefined' && mapInstance && mapInstance.pm && mapInstance.pm.globalDrawModeEnabled && mapInstance.pm.globalDrawModeEnabled())) &&
        typeof cancelFarmDraw === 'function') { cancelFarmDraw(); return true; }
    const signedIn = typeof currentAccount !== 'undefined' && !!currentAccount;
    const home = el('view-home');
    if (signedIn && home && home.classList.contains('hidden') && typeof navigateToMenu === 'function') { navigateToMenu('home'); return true; }
    const plugin = root.Capacitor && root.Capacitor.Plugins && root.Capacitor.Plugins.JagaSync;
    // On Beranda (or the login screen) send the app to the background instead of closing it: an upload or a
    // half-typed note survives, and reopening is instant. exitApp() without options would close it.
    if (root.JagaNative && root.JagaNative.isNative() && plugin && typeof plugin.exitApp === 'function') {
      try { plugin.exitApp({ background: true }); } catch (_) { /* old APK: nothing to do */ }
      return true;
    }
    return false;
  }
  doc.addEventListener('jagaBack', handleBack);

  /* ------------------------------------------------------------------ adaptive background polling of submitted analyses (audit M5) */
  function hasPendingWork() {
    const drafts = typeof workflowDrafts !== 'undefined' ? workflowDrafts : [];
    const jobs = typeof workflowJobs !== 'undefined' ? [...workflowJobs.values()] : [];
    return drafts.some(d => ['submitted', 'pending', 'uploading'].includes(d.status)) || jobs.some(j => ['queued', 'claimed'].includes(j.status));
  }
  function schedulePoll(delay) {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(pollTick, delay);
  }
  async function pollTick() {
    pollTimer = null;
    if (!polling || typeof currentAccount === 'undefined' || !currentAccount) return;
    if (doc.hidden || isOffline()) { return; }            // resumed by visibilitychange / online
    if (!hasPendingWork()) return;                         // nothing waiting: stay quiet until kick()
    try { if (typeof refreshWorkflow === 'function') await refreshWorkflow(); } catch (_) { /* next tick */ }
    if (polling && hasPendingWork()) schedulePoll(typeof scanState !== 'undefined' && scanState === 'sent' ? 8000 : 20000);
  }
  doc.addEventListener('visibilitychange', () => { if (!doc.hidden && polling) { renderChip(); pollTick(); } });
  root.addEventListener('online', () => { renderChip(); renderBanner(); if (polling) shell.kick(); });
  root.addEventListener('offline', () => { renderChip(); renderBanner(); });

  /* ------------------------------------------------------------------ public API */
  const shell = {
    setAttention(key, message, options = {}) { attention.set(key, { message, tone: options.tone || 'warn', label: options.label, onClick: options.onClick }); renderBanner(); },
    clearAttention(key) { if (attention.delete(key)) renderBanner(); },
    /* workflow-ui calls this after every draft list refresh */
    setDraftState(state) {
      draftState = { ...draftState, ...state, counts: { ...draftState.counts, ...(state.counts || {}) } };
      shell.refresh();
      // New work appeared (a photo was sent, a draft is waiting for its result): make sure the poller is armed.
      if (polling && !pollTimer && !doc.hidden && !isOffline() && hasPendingWork()) schedulePoll(typeof scanState !== 'undefined' && scanState === 'sent' ? 8000 : 20000);
    },
    refresh() { renderChip(); renderBanner(); renderBadge(); },
    noteResult(record) {
      if (!record || !record.id) return;
      unseen.add(String(record.id));
      saveUnseen();
      renderBadge();
      if (typeof showToast === 'function') {
        const label = [record.cropName || record.crop, record.severity === 'Severe' ? 'Kritis' : record.severity === 'Moderate' ? 'Waspada' : record.severity === 'Healthy' ? 'Sehat' : '']
          .filter(Boolean).join(' — ');
        showToast('Hasil siap' + (label ? ': ' + label : '') + '. Lihat di Riwayat.');
      }
    },
    markSeen() { if (unseen.size) { unseen.clear(); saveUnseen(); renderBadge(); } },
    unseenCount() { return unseen.size; },
    openDrafts() {
      if (typeof navigateToMenu === 'function') navigateToMenu('log');
      const section = el('offline-drafts');
      if (root.JagaDraftsStrip && root.JagaDraftsStrip.expand) root.JagaDraftsStrip.expand();
      if (section && !section.hidden) setTimeout(() => section.scrollIntoView({ block: 'start' }), 60);
    },
    /* start/stop the adaptive poller; kick() re-arms it when new work appears */
    kick() { if (polling) schedulePoll(1500); },
    onSignedIn() { polling = true; loadUnseen(); shell.refresh(); shell.kick(); },
    onSignedOut() { polling = false; if (pollTimer) clearTimeout(pollTimer); pollTimer = null; unseen = new Set(); unseenKey = null; draftState = { ...draftState, label: '', attention: false, counts: { unsent: 0, processing: 0, failed: 0, active: 0 }, uploading: 0 }; attention.clear(); shell.refresh(); },
    handleBack,
  };
  root.JagaShell = shell;
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', () => shell.refresh()); else shell.refresh();
})(window);
