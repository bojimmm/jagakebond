    /* =====================================================================
       JagaKebond — field app

       Every list below is loaded from the server for the signed-in account.
       There is no seed data in this file: an account starts empty and fills
       up from real photos the farmer takes.
       ===================================================================== */

    // Loaded from the API. The names are the ones the render functions expect.
    let farmRecords = [];
    let dailyRecommendations = [];

    // Last known position and weather. Null until a real reading arrives —
    // nothing here is invented, and the UI shows "—" while it waits.
    let currentCoords = {
      lat: null, lng: null, elevation: null, accuracy: null,
      locationName: null, weather: null, tempC: null, rh: null
    };
    let gpsFailure = '';

    let currentAccount = null;
    let accountGeneration = 0;
    window.JagaAppAccount = () => currentAccount;
    window.JagaAppGeneration = () => accountGeneration;
    let authMode = 'login';
    let loadedOnce = false;

    let selectedImageBase64 = null;
    let capturePhotoSnapshot = null;
    let fullCapturePhoto = null;
    let stampedImageBlobUrl = null;
    let liveMediaStream = null;
    let cameraFacing = 'environment';
    let photoMode = 'live'; // 'live' | 'gallery'
    let selectedPhotoDateString = null;
    let selectedPhotoTimestampMs = null;
    let selectedPhotoMetadata = null;
    let pendingCropAssignment = null
    let activeLogTab = 'crops';
    let expandedCropId = null;
    let selectedCaptureTree = null;

    function clearCaptureTree() {
      selectedCaptureTree = null;
      const context = document.getElementById('capture-tree-context');
      if (context) { context.hidden = true; context.textContent = ''; }
    }

    async function startTreeCapture(cropId) {
      if (!currentAccount) return;
      const owner = String(currentAccount.id), generation = accountGeneration;
      const record = farmRecords.find(r => r.cropId === cropId || 'crop_legacy_' + r.id === cropId);
      if (!record) { showToast('Tanaman tidak ditemukan. Muat ulang riwayat terlebih dahulu.'); return; }
      // A sent or saved photo is finished, so the camera just opens. Only an unsent photo asks before it is dropped.
      if (hasUnsentPhoto()) {
        const drop = await confirmAction({ title: 'Foto belum dikirim', okLabel: 'Buang dan foto baru',
          message: 'Foto yang sedang terbuka belum dikirim. Buang foto itu dan memotret ' + (record.cropName || record.crop || 'tanaman ini') + '?' });
        if (!drop || generation !== accountGeneration || String(currentAccount?.id) !== owner) return;
      }
      if (!record.cropId) {
        try {
          await api('/api/records/' + encodeURIComponent(record.id), {method:'PUT', body:{cropId}});
          if (generation !== accountGeneration || String(currentAccount?.id) !== owner) return;
          record.cropId = cropId;
        } catch (error) { showToast('Riwayat belum dapat dihubungkan: ' + userMessage(error)); return; }
      }
      resetToLiveCamera();
      selectedCaptureTree = {cropId, cropName:record.cropName || record.crop, cropHint:record.crop, owner, generation};
      const context = document.getElementById('capture-tree-context');
      if (context) { context.hidden = false; context.textContent = 'Foto lanjutan: ' + selectedCaptureTree.cropName + '. Hasil akan masuk ke riwayat tanaman ini.'; }
      const hint = document.getElementById('crop-hint-input'); if (hint) hint.value = record.crop || '';
      navigateToMenu('scan');
    }
    let pendingDailyDraft = null;
    let mapInstance = null;
    let mapMarkersLayer = null;
    let mapPlantMarkers = [];
    const mapPinCountMarkers = new Map();
    let currentDetailRecord = null;
    let currentMapTileType = 'standard'; // OpenStreetMap standard tiles
    let activeTileLayer = null;
    let mapCenteredOnFix = false;
    let jobPollTimer = null;
    let submittedPollTimer = null;
    const receiptFailures = new Map();
    let syncNotice = '';

    /* Farm boundaries (petak). `farmList` mirrors GET /api/farms; the pending
       fields hold a boundary that has been drawn but not yet saved. */
    let farmList = [];
    let farmLayer = null;
    let traceLayer = null;
    let pendingFarmLayer = null;
    let pendingFarmRing = null;
    let pendingFarmArea = null;
    let pendingFarmSource = 'peta';
    let gpsTraceWatchId = null;
    let gpsTracePoints = [];
    let lastConfidenceShown = null;
    let selectedFarmId = null;
    let cameraRequestGeneration = 0;

    /* ---------------------------------- api ---------------------------------- */
    const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

    function readCookie(name) {
      const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
      return match ? decodeURIComponent(match[1]) : null;
    }

    // Lucide comes from a CDN; a slow or blocked load must not break the app.
    function icons() {
      try {
        if (typeof lucide !== 'undefined') lucide.createIcons();
      } catch (error) { /* icon set unavailable */ }
    }


    /* --------------------------------- account ------------------------------- */
    // `api(path, { anonymous: true })` means "a 401 here is a normal answer, not a dead
    // session". On the login form a 401 is simply a wrong email or password, and calling
    // forceSignOut() there replaced the server's useful message ("Email atau kata sandi
    // salah") with a misleading "Sesi berakhir" on the login screen itself.
    function showAuthGate(message) {
      const gate = document.getElementById('auth-gate');
      if (gate) gate.classList.remove('hidden');
      ['#desktop-nav', '#app-shell > header', '#app-shell > main', '#app-shell > nav'].forEach(selector => {
        const surface = document.querySelector(selector);
        if (surface) { surface.inert = true; surface.setAttribute('aria-hidden','true'); }
      });
      const err = document.getElementById('auth-error');
      if (err) {
        err.textContent = message || '';
        err.classList.toggle('hidden', !message);
      }
      const chip = document.getElementById('account-chip-label');
      if (chip) chip.innerText = 'Masuk';
      icons();
      // "Masuk dengan Google" (google-signin.js) checks the server and draws its button only while this screen is open.
      if (window.JagaGoogle) window.JagaGoogle.onGate(true);
    }

    function hideAuthGate() {
      const gate = document.getElementById('auth-gate');
      if (gate) gate.classList.add('hidden');
      const err = document.getElementById('auth-error');
      if (err) err.classList.add('hidden');
      ['#desktop-nav', '#app-shell > header', '#app-shell > main', '#app-shell > nav'].forEach(selector => {
        const surface = document.querySelector(selector);
        if (surface) { surface.inert = false; surface.removeAttribute('aria-hidden'); }
      });
      if (window.JagaGoogle) window.JagaGoogle.onGate(false);
    }

    function showAuthTab(mode) {
      authMode = mode === 'register' ? 'register' : 'login';
      const isRegister = authMode === 'register';
      const title = document.getElementById('auth-title');
      const description = document.getElementById('auth-description');
      if (title) title.textContent = isRegister ? 'Mulai catatan kebun Anda' : 'Masuk ke kebun Anda';
      if (description) description.textContent = isRegister
        ? 'Buat akun sesuai izin admin kebun Anda.' : 'Catatan tanaman Anda siap dilanjutkan.';
      const nameWrap = document.getElementById('auth-name-wrap');
      if (nameWrap) nameWrap.classList.toggle('hidden', !isRegister);
      document.getElementById('auth-submit').innerText = isRegister ? 'Daftar' : 'Masuk';
      [['auth-tab-login', !isRegister], ['auth-tab-register', isRegister]].forEach(([id, active]) => {
        const tab = document.getElementById(id);
        if (!tab) return;
        tab.classList.toggle('is-active', active);
        tab.setAttribute('aria-pressed', String(active));
      });
      const hint = document.getElementById('auth-hint');
      if (hint) {
        hint.innerText = isRegister
          ? 'Pendaftaran hanya terbuka bila admin mengizinkan.'
          : (document.getElementById('auth-tab-register').hidden
            ? 'Belum punya akun? Hubungi admin kebun Anda.'
            : 'Baru di JagaKebond? Buat akun untuk mulai mencatat.');
      }
      const password = document.getElementById('auth-password');
      document.getElementById('auth-error').classList.add('hidden');
      if (password) password.setAttribute('autocomplete', isRegister ? 'new-password' : 'current-password');
      if (password) {
        password.type = 'password';
        password.placeholder = isRegister ? 'Minimal 8 karakter' : 'Masukkan kata sandi';
      }
      const reveal = document.getElementById('auth-toggle-password');
      if (reveal) {
        reveal.textContent = 'Lihat';
        reveal.setAttribute('aria-pressed', 'false');
        reveal.setAttribute('aria-label', 'Tampilkan kata sandi');
      }
    }

    function wireAuthForm() {
      const form = document.getElementById('auth-form');
      if (!form) return;
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const submit = document.getElementById('auth-submit');
        const errorBox = document.getElementById('auth-error');
        errorBox.classList.add('hidden');
        submit.disabled = true;
        submit.innerText = authMode === 'register' ? 'Mendaftar…' : 'Masuk…';
        try {
          const body = {
            email: document.getElementById('auth-email').value.trim(),
            password: document.getElementById('auth-password').value,
          };
          if (authMode === 'register') body.name = document.getElementById('auth-name').value.trim();
          const payload = await api('/api/auth/' + (authMode === 'register' ? 'register' : 'login'),
                                    { method: 'POST', body, anonymous: true });
          document.getElementById('auth-password').value = '';
          await afterSignIn(payload.account);
        } catch (error) {
          errorBox.textContent = userMessage(error);
          errorBox.classList.remove('hidden');
        } finally {
          submit.disabled = false;
          submit.innerText = authMode === 'register' ? 'Daftar' : 'Masuk';
        }
      });
    }


    function resetAccountUiState() { JagaHooks.run('account-reset'); resetAccountUiStateCore(); }
    function resetAccountUiStateCore() {
      window.JagaTour?.reset();
      clearCaptureTree();
      if (dailyRefreshTimer) { clearTimeout(dailyRefreshTimer); dailyRefreshTimer = null; }
      cancelRequested = true;
      if (jobPollTimer) { clearTimeout(jobPollTimer); jobPollTimer = null; }
      if (submittedPollTimer) { clearInterval(submittedPollTimer); submittedPollTimer = null; }
      stopLiveCameraStream();
      farmRecords = [];
      dailyRecommendations = [];
      farmList = [];
      selectedFarmId = null;
      pendingPlaceHint = '';
      queuedPlaceSearch = null;
      closeFarmCrops();
      if (editingFarmLayer && mapInstance) mapInstance.removeLayer(editingFarmLayer);
      editingFarmLayer = null;
      editingFarmId = null;
      editingFarmGeneration = null;
      if (mapInstance?.pm) mapInstance.pm.disableDraw();
      pendingFarmLayer = null;
      pendingFarmRing = null;
      telemetrySnapshot = null;
      telemetryError = false;
      telemetrySample = null;
      gpsFailure = '';
      telemetryRequest = null;
      telemetryLastAttemptMs = null;
      telemetryAttemptGeneration = null;
      locationGeneration += 1;
      currentCoords = { lat: null, lng: null, elevation: null, accuracy: null,
        locationName: null, weather: null, tempC: null, rh: null };
      currentDetailRecord = null;
      pendingCropAssignment = null;
      pendingDailyDraft = null;
      selectedImageBase64 = null;
      selectedPhotoMetadata = null;
      selectedPhotoTimestampMs = null;
      selectedPhotoDateString = null;
      capturePhotoSnapshot = null;
      activeOfflineCapture = null;
      receiptFailures.clear();
      syncNotice = '';
      const syncBanner = document.querySelector('.sync-banner');
      if (syncBanner) syncBanner.hidden = true;
      closePhotoViewer();
      window.JagaAssessment?.clear();
      resolveConfirm(false);
      for (const id of Object.keys(dialogNames)) closeDialog(id);
      stampedImageBlobUrl = null;
      ['modal-account','modal-crop-assign','modal-daily','modal-status','modal-date-picker','modal-farm','modal-confirm']
        .forEach(id => { const el = document.getElementById(id); if (el) el.classList.add('hidden'); });
      ['#desktop-nav', '#app-shell > header', '#app-shell > main', '#app-shell > nav'].forEach(selector => {
        const surface = document.querySelector(selector);
        if (surface) { surface.inert = true; surface.setAttribute('aria-hidden', 'true'); }
      });
      resetMapPinPhotos();
      if (mapMarkersLayer) mapMarkersLayer.clearLayers();
      mapPlantMarkers = [];
      mapPinCountMarkers.clear();
      if (farmLayer) farmLayer.clearLayers();
      if (traceLayer) traceLayer.clearLayers();
      if (window.JagaNative && window.JagaNative.revokeImages) window.JagaNative.revokeImages();
      refreshAllHistoryViews();
    }


    /* --------------------------------- data --------------------------------- */
    function browserDataCache() {
      return window.JagaNative?.isNative() ? null : window.JagaOfflineStore;
    }

    async function cacheAccountData(owner,name,value) {
      const cache = browserDataCache();
      if (!owner || !cache) return;
      try { await cache.cachePut({accountId:owner,name,value}); }
      catch (_) { /* A cache failure must not hide successfully loaded server data. */ }
    }

    async function loadRecords() {
      const owner = currentAccount && String(currentAccount.id);
      try {
        farmRecords = (await fetchAllRecords()).map(normalizeRecord);
        await cacheAccountData(owner,'records',farmRecords);
      } catch (error) {
        if (error.offline) {
          if (owner && browserDataCache()) farmRecords = (await browserDataCache().cacheGet({accountId:owner,name:'records'}) || []).map(normalizeRecord);
          if (navigator.onLine !== false) showToast('Server belum bisa dihubungi. Menampilkan data terakhir.');
          return;
        }
        throw error;
      }
    }

    /* Contract 5.1: pages of 200 until `next` is null. An older server ignores `limit` and answers with the full
       array, which is used as is. The order is the server's, identical to the legacy list. */
    const RECORDS_PAGE = 200;
    const RECORDS_MAX_PAGES = 100;
    async function fetchAllRecords() {
      const all = [];
      let cursor = null;
      for (let page = 0; page < RECORDS_MAX_PAGES; page += 1) {
        const query = '?limit=' + RECORDS_PAGE + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
        const payload = await api('/api/records' + query);
        if (Array.isArray(payload)) return page === 0 ? payload : all.concat(payload);
        if (!payload || !Array.isArray(payload.items)) return all;
        all.push(...payload.items);
        if (!payload.next || payload.next === cursor) return all;
        cursor = String(payload.next);
      }
      return all;
    }
    /* Audit M11: a record with an empty crop or condition must never crash a list; the renderers show
       "Belum dinilai" for an unknown severity. Server-owned fields are kept as they are otherwise. */
    function canonicalCropName(value) {
      if (typeof value !== 'string') return value;
      const aliases = new Set(['ketapang','sea almond','tropical almond','indian almond','terminalia catappa']);
      const key = value.trim().replace(/\s+/g,' ').toLowerCase();
      const parts = /^([^()]+)\s*\(([^()]+)\)$/.exec(key);
      return aliases.has(key) || (parts && aliases.has(parts[1].trim()) && aliases.has(parts[2].trim()))
        ? 'Ketapang (Tropical Almond)' : value;
    }

    function normalizeRecord(rec) {
      if (!rec || typeof rec !== 'object') return { id: 'rusak_' + Math.random().toString(36).slice(2), crop: '', condition: '', severity: null };
      const out = { ...rec };
      out.crop = typeof rec.crop === 'string' ? rec.crop : (rec.crop == null ? '' : String(rec.crop));
      out.crop = canonicalCropName(out.crop);
      out.condition = typeof rec.condition === 'string' ? rec.condition : (rec.condition == null ? '' : String(rec.condition));
      if (rec.cropName != null && typeof rec.cropName !== 'string') out.cropName = String(rec.cropName);
      out.cropName = canonicalCropName(out.cropName);
      if (rec.locationName != null && typeof rec.locationName !== 'string') out.locationName = String(rec.locationName);
      if (out.id == null) out.id = 'rusak_' + Math.random().toString(36).slice(2);
      else out.id = String(out.id);
      return out;
    }

    async function loadDaily() {
      const owner = currentAccount && String(currentAccount.id);
      try {
        dailyRecommendations = (await api('/api/daily')) || [];
        await cacheAccountData(owner,'daily',dailyRecommendations);
      } catch (error) {
        if (!error.offline) throw error;
        if (owner && browserDataCache()) dailyRecommendations = await browserDataCache().cacheGet({accountId:owner,name:'daily'}) || [];
      }
    }

    let lastDataRefreshMs = 0;
    async function refreshAllData() { await refreshAllDataCore(); await JagaHooks.runAsync('data-refreshed'); }
    async function refreshAllDataCore() {
      try {
        await Promise.all([loadRecords(), loadDaily(), loadFarms()]);
        loadedOnce = true;
        lastDataRefreshMs = Date.now();
        refreshAllHistoryViews();
      } catch (error) {
        showToast(userMessage(error));
      }
    }

    async function refreshAllHistoryViews() {
      reconcileFarmMembership();
      updateDashboardTelemetry();
      renderHomeSummary();
      renderMapMarkers();
      renderLogRecords();
      renderDailyRecommendations();
      scheduleDailyRefresh();
      renderHomeHistoryCarousel();
      renderFarmList();
      // The petak tab only exists once a boundary has been drawn, and its contents track
      // the same records, so both need refreshing here.
      updateFarmTabVisibility();
      if (activeLogTab === 'petak') renderFarmLog();
      JagaHooks.run('history-shown');
    }

    /* -------------------------------- account UI ----------------------------- */
    function renderFastQuota() {
      // One "Analisis" button: the server decides per photo. This line says how much of the
      // fast allowance is left and what happens once it runs out, so a slower answer is
      // never mistaken for a bug.
      const account = currentAccount;
      const known = account && Object.hasOwn(account, 'fastQuota');
      const unlimited = known && account.role === 'admin' && account.fastQuota === null;
      const remaining = known && Number.isFinite(account.fastRemaining) ? Math.max(0, account.fastRemaining) : null;
      const status = document.getElementById('fast-quota-status');
      if (!status) return;
      if (unlimited) { status.textContent = 'Analisis cepat tanpa batas hari ini.'; return; }
      if (remaining === null) { status.textContent = ''; return; }
      status.textContent = remaining > 0
        ? 'Analisis cepat hari ini: sisa ' + remaining + ' dari ' + account.fastQuota + '. Setelah habis, foto masuk antrean biasa.'
        : 'Kuota analisis cepat hari ini habis. Foto berikutnya dianalisis lewat antrean biasa.';
    }

    async function refreshAccountQuota() {
      if (!currentAccount) return;
      const owner = currentAccount.id;
      const generation = accountGeneration;
      try {
        const result = await api('/api/auth/me');
        if (generation !== accountGeneration || result?.account?.id !== owner || currentAccount?.id !== owner) return;
        currentAccount = result.account;
      } catch (error) { /* Offline counters remain last-known, never inferred as unlimited. */ }
      if (generation === accountGeneration) renderFastQuota();
    }

    async function openAccountModal() {
      if (!currentAccount) { showAuthGate(''); return; }
      const generation = accountGeneration;
      document.getElementById('account-name').innerText = currentAccount.name || '—';
      document.getElementById('account-email').innerText = currentAccount.email;
      document.getElementById('account-role').innerText =
        currentAccount.role === 'admin' ? 'Admin' : currentAccount.role === 'priority' ? 'Prioritas' : 'Normal';
      document.getElementById('account-quota').innerText = fastQuotaShort(currentAccount);
      document.getElementById('account-records').innerText = farmRecords.length + ' foto';
      document.getElementById('pw-current').value = '';
      document.getElementById('pw-new').value = '';
      document.getElementById('pw-error').classList.add('hidden');
      setDialogOpen('modal-account');
      icons();
      await refreshAccountQuota();
      if (!currentAccount || generation !== accountGeneration) return;
      document.getElementById('account-role').innerText =
        currentAccount.role === 'admin' ? 'Admin' : currentAccount.role === 'priority' ? 'Prioritas' : 'Normal';
      document.getElementById('account-quota').innerText = fastQuotaShort(currentAccount);
    }
    // Short value for the account sheet: "2 dari 3 tersisa".
    function fastQuotaShort(account) {
      if (!account || !Object.hasOwn(account, 'fastQuota')) return 'Belum tersedia';
      if (account.role === 'admin' && account.fastQuota === null) return 'Tanpa batas';
      if (!Number.isFinite(account.fastQuota) || !Number.isFinite(account.fastRemaining)) return 'Belum tersedia';
      return Math.max(0, account.fastRemaining) + ' dari ' + account.fastQuota + ' tersisa';
    }

    function closeAccountModal() {
      closeDialog('modal-account');
    }

    async function changePassword() {
      const current = document.getElementById('pw-current').value;
      const next = document.getElementById('pw-new').value;
      const errorBox = document.getElementById('pw-error');
      errorBox.classList.add('hidden');
      if (!current || !next) {
        errorBox.textContent = 'Isi kata sandi saat ini dan kata sandi baru.';
        errorBox.classList.remove('hidden');
        return;
      }
      try {
        const result = await api('/api/auth/password', { method: 'POST', body: { current, new: next } });
        document.getElementById('pw-current').value = '';
        document.getElementById('pw-new').value = '';
        showToast('Kata sandi diperbarui' + (result.revokedSessions
          ? ' · ' + result.revokedSessions + ' perangkat lain dikeluarkan' : ''));
      } catch (error) {
        errorBox.textContent = userMessage(error);
        errorBox.classList.remove('hidden');
      }
    }

    window.onload = function() {
      if (typeof lucide !== 'undefined') {
        lucide.createIcons();
      }
      registerServiceWorker();
      // The GPS watcher starts after sign-in (session.js afterSignIn), never on the login screen (audit L).
      layoutScanFrame();
      window.addEventListener('resize', layoutScanFrame);
      if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(() => requestAnimationFrame(layoutScanFrame)).observe(document.getElementById('scan-stage'));
      }
      wireAuthForm();
      wireHomeCarousel();
      boot();
    };

    /* Desktop menu: full width or an icon rail. Only the layout changes; the labels stay readable to screen readers. */
    const NAV_COLLAPSED_KEY = 'jk-nav-collapsed';
    function applyDesktopNav(collapsed) {
      document.documentElement.classList.toggle('jk-nav-collapsed', collapsed);
      // Expanded: "Ciutkan menu" sits right of the name. Collapsed: the logo itself is the "Buka menu" button.
      const toggle = document.getElementById('desktop-nav-toggle'), expand = document.getElementById('desktop-nav-expand');
      if (toggle) toggle.setAttribute('aria-expanded', String(!collapsed));
      if (expand) {
        expand.tabIndex = collapsed ? 0 : -1;
        expand.setAttribute('aria-expanded', String(!collapsed));
        if (collapsed) expand.removeAttribute('aria-hidden'); else expand.setAttribute('aria-hidden', 'true');
      }
      document.querySelectorAll('#desktop-nav [data-view]').forEach(btn => {
        if (collapsed) btn.title = btn.textContent.trim();
        else btn.removeAttribute('title');
      });
    }
    function toggleDesktopNav() {
      const collapsed = !document.documentElement.classList.contains('jk-nav-collapsed');
      applyDesktopNav(collapsed);
      try { window.localStorage.setItem(NAV_COLLAPSED_KEY, collapsed ? '1' : '0'); } catch (_) { /* optional */ }
      // The button that was pressed disappears, so keyboard focus moves to the one that reverses it.
      const next = document.getElementById(collapsed ? 'desktop-nav-expand' : 'desktop-nav-toggle');
      if (next && document.activeElement && document.activeElement.closest('.desktop-brand')) next.focus();
      // The map and scan frame size themselves to their box: re-measure now and after the 200 ms width animation.
      const remeasure = () => {
        if (mapInstance) mapInstance.invalidateSize();
        layoutScanFrame();
        updateCarouselNav();
      };
      requestAnimationFrame(remeasure);
      setTimeout(remeasure, 260);
    }
    // Applied before the first paint, so a collapsed menu never flashes open.
    try { applyDesktopNav(window.localStorage.getItem(NAV_COLLAPSED_KEY) === '1'); } catch (_) { applyDesktopNav(false); }


    function syncSidebarAccountUi() {
      const labelEl = document.getElementById('sidebar-account-label');
      const subEl = document.getElementById('sidebar-account-sub');
      const avEl = document.getElementById('sidebar-account-avatar');
      if (!labelEl && !subEl && !avEl) return;
      const name = String(currentAccount?.name || currentAccount?.email || 'Petani').trim();
      const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0].toUpperCase()).join('') || 'JK';
      const roleLabel = currentAccount?.role === 'admin' ? 'Admin' : currentAccount?.role === 'priority' ? 'Prioritas' : 'Petani';
      if (labelEl) labelEl.textContent = name;
      if (subEl) subEl.textContent = currentAccount?.email ? (roleLabel + ' · ' + currentAccount.email) : 'Kelola akun & data';
      if (avEl) avEl.textContent = initials;
    }

    function syncSidebarSyncBox() {
      const box = document.getElementById('sidebar-sync-box');
      if (!box) return;
      const titleEl = document.getElementById('sidebar-sync-title');
      const badgeEl = document.getElementById('sidebar-sync-badge');
      const subEl = document.getElementById('sidebar-sync-sub');
      const syncEl = document.getElementById('sync-status');
      const offline = navigator.onLine === false || syncEl?.dataset?.tone === 'offline';
      const activeSync = syncEl && !syncEl.classList.contains('hidden') && syncEl.dataset.tone;
      if (offline) {
        box.classList.remove('is-synced');
        if (titleEl) titleEl.textContent = 'Mode Offline';
        if (badgeEl) { badgeEl.className = 'badge badge-moderate'; badgeEl.textContent = 'Offline'; }
        if (subEl) subEl.textContent = syncEl?.title || 'Foto disimpan lokal dan dikirim otomatis saat online.';
      } else if (activeSync) {
        const tone = syncEl.dataset.tone;
        box.classList.remove('is-synced');
        if (titleEl) titleEl.textContent = syncEl.textContent.trim() || 'Menunggu Sinkron';
        if (badgeEl) {
          badgeEl.className = 'badge ' + (tone === 'bad' ? 'badge-severe' : 'badge-moderate');
          badgeEl.textContent = tone === 'bad' ? 'Perlu Cek' : 'Antre';
        }
        if (subEl) subEl.textContent = syncEl.title || 'Foto draf sedang diproses ke server.';
      } else {
        box.classList.add('is-synced');
        if (titleEl) titleEl.textContent = 'Semua Foto Terkirim';
        if (badgeEl) { badgeEl.className = 'badge badge-healthy'; badgeEl.textContent = 'Sinkron'; }
        if (subEl) subEl.textContent = 'Data kebun tersimpan aman di perangkat & server.';
      }
    }

    function updateTopPageSub(menu) {
      const subEl = document.getElementById('top-page-sub');
      if (!subEl) return;
      const target = menu || currentMenuName || 'home';
      if (target === 'home') {
        const snapshotMoved = telemetrySnapshot && !nearbyFix(telemetrySnapshot, currentCoords.lat, currentCoords.lng);
        const home = snapshotMoved ? currentCoords : (telemetrySnapshot || currentCoords);
        const place = (!snapshotMoved && home.locationName) ? home.locationName : 'Lokasi Kebun';
        const parts = [place];
        if (typeof home.tempC === 'number') parts.push(Math.round(home.tempC) + '°C');
        if (typeof home.rh === 'number') parts.push('RH ' + Math.round(home.rh) + '%');
        subEl.textContent = parts.length > 1 ? parts.join(' · ') : 'Menunggu lokasi & cuaca kebun…';
      } else if (target === 'scan') {
        subEl.textContent = 'Kamera berstempel GPS & panduan tindakan';
      } else if (target === 'map') {
        const treeTotal = groupRecordsByCrop(farmRecords).length;
        subEl.textContent = farmList.length
          ? (farmList.length + ' Petak Aktif · ' + treeTotal + ' Tanaman Terpantau')
          : 'Lihat posisi petak dan titik tanaman';
      } else if (target === 'log') {
        subEl.textContent = 'Progres pemulihan dan antrean offline';
      }
    }

    if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
      const syncStatusNode = document.getElementById('sync-status');
      if (syncStatusNode) {
        new MutationObserver(syncSidebarSyncBox).observe(syncStatusNode, { attributes: true, childList: true, subtree: true });
      }
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', syncSidebarSyncBox);
      window.addEventListener('offline', syncSidebarSyncBox);
    }

    // Public entry: the screen change, then whatever later scripts registered for it (JagaHooks 'menu-shown').
    function navigateToMenu(targetMenu) { navigateToMenuCore(targetMenu); JagaHooks.run('menu-shown', targetMenu); }
    function navigateToMenuCore(targetMenu) {
      if (targetMenu !== 'scan' && !selectedImageBase64) clearCaptureTree();
      if (targetMenu !== 'map') {
        closeFarmPanel();
        closeFarmCrops();
        closeBottomSheet();
      }
      if (targetMenu !== 'map' && (editingFarmId || gpsTraceWatchId !== null || mapInstance?.pm?.globalDrawModeEnabled())) cancelFarmDraw();
      document.querySelectorAll('.menu-view').forEach(view => {
        view.classList.add('hidden');
      });

      const targetEl = document.getElementById(`view-${targetMenu}`);
      if (targetEl) {
        targetEl.classList.remove('hidden');
      }
      currentMenuName = targetMenu;
      if (targetMenu !== 'map' && visibleMapPhotoPins.size) refreshMapPinPhotos();
      document.dispatchEvent(new CustomEvent('jaga-menu-changed', { detail: { menu: targetMenu } }));
      if (targetMenu === 'log') {
        // Tapping the Riwayat tab always opens the list; only openTreeTimeline() keeps a timeline open.
        if (!keepTimelineOnNavigate) expandedCropId = null;
        keepTimelineOnNavigate = false;
        renderLogRecords();
      }

      ['home', 'map', 'log', 'scan'].forEach(tabKey => {
        const btn = document.getElementById(`nav-btn-${tabKey}`);
        if (btn) {
          btn.classList.toggle('is-active', tabKey === targetMenu);
          if (tabKey === targetMenu) btn.setAttribute('aria-current', 'page');
          else btn.removeAttribute('aria-current');
        }
      });
      document.querySelectorAll('#desktop-nav [data-view]').forEach(btn => {
        const active = btn.getAttribute('data-view') === targetMenu;
        btn.classList.toggle('is-active', active);
        if (active) btn.setAttribute('aria-current', 'page');
        else btn.removeAttribute('aria-current');
      });
      const title = document.getElementById('desktop-page-title');
      if (title) title.textContent = ({ home: 'Beranda', map: 'Peta', scan: 'Foto Tanaman', log: 'Riwayat' })[targetMenu] || 'Beranda';
      const topTitle = document.getElementById('top-page-title');
      if (topTitle) {
        topTitle.textContent = ({
          home: 'Beranda Kebun',
          scan: 'Foto & Analisis Tanaman',
          map: 'Peta Kebun Interaktif',
          log: 'Riwayat Tanaman & Petak'
        })[targetMenu] || 'Beranda Kebun';
      }
      updateTopPageSub(targetMenu);
      syncSidebarAccountUi();
      syncSidebarSyncBox();

      if (targetMenu === 'scan') {
        requestAnimationFrame(() => layoutScanFrame());
      }
      if (targetMenu === 'map') {
        loadMapFeature();
        updateMapOfflineNote();
      }

      // Don't touch the camera or the API before there is a session.
      const signedIn = !!currentAccount;
      if (signedIn && targetMenu === 'scan' && photoMode === 'live' && !selectedImageBase64) {
        startLiveCameraStream();
      } else if (targetMenu !== 'scan') {
        stopLiveCameraStream();
      }
      // Pull fresh server state on the reading screens, so a second device's
      // records show up without a reload.
      if (signedIn && (targetMenu === 'home' || targetMenu === 'log') && Date.now() - lastDataRefreshMs > 30000) {
        refreshAllData();
      }
    }
    let currentMenuName = 'home';
    let mapNeedsFit = true;


    /* ---------------------- analysis: the real pipeline ----------------------
       The camera, capture, upload, progress, result and tree-assignment code lives in scan-flow.js;
       session, API client and service-worker code in session.js. The state they share stays here. */
    let activeJobId = null;
    let activeOfflineCapture = null;
    let cancelRequested = false;

    function buildRecordFromJob(job, diagnosis, imageUrl) {
      const context = job.context || {};
      return {
        id: 'record_' + String(job.id),
        cropId: context.cropId || null,
        cropName: context.cropId ? (farmRecords.find(r => r.cropId === context.cropId)?.cropName || null) : null,
        timestampMs: context.photoTimestampMs ?? null,
        crop: diagnosis.crop || 'Tanaman',
        condition: diagnosis.condition || 'Tidak diketahui',
        severity: diagnosis.severity || 'Moderate',
        lat: context.lat,
        lng: context.lng,
        elevation: context.elevation,
        locationName: context.locationName || null,
        accuracy: context.accuracy,
        date: context.photoDate || '',
        symptoms: diagnosis.symptoms_id || diagnosis.symptoms || null,
        geocorrelation: diagnosis.geocorrelation || null,
        immediate_action: diagnosis.immediate_action || diagnosis.immediate_action_id || '',
        assessment: diagnosis.assessment || null,
        suitability: diagnosis.suitability || null,
        needs_review: diagnosis.needs_review === true,
        confidence: typeof diagnosis.confidence === 'number' ? diagnosis.confidence : null,
        imageUrl: imageUrl,
        source: 'ai'
      };
    }

    // The worker can finish long after the phone stopped watching: the farmer cancelled,
    // closed the app, or the poll ran out of attempts. The server keeps every result, and
    // /api/queue/pending hands back the terminal-but-unacknowledged ones, so they become
    // records on the next visit instead of being paid for and silently lost.
    async function resumeSubmittedDrafts() {
      if (!currentAccount || !window.JagaNative) return;
      const accountGenerationAtStart = accountGeneration;
      let receipts;
      try {
        receipts = window.JagaNative.isNative()
          ? (await window.JagaNative.list({ accountId: String(currentAccount.id) })).drafts.filter(row => row.status === 'submitted')
          : await window.JagaOfflineStore.submitted(String(currentAccount.id));
      }
      catch (_) { return; }
      for (const receipt of receipts) {
        if (!currentAccount || accountGenerationAtStart !== accountGeneration || String(currentAccount.id) !== String(receipt.accountId)) return;
        if (!receipt.jobId) continue;
        try {
          const job = await api('/api/analyze/' + encodeURIComponent(receipt.jobId));
          if (accountGenerationAtStart !== accountGeneration) return;
          if (job.status === 'done' && job.diagnosis) {
            const saved = await saveRecord(buildRecordFromJob(job, job.diagnosis, null));
            if (!saved || accountGenerationAtStart !== accountGeneration) continue;
            acknowledgeJob(job.id);
            await window.JagaNative.remove({ accountId: String(receipt.accountId), clientRequestId: receipt.clientRequestId });
            receiptFailures.delete(receipt.clientRequestId);
          } else if (['failed', 'cancelled', 'rejected'].includes(job.status)) {
            receiptFailures.set(receipt.clientRequestId, {jobId:job.id, error:job.error || 'Analisis tidak selesai. Ambil foto baru atau buang draf.'});
          }
        } catch (_) { /* preserve receipt until next connected visit */ }
      }
      await updateOfflineDraftCount();
    }

    window.onOfflineDraftSubmitted = async function(draft) {
      const account = currentAccount;
      if (!account || String(account.id) !== String(draft.accountId)) return;
      syncNotice = '';
      // The scan screen already says "Foto terkirim" for the photo the farmer is looking at (UX G4: one message).
      const foreground = activeOfflineCapture && activeOfflineCapture.clientRequestId === draft.clientRequestId;
      if (!foreground) showToast('Foto terkirim. Hasilnya masuk ke Riwayat.');
      if (window.JagaShell) window.JagaShell.kick();
      await updateOfflineDraftCount();
    };
    window.onOfflineSyncError = function(error) {
      if (!error) return;
      // Contract 5.2: another account owns this browser's session now. Stop, keep the drafts, reload the tab.
      if (error.accountMismatch) { if (typeof handleAccountMismatch === 'function') handleAccountMismatch(error.message); return; }
      if (error.auth) { forceSignOut('Sesi berakhir. Masuk lagi untuk mengirim foto yang tersimpan.'); return; }
      syncNotice = error.serverVersion ? 'Server perlu diperbarui. Foto tetap tersimpan di HP.' : '';
      updateOfflineDraftCount();
    };
    /* One short Bahasa status per draft (UX brief D1). */
    function draftSyncLabel(draft) {
      if (!draft) return 'Menunggu sinyal';
      if (draft.status === 'submitted') return 'Sedang dianalisis';
      if (draft.status === 'uploading') return 'Sedang dikirim';
      if (draft.status === 'editing') return 'Siap dikirim';
      if (draft.status === 'conflict' || draft.error === 'idempotency_conflict') return 'Perlu dicek di Riwayat';
      // Error values written by the Android outbox (0.2.2.0) and the server's wait-and-retry codes.
      const error = String(draft.error || '');
      // `code` = errorCode (web outbox) or a code-like error value (Android outbox writes codes into `error`).
      const code = String(draft.errorCode || (/^[a-z_]+(?::|$)|^http_\d{3}$|^health_http_\d{3}$/.test(error) ? error : ''));
      if (error === 'photo_too_large' || code === 'http_413') return 'Foto terlalu besar — foto ulang';
      if (error.startsWith('invalid:') || /^http_4(?:00|22)$/.test(code)) return 'Ditolak server — foto ulang';
      if (/^health_http_\d{3}$/.test(code)) return 'Server belum bisa dicek — dicoba lagi otomatis';
      if (error === 'account_mismatch') return 'Akun berganti — masuk lagi';
      if (error === 'server_failures') return 'Server bermasalah — coba lagi nanti';
      if (error === 'store_error') return 'Penyimpanan HP bermasalah';
      if (error === 'image_missing' || error === 'image_unreadable') return 'Foto rusak — hapus lalu foto ulang';
      if (error === 'server_update_required') return 'Server perlu diperbarui';
      if (error === 'authentication_required') return 'Masuk lagi untuk mengirim';
      const serverCode = String(draft.serverCode || '');
      if (serverCode === 'queue_full') return 'Antrean Anda penuh — dikirim nanti';
      if (serverCode === 'queue_busy' || serverCode === 'decode_busy') return 'Server sibuk — dicoba lagi otomatis';
      if (serverCode === 'photo_quota') return 'Batas kiriman tercapai — dicoba lagi nanti';
      if (['failed', 'rejected', 'cancelled', 'blocked'].includes(draft.status)) return 'Gagal — coba lagi';
      if (code === 'retry_after' || /^http_5\d\d$/.test(code) || Number(draft.nextAttemptAtMs) > Date.now()) return 'Server sibuk — dicoba lagi otomatis';
      if (code === 'timeout') return 'Sinyal lemah — dicoba lagi otomatis';
      return navigator.onLine === false ? 'Menunggu sinyal' : 'Menunggu dikirim';
    }

    // The server save. workflow-ui.js defines saveRecord(), which keeps the photo on the phone and calls this (0.2.4.16).
    async function saveRecordToServer(record) {
      try {
        const saved = normalizeRecord(await api('/api/records', { method: 'POST', body: record }));
        record.imageUrl = saved.imageUrl || record.imageUrl || null;
        const index = farmRecords.findIndex(r => r.id === saved.id);
        if (index >= 0) farmRecords[index] = saved; else farmRecords.unshift(saved);
        refreshAllHistoryViews();
        return saved;
      } catch (error) {
        if (!error.stale) showToast('Hasil belum tersimpan: ' + userMessage(error));
        return null;
      }
    }

    async function syncPendingDrafts() {
      const account = currentAccount;
      const generation = accountGeneration;
      if (!account) { showToast('Masuk dulu untuk mengirim foto yang tersimpan.'); return; }
      syncNotice = '';
      try {
        if (window.JagaNative && window.JagaNative.isNative()) {
          await window.JagaNative.activate({ accountId: String(account.id) });
          if (generation !== accountGeneration || String(currentAccount?.id) !== String(account.id)) return;
          await resumeSubmittedDrafts();
          await updateOfflineDraftCount();
          return;
        }
        if (navigator.onLine === false) showToast('Belum ada sinyal. Foto dikirim otomatis saat ada sinyal.');
        else if (window.JagaOfflineSync) await window.JagaOfflineSync.run({ manual: true });
        await resumeSubmittedDrafts();
        await updateOfflineDraftCount();
      } catch (error) {
        if (generation !== accountGeneration || String(currentAccount?.id) !== String(account.id)) return;
        syncNotice = 'Belum bisa mengirim: ' + userMessage(error);
        await updateOfflineDraftCount();
      }
    }
    window.syncPendingDrafts = syncPendingDrafts;

    async function recoverPendingAnalyses() {
      if (!currentAccount) return;
      const owner = String(currentAccount.id), generation = accountGeneration;
      const isCurrent = () => generation === accountGeneration && String(currentAccount?.id) === owner;
      let pending;
      try {
        pending = await api('/api/queue/pending');
      } catch (error) {
        return;   // recovery is a bonus; never block sign-in on it
      }
      if (!isCurrent() || !Array.isArray(pending) || pending.length === 0) return;

      let recovered = 0;
      for (const job of pending) {
        if (!isCurrent()) return;
        if (job.status === 'done' && job.diagnosis) {
          // The stamped photo is not available this late, but the diagnosis, location
          // and severity all are — that is the part worth keeping.
          const saved = await saveRecord(buildRecordFromJob(job, job.diagnosis, null));
          if (!isCurrent()) return;
          if (!saved) continue;   // leave it unacknowledged so the next visit retries
          recovered += 1;
        }
        // Rejected jobs have nothing to save, but they must still be acknowledged or
        // they would be re-fetched on every launch forever.
        if (['done','failed','cancelled','rejected'].includes(job.status)) acknowledgeJob(job.id);
      }
      if (recovered > 0) {
        showToast(recovered + ' hasil analisis yang tertunda sudah masuk ke Riwayat.');
      }
    }

    function roundRectPath(ctx, x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    /* Geotag stamp, drawn in the photo's bottom-left like field-survey cameras do: one translucent rounded panel,
       every line left-aligned and measured, sizes scale with the photo. The diagnosis and the place may take two
       lines (then end in "…"); the brand sits at the end of the last, shortest line, so nothing can overlap.
         [WASPADA] Jagung (Corn) · Bule (Downy Mildew)
                   pada daun muda
         Petak Kebun Cabe, Ciomas
         -3.443600°, 104.043900°  ±12 m
         Rab, 28 Okt 2026 · 19.42 WIB
         Elevasi 27 m dpl · 25°C • 98% RH                 [logo] JagaKebond */
    function stampTimeText(metadata) {
      const value = metadata.photoTimestampMs ?? metadata.captureTimeMs;
      const ms = value === null || value === undefined || value === "" ? NaN : Number(value);
      if (Number.isFinite(ms) && Number.isFinite(new Date(ms).getTime())) {
        const d = new Date(ms);
        const day = new Intl.DateTimeFormat('id-ID', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(d);
        const time = new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(d);
        return day + ' · ' + time + (/EXIF/.test(metadata.photoDate || '') ? ' · zona EXIF tidak diketahui' : /manual/.test(metadata.photoDate || '') ? ' · waktu manual' : '');
      }
      // Older drafts only carry the long text form; keep its date part, not the provenance note in brackets.
      if (metadata.photoDate) return String(metadata.photoDate).split(' (')[0];
      return 'Waktu foto tidak diketahui';
    }
    function drawGeotagStamp(ctx, w, h, metadata, diagnosis, logo = null) {
      if (diagnosis) diagnosis = {...diagnosis,crop:canonicalCropName(diagnosis.crop),severity:diagnosis.observedSeverity||diagnosis.severity};
      const font = (weight, size) => weight + ' ' + Math.round(size) + "px 'Google Sans', system-ui, sans-serif";
      const base = Math.max(14, Math.min(72, Math.round(Math.min(w, h) * 0.034)));
      const margin = Math.round(base * 0.9), pad = Math.round(base * 0.8), gap = Math.round(base * 0.35);
      const panelW = w - margin * 2, innerW = panelW - pad * 2;
      const ellipsize = (text, maxWidth) => {
        if (ctx.measureText(text).width <= maxWidth) return text;
        while (text.length > 1 && ctx.measureText(text + '…').width > maxWidth) text = text.slice(0, -1);
        return text.trimEnd() + '…';
      };
      // Word wrap into at most `maxLines` lines; the first line may be narrower (it sits beside the status pill).
      const wrap = (text, firstWidth, restWidth, maxLines) => {
        const words = String(text || '').split(/\s+/).filter(Boolean), lines = [];
        let line = '';
        for (let i = 0; i < words.length; i++) {
          const width = lines.length ? restWidth : firstWidth, next = line ? line + ' ' + words[i] : words[i];
          if (ctx.measureText(next).width <= width || !line) { line = next; continue; }
          lines.push(line);
          line = words[i];
          if (lines.length === maxLines - 1) { line = words.slice(i).join(' '); break; }
        }
        if (line) lines.push(line);
        return lines.map((l, i) => ellipsize(l, i ? restWidth : firstWidth));
      };
      const num = v => (v === null || v === undefined || v === '' ? NaN : Number(Array.isArray(v) ? v[0] : v));
      const lat = num(metadata.lat), lng = num(metadata.lng), acc = num(metadata.accuracy), elev = num(metadata.elevation);
      const hasFix = Number.isFinite(lat) && Number.isFinite(lng);

      // Brand: measured first, so the last row knows how much room it leaves.
      const mark = Math.round(base * 1.2), brandGap = Math.round(base * 0.35);
      ctx.font = font(700, base * 0.8);
      const brandText = 'JagaKebond', brandW = mark + brandGap + ctx.measureText(brandText).width;

      const rows = [];
      if (diagnosis) {
        const meta = severityMeta(diagnosis.severity);
        const colors = { Severe: ['#dc2626', '#ffffff'], Moderate: ['#f59e0b', '#0f172a'], Healthy: ['#15803d', '#ffffff'] };
        const [bg, fg] = colors[diagnosis.severity] || ['#e2e8f0', '#0f172a'];
        const label = meta.label.toUpperCase();
        ctx.font = font(800, base * 0.72);
        const pillPad = Math.round(base * 0.45), pillW = ctx.measureText(label).width + pillPad * 2, indent = pillW + Math.round(base * 0.45);
        ctx.font = font(700, base * 0.95);
        const text = [diagnosis.crop, diagnosis.condition].filter(Boolean).join(' · ') || 'Hasil analisis';
        rows.push({ kind: 'diagnosis', size: base * 0.95, weight: 700, color: '#ffffff', label, bg, fg, pillPad, pillW, indent,
          lines: wrap(text, innerW - indent, innerW - indent, 2), lineH: Math.max(base * 1.4, base * 0.95 * 1.3) });
      }
      const plain = (size, weight, color, text, maxLines, width = innerW) => {
        ctx.font = font(weight, size);
        rows.push({ size, weight, color, lines: wrap(text, width, width, maxLines), lineH: size * 1.32 });
      };
      plain(base * 0.95, 700, '#ffffff', metadata.locationName || 'Lokasi tidak diketahui', 2);
      plain(base * 0.8, 500, '#e2e8f0', hasFix ? lat.toFixed(6) + '°, ' + lng.toFixed(6) + '°' + (Number.isFinite(acc) ? '  ±' + Math.round(acc) + ' m' : '') : 'GPS tidak tersedia', 1);
      const extra = [Number.isFinite(elev) ? 'Elevasi ' + Math.round(elev) + ' m dpl' : '', metadata.weather || ''].filter(Boolean).join(' · ');
      plain(base * 0.75, 500, '#e2e8f0', stampTimeText(metadata), 1, extra ? innerW : innerW - brandW - base);
      if (stampTimeText(metadata) === 'Waktu foto tidak diketahui') {
        const added = metadata.addedTimeMs ?? metadata.importedAtMs;
        const when = added == null ? metadata.exportedAtMs : added;
        if (Number.isFinite(Number(when)) && when != null) plain(base * 0.75,500,'#cbd5e1',(added == null ? 'Diekspor ' : 'Ditambahkan ') + stampTimeText({photoTimestampMs:when}),2,extra?innerW:innerW-brandW-base);
      }
      if (extra) plain(base * 0.75, 500, '#cbd5e1', extra, 1, innerW - brandW - base);
      rows.forEach(r => { r.height = r.lines.length * r.lineH; });

      const panelH = pad * 2 + rows.reduce((sum, r) => sum + r.height, 0) + gap * (rows.length - 1);
      const x = margin, top = h - margin - panelH, left = x + pad;
      ctx.save();
      ctx.fillStyle = 'rgba(15, 23, 42, 0.74)';
      roundRectPath(ctx, x, top, panelW, panelH, Math.round(base * 0.6));
      ctx.fill();
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';

      let y = top + pad, lastMid = 0;
      for (const r of rows) {
        r.lines.forEach((line, i) => {
          const mid = y + r.lineH * (i + 0.5);
          let tx = left;
          if (r.kind === 'diagnosis') {
            tx = left + r.indent;   // hanging indent: continuation lines start under the text, not under the pill
            if (i === 0) {
              const pillH = Math.round(base * 1.25);
              ctx.fillStyle = r.bg;
              roundRectPath(ctx, left, mid - pillH / 2, r.pillW, pillH, Math.round(base * 0.3));
              ctx.fill();
              ctx.font = font(800, base * 0.72);
              ctx.fillStyle = r.fg;
              ctx.fillText(r.label, left + r.pillPad, mid + 1);
            }
          }
          ctx.font = font(r.weight, r.size);
          ctx.fillStyle = r.color;
          ctx.fillText(line, tx, mid);
          lastMid = mid;
        });
        y += r.height + gap;
      }

      const brandX = left + innerW - brandW;
      if (logo) {
        ctx.fillStyle = '#ffffff';
        roundRectPath(ctx,brandX,lastMid-mark/2,mark,mark,Math.round(mark*.2));ctx.fill();
        ctx.drawImage(logo,brandX,lastMid-mark/2,mark,mark);
      }
      ctx.textAlign = 'left';
      ctx.font = font(700, base * 0.8);
      ctx.fillStyle = '#cbd5e1';
      ctx.fillText(brandText, brandX + mark + brandGap, lastMid);
      ctx.restore();
    }

    let stampLogoPromise = null;
    function loadStampLogo() {
      if (!stampLogoPromise) stampLogoPromise = new Promise(resolve => {
        const logo = new Image();
        const timer = setTimeout(() => { stampLogoPromise=null;resolve(null); },3000);
        logo.onload=()=>{clearTimeout(timer);resolve(logo);};
        logo.onerror=()=>{clearTimeout(timer);stampLogoPromise=null;resolve(null);};
        logo.src=new URL('icons/logo-256.png?v=3',document.baseURI).href;
      });
      return stampLogoPromise;
    }
    async function bakeStampIntoCanvas(imageSource, metadata, diagnosis = null) {
      return new Promise((resolve) => {
        if (!imageSource) { resolve(null); return; }
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = async function() {
          canvas.width = img.naturalWidth || 1080;
          canvas.height = img.naturalHeight || 1440;

          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

          // A drawing error must never leave the photo unsaved: the plain photo is still returned.
          try {
            const logo=await loadStampLogo();if(!logo){resolve(null);return;}
            drawGeotagStamp(ctx, canvas.width, canvas.height, metadata || {}, diagnosis, logo);
            resolve(canvas.toDataURL('image/jpeg',0.92));
          } catch (error) { console.warn('Stamp drawing failed:', error);resolve(null); }
        };
        img.onerror = () => resolve(null);
        img.src = imageSource;
      });
    }



    const MAP_MAX_ZOOM = 22;
    const MAP_PLOT_COLOR = '#c026d3';
    function farmBoundaryStyle(selected = false) {
      return { color: MAP_PLOT_COLOR, weight: selected ? 5 : 3,
        fillColor: '#e879f9', fillOpacity: selected ? 0.20 : 0.12,
        dashArray: selected ? null : '8 5', className: 'farm-boundary' };
    }

    let mapFeatureRequest = null;
    function loadMapFeature() {
      if (mapFeatureRequest) return mapFeatureRequest;
      const mapEl = document.getElementById('map-container');
      const status = document.getElementById('map-load-status');
      const message = document.getElementById('map-load-message');
      const retry = document.getElementById('map-load-retry');
      mapEl?.setAttribute('aria-busy', 'true');
      status?.classList.remove('hidden');
      if (message) message.textContent = 'Memuat alat peta…';
      if (retry) retry.hidden = true;
      mapFeatureRequest = JagaFeatures.load('map').then(() => {
        if (currentMenuName !== 'map' || !currentAccount) return;
        ensureMap();
        if (mapInstance) {
          mapInstance.invalidateSize();
          if (mapNeedsFit) { mapNeedsFit = false; fitMapBounds(); }
          layoutMapPins();
        }
        status?.classList.add('hidden');
      }).catch(() => {
        if (message) message.textContent = 'Alat peta belum dapat dimuat. Sambungkan internet lalu coba lagi. Catatan tanaman tetap tersedia di Riwayat.';
        if (retry) retry.hidden = false;
      }).finally(() => {
        mapEl?.removeAttribute('aria-busy');
        mapFeatureRequest = null;
      });
      return mapFeatureRequest;
    }

    function initMap() {
      if (mapInstance || typeof L === 'undefined') return;
      const mapEl = document.getElementById('map-container');
      if (!mapEl) return;

      // Start wide instead of pretending to know where the farmer is: a null
      // position used to be impossible here, and setView([null, null]) throws.
      // The view recentres on the first real GPS fix. The map is built on the first visit to
      // the Peta tab (not at launch) so Beranda opens faster on low-end phones.
      mapInstance = L.map('map-container', { zoomControl: false, attributionControl: true, maxZoom: MAP_MAX_ZOOM })
        .setView([-2.5, 118.0], 5);   // Indonesia, country scale
      setMapTileLayer(savedMapLayer());

      mapMarkersLayer = L.layerGroup().addTo(mapInstance);
      mapInstance.on('moveend resize', layoutMapPins);
      farmLayer = L.layerGroup().addTo(mapInstance);
      traceLayer = L.layerGroup().addTo(mapInstance);
      wireFarmDrawing();
      renderFarmPolygons();
      renderMapMarkers();
      if (validCoordinates(currentCoords.lat, currentCoords.lng)) {
        mapInstance.setView([currentCoords.lat, currentCoords.lng], 15);
        mapCenteredOnFix = true;
      }
    }
    function ensureMap() {
      if (!mapInstance) initMap();
      return !!mapInstance;
    }


    /* Base maps. OpenStreetMap is the default; Esri World Imagery is an online-only satellite layer.
       Neither is cached by the service worker (it ignores every cross-origin request). */
    const MAP_LAYERS = {
      standard: {
        url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        options: { maxZoom: MAP_MAX_ZOOM, maxNativeZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>' }
      },
      satellite: {
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        options: { maxZoom: MAP_MAX_ZOOM, maxNativeZoom: 18, attribution: 'Citra &copy; Esri, Maxar, Earthstar Geographics' }
      }
    };
    let mapTileErrors = 0;
    function savedMapLayer() {
      try { const value = window.localStorage.getItem('jk-map-layer'); return MAP_LAYERS[value] ? value : 'standard'; }
      catch (_) { return 'standard'; }   // storage blocked: per-viewer convenience only
    }
    function syncMapLayerButtons() {
      document.querySelectorAll('#map-toolbar [data-layer]').forEach(button => {
        const active = button.getAttribute('data-layer') === currentMapTileType;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
      });
    }
    function updateMapOfflineNote() {
      const note = document.getElementById('map-offline-note');
      if (!note) return;
      const offline = navigator.onLine === false;
      const failing = mapTileErrors >= 3;
      note.textContent = offline || failing
        ? (currentMapTileType === 'satellite' ? 'Citra satelit butuh sinyal.' : 'Peta butuh sinyal.') + ' Titik dan petak Anda tetap terlihat.'
        : '';
      note.classList.toggle('hidden', !(offline || failing));
    }
    function setMapTileLayer(type) {
      const next = MAP_LAYERS[type] ? type : 'standard';
      currentMapTileType = next;
      try { window.localStorage.setItem('jk-map-layer', next); } catch (_) { /* optional */ }
      syncMapLayerButtons();
      if (!mapInstance) return;
      if (activeTileLayer) mapInstance.removeLayer(activeTileLayer);
      mapTileErrors = 0;
      const def = MAP_LAYERS[next];
      activeTileLayer = L.tileLayer(def.url, def.options).addTo(mapInstance);
      activeTileLayer.on('tileerror', () => { mapTileErrors += 1; if (mapTileErrors === 3) updateMapOfflineNote(); });
      activeTileLayer.on('load', () => { if (mapTileErrors) { mapTileErrors = 0; updateMapOfflineNote(); } });
      updateMapOfflineNote();
    }
    function setMapLayer(type) {
      ensureMap();
      setMapTileLayer(type);
    }
    window.addEventListener('online', updateMapOfflineNote);
    window.addEventListener('offline', updateMapOfflineNote);


    function toggleSatelliteMode() {
      setMapLayer(currentMapTileType === 'satellite' ? 'standard' : 'satellite');
    }

    /* --------------------------- petak / web gis ----------------------------- */


    /* ------------------- shared helpers for Beranda, Peta and Riwayat (0.2.2.0) ------------------- */
    const ID_DAYS = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
    const ID_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
    function pad2(n) { return String(n).padStart(2, '0'); }
    function startOfDay(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
    function formatClock(ms) { const d = new Date(ms); return pad2(d.getHours()) + '.' + pad2(d.getMinutes()); }
    function formatDateId(ms, withWeekday) {
      const d = new Date(ms);
      return (withWeekday ? ID_DAYS[d.getDay()] + ', ' : '') + d.getDate() + ' ' + ID_MONTHS[d.getMonth()] + ' ' + d.getFullYear();
    }
    // "Hari ini 14.05", "Kemarin 09.30", "Senin, 20 Okt", "5 Sep", "5 Sep 2025". Device local time, never a zone name.
    function formatWhenId(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return 'Waktu foto tidak diketahui';
      const days = Math.round((startOfDay(Date.now()) - startOfDay(ms)) / 86400000);
      const d = new Date(ms);
      if (days === 0) return 'Hari ini ' + formatClock(ms);
      if (days === 1) return 'Kemarin ' + formatClock(ms);
      if (days > 1 && days < 7) return ID_DAYS[d.getDay()] + ', ' + d.getDate() + ' ' + ID_MONTHS[d.getMonth()];
      return d.getDate() + ' ' + ID_MONTHS[d.getMonth()] + (d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : '');
    }
    // Old saved notes carry "2026-10-20 (Asia/Jakarta)". Show them in plain Indonesian instead.
    function plainDateText(value) {
      return String(value === null || value === undefined ? '' : value)
        .replace(/\s*\((?:Africa|America|Asia|Atlantic|Australia|Europe|Indian|Pacific|UTC|GMT)[^)]*\)/g, '')
        .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (all, y, m, d) => (Number(m) >= 1 && Number(m) <= 12) ? Number(d) + ' ' + ID_MONTHS[Number(m) - 1] + ' ' + y : all);
    }
    function recordMs(rec) {
      const value = Number(rec && (rec.timestampMs ?? rec.createdMs));
      return Number.isFinite(value) && value > 0 ? value : null;
    }
    // The status shown to the farmer: their own check (observedSeverity) wins over the AI's first reading.
    function recSeverity(rec) {
      const value = rec && (rec.observedSeverity || rec.severity);
      const observed = rec?.observedProblems;
      if (value === 'Healthy' && observed && [observed.disease,observed.pest].some(v => String(v || '').trim())) return 'Moderate';
      if (!rec?.observedSeverity && (rec?.assessment?.uncertain || (rec?.needs_review && Number(rec?.confidence) < .5))) return value === 'Severe' || value === 'Moderate' ? value : 'Unknown';
      if (!observed && !rec?.observedSeverity && value === 'Healthy' && [rec?.condition,...(rec?.assessment?.active_conditions||[])].some(label=>window.JagaProblems?.id(label))) return 'Unknown';
      return SEVERITY_META[value] ? value : 'Unknown';
    }
    function treeKey(rec) { return rec.cropId || 'crop_legacy_' + rec.id; }
    function attentionRank(group) {
      const sev = recSeverity(group.latest);
      if (sev === 'Severe') return 0;
      if (sev === 'Moderate' || group.latest.needs_review === true) return 1;
      return 2;
    }
    function treeMatchesFilter(group, filter) {
      if (filter === 'all') return true;
      if (filter === 'review') return group.latest.needs_review === true;
      return recSeverity(group.latest) === filter;
    }
    function treeCounts(groups) {
      const counts = { all: groups.length, Severe: 0, Moderate: 0, Healthy: 0, review: 0 };
      for (const group of groups) {
        const sev = recSeverity(group.latest);
        if (counts[sev] !== undefined) counts[sev] += 1;
        if (group.latest.needs_review === true) counts.review += 1;
      }
      return counts;
    }
    // Re-render a list only when what it shows has changed (tab switches stay instant).
    const renderSigs = Object.create(null);
    function skipUnchanged(key, signature) {
      if (renderSigs[key] === signature) return true;
      renderSigs[key] = signature;
      return false;
    }
    function recordsSig() {
      return farmRecords.map(r => {
        const image = String(r.imageUrl || '');
        return [r.id, r.updatedMs || '', r.severity, r.observedSeverity || '', r.observedProblems?.disease || '', r.observedProblems?.pest || '',
          r.cropId || '', r.cropName || '', r.crop || '', r.condition || '', r.farmId || '', r.needs_review ? 1 : 0,
          r.lat, r.lng, r.timestampMs || '', image.length, image.slice(-16)].join('|');
      }).join('\n');
    }
    function thumbHtml(url, size, action) {
      const src = imageAttribute(url);
      const click = action ? action + ' style="cursor:pointer"' : '';
      return '<span class="thumb ' + (size || '') + '">' + (src ? '<img src="' + src + '" alt="" loading="lazy" decoding="async"' + click + '>' : '') + '</span>';
    }
    // A thumbnail that fails to load shows the leaf placeholder, never the broken-image icon.
    document.addEventListener('error', event => {
      const el = event.target;
      if (el && el.tagName === 'IMG' && el.closest && el.closest('.thumb, .thumb-fill')) el.classList.add('is-broken');
    }, true);
    function toggleHidden(id, show) {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('hidden', !show);
    }
    function setText(id, value) {
      const el = document.getElementById(id);
      const text = String(value);
      if (el && el.textContent !== text) el.textContent = text;
    }
    function escapeText(value) {
      return String(value === null || value === undefined ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function jsArg(value) {
      return escapeText(JSON.stringify(String(value ?? '')));
    }

    // 0.2.4.16: a delegated action (actions.js) instead of an inline onclick, so the CSP can forbid inline script.
    // Arguments travel as escaped JSON; "$this" stands for the clicked element.
    function act(name, ...args) {
      return ' data-act="' + escapeText(name) + '"' + (args.length ? ' data-args="' + escapeText(JSON.stringify(args)) + '"' : '');
    }

    function imageAttribute(value) {
      const url = String(value || '');
      const localPhoto = /^\/api\/photos\/[A-Za-z0-9_-]+$/.test(url);
      const inlinePhoto = /^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(url);
      const blobPhoto = url.startsWith('blob:' + location.origin + '/');
      return escapeText(localPhoto || inlinePhoto || blobPhoto ? url : '');
    }


    function formatArea(m2) {
      if (typeof m2 !== 'number' || !isFinite(m2) || m2 <= 0) return '—';
      const meters = Math.round(m2).toLocaleString('id-ID') + ' m²';
      if (m2 < 1000) return meters;
      const ha = m2 / 10000;
      return (ha >= 10 ? Math.round(ha).toLocaleString('id-ID') : ha.toFixed(1).replace('.', ',')) + ' ha (' + meters + ')';
    }

    let editingFarmId = null;
    let editingFarmGeneration = null;
    let editingFarmLayer = null;
    let farmEditRevision = 0;


    function setMapHint(text) {
      const box = document.getElementById('map-hint-box');
      if (!box) return;
      if (!text) { box.innerHTML = ''; box.classList.add('hidden'); return; }
      box.classList.remove('hidden');
      box.innerHTML = '<div class="map-hint"><i data-lucide="info"></i><span>' + escapeText(text) + '</span></div>';
      icons();
    }

    function turfAreaM2(ring) {
      try {
        if (typeof turf === 'undefined' || !Array.isArray(ring) || ring.length < 4) return null;
        const value = turf.area(turf.polygon([ring.map(([lat, lng]) => [lng, lat])]));
        return typeof value === 'number' && isFinite(value) ? value : null;
      } catch (error) {
        return null;
      }
    }

    // A boundary arrives as a list of corners and leaves as a closed ring:
    // [lat, lng] pairs, first point repeated at the end, minimum 3 corners.
    function closeRing(rawPoints) {
      const points = (rawPoints || [])
        .map(p => [Number(p[0]), Number(p[1])])
        .filter(p => isFinite(p[0]) && isFinite(p[1]));
      if (points.length < 3) return null;
      const first = points[0];
      const last = points[points.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) points.push([first[0], first[1]]);
      return points.length >= 4 ? points : null;
    }

    function validFarmRing(ring) {
      return window.JagaFarmMembership?.validateRing(ring) === true;
    }

    function farmLayerRing(layer) {
      const rings=layer?.getLatLngs?.()||[];
      if (rings.length !== 1 || !Array.isArray(rings[0]) || rings[0].some(point => Array.isArray(point))) return null;
      return closeRing(rings[0].map(p=>[p.lat,p.lng]));
    }


    // Which petak is the farmer standing in? Lets a photo inherit its farm
    // automatically, so per-petak advice has data to work with later.
    function farmContainingPoint(lat, lng) {
      return window.JagaFarmMembership?.resolve({lat,lng},farmList).farmId || null;
    }

    function reconcileFarmMembership() {
      if (!window.JagaFarmMembership) return;
      farmRecords = farmRecords.map(record => {
        // Derived membership must be recalculated if polygons move or are removed.
        const persistedFarmId = Object.hasOwn(record,'persistedFarmId') ? record.persistedFarmId : record.farmId;
        const result = window.JagaFarmMembership.resolve({...record,farmId:persistedFarmId},farmList);
        return {...record, persistedFarmId:persistedFarmId || null, farmId:result.farmId, farmAssignment:result.status};
      });
    }


    function farmMembershipLabel(record) {
      const farm = farmList.find(farm => farm.id === record.farmId);
      if (farm) return farm.name;
      if (record.farmAssignment === 'ambiguous') return 'Di batas dua petak: pilih petaknya';
      if (record.farmAssignment === 'missing-location') return 'Lokasi belum terbaca';
      return 'Di luar petak';
    }


    function wireFarmDrawing() {
      if (!mapInstance || !mapInstance.pm) return;
      // Plain Bahasa for the drawing tooltips (no "vertex", no "klik").
      const tooltips = { firstVertex: 'Ketuk peta untuk menaruh titik pertama', continueLine: 'Ketuk untuk menambah titik',
        finishPoly: 'Ketuk titik pertama untuk menutup petak' };
      try { mapInstance.pm.setLang('id', { tooltips }, 'en'); } catch (error) { /* older builds have no 'id' */ }
      mapInstance.on('pm:drawstart', (event) => {
        if (event.workingLayer && event.workingLayer.on) event.workingLayer.on('pm:vertexadded', updateDrawStats);
        updateDrawStats();
      });
      mapInstance.on('pm:create', (event) => {
        const ring = closeRing((event.layer.getLatLngs()[0] || []).map(p => [p.lat, p.lng]));
        if (mapInstance && mapInstance.pm) mapInstance.pm.disableDraw();
        setMapHint('');
        setDrawBar(null);
        if (!ring) {
          if (mapInstance) mapInstance.removeLayer(event.layer);
          showToast('Petak butuh minimal 3 titik.');
          return;
        }
        if (pendingFarmLayer && mapInstance && pendingFarmLayer !== event.layer) {
          mapInstance.removeLayer(pendingFarmLayer);
        }
        pendingFarmLayer = event.layer;
        pendingFarmSource = 'peta';
        openFarmModal(ring, 'Simpan petak');
      });
    }

    /* Bottom action bar while drawing a plot or walking its boundary with GPS. */
    let drawBarMode = null;   // 'draw' | 'gps' | null
    let gpsTraceMeters = 0;
    let gpsTraceAccuracy = null;
    function drawPoints() {
      const layer = mapInstance && mapInstance.pm && mapInstance.pm.Draw && mapInstance.pm.Draw.Polygon && mapInstance.pm.Draw.Polygon._layer;
      let points = layer && layer.getLatLngs ? layer.getLatLngs() : [];
      if (points.length && Array.isArray(points[0])) points = points[0];
      return points.map(p => [p.lat, p.lng]);
    }
    function updateDrawStats() {
      const stats = document.getElementById('draw-bar-stats');
      const finish = document.getElementById('draw-finish');
      if (!stats) return;
      if (drawBarMode === 'gps') {
        stats.textContent = gpsTracePoints.length + ' titik · ' + Math.round(gpsTraceMeters).toLocaleString('id-ID') + ' m · ' +
          (Number.isFinite(gpsTraceAccuracy) ? 'GPS ±' + Math.round(gpsTraceAccuracy) + ' m' : 'menunggu GPS');
        if (finish) finish.disabled = false;
      } else if (drawBarMode === 'draw') {
        const points = drawPoints();
        const area = points.length >= 3 ? turfAreaM2(closeRing(points)) : null;
        stats.textContent = points.length + ' titik' + (points.length >= 3 ? (area ? ' · ±' + (area < 10000 ? Math.round(area).toLocaleString('id-ID') + ' m²' : formatArea(area).split(' (')[0]) : '') : ' · butuh minimal 3');
        if (finish) finish.disabled = points.length < 3;
      }
    }
    function setDrawBar(mode) {
      drawBarMode = mode || null;
      document.getElementById('draw-bar')?.classList.toggle('hidden', !mode);
      document.getElementById('view-map')?.classList.toggle('is-drawing', !!mode);
      document.getElementById('draw-undo')?.classList.toggle('hidden', mode !== 'draw');
      const finish = document.getElementById('draw-finish');
      if (finish) finish.textContent = mode === 'gps' ? 'Selesai jalan' : 'Selesai';
      updateDrawStats();
    }
    function undoDrawPoint() {
      try { mapInstance.pm.Draw.Polygon._removeLastVertex(); } catch (error) { /* nothing to remove */ }
      updateDrawStats();
    }
    function finishDrawPoints() {
      if (gpsTraceWatchId !== null) { finishGpsTrace(); return; }
      if (!mapInstance?.pm?.Draw?.Polygon) return;
      if (drawPoints().length < 3) { showToast('Butuh minimal 3 titik.'); return; }
      try { mapInstance.pm.Draw.Polygon._finishShape(); }
      catch (error) { showToast('Petak belum bisa diselesaikan. Ketuk titik pertama untuk menutup.'); }
    }


    function openFarmModal(ring, title) {
      pendingFarmRing = ring;
      pendingFarmArea = turfAreaM2(ring);
      const titleEl = document.getElementById('farm-modal-title');
      const areaEl = document.getElementById('farm-modal-area');
      const errorEl = document.getElementById('farm-modal-error');
      if (titleEl) titleEl.innerText = title || 'Simpan petak';
      const saveButton = document.getElementById('farm-modal-save');
      if (saveButton) saveButton.innerText = editingFarmId ? 'Simpan perubahan' : 'Simpan petak';
      document.getElementById('farm-edit-geometry')?.classList.toggle('hidden', !editingFarmId);
      if (areaEl) {
        areaEl.innerText = 'Luas: ' + formatArea(pendingFarmArea) + ' · ' + (ring.length - 1) + ' titik';
      }
      if (errorEl) { errorEl.classList.add('hidden'); errorEl.innerText = ''; }
      setDialogOpen('modal-farm');
      icons();
    }

    function farmModalError(message) {
      const errorEl = document.getElementById('farm-modal-error');
      if (!errorEl) return;
      if (!message) { errorEl.classList.add('hidden'); errorEl.innerText = ''; return; }
      errorEl.classList.remove('hidden');
      errorEl.innerText = message;
    }


    function startFarmDraw() {
      ensureMap();
      closeFarmCrops(); selectedFarmId=null; renderFarmPolygons();
      if (!mapInstance || !mapInstance.pm) {
        showToast('Alat gambar peta belum siap. Muat ulang halaman.');
        return;
      }
      cancelFarmDraw();
      closeFarmPanel();
      pendingFarmSource = 'peta';
      setMapHint('Ketuk peta di setiap sudut petak.');
      try {
        mapInstance.pm.enableDraw('Polygon', {
          snappable: true, allowSelfIntersection: false, finishOn: 'dblclick',
          templineStyle: { ...farmBoundaryStyle(true), fill: false },
          hintlineStyle: { ...farmBoundaryStyle(true), fill: false, dashArray: '8 5' },
          pathOptions: farmBoundaryStyle(true),
        });
        setDrawBar('draw');
      } catch (error) {
        showToast('Gagal memulai gambar petak.');
      }
    }


    function cancelFarmDraw() {
      farmEditRevision += 1;
      if (mapInstance && mapInstance.pm) mapInstance.pm.disableDraw();
      stopGpsTrace();
      if (pendingFarmLayer && mapInstance) mapInstance.removeLayer(pendingFarmLayer);
      if (editingFarmLayer && mapInstance) mapInstance.removeLayer(editingFarmLayer);
      editingFarmLayer = null;
      editingFarmId = null;
      editingFarmGeneration = null;
      document.getElementById('farm-edit-toolbar')?.classList.add('hidden');
      pendingFarmLayer = null;
      pendingFarmRing = null;
      pendingFarmArea = null;
      setMapHint('');
      setDrawBar(null);
      farmModalError('');
      closeDialog('modal-farm');
    }

    async function saveFarmPolygon() {
      if (!editingFarmId && !pendingFarmRing) { cancelFarmDraw(); return; }
      const nameEl = document.getElementById('farm-name-input');
      const cropEl = document.getElementById('farm-crop-input');
      const noteEl = document.getElementById('farm-note-input');
      const name = (nameEl && nameEl.value || '').trim();
      const crop = (cropEl && cropEl.value || '').trim();
      const note = (noteEl && noteEl.value || '').trim();
      if (name.length < 2) { farmModalError('Beri nama petak minimal 2 huruf.'); return; }

      const ring = editingFarmId && editingFarmLayer ? farmLayerRing(editingFarmLayer) : pendingFarmRing;
      if (!validFarmRing(ring)) { farmModalError('Batas tidak valid. Periksa koordinat atau garis yang berpotongan.'); return; }
      farmModalError('');
      const areaM2 = turfAreaM2(ring);
      const editId = editingFarmId;
      const generation = editId ? editingFarmGeneration : accountGeneration;
      const revision = farmEditRevision;
      try {
        const saved = await api(editId ? '/api/farms/' + encodeURIComponent(editId) : '/api/farms', {
          method: editId ? 'PUT' : 'POST',
          body: editId ? { name, crop, note, ring, areaM2 } : { name, crop, note, ring, areaM2, source: pendingFarmSource },
        });
        if (revision !== farmEditRevision) return;
        if (generation !== accountGeneration || (editId && !farmList.some(farm => farm.id === editId))) {
          if (editingFarmLayer && mapInstance) mapInstance.removeLayer(editingFarmLayer);
          editingFarmLayer = null;
          editingFarmId = null;
          editingFarmGeneration = null;
          return;
        }
        farmList = [saved].concat(farmList.filter(f => f.id !== saved.id));
        if (editingFarmLayer && mapInstance) mapInstance.removeLayer(editingFarmLayer);
        editingFarmLayer = null;
        editingFarmId = null;
        editingFarmGeneration = null;
        if (pendingFarmLayer && mapInstance) mapInstance.removeLayer(pendingFarmLayer);
        pendingFarmLayer = null;
        pendingFarmRing = null;
        pendingFarmArea = null;
        document.getElementById('farm-edit-toolbar')?.classList.add('hidden');
        if (nameEl) nameEl.value = '';
        if (cropEl) cropEl.value = '';
        if (noteEl) noteEl.value = '';
        closeDialog('modal-farm');
        renderFarmPolygons();
        refreshAllHistoryViews();
        setMapHint('');
        showToast('Petak "' + saved.name + '" tersimpan (' + formatArea(saved.areaM2) + ').');
        if (mapInstance && (saved.ring || []).length >= 4) {
          mapInstance.fitBounds(L.latLngBounds(saved.ring), { padding: [40, 40] });
        }
      } catch (error) {
        if (!error.stale && generation === accountGeneration && revision === farmEditRevision) farmModalError('Gagal menyimpan petak: ' + userMessage(error));
      }
    }

    function renderFarmPolygons() {
      const badge = document.getElementById('farm-count-badge');
      if (badge) badge.innerText = String(farmList.length);
      if (typeof renderHomeMiniMap === 'function') renderHomeMiniMap();
      if (!farmLayer) return;
      farmLayer.clearLayers();
      if (selectedFarmId && !farmList.some(farm => farm.id === selectedFarmId)) selectedFarmId = null;
      farmList.forEach(farm => {
        const ring = farm.ring || [];
        if (ring.length < 4) return;
        const shape = L.polygon(ring, {
          farmId: farm.id,
          ...farmBoundaryStyle(farm.id === selectedFarmId),
        });
        shape.bindTooltip(escapeText(farm.name) + ' • ' + formatArea(farm.areaM2),
                          { sticky: true });
        shape.on('click', event => { event.originalEvent?.preventDefault(); if (drawBarMode || editingFarmId) return; focusFarm(farm.id); });
        shape.addTo(farmLayer);
        const path = shape.getElement();
        if (path) {
          path.setAttribute('tabindex', '0');
          path.setAttribute('role', 'button');
          path.setAttribute('aria-label', farm.name || 'Petak');
          path.setAttribute('aria-pressed', String(farm.id === selectedFarmId));
          path.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              focusFarm(farm.id);
            }
          });
        }
      });
    }

    async function loadFarms() {
      const owner = currentAccount && String(currentAccount.id);
      try {
        const rows = await api('/api/farms');
        farmList = Array.isArray(rows) ? rows : [];
        await cacheAccountData(owner,'farms',farmList);
      } catch (error) {
        if (!error.offline) throw error;
        if (owner && browserDataCache()) farmList = (await browserDataCache().cacheGet({accountId:owner,name:'farms'}) || []);
      }
      reconcileFarmMembership();
      renderFarmPolygons();
      renderFarmList();
      updateFarmTabVisibility();
      if (activeLogTab === 'petak') renderFarmLog();
      JagaHooks.run('history-shown');
    }


    function renderFarmList() {
      const listEl = document.getElementById('farm-sheet-list');
      const subEl = document.getElementById('farm-sheet-subtitle');
      if (subEl) {
        subEl.innerText = farmList.length === 0
          ? 'Belum ada petak tersimpan'
          : farmList.length + ' petak tersimpan';
      }
      if (!listEl) return;
      if (farmList.length === 0) {
        listEl.innerHTML = '<p class="t-body t-muted farm-empty">Belum ada petak. Ketuk ikon segi lima di kanan peta untuk menggambar petak, atau ikon jejak kaki sambil berjalan di batas kebun.</p>';
        return;
      }
      listEl.innerHTML = farmList.map(farm => {
        const related = farmRecords.filter(rec => rec.farmId === farm.id).length;
        const corners = Math.max(0, (farm.ring || []).length - 1);
        return '<div class="card farm-row">' +
          '<button type="button"' + act('focusFarm', String(farm.id ?? '')) + ' class="farm-info">' +
            '<span class="farm-name">' + escapeText(farm.name) + '</span>' +
            '<span class="farm-sub">' + escapeText(farm.crop || 'Tanaman belum diisi') + ' · ' + escapeText(formatArea(farm.areaM2)) + '</span>' +
            '<span class="farm-sub">' + related + ' foto · ' + corners + ' sudut</span>' +
          '</button>' +
          '<button type="button"' + act('openFarmEdit', String(farm.id ?? '')) + ' class="btn btn-secondary btn-sm" aria-label="Ubah petak ' + escapeText(farm.name) + '"><span>Ubah</span></button>' +
          '<button type="button"' + act('deleteFarm', String(farm.id ?? '')) + ' class="btn btn-danger btn-icon btn-sm" title="Hapus petak" aria-label="Hapus petak ' + escapeText(farm.name) + '"><i data-lucide="trash-2"></i></button>' +
        '</div>';
      }).join('');
      icons();
    }


    function updateMapSheetState() {
      const mapSheet = document.getElementById('map-bottom-sheet');
      const listSheet = document.getElementById('farm-sheet');
      const crops = document.getElementById('farm-crops-sheet');
      const open = !!(mapSheet && mapSheet.classList.contains('translate-y-0')) ||
        !!(listSheet && !listSheet.hidden) || !!(crops && !crops.classList.contains('hidden'));
      document.getElementById('view-map')?.classList.toggle('sheet-open', open);
    }
    function openFarmPanel() {
      renderFarmList();
      closeBottomSheet();
      const sheet = document.getElementById('farm-sheet');
      if (sheet) { sheet.hidden = false; sheet.classList.remove('translate-y-[150%]'); }
      updateMapSheetState();
    }
    function closeFarmPanel() {
      const sheet = document.getElementById('farm-sheet');
      if (sheet) { sheet.hidden = true; sheet.classList.add('translate-y-[150%]'); }
      updateMapSheetState();
    }

    function closeFarmModal() {
      cancelFarmDraw();
    }


    function focusFarm(farmId) {
      const farm = farmList.find(f => f.id === farmId);
      if (!farm) return;

      closeFarmPanel();
      const ring = farm.ring || [];
      if (mapInstance && ring.length >= 4) {
        const bounds=L.latLngBounds(ring); if(!mapInstance.getBounds().contains(bounds)) mapInstance.fitBounds(bounds, { padding: [40, 40] });
      }
      selectedFarmId = farm.id;
      farmLayer?.eachLayer(layer => {
        const selected = layer.options.farmId === farm.id;
        layer.setStyle(farmBoundaryStyle(selected));
        layer.getElement()?.setAttribute('aria-pressed', String(selected));
      });
      renderSelectedFarmCrops(farm);
    }

    function openFarmEdit(farmId) {
      closeFarmCrops(); selectedFarmId=null; renderFarmPolygons();
      if (!currentAccount || !mapInstance?.pm) return;
      cancelFarmDraw();
      if (mapInstance?.pm) mapInstance.pm.disableDraw();
      stopGpsTrace();
      const farm = farmList.find(item => item.id === farmId);
      if (!farm || !validFarmRing(farm.ring)) return;
      closeFarmPanel();
      if (pendingFarmLayer && mapInstance) mapInstance.removeLayer(pendingFarmLayer);
      pendingFarmLayer = null;
      editingFarmId = farm.id;
      editingFarmGeneration = accountGeneration;
      editingFarmLayer = L.polygon(farm.ring, farmBoundaryStyle(true)).addTo(mapInstance);

      document.getElementById('farm-name-input').value = farm.name || '';
      document.getElementById('farm-crop-input').value = farm.crop || '';
      document.getElementById('farm-note-input').value = farm.note || '';
      pendingFarmRing = farm.ring.map(point => point.slice());
      pendingFarmArea = turfAreaM2(pendingFarmRing);
      openFarmModal(pendingFarmRing, 'Ubah petak');
    }

    function editFarmGeometry() {
      if (!editingFarmLayer || editingFarmGeneration !== accountGeneration) return;
      closeDialog('modal-farm');
      navigateToMenu('map');
      editingFarmLayer.pm.enable({allowSelfIntersection:false, preventMarkerRemoval:true, snappable:false});
      document.getElementById('farm-edit-toolbar')?.classList.remove('hidden');
      setMapHint('Geser titik sudut untuk mengubah batas. Selesai menggeser membuka formulir; perubahan belum disimpan.');
      mapInstance.invalidateSize();
      mapInstance.fitBounds(editingFarmLayer.getBounds(), {paddingTopLeft:[35,200],paddingBottomRight:[70,90],animate:false});
      document.querySelector('#farm-edit-toolbar button')?.focus();
    }

    function returnToFarmEditForm() {
      if (!editingFarmId || !editingFarmLayer) return;
      editingFarmLayer.pm.disable();
      setMapHint('');
      const ring = farmLayerRing(editingFarmLayer);
      if (!validFarmRing(ring)) {
              document.getElementById('farm-edit-toolbar')?.classList.add('hidden');
              setDialogOpen('modal-farm');
              document.getElementById('farm-modal-title').innerText = 'Ubah petak';
              document.getElementById('farm-modal-area').innerText = 'Batas tidak valid';
        farmModalError('Batas tidak valid. Periksa koordinat atau garis yang berpotongan.');
        return;
      }
      document.getElementById('farm-edit-toolbar')?.classList.add('hidden');
      openFarmModal(ring, 'Ubah petak');
    }

    function deleteFarm(farmId) {
      const farm = farmList.find(f => f.id === farmId);
      if (!farm) return;
      confirmAction({
        title: 'Hapus petak ini?',
        message: farm.name + ' akan dihapus. Catatan analisis di dalamnya tetap tersimpan.',
        okLabel: 'Hapus',
      }).then(async (ok) => {
        if (!ok) return;
        try {
          await api('/api/farms/' + encodeURIComponent(farmId), { method: 'DELETE' });
          if (selectedFarmId === farmId) selectedFarmId = null;
          farmList = farmList.filter(f => f.id !== farmId);
          renderFarmPolygons();
          refreshAllHistoryViews();
          showToast('Petak dihapus.');
        } catch (error) {
          showToast('Gagal menghapus petak: ' + userMessage(error));
        }
      });
    }


    function centerMapOnMe() {
      if (!ensureMap()) return;
      if (currentCoords.lat === null || currentCoords.lng === null) {
        showToast('Lokasi belum terbaca. Ketuk tombol perbarui di Beranda.');
        requestLiveLocation(true);
        return;
      }
      mapInstance.setView([currentCoords.lat, currentCoords.lng], 18);
    }


    function toggleGpsTrace() {
      if (gpsTraceWatchId !== null) { finishGpsTrace(); return; }
      if (!ensureMap()) { showToast('Peta sedang dimuat. Coba sebentar lagi.'); return; }
      if (!navigator.geolocation) { showToast('HP ini tidak punya GPS.'); return; }
      if (!currentAccount) return;
      cancelFarmDraw();
      closeFarmPanel();
      const traceGeneration = gpsTraceGeneration;
      const ownerGeneration = accountGeneration;
      gpsTracePoints = [];
      gpsTraceMeters = 0;
      gpsTraceAccuracy = null;
      if (traceLayer) traceLayer.clearLayers();
      gpsTraceWatchId = navigator.geolocation.watchPosition(
        (position) => {
          if (traceGeneration !== gpsTraceGeneration || ownerGeneration !== accountGeneration || !currentAccount) return;
          const point = [position.coords.latitude, position.coords.longitude];
          gpsTraceAccuracy = position.coords.accuracy;
          const last = gpsTracePoints[gpsTracePoints.length - 1];
          if (last && turfDistanceM(last, point) < 3) { updateDrawStats(); return; }
          if (last) gpsTraceMeters += turfDistanceM(last, point);
          gpsTracePoints.push(point);
          if (traceLayer) {
            traceLayer.clearLayers();
            if (gpsTracePoints.length > 1) {
              L.polyline(gpsTracePoints, { ...farmBoundaryStyle(true), fill: false, dashArray: '8 5' })
                .addTo(traceLayer);
            }
            L.circleMarker(point, { radius: 5, color: '#fff', weight: 2, fillColor: MAP_PLOT_COLOR, fillOpacity: 1 })
              .addTo(traceLayer);
          }
          updateDrawStats();
        },
        () => {
          if (traceGeneration !== gpsTraceGeneration || ownerGeneration !== accountGeneration || !currentAccount) return;
          showToast('GPS belum terbaca. Coba di tempat terbuka.'); stopGpsTrace();
        },
        { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
      );
      setMapHint('Berjalanlah di sekeliling batas kebun. Ketuk "Selesai jalan" bila sudah kembali ke titik awal.');
      setDrawBar('gps');
    }

    function turfDistanceM(a, b) {
      try {
        if (typeof turf !== 'undefined') {
          return turf.distance(turf.point([a[1], a[0]]), turf.point([b[1], b[0]]), { units: 'meters' });
        }
      } catch (error) { /* fall through */ }
      const dLat = (b[0] - a[0]) * 111320;
      const dLng = (b[1] - a[1]) * 111320 * Math.cos(a[0] * Math.PI / 180);
      return Math.sqrt(dLat * dLat + dLng * dLng);
    }

    let gpsTraceGeneration = 0;

    function stopGpsTrace() {
      gpsTraceGeneration += 1;
      if (gpsTraceWatchId !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(gpsTraceWatchId);
      }
      const wasWalking = gpsTraceWatchId !== null;
      gpsTraceWatchId = null;
      gpsTracePoints = [];
      gpsTraceMeters = 0;
      gpsTraceAccuracy = null;
      if (traceLayer) traceLayer.clearLayers();
      if (mapInstance?.pm) mapInstance.pm.disableDraw();
      setMapHint('');
      if (wasWalking || drawBarMode === 'gps') setDrawBar(null);
    }


    function finishGpsTrace() {
      if (gpsTraceWatchId === null) return;
      const points = gpsTracePoints.slice();
      stopGpsTrace();
      if (traceLayer) traceLayer.clearLayers();
      gpsTracePoints = [];
      const ring = closeRing(points);
      if (!ring) {
        showToast('Jejak terlalu pendek. Berjalanlah mengelilingi batas kebun dulu.');
        return;
      }
      pendingFarmLayer = null;
      pendingFarmSource = 'gps';
      openFarmModal(ring, 'Simpan jejak petak');
    }


    function fitMapBounds() {
      if (!ensureMap()) return;
      const points = [];
      farmList.forEach(farm => (farm.ring || []).forEach(p => points.push(p)));
      farmRecords.forEach(rec => {
        if (validCoordinates(rec.lat, rec.lng)) points.push([rec.lat, rec.lng]);
      });
      if (points.length === 0) {
        if (currentCoords.lat !== null && currentCoords.lng !== null) {
          mapInstance.setView([currentCoords.lat, currentCoords.lng], 17);
        } else {
          mapInstance.setView([-2.5, 118.0], 5);
        }
        return;
      }
      if (points.length === 1) {
        mapInstance.setView(points[0], 18);
        return;
      }
      mapInstance.fitBounds(L.latLngBounds(points), { padding: [40, 40] });
    }

    function validCoordinates(lat, lng) {
      return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
    }


    const MAP_PIN_PHOTO_ZOOM = 18;
    const MAP_PIN_STACK_LIMIT = 3;
    const MAP_PIN_BODY_BACK = '<svg class="map-pin-body map-pin-back" viewBox="0 0 48 58" focusable="false">' +
      '<path d="M24 1.5A22.5 22.5 0 0 1 46.5 24C46.5 35.7 37.1 43.3 26.5 54.8Q24 57.7 21.5 54.8C10.9 43.3 1.5 35.7 1.5 24A22.5 22.5 0 0 1 24 1.5Z"/></svg>';
    const MAP_PIN_BODY_DEEP = '<svg class="map-pin-body map-pin-back is-deep" viewBox="0 0 48 58" focusable="false">' +
      '<path d="M24 1.5A22.5 22.5 0 0 1 46.5 24C46.5 35.7 37.1 43.3 26.5 54.8Q24 57.7 21.5 54.8C10.9 43.3 1.5 35.7 1.5 24A22.5 22.5 0 0 1 24 1.5Z"/></svg>';
    const MAP_PIN_BODY_FRONT = '<svg class="map-pin-body" viewBox="0 0 48 58" focusable="false">' +
      '<path d="M24 1.5A22.5 22.5 0 0 1 46.5 24C46.5 35.7 37.1 43.3 26.5 54.8Q24 57.7 21.5 54.8C10.9 43.3 1.5 35.7 1.5 24A22.5 22.5 0 0 1 24 1.5Z"/></svg>';
    const MAP_PIN_VISIBLE_LIMIT = 40;
    const MAP_PIN_REQUEST_LIMIT = 4;
    const MAP_PIN_CACHE_LIMIT = 96;
    const MAP_PIN_MAX_BYTES = 128 * 1024;
    const mapPinPhotoCache = new Map();
    const mapPinRequests = new Map();
    let visibleMapPhotoPins = new Map();
    const nearbyMapPhotos = new Map();
    let nearbyMapPhotoObserver = null;

    function mapPinSeverityRank(severity) {
      if (severity === 'Severe') return 0;
      if (severity === 'Moderate') return 1;
      return 2;
    }

    function mapPinMetrics(zoom) {
      const scale = zoom < MAP_PIN_PHOTO_ZOOM ? 0.86
        : 1 + 0.08 * Math.min(4, zoom - MAP_PIN_PHOTO_ZOOM);
      return { scale, width: Math.max(46, 2 * Math.ceil(26 * scale)), height: Math.ceil(71 * scale) };
    }

    function mapPinIcon(metrics, content, stackColors = [], color = '', stackSize = 0) {
      let backLayers = '';
      if (stackSize > 1) {
        if (stackSize >= 3) backLayers += MAP_PIN_BODY_DEEP;
        backLayers += MAP_PIN_BODY_BACK;
      }
      const stackClass = stackSize > 1 ? ' map-pin-stack' : '';
      const countClass = stackSize >= 100 ? ' map-pin-count-long' : '';
      const countBadge = stackSize > 1 ? '<span class="map-pin-stack-badge" aria-hidden="true">' + stackSize + '</span>' : '';
      const vars = [
        '--pin-scale:' + metrics.scale,
        color ? '--pin-status:' + color : '',
        stackColors[0] ? '--pin-back-1:' + stackColors[0] : '',
        stackColors[1] ? '--pin-back-2:' + stackColors[1] : '',
      ].filter(Boolean).join(';');
      return L.divIcon({
        className: 'custom-farm-pin',
        iconSize: [metrics.width, metrics.height],
        iconAnchor: [metrics.width / 2, metrics.height],
        html: '<div aria-hidden="true" class="map-pin' + stackClass + countClass +
          '" style="' + vars + '">' + backLayers + MAP_PIN_BODY_FRONT + content + countBadge + '</div>',
      });
    }

    function mapPinGrid(spacing) {
      const cells = new Map();
      const cell = point => [Math.floor(point.x / spacing), Math.floor(point.y / spacing)];
      return {
        add(point, item) {
          const key = cell(point).join(',');
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push(item);
        },
        nearby: function* (point) {
          const [column, row] = cell(point);
          for (let x = column - 1; x <= column + 1; x++) {
            for (let y = row - 1; y <= row + 1; y++) yield* cells.get(x + ',' + y) || [];
          }
        },
      };
    }

    function mapPinMarker(position, options, activate) {
      return L.marker(position, { keyboard: true, ...options })
        .on('click', event => {
          if (!drawBarMode && !editingFarmId) activate(event);
        })
        .on('add', event => {
          const marker = event.target;
          const element = marker.getElement();
          element.setAttribute('aria-label', options.title);
          element.addEventListener('keydown', key => {
            if (key.key !== 'Enter' && key.key !== ' ') return;
            key.preventDefault();
            key.stopPropagation();
            if (!key.repeat) marker.fire('click');
          });
        });
    }

    function layoutMapPins() {
      if (!mapMarkersLayer || currentMenuName !== 'map') return;
      const size = mapInstance.getSize();
      if (size.x <= 0 || size.y <= 0) return;
      const metrics = mapPinMetrics(mapInstance.getZoom());
      const overlapWidth = metrics.width + 4;
      const overlapHeight = metrics.height + 4;
      const displayedMarkers = new Set();
      const anchors = mapPinGrid(Math.max(overlapWidth, overlapHeight));
      const anchorPixels = new Map();
      const groups = new Set();

      // Find connected sets of overlapping hit targets in screen pixels. Check only
      // neighbouring cells, and only once per set when several pins share an anchor.
      for (const marker of mapPlantMarkers) {
        const point = mapInstance.latLngToContainerPoint(marker.getLatLng());
        if (point.x < 0 || point.y < 0 || point.x > size.x || point.y > size.y) continue;
        const pixelKey = point.x + ',' + point.y;
        const sharedAnchor = anchorPixels.get(pixelKey);
        if (sharedAnchor) {
          sharedAnchor.group.push({ marker, point, group: sharedAnchor.group });
          continue;
        }
        const matches = new Set();
        for (const pin of anchors.nearby(point)) {
          if (!matches.has(pin.group) && Math.abs(point.x - pin.point.x) < overlapWidth
            && Math.abs(point.y - pin.point.y) < overlapHeight) matches.add(pin.group);
        }
        const group = [...matches].reduce((largest, candidate) => candidate.length > largest.length ? candidate : largest, []);
        for (const match of matches) {
          if (match === group) continue;
          for (const pin of match) { pin.group = group; group.push(pin); }
          groups.delete(match);
        }
        const pin = { marker, point, group };
        anchors.add(point, pin);
        anchorPixels.set(pixelKey, pin);
        group.push(pin);
        groups.add(group);
      }

      const countKeys = new Set();
      for (const group of groups) {
        group.sort((a, b) =>
          (a.marker.options.severityRank - b.marker.options.severityRank) ||
          ((b.marker.options.recordTs || 0) - (a.marker.options.recordTs || 0))
        );
        const front = group[0].marker;
        if (group.length === 1) {
          if (front.options.pinScale !== metrics.scale) {
            front.setIcon(mapPinIcon(metrics, front.options.pinContent, [], front.options.pinColor, 0));
            front.options.pinScale = metrics.scale;
          }
          front.setZIndexOffset(front.options.pinZIndex || 0);
          displayedMarkers.add(front);
          continue;
        }
        const backColors = group.slice(1, 3).map(pin => pin.marker.options.pinColor);
        const key = group.map(pin => pin.marker.options.recordId).sort().join('|');
        countKeys.add(key);
        const label = group.length + ' Tanaman Berdekatan';
        const sig = [
          metrics.scale, front.options.pinColor, front.options.thumbnailPath || '',
          front.options.pinContent, backColors.join(','), group.length
        ].join('|');
        let countMarker = mapPinCountMarkers.get(key);
        if (!countMarker || countMarker.options.title !== label) {
          countMarker = mapPinMarker(front.getLatLng(), {
            title: label,
            thumbnailPath: front.options.thumbnailPath,
            recordId: front.options.recordId,
          }, event => openNearbyMapPlants(event.target.options.plants));
          mapPinCountMarkers.set(key, countMarker);
        }
        countMarker.setLatLng(front.getLatLng());
        countMarker.options.thumbnailPath = front.options.thumbnailPath;
        countMarker.options.recordId = front.options.recordId;
        countMarker.setZIndexOffset((front.options.pinZIndex || 0) + 50);
        if (countMarker.options.iconSig !== sig) {
          countMarker.setIcon(mapPinIcon(metrics, front.options.pinContent, backColors, front.options.pinColor, group.length));
          countMarker.options.iconSig = sig;
          countMarker.options.pinScale = metrics.scale;
        }
        countMarker.options.plants = group.map(pin => pin.marker.options);
        displayedMarkers.add(countMarker);
      }
      for (const key of mapPinCountMarkers.keys()) if (!countKeys.has(key)) mapPinCountMarkers.delete(key);
      mapMarkersLayer.eachLayer(marker => { if (!displayedMarkers.has(marker)) mapMarkersLayer.removeLayer(marker); });
      for (const marker of displayedMarkers) {
        if (!mapMarkersLayer.hasLayer(marker)) marker.addTo(mapMarkersLayer);
      }
      refreshMapPinPhotos();
    }

    function refreshMapPinPhotos() {
      const next = new Map();
      if (currentAccount && currentMenuName === 'map' && !document.hidden) {
        for (const [photo, path] of nearbyMapPhotos) {
          next.set(photo, path);
          if (next.size >= MAP_PIN_VISIBLE_LIMIT) break;
        }
        if (mapInstance && next.size < MAP_PIN_VISIBLE_LIMIT) {
          const bounds = mapInstance.getBounds();
          for (const marker of mapMarkersLayer.getLayers()) {
            const path = marker.options.thumbnailPath;
            const circle = marker.getElement()?.querySelector('.map-pin-circle');
            if (!path || !circle || !bounds.contains(marker.getLatLng())) continue;
            next.set(circle, path);
            if (next.size >= MAP_PIN_VISIBLE_LIMIT) break;
          }
        }
      }
      for (const pin of visibleMapPhotoPins.keys()) {
        if (next.has(pin)) continue;
        pin.querySelector('img')?.remove();
        pin.classList.remove('has-photo');
      }
      visibleMapPhotoPins = next;
      fillVisibleMapPinPhotos();
    }

    function fillVisibleMapPinPhotos() {
      for (const [pin, path] of visibleMapPhotoPins) {
        const cached = mapPinPhotoCache.get(path);
        if (cached?.url) {
          // Keep the thumbnails in the current viewport at the end of the cache.
          mapPinPhotoCache.delete(path);
          mapPinPhotoCache.set(path, cached);
          if (pin.querySelector('img')) continue;
          const image = new Image();
          image.alt = '';
          image.hidden = true;
          image.decoding = 'async';
          image.addEventListener('load', () => {
            if (!image.isConnected || !visibleMapPhotoPins.has(pin)) return;
            pin.classList.add('has-photo');
            image.hidden = false;
          }, { once: true });
          pin.append(image);
          image.src = cached.url;
        } else if (navigator.onLine !== false && (!cached || cached.retryAfter <= Date.now()) && !mapPinRequests.has(path)
          && mapPinRequests.size < MAP_PIN_REQUEST_LIMIT) {
          loadMapPinPhoto(path);
        }
      }
    }

    async function fetchMapPinThumbnail(path, signal) {
      if (path.startsWith('local:')) {
        try {
          const dataUrl = await JagaMedia?.dataUrl?.(path.slice(6));
          if (!dataUrl || !/^data:image\//i.test(dataUrl)) return null;
          const res = await fetch(dataUrl, { signal });
          return res.ok ? await res.blob() : null;
        } catch (_) { return null; }
      }
      if (/^data:image\//i.test(path)) {
        const res = await fetch(path, { signal });
        return res.ok ? await res.blob() : null;
      }
      if (window.JagaNative?.isNative() && path.startsWith('/api/')) {
        const result = await window.JagaNative.request({ path, method: 'GET' });
        if (result.status !== 200 || result.encoding !== 'base64' || typeof result.body !== 'string'
          || !/^image\/(?:jpeg|png|webp)(?:;|$)/i.test(result.headers?.['content-type'] || '')
          || result.body.length > 4 * Math.ceil(MAP_PIN_MAX_BYTES / 3)) return null;
        const bytes = Uint8Array.from(atob(result.body), character => character.charCodeAt(0));
        return new Blob([bytes], { type: 'image/jpeg' });
      }
      const response = await fetch(path, { signal, credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok || !/^image\/(?:jpeg|png|webp)(?:;|$)/i.test(response.headers.get('content-type') || '')) return null;
      return response.blob();
    }

    async function loadMapPinPhoto(path) {
      const request = new AbortController();
      const generation = accountGeneration;
      mapPinRequests.set(path, request);
      const timeout = setTimeout(() => request.abort(), 12000);
      let url = '';
      try {
        const blob = await fetchMapPinThumbnail(path, request.signal);
        if (blob?.size > 0 && blob.size <= MAP_PIN_MAX_BYTES
          && generation === accountGeneration && !request.signal.aborted) url = URL.createObjectURL(blob);
      } catch (_) {
        // A missing or unreadable photo keeps the letter marker available.
      } finally {
        clearTimeout(timeout);
      }
      if (mapPinRequests.get(path) !== request) return;
      mapPinRequests.delete(path);
      mapPinPhotoCache.delete(path);
      mapPinPhotoCache.set(path, { url, retryAfter: Date.now() + 30000 });
      if (mapPinPhotoCache.size > MAP_PIN_CACHE_LIMIT) {
        const oldest = mapPinPhotoCache.keys().next().value;
        const entry = mapPinPhotoCache.get(oldest);
        if (entry.url) URL.revokeObjectURL(entry.url);
        mapPinPhotoCache.delete(oldest);
      }
      fillVisibleMapPinPhotos();
    }

    function resetMapPinPhotos() {
      for (const request of mapPinRequests.values()) request.abort();
      mapPinRequests.clear();
      for (const { url } of mapPinPhotoCache.values()) if (url) URL.revokeObjectURL(url);
      mapPinPhotoCache.clear();
      visibleMapPhotoPins.clear();
    }

    document.addEventListener('visibilitychange', refreshMapPinPhotos);
    window.addEventListener('online', () => {
      for (const [path, entry] of mapPinPhotoCache) if (!entry.url) mapPinPhotoCache.delete(path);
      refreshMapPinPhotos();
    });

    let mapSeverityFilter = 'all';
    function renderMapMarkers(filterSeverity) {
      if (typeof filterSeverity === 'string') mapSeverityFilter = filterSeverity;
      // One pin per tree: its position from the newest record that has coordinates,
      // its colour from the tree's latest status.
      const groups = groupRecordsByCrop(farmRecords);
      const placed = groups
        .map(group => ({ group, pos: group.records.find(r => validCoordinates(r.lat, r.lng)) }))
        .filter(item => item.pos);
      const counts = { all: placed.length, Severe: 0, Moderate: 0, Healthy: 0 };
      // Plants whose photos have no location are not on the map; say how many instead of showing nothing (0.2.4.15).
      const unlocated = groups.length - placed.length;
      const unlocatedRow = document.getElementById('map-unlocated-row');
      if (unlocatedRow) {
        unlocatedRow.hidden = unlocated <= 0;
        document.getElementById('view-map')?.classList.toggle('has-unlocated', unlocated > 0);
        setText('map-unlocated-text', unlocated + ' tanaman belum punya lokasi');
      }
      placed.forEach(item => { const sev = recSeverity(item.group.latest); if (counts[sev] !== undefined) counts[sev] += 1; });
      document.querySelectorAll('#map-toolbar [data-count]').forEach(el => {
        const value = String(counts[el.getAttribute('data-count')] ?? 0);
        if (el.textContent !== value) el.textContent = value;
      });
      if (!mapMarkersLayer) return;
      if (skipUnchanged('markers', recordsSig() + '|' + mapSeverityFilter)) return;
      mapMarkersLayer.clearLayers();
      mapPinCountMarkers.clear();
      mapPlantMarkers = [];
      const cropsSheet = document.getElementById('farm-crops-sheet');
      if (cropsSheet?.dataset.mode === 'nearby') closeFarmCrops();
      placed.sort((a, b) =>
        (mapPinSeverityRank(recSeverity(a.group.latest)) - mapPinSeverityRank(recSeverity(b.group.latest))) ||
        ((recordMs(b.group.latest) || 0) - (recordMs(a.group.latest) || 0))
      );
      placed.forEach(({ group, pos }) => {
        const sev = recSeverity(group.latest);
        if (mapSeverityFilter !== 'all' && sev !== mapSeverityFilter) return;
        const meta = severityMeta(sev);
        const letter = escapeText(String(group.cropName || group.latest.crop || '?').charAt(0).toUpperCase());
        const color = sev === 'Moderate' ? '#f3bf31' : meta.pin;
        const content = '<span class="map-pin-circle" style="color:' + meta.pinInk + '">' + letter + '</span>';
        const photo = group.records.find(record => {
          const url = record.imageUrl || '';
          return /^\/api\/photos\/[A-Za-z0-9_-]{1,128}$/.test(url) || /^(?:\/img\/|img\/|crops\/|data:image\/)/.test(url);
        });
        const thumbnailPath = photo
          ? (/^\/api\/photos\//.test(photo.imageUrl) ? photo.imageUrl + '/thumbnail' : photo.imageUrl)
          : (group.latest?.id ? 'local:' + group.latest.id : null);
        const severityRank = mapPinSeverityRank(sev);
        const pinZIndex = sev === 'Severe' ? 300 : (sev === 'Moderate' ? 150 : 0);
        const label = (group.cropName || group.latest.crop || '?') + ' — ' + meta.label;
        const marker = mapPinMarker([pos.lat, pos.lng], {
          title: label, alt: label, recordId: group.latest.id,
          pinContent: content, pinColor: color,
          severityRank, recordTs: recordMs(group.latest) || 0, pinZIndex,
          thumbnailPath,
        }, () => openBottomSheet(group.latest.id));
        marker.setZIndexOffset(pinZIndex);
        mapPlantMarkers.push(marker);
      });
      layoutMapPins();
    }

    function openUnlocatedHelp() {
      navigateToMenu('log');
      showToast('Buka tanamannya, lalu Lainnya → Ubah lokasi untuk menaruhnya di peta.');
    }
    window.openUnlocatedHelp = openUnlocatedHelp;

    function filterMapPoints(severity, btnEl) {
      document.querySelectorAll('.map-filter-btn').forEach(b => { b.classList.remove('is-active'); b.setAttribute('aria-pressed', 'false'); });
      if (btnEl) { btnEl.classList.add('is-active'); btnEl.setAttribute('aria-pressed', 'true'); }
      renderMapMarkers(severity);
    }


    /* ------------------------------ photo viewer -----------------------------
       Record thumbnails are 48-56px squares — far too small to judge whether the AI
       looked at the right leaf. Tapping any of them opens the stored photo full-size.
       ---------------------------------------------------------------------- */
    let viewerRecordId = null;

    function displayElevation(value) {
      if (value === null || value === undefined || value === '') return 'Ketinggian tidak tersedia';
      const number = Number(value);
      return Number.isFinite(number) ? `${Math.round(number)} meter dpl` : 'Ketinggian tidak tersedia';
    }

    async function recordPhotoSource(record) {
      const owner = String(currentAccount?.id || ''), generation = accountGeneration;
      if (!record || !owner) return null;
      try {
        const local = await JagaMedia.dataUrl(record.id);
        if (generation !== accountGeneration || owner !== String(currentAccount?.id || '')) return null;
        if (local) return local;
      } catch (_) { /* Older records can have only the owned server copy. */ }
      const serverUrl = record.serverImageUrl || record.imageUrl;
      if (!serverUrl) return null;
      try {
        const resolved = await JagaNative.resolveImageUrl(serverUrl);
        if (generation !== accountGeneration || owner !== String(currentAccount?.id || '')) return null;
        return resolved || null;
      } catch (_) { return null; }
    }

    function openPhotoViewer(imageUrl, title, subtitle, caption, recordId) {
      if (!imageUrl) {
        showToast('Catatan ini belum punya foto tersimpan.');
        return;
      }
      viewerRecordId = recordId || null;
      const viewer = document.getElementById('photo-viewer');
      const image = document.getElementById('photo-viewer-image');
      if (image) {
        image.onerror = () => showToast('Pratinjau foto tidak dapat dimuat. Periksa koneksi atau buka kembali Riwayat.');
        image.onload = () => { image.onerror = null; };
        image.src = imageUrl;
      }
      const titleEl = document.getElementById('photo-viewer-title');
      if (titleEl) titleEl.innerText = title || 'Foto Analisis';
      const subEl = document.getElementById('photo-viewer-subtitle');
      if (subEl) subEl.innerText = subtitle || '';
      const capEl = document.getElementById('photo-viewer-caption');
      if (capEl) capEl.innerText = caption || '';
      let assessmentHost = document.getElementById('viewer-assessment');
      if (!assessmentHost && capEl) { assessmentHost = document.createElement('div'); assessmentHost.id='viewer-assessment'; capEl.after(assessmentHost); }
      const assessmentRecord = farmRecords.find(row=>row.id===recordId);
      if(subEl&&assessmentRecord?.previousCondition)subEl.innerText='Sebelum analisis ulang: '+assessmentRecord.previousCondition+' · '+formatWhenId(recordMs(assessmentRecord));
      window.JagaAssessment?.render(assessmentHost, assessmentRecord || {},{compact:true});
      if(capEl){capEl.hidden=false;if(assessmentRecord)window.JagaAssessment?.summary(capEl,assessmentRecord);}
      if (viewer) setDialogOpen('photo-viewer');
      const editLocation = document.getElementById('viewer-edit-location'); if (editLocation) editLocation.textContent = 'Ubah lokasi';
      const saveGallery = document.getElementById('viewer-save-gallery'); if (saveGallery) saveGallery.textContent = 'Simpan ke galeri';
      icons();
    }

    async function openViewerForRecord(recordId) {
      const rec = farmRecords.find(r => r.id === recordId);
      if (!rec) return;
      const owner=String(currentAccount?.id||''),generation=accountGeneration;
      const rendered=typeof renderRecordPhoto==='function'?await renderRecordPhoto(rec):null;
      const source=rendered?.dataUrl||await recordPhotoSource(rec);
      if(generation!==accountGeneration||owner!==String(currentAccount?.id||''))return;
      if (!source) { showToast('Pratinjau foto tidak dapat dimuat. Periksa koneksi atau buka kembali Riwayat.'); return; }
      openPhotoViewer(
        source,
        rec.cropName || rec.crop || 'Tanaman',
        [recordLabel(rec), formatWhenId(recordMs(rec))].filter(Boolean).join(' · '),
        rec.immediate_action || rec.symptoms || '',
        rec.id
      );
    }

    function closePhotoViewer() {
      closeDialog('photo-viewer');
      const image = document.getElementById('photo-viewer-image');
      if (image) image.removeAttribute('src');   // release the decoded image
      viewerRecordId = null;
      for(const id of ['photo-viewer-title','photo-viewer-subtitle','photo-viewer-caption','viewer-assessment'])document.getElementById(id)?.replaceChildren();
    }

    function openViewerInMap() {
      const recordId = viewerRecordId;
      closePhotoViewer();
      if (recordId) viewRecordInMap(recordId);
    }


    let mapSheetTrigger = null;
    function openBottomSheet(recordId) {
      const rec = farmRecords.find(r => r.id === recordId);
      if (!rec) return;
      closeFarmPanel();
      closeFarmCrops();
      currentDetailRecord = rec;

      const meta = severityMeta(recSeverity(rec));
      const badge = document.getElementById('sheet-severity-badge');
      badge.innerText = meta.label;
      badge.className = meta.badgeClass;

      document.getElementById('sheet-crop-title').innerText = rec.cropName || rec.crop || 'Tanaman';
      document.getElementById('sheet-condition-name').innerText = recordLabel(rec);
      const geo = document.getElementById('sheet-geocorrelation');
      geo.innerText = rec.geocorrelation || '';
      geo.classList.toggle('hidden', !rec.geocorrelation);
      document.getElementById('sheet-meta-time').innerText = formatWhenId(recordMs(rec));
      const hasElevation = rec.elevation !== null && rec.elevation !== undefined && rec.elevation !== '' && Number.isFinite(Number(rec.elevation));
      document.getElementById('sheet-meta-elev').innerText = hasElevation ? Math.round(Number(rec.elevation)) + ' m dpl' : 'Tidak tersedia';
      document.getElementById('sheet-meta-elev').closest('.info-row')?.classList.remove('hidden');
      document.getElementById('sheet-action-text').innerText = rec.assessment?.actions?.[0] || rec.immediate_action || 'Belum ada saran. Foto ulang bila perlu.';
      document.getElementById('sheet-action-text').parentElement.hidden=false;
      window.JagaAssessment?.render(document.getElementById('sheet-assessment'),rec,{compact:true});
      const sheetThumb = document.getElementById('sheet-crop-thumb');
      if (sheetThumb) {
        sheetThumb.classList.remove('is-broken');
        sheetThumb.onerror = () => { sheetThumb.removeAttribute('src'); sheetThumb.classList.add('is-broken'); };
        const photoRecordId = rec.id, photoOwner = String(currentAccount?.id || ''), photoGeneration = accountGeneration;
        sheetThumb.alt = `Foto ${rec.crop || 'tanaman'}`;
        sheetThumb.removeAttribute('src');
        recordPhotoSource(rec).then(source => {
          if (!sheetThumb.isConnected || currentDetailRecord?.id !== photoRecordId ||
              photoOwner !== String(currentAccount?.id || '') || photoGeneration !== accountGeneration) return;
          if (source) sheetThumb.src = source; else sheetThumb.classList.add('is-broken');
        });
        // Same full-size viewer as Riwayat and Beranda.
        sheetThumb.classList.add('cursor-pointer');
        sheetThumb.onclick = () => openViewerForRecord(rec.id);
      }

      const sheet = document.getElementById('map-bottom-sheet');
      if (!sheet.classList.contains('translate-y-0')) mapSheetTrigger = document.activeElement;
      sheet.inert = false; sheet.setAttribute('aria-hidden','false');
      sheet.classList.remove('translate-y-[150%]');
      sheet.classList.add('translate-y-0');
      updateMapSheetState();

      if (mapInstance && validCoordinates(rec.lat, rec.lng)) {
        mapInstance.panTo([rec.lat, rec.lng]);
      }
    }


    function closeBottomSheet() {
      const sheet = document.getElementById('map-bottom-sheet');
      if (sheet) {
        const restore = sheet.contains(document.activeElement);
        sheet.inert = true;
        sheet.setAttribute('aria-hidden', 'true');
        sheet.classList.remove('translate-y-0');
        sheet.classList.add('translate-y-[150%]');
        if (restore && mapSheetTrigger?.isConnected && !mapSheetTrigger.closest('[inert]') && mapSheetTrigger.getClientRects().length) mapSheetTrigger.focus();
      }
      mapSheetTrigger = null;
      currentDetailRecord = null;
      updateMapSheetState();
    }
    function photoAgainFromSheet() {
      const rec = currentDetailRecord;
      if (!rec) return;
      closeBottomSheet();
      startTreeCapture(treeKey(rec));
    }
    function openHistoryFromSheet() {
      const rec = currentDetailRecord;
      if (!rec) return;
      closeBottomSheet();
      openTreeTimeline(treeKey(rec));
    }


    function speakCurrentDetail() {
      if (!currentDetailRecord) return;
      speakRecord(currentDetailRecord);
    }

    function viewRecordInMap(recordId) {
      navigateToMenu('map');
      setTimeout(() => {
        openBottomSheet(recordId);
      }, 300);
    }

    function viewLatestInMap() {
      if (farmRecords.length > 0) {
        viewRecordInMap(farmRecords[0].id);
      }
    }


    /* ----------------------------------- Riwayat ---------------------------------- */
    let logFilter = 'all';      // all | Severe | Moderate | Healthy | review
    let logQuery = '';
    let logSearchTimer = null;
    const entryMoreOpen = new Set();

    function groupMatchesQuery(group, query) {
      if (!query) return true;
      return group.records.some(r =>
        String(group.cropName || '').toLowerCase().includes(query) ||
        String(r.cropName || r.crop || '').toLowerCase().includes(query) ||
        String(r.crop || '').toLowerCase().includes(query) ||
        String(r.condition || '').toLowerCase().includes(query) ||
        recordLabel(r).toLowerCase().includes(query) ||
        String(r.locationName || '').toLowerCase().includes(query));
    }

    function updateLogChips(counts) {
      document.querySelectorAll('#log-chips .chip').forEach(chip => {
        const filter = chip.getAttribute('data-filter');
        const active = filter === logFilter;
        chip.classList.toggle('is-active', active);
        chip.setAttribute('aria-pressed', String(active));
        const count = chip.querySelector('.chip-count');
        if (count && count.textContent !== String(counts[filter] ?? 0)) count.textContent = String(counts[filter] ?? 0);
      });
    }

    function updateLogChrome() {
      const inTimeline = activeLogTab === 'crops' && !!expandedCropId && farmRecords.some(r => treeKey(r) === expandedCropId);
      document.getElementById('log-filter-wrap')?.classList.toggle('hidden', activeLogTab !== 'crops' || inTimeline);
      document.getElementById('view-log')?.classList.toggle('timeline-open', inTimeline);
    }

    function trendDotsHtml(records) {
      if (!Array.isArray(records) || records.length === 0) return '';
      const ordered = [...records].sort((a, b) => (recordMs(a) || 0) - (recordMs(b) || 0)).slice(-3);
      return '<span class="trend-dots" aria-hidden="true">' + ordered.map(r => {
        const s = recSeverity(r);
        const cls = s === 'Severe' ? 'sev' : s === 'Moderate' ? 'mod' : s === 'Healthy' ? 'hl' : '';
        return '<span class="tdot ' + cls + '"></span>';
      }).join('') + '</span>';
    }

    function treeCardHtml(g) {
      const rec = g.latest, meta = severityMeta(recSeverity(rec));
      const review = rec.needs_review === true;
      // One row: thumbnail | name, condition, status + when | camera icon ("Foto lagi"). The status sits in the
      // text column (list-item practice), so both ends of the row are free and vertically centred.
      // The whole text area opens the timeline.
      const open = act('toggleCropTimeline', String(g.cropId ?? ''));
      return '<article class="card tree-card">' +
        '<span class="tree-thumb"' + open + ' aria-hidden="true">' + thumbHtml(rec.imageUrl, '') + '</span>' +
        '<button type="button" class="tree-main"' + open + '>' +
          '<span class="tree-body">' +
            '<span class="tree-name">' + escapeText(g.cropName) + trendDotsHtml(g.records) + '</span>' +
            '<span class="tree-sub">' + escapeText(recordLabel(rec)) + (review ? ' · Perlu dicek' : '') + '</span>' +
            '<span class="card-status"><span class="' + meta.badgeClass + ' badge-sm">' + meta.label + '</span>' +
              '<span class="tree-when">' + escapeText(formatWhenId(recordMs(rec))) + ' · ' + g.count + ' foto</span></span>' +
          '</span>' +
        '</button>' +
        '<button type="button" class="btn btn-secondary btn-icon tree-cam" ' + act('startTreeCapture', String(g.cropId ?? '')) + ' title="Foto lagi" aria-label="Foto lagi"><i data-lucide="camera"></i></button>' +
      '</article>';
    }

    // A model's self-reported score is not a calibrated probability of a correct diagnosis.
    function confidenceHtml(rec) {
      if (rec.source === 'manual' || !rec.needs_review) return '';
      return '<p class="tl-confidence is-low">Perlu Pemeriksaan Langsung</p>';
    }

    // 0.2.4.17: a species or date the farmer corrected says so, with what the AI first said.
    function correctionHtml(rec) {
      const fields = Array.isArray(rec.correctedFields) ? rec.correctedFields : [];
      if (!fields.length) return '';
      const parts = [fields.includes('crop') ? 'jenis' : null, fields.includes('date') ? 'tanggal' : null].filter(Boolean).join(' dan ');
      return '<p class="tl-corrected">' + escapeText(parts.charAt(0).toUpperCase() + parts.slice(1)) + ' diubah oleh Anda' +
        (fields.includes('crop') && rec.aiCrop ? ' (AI: ' + escapeText(rec.aiCrop) + ')' : '') + '</p>';
    }

    function entryHtml(rec, last) {
      const meta = severityMeta(recSeverity(rec));
      const more = entryMoreOpen.has(rec.id);
      const rid = String(rec.id ?? '');
      const actionSummary = rec.assessment?.actions?.[0] || rec.immediate_action;
      const action = actionSummary
        ? '<p class="tl-action"><b>Rekomendasi tindakan:</b> ' + escapeText(actionSummary) + '</p>' : '';
      const onMap = validCoordinates(rec.lat, rec.lng)
        ? '<button type="button" class="btn btn-secondary btn-sm" ' + act('viewRecordInMap', rid) + '><i data-lucide="map-pin"></i><span>Lihat di Peta</span></button>' : '';
      // A record whose analysis failed has no assessment, so the big "Lihat analisis dan
      // pencegahan" button is hidden. Re-analysis therefore also lives in "Lainnya",
      // shown for every AI record that still owns an unstamped server original.
      let canReanalyze = false;
      try { canReanalyze = window.JagaAssessment?.canReanalyze?.(rec) === true; } catch (_) { canReanalyze = false; }
      const reanalyze = canReanalyze
        ? '<button type="button" class="btn btn-secondary btn-sm" ' + act('JagaAssessment.reanalyze', rid, '$this') + '><i data-lucide="refresh-cw"></i><span>Analisis Ulang</span></button>' : '';
      return '<article class="tl-entry">' +
        '<div class="tl-rail"><span class="tl-dot ' + meta.dotClass + '"></span>' + (last ? '' : '<span class="tl-line"></span>') + '</div>' +
        '<div class="card tl-card">' +
          '<div class="tl-top">' + thumbHtml(rec.imageUrl, '', act('openViewerForRecord', rid) + ' data-stop') +
            '<div class="min-w-0 flex-1">' +
              '<div class="tl-meta-row"><span class="' + meta.badgeClass + '">' + meta.label + '</span><span class="t-meta">' + escapeText(formatWhenId(recordMs(rec))) + '</span></div>' +
              '<p class="tl-condition">' + escapeText(recordLabel(rec)) + '</p>' +
              confidenceHtml(rec) + correctionHtml(rec) +
              (rec.needs_review === true ? '<p class="t-meta">Perlu dicek petugas</p>' : '') +
            '</div>' +
          '</div>' +
          action +
          (rec.assessment ? '<button type="button" class="btn btn-secondary btn-sm" ' + act('JagaAssessment.open', rid) + '>Lihat Analisis dan Pencegahan</button>' : '') +
          '<div class="btn-row">' +
            '<button type="button" class="btn btn-secondary btn-sm" ' + act('listenRecord', rid) + '><i data-lucide="volume-2"></i><span>Dengarkan</span></button>' +
            '<button type="button" class="btn btn-secondary btn-sm" aria-expanded="' + more + '" ' + act('toggleEntryMore', rid) + '><i data-lucide="' + (more ? 'chevron-up' : 'chevron-down') + '"></i><span>Lainnya</span></button>' +
          '</div>' +
          '<div class="tl-more btn-stack' + (more ? '' : ' hidden') + '">' + reanalyze + onMap +
            '<button type="button" class="btn btn-secondary btn-sm" ' + act('openRecordEdit', rid) + '><i data-lucide="square-pen"></i><span>Ubah Data Tanaman</span></button>' +
            '<button type="button" class="btn btn-danger btn-sm" ' + act('deleteRecord', rid) + '><i data-lucide="trash-2"></i><span>Hapus Catatan</span></button>' +
          '</div>' +
        '</div>' +
      '</article>';
    }

    function timelineHtml(g) {
      const rec = g.latest, meta = severityMeta(recSeverity(rec));
      const farm = farmList.find(f => f.id === rec.farmId);
      return '<div class="tl-head">' +
        '<button type="button" class="btn btn-ghost btn-sm tl-back" ' + act('closeTreeTimeline') + '><i data-lucide="chevron-left"></i><span>Semua tanaman</span></button>' +
        '<div class="card tl-hero">' +
          '<div class="tl-hero-top">' + thumbHtml(rec.imageUrl, 'thumb-lg', act('openViewerForRecord', String(rec.id ?? ''))) +
            '<div class="min-w-0 flex-1"><h2 class="t-title tl-title">' + escapeText(g.cropName) + '</h2>' +
              (farm ? '<p class="t-meta">Petak: ' + escapeText(farm.name) + '</p>' : '') +
              '<div class="tl-hero-status"><span class="' + meta.badgeClass + '">' + meta.label + '</span><span class="t-meta">' + g.count + ' foto</span></div>' +
            '</div>' +
          '</div>' +
          '<div class="tree-actions"><button type="button" class="btn btn-primary btn-icon tree-cam" ' + act('startTreeCapture', String(g.cropId ?? '')) + ' title="Foto lagi" aria-label="Foto lagi"><i data-lucide="camera"></i></button></div>' +
        '</div>' +
      '</div>' +
      '<div class="tl-list">' + g.records.map((r, i) => entryHtml(r, i === g.records.length - 1)).join('') + '</div>';
    }

    function renderLogRecords(filterQuery) {
      const container = document.getElementById('logs-container');
      if (!container) return;
      if (typeof filterQuery === 'string') logQuery = filterQuery.toLowerCase().trim();
      const allGroups = groupRecordsByCrop(farmRecords);
      let open = expandedCropId ? allGroups.find(g => g.cropId === expandedCropId) : null;
      if (expandedCropId && !open) expandedCropId = null;
      const counts = treeCounts(allGroups);
      updateLogChips(counts);
      updateLogChrome();
      const signature = ['log', recordsSig(), expandedCropId, logFilter, logQuery, [...entryMoreOpen].join(','), farmList.map(f => f.id + f.name).join(',')].join('|');
      if (skipUnchanged('log', signature)) return;

      if (open) {
        container.innerHTML = timelineHtml(open);
      } else if (allGroups.length === 0) {
        container.innerHTML = '<div class="card empty-card"><span class="home-empty-icon"><i data-lucide="leaf"></i></span><h3 class="t-title">Belum ada foto tanaman</h3><p class="t-body t-muted">Foto satu tanaman untuk memulai riwayatnya.</p>' +
          '<button type="button" class="btn btn-primary btn-block" ' + act('navigateToMenu', 'scan') + '><i data-lucide="camera"></i><span>Foto Tanaman</span></button></div>';
      } else {
        const groups = allGroups
          .filter(g => treeMatchesFilter(g, logFilter) && groupMatchesQuery(g, logQuery))
          .sort((a, b) => attentionRank(a) - attentionRank(b) || (recordMs(b.latest) || 0) - (recordMs(a.latest) || 0));
        container.innerHTML = groups.length
          ? groups.map(treeCardHtml).join('')
          : '<div class="card empty-card"><h3 class="t-title">Tidak ada tanaman yang cocok</h3><p class="t-body t-muted">Coba pilih status lain atau hapus kata pencarian.</p>' +
            '<button type="button" class="btn btn-secondary btn-block" ' + act('resetLogFilters') + '><span>Tampilkan semua</span></button></div>';
      }
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }

    function setLogFilter(filter) {
      logFilter = ['all', 'Severe', 'Moderate', 'Healthy', 'review'].includes(filter) ? filter : 'all';
      renderLogRecords();
    }
    function resetLogFilters() {
      logFilter = 'all';
      logQuery = '';
      const input = document.getElementById('log-search-input');
      if (input) input.value = '';
      renderLogRecords();
    }
    function toggleEntryMore(recordId) {
      if (entryMoreOpen.has(recordId)) entryMoreOpen.delete(recordId); else entryMoreOpen.add(recordId);
      renderLogRecords();
    }
    function speakRecord(rec) {
      if (!rec) return;
      const status = severityMeta(recSeverity(rec)).label;
      speakText('Tanaman ' + (rec.cropName || rec.crop || '') + '. Status ' + status + '. ' + recordLabel(rec) + '. ' +
        (window.JagaAssessment?.text(rec) || rec.immediate_action || ''));
    }
    function listenRecord(recordId) { speakRecord(farmRecords.find(r => r.id === recordId)); }
    function speakText(text) {
      if (!('speechSynthesis' in window)) { showToast('Pembacaan suara belum tersedia di perangkat ini.'); return; }
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(String(text));
      utterance.lang = 'id-ID'; utterance.rate = 0.95;
      window.speechSynthesis.speak(utterance);
    }

    function filterLogRecords() {
      clearTimeout(logSearchTimer);
      logSearchTimer = setTimeout(() => {
        logQuery = (document.getElementById('log-search-input')?.value || '').toLowerCase().trim();
        renderLogRecords();
      }, 200);
    }


    // ---------- Severity design tokens (single source of truth) ----------
    const SEVERITY_META = {
      Severe: {
        label: 'Kritis',
        badgeClass: 'badge badge-severe',
        softClass: 'bg-red-50 text-red-700 border border-red-200',
        dotClass: 'bg-red-500',
        textClass: 'text-red-600',
        pin: '#dc2626', pinInk: '#fff'
      },
      Moderate: {
        label: 'Waspada',
        badgeClass: 'badge badge-moderate',
        softClass: 'bg-amber-50 text-amber-800 border border-amber-200',
        dotClass: 'bg-amber-400',
        textClass: 'text-amber-700',
        pin: '#f59e0b', pinInk: '#0f172a'
      },
      Healthy: {
        label: 'Sehat',
        badgeClass: 'badge badge-healthy',
        softClass: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
        dotClass: 'bg-emerald-500',
        textClass: 'text-emerald-700',
        pin: '#15803d', pinInk: '#fff'
      },
      Unknown: {
        label: 'Belum dinilai',
        badgeClass: 'badge badge-unknown',
        softClass: 'bg-slate-100 text-slate-700 border border-slate-200',
        dotClass: 'bg-slate-400',
        textClass: 'text-slate-600',
        pin: '#64748b', pinInk: '#fff'
      }
    };

    function severityMeta(severity) {
      return SEVERITY_META[severity] || SEVERITY_META.Unknown;
    }

    // ONE short pest/disease name per record, shared by every card, list, map sheet and
    // viewer. assessment-ui.js owns the wording so no screen can drift from another.
    function recordLabel(rec) {
      try { return window.JagaAssessment?.label?.(rec) || rec?.condition || 'Belum dapat dipastikan'; }
      catch (_) { return rec?.condition || 'Belum dapat dipastikan'; }
    }


    /* ----------------------------------- Beranda ---------------------------------- */
    // `action` replaces the default tap (open the plant in Riwayat), e.g. the Peta plot sheet's own handler.
    function attentionItemHtml(group, action) {
      const rec = group.latest;
      const sev = recSeverity(rec);
      const meta = severityMeta(sev);
      const review = rec.needs_review === true;
      const farm = rec.farmId ? farmList.find(f => f.id === rec.farmId) : null;
      const metaParts = [];
      if (farm?.name) metaParts.push(farm.name);
      metaParts.push(formatWhenId(recordMs(rec)));
      if (Number.isFinite(rec.elevation)) metaParts.push(Math.round(rec.elevation) + ' m dpl');
      const actionPill = action ? '' : '<span class="att-action-pill' + (sev === 'Severe' ? ' is-severe' : '') + '">' + (sev === 'Severe' ? 'Diagnosis' : 'Riwayat') + '</span>';
      return '<button type="button" class="card card-tap att-item" ' + (action || act('openCropFromHome', String(group.cropId ?? ''))) + '>' +
        thumbHtml(rec.imageUrl, '') +
        '<span class="att-item-body">' +
          '<span class="att-item-top"><span class="' + meta.badgeClass + ' badge-sm">' + meta.label + '</span>' +
            '<span class="att-item-name">' + escapeText(group.cropName) + '</span>' +
            trendDotsHtml(group.records) +
          '</span>' +
          '<span class="att-item-cond">' + escapeText(recordLabel(rec)) + (review ? ' · Perlu dicek' : '') + '</span>' +
          '<span class="att-item-meta">' + escapeText(metaParts.join(' · ')) + '</span>' +
        '</span>' +
        actionPill +
      '</button>';
    }

    function renderHomeSummary() {
      const ready = loadedOnce || farmRecords.length > 0;
      if (skipUnchanged('home', recordsSig() + '|' + ready + '|' + farmList.length)) return;
      const groups = groupRecordsByCrop(farmRecords);
      const counts = treeCounts(groups);
      setText('stat-total-scans', ready ? counts.all : '—');
      setText('stat-critical-count', ready ? counts.Severe : '—');
      setText('stat-moderate-count', ready ? counts.Moderate : '—');
      setText('stat-healthy-count', ready ? (counts.Healthy || 0) : '—');
      const sideBadge = document.getElementById('side-critical-badge');
      if (sideBadge) {
        const crit = Number(counts.Severe) || 0;
        sideBadge.textContent = String(crit);
        sideBadge.classList.toggle('hidden', !ready || crit <= 0);
      }
      const empty = ready && farmRecords.length === 0;
      toggleHidden('home-empty', empty);
      toggleHidden('home-actions', !empty);
      toggleHidden('home-tiles', !empty);
      toggleHidden('home-attention', !empty);
      toggleHidden('home-recent', !empty);
      toggleHidden('home-daily', !empty);   // first use: one clear action, nothing to summarise yet
      syncSidebarAccountUi();
      syncSidebarSyncBox();
      updateTopPageSub(currentMenuName);
      const list = document.getElementById('home-attention-list');
      const more = document.getElementById('home-attention-more');
      if (!list) return;
      if (!ready) return;   // keep the skeleton while the first load runs
      const attention = groups.filter(group => attentionRank(group) < 2)
        .sort((a, b) => (recordMs(b.latest) || 0) - (recordMs(a.latest) || 0));
      if (attention.length === 0) {
        list.innerHTML = '<div class="notice notice-ok"><i data-lucide="circle-check"></i><span>Semua tanaman terakhir terlihat sehat.</span></div>';
      } else {
        list.innerHTML = attention.slice(0, 4).map(group => attentionItemHtml(group)).join('');
      }
      if (more) more.classList.toggle('hidden', attention.length <= 4);
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }

    function renderHomeHistoryCarousel() {
      const container = document.getElementById('home-history-carousel');
      if (!container) return;
      if (skipUnchanged('carousel', recordsSig())) return;
      const groups = groupRecordsByCrop(farmRecords).slice(0, 4);
      if (groups.length === 0) {
        container.innerHTML = '<div class="card w-full t-body t-muted text-center" style="grid-column:1 / -1;">Belum ada foto tanaman.</div>';
        updateCarouselNav();
        return;
      }
      container.innerHTML = groups.map(g => {
        const meta = severityMeta(recSeverity(g.latest));
        const src = imageAttribute(g.latest.imageUrl);
        return '<button type="button" ' + act('openCropFromHome', String(g.cropId ?? '')) + ' class="recent-card" aria-label="' + escapeText(g.cropName) + ', ' + meta.label + '">' +
          (src ? '<img class="recent-img" src="' + src + '" alt="' + escapeText(g.cropName) + '" loading="lazy" decoding="async">' : '<div class="recent-img"></div>') +
          '<div class="recent-body">' +
            '<div class="recent-body-top">' +
              '<strong>' + escapeText(g.cropName) + '</strong>' +
              '<span class="' + meta.badgeClass + ' badge-sm">' + meta.label + '</span>' +
            '</div>' +
            '<span class="recent-sub">' + escapeText(recordLabel(g.latest)) + ' · ' + escapeText(formatWhenId(recordMs(g.latest))) + '</span>' +
          '</div>' +
        '</button>';
      }).join('');
      updateCarouselNav();
    }

    /* Foto terbaru slider: arrows step about one row width and hide at each end. */
    function updateCarouselNav() {
      const row = document.getElementById('home-history-carousel');
      if (!row) return;
      const wrap = row.parentElement;
      const max = row.scrollWidth - row.clientWidth;
      const prev = wrap.querySelector('.carousel-nav.is-prev');
      const next = wrap.querySelector('.carousel-nav.is-next');
      if (prev) prev.hidden = !(max > 2 && row.scrollLeft > 2);
      if (next) next.hidden = !(max > 2 && row.scrollLeft < max - 2);
    }
    function slideHomeCarousel(direction) {
      const row = document.getElementById('home-history-carousel');
      if (!row) return;
      const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      row.scrollBy({ left: direction * Math.max(row.clientWidth * 0.8, 160), behavior: reduce ? 'auto' : 'smooth' });
    }
    function wireHomeCarousel() {
      const row = document.getElementById('home-history-carousel');
      if (!row) return;
      let queued = false;
      const update = () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; updateCarouselNav(); });
      };
      row.addEventListener('scroll', update, { passive: true });
      window.addEventListener('resize', update);
      if (typeof ResizeObserver !== 'undefined') new ResizeObserver(update).observe(row);
    }

    // Opens that tree's timeline in Riwayat (also used by the map sheet and Perlu perhatian).
    function openCropFromHome(cropId) { openTreeTimeline(cropId); }
    let keepTimelineOnNavigate = false;
    function openTreeTimeline(cropId) {
      expandedCropId = cropId;
      logFilter = 'all';
      logQuery = '';
      const input = document.getElementById('log-search-input');
      if (input) input.value = '';
      keepTimelineOnNavigate = true;
      navigateToMenu('log');
      switchLogTab('crops');
      const view = document.getElementById('view-log');
      if (view) view.scrollTop = 0;
    }
    function closeTreeTimeline() {
      expandedCropId = null;
      renderLogRecords();
      const view = document.getElementById('view-log');
      if (view) view.scrollTop = 0;
    }
    // Stat tiles on Beranda: open Riwayat with that status already chosen.
    function openLogWithFilter(filter) {
      expandedCropId = null;
      logFilter = ['all', 'Severe', 'Moderate', 'Healthy', 'review'].includes(filter) ? filter : 'all';
      logQuery = '';
      const input = document.getElementById('log-search-input');
      if (input) input.value = '';
      navigateToMenu('log');
      switchLogTab('crops');
      const view = document.getElementById('view-log');
      if (view) view.scrollTop = 0;
    }


    // ---------- Crop identity: distance (m) + species match, confirm with user ----------

    function baseSpeciesName(cropLabel) {
      return (cropLabel || '').split('/')[0].split('-')[0].trim().toLowerCase();
    }

    function speciesWords(cropLabel) {
      return (cropLabel || '').toLowerCase().split(/[^a-z]+/).filter(w => w.length > 2);
    }

    function speciesOverlap(a, b) {
      const wa = speciesWords(a);
      const wb = new Set(speciesWords(b));
      return wa.some(w => wb.has(w));
    }

    function haversineMeters(lat1, lng1, lat2, lng2) {
      const R = 6371000;
      const toRad = d => (d * Math.PI) / 180;
      const dLat = toRad(lat2 - lat1);
      const dLng = toRad(lng2 - lng1);
      const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2);
      return 2 * R * Math.asin(Math.sqrt(a));
    }


    function groupRecordsByCrop(records) {
      const groups = Object.create(null);
      records.forEach(rec => {
        const key = rec.cropId || `crop_legacy_${rec.id}`;
        if (!groups[key]) {
          groups[key] = {
            cropId: key,
            cropName: rec.cropName || rec.crop,
            species: baseSpeciesName(rec.crop),
            records: []
          };
        }
        groups[key].records.push(rec);
      });
      Object.values(groups).forEach(g => {
        g.records.sort((a, b) => (recordMs(b) || 0) - (recordMs(a) || 0));
        g.latest = g.records[0];
        g.count = g.records.length;
      });
      return Object.values(groups).sort((a, b) => ((recordMs(b.latest)) || 0) - ((recordMs(a.latest)) || 0));
    }


    // ---------- Riwayat tabs ----------

    function switchLogTab(tab) {
      // Guard: the petak tab is hidden until a polygon exists, so it must not stay active
      // if the farms go away (deleted, or a different account signed in).
      if (tab === 'petak' && farmList.length === 0) tab = 'crops';
      activeLogTab = tab;
      ['crops', 'petak', 'daily'].forEach(t => {
        const btn = document.getElementById(`tab-log-${t}`);
        if (btn) { btn.classList.toggle('is-active', t === tab); btn.setAttribute('aria-pressed', String(t === tab)); }
      });
      const cropsBox = document.getElementById('logs-container');
      const farmBox = document.getElementById('farm-logs-container');
      const dailyBox = document.getElementById('daily-container');
      if (cropsBox) cropsBox.classList.toggle('hidden', tab !== 'crops');
      if (farmBox) farmBox.classList.toggle('hidden', tab !== 'petak');
      if (dailyBox) dailyBox.classList.toggle('hidden', tab !== 'daily');
      if (tab === 'crops') renderLogRecords();
      else if (tab === 'petak') renderFarmLog();
      else renderDailyList();
      updateLogChrome();
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }

    /* ----------------------- riwayat grouped by petak ------------------------
       Once a farmer has drawn boundaries, the plot is the unit they think in — "how is
       kebun A doing?" — so the same records are also grouped by farm here. Records whose
       photo was taken outside every polygon (or before any existed) collect under
       "Tanpa Petak" rather than disappearing.
       ---------------------------------------------------------------------- */

    function renderFarmLog() {
      const box = document.getElementById('farm-logs-container');
      if (!box) return;
      if (skipUnchanged('farmlog', recordsSig() + '|' + farmList.map(f => f.id + f.name + f.areaM2).join(','))) return;

      if (farmList.length === 0) {
        box.innerHTML = '<div class="card empty-card"><span class="home-empty-icon"><i data-lucide="land-plot"></i></span><h3 class="t-title">Belum ada petak</h3>' +
          '<p class="t-body t-muted">Gambar batas kebun di menu Peta untuk mengelompokkan riwayat.</p></div>';
        icons();
        return;
      }

      const buckets = new Map(farmList.map(farm => [farm.id, []]));
      const loose = [];
      farmRecords.forEach(rec => {
        if (rec.farmId && buckets.has(rec.farmId)) buckets.get(rec.farmId).push(rec);
        else loose.push(rec);
      });

      const recordRow = (rec) => {
        const meta = severityMeta(recSeverity(rec));
        return '<button type="button" class="farm-rec" ' + act('openCropFromHome', String(treeKey(rec) ?? '')) + '>' +
          thumbHtml(rec.imageUrl, 'thumb-sm') +
          '<span class="farm-rec-body">' +
            '<span class="farm-rec-name">' + escapeText(rec.cropName || rec.crop || 'Tanaman') + '</span>' +
            '<span class="farm-rec-sub">' + escapeText(recordLabel(rec)) + '</span>' +
            '<span class="farm-rec-sub">' + escapeText(formatWhenId(recordMs(rec))) + ' · ' + escapeText(farmMembershipLabel(rec)) + '</span>' +
          '</span>' +
          '<span class="' + meta.badgeClass + '">' + meta.label + '</span>' +
        '</button>';
      };

      const section = (title, subtitle, records, farmId) => {
        if (records.length === 0) return '';
        const sorted = [...records].sort((a, b) => (recordMs(b) || 0) - (recordMs(a) || 0));
        return '<section class="card farm-log-card">' +
          '<div class="farm-log-head"><div class="min-w-0"><h3 class="t-title truncate">' + escapeText(title) + '</h3><p class="t-meta">' + escapeText(subtitle) + '</p></div>' +
          '<span class="badge badge-info">' + records.length + ' foto</span></div>' +
          (farmId ? '<button type="button" class="btn btn-secondary btn-sm btn-block farm-log-summary" ' + act('JagaPlotSummary.open', String(farmId)) + '><i data-lucide="clipboard-list"></i><span>Ringkasan dan saran petak</span></button>' : '') +
          sorted.map(recordRow).join('') +
        '</section>';
      };

      const sections = farmList.map(farm => {
        const records = buckets.get(farm.id) || [];
        const crops = [...new Set(records.map(r => r.crop).filter(Boolean))];
        const subtitle = [
          farm.crop || 'Tanaman belum diisi',
          formatArea(farm.areaM2),
          crops.length > 1 ? crops.length + ' jenis' : null,
        ].filter(Boolean).join(' · ');
        return section(farm.name, subtitle, records, farm.id);
      }).join('');

      box.innerHTML = sections
        + section('Belum masuk petak', 'Lokasi kosong atau di luar batas petak', loose);
      icons();
    }

    // The tab appears only when there is something to group by.
    function updateFarmTabVisibility() {
      const tab = document.getElementById('tab-log-petak');
      if (!tab) return;
      const hasFarms = farmList.length > 0;
      tab.classList.toggle('hidden', !hasFarms);
      if (!hasFarms && activeLogTab === 'petak') switchLogTab('crops');
    }

    let pendingStatusRecordId = null;
    function openStatusModal(recordId) {
      pendingStatusRecordId = recordId;
      const rec = farmRecords.find(r => r.id === recordId);
      const sub = document.getElementById('status-modal-subtitle');
      if (sub && rec) sub.innerText = `${rec.cropName || rec.crop} · ${formatWhenId(recordMs(rec))}`;
      openRecordEdit(recordId);
    }
    function closeStatusModal() {
      pendingStatusRecordId = null;
      closeRecordEdit();
    }
    async function confirmStatusChange(severity) {
      const recordId = pendingStatusRecordId;
      if (!recordId) return;
      const label = severity === 'Severe' ? 'Kritis' : severity === 'Moderate' ? 'Waspada' : 'Sehat';
      closeStatusModal();
      try {
        const record = farmRecords.find(r => r.id === recordId);
        const saved = await api('/api/records/' + encodeURIComponent(recordId),
          { method: 'PUT', body: { observedSeverity: severity } });
        const index = farmRecords.findIndex(r => r.id === saved.id);
        if (index >= 0) farmRecords[index] = saved;
        showToast('Status diperbarui: ' + label);
        refreshAllHistoryViews();
      } catch (error) {
        showToast('Gagal memperbarui status: ' + userMessage(error));
      }
    }

    /* 0.2.4.18: Ubah data tanaman lets a farmer correct species/date and record the observed status and
       short pest/disease labels for this photo. AI assessment text remains intact as a separate source. */
    let recordEdit = null;
    const plainSpecies = value => String(value || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
    function recordEditProblems(rec) {
      const saved = rec?.observedProblems;
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        return { disease: String(saved.disease || ''), pest: String(saved.pest || '') };
      }
      const result = { disease: '', pest: '' };
      const current = String(window.JagaAssessment?.label?.(rec) || rec?.condition || '').trim();
      if (!current || /^(tanaman sehat|belum dapat dipastikan)$/i.test(current)) return result;
      for (const part of current.split(/\s*(?:·|\+|;|,|\bdan\b)\s*/i)) {
        const label = part.trim();
        if (!label || /^(tanaman sehat|belum dapat dipastikan|kebutuhan unsur hara)$/i.test(label)
            || /^(?:kekurangan|defisiensi)\s+(?:unsur\s+)?(?:hara|nitrogen|fosfor|fosfat|kalium|kalsium|magnesium|belerang|sulfur|besi|mangan|boron|seng|zink|tembaga|molibdenum)\b/i.test(label)) continue;
        if (/^(?:hama\b|kutu\b|tungau\b|thrips\b|ulat\b|wereng\b|kepik\b|lalat\b|belalang\b|kumbang\b|nematoda\b|keong\b|tikus\b|penggerek\b|pengunyah\b)/i.test(label)) {
          result.pest = result.pest || label;
        } else {
          result.disease = result.disease || label;
        }
      }
      return result;
    }
    function dateInputValue(ms) {
      const d = new Date(ms || Date.now());
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    function openRecordEdit(recordId) {
      const rec = farmRecords.find(r => r.id === recordId);
      if (!rec || !currentAccount) return;
      const siblings = rec.cropId ? farmRecords.filter(r => r.cropId === rec.cropId).length : 1;
      const problems = recordEditProblems(rec);
      recordEdit = { id: rec.id, owner: String(currentAccount.id), generation: accountGeneration,
        crop: plainSpecies(rec.crop || rec.cropName), date: dateInputValue(recordMs(rec)),
        severity: rec.observedSeverity || rec.severity || '', problems };
      document.getElementById('record-edit-crop').value = recordEdit.crop;
      document.querySelector('#record-edit-status option[value=""]').textContent = rec.source === 'ai'
        ? 'Ikuti hasil AI' : (rec.observedSeverity && rec.severity ? 'Ikuti status awal' : 'Belum dinilai');
      document.getElementById('record-edit-status').value = recordEdit.severity;
      document.getElementById('record-edit-disease').value = problems.disease;
      document.getElementById('record-edit-pest').value = problems.pest;
      const aiCrop = rec.aiCrop || (rec.source === 'ai' ? rec.crop : null);
      const ai = document.getElementById('record-edit-ai');
      ai.textContent = aiCrop ? 'Dikenali AI sebagai: ' + aiCrop : '';
      ai.hidden = !aiCrop;
      document.getElementById('record-edit-all').checked = true;
      document.getElementById('record-edit-all-text').textContent = 'Terapkan ke semua ' + siblings + ' foto tanaman ini';
      document.getElementById('record-edit-all-row').hidden = siblings < 2;
      const date = document.getElementById('record-edit-date');
      date.value = recordEdit.date;
      date.max = dateInputValue(Date.now());
      document.getElementById('record-edit-location').textContent = rec.locationName ||
        (validCoordinates(rec.lat, rec.lng) ? Number(rec.lat).toFixed(5) + ', ' + Number(rec.lng).toFixed(5) : 'Belum ada lokasi');
      document.getElementById('record-edit-hint').textContent = rec.source === 'ai'
        ? 'Status dan dugaan hama/penyakit berlaku untuk foto ini. Rincian analisis AI tetap tersimpan. Bila jenis tanaman diubah, Anda bisa meminta analisis ulang dengan jenis yang benar.'
        : 'Status dan dugaan hama/penyakit berlaku untuk foto ini.';
      document.getElementById('record-edit-hint').hidden = false;
      const error = document.getElementById('record-edit-error');
      error.textContent = ''; error.classList.add('hidden');
      document.getElementById('record-edit-save').disabled = false;
      setDialogOpen('modal-record-edit');
    }
    function closeRecordEdit() { recordEdit = null; closeDialog('modal-record-edit'); }
    function openRecordEditLocation() { if (recordEdit) openLocationEditor('record', recordEdit.id); }
    // A location saved from inside this dialog shows here at once.
    JagaHooks.on('history-shown', () => {
      const rec = recordEdit && farmRecords.find(r => r.id === recordEdit.id), label = document.getElementById('record-edit-location');
      if (rec && label) label.textContent = rec.locationName || (validCoordinates(rec.lat, rec.lng) ? Number(rec.lat).toFixed(5) + ', ' + Number(rec.lng).toFixed(5) : 'Belum ada lokasi');
    });
    async function saveRecordEdit() {
      const target = recordEdit, rec = target && farmRecords.find(r => r.id === target.id);
      if (!rec) { closeRecordEdit(); return; }
      const error = document.getElementById('record-edit-error'), button = document.getElementById('record-edit-save');
      const fail = message => { error.textContent = message; error.classList.remove('hidden'); };
      const crop = document.getElementById('record-edit-crop').value.trim().replace(/\s+/g, ' ');
      const date = document.getElementById('record-edit-date').value;
      const severity = document.getElementById('record-edit-status').value;
      const disease = document.getElementById('record-edit-disease').value.trim().replace(/\s+/g, ' ');
      const pest = document.getElementById('record-edit-pest').value.trim().replace(/\s+/g, ' ');
      if (!crop) { fail('Isi jenis tanaman.'); return; }
      const body = {};
      if (crop !== target.crop) body.correctedCrop = crop;
      if (severity !== target.severity) {
        if (rec.source === 'ai' || rec.observedSeverity) body.observedSeverity = severity || null;
        else body.severity = severity || null;
      }
      if (disease !== target.problems.disease || pest !== target.problems.pest) {
        body.observedProblems = { disease, pest };
      }
      if (date && date !== target.date) {
        const [y, m, d] = date.split('-').map(Number), base = new Date(recordMs(rec) || Date.now());
        const next = new Date(y, m - 1, d, base.getHours(), base.getMinutes(), base.getSeconds()).getTime();
        if (!Number.isFinite(next) || y < 2000) { fail('Tanggal foto tidak valid.'); return; }
        if (next > Date.now() + 36e5) { fail('Tanggal foto tidak boleh setelah hari ini.'); return; }
        body.correctedTimestampMs = next;
      }
      if (!Object.keys(body).length) { closeRecordEdit(); return; }
      const all = !document.getElementById('record-edit-all-row').hidden && document.getElementById('record-edit-all').checked;
      if (body.correctedCrop && !all) body.applyToPlant = false;
      button.disabled = true;
      try {
        const saved = await api('/api/records/' + encodeURIComponent(rec.id), { method: 'PUT', body });
        if (String(currentAccount?.id || '') !== target.owner || accountGeneration !== target.generation) return;
        farmRecords = farmRecords.map(r => {
          if (r.id === saved.id) return saved;
          if (!body.correctedCrop || !all || !rec.cropId || r.cropId !== rec.cropId) return r;
          const fields = (Array.isArray(r.correctedFields) ? r.correctedFields : []).filter(f => f !== 'crop');
          const aiCrop = r.aiCrop || (r.source === 'ai' ? r.crop : null);
          return { ...r, crop: saved.crop, cropName: saved.crop, aiCrop, correctedFields: aiCrop === saved.crop ? fields : [...fields, 'crop'], updatedMs: saved.updatedMs };
        });
        closeRecordEdit();
        refreshAllHistoryViews();
        if (currentDetailRecord?.id === saved.id) openBottomSheet(saved.id);
        let canReanalyze = false;
        try { canReanalyze = body.correctedCrop && window.JagaAssessment?.canReanalyze?.(saved) === true; } catch (_) { canReanalyze = false; }
        if (!canReanalyze) { showToast('Data tanaman disimpan.'); return; }
        const again = await confirmAction({ title: 'Analisis ulang dengan jenis baru?',
          message: 'Diagnosis sekarang dibuat saat AI mengira tanaman ini ' + (rec.aiCrop || rec.crop || 'jenis lain') + '. Analisis ulang memakai foto yang sama dengan jenis ' + saved.crop + '.',
          okLabel: 'Analisis ulang', danger: false });
        if (again && String(currentAccount?.id || '') === target.owner) JagaAssessment.reanalyze(saved.id);
        else showToast('Data tanaman disimpan.');
      } catch (err) {
        if (recordEdit === target) { button.disabled = false; fail('Gagal menyimpan: ' + userMessage(err)); }
      }
    }

    function deleteRecord(recordId) {
      const rec = farmRecords.find(r => r.id === recordId);
      if (!rec) return;
      confirmAction({
        title: 'Hapus Catatan ini?',
        message: `Foto ${rec.cropName || rec.crop} (${formatWhenId(recordMs(rec))}) akan dihapus dari riwayat. Tidak bisa dibatalkan.`,
        okLabel: 'Hapus'
      }).then(async (ok) => {
        if (!ok) return;
        try {
          await api('/api/records/' + encodeURIComponent(recordId), { method: 'DELETE' });
          farmRecords = farmRecords.filter(r => r.id !== recordId);
          // Contract 5.6 (WEB): the private original on this phone goes with the record.
          if (window.JagaMedia) window.JagaMedia.deleteQuietly({ photoId: recordId });
          showToast("Catatan dihapus dari riwayat.");
          refreshAllHistoryViews();
        } catch (error) {
          showToast('Gagal menghapus: ' + userMessage(error));
        }
      });
    }

    function deleteDaily(dailyId) {
      confirmAction({
        title: 'Hapus Catatan harian?',
        message: 'Catatan ini akan dihapus dari arsip harian secara permanen.',
        okLabel: 'Hapus'
      }).then(async (ok) => {
        if (!ok) return;
        try {
          await api('/api/daily/' + encodeURIComponent(dailyId), { method: 'DELETE' });
          dailyRecommendations = dailyRecommendations.filter(d => d.id !== dailyId);
          renderDailyRecommendations();
          renderDailyList();
          showToast("Catatan harian dihapus.");
        } catch (error) {
          showToast('Gagal menghapus: ' + userMessage(error));
        }
      });
    }

    function toggleCropTimeline(cropId) {
      expandedCropId = expandedCropId === cropId ? null : cropId;
      renderLogRecords();
      const view = document.getElementById('view-log');
      if (view) view.scrollTop = 0;
    }

    // Today's uploads feed a live summary; saved personal notes remain explicit snapshots.
    function buildDailyDraft(now = Date.now()) {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const records = farmRecords.map(rec => ({...rec, condition:window.JagaAssessment?.label(rec)||rec.condition,
        severity:recSeverity(rec), observedSeverity:null}));
      const derived = window.JagaDailyLog.build(records, now, timeZone);
      const label=value=>({Severe:'kritis',Moderate:'waspada',Healthy:'sehat'})[value]||'status tidak dicatat';
      const lines = derived.crops.length ? derived.crops.map(crop => `${crop.crop}: ${label(crop.severity)}`) : ['Belum ada foto tanaman diunggah hari ini.'];
      return {...derived, lines, zones:[], counts:{}, summary: window.JagaDailyLog.narrative(derived)};
    }
    function openDailyModal() {
      const draft = pendingDailyDraft = buildDailyDraft();
      const box = document.getElementById('daily-draft-summary');
      if (box) box.textContent = draft.summary;
      const date = document.getElementById('daily-source-date');
      if (date) date.textContent = 'Untuk hari ini, ' + window.JagaDailyLog.labelDate(draft.date, true);
      const title = document.getElementById('daily-title-input'), summary = document.getElementById('daily-summary-input');
      if (title) title.value = '';
      if (summary) summary.value = '';
      const actions = document.getElementById('daily-actions-input'); if (actions) actions.value = '';
      const fold = document.querySelector('#modal-daily details.fold'); if (fold) fold.open = false;
      const feedback = document.getElementById('daily-save-error');
      feedback.textContent = ''; feedback.hidden = true;
      setDialogOpen('modal-daily'); icons();
    }
    function useDailySuggestion() {
      const summary = document.getElementById('daily-summary-input');
      const text = (pendingDailyDraft || buildDailyDraft()).summary;
      if (summary) { summary.value = text; summary.focus(); }
    }
    function closeDailyModal(){closeDialog('modal-daily');}

    async function saveDailyRecommendation() {
      const button = document.getElementById('daily-save');
      const feedback = document.getElementById('daily-save-error');
      if (button.disabled) return;
      feedback.textContent = '';
      feedback.hidden = true;
      const owner = String(currentAccount?.id || ''), generation = accountGeneration, draft = buildDailyDraft();
      const summary = document.getElementById('daily-summary-input')?.value.trim() || String(draft.summary || '').trim();
      const title = document.getElementById('daily-title-input')?.value.trim() || ('Catatan ' + window.JagaDailyLog.shortDate(draft.date));
      const actionsRaw = document.getElementById('daily-actions-input')?.value.trim();
      if (!summary) {
        feedback.textContent = 'Tulis catatan dulu, atau ketuk "Pakai ringkasan".';
        feedback.hidden = false;
        return;
      }
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      button.textContent = 'Menyimpan…';
      try {
        const saved = await api('/api/daily', {method:'POST', body:{
          date:`${draft.date} (${draft.timeZone})`, timestampMs:Date.now(), title, summary,
          actions:actionsRaw ? actionsRaw.split('\n').map(x => x.trim()).filter(Boolean) : [],
          sourceRecordIds:draft.sourceRecordIds, zones:draft.zones
        }});
        if (generation !== accountGeneration || owner !== String(currentAccount?.id || '')) return;
        const i = dailyRecommendations.findIndex(x => x.id === saved.id);
        if (i >= 0) dailyRecommendations[i] = saved; else dailyRecommendations.unshift(saved);
        dailyRecommendations.sort((a,b) => (b.timestampMs || 0) - (a.timestampMs || 0));
        pendingDailyDraft = null;
        closeDailyModal();
        renderDailyRecommendations();
        renderDailyList();
        showToast('Catatan tersimpan di Riwayat > Harian.');
      } catch (error) {
        if (generation === accountGeneration && owner === String(currentAccount?.id || '')) {
          feedback.textContent = 'Catatan belum tersimpan: ' + userMessage(error);
          feedback.hidden = false;
          feedback.scrollIntoView({block:'nearest'});
        }
      } finally {
        button.disabled = false;
        button.removeAttribute('aria-busy');
        button.textContent = 'Simpan catatan';
      }
    }

    let dailyRefreshTimer = null;
    function scheduleDailyRefresh() {
      if (dailyRefreshTimer) clearTimeout(dailyRefreshTimer);
      dailyRefreshTimer = null;
      if (!currentAccount || document.hidden) return;
      const now = new Date(), midnight = new Date(now);
      midnight.setHours(24,0,0,50);
      dailyRefreshTimer = setTimeout(() => {
        dailyRefreshTimer = null;
        if (currentAccount && !document.hidden) { renderDailyRecommendations(); scheduleDailyRefresh(); }
      }, Math.max(50,midnight.getTime()-now.getTime()));
    }
    function renderDailyRecommendations() {
      renderHomeDaily();
      if (activeLogTab === 'daily') renderDailyList();
      const modal = document.getElementById('modal-daily');
      if (modal && !modal.classList.contains('hidden')) {
        pendingDailyDraft = buildDailyDraft();
        document.getElementById('daily-draft-summary').textContent = pendingDailyDraft.summary;
        document.getElementById('daily-source-date').textContent = 'Untuk hari ini, ' + window.JagaDailyLog.labelDate(pendingDailyDraft.date,true);
        // A farmer's typed note is never replaced when new photos arrive.
      }
    }


    let homeDailyText = '';
    function renderHomeDaily() {
      const box = document.getElementById('home-daily-card');
      if (!box) return;
      const draft = buildDailyDraft();
      if (skipUnchanged('homeDaily', draft.summary + '|' + dailyRecommendations.length)) return;
      homeDailyText = draft.summary;
      box.innerHTML = '<article class="card daily-home">' +
        '<p class="daily-narrative daily-clamp">' + escapeText(draft.summary) + '</p>' +
        '<div class="btn-row">' +
          '<button type="button" class="btn btn-secondary btn-sm" ' + act('speakHomeDaily') + '><i data-lucide="volume-2"></i><span>Dengarkan</span></button>' +
          '<button type="button" class="btn btn-secondary btn-sm" ' + act('switchLogTabFromHome', 'daily') + '><span>Lihat semua</span></button>' +
        '</div>' +
      '</article>';
      if (typeof lucide !== 'undefined') lucide.createIcons();
      requestAnimationFrame(updateHomeScrollCues);
    }

    // Named actions for the two handlers that used to read app state inline (0.2.4.16, CSP without 'unsafe-inline').
    function speakHomeDaily() { speakDailySummary(homeDailyText); }
    function editCurrentDetailLocation() { if (currentDetailRecord) openLocationEditor('record', currentDetailRecord.id); }
    function editCurrentDetailRecord() { if (currentDetailRecord) openRecordEdit(currentDetailRecord.id); }

    function speakDailySummary(text) {
      if (!('speechSynthesis' in window)) { showToast('Pembacaan suara belum tersedia di perangkat ini.'); return; }
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(String(text));
      utterance.lang = 'id-ID'; utterance.rate = 0.95;
      window.speechSynthesis.speak(utterance);
    }

    function listenDailyEntry(id) {
      const entry = dailyRecommendations.find(item => item.id === id);
      if (entry) speakDailySummary(entry.summary);
    }

    function switchLogTabFromHome(tab) {
      navigateToMenu('log');
      setTimeout(() => switchLogTab(tab), 150);
    }


    function dailyDateLabel(entry) {
      const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(entry.date || ''));
      if (m && window.JagaDailyLog) return window.JagaDailyLog.labelDate(m[1], true);
      return Number.isFinite(entry.timestampMs) && entry.timestampMs > 0 ? formatDateId(entry.timestampMs, true) : plainDateText(entry.date);
    }
    function renderDailyList() {
      const box = document.getElementById('daily-container');
      if (!box) return;
      const draft = buildDailyDraft();
      if (skipUnchanged('dailylist', draft.summary + '|' + JSON.stringify(dailyRecommendations.map(d => [d.id, d.title, d.summary, d.date, d.timestampMs, (d.actions || []).length])))) return;
      const today = '<article class="card daily-item daily-live">' +
        '<div><h3 class="t-title">Ringkasan hari ini</h3><p class="t-meta">' + escapeText(window.JagaDailyLog.labelDate(draft.date,true)) + '</p></div>' +
        '<p class="daily-narrative t-body">' + escapeText(draft.summary) + '</p>' +
        '<div class="btn-row"><button type="button" class="btn btn-secondary btn-sm" ' + act('openDailyModal') + '><i data-lucide="plus"></i><span>Tulis catatan</span></button></div></article>';
      box.innerHTML = today + [...dailyRecommendations]
        .sort((a, b) => (b.timestampMs || 0) - (a.timestampMs || 0))
        .map(d => {
          const actions = Array.isArray(d.actions) ? d.actions : [];
          const zones = Array.isArray(d.zones) ? d.zones : [];
          return '<article class="card daily-item">' +
            '<div class="min-w-0"><h3 class="t-title">' + escapeText(plainDateText(d.title)) + '</h3><p class="t-meta">' + escapeText(dailyDateLabel(d)) + '</p></div>' +
            (zones.length ? '<div class="flex flex-wrap gap-2">' + zones.map(z => '<span class="badge badge-info">' + escapeText(z) + '</span>').join('') + '</div>' : '') +
            '<p class="daily-narrative t-body">' + escapeText(plainDateText(d.summary)) + '</p>' +
            (actions.length ? '<div class="info-box">' + actions.map(a => '<div class="daily-action"><i data-lucide="check"></i><span>' + escapeText(a) + '</span></div>').join('') + '</div>' : '') +
            '<div class="btn-row">' +
              '<button type="button" class="btn btn-secondary btn-sm" ' + act('listenDailyEntry', String(d.id ?? '')) + '><i data-lucide="volume-2"></i><span>Dengarkan</span></button>' +
              '<button type="button" class="btn btn-danger btn-sm" ' + act('deleteDaily', String(d.id ?? '')) + '><i data-lucide="trash-2"></i><span>Hapus</span></button>' +
            '</div>' +
          '</article>';
        }).join('');
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }

    function exportLogsToJSON() {
      const payload = {
        exportedAt: new Date().toISOString(),
        crops: groupRecordsByCrop(farmRecords),
        records: farmRecords,
        dailyRecommendations
      };
      const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(payload, null, 2));
      const downloadAnchor = document.createElement('a');
      downloadAnchor.setAttribute("href", dataStr);
      downloadAnchor.setAttribute("download", `JagaKebond_Logs_${Date.now()}.json`);
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      downloadAnchor.remove();
      showToast("Data tersimpan ke file.");
    }

    function weatherNote(rh) {
      if (typeof rh !== 'number') return 'Menunggu data cuaca';
      if (rh >= 80) return 'Lembap, waspada jamur';
      if (rh <= 60) return 'Udara kering';
      return 'Kelembapan sedang';
    }

    function setAccuracyDot(meters, status = 'Lokasi belum tersedia') {
      const value = Number.isFinite(meters) && meters >= 0 ? meters : null;
      const kind = value === null ? 'unknown' : value < 50 ? 'good' : value <= 100 ? 'fair' : 'poor';
      const label = value === null ? status : `Akurasi GPS ${kind === 'good' ? 'baik' : kind === 'fair' ? 'sedang' : 'rendah'}`;
      ['home-accuracy-tag', 'header-gps-indicator'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.dataset.accuracy = kind;
        el.textContent = '';
        el.setAttribute('aria-label', label);
        el.title = label;
      });
    }
    function updateAccuracyDot(meters) { setAccuracyDot(meters); }

    function updateHomeScrollCues() {}
    function scrollHomePane() {}
    function scheduleHomeScrollPeek() {}
    function renderHomeMiniMap(groupsArg) {
      const canvas = document.getElementById('home-mini-map-canvas');
      if (!canvas || !canvas.getContext) return;
      const ctx = canvas.getContext('2d');
      const W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#edf4ee';
      ctx.fillRect(0, 0, W, H);

      /* Soft cartographic contour lines */
      ctx.strokeStyle = 'rgba(21, 128, 61, 0.08)';
      ctx.lineWidth = 1.25;
      for (let i = -1; i < 6; i++) {
        ctx.beginPath();
        ctx.ellipse(W * 0.52, H * 0.55, 70 + i * 48, 34 + i * 24, -0.18, 0, Math.PI * 2);
        ctx.stroke();
      }

      const groups = Array.isArray(groupsArg) ? groupsArg : (typeof groupRecordsByCrop === 'function' ? groupRecordsByCrop(farmRecords) : []);
      const metaEl = document.getElementById('home-map-meta');
      if (metaEl) {
        if (farmList.length || groups.length) {
          metaEl.textContent = `${farmList.length} petak aktif · ${groups.length} tanaman tercatat`;
        } else {
          metaEl.textContent = 'Ketuk untuk menandai batas petak di peta';
        }
      }

      const polys = (farmList || []).filter(f => Array.isArray(f.ring) && f.ring.length >= 3);
      const pts = [];
      (farmRecords || []).forEach(r => {
        if (Number.isFinite(Number(r.lat)) && Number.isFinite(Number(r.lng))) {
          pts.push({ lat: Number(r.lat), lng: Number(r.lng), sev: recSeverity(r) });
        }
      });

      const allCoords = [];
      polys.forEach(f => f.ring.forEach(p => { if (Array.isArray(p) && p.length >= 2) allCoords.push([Number(p[0]), Number(p[1])]); }));
      pts.forEach(p => allCoords.push([p.lat, p.lng]));

      if (!allCoords.length) {
        ctx.strokeStyle = 'rgba(21, 128, 61, 0.25)';
        ctx.setLineDash([6, 5]);
        ctx.strokeRect(36, 32, W - 72, H - 64);
        ctx.setLineDash([]);
        ctx.fillStyle = '#475569';
        ctx.font = '600 13px system-ui, -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Belum ada poligon atau pin kebun', W / 2, H / 2 + 4);
        return;
      }

      let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
      allCoords.forEach(([la, ln]) => {
        if (la < minLat) minLat = la;
        if (la > maxLat) maxLat = la;
        if (ln < minLng) minLng = ln;
        if (ln > maxLng) maxLng = ln;
      });
      const midLatRad = ((minLat + maxLat) * 0.5) * Math.PI / 180;
      const cosLat = Math.max(0.2, Math.cos(midLatRad));
      const pad = 26;
      const spanX = Math.max(0.0004, (maxLng - minLng) * cosLat);
      const spanY = Math.max(0.0004, maxLat - minLat);
      const scale = Math.min((W - pad * 2) / spanX, (H - pad * 2) / spanY);
      const offsetX = (W - spanX * scale) * 0.5;
      const offsetY = (H - spanY * scale) * 0.5;
      const proj = (la, ln) => [
        offsetX + ((ln - minLng) * cosLat) * scale,
        H - (offsetY + (la - minLat) * scale)
      ];

      const strokes = ['#7c3aed', '#15803d', '#0284c7', '#b45309'];
      const fills = ['rgba(124, 58, 237, 0.14)', 'rgba(21, 128, 61, 0.14)', 'rgba(2, 132, 199, 0.14)', 'rgba(180, 83, 9, 0.14)'];
      polys.forEach((f, idx) => {
        ctx.beginPath();
        f.ring.forEach((p, i) => {
          const [x, y] = proj(Number(p[0]), Number(p[1]));
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.closePath();
        ctx.fillStyle = fills[idx % fills.length];
        ctx.fill();
        ctx.strokeStyle = strokes[idx % strokes.length];
        ctx.lineWidth = 2.2;
        ctx.stroke();
      });

      const dotCols = { Severe: '#dc2626', Moderate: '#eab308', Healthy: '#16a34a', Unknown: '#64748b' };
      pts.forEach(p => {
        const [x, y] = proj(p.lat, p.lng);
        ctx.beginPath(); ctx.arc(x, y, 6.2, 0, Math.PI * 2); ctx.fillStyle = '#ffffff'; ctx.fill();
        ctx.beginPath(); ctx.arc(x, y, 4.4, 0, Math.PI * 2); ctx.fillStyle = dotCols[p.sev] || '#64748b'; ctx.fill();
      });
    }

    /* Plants in the tapped plot, as the same cards Beranda uses (photo, condition, status, date), most urgent
       first. A card still opens that plant's map sheet, so the farmer stays on Peta. */
    function renderSelectedFarmCrops(farm) {
      const sheet = document.getElementById('farm-crops-sheet'), title = document.getElementById('farm-crops-title'), list = document.getElementById('farm-crops-list');
      if (!sheet || !list) return;
      title.textContent = farm.name;
      document.getElementById('farm-crops-count').hidden = true;
      stopNearbyMapPhotos();
      sheet.dataset.mode = 'plot';
      sheet.setAttribute('aria-label', 'Tanaman dalam petak');
      sheet.dataset.farmId = farm.id;
      const teaser = document.getElementById('farm-crops-summary');
      if (teaser && window.JagaPlotSummary) teaser.innerHTML = JagaPlotSummary.teaserHtml(farm);
      const groups = groupRecordsByCrop(farmRecords.filter(r => r.farmId === farm.id))
        .sort((a, b) => (attentionRank(a) - attentionRank(b)) || ((recordMs(b.latest) || 0) - (recordMs(a.latest) || 0)));
      if (!groups.length) {
        list.innerHTML = '<p class="t-body t-muted">Belum ada tanaman tercatat di petak ini.</p>';
      } else {
        list.innerHTML = groups.map(group => attentionItemHtml(group, 'data-farm-record="' + escapeText(group.latest.id) + '"')).join('');
        list.querySelectorAll('[data-farm-record]').forEach(card => card.addEventListener('click', () => {
          sheet.classList.add('hidden');
          openBottomSheet(card.dataset.farmRecord);
        }));
        icons();
      }
      sheet.classList.remove('hidden');
      updateMapSheetState();
    }

    function stopNearbyMapPhotos() {
      if (!nearbyMapPhotoObserver && !nearbyMapPhotos.size) return;
      nearbyMapPhotoObserver?.disconnect();
      nearbyMapPhotoObserver = null;
      nearbyMapPhotos.clear();
      refreshMapPinPhotos();
    }

    function openNearbyMapPlants(plants) {
      const sheet = document.getElementById('farm-crops-sheet');
      const list = document.getElementById('farm-crops-list');
      const byId = new Map(farmRecords.map(record => [record.id, record]));
      const paths = new Map(plants.map(plant => [plant.recordId, plant.thumbnailPath]));
      const records = plants.map(plant => byId.get(plant.recordId)).filter(Boolean);
      if (!records.length) return;
      closeBottomSheet();
      closeFarmPanel();
      stopNearbyMapPhotos();
      delete sheet.dataset.farmId;
      sheet.dataset.mode = 'nearby';
      sheet.setAttribute('aria-label', 'Pilih Tanaman');
      document.getElementById('farm-crops-title').textContent = 'Pilih Tanaman';
      const count = document.getElementById('farm-crops-count');
      count.textContent = records.length + ' tanaman berdekatan';
      count.hidden = false;
      list.replaceChildren();
      const photos = new Map();
      for (const record of records) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'btn btn-secondary map-nearby-plant';
        const thumb = document.createElement('span');
        thumb.className = 'map-nearby-photo';
        thumb.setAttribute('aria-hidden', 'true');
        const name = document.createElement('span');
        name.className = 'map-nearby-name';
        name.textContent = record.cropName || record.crop || 'Tanaman';
        thumb.textContent = name.textContent.charAt(0).toUpperCase();
        const path = paths.get(record.id);
        if (path) photos.set(thumb, path);
        const status = severityMeta(recSeverity(record));
        const badge = document.createElement('span');
        badge.className = status.badgeClass;
        badge.textContent = status.label;
        row.append(thumb, name, badge);
        row.addEventListener('click', () => openBottomSheet(record.id));
        list.append(row);
      }
      sheet.classList.remove('hidden');
      sheet.scrollTop = 0;
      updateMapSheetState();
      list.firstElementChild.focus({ preventScroll: true });
      if (photos.size && typeof IntersectionObserver !== 'undefined') {
        const observer = new IntersectionObserver(entries => {
          if (observer !== nearbyMapPhotoObserver) return;
          for (const entry of entries) {
            if (entry.isIntersecting) nearbyMapPhotos.set(entry.target, photos.get(entry.target));
            else nearbyMapPhotos.delete(entry.target);
          }
          refreshMapPinPhotos();
        }, { root: sheet, rootMargin: '48px 0px' });
        nearbyMapPhotoObserver = observer;
        for (const thumb of photos.keys()) observer.observe(thumb);
      }
    }

    function closeFarmCrops() {
      document.getElementById('farm-crops-sheet')?.classList.add('hidden');
      stopNearbyMapPhotos();
      updateMapSheetState();
    }
    function selectedSheetFarmId(){return document.getElementById('farm-crops-sheet')?.dataset.farmId || selectedFarmId;}
    function editSelectedFarm(){const id=selectedSheetFarmId();if(id)openFarmEdit(id);}
    function openSelectedFarmSummary(){const id=selectedSheetFarmId();if(id)JagaPlotSummary.open(id);}
    // An open plot sheet follows its plants too (a new photo, a corrected species, a deleted record).
    JagaHooks.on('history-shown', () => {
      const sheet = document.getElementById('farm-crops-sheet'), farm = farmList.find(f => f.id === sheet?.dataset.farmId);
      if (!sheet || sheet.classList.contains('hidden') || sheet.dataset.mode === 'nearby') return;
      if (farm) renderSelectedFarmCrops(farm); else closeFarmCrops();
    });
    function updateDashboardTelemetry() { updateDashboardTelemetryCore(); JagaHooks.run('telemetry-shown'); }
    function updateDashboardTelemetryCore() {
      const snapshotMoved = telemetrySnapshot && !nearbyFix(telemetrySnapshot,currentCoords.lat,currentCoords.lng);
      const home = snapshotMoved ? currentCoords : (telemetrySnapshot || currentCoords);
      const elev = home.elevation;
      const hasElev = typeof elev === 'number' && isFinite(elev);
      const elevEl = document.getElementById('home-elev-val');
      const liveMsl = document.getElementById('live-msl-stamp');
      const zoneLabel = document.getElementById('home-zone-label');

      if (elevEl) elevEl.innerText = hasElev ? String(Math.round(elev)) : '—';

      if (liveMsl) liveMsl.innerText = Number.isFinite(currentCoords.elevation) ? Math.round(currentCoords.elevation) + ' m dpl' : '— m dpl';
      if (zoneLabel) {
        if (!hasElev) zoneLabel.innerText = telemetryRequest?.pending ? 'Memuat zona…' : telemetrySnapshot ? 'Zona tidak tersedia' : 'Menunggu GPS';
        else if (elev < 400) zoneLabel.innerText = 'Zona Dataran Rendah';
        else if (elev <= 800) zoneLabel.innerText = 'Zona Dataran Menengah';
        else zoneLabel.innerText = 'Zona Dataran Tinggi';
      }
      const coordStatusEl = document.getElementById('home-coord-status');
      if (coordStatusEl) {
        coordStatusEl.innerText = validCoordinates(currentCoords.lat, currentCoords.lng)
          ? (gpsFailure ? 'Koordinat Terakhir' : 'Koordinat Terkunci')
          : (gpsFailure || 'Menunggu GPS');
      }

      const tempEl = document.getElementById('home-temp-val');
      const rhEl = document.getElementById('home-rh-val');
      const noteEl = document.getElementById('home-weather-note');
      if (tempEl) tempEl.innerText = (typeof home.tempC === 'number')
        ? Math.round(home.tempC) + '°C' : '—';
      if (rhEl) rhEl.innerText = (typeof home.rh === 'number')
        ? Math.round(home.rh) + '%' : '—';
      if (noteEl) {
        if (home.rh === null) {
          noteEl.textContent = telemetryRequest?.pending ? 'Memuat cuaca lokal…' : telemetrySnapshot ? 'Data cuaca tidak tersedia.' : 'Menunggu data cuaca lokal untuk peringatan kelembapan & jamur.';
        } else if (home.rh >= 75) {
          noteEl.innerHTML = '<strong>Lembap tinggi: Waspada Jamur &amp; Antraknosa.</strong> ' + escapeText(weatherNote(home.rh));
        } else {
          noteEl.textContent = weatherNote(home.rh);
        }
      }
      // No reading yet: show only the plain note, not "— · —".
      const weatherLine = document.getElementById('home-weather-line');
      weatherLine?.classList?.toggle('is-empty', typeof home.tempC !== 'number' && typeof home.rh !== 'number');

      updateAccuracyDot(currentCoords.accuracy);
      updateTopPageSub(currentMenuName);

      const liveCoordinates = document.getElementById('home-live-coordinates');
      if(liveCoordinates) liveCoordinates.textContent = validCoordinates(currentCoords.lat,currentCoords.lng) ? `Koordinat ${gpsFailure ? 'terakhir' : 'GPS (WGS84)'}: ${currentCoords.lat.toFixed(6)}, ${currentCoords.lng.toFixed(6)}` : (gpsFailure || 'Koordinat: menunggu GPS');
      const coordsStamp = document.getElementById('live-coords-stamp');
      if (coordsStamp) {
        coordsStamp.innerText = (typeof currentCoords.lat === 'number' && typeof currentCoords.lng === 'number')
          ? currentCoords.lat.toFixed(4) + '°, ' + currentCoords.lng.toFixed(4) + '°' : '— , —';
      }
      const weatherStamp = document.getElementById('live-weather-stamp');
      if (weatherStamp) weatherStamp.innerText = currentCoords.weather || '—';

      // One source of truth for every place-name surface: the home card, the
      // camera HUD and therefore the burned-in stamp.
      const movedNow = telemetrySnapshot && !nearbyFix(telemetrySnapshot,currentCoords.lat,currentCoords.lng);
      const coordinateLabel = validCoordinates(currentCoords.lat,currentCoords.lng) ? currentCoords.lat.toFixed(5)+', '+currentCoords.lng.toFixed(5) : (gpsFailure || 'Lokasi belum terbaca');
      const placeLabel = movedNow ? coordinateLabel : ((telemetrySnapshot || currentCoords).locationName ? (telemetrySnapshot || currentCoords).locationName : coordinateLabel);
      const homeLocEl = document.getElementById('home-location-text');
      const liveLocEl = document.getElementById('live-location-name');
      if (homeLocEl) homeLocEl.innerText = placeLabel;
      if (liveLocEl) liveLocEl.innerText = currentCoords.locationName || 'Lokasi berubah — menunggu pembaruan';
      const statusEl = document.getElementById('home-telemetry-status');
      if (statusEl) {
        if (gpsFailure && !validCoordinates(currentCoords.lat,currentCoords.lng)) statusEl.innerText = gpsFailure + '. Aktifkan izin lokasi lalu ketuk Perbarui. Foto galeri dapat diberi pin secara manual.';
        else if (telemetryRequest?.pending) statusEl.innerText = 'Memperbarui lokasi dan cuaca…';
        else if (telemetryError) statusEl.innerText = 'Data belum dapat diperbarui. Koordinat tetap tersedia; coba tombol perbarui.';
        else if (!telemetrySnapshot) statusEl.innerText = 'Menunggu data lokasi dan cuaca';
        else {
          const moved = !nearbyFix(telemetrySnapshot, currentCoords.lat, currentCoords.lng);
          const updated = new Date(telemetrySnapshot.updatedMs).toLocaleString();
          statusEl.innerText = moved ? 'Data terakhir ' + updated + ' • perangkat berpindah; diperbarui otomatis sebentar lagi' : 'Diperbarui ' + updated;
        }
      }

    }

    let watchId = null;
    let watchWanted = false;
    /* Audit H6/L: runs only while signed in and visible (no GPS on the login screen, no battery drain in a pocket). */
    function gpsFixTime(pos) {
      const stamp = Number(pos && pos.timestamp);
      return Number.isFinite(stamp) && stamp > 0 && stamp <= Date.now() + 1000 ? Math.min(stamp, Date.now()) : Date.now();
    }
    function stopLiveLocationWatcher(keepWanted) {
      if (!keepWanted) watchWanted = false;
      if (watchId !== null && 'geolocation' in navigator) { try { navigator.geolocation.clearWatch(watchId); } catch (_) { /* ignore */ } }
      watchId = null;
    }
    if (typeof document.addEventListener === 'function') document.addEventListener('visibilitychange', () => {
      if (document.hidden) { if (dailyRefreshTimer) { clearTimeout(dailyRefreshTimer); dailyRefreshTimer = null; } if (watchId !== null) stopLiveLocationWatcher(true); }
      else if (currentAccount) { renderDailyRecommendations(); scheduleDailyRefresh(); if (watchWanted && watchId === null) startLiveLocationWatcher(); }
    });
    function startLiveLocationWatcher() {
      watchWanted = true;
      if (watchId !== null || document.hidden) return;
      if (!('geolocation' in navigator)) {
        const tag = document.getElementById('home-accuracy-tag');
        setAccuracyDot(null, 'GPS tidak didukung');
        gpsFailure = 'GPS tidak didukung'; updateDashboardTelemetry();
        return;
      }
      try {
        watchId = navigator.geolocation.watchPosition(
          (pos) => applyLiveGpsReading(pos.coords.latitude, pos.coords.longitude,
                                     Math.round(pos.coords.accuracy), false, gpsFixTime(pos)),
          (err) => {
            // Report the failure honestly. This used to fake a plausible accuracy
            // reading, which made a photo with no fix look properly geotagged.
            console.warn('GPS unavailable:', err.message);
            const tag = document.getElementById('home-accuracy-tag');
            setAccuracyDot(null, err.code === 1 ? 'Izin lokasi ditolak' : 'GPS tidak tersedia');
            gpsFailure = err.code === 1 ? 'Izin lokasi ditolak' : 'GPS tidak tersedia'; updateDashboardTelemetry();
          },
          { enableHighAccuracy: true, maximumAge: 2000, timeout: 7000 }
        );
      } catch (error) {
        console.warn('GPS watch failed:', error);
        gpsFailure = 'GPS tidak tersedia'; updateDashboardTelemetry();
      }
    }

    let locationGeneration = 0;
    let telemetryRequest = null;
    let telemetrySample = null;
    let telemetrySnapshot = null;
    let telemetryError = false;
    let telemetryLastAttemptMs = null;
    let telemetryAttemptGeneration = null;
    const TELEMETRY_REFRESH_MS = 60 * 60 * 1000;
    const TELEMETRY_MOVED_REFRESH_MS = 60 * 1000;   // moved > 50 m from the last sample: refresh, at most once a minute
    function nearbyFix(first, lat, lng) {
      if (!first) return false;
      const radians = Math.PI / 180;
      const dy = (lat - first.lat) * radians;
      const dx = (lng - first.lng) * radians * Math.cos((lat + first.lat) * radians / 2);
      return Math.hypot(dx,dy) * 6371008.8 <= 50;
    }
    let pendingPlaceHint = '';
    let queuedPlaceSearch = null;
    function submitPlaceSearch() {
      const hint = document.getElementById('home-place-search')?.value.trim();
      if (!hint || !currentAccount) return;
      if (!validCoordinates(currentCoords.lat,currentCoords.lng)) { showToast('Aktifkan GPS sebelum mencari nama tempat di sekitar lokasi.'); return; }
      if (telemetryRequest?.pending) {
        queuedPlaceSearch = {hint,lat:currentCoords.lat,lng:currentCoords.lng,generation:accountGeneration,owner:String(currentAccount.id)};
        return;
      }
      pendingPlaceHint = hint;
      applyLiveGpsReading(currentCoords.lat,currentCoords.lng,currentCoords.accuracy,true);
    }
    function applyLiveGpsReading(lat, lng, accuracyMeters, forceTelemetry = false, fixMs) {
      if (!currentAccount || !validCoordinates(lat,lng)) return;
      gpsFailure = '';
      const generation = accountGeneration;
      // The time of the reading (audit H6): a capture more than a minute later does not reuse it as the photo's position.
      if (Number.isFinite(fixMs)) currentCoords.fixMs = fixMs;
      currentCoords.lat = lat;
      currentCoords.lng = lng;
      currentCoords.accuracy = typeof accuracyMeters === 'number' ? accuracyMeters : null;
      if (queuedPlaceSearch && !nearbyFix(queuedPlaceSearch,lat,lng)) queuedPlaceSearch = null;
      const reuse = telemetrySample?.generation === generation && nearbyFix(telemetrySample,lat,lng);
      if (!reuse) {
        currentCoords.elevation = null;
        currentCoords.locationName = null;
        currentCoords.weather = null;
        currentCoords.tempC = null;
        currentCoords.rh = null;
      }

      // Recentre the map on the first real fix only, so it does not yank the
      // view around while the farmer is looking at it.
      if (mapInstance && !mapCenteredOnFix) {
        mapInstance.setView([lat, lng], 15);
        mapCenteredOnFix = true;
      }
      updateDashboardTelemetry();
      if (typeof updateScanLocationChip === 'function') updateScanLocationChip();   // S1: the chip follows every fix

      const now = Date.now();
      if (telemetryAttemptGeneration !== generation) {
        telemetryAttemptGeneration = generation;
        telemetryLastAttemptMs = null;
      }
      const refreshAfter = reuse ? TELEMETRY_REFRESH_MS : TELEMETRY_MOVED_REFRESH_MS;
      if (!forceTelemetry && telemetryLastAttemptMs !== null && now - telemetryLastAttemptMs < refreshAfter) return;
      if (telemetryRequest?.pending) return;
      const fix = ++locationGeneration;
      const request = telemetryRequest = {lat,lng,generation,startedMs:now,pending:true};
      telemetryError = false;
      updateDashboardTelemetry();
      // Count attempts, not only successful responses: continuous watch ticks
      // must not turn a failed upstream request into a retry storm.
      telemetryLastAttemptMs = now;
      const placeHint = pendingPlaceHint; pendingPlaceHint='';
      api('/api/telemetry?lat=' + lat + '&lng=' + lng + (placeHint ? '&placeHint=' + encodeURIComponent(placeHint) : ''))
        .then((data) => {
          if (!data || fix !== locationGeneration || generation !== accountGeneration) return;
          if (!nearbyFix(request,currentCoords.lat,currentCoords.lng)) return;
          telemetrySample = {lat,lng,generation,receivedMs:Date.now()};
          const elev = Array.isArray(data.elevation) ? data.elevation[0] : data.elevation;
          const fresh = {
            lat, lng, accuracy: currentCoords.accuracy, updatedMs: Date.now(),
            elevation: Number.isFinite(elev) ? Math.round(elev) : null,
            locationName: data.locationName || null,
            tempC: typeof data.tempC === 'number' ? data.tempC : null,
            rh: typeof data.rh === 'number' ? data.rh : null,
            weather: data.weather || null,
            locationProvider: data.locationProvider || null,
            locationApproximate: data.locationApproximate === true
          };
          currentCoords.elevation = fresh.elevation;
          currentCoords.locationName = fresh.locationName;
          currentCoords.tempC = fresh.tempC;
          currentCoords.rh = fresh.rh;
          currentCoords.weather = fresh.weather;
          telemetrySnapshot = fresh;
          updateDashboardTelemetry();
          const input = document.getElementById('home-place-search');
          if(data.locationName && placeHint && input?.value.trim() === placeHint) input.value='';
        })
        .catch(() => { if (generation === accountGeneration && fix === locationGeneration) telemetryError = true; })
        .finally(() => {
          request.pending = false;
          if (generation !== accountGeneration || fix !== locationGeneration) return;
          updateDashboardTelemetry();
          const next = queuedPlaceSearch;
          queuedPlaceSearch = null;
          if (next && next.generation === accountGeneration && next.owner === String(currentAccount?.id) && nearbyFix(next,currentCoords.lat,currentCoords.lng)) {
            pendingPlaceHint = next.hint;
            applyLiveGpsReading(currentCoords.lat,currentCoords.lng,currentCoords.accuracy,true);
          }
        });
    }

    function requestLiveLocation(isManualClick = false) {
      const generation = accountGeneration;
      const icon = document.getElementById('btn-refresh-icon');
      if (icon) {
        icon.classList.add('animate-spin');
        setTimeout(() => icon.classList.remove('animate-spin'), 1000);
      }

      if (!("geolocation" in navigator)) {
        gpsFailure = 'GPS tidak didukung'; updateDashboardTelemetry();
        if (isManualClick) showToast("GPS tidak didukung perangkat.");
        return;
      }

      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          if (generation !== accountGeneration || !currentAccount) return;
          applyLiveGpsReading(pos.coords.latitude, pos.coords.longitude, Math.round(pos.coords.accuracy), isManualClick, gpsFixTime(pos));
          if (isManualClick) {
            showToast('Lokasi GPS diperbarui.');
          }
        },
        (err) => {
          if (generation !== accountGeneration || !currentAccount) return;
          // No fabrication: say what happened instead of inventing a position.
          const tag = document.getElementById('home-accuracy-tag');
          setAccuracyDot(null, err.code === 1 ? 'Izin lokasi ditolak' : 'GPS tidak tersedia');
          gpsFailure = err.code === 1 ? 'Izin lokasi ditolak' : 'GPS tidak tersedia'; updateDashboardTelemetry();
          if (!isManualClick) return;
          showToast(err.code === 1
            ? 'Izin lokasi ditolak. Aktifkan izin lokasi untuk situs ini di pengaturan browser.'
            : 'Lokasi belum tersedia. Coba lagi di tempat terbuka.');
        },
        { enableHighAccuracy: true, timeout: 8000 }
      );
    }


    let toastTimer = null;
    function showToast(message) {
      const toast = document.getElementById('toast-notification');
      if (!toast) return;
      toast.textContent = String(message === null || message === undefined ? '' : message);
      toast.style.top = '';
      toast.style.bottom = '';
      toast.classList.remove('hidden');
      // The CSS places the toast below the map toolbar while a sheet is open. A tall sheet (long advice text)
      // can still reach that band: then the toast goes right under the header, over the map tools, never over the sheet.
      const sheet = ['map-bottom-sheet', 'farm-sheet', 'farm-crops-sheet', 'draw-bar'].map(id => document.getElementById(id))
        .find(el => el && !el.hidden && !el.classList.contains('hidden') && el.getClientRects().length &&
          (el.id !== 'map-bottom-sheet' || el.classList.contains('translate-y-0')) && !el.closest('.menu-view.hidden'));
      if (sheet && toast.getBoundingClientRect().bottom > sheet.getBoundingClientRect().top - 4) {
        const header = document.querySelector('#app-shell > header');
        toast.style.top = Math.round((header ? header.getBoundingClientRect().bottom : 0) + 8) + 'px';
        toast.style.bottom = 'auto';
      }
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toast.classList.add('hidden'); }, 3500);
    }

    // ---------- Confirm dialog (replaces native confirm()) ----------
    let _confirmResolver = null;
    let activeDialog = null;
    const dialogStack = [];
    const dialogInert = new Map();
    const dialogNames = {'modal-account':'Akun saya','modal-crop-assign':'Pilih tanaman',
      'modal-daily':'Catatan harian','modal-status':'Ubah status pengamatan',
      'modal-date-picker':'Waktu pengambilan foto','modal-farm':'Simpan petak',
      'modal-confirm':'Konfirmasi','photo-viewer':'Foto pengamatan',
      'modal-reanalysis-progress':'Analisis ulang'};
    function dialogFocusable(modal) {
      const selector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])';
      return [...modal.querySelectorAll(selector)].filter(node => {
        if (node.matches(':disabled') || !node.getClientRects().length || node.closest('[inert]') || getComputedStyle(node).visibility !== 'visible') return false;
        // Layout boxes can exist inside a closed details element. Only its summary is navigable.
        for (let parent = node.parentElement; parent && parent !== modal; parent = parent.parentElement) {
          if (parent.tagName === 'DETAILS' && !parent.open) {
            const summary = parent.querySelector(':scope > summary');
            if (!summary || !summary.contains(node)) return false;
          }
        }
        return true;
      });
    }
    function syncDialogInert() {
      dialogInert.forEach((value,node) => { node.inert = value; });
      dialogInert.clear();
      if (!activeDialog) return;
      let branch = activeDialog;
      while (branch.parentElement && branch !== document.body) {
        for (const sibling of branch.parentElement.children) {
          if (sibling === branch) continue;
          dialogInert.set(sibling, sibling.inert);
          sibling.inert = true;
        }
        branch = branch.parentElement;
      }
    }
    // The location editor is built by workflow-ui.js. Plain-language copy and the coordinate fields
    // behind a disclosure are applied here, once, without depending on that file's markup string.
    function setDialogOpen(id, trigger) {
      const modal = document.getElementById(id);
      if (!modal) return;
      if (!dialogStack.some(entry => entry.modal === modal)) {
        dialogStack.push({modal, trigger:trigger || document.activeElement});
      }
      activeDialog = modal;
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('aria-label', dialogNames[id] || 'Dialog');
      modal.classList.remove('hidden');
      syncDialogInert();
      const focusable = dialogFocusable(modal)[0];
      if (focusable) focusable.focus(); else modal.setAttribute('tabindex', '-1'), modal.focus();
    }
    function closeDialog(id, callback) {
      const modal = document.getElementById(id);
      if (modal) modal.classList.add('hidden');
      const index = dialogStack.findIndex(entry => entry.modal === modal);
      const entry = index >= 0 ? dialogStack.splice(index, 1)[0] : null;
      activeDialog = dialogStack.at(-1)?.modal || null;
      syncDialogInert();
      const restore = entry?.trigger;
      if (restore?.isConnected && !restore.closest('[inert]') && restore.getClientRects().length) restore.focus();
      if (callback) callback();
    }
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !activeDialog && editingFarmId) {
        event.preventDefault();
        cancelFarmDraw();
        return;
      }
      if (!activeDialog || activeDialog.classList.contains('hidden')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeDialogById(activeDialog.id);
        return;
      }
      if (event.key === 'Tab') {
        const nodes = dialogFocusable(activeDialog);
        if (!nodes.length) { event.preventDefault(); activeDialog.focus(); return; }
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (!nodes.includes(document.activeElement)) { event.preventDefault(); first.focus(); }
        else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });


    function closeDialogById(id) {
      if (id === 'feature-tour') window.JagaTour?.dismiss();
      else if (id === 'modal-confirm') resolveConfirm(false);
      else if (id === 'modal-account') closeAccountModal();
      else if (id === 'modal-crop-assign') closeCropAssignModal();
      else if (id === 'modal-daily') closeDailyModal();
      else if (id === 'modal-status') closeStatusModal();
      else if (id === 'modal-record-edit') closeRecordEdit();
      else if (id === 'modal-plot-summary') JagaPlotSummary.close();
      else if (id === 'modal-date-picker') closeDatePickerModal();
      else if (id === 'modal-farm') closeFarmModal();
      else if (id === 'photo-viewer') closePhotoViewer();
      else closeDialog(id);
    }

    function confirmAction({ title, message, okLabel = 'Hapus', danger = true }) {
      const titleEl = document.getElementById('confirm-title');
      const msgEl = document.getElementById('confirm-message');
      const okBtn = document.getElementById('confirm-ok-btn');
      if (titleEl) titleEl.innerText = title || 'Konfirmasi';
      if (msgEl) msgEl.innerText = message || '';
      if (okBtn) { okBtn.innerText = okLabel; okBtn.className = 'btn ' + (danger ? 'btn-danger-solid' : 'btn-primary'); }
      setDialogOpen('modal-confirm');
      return new Promise(resolve => { _confirmResolver = resolve; });
    }

    function resolveConfirm(result) {
      closeDialog('modal-confirm');
      if (_confirmResolver) {
        const resolve = _confirmResolver;
        _confirmResolver = null;
        resolve(result);
      }
    }

    window.scrollHomePane = scrollHomePane;
    window.addEventListener('resize', updateHomeScrollCues, { passive: true });
    /* Small public surface for the other scripts (shell.js back button, tests). */
    window.JagaUx = {
      openTreeTimeline, closeTreeTimeline, openLogWithFilter,
      // True when something inside the field screens was closed (an open tree timeline); shell.js asks this
      // before it falls back to "go to Beranda".
      handleBack() {
        if (currentMenuName === 'log' && expandedCropId) { closeTreeTimeline(); return true; }
        return false;
      },
    };
