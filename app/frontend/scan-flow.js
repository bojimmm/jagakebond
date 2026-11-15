/* Scan flow: camera -> photo review -> upload -> result -> tree assignment (UX brief S1-S7, audit H6/M2/M7/M15).

   One state machine drives the Kamera tab:  live -> review -> sending -> sent -> result   (failed from sending/sent)
   `data-scan-state` on #view-scan selects the layout, the `hidden` class on the six blocks selects what is shown.
   The farmer never has to wait on this screen: once the photo is saved on the phone and accepted by the server the
   screen offers "Ambil foto berikutnya"; the result is picked up in the background (see shell.js / workflow-ui.js).

   State variables (selectedImageBase64, selectedPhotoMetadata, activeJobId, ...) are declared in app.js. */

const CAPTURE_ASPECT = 3 / 4;        // must match #scan-frame's 3:4 ratio
const CAPTURE_MAX_PX = 1600;         // the server stores 1600 and shows the model 1024
const CAPTURE_QUALITY = 0.85;
const ORIGINAL_MAX_PX = 2560;        // private original copy (export / stamping), never more than this
const GPS_MAX_AGE_MS = 60000;        // audit H6: an older fix is never stamped as the photo's position
const GPS_MAX_ACCURACY_M = 200;      // worse than this is "not accurate", the farmer is asked to place the photo
const GPS_WEAK_ACCURACY_M = 100;
const POLL_FIRST_MS = 4000;
const POLL_EVERY_MS = 8000;
const POLL_MAX_ATTEMPTS = 120;       // ~16 minutes in the foreground; the background poller continues afterwards
const POLL_MAX_OFFLINE = 300;
const LOW_CONFIDENCE_THRESHOLD = 0.5;
const CROP_MATCH_RADIUS_M = 25;
const SCAN_BLOCKS = { live: 'shutter-live-controls', preparing:'photo-preparing', review: 'photo-review-controls', sending: 'analysis-progress',
  sent: 'analysis-sent', failed: 'analysis-failed', result: 'stamped-result-actions' };

let scanState = 'live';
let scanSession = 0;                 // bumped when the farmer cancels or moves on: stale async work checks it
let scanBusy = false;
let lastResultRecord = null;
let lastFailedCapture = null;        // { clientRequestId, jobId } of the capture whose failure card is on screen
let foregroundJobId = null;          // the job the foreground tracker is watching (the background poller skips it)
let cameraEndedRestarts = [];
let cameraHardwareZoom = false;
let scanChipTimer = null;
let assignChoice = null;

const scanEl = id => document.getElementById(id);

/* ------------------------------------------------------------------ helpers */
function friendlyTime(ms) {
  if (!Number.isFinite(ms)) return '';
  const date = new Date(ms), now = new Date(), yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const time = date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }).replace(':', '.');
  if (date.toDateString() === now.toDateString()) return 'Hari ini ' + time;
  if (date.toDateString() === yesterday.toDateString()) return 'Kemarin ' + time;
  return date.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }) + ' ' + time;
}
function dataUrlToBlob(dataUrl) {
  const comma = String(dataUrl).indexOf(',');
  if (comma < 0) throw new Error('Foto tidak valid.');
  const mime = dataUrl.slice(5, comma).split(';')[0] || 'image/jpeg';
  const raw = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
function severityBadge(severity) {
  if (severity === 'Severe') return { label: 'Kritis', cls: 'badge-severe' };
  if (severity === 'Moderate') return { label: 'Waspada', cls: 'badge-moderate' };
  if (severity === 'Healthy') return { label: 'Sehat', cls: 'badge-healthy' };
  return { label: 'Belum dinilai', cls: 'badge-unknown' };
}
function scanVisible() { const view = scanEl('view-scan'); return !!view && !view.classList.contains('hidden'); }
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Foto tidak dapat dibaca.'));
    reader.readAsDataURL(blob);
  });
}

/* ------------------------------------------------------------------ GPS freshness and the location chip (S1) */
function currentGpsStatus() {
  const { lat, lng, accuracy, fixMs } = currentCoords;
  if (!validCoordinates(lat, lng)) return { state: 'none' };
  if (!Number.isFinite(fixMs) || Date.now() - fixMs > GPS_MAX_AGE_MS) return { state: 'stale', ageMs: Number.isFinite(fixMs) ? Date.now() - fixMs : null };
  if (!Number.isFinite(accuracy) || accuracy > GPS_MAX_ACCURACY_M) return { state: 'inaccurate', accuracy };
  if (accuracy > GPS_WEAK_ACCURACY_M) return { state: 'weak', accuracy };
  return { state: 'fresh', accuracy };
}
function placeShort(name) { return String(name || '').split(',')[0].trim(); }
function liveLocationModel() {
  const gps = currentGpsStatus();
  const place = placeShort(currentCoords.locationName);
  if (gps.state === 'fresh') return { tone: 'ok', text: 'Lokasi: ' + (place ? place + ' ' : '') + '±' + Math.round(gps.accuracy) + ' m' };
  if (gps.state === 'weak') return { tone: 'warn', text: 'Lokasi kurang akurat ±' + Math.round(gps.accuracy) + ' m' };
  if (gps.state === 'inaccurate') return { tone: 'none', text: 'Lokasi belum akurat' };
  return { tone: 'none', text: 'Lokasi belum terbaca' };
}
function photoLocationModel(meta) {
  if (!meta) return liveLocationModel();
  const hasPoint = validCoordinates(meta.lat, meta.lng);
  if (hasPoint) {
    const place = placeShort(meta.locationName);
    const acc = Number.isFinite(meta.accuracy) ? ' ±' + Math.round(meta.accuracy) + ' m' : '';
    return { tone: Number.isFinite(meta.accuracy) && meta.accuracy > GPS_WEAK_ACCURACY_M ? 'warn' : 'ok', text: 'Lokasi: ' + (place ? place : 'tercatat') + acc };
  }
  return { tone: 'none', text: 'Lokasi belum terbaca' };
}
function updateScanLocationChip() {
  const chip = scanEl('scan-location-chip'), text = scanEl('scan-location-text');
  if (!chip || !text) return;
  const model = scanState === 'live' || !selectedImageBase64 ? liveLocationModel() : photoLocationModel(selectedPhotoMetadata);
  chip.dataset.tone = model.tone;
  text.textContent = model.text;
  const warning = scanEl('scan-location-warning');
  if (warning) warning.classList.toggle('hidden', !(scanState === 'review' && model.tone === 'none'));
}

/* ------------------------------------------------------------------ state machine */
function setScanState(state, info = {}) {
  scanState = state;
  const view = scanEl('view-scan');
  if (view) view.dataset.scanState = state;
  Object.entries(SCAN_BLOCKS).forEach(([key, id]) => { const node = scanEl(id); if (node) node.classList.toggle('hidden', key !== state); });
  renderScanHead(state, info);
  updateScanLocationChip();
  document.body.classList.toggle('scan-actionbar', state !== 'live' && scanVisible());
  layoutScanFrame();
  requestAnimationFrame(layoutScanFrame);
  // A new photo under review must always be sendable: the previous send left the buttons disabled while it ran.
  if (state === 'review') setAnalyzeButtonsDisabled(scanBusy);
}
function renderScanHead(state, info) {
  const head = scanEl('scan-status-head');
  const title = scanEl('photo-review-label');
  const text = scanEl('scan-status-text');
  const links = scanEl('scan-info-links');
  const date = scanEl('scan-photo-date');
  const offline = scanEl('scan-offline-note');
  if (head) head.classList.toggle('hidden', state === 'live');
  if (links) links.classList.toggle('hidden', state !== 'review');
  if (offline) offline.classList.toggle('hidden', !(state === 'review' && (!navigator.onLine || (typeof offlineMode !== 'undefined' && offlineMode))));
  if (date) {
    const when = selectedPhotoMetadata && Number.isFinite(selectedPhotoMetadata.captureTimeMs) ? friendlyTime(selectedPhotoMetadata.captureTimeMs) : '';
    date.classList.toggle('hidden', state === 'live' || !when);
    date.textContent = when ? 'Diambil ' + when : '';
    const setDate = scanEl('scan-set-date');
    if (setDate) setDate.classList.toggle('hidden', !(state === 'review' && photoMode === 'gallery'));
  }
  // The sent/failed cards carry their own title; the head then only shows when and where the photo was taken.
  const titles = { preparing:'Menyiapkan Foto…', review: 'Foto Siap Dianalisis', sending: 'Mengirim foto…', result: 'Hasil analisis' };
  if (title) { title.textContent = titles[state] || ''; title.classList.toggle('hidden', !titles[state]); }
  const hasPoint = selectedPhotoMetadata && validCoordinates(selectedPhotoMetadata.lat, selectedPhotoMetadata.lng);
  const reviewSub = (photoMode === 'gallery' && !hasPoint) ? 'Foto dari galeri' : 'Foto siap dikirim untuk analisis';
  if (text) text.textContent = info.headText || (state === 'review' ? reviewSub : '');
}
function resetScanControls() {
  setScanState(selectedImageBase64 ? 'review' : 'live');
  setAnalyzeButtonsDisabled(false);
}
function setProgress(percent, text) {
  const bar = scanEl('progress-bar-fill');
  const clamped = Math.max(4, Math.min(97, percent));
  if (bar) { bar.style.transform = 'scaleX(' + clamped / 100 + ')'; const holder = bar.parentElement; if (holder) holder.setAttribute('aria-valuenow', String(Math.round(clamped))); }
  const label = scanEl('progress-step-text');
  if (label) label.innerText = text;
}
function setAnalyzeButtonsDisabled(disabled) {
  ['btn-run-analysis'].forEach(id => { const node = scanEl(id); if (node) node.disabled = disabled; });
  if (!disabled) renderFastQuota();
}
function layoutScanFrame() {
  const stage = scanEl('scan-stage'), frame = scanEl('scan-frame');
  if (!stage || !frame) return;
  const rect = stage.getBoundingClientRect();
  const availW = Math.max(rect.width || stage.clientWidth || 0, 0);
  const availH = Math.max(rect.height || stage.clientHeight || 0, 0);
  if (!availW || !availH) return;
  let w = availW;
  let h = (w * 4) / 3;
  if (h > availH) { h = availH; w = (h * 3) / 4; }
  frame.style.width = `${Math.floor(w)}px`;
  frame.style.height = `${Math.floor(h)}px`;
}

/* ------------------------------------------------------------------ camera (S1, M2, L2) */
async function requestCameraStream() {
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    const error = new Error('Kamera tidak didukung di sini.');
    error.name = 'NotSupportedError';
    throw error;
  }
  const base = { facingMode: cameraFacing };
  try {
    // Ask for a full-size 4:3 frame (audit M2); the viewfinder crops it to the 3:4 portrait framing.
    return await navigator.mediaDevices.getUserMedia({ video: { ...base, width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false });
  } catch (error) {
    if (error && (error.name === 'NotAllowedError' || error.name === 'SecurityError' || error.name === 'NotFoundError')) throw error;
    return navigator.mediaDevices.getUserMedia({ video: base, audio: false });
  }
}
function updateCameraZoomUi() {
  const z = typeof cameraZoom === 'number' && cameraZoom === 2 ? 2 : 1;
  const btn = scanEl('btn-cam-zoom');
  if (btn) {
    btn.textContent = z === 2 ? '2×' : '1×';
    btn.classList.toggle('is-active', z === 2);
    btn.setAttribute('aria-pressed', String(z === 2));
  }
  const videoEl = scanEl('camera-stream');
  if (videoEl) videoEl.classList.toggle('is-zoom-2x', z === 2 && !cameraHardwareZoom);
}
async function applyCameraZoom(track) {
  const z = typeof cameraZoom === 'number' && cameraZoom === 2 ? 2 : 1;
  cameraHardwareZoom = false;
  if (track && typeof track.getCapabilities === 'function' && typeof track.applyConstraints === 'function') {
    try {
      const caps = track.getCapabilities();
      if (caps && caps.zoom && Number(caps.zoom.max) >= 2 && Number(caps.zoom.min || 1) <= 2) {
        const target = z === 2 ? 2 : Math.max(Number(caps.zoom.min || 1), 1);
        await track.applyConstraints({ advanced: [{ zoom: target }] });
        cameraHardwareZoom = true;
      }
    } catch (_) { cameraHardwareZoom = false; }
  }
  updateCameraZoomUi();
}
async function toggleCameraZoom() {
  const next = typeof cameraZoom === 'number' && cameraZoom === 2 ? 1 : 2;
  if (typeof cameraZoom !== 'undefined') cameraZoom = next;
  const track = liveMediaStream?.getVideoTracks?.()[0] || null;
  await applyCameraZoom(track);
}
async function startLiveCameraStream() {
  const videoEl = scanEl('camera-stream');
  if (!videoEl || selectedImageBase64) return;
  videoEl.classList.add('hidden');
  videoEl.pause();
  stopLiveCameraStream();
  const generation = ++cameraRequestGeneration;
  const loading = scanEl('camera-loading');
  if (loading) loading.textContent = 'Menyiapkan kamera…';
  try {
    const stream = await requestCameraStream();
    if (generation !== cameraRequestGeneration || !videoEl.isConnected) { stream.getTracks().forEach(track => track.stop()); return; }
    liveMediaStream = stream;
    videoEl.srcObject = stream;
    await applyCameraZoom(stream.getVideoTracks()[0]);
    if (generation !== cameraRequestGeneration || !videoEl.isConnected) return;
    videoEl.onplaying = () => { if (generation === cameraRequestGeneration && videoEl.readyState >= 2) { videoEl.classList.remove('hidden'); scanEl('camera-loading')?.classList.add('hidden'); } };
    // A track ends when another app takes the camera or the phone sleeps: bring it back (at most 3 times a minute).
    stream.getVideoTracks().forEach(track => track.addEventListener('ended', () => {
      if (generation !== cameraRequestGeneration || !currentAccount || selectedImageBase64 || !scanVisible()) return;
      const now = Date.now();
      cameraEndedRestarts = cameraEndedRestarts.filter(at => now - at < 60000);
      if (cameraEndedRestarts.length >= 3) { if (loading) { loading.classList.remove('hidden'); loading.textContent = 'Kamera terhenti. Ketuk Putar atau buka lagi tab Kamera.'; } return; }
      cameraEndedRestarts.push(now);
      setTimeout(() => { if (scanVisible() && !selectedImageBase64 && currentAccount) startLiveCameraStream(); }, 400);
    }));
    await videoEl.play();
  } catch (err) {
    if (generation === cameraRequestGeneration && loading) {
      loading.classList.remove('hidden');
      loading.textContent = err.name === 'NotAllowedError' ? 'Akses kamera ditolak. Aktifkan izin kamera atau pilih foto dari galeri.'
        : err.name === 'NotSupportedError' ? 'Kamera tidak didukung di sini. Pilih foto dari galeri.'
        : 'Kamera belum tersedia. Coba lagi atau pilih foto dari galeri.';
    }
  }
}
function stopLiveCameraStream() {
  cameraRequestGeneration += 1;
  const videoEl = scanEl('camera-stream');
  if (videoEl) { videoEl.classList.add('hidden'); videoEl.pause(); videoEl.srcObject = null; videoEl.onplaying = null; scanEl('camera-loading')?.classList.toggle('hidden', !!selectedImageBase64); }
  if (liveMediaStream) {
    liveMediaStream.getTracks().forEach(t => t.stop());
    liveMediaStream = null;
  }
}
function toggleCameraFacing() {
  cameraFacing = cameraFacing === 'environment' ? 'user' : 'environment';
  startLiveCameraStream();
  showToast(`Kamera diganti ke ${cameraFacing === 'environment' ? 'belakang' : 'depan'}`);
}
document.addEventListener('visibilitychange', () => {
  if (!currentAccount) return;
  if (document.hidden) { if (liveMediaStream) stopLiveCameraStream(); }
  else if (scanVisible() && scanState === 'live' && !selectedImageBase64 && photoMode === 'live' && !liveMediaStream) startLiveCameraStream();
});

/* ------------------------------------------------------------------ capture: crop + compress */
/* The viewfinder is a 3:4 frame showing the camera feed `object-cover`, so the farmer composes ONE crop of the sensor.
   Crop to that frame, then shrink to what the server uses (1600 px stored, 1024 px shown to the model). */
function renderCapture(source, sourceW, sourceH, zoomFactor = 1) {
  let cropW = sourceW;
  let cropH = Math.round(sourceW / CAPTURE_ASPECT);
  if (cropH > sourceH) { cropH = sourceH; cropW = Math.round(sourceH * CAPTURE_ASPECT); }
  if (Number.isFinite(zoomFactor) && zoomFactor > 1) {
    cropW = Math.max(1, Math.round(cropW / zoomFactor));
    cropH = Math.max(1, Math.round(cropH / zoomFactor));
  }
  const cropX = Math.round((sourceW - cropW) / 2);
  const cropY = Math.round((sourceH - cropH) / 2);
  const scale = Math.min(1, CAPTURE_MAX_PX / Math.max(cropW, cropH));
  const outW = Math.max(1, Math.round(cropW * scale));
  const outH = Math.max(1, Math.round(cropH * scale));
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, cropX, cropY, cropW, cropH, 0, 0, outW, outH);
  return canvas.toDataURL('image/jpeg', CAPTURE_QUALITY);
}
/* Full-frame private copy, capped so a 12 MP gallery photo does not become a 50 MB canvas (audit M7). */
function renderOriginal(source, sourceW, sourceH) {
  const scale = Math.min(1, ORIGINAL_MAX_PX / Math.max(sourceW, sourceH));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sourceW * scale));
  canvas.height = Math.max(1, Math.round(sourceH * scale));
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.9);
}
function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Gambar tidak dapat dibaca'));
    image.src = src;
  });
}
async function decodeGalleryImage(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close() { if (bitmap.close) bitmap.close(); } };
    } catch (_) { /* older engines: fall back to an <img> below */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImageElement(url);
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, close() { URL.revokeObjectURL(url); } };
  } catch (error) { URL.revokeObjectURL(url); throw error; }
}
function formatPhotoDate(date, provenance) {
  const formatted = new Intl.DateTimeFormat('id-ID', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }).format(date);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'zona perangkat tidak diketahui';
  return `${formatted} (${provenance}; ${zone})`;
}
function showReviewPhoto() {
  const videoEl = scanEl('camera-stream'), imgEl = scanEl('scanned-image');
  if (videoEl) videoEl.classList.add('hidden');
  if (imgEl) { imgEl.src = selectedImageBase64; imgEl.classList.remove('hidden'); }
  scanEl('camera-loading')?.classList.add('hidden');
  const badge = scanEl('stamp-source-badge');
  const hasPoint = selectedPhotoMetadata && validCoordinates(selectedPhotoMetadata.lat, selectedPhotoMetadata.lng);
  if (badge) badge.innerText = (photoMode === 'live' || hasPoint) ? 'Foto Baru' : 'Foto Galeri';
}
async function handleImageSelected(event) {
  const input = event.target;
  const file = input.files && input.files[0];
  if (!file) return;
  // Reject before reading: an empty or oversized file wastes the farmer's data allowance and would be refused anyway.
  if (!file.type || !file.type.startsWith('image/')) { showToast('Berkas harus berupa gambar.'); input.value = ''; return; }
  if (file.size === 0) { showToast('Berkas foto kosong.'); input.value = ''; return; }
  if (file.size > MAX_UPLOAD_BYTES) { showToast('Foto melebihi 12 MB. Pilih foto yang lebih kecil.'); input.value = ''; return; }
  if (!currentAccount) return;
  const owner = String(currentAccount.id), generation = accountGeneration, selection = ++scanSession;
  const selectionCurrent = () => String(currentAccount?.id||'') === owner && generation === accountGeneration && selection === scanSession && photoMode === 'gallery';
  activeOfflineCapture = null;
  scanBusy = false;
  selectedImageBase64 = null; capturePhotoSnapshot = null; fullCapturePhoto = null;
  selectedPhotoMetadata = null; selectedPhotoDateString = null; selectedPhotoTimestampMs = null;
  photoMode = 'gallery';
  stopLiveCameraStream();
  scanEl('scanned-image')?.classList.add('hidden');
  scanEl('camera-loading')?.classList.add('hidden');
  setScanState('preparing');
  let decoded, original, inferenceImage;
  try {
    decoded = await decodeGalleryImage(file);
    if (!selectionCurrent()) return;
    if (!decoded.width || !decoded.height) throw new Error('Foto tidak dapat dibaca.');
    original = renderOriginal(decoded.source, decoded.width, decoded.height);
    inferenceImage = renderCapture(decoded.source, decoded.width, decoded.height);
    if (!inferenceImage || inferenceImage === 'data:,') throw new Error('Foto tidak dapat dibaca.');
  } catch (error) {
    if (!selectionCurrent()) return;
    selectedImageBase64 = null; capturePhotoSnapshot = null; fullCapturePhoto = null;
    showToast('Foto tidak dapat dibaca.');
    input.value = '';
    resetToLiveCamera();
    return;
  } finally { if (decoded) decoded.close(); }

  let detectedDate = null;
  let detectedGps = null;
  try { // EXIF DateTimeOriginal and GPS, when the file has them
    await JagaFeatures.load('photoMetadata');
    if (typeof exifr !== 'undefined') {
      const exif = await exifr.parse(file, { tiff: true, exif: true, gps: true });
      if (exif) {
        const rawDate = exif.DateTimeOriginal || exif.CreateDate || exif.ModifyDate;
        if (rawDate instanceof Date && !isNaN(rawDate)) detectedDate = rawDate;
        if (Number.isFinite(exif.latitude) && Number.isFinite(exif.longitude)) {
          detectedGps = { lat: exif.latitude, lng: exif.longitude, altitude: Number.isFinite(exif.altitude) ? exif.altitude : null,
            accuracy: Number.isFinite(exif.GPSHPositioningError) ? exif.GPSHPositioningError : null };
        }
      }
    }
  } catch (exifErr) { console.warn('EXIF reading skipped or not present:', exifErr); }
  if (!selectionCurrent()) return;
  fullCapturePhoto = original;
  selectedImageBase64 = inferenceImage;
  capturePhotoSnapshot = inferenceImage;

  if (detectedDate) {
    selectedPhotoDateString = formatPhotoDate(detectedDate, 'EXIF; zona waktu tidak diketahui');
    selectedPhotoTimestampMs = detectedDate.getTime();
  } else {
    const captureNow = new Date();
    selectedPhotoDateString = formatPhotoDate(captureNow, 'waktu unggah perangkat');
    selectedPhotoTimestampMs = captureNow.getTime();
  }
  selectedPhotoMetadata = Object.freeze({ source: detectedGps ? 'gallery-exif' : 'gallery-unknown', importedAtMs: Date.now(), captureTimeMs: selectedPhotoTimestampMs,
    photoDate: selectedPhotoDateString, lat: detectedGps ? detectedGps.lat : null, lng: detectedGps ? detectedGps.lng : null,
    elevation: detectedGps ? detectedGps.altitude : null, accuracy: detectedGps ? detectedGps.accuracy : null, locationName: null, weather: null });
  if (detectedGps && navigator.onLine !== false) {
    api('/api/telemetry?lat=' + encodeURIComponent(detectedGps.lat) + '&lng=' + encodeURIComponent(detectedGps.lng))
      .then((telem) => {
        if (!selectionCurrent() || !telem) return;
        const rawElev = Array.isArray(telem.elevation) ? telem.elevation[0] : telem.elevation;
        const elev = Number.isFinite(Number(rawElev)) ? Math.round(Number(rawElev)) : (selectedPhotoMetadata?.elevation ?? null);
        selectedPhotoMetadata = Object.freeze({
          ...selectedPhotoMetadata,
          locationName: telem.locationName || selectedPhotoMetadata.locationName,
          elevation: elev,
          weather: telem.weather || selectedPhotoMetadata.weather,
        });
        updateScanLocationChip();
      })
      .catch(() => undefined);
  }
  showReviewPhoto();
  setScanState('review');
  renderFastQuota();
  refreshAccountQuota();
  input.value = ''; // choosing the same file again must fire `change` again
}

/* ------------------------------------------------------------------ photo date for gallery photos (M15) */
function openDatePickerModal() {
  setDialogOpen('modal-date-picker');
  const input = scanEl('manual-datetime-input');
  if (input) {
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    input.value = now.toISOString().slice(0, 16);
  }
}
function closeDatePickerModal() { closeDialog('modal-date-picker'); }
function applyPhotoTime(date, provenance, toast) {
  selectedPhotoTimestampMs = date.getTime();
  selectedPhotoDateString = formatPhotoDate(date, provenance);
  selectedPhotoMetadata = Object.freeze({ ...(selectedPhotoMetadata || {}), captureTimeMs: selectedPhotoTimestampMs, photoDate: selectedPhotoDateString });
  const clockEl = scanEl('live-clock-stamp');
  if (clockEl) clockEl.innerText = selectedPhotoDateString;
  closeDatePickerModal();
  renderScanHead(scanState, {});
  showToast(toast);
}
function applyManualDatePreset(daysAgo, label) {
  const target = new Date();
  target.setDate(target.getDate() - daysAgo);
  target.setHours(10, 30, 0, 0);
  applyPhotoTime(target, 'dipilih manual', `Tanggal foto: ${label}`);
}
function confirmCustomDateTime() {
  const input = scanEl('manual-datetime-input');
  if (!input || !input.value) { applyManualDatePreset(0, 'Hari ini'); return; }
  const selected = new Date(input.value);
  if (isNaN(selected)) { showToast('Tanggal tidak valid.'); return; }
  if (selected.getTime() > Date.now() + 60000) { showToast('Tanggal foto tidak boleh di masa depan.'); return; }
  applyPhotoTime(selected, 'waktu lokal manual', 'Tanggal foto disimpan.');
}

/* ------------------------------------------------------------------ snapshot -> review */
function takeSnapshotForReview() {
  const videoEl = scanEl('camera-stream');
  if (videoEl && !videoEl.classList.contains('hidden') && videoEl.videoWidth) {
    const digitalZoom = (typeof cameraZoom === 'number' && cameraZoom === 2 && !cameraHardwareZoom) ? 2 : 1;
    const origW = Math.max(1, Math.round(videoEl.videoWidth / digitalZoom));
    const origH = Math.max(1, Math.round(videoEl.videoHeight / digitalZoom));
    const origX = Math.round((videoEl.videoWidth - origW) / 2);
    const origY = Math.round((videoEl.videoHeight - origH) / 2);
    const originalCanvas = document.createElement('canvas');
    originalCanvas.width = origW;
    originalCanvas.height = origH;
    originalCanvas.getContext('2d').drawImage(videoEl, origX, origY, origW, origH, 0, 0, origW, origH);
    fullCapturePhoto = originalCanvas.toDataURL('image/jpeg', 0.94);
    selectedImageBase64 = renderCapture(videoEl, videoEl.videoWidth, videoEl.videoHeight, digitalZoom);
    capturePhotoSnapshot = selectedImageBase64;
    photoMode = 'live';
    try { if (navigator.vibrate) navigator.vibrate(20); } catch (_) { /* no haptics on this device */ }
    // Record the moment explicitly instead of trusting the live clock in the DOM.
    const now = new Date();
    selectedPhotoTimestampMs = now.getTime();
    selectedPhotoDateString = formatPhotoDate(now, 'waktu pengambilan perangkat');
    // Audit H6: a fix older than a minute (or too inaccurate) is NOT the photo's position. The photo is then filed with
    // no coordinates and the farmer is asked to place it, instead of getting a confident but wrong "±5 m".
    const gps = currentGpsStatus();
    const usable = gps.state === 'fresh' || gps.state === 'weak';
    selectedPhotoMetadata = Object.freeze({ source: 'camera-capture', captureTimeMs: selectedPhotoTimestampMs,
      photoDate: selectedPhotoDateString,
      lat: usable ? currentCoords.lat : null, lng: usable ? currentCoords.lng : null,
      elevation: usable ? currentCoords.elevation : null, accuracy: usable ? currentCoords.accuracy : null,
      locationName: usable ? currentCoords.locationName : null, weather: usable ? currentCoords.weather : null,
      locationSource: usable ? 'camera-capture' : 'unknown' });
    if (!usable && typeof requestLiveLocation === 'function') requestLiveLocation(false);
    const clockEl = scanEl('live-clock-stamp');
    if (clockEl) clockEl.innerText = selectedPhotoDateString;
  }
  if (!selectedImageBase64) { showToast('Arahkan kamera ke tanaman dulu.'); return; }
  stopLiveCameraStream();
  showReviewPhoto();
  setScanState('review');
  renderFastQuota();
  refreshAccountQuota();
}
function resetToLiveCamera() { JagaHooks.run('before-live-camera'); resetToLiveCameraCore(); }
function resetToLiveCameraCore() {
  clearCaptureTree();
  scanSession += 1;
  // The previous capture (if still saving/sending) finishes on its own: its `stale()` guard keeps it away from this
  // screen, and the draft is safe on the phone. It must not keep the next photo from being sent.
  scanBusy = false;
  if (typeof cameraZoom !== 'undefined') cameraZoom = 1;
  cameraHardwareZoom = false;
  updateCameraZoomUi();
  foregroundJobId = null;
  selectedImageBase64 = null;
  stampedImageBlobUrl = null;
  selectedPhotoDateString = null;
  selectedPhotoTimestampMs = null;
  selectedPhotoMetadata = null;
  capturePhotoSnapshot = null;
  activeOfflineCapture = null;
  pendingCropAssignment = null;
  lastResultRecord = null;
  const imgEl = scanEl('scanned-image'), videoEl = scanEl('camera-stream');
  if (imgEl) { imgEl.classList.add('hidden'); imgEl.removeAttribute('src'); }
  if (videoEl) videoEl.classList.add('hidden');
  const badge = scanEl('stamp-source-badge');
  if (badge) badge.innerText = 'Foto Baru';
  const hint = scanEl('crop-hint-input');
  if (hint) hint.value = '';
  toggleCropHint(false);
  const assign = scanEl('scan-assign-card');
  if (assign) { assign.classList.add('hidden'); assign.replaceChildren(); }
  setScanState('live');
  startLiveCameraStream();
}
function takeAnotherPhoto() {
  navigateToMenu('scan');
  resetToLiveCamera();
}
// Every "take a photo" button (nav, Beranda, desktop menu) lands on a working camera. A photo that was already sent or
// saved is finished (its draft is safe), so the camera starts fresh; an unsent photo under review stays open to send.
function openCamera() {
  const finished = selectedImageBase64 && (scanState === 'sent' || scanState === 'result' || scanState === 'sending');
  navigateToMenu('scan');
  if (finished) resetToLiveCamera();
}
// True while a photo is on screen that has NOT been sent or saved yet.
function hasUnsentPhoto() { return !!selectedImageBase64 && scanState === 'review'; }
function openHistoryFromScan() { navigateToMenu('log'); }
function toggleCropHint(open) {
  const wrap = scanEl('crop-hint-wrap'), toggle = scanEl('crop-hint-toggle');
  const show = typeof open === 'boolean' ? open : !!(wrap && wrap.hidden);
  if (wrap) wrap.hidden = !show;
  if (toggle) { toggle.setAttribute('aria-expanded', String(show)); toggle.classList.toggle('hidden', show); }
  if (show) { renderCropHintChips(); scanEl('crop-hint-input')?.focus(); }
}
/* Plant-type suggestions as tappable chips (the native datalist popup was messy on Android). The typed text filters
   them; a tap fills the field and closes the keyboard. Names come from the shared #cropHintSuggestions list. */
function cropHintNames() {
  return Array.from(document.querySelectorAll('#cropHintSuggestions option')).map(o => o.value).filter(Boolean);
}
function renderCropHintChips() {
  const host = scanEl('crop-hint-chips'), input = scanEl('crop-hint-input');
  if (!host || !input) return;
  const typed = input.value.trim().toLowerCase();
  const names = cropHintNames().filter(n => n.toLowerCase() !== typed && (!typed || n.toLowerCase().includes(typed))).slice(0, 8);
  host.replaceChildren(...names.map(name => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = name;
    chip.addEventListener('click', () => { input.value = name; input.blur(); renderCropHintChips(); });
    return chip;
  }));
  host.hidden = names.length === 0;
}

/* ------------------------------------------------------------------ analysis (S3, S4) */
function buildCaptureFields(metadata, tree) {
  const fields = {
    lat: Number.isFinite(metadata.lat) ? String(metadata.lat) : null,
    lng: Number.isFinite(metadata.lng) ? String(metadata.lng) : null,
    elevation: Number.isFinite(metadata.elevation) ? String(metadata.elevation) : null,
    locationName: metadata.locationName || null,
    accuracy: Number.isFinite(metadata.accuracy) ? String(metadata.accuracy) : null,
    weather: metadata.weather || null,
    photoDate: metadata.photoDate || null,
    photoTimestampMs: Number.isFinite(metadata.captureTimeMs) ? String(metadata.captureTimeMs) : null,
  };
  const hintEl = scanEl('crop-hint-input');
  fields.cropHint = hintEl ? (hintEl.value || '').trim() : '';
  if (tree) { fields.cropId = tree.cropId; fields.cropName = tree.cropName; }
  // Link the photo to a petak when the farmer is standing inside one.
  fields.farmId = metadata.farmId || (Number.isFinite(metadata.lat) && Number.isFinite(metadata.lng) ? farmContainingPoint(metadata.lat, metadata.lng) || null : null);
  fields.locationSource = metadata.locationSource || metadata.source || 'unknown';
  fields.deviceId = 'app';
  return fields;
}
async function draftRowFor(accountId, clientRequestId) {
  const listed = await window.JagaNative.list({ accountId });
  return (listed.drafts || []).find(row => row.clientRequestId === clientRequestId) || null;
}
async function executeCropPathologyAnalysis() {
  if (!selectedImageBase64 || scanBusy) return;
  if (!currentAccount) { showAuthGate('Masuk untuk menyimpan foto.'); return; }
  const submissionOwner = String(currentAccount.id), submissionGeneration = accountGeneration;
  const tree = selectedCaptureTree && selectedCaptureTree.owner === submissionOwner && selectedCaptureTree.generation === submissionGeneration ? { ...selectedCaptureTree } : null;
  scanBusy = true;
  const session = ++scanSession;
  cancelRequested = false;
  setAnalyzeButtonsDisabled(true);
  setScanState('sending');
  setProgress(8, 'Menyimpan foto di HP…');
  const stale = () => session !== scanSession || submissionGeneration !== accountGeneration || String(currentAccount?.id) !== submissionOwner;
  let clientRequestId = null;
  try {
    const blob = dataUrlToBlob(selectedImageBase64);
    if (blob.size > MAX_UPLOAD_BYTES) throw new Error('Foto melebihi 12 MB. Pilih foto yang lebih kecil.');
    const metadata = selectedPhotoMetadata || Object.freeze({ source: photoMode === 'live' ? 'camera-capture' : 'gallery-unknown' });
    const fields = buildCaptureFields(metadata, tree);
    const dataUrl = selectedImageBase64;
    clientRequestId = (activeOfflineCapture && activeOfflineCapture.clientRequestId) || crypto.randomUUID();
    const accountId = String(currentAccount.id);
    // The private original is a convenience: a full phone must never stop the farmer from sending the photo (audit H3).
    if (window.JagaMedia) {
      const kept = await window.JagaMedia.tryPut({ accountId, photoId: clientRequestId, imageBase64: (fullCapturePhoto || dataUrl).split(',')[1],
        metadata: locationMetadata({ ...metadata, ...fields }) });
      if (!kept.ok) showToast(kept.quota ? 'Penyimpanan HP hampir penuh. Foto tetap dikirim, tapi salinan asli tidak disimpan.' : 'Salinan asli foto tidak disimpan. Foto tetap dikirim.');
    }
    if (stale()) return;
    await window.JagaNative.enqueue({ accountId, clientRequestId, imageBase64: dataUrl.split(',')[1], fields });
    if (stale()) return;
    activeOfflineCapture = { accountId, clientRequestId, jobId: null };
    if (!navigator.onLine || isNativeApp()) { setScanState('sent', { queued: true }); updateSentText({ queued: true }); updateOfflineDraftCount(); return; }
    setProgress(40, 'Mengirim foto…');
    await window.JagaOfflineSync.run({ manual: true, only: clientRequestId });
    if (stale()) return;
    const row = await draftRowFor(accountId, clientRequestId);
    if (stale()) return;
    if (!row) { setScanState('sent', { queued: true }); updateSentText({ queued: true }); return; }
    if (row.status === 'submitted' && row.jobId) {
      activeOfflineCapture.jobId = row.jobId;
      setScanState('sent', {});
      updateSentText({});
      trackSubmittedJob(row.jobId, session);
      updateOfflineDraftCount();
      return;
    }
    if (row.status === 'failed' || row.status === 'conflict') {
      lastFailedCapture = { clientRequestId, jobId: null };
      showAnalysisFailure(row.error || 'Foto ditolak server. Ambil ulang foto.', { kind: 'retake', title: 'Foto belum bisa dikirim' });
      updateOfflineDraftCount();
      return;
    }
    // Waiting for signal or for the server: the photo is safe on the phone and goes out by itself.
    setScanState('sent', { queued: true });
    updateSentText({ queued: true, note: row.error && row.errorCode !== 'network' ? row.error : '' });
    updateOfflineDraftCount();
  } catch (error) {
    if (stale()) return;
    showAnalysisFailure(userMessage(error, 'Foto belum bisa disimpan. Coba lagi.'), { kind: 'retry', title: 'Foto belum bisa disimpan' });
  } finally {
    if (session === scanSession) scanBusy = false;   // a newer capture owns the flag if the session moved on
    if (scanState === 'review') setAnalyzeButtonsDisabled(false);
  }
}
function updateSentText(info) {
  const title = scanEl('sent-title'), text = scanEl('sent-text'), status = scanEl('sent-status');
  if (title) title.textContent = info.queued ? 'Foto tersimpan di HP' : 'Foto terkirim';
  if (text) text.textContent = info.queued ? 'Tersimpan di HP — dikirim otomatis saat ada sinyal.' : 'Hasil biasanya muncul dalam beberapa menit.';
  if (status) status.textContent = info.note || (info.queued ? 'Anda bisa lanjut memotret. Lihat statusnya di Riwayat.' : 'Anda bisa lanjut memotret. Hasilnya masuk ke Riwayat.');
}
function cancelAnalysis() {
  const capture = activeOfflineCapture;
  if (scanState !== 'sending') return;
  scanSession += 1;                       // everything still running for this capture now sees `stale`
  scanBusy = false;
  if (capture && capture.clientRequestId) {
    if (window.JagaOfflineSync) window.JagaOfflineSync.cancelUpload(capture.clientRequestId);
    // The farmer still has the photo on screen; the unsent copy would otherwise be sent later against their wish.
    window.JagaNative.remove({ accountId: capture.accountId, clientRequestId: capture.clientRequestId })
      .then(() => updateOfflineDraftCount()).catch(() => undefined);
    activeOfflineCapture = null;
  }
  resetScanControls();
  showToast('Dibatalkan. Foto masih ada di layar.');
}

/* Foreground tracker: only an accelerator for the capture the farmer is still looking at.
   Everything else is collected by the background poller, so leaving this screen loses nothing. */
function waitFor(ms, session) {
  return new Promise(resolve => {
    let waited = 0;
    const tick = () => {
      if (session !== scanSession || waited >= ms) { resolve(); return; }
      const slice = Math.min(500, ms - waited);
      waited += slice;
      setTimeout(tick, slice);
    };
    tick();
  });
}
const STAGE_TEXT = { 'triage:start': 'Memeriksa foto…', 'triage:http': 'Memeriksa foto…', 'triage:done': 'Menyiapkan diagnosis…',
  'diagnose:start': 'Menganalisis gejala…', 'diagnose:http': 'Menganalisis gejala…', 'diagnose:done': 'Menyusun hasil…', 'result:posted': 'Menyiapkan hasil…' };
function updateSentStatus(job) {
  const status = scanEl('sent-status');
  if (!status || scanState !== 'sent') return;
  const position = typeof job.position === 'number' ? job.position : null;
  let label;
  if (job.stageLabel) label = job.stageLabel;
  else if (job.stage && STAGE_TEXT[job.stage]) label = STAGE_TEXT[job.stage];
  else if (job.status === 'claimed' || position === 0) label = 'Sedang dianalisis…';
  else label = 'Menunggu giliran' + (position === null ? '' : ' (nomor ' + (position + 1) + ')');
  status.textContent = label + ' Anda boleh lanjut memotret.';
}
async function trackSubmittedJob(jobId, session) {
  foregroundJobId = jobId;
  activeJobId = jobId;
  let attempts = 0, offline = 0, delay = POLL_FIRST_MS;
  try {
    while (attempts < POLL_MAX_ATTEMPTS && offline < POLL_MAX_OFFLINE) {
      await waitFor(delay, session);
      if (session !== scanSession) return;
      delay = POLL_EVERY_MS;
      if (document.hidden || !navigator.onLine) continue;
      let job;
      try { job = await api('/api/analyze/' + encodeURIComponent(jobId)); }
      catch (error) {
        if (session !== scanSession) return;
        if (error.status === 404) { onJobGone(); return; }
        offline += 1;                                  // a network failure never uses up a poll attempt
        continue;
      }
      if (session !== scanSession) return;
      offline = 0;
      attempts += 1;
      if (job.status === 'queued' || job.status === 'claimed') { updateSentStatus(job); continue; }
      if (job.status === 'done') { await finishSuccessfulAnalysis(job); return; }
      if (['rejected', 'failed', 'cancelled'].includes(job.status)) { finishTerminalJob(job); return; }
    }
  } finally {
    if (foregroundJobId === jobId) foregroundJobId = null;
    if (activeJobId === jobId) activeJobId = null;
    if (window.JagaShell) window.JagaShell.kick();
  }
}
function acknowledgeJob(jobId) {
  api('/api/analyze/' + encodeURIComponent(jobId) + '/ack', { method: 'POST', body: {} }).catch(() => undefined);
}
function onJobGone() {
  showAnalysisFailure('Pekerjaan analisis ini tidak ditemukan di server. Coba kirim ulang.', { kind: 'retry', title: 'Analisis tidak ditemukan' });
}
/* The server gave up or refused. A provider outage keeps the photo so it can be sent again; a refused photo needs a new one. */
function finishTerminalJob(job) {
  const capture = activeOfflineCapture;
  const providerDown = job.triage && job.triage.code === 'provider_unavailable';
  const reason = job.error || 'Server tidak dapat menyelesaikan analisis ini.';
  lastFailedCapture = { clientRequestId: capture ? capture.clientRequestId : null, jobId: job.id };
  if (job.status === 'rejected' && !providerDown) {
    showAnalysisFailure(reason + ' Sebaiknya ambil foto lain yang lebih dekat dan jelas.', { kind: 'retake', title: 'Foto belum bisa dianalisis' });
  } else {
    // provider_unavailable (BE1 give-up) or a server failure: the photo is safe, offer to send it again
    showAnalysisFailure(reason, { kind: 'resend', title: providerDown ? 'Server analisis sedang bermasalah' : 'Analisis belum selesai' });
  }
  if (window.JagaShell) window.JagaShell.kick();
}

/* ------------------------------------------------------------------ failure card (S7) */
function showAnalysisFailure(message, options = {}) {
  const kind = options.kind || 'retry';
  const text = scanEl('analysis-failed-text');
  if (text) text.innerText = message || 'Analisis tidak dapat diselesaikan.';
  const title = scanEl('analysis-failed-title');
  if (title) title.textContent = options.title || 'Analisis gagal';
  const retry = scanEl('btn-retry-analysis'), retake = scanEl('btn-retake-after-fail'), history = scanEl('btn-failed-history');
  const label = scanEl('btn-retry-label');
  // One dominant action: "Foto ulang" when the photo itself is the problem, "Coba lagi" / "Kirim ulang" when it is not.
  if (retry) retry.classList.toggle('hidden', kind === 'retake');
  if (history) history.classList.toggle('hidden', kind === 'retry');
  if (label) label.textContent = kind === 'resend' ? 'Kirim ulang' : 'Coba lagi';
  if (retake) {
    retake.classList.toggle('btn-primary', kind === 'retake');
    retake.classList.toggle('btn-lg', kind === 'retake');
    retake.classList.toggle('btn-secondary', kind !== 'retake');
  }
  setScanState('failed', { title: options.title || 'Analisis gagal' });
  icons();
}
function hideAnalysisFailure() { scanEl('analysis-failed')?.classList.add('hidden'); }
/* Removes the capture behind the failure card once the farmer chose to retake (nothing else would ever send it). */
async function discardFailedCapture() {
  const failed = lastFailedCapture;
  lastFailedCapture = null;
  if (!failed || !failed.clientRequestId || !currentAccount) return;
  try {
    if (failed.jobId) await api('/api/analyze/' + encodeURIComponent(failed.jobId) + '/ack', { method: 'POST', body: {} }).catch(() => undefined);
    await window.JagaNative.remove({ accountId: String(currentAccount.id), clientRequestId: failed.clientRequestId });
    updateOfflineDraftCount();
  } catch (_) { /* it stays listed in Riwayat where it can be deleted by hand */ }
}
function retakeAfterFailure() { discardFailedCapture(); resetToLiveCamera(); }
async function retryAnalysis() {
  if (!selectedImageBase64) { resetToLiveCamera(); showToast('Fotonya sudah tidak ada. Ambil ulang foto tanaman Anda.'); return; }
  const failed = lastFailedCapture;
  lastFailedCapture = null;
  // A finished-and-failed job is bound to its request id: a fresh id makes a fresh job.
  if (failed && failed.jobId) {
    activeOfflineCapture = null;
    if (currentAccount && failed.clientRequestId) {
      api('/api/analyze/' + encodeURIComponent(failed.jobId) + '/ack', { method: 'POST', body: {} }).catch(() => undefined);
      window.JagaNative.remove({ accountId: String(currentAccount.id), clientRequestId: failed.clientRequestId }).catch(() => undefined);
    }
  }
  setScanState('review');
  executeCropPathologyAnalysis();
}

/* ------------------------------------------------------------------ result (S5, S6) */
function confidenceWords(value) {
  if (typeof value !== 'number' || !isFinite(value) || value < LOW_CONFIDENCE_THRESHOLD) return 'Bukti foto belum cukup. Perlu pemeriksaan langsung.';
  return 'Dugaan dari foto, belum dikonfirmasi di lapangan.';
}
function renderConfidenceNotice(confidence, uncertain=false) {
  const value = typeof confidence === 'number' && isFinite(confidence) ? confidence : null;
  lastConfidenceShown = value;
  const words = scanEl('res-confidence-words');
  if (words) words.textContent = uncertain ? 'Penyebab belum dapat dipastikan. Periksa tanaman secara langsung.' : confidenceWords(value);
  const textEl = scanEl('res-confidence');
  if (textEl) { textEl.textContent = ''; textEl.hidden = true; }
  const fillEl = scanEl('res-confidence-fill');
  if (fillEl) {
    fillEl.parentElement.hidden = true;
  }
  const warning = scanEl('res-confidence-warning');
  if (!warning) return;
  if (!uncertain && (value === null || value >= LOW_CONFIDENCE_THRESHOLD)) { warning.classList.add('hidden'); return; }
  const titleEl = scanEl('res-confidence-title'), adviceEl = scanEl('res-confidence-advice');
  if (titleEl) titleEl.innerText = 'Perlu Pemeriksaan Langsung';
  if (adviceEl) adviceEl.innerText = confidenceAdvice(value);
  warning.classList.remove('hidden');
}
function confidenceAdvice(value) {
  return 'Lengkapi dengan foto seluruh tanaman dan foto dekat bagian yang berubah. Gunakan cahaya yang cukup dan periksa kondisi tanaman langsung; beberapa penyebab memerlukan pemeriksaan petugas.';
}
function retakeForBetterPhoto() { navigateToMenu('scan'); resetToLiveCamera(); }
async function finishSuccessfulAnalysis(job) {
  const generation = accountGeneration;
  const diagnosis = job.diagnosis || {};
  const context = job.context || {};
  // Stamp the photo locally so the farmer keeps a labelled copy. If this fails the diagnosis still stands.
  let stamped = null;
  try {
    const stampMetadata = { lat: context.lat, lng: context.lng, elevation: context.elevation, accuracy: context.accuracy,
      locationName: context.locationName, weather: context.weather, photoDate: context.photoDate, photoTimestampMs: context.photoTimestampMs, addedTimeMs:job.createdMs };
    stamped = await bakeStampIntoCanvas(capturePhotoSnapshot || selectedImageBase64, stampMetadata, diagnosis);
    stampedImageBlobUrl = stamped;
    selectedImageBase64 = stamped || selectedImageBase64;
    const imgEl = scanEl('scanned-image');
    if (imgEl && stamped) imgEl.src = stamped;
  } catch (error) { console.warn('Stamp failed:', error); }
  if (generation !== accountGeneration || !currentAccount) return;

  const badge = severityBadge(diagnosis.severity);
  const sev = scanEl('res-badge-severity');
  if (sev) { sev.textContent = badge.label; sev.className = 'badge ' + badge.cls; }
  const crop = scanEl('res-crop-condition');
  if (crop) crop.innerText = [diagnosis.crop, window.JagaAssessment?.label?.(diagnosis) || diagnosis.condition].filter(Boolean).join(' — ') || '—';
  const action = scanEl('res-geo-brief');
  if (action) action.innerText = diagnosis.immediate_action_id || diagnosis.immediate_action || 'Belum ada saran. Periksa tanaman langsung.';
  scanEl('res-review-chip')?.classList.toggle('hidden', diagnosis.needs_review !== true);
  renderConfidenceNotice(typeof diagnosis.confidence === 'number' ? diagnosis.confidence : null, diagnosis.assessment?.uncertain === true);

  const saved = await saveRecord(buildRecordFromJob(job, diagnosis, null));
  if (generation !== accountGeneration) return;
  if (saved) acknowledgeJob(job.id);
  const capture = activeOfflineCapture;
  if (saved && capture && capture.jobId === job.id) {
    activeOfflineCapture = null;
    // The receipt and the private original of the upload are done with once the record exists.
    await window.JagaNative.remove({ accountId: capture.accountId, clientRequestId: capture.clientRequestId }).catch(() => undefined);
    updateOfflineDraftCount();
  }
  lastResultRecord = saved || null;
  window.JagaAssessment?.render(scanEl('res-assessment'), saved || diagnosis);
  if(action) action.parentElement.hidden = !!(saved?.assessment || diagnosis.assessment);
  if (!saved) showToast('Hasil belum masuk Riwayat. Dicoba lagi otomatis.');
  setScanState('result');
  if (saved) { pendingCropAssignment = { record: saved }; promptCropAssignment(); }
  else { const card = scanEl('scan-assign-card'); if (card) card.classList.add('hidden'); }
  icons();
}

/* ------------------------------------------------------------------ tree assignment: inline card, modal for old results */
function findNearbyCropCandidates(record) {
  const candidates = [];
  const seen = Object.create(null);
  farmRecords.forEach(rec => {
    if (!rec.cropId || rec.id === record.id) return;
    if (!speciesOverlap(record.crop, rec.crop)) return;
    if (seen[rec.cropId]) return;
    if (!validCoordinates(record.lat, record.lng) || !validCoordinates(rec.lat, rec.lng)) return;
    const d = haversineMeters(record.lat, record.lng, rec.lat, rec.lng);
    if (d > CROP_MATCH_RADIUS_M) return;
    seen[rec.cropId] = true;
    const same = farmRecords.filter(r => r.cropId === rec.cropId);
    const latest = same.reduce((best, r) => ((r.timestampMs || 0) > (best.timestampMs || 0) ? r : best), same[0]);
    candidates.push({ cropId: rec.cropId, cropName: rec.cropName || rec.crop, distanceM: Math.round(d), count: same.length,
      lastSeverity: latest.severity, lastMs: latest.timestampMs, imageUrl: latest.imageUrl || '' });
  });
  return candidates.sort((a, b) => a.distanceM - b.distanceM);
}
function candidateRow(c, selected) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'card card-tap scan-candidate' + (selected ? ' is-selected' : '');
  row.dataset.cropId = c.cropId;
  row.setAttribute('aria-pressed', String(!!selected));
  const thumb = document.createElement('span');
  thumb.className = 'thumb thumb-sm';
  const src = imageAttribute(c.imageUrl);
  if (src) { const img = document.createElement('img'); img.alt = ''; img.loading = 'lazy'; img.src = src.replace(/&amp;/g, '&'); img.onerror = () => img.classList.add('is-broken'); thumb.append(img); }
  const copy = document.createElement('span');
  copy.className = 'scan-candidate-copy';
  const name = document.createElement('strong');
  name.className = 't-body';
  name.textContent = c.cropName;
  const meta = document.createElement('span');
  meta.className = 't-meta';
  const sev = severityBadge(c.lastSeverity).label;
  meta.textContent = '±' + c.distanceM + ' m dari foto ini · ' + c.count + ' foto · terakhir ' + sev;
  copy.append(name, meta);
  const mark = document.createElement('span');
  mark.className = 'scan-candidate-mark';
  mark.setAttribute('aria-hidden', 'true');
  row.append(thumb, copy, mark);
  return row;
}
/* Renders the "Simpan ke tanaman" picker into `host` (inline card or modal list). `onPick(cropId|null)` finishes the choice. */
function renderAssignPicker(host, candidates, onPick) {
  assignChoice = candidates[0] ? candidates[0].cropId : null;
  host.replaceChildren();
  const list = document.createElement('div');
  list.className = 'scan-candidates';
  const rows = candidates.map((c, index) => candidateRow(c, index === 0));
  rows.forEach(row => row.addEventListener('click', () => {
    assignChoice = row.dataset.cropId;
    rows.forEach(other => { const on = other === row; other.classList.toggle('is-selected', on); other.setAttribute('aria-pressed', String(on)); });
    updatePrimary();
  }));
  list.append(...rows);
  const actions = document.createElement('div');
  actions.className = 'btn-row';
  const fresh = document.createElement('button');
  fresh.type = 'button';
  fresh.className = 'btn btn-secondary';
  fresh.innerHTML = '<span class="btn-label">Tanaman baru</span>';
  fresh.addEventListener('click', () => onPick(null));
  const primary = document.createElement('button');
  primary.type = 'button';
  primary.className = 'btn btn-primary btn-grow';
  const primaryLabel = document.createElement('span');
  primaryLabel.className = 'btn-label';
  primary.append(primaryLabel);
  function updatePrimary() {
    const chosen = candidates.find(c => c.cropId === assignChoice) || candidates[0];
    primaryLabel.textContent = 'Simpan ke ' + chosen.cropName;
  }
  updatePrimary();
  primary.addEventListener('click', () => onPick(assignChoice));
  actions.append(fresh, primary);
  host.append(list, actions);
}
function promptCropAssignment() {
  if (!pendingCropAssignment) return;
  const rec = pendingCropAssignment.record;
  const card = scanEl('scan-assign-card');
  if (rec.cropId) {
    expandedCropId = rec.cropId;
    pendingCropAssignment = null;
    closeCropAssignModal();
    if (card) card.classList.add('hidden');
    return;
  }
  const candidates = findNearbyCropCandidates(rec);
  if (candidates.length === 0) { assignCropChoice(null); return; }
  if (scanState === 'result' && card && lastResultRecord && lastResultRecord.id === rec.id) {
    // Inline in the result: no modal, nothing to dismiss, the closest tree is already chosen.
    card.replaceChildren();
    const title = document.createElement('p');
    title.className = 'section-title';
    title.textContent = 'Simpan ke tanaman:';
    const host = document.createElement('div');
    renderAssignPicker(host, candidates, cropId => assignCropChoice(cropId));
    card.append(title, host);
    card.classList.remove('hidden');
    return;
  }
  const list = scanEl('crop-assign-list');
  if (list) renderAssignPicker(list, candidates, cropId => assignCropChoice(cropId));
  setDialogOpen('modal-crop-assign');
}
function closeCropAssignModal() { closeDialog('modal-crop-assign'); }
/* Opens the picker for any saved record that has no tree yet (used by Riwayat's "Pilih tanaman"). */
function openTreeAssignment(recordId) {
  const rec = farmRecords.find(r => r.id === recordId);
  if (!rec) return;
  pendingCropAssignment = { record: rec };
  promptCropAssignment();
}
async function assignCropChoice(cropId) {
  if (!pendingCropAssignment) { closeCropAssignModal(); return; }
  const rec = pendingCropAssignment.record;
  let nextCropId, nextCropName;
  if (cropId) {
    const existing = farmRecords.find(r => r.cropId === cropId);
    nextCropId = cropId;
    nextCropName = (existing && (existing.cropName || existing.crop)) || rec.crop;
  } else {
    const slug = baseSpeciesName(rec.crop).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'tanaman';
    nextCropId = `crop_${slug}_${Date.now()}`;
    const place = String(rec.locationName || '').split(',')[0].trim();
    nextCropName = place ? `${rec.crop} - ${place}` : rec.crop;
  }
  closeCropAssignModal();
  pendingCropAssignment = null;
  const card = scanEl('scan-assign-card');
  if (card) card.classList.add('hidden');
  try {
    const saved = await api('/api/records/' + encodeURIComponent(rec.id), { method: 'PUT', body: { cropId: nextCropId, cropName: nextCropName } });
    const index = farmRecords.findIndex(r => r.id === saved.id);
    if (index >= 0) farmRecords[index] = saved; else farmRecords.unshift(saved);
    if (lastResultRecord && lastResultRecord.id === saved.id) lastResultRecord = saved;
    expandedCropId = nextCropId;
    showToast((cropId ? 'Masuk ke ' : 'Tanaman baru: ') + nextCropName);
    refreshAllHistoryViews();
  } catch (error) {
    showToast('Belum bisa menyimpan tanaman: ' + userMessage(error));
  }
}

/* ------------------------------------------------------------------ result actions */
function speakScanResult() {
  if (!('speechSynthesis' in window)) { showToast('Pembacaan suara belum tersedia di HP ini.'); return; }
  const parts = [scanEl('res-badge-severity')?.textContent, scanEl('res-crop-condition')?.innerText, (window.JagaAssessment?.text(lastResultRecord) || scanEl('res-geo-brief')?.innerText || '')];
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(parts.filter(Boolean).join('. '));
  utterance.lang = 'id-ID';
  utterance.rate = 0.95;
  window.speechSynthesis.speak(utterance);
}
function sharePhotoWhatsApp() {
  const rec = lastResultRecord || farmRecords[0];
  if (!rec) return;
  const lines = ['*Laporan Lapangan JagaKebond*',
    'Tanaman: ' + (rec.cropName || rec.crop || '-'),
    'Kondisi: ' + (window.JagaAssessment?.label?.(rec) || rec.condition || '-') + ' (' + severityBadge(rec.severity).label + ')',
    rec.locationName ? 'Lokasi: ' + rec.locationName : '',
    Number.isFinite(rec.timestampMs) ? 'Waktu: ' + friendlyTime(rec.timestampMs) : '',
    window.JagaAssessment?.text(rec) || rec.immediate_action || ''].filter(Boolean);
  window.open('https://api.whatsapp.com/send?text=' + encodeURIComponent(lines.join('\n')), '_blank', 'noopener');
}
function viewScanResultInMap() {
  const rec = lastResultRecord || farmRecords[0];
  if (rec) viewRecordInMap(rec.id); else showToast('Belum ada hasil untuk ditampilkan di peta.');
}

/* ------------------------------------------------------------------ wiring */
document.addEventListener('DOMContentLoaded', () => {
  scanEl('crop-hint-toggle')?.addEventListener('click', () => toggleCropHint(true));
  const hintInput = scanEl('crop-hint-input');
  if (hintInput) {
    hintInput.addEventListener('input', renderCropHintChips);
    // The sticky Analisis bar stays put (moving it under the finger made taps miss); instead the field scrolls to the
    // middle of the screen, above the bar, once the keyboard has opened.
    hintInput.addEventListener('focus', () => { setTimeout(() => hintInput.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300); });
    hintInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); hintInput.blur(); } });
  }
  scanEl('scan-photo-preview-btn')?.addEventListener('click', () => { if (selectedImageBase64) openPhotoViewer(selectedImageBase64, 'Foto Tanaman', '', '', null); });
  scanEl('scan-set-date')?.addEventListener('click', openDatePickerModal);
  scanEl('scan-location-fix')?.addEventListener('click', () => openLocationEditor('capture'));
  scanEl('capture-edit-location')?.addEventListener('click', () => openLocationEditor('capture'));
  scanEl('scan-retake')?.addEventListener('click', resetToLiveCamera);
  if (!scanChipTimer) scanChipTimer = setInterval(() => { if (scanVisible() && currentAccount) updateScanLocationChip(); }, 10000);
});
