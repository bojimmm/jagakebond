/* Account-partitioned durable browser store: outbox drafts and their photos, private original copies, small
   JSON caches and a few non-secret markers. It is not encrypted at rest.

   IndexedDB name kept as 'jagakebond-offline-v1' so installs made by older releases keep their drafts.
     v1  drafts{key} (index accountId) with the upload JPEG inline, cache{key}
     v2  drafts hold metadata only; draftImages{key} holds the upload JPEG (base64); photos{key} holds private
         original copies as Blobs; thumbs{key} small preview data URLs; meta{key} non-secret markers
         (last signed-in account, pending logout).
   The v1 -> v2 upgrade runs inside the version-change transaction, so any failure rolls back to v1 untouched. */
(function installOfflineStore(root) {
  'use strict';
  const DB_NAME = 'jagakebond-offline-v1';
  const DB_VERSION = 2;
  const REQUEST_ID = /^[A-Za-z0-9_-]{8,100}$/;
  const PHOTO_ID = /^[A-Za-z0-9_-]{1,128}$/;
  const MAX_IMAGE_CHARS = 18 * 1024 * 1024;
  const STALE_UPLOAD_MS = 120000;
  const PHOTO_MAX_BYTES = 120 * 1024 * 1024;
  const PHOTO_MAX_COUNT = 160;
  const THUMB_MAX_COUNT = 600;
  const TOUCH_AFTER_MS = 10 * 60 * 1000;
  const OPEN_TIMEOUT_MS = 12000;
  const EDITABLE = ['pending', 'blocked', 'failed', 'rejected', 'cancelled', 'editing'];
  let activeAccount = null;
  let locked = true;
  let dbPromise = null;

  /* ------------------------------------------------------------------ errors */
  function storageError(message, reason) {
    const error = new Error(message);
    if (reason) error.reason = reason;
    return error;
  }
  function isQuota(error) {
    return !!error && (error.name === 'QuotaExceededError' || error.code === 22 || /quota/i.test(String(error.message || '')));
  }
  /* Raw DOMException text is English and useless to a farmer; map storage failures to plain Bahasa. */
  function friendly(error) {
    if (!error) return storageError('Penyimpanan HP bermasalah. Tutup lalu buka lagi aplikasi.', 'storage');
    if (error.reason === 'quota' || isQuota(error)) {
      const wrapped = storageError('Penyimpanan HP penuh. Hapus foto lama atau kirim foto yang menunggu, lalu coba lagi.', 'quota');
      wrapped.cause = error;
      return wrapped;
    }
    if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
      const wrapped = storageError('Penyimpanan HP bermasalah. Tutup lalu buka lagi aplikasi.', 'storage');
      wrapped.cause = error;
      return wrapped;
    }
    return error;
  }

  /* ------------------------------------------------------------------ database */
  function migrateV1(drafts, cache, images, photos) {
    const draftCursor = drafts.openCursor();
    draftCursor.onsuccess = () => {
      const cursor = draftCursor.result;
      if (!cursor) return;
      const row = cursor.value;
      if (typeof row.imageBase64 === 'string' && row.imageBase64) {
        try {
          images.put({ key: row.key, accountId: row.accountId, imageBase64: row.imageBase64 });
          const { imageBase64, ...rest } = row;
          cursor.update({ ...rest, hasImage: true, imageChars: imageBase64.length, attempts: Number(rest.attempts) || 0 });
        } catch (_) { /* keep the inline copy: every reader below still understands it */ }
      }
      cursor.continue();
    };
    const cacheCursor = cache.openCursor();
    cacheCursor.onsuccess = () => {
      const cursor = cacheCursor.result;
      if (!cursor) return;
      const match = /^([^:]+):cache:photo:(.+)$/.exec(String(cursor.key));
      const value = cursor.value && cursor.value.value;
      if (match && value && typeof value.imageBase64 === 'string' && value.imageBase64) {
        try {
          const blob = base64ToBlob(value.imageBase64);
          const now = Date.now();
          photos.put({ key: match[1] + ':' + match[2], accountId: match[1], photoId: match[2], blob,
            metadata: value.metadata || {}, bytes: blob.size, createdMs: now, touchedMs: now });
          cursor.delete();
        } catch (_) { /* leave the old cache entry where it is */ }
      }
      cursor.continue();
    };
  }
  function upgrade(request, event) {
    const db = request.result;
    const tx = request.transaction;
    const ensure = (name, options, indexes) => {
      const store = db.objectStoreNames.contains(name) ? tx.objectStore(name) : db.createObjectStore(name, options);
      (indexes || []).forEach(([index, path]) => { if (!store.indexNames.contains(index)) store.createIndex(index, path, { unique: false }); });
      return store;
    };
    const drafts = ensure('drafts', { keyPath: 'key' }, [['accountId', 'accountId']]);
    const cache = ensure('cache', { keyPath: 'key' });
    const images = ensure('draftImages', { keyPath: 'key' });
    const photos = ensure('photos', { keyPath: 'key' }, [['accountId', 'accountId']]);
    ensure('thumbs', { keyPath: 'key' });
    ensure('meta', { keyPath: 'key' });
    if (event.oldVersion === 1) migrateV1(drafts, cache, images, photos);
  }
  /* One cached connection. It closes itself when another tab upgrades the database. */
  function openDb() {
    if (dbPromise) return dbPromise;
    const attempt = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(storageError('Penyimpanan HP tidak tersedia di peramban ini.', 'storage')); return; }
      let settled = false;
      let request;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(storageError('Penyimpanan HP sedang dipakai jendela lain. Tutup jendela lain lalu coba lagi.', 'blocked'));
      }, OPEN_TIMEOUT_MS);
      try { request = indexedDB.open(DB_NAME, DB_VERSION); }
      catch (error) { settled = true; clearTimeout(timer); reject(error); return; }
      request.onupgradeneeded = event => {
        try { upgrade(request, event); }
        catch (error) { try { request.transaction.abort(); } catch (_) { /* already aborted */ } }
      };
      request.onsuccess = () => {
        const db = request.result;
        if (settled) { db.close(); return; }
        settled = true;
        clearTimeout(timer);
        db.onversionchange = () => { try { db.close(); } catch (_) { /* closing */ } if (dbPromise === attempt) dbPromise = null; };
        db.onclose = () => { if (dbPromise === attempt) dbPromise = null; };
        resolve(db);
      };
      request.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(request.error || storageError('Penyimpanan offline gagal dibuka.', 'storage'));
      };
    });
    dbPromise = attempt;
    attempt.catch(() => { if (dbPromise === attempt) dbPromise = null; });
    return attempt;
  }
  /* Runs `work(tx)` in one transaction. `work` returns a value, or a function evaluated after the commit
     (request callbacks fill their results in later, so the function form is how reads hand results back). */
  async function withTx(names, mode, work, retry = true) {
    const db = await openDb();
    let tx;
    try { tx = db.transaction(names, mode); }
    catch (error) {
      if (retry && error && error.name === 'InvalidStateError') { dbPromise = null; return withTx(names, mode, work, false); }
      throw error;
    }
    return new Promise((resolve, reject) => {
      let result;
      tx.oncomplete = () => {
        try { resolve(typeof result === 'function' ? result() : result); } catch (error) { reject(error); }
      };
      tx.onabort = () => reject(tx.error || storageError('Transaksi penyimpanan dibatalkan.', 'storage'));
      try { result = work(tx); }
      catch (error) { try { tx.abort(); } catch (_) { /* already finished */ } reject(error); }
    });
  }

  /* ------------------------------------------------------------------ small helpers */
  const key = (accountId, id) => accountId + ':' + id;
  const cacheKey = (accountId, name) => key(accountId, 'cache:' + name);
  const prefixRange = accountId => IDBKeyRange.bound(accountId + ':', accountId + ':￿');
  function assertOwner(accountId) {
    if (locked || !activeAccount || accountId !== activeAccount) throw new Error('Draft terkunci. Masuk kembali dengan akun yang sama.');
  }
  function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
    return JSON.stringify(value);
  }
  function cyrb53(text) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ code, 2654435761);
      h2 = Math.imul(h2 ^ code, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
  }
  async function fingerprint(imageBase64, fields) {
    const text = imageBase64 + '\n' + canonical(fields);
    if (root.crypto && root.crypto.subtle) {
      const digest = await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    }
    return 'x' + cyrb53(text); // insecure context (plain http): only detects accidental payload changes
  }
  function base64ToBlob(base64, type) {
    const raw = atob(base64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    return new Blob([bytes], { type: type || 'image/jpeg' });
  }
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => { const text = String(reader.result); const comma = text.indexOf(','); resolve(comma >= 0 ? text.slice(comma + 1) : ''); };
      reader.onerror = () => reject(storageError('Foto tersimpan tidak dapat dibaca.', 'storage'));
      reader.readAsDataURL(blob);
    });
  }
  function publicRow(row) {
    const { imageBase64, fingerprint: ignored, ...rest } = row;
    return rest;
  }
  async function rowsFor(accountId) {
    return withTx(['drafts'], 'readonly', tx => {
      const out = [];
      const request = tx.objectStore('drafts').index('accountId').getAll(accountId);
      request.onsuccess = () => out.push(...request.result);
      return out;
    });
  }
  async function readRow(accountId, requestId) {
    return withTx(['drafts'], 'readonly', tx => {
      const out = {};
      const request = tx.objectStore('drafts').get(key(accountId, requestId));
      request.onsuccess = () => { out.row = request.result; };
      return () => out.row;
    });
  }
  async function readImage(accountId, requestId, row) {
    const found = await withTx(['draftImages'], 'readonly', tx => {
      const out = {};
      const request = tx.objectStore('draftImages').get(key(accountId, requestId));
      request.onsuccess = () => { out.row = request.result; };
      return () => out.row;
    });
    if (found && typeof found.imageBase64 === 'string') return found.imageBase64;
    return row && typeof row.imageBase64 === 'string' ? row.imageBase64 : null; // legacy inline copy
  }

  /* ------------------------------------------------------------------ private photo cache */
  /* Never evicts a photo that still belongs to a draft (the original is needed to stamp or export it). */
  function evictPhotos(accountId, options = {}) {
    const maxBytes = options.aggressive ? Math.floor(PHOTO_MAX_BYTES * 0.4) : PHOTO_MAX_BYTES;
    const maxCount = options.aggressive ? Math.floor(PHOTO_MAX_COUNT * 0.4) : PHOTO_MAX_COUNT;
    return withTx(['photos', 'drafts'], 'readwrite', tx => {
      const out = { removed: 0, bytes: 0 };
      let drafts = null;
      let photos = null;
      const finish = () => {
        if (!drafts || !photos) return;
        const protectedIds = new Set(drafts.map(row => row.clientRequestId));
        let totalBytes = photos.reduce((sum, row) => sum + (Number(row.bytes) || 0), 0);
        let totalCount = photos.length;
        const victims = photos.filter(row => !protectedIds.has(row.photoId))
          .sort((a, b) => (Number(a.touchedMs) || Number(a.createdMs) || 0) - (Number(b.touchedMs) || Number(b.createdMs) || 0));
        for (const row of victims) {
          if (totalBytes <= maxBytes && totalCount <= maxCount) break;
          tx.objectStore('photos').delete(row.key);
          totalBytes -= Number(row.bytes) || 0;
          totalCount -= 1;
          out.removed += 1;
          out.bytes += Number(row.bytes) || 0;
        }
      };
      const draftRequest = tx.objectStore('drafts').index('accountId').getAll(accountId);
      draftRequest.onsuccess = () => { drafts = draftRequest.result; finish(); };
      const photoRequest = tx.objectStore('photos').getAll(prefixRange(accountId));
      photoRequest.onsuccess = () => { photos = photoRequest.result; finish(); };
      return out;
    });
  }
  function trimThumbs(accountId) {
    return withTx(['thumbs'], 'readwrite', tx => {
      const store = tx.objectStore('thumbs');
      const countRequest = store.count(prefixRange(accountId));
      countRequest.onsuccess = () => {
        if (countRequest.result <= THUMB_MAX_COUNT) return;
        const rows = store.getAll(prefixRange(accountId));
        rows.onsuccess = () => {
          rows.result.sort((a, b) => (Number(a.touchedMs) || 0) - (Number(b.touchedMs) || 0))
            .slice(0, rows.result.length - Math.floor(THUMB_MAX_COUNT * 0.8))
            .forEach(row => store.delete(row.key));
        };
      };
    });
  }

  /* ------------------------------------------------------------------ public API */
  const store = {
    async activate(accountId) {
      if (accountId === undefined || accountId === null || String(accountId) === '') throw new Error('Akun tidak valid.');
      activeAccount = String(accountId);
      locked = false;
      return { ok: true, accountId: activeAccount };
    },
    async lock() { locked = true; activeAccount = null; return { ok: true }; },

    /* ---- outbox ---- */
    async enqueue({ accountId, clientRequestId, imageBase64, fields }) {
      accountId = String(accountId);
      assertOwner(accountId);
      if (!REQUEST_ID.test(clientRequestId || '')) throw new Error('ID permintaan tidak valid.');
      if (typeof imageBase64 !== 'string' || !imageBase64 || imageBase64.length > MAX_IMAGE_CHARS) throw new Error('Foto tidak valid atau terlalu besar.');
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('Konteks foto tidak valid.');
      const fp = await fingerprint(imageBase64, fields);
      assertOwner(accountId);
      const id = key(accountId, clientRequestId);
      const row = { key: id, accountId, clientRequestId, fields, fingerprint: fp, createdMs: Date.now(), status: 'pending',
        attempts: 0, hasImage: true, imageChars: imageBase64.length };
      try {
        return await withTx(['drafts', 'draftImages'], 'readwrite', tx => {
          const drafts = tx.objectStore('drafts');
          const out = {};
          const get = drafts.get(id);
          get.onsuccess = () => {
            if (get.result) {
              if (get.result.fingerprint !== fp) { out.error = new Error('ID permintaan sudah digunakan untuk foto/konteks berbeda.'); return; }
              out.value = { ok: true, clientRequestId };
              return;
            }
            drafts.put(row);
            tx.objectStore('draftImages').put({ key: id, accountId, imageBase64 });
            out.value = { ok: true, clientRequestId };
          };
          get.onerror = () => { out.error = get.error; };
          return () => { if (out.error) throw out.error; return out.value; };
        });
      } catch (error) { throw friendly(error); }
    },
    async list({ accountId } = {}) {
      accountId = String(accountId);
      assertOwner(accountId);
      const rows = await rowsFor(accountId);
      assertOwner(accountId);
      return { drafts: rows.map(publicRow) };
    },
    async pendingForSync(accountId) {
      accountId = String(accountId);
      assertOwner(accountId);
      const rows = await rowsFor(accountId);
      assertOwner(accountId);
      const now = Date.now();
      return rows.filter(row => row.status === 'pending' ||
        (row.status === 'uploading' && now - Number(row.uploadingMs || 0) > STALE_UPLOAD_MS)).map(publicRow);
    },
    async submitted(accountId) {
      accountId = String(accountId);
      assertOwner(accountId);
      const rows = await rowsFor(accountId);
      assertOwner(accountId);
      return rows.filter(row => row.status === 'submitted').map(publicRow);
    },
    async update(accountId, clientRequestId, changes) {
      accountId = String(accountId);
      assertOwner(accountId);
      const id = key(accountId, clientRequestId);
      const safe = { ...changes };
      delete safe.imageBase64; delete safe.key; delete safe.accountId; delete safe.fingerprint;
      try {
        await withTx(['drafts'], 'readwrite', tx => {
          const drafts = tx.objectStore('drafts');
          const request = drafts.get(id);
          request.onsuccess = () => {
            if (!request.result) return;
            assertOwner(accountId);
            drafts.put({ ...request.result, ...safe });
          };
        });
      } catch (error) { throw friendly(error); }
      assertOwner(accountId);
      return { ok: true };
    },
    async discardSubmitted(accountId, clientRequestId) {
      accountId = String(accountId);
      assertOwner(accountId);
      const id = key(accountId, clientRequestId);
      await withTx(['drafts', 'draftImages', 'photos', 'thumbs'], 'readwrite', tx => {
        const drafts = tx.objectStore('drafts');
        const request = drafts.get(id);
        request.onsuccess = () => {
          if (!request.result || request.result.status !== 'submitted') return;
          drafts.delete(id);
          tx.objectStore('draftImages').delete(id);
          tx.objectStore('photos').delete(id);
          tx.objectStore('thumbs').delete(id);
        };
      });
      assertOwner(accountId);
      return { ok: true };
    },
    async markFailure(accountId, clientRequestId, error) {
      return store.update(accountId, clientRequestId, { status: 'failed', error: String(error || 'Gagal mengirim') });
    },
    /* Deleting a draft also deletes its private original copy: nothing else will ever read it. */
    async remove({ accountId, clientRequestId }) {
      accountId = String(accountId);
      assertOwner(accountId);
      const id = key(accountId, clientRequestId);
      await withTx(['drafts', 'draftImages', 'photos', 'thumbs'], 'readwrite', tx => {
        tx.objectStore('drafts').delete(id);
        tx.objectStore('draftImages').delete(id);
        tx.objectStore('photos').delete(id);
        tx.objectStore('thumbs').delete(id);
      });
      return { ok: true };
    },
    async draftGet({ accountId, clientRequestId }) {
      accountId = String(accountId);
      assertOwner(accountId);
      const row = await readRow(accountId, clientRequestId);
      assertOwner(accountId);
      if (!row) return {};
      const imageBase64 = await readImage(accountId, clientRequestId, row);
      assertOwner(accountId);
      return { draft: { ...row, imageBase64: imageBase64 || undefined } };
    },
    /* The upload JPEG only (no row): the sync engine reads it just before sending. */
    async draftImage(accountId, clientRequestId) {
      accountId = String(accountId);
      assertOwner(accountId);
      const row = await readRow(accountId, clientRequestId);
      const image = await readImage(accountId, clientRequestId, row);
      assertOwner(accountId);
      return image;
    },
    async draftClaim({ accountId, clientRequestId, ignoreDeadline }) {
      accountId = String(accountId);
      assertOwner(accountId);
      const id = key(accountId, clientRequestId);
      const result = await withTx(['drafts'], 'readwrite', tx => {
        const holder = { claimed: false };
        const drafts = tx.objectStore('drafts');
        const request = drafts.get(id);
        request.onsuccess = () => {
          const row = request.result;
          const now = Date.now();
          if (row && (row.status === 'pending' || (row.status === 'uploading' && now - Number(row.uploadingMs || 0) > STALE_UPLOAD_MS)) &&
              (ignoreDeadline || !(Number(row.nextAttemptAtMs) > now))) {
            drafts.put({ ...row, status: 'uploading', uploadingMs: now });
            holder.claimed = true;
          }
        };
        return holder;
      });
      assertOwner(accountId);
      return result;
    },
    async draftEdit({ accountId, clientRequestId, newClientRequestId, fields }) {
      accountId = String(accountId);
      assertOwner(accountId);
      if (!REQUEST_ID.test(newClientRequestId) || newClientRequestId === clientRequestId) throw Error('ID draf baru tidak valid.');
      const prior = (await store.draftGet({ accountId, clientRequestId })).draft;
      if (!prior || !EDITABLE.includes(prior.status)) throw Error('Draf sudah dikirim; lokasi hasil dapat diubah setelah selesai.');
      if (!prior.imageBase64) throw Error('Foto draf tidak ditemukan di perangkat ini.');
      const fp = await fingerprint(prior.imageBase64, fields);
      assertOwner(accountId);
      const oldKey = key(accountId, clientRequestId);
      const newKey = key(accountId, newClientRequestId);
      let result;
      try {
        result = await withTx(['drafts', 'draftImages'], 'readwrite', tx => {
          const holder = { error: null };
          const drafts = tx.objectStore('drafts');
          const request = drafts.get(oldKey);
          request.onsuccess = () => {
            const current = request.result;
            if (!current || !EDITABLE.includes(current.status)) { holder.error = 'Status draf berubah; pengeditan dibatalkan.'; return; }
            const { imageBase64, ...meta } = current;
            drafts.delete(oldKey);
            tx.objectStore('draftImages').delete(oldKey);
            drafts.add({ ...meta, key: newKey, clientRequestId: newClientRequestId, fields, fingerprint: fp, status: 'editing',
              jobId: null, error: null, hasImage: true, imageChars: prior.imageBase64.length });
            tx.objectStore('draftImages').put({ key: newKey, accountId, imageBase64: prior.imageBase64 });
          };
          return holder;
        });
      } catch (error) { throw friendly(error); }
      if (result.error) throw Error(result.error);
      assertOwner(accountId);
      return { ok: true, clientRequestId: newClientRequestId };
    },
    async draftResume({ accountId, clientRequestId }) {
      const row = (await store.draftGet({ accountId, clientRequestId })).draft;
      if (!row || row.status !== 'editing') throw Error('Draf tidak sedang diedit.');
      return store.update(String(accountId), clientRequestId, { status: 'pending' });
    },
    async draftMark({ accountId, clientRequestId, status, error, jobId }) {
      const row = (await store.draftGet({ accountId, clientRequestId })).draft;
      if (!row || !['submitted', 'failed', 'rejected', 'cancelled'].includes(row.status) || !['failed', 'rejected', 'cancelled'].includes(status)) throw Error('Status hasil tidak valid.');
      return store.update(String(accountId), clientRequestId, { status, error, jobId });
    },
    /* "Coba kirim lagi": a failed or deferred draft becomes eligible straight away. */
    async draftRetry({ accountId, clientRequestId }) {
      const row = (await store.draftGet({ accountId, clientRequestId })).draft;
      if (!row || !['failed', 'pending', 'blocked', 'conflict'].includes(row.status)) throw Error('Draf ini tidak dapat dikirim ulang.');
      return store.update(String(accountId), clientRequestId, { status: 'pending', attempts: 0, error: null, errorCode: null, nextAttemptAtMs: 0 });
    },

    /* ---- small per-account JSON caches (records, farms, daily) ---- */
    async cacheGet({ accountId, name }) {
      accountId = String(accountId);
      assertOwner(accountId);
      const holder = await withTx(['cache'], 'readonly', tx => {
        const out = {};
        const request = tx.objectStore('cache').get(cacheKey(accountId, name));
        request.onsuccess = () => { out.value = request.result && request.result.value; };
        return out;
      });
      assertOwner(accountId);
      return holder.value;
    },
    async cachePut({ accountId, name, value }) {
      accountId = String(accountId);
      assertOwner(accountId);
      try {
        return await withTx(['cache'], 'readwrite', tx => { tx.objectStore('cache').put({ key: cacheKey(accountId, name), accountId, value }); });
      } catch (error) { throw friendly(error); }
    },

    /* ---- private original photos (never uploaded as-is; used for export and for stamping results) ---- */
    async photoPut({ accountId, photoId, imageBase64, metadata }) {
      accountId = String(accountId);
      assertOwner(accountId);
      if (!PHOTO_ID.test(String(photoId || '')) || typeof imageBase64 !== 'string' || !imageBase64) throw new Error('Foto tidak valid.');
      const blob = base64ToBlob(imageBase64);
      const now = Date.now();
      const entry = { key: key(accountId, photoId), accountId, photoId: String(photoId), blob, metadata: metadata || {}, bytes: blob.size, createdMs: now, touchedMs: now };
      const write = () => withTx(['photos'], 'readwrite', tx => { tx.objectStore('photos').put(entry); });
      try { await write(); }
      catch (error) {
        if (!isQuota(error)) throw friendly(error);
        try { await evictPhotos(accountId, { aggressive: true }); await write(); }
        catch (second) { throw friendly(second); }
      }
      assertOwner(accountId);
      evictPhotos(accountId).catch(() => undefined); // keep the cache inside its caps, never blocks the caller
      return { ok: true };
    },
    async photoGet({ accountId, photoId }) {
      accountId = String(accountId);
      assertOwner(accountId);
      const entry = await withTx(['photos'], 'readonly', tx => {
        const out = {};
        const request = tx.objectStore('photos').get(key(accountId, photoId));
        request.onsuccess = () => { out.row = request.result; };
        return () => out.row;
      });
      assertOwner(accountId);
      if (!entry) return { found: false };
      const imageBase64 = await blobToBase64(entry.blob);
      assertOwner(accountId);
      if (Date.now() - (Number(entry.touchedMs) || 0) > TOUCH_AFTER_MS) {
        withTx(['photos'], 'readwrite', tx => { tx.objectStore('photos').put({ ...entry, touchedMs: Date.now() }); }).catch(() => undefined);
      }
      return { imageBase64, metadata: entry.metadata || {} };
    },
    async photoDelete({ accountId, photoId }) {
      accountId = String(accountId);
      assertOwner(accountId);
      const id = key(accountId, photoId);
      const holder = await withTx(['photos', 'thumbs'], 'readwrite', tx => {
        const out = { deleted: false };
        const request = tx.objectStore('photos').getKey(id);
        request.onsuccess = () => { out.deleted = request.result !== undefined; };
        tx.objectStore('photos').delete(id);
        tx.objectStore('thumbs').delete(id);
        return out;
      });
      return { deleted: !!holder.deleted };
    },
    async thumbGet({ accountId, photoId }) {
      accountId = String(accountId);
      assertOwner(accountId);
      const row = await withTx(['thumbs'], 'readonly', tx => {
        const out = {};
        const request = tx.objectStore('thumbs').get(key(accountId, photoId));
        request.onsuccess = () => { out.row = request.result; };
        return () => out.row;
      });
      assertOwner(accountId);
      return row && typeof row.dataUrl === 'string' ? row.dataUrl : null;
    },
    async thumbPut({ accountId, photoId, dataUrl }) {
      accountId = String(accountId);
      assertOwner(accountId);
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/') || dataUrl.length > 400000) return { ok: false };
      try {
        await withTx(['thumbs'], 'readwrite', tx => { tx.objectStore('thumbs').put({ key: key(accountId, photoId), accountId, photoId: String(photoId), dataUrl, touchedMs: Date.now() }); });
      } catch (error) { return { ok: false }; } // a missing thumbnail only costs one regeneration
      trimThumbs(accountId).catch(() => undefined);
      return { ok: true };
    },

    /* ---- non-secret markers: last signed-in account, pending logout ---- */
    async getMeta(name) {
      const holder = await withTx(['meta'], 'readonly', tx => {
        const out = {};
        const request = tx.objectStore('meta').get(name);
        request.onsuccess = () => { out.row = request.result; };
        return out;
      });
      return holder.row ? holder.row.value : null;
    },
    async setMeta(name, value) {
      try { await withTx(['meta'], 'readwrite', tx => { tx.objectStore('meta').put({ key: name, value, updatedMs: Date.now() }); }); }
      catch (error) { throw friendly(error); }
      return { ok: true };
    },
    async deleteMeta(name) {
      await withTx(['meta'], 'readwrite', tx => { tx.objectStore('meta').delete(name); });
      return { ok: true };
    },

    /* ---- maintenance ---- */
    /* "Keluar dan hapus data perangkat": everything stored for this account, drafts included. */
    async wipeAccount(accountId) {
      accountId = String(accountId);
      await withTx(['drafts', 'draftImages', 'photos', 'thumbs', 'cache', 'meta'], 'readwrite', tx => {
        const range = prefixRange(accountId);
        ['drafts', 'draftImages', 'photos', 'thumbs', 'cache'].forEach(name => tx.objectStore(name).delete(range));
        const meta = tx.objectStore('meta');
        ['lastAccount', 'pendingLogout'].forEach(name => {
          const request = meta.get(name);
          request.onsuccess = () => { const value = request.result && request.result.value; if (value && String(value.accountId || value.id) === accountId) meta.delete(name); };
        });
      });
      return { ok: true };
    },
    async storageEstimate() {
      try {
        if (!root.navigator || !root.navigator.storage || typeof root.navigator.storage.estimate !== 'function') return null;
        const estimate = await root.navigator.storage.estimate();
        const usage = Number(estimate.usage) || 0;
        const quota = Number(estimate.quota) || 0;
        return { usage, quota, ratio: quota > 0 ? usage / quota : 0 };
      } catch (_) { return null; }
    },
    async requestPersistence() {
      try {
        if (root.navigator && root.navigator.storage && typeof root.navigator.storage.persist === 'function') {
          if (typeof root.navigator.storage.persisted === 'function' && await root.navigator.storage.persisted()) return true;
          return !!(await root.navigator.storage.persist());
        }
      } catch (_) { /* best effort */ }
      return false;
    },
    evictPhotos(accountId, options) { assertOwner(String(accountId)); return evictPhotos(String(accountId), options); },
  };
  root.JagaOfflineStore = store;
})(window);
