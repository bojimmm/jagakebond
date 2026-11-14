# Build instructions — JagaKebond MVP from zero

Companion to `PRD.md` (the what). This is the ordered how. Build in the order below; each step ends with a check before moving on.

## 0. Prerequisites

- Python 3.12+, `pip install -r requirements.txt` (`fastapi>=0.115`, `uvicorn[standard]>=0.30`, `python-multipart>=0.0.18`, `httpx>=0.27`, `pillow>=10.0`).
- An OpenAI-compatible LLM router URL + key with vision models (defaults: triage `gemini/gemma-4-26b-a4b-it`, diagnose `gemini/gemma-4-31b-it`).
- Scaffold the tree first:
  `backend/app.py`, `worker/gemini_worker.py`, `frontend/index.html`, `frontend/sw.js`, `frontend/manifest.webmanifest`, `frontend/icons/`, `frontend/vendor/`, `n8n/jagakebond-analyze.json`, `data/` (gitignored `.env`, `__pycache__`, `*.pyc`, `db.json.tmp`).

## 1. Backend skeleton + DB layer

1. Path constants (`BASE_DIR`, `FRONTEND_DIR`, `DATA_DIR`, `UPLOAD_DIR`, `DB_PATH`); create dirs on import.
2. Env reads per PRD section 10. Seed constants (`SEED_RECORDS` 4, `SEED_DAILY` 1, `SEED_FARMS` 2 — copy field shapes from PRD section 9).
3. `load_db()` (create-from-seeds if missing, `setdefault` all four keys), `save_db()` (write temp file + atomic replace), module `_lock = threading.Lock()`, `_now_ms()`.
4. Check: `python -c "import backend.app"` creates `data/db.json` with 4/1/2 seeds.

## 2. Records / daily / farms / photos CRUD

Build in this order, testing each with curl: `GET /api/records` → `POST /api/records` (auto-id `rec_<hex12>`, upsert by id, newest first) → `PUT` (allowlist only) → `DELETE`. Same pattern for `daily` (`daily_<hex12>`). Farms (`farm_<hex12>`): require `ring`, run `_validate_ring` (≥4 positions, auto-close, ≥3 distinct vertices, numeric, lat/lng range) on create and on ring patch. `POST /api/photos`: 12 MB cap, Pillow verify, 1600px JPEG q85 into `data/uploads/`, return `/uploads/<uuid>.jpg`.

## 3. Telemetry + legacy diagnose

`GET /api/telemetry?lat=&lng=`: `asyncio.gather` the three upstream calls (15 s timeout, `return_exceptions=True`), parse elevation array, `current.temperature_2m` / `relative_humidity_2m`, BigDataCloud city + top-2 admins (`localityLanguage=id`); nulls on any failure. Check: real Bogor coords return elevation + `°C • % RH` + Indonesian place name.
`POST /api/diagnose`: 12 MB cap + `Image.verify()`; Plant.id path when key set (map per PRD section 8, catch exceptions into heuristic + `fallback_error`); else `_heuristic_diagnosis(elevation)` three-branch.

## 4. AI queue endpoints (the core — build carefully)

1. `POST /api/analyze`: read multipart fields per PRD; 12 MB cap; Pillow → RGB → 1024px thumbnail → JPEG q82 → base64 into `job.image_b64`; `job_<hex12>`, status `queued`, context object, `triage/diagnosis/error=None`; append under lock, compute `_queue_position`, best-effort `_maybe_trigger_n8n` (fire-and-forget task, never fail the request); return `{job_id, status, position}`.
2. `GET /api/analyze/{id}`: `_sanitize_job` (strip `image_b64`), add `position` while pending; 404 unknown.
3. `GET /api/queue/next?worker=`: under lock, first demote stale `claimed` (>300 s) to `queued`; claim oldest `queued` (sort `createdMs`), attempts+1, stamp worker/ms; return job **with** `image_b64`; `{job: None}` when empty.
4. `POST /api/analyze/{id}/result`: require `triage` + `diagnosis` dicts; 409 if not queued/claimed; if `triage.usable` falsy → `rejected` + error=reason; else `_apply_confidence_gate(diagnosis)` → `done`.
5. `POST .../ack`, `GET /api/queue/pending?deviceId=`, `GET /api/queue` (depth = queued+claimed, byStatus, recent 20 trimmed).
6. Implement `_apply_confidence_gate` exactly per PRD section 6, then unit-test it offline (no models needed): Severe@0.4→Moderate+review; Severe@0.6→Moderate+review; Healthy@0.3 stays Healthy+review; pesticide text @0.65 stripped; confidence clamped/rounded.

## 5. Worker

Stdlib only (`urllib`). Implement `_http`, `router_chat_json` (image_url data-URI part, temp 0.2, 180 s timeout, 429/503→`RateLimited`, 401→key error, empty-reply→single +600 retry when `max_tokens<1200`), `_extract_json` (direct parse, else first `{...}` span), `build_context_text`, `process_job` (triage@600 → diagnose@2500 → post result; rejected triage posts `{severity Moderate, confidence 0, needs_review True}`), `main()` loop (claim → process → pacer sleep; backoff doubling from 30 s on rate-limit; 10 s on loop error). Copy the Indonesian triage/diagnose prompts from PRD section 7 verbatim. Refuse to start without `NINEROUTER_KEY` (message, exit 1).

## 6. Frontend (largest step — build tab by tab)

Single `index.html` (~3000 lines), Tailwind CDN + Leaflet 1.9.4 CDN + Lucide + exifr CDN; Geoman + Turf vendored. Order: (a) shell + bottom nav + four tab containers; (b) Home (GPS stamp + carousel + daily card); (c) Scan (camera → review → progress → result → stamp/assign); (d) Map (Leaflet + Geoman draw + GPS trace + bottom sheet + farm panel); (e) Log (grouped history + search + daily editor + export); (f) modals (crop-assign, daily, farm, date-picker, status).
Wire `apiBase` (same origin), `deviceId` persistence, farm cache sync, `handleImageSelected` → `executeCropPathologyAnalysis` (enqueue) → `pollAnalysisJob` (4 s / 8 s / 120 attempts) → `finishQueuedAnalysis` → stamp → assign → timeline; `recoverPendingJobs` on launch; `GET /api/telemetry` for the stamp; `downloadStampedPhoto` via canvas bake.
Camera: `getUserMedia` portrait 4:3, flip button re-acquires with `facingMode` toggled, `layoutScanFrame` keeps the frame inside the viewport (no page scroll in Scan).

## 7. PWA shell + static hosting

`sw.js` (`jk-v2`, app-shell list, `jk-tiles-v1`/`jk-api-v1`, network-first API, stale-while-revalidate images/uploads, navigate→cached `index.html`); `manifest.webmanifest` (standalone, portrait, `id`, green theme); 4 icons; vendor Geoman JS/CSS + Turf locally. Backend: `GET /sw.js` (no-store JS), `GET /manifest.webmanifest`, mount `/uploads`, mount `/` with `html=True` last.

## 8. Env, run, verify

`cp .env.example .env`, fill `NINEROUTER_URL` + `NINEROUTER_KEY`. Terminal 1: `uvicorn backend.app:app --host 127.0.0.1 --port 8000`. Terminal 2: `python3 worker/gemini_worker.py`. Verify in order: health → telemetry → seed lists → photo upload → enqueue (returns position 0) → claim via curl → post a canned result → status `done` → gate behavior → restart worker for the live round-trip with a real plant photo → phone-poll flow → restart recovery (`pending` then `ack`). Then PWA: install prompt, offline shell load, map draw + trace, log search + export.

## 9. n8n (optional, last)

Import `n8n/jagakebond-analyze.json`; Header Auth `Authorization: Bearer <key>` into both Router nodes; env `NINEROUTER_URL` + both models; diagnose node `max_tokens` 2500; fix backend URLs; activate; paste webhook into `.env`; concurrency 1. The poll loop stays the reliable path — the webhook is best-effort.

## 10. Pitfalls (all hit in the real build)

- `gemma-*-local` combos silently return a non-Gemma model. That is now an accepted choice when you want a non-Gemma model; the console accepts any single route name without spaces.
- Diagnose `max_tokens` below ~2500 (triage below ~600) returns empty replies — this is reasoning-budget starvation, not a broken model.
- `GET /v1/models/image-to-text` returning `[]` does not mean vision is broken; vision rides the chat endpoint.
- Keep one uvicorn worker (the JSON lock is single-process). Never commit `.env`. Never expose keys to the phone.
- Photo EXIF orientation: bake rotation into the canvas stamp before upload.
