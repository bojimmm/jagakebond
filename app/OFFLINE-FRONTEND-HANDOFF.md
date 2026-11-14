# Offline frontend implementation handoff

Scope: assigned browser/native adapter and web outbox files only; no production edits. Integration remains staged pending parent acceptance.

## Files
- `frontend/app.js`: account-bound local cache, durable capture enqueue, stable `clientRequestId`, submitted-receipt recovery, signed-out surface/modal reset, owned AI record provenance (`record_<job.id>`, `source: ai`), observedSeverity updates, daily draft escaping, and server-owned image URL adoption. Capture stamping uses the original selected-photo snapshot.
- `frontend/native-adapter.js`: `window.JagaNative` facade, constrained `/api/...` paths, web fallback, and native photo path conversion to object URLs.
- `frontend/offline-store.js`: IndexedDB drafts and account-partitioned cache, duplicate content protection, lock, failure and submitted receipt operations.
- `frontend/offline-sync.js`: open-page outbox sync, retries with stable request ID, retained server-submitted receipts, and auth pause. It does not promise closed-browser web sync.
- `frontend/index.html`, `frontend/sw.js`: sign-in gate inertness and cache shell version.
- `tests/test_offline_browser.cjs`: real Chrome IndexedDB test.

## Verification (last run)
From `app/`:
- `node --check frontend/app.js && node --check frontend/native-adapter.js && node --check frontend/offline-store.js && node --check frontend/offline-sync.js` — passed.
- `node tests/test_offline_browser.cjs` — passed: reload persistence, account isolation, idempotent duplicate, payload conflict, lock, response-loss replay with fixed request ID, and submitted receipt retention.
- `python3 tools/check_frontend.py` — OK, no undefined calls or duplicate definitions.
- `git diff --check` — passed.

## Remaining integration risks / acceptance
The complete online/offline capture-to-analysis lifecycle, response status matrix (including 401/403/409/429/400/413), real native bridge behavior, and current concurrent backend/UI integration have not been independently exercised here. Parent/API reports that server-side AI record creation will persist the owned job thumbnail and return `imageUrl`; that concurrent change was not yet verified by this worker. Submitted browser receipts are retained after enqueue and are cleared only after a safely persisted record/result path; confirm acknowledgement/receipt recovery ordering during parent integration. No closed-browser web sync claim, Android device guarantee, or production deployment is implied.
