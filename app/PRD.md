# PRD — JagaKebond MVP (rebuild from scratch)

- Version: 1.0 (reconstructed 2026-10-10 from live-tested build of 2026-10-05)
- Status: buildable spec. Source bundle: `dist/jagakebond-mvp-bundle.zip` (19 files).
- Language: Bahasa Indonesia UI (`lang: id`). Audience: smallholder farmers, mobile-first, portrait phones.

## 1. Product summary

JagaKebond MVP is a full-stack installable PWA: a mobile-first geotagged crop camera plus AI disease diagnosis. The farmer takes one photo, gets `{job_id, position}` instantly, keeps working while the phone polls in the background, and the result lands in a per-crop timeline. Farm boundary polygons, daily recommendations, and a diagnosis history round out the app. Everything must work on flaky farm connectivity (offline-tolerant polling, app-shell + tile caching).

## 2. Architecture and repo layout

```
jagakebond-mvp/
  backend/app.py          FastAPI: API + static PWA host (~824 lines)
  worker/gemini_worker.py FIFO AI worker, stdlib only (~252 lines)
  frontend/index.html     Single-file PWA UI (~3032 lines, ~144 KB)
  frontend/sw.js          Service worker (app-shell offline, API network-first)
  frontend/manifest.webmanifest
  frontend/icons/         apple-touch-icon, icon-192, icon-512, maskable-512
  frontend/vendor/        leaflet-geoman.min.js/.css, turf.min.js (vendored, offline)
  n8n/jagakebond-analyze.json  Optional 9-node workflow (replaces/augments worker)
  data/db.json            JSON-file DB (seeded; recreated from seeds if deleted)
  data/uploads/           Stamped photo storage (empty at build)
  requirements.txt        fastapi, uvicorn[standard], python-multipart, httpx, pillow
  .env.example            Single place for secrets (never commit .env)
  QUEUE_SETUP.md, handoff.md (docs)
```

Stack rules: no frontend build step (one HTML file + vendored JS). Backend serves the PWA statically. Keys live only in process env / `.env`; the phone app never sees any key.

## 3. Frontend requirements (`frontend/index.html`)

Four bottom-nav tabs, `navigateToMenu('home'|'scan'|'map'|'log')`:

- **Home**: live GPS stamp (clock, coords, location name, MSL elevation, weather), history carousel (latest records), daily recommendation card, zone label.
- **Scan**: non-scrollable 4:3 vertical camera viewfinder, snap button, front/back flip inside viewfinder, photo review controls, run-analysis button, progress bar + step text, queue position line, result card (severity badge, crop/condition, geo brief), stamped-result actions (download stamped photo, assign crop). Manual date picker modal ("Kapan Foto Ini Diambil?"). Old-photo import with EXIF read (exifr CDN) for GPS/timestamp fallback. Demo sample loader for testing.
- **Map**: Leaflet 1.9.4 map of problem points (severity-colored markers), farm polygons (Geoman draw, GPS trace via `watchPosition`), farm list panel with count badge, bottom-sheet record detail, layer-mode label, filter points.
- **Log (Riwayat)**: diagnosis history grouped by crop, search filter, status-change modal, daily recommendations list + editor modal, export logs to JSON.

Key client behaviors:

- `deviceId`: generated once, persisted in `localStorage 'jk_device_id'`.
- Farms cached in `localStorage 'jk_farms_v1'`, synced with `/api/farms`.
- Enqueue: `POST /api/analyze` (multipart image + lat/lng/elevation/locationName/accuracy/weather/photoDate/photoTimestampMs/farmId/deviceId) → store `job_id`, start `pollAnalysisJob`: first poll at 4 s, then every 8 s, up to 120 attempts (~16 min), offline-tolerant (network errors do not consume attempts terminally; keep polling). Show queue position while pending. On `done`, run stamp → crop-assign → timeline flow. On `rejected`, show "foto ditolak triase" + reason.
- Restart recovery: on launch, `GET /api/queue/pending?deviceId=` and resume unacked done jobs; `POST /api/analyze/{id}/ack` after the farmer sees each result.
- Camera/photo limits: reject empty or >12 MB files client-side before upload.
- PWA: `sw.js` cache version `jk-v2`; app-shell (`index.html`, manifest, vendored Geoman + Turf) cached offline; tiles/API network-first with cache fallback; navigations fall back to cached `index.html`. Manifest: `display: standalone`, `orientation: portrait`, theme `#16a34a`, id locale. Google Sans style font.

## 4. Backend API contract (`backend/app.py`)

| Method + path | Input | Output |
|---|---|---|
| `GET /api/health` | — | `{ok, plantAi, gemini, router, triageModel, diagnoseModel, n8n, queueDepth}` |
| `GET /api/telemetry?lat=&lng=` | floats | `{lat, lng, elevation, tempC, rh, weather, locationName}` (each nullable on upstream failure) |
| `POST /api/diagnose` | multipart `image` + `lat, lng, elevation, locationName, accuracy, weather` | diagnosis `{crop, condition, severity, probability, symptoms, geocorrelation, immediate_action, suitability, source}`; Plant.id when `PLANT_ID_API_KEY` set, else elevation heuristic |
| `POST /api/analyze` | multipart `image` + `lat, lng, elevation, locationName, accuracy, weather, photoDate, photoTimestampMs, farmId, deviceId` | `{job_id, status: queued, position}`; image downscaled to 1024px JPEG q82 base64 stored in job |
| `GET /api/analyze/{id}` | — | job sans `image_b64`, plus `position` while queued/claimed |
| `GET /api/queue` | — | `{depth, byStatus, recent[20]}` |
| `GET /api/queue/next?worker=` | worker name | `{job}` oldest queued (with `image_b64`), stale claimed (>300 s) auto-requeued first; attempts incremented |
| `POST /api/analyze/{id}/result` | `{triage, diagnosis}` | updated job; confidence gate re-applied; 409 if already terminal |
| `POST /api/analyze/{id}/ack` | — | `{ok: true}` |
| `GET /api/queue/pending?deviceId=` | — | done-but-unacked jobs (restart recovery) |
| `GET/POST /api/records`, `PUT/DELETE /api/records/{id}` | record JSON (PUT allowlist: severity, condition, crop, cropName, immediate_action) | record / `{ok: true}` |
| `GET/POST /api/daily`, `DELETE /api/daily/{id}` | entry JSON | entry / `{ok: true}` |
| `GET/POST /api/farms`, `PUT/DELETE /api/farms/{id}` | farm JSON with `ring: [[lat,lng]...]` (PUT allowlist: name, crop, note, ring, areaM2, updatedMs) | farm / `{ok: true}` |
| `POST /api/photos` | multipart `file` | `{url: /uploads/<uuid>.jpg}` (1600px JPEG q85) |
| `GET /sw.js`, `GET /manifest.webmanifest` | — | service worker (Cache-Control: no-store), manifest |
| `/uploads/*`, `/*` | — | static uploads dir; frontend dir with `html=True` |

Validation rules: images empty or >12 MB → 400; invalid image bytes → 400; farm ring must be ≥4 positions closed (auto-close), ≥3 distinct vertices, numeric `[lat, lng]` in range, else 400; missing job/record/farm → 404.

## 5. Queue state machine

`queued` → `claimed` (via `/queue/next`, attempts+1, claimedMs set) → `done` (triage usable) or `rejected` (triage `usable=false`, error = triage reason). Stale `claimed` older than `QUEUE_STALE_CLAIM_SEC` (default 300) returns to `queued` on the next claim call. `QUEUE_MAX_ATTEMPTS` default 3 (enforced by worker/n8n, not the server). `acked=true` set by phone after display. All DB access under a single `threading.Lock`; writes via temp-file replace.

## 6. Confidence gate (server-side, deterministic — re-applied on every result post)

Given `{severity, confidence, immediate_action}`: normalize severity to `Severe|Moderate|Healthy` (else `Moderate`); clamp confidence to 0..1, round 3 dp. If `confidence < 0.5`: `Severe→Moderate`, `Healthy` stays, else `Moderate`; force `needs_review=true`; default the action to a re-photo/POPT-consultation line if empty. If `0.5 ≤ confidence < 0.7` and `Severe`: downgrade to `Moderate`, force `needs_review=true`. If `confidence < 0.7` and the action names a pesticide (`fungisida|insektisida|bakterisida|pestisida`) without mentioning consultation (`konsultas`): replace with isolate-and-monitor + consult-POPT text. Never trust raw model severity alone.

## 7. Worker contract (`worker/gemini_worker.py`, stdlib only)

Loop: `GET /queue/next?worker=` → if no job, sleep `QUEUE_PACER_SECONDS` (default 25); else triage call → if usable, diagnose call → `POST /result`. `429/503` → exponential backoff from `QUEUE_BACKOFF_BASE` (default 30 s), job left to stale-claim requeue. Any other failure → log, sleep pacer (server requeues on stale claim). Empty model reply → one retry at +600 tokens, then fail the job.

- Transport: `POST {NINEROUTER_URL}/v1/chat/completions`, OpenAI-compatible `image_url` part (`data:image/jpeg;base64,...`), `temperature: 0.2`, `stream: false`, timeout 180 s. `401` → fix `NINEROUTER_KEY`.
- Triage: model `gemini/gemma-4-26b-a4b-it`, `max_tokens=600`. Native vision, ~2.5K tok/job. Output JSON only: `{usable: bool, is_plant: bool, reason: string}`; `usable=true` only if the photo is clear enough and shows a plant.
- Diagnose: model `gemini/gemma-4-31b-it`, `max_tokens=2500` (model spends ~750 reasoning tokens first; ≤800 returns empty). Native vision, ~3.3K tok/job. Prompt is an Indonesian agronomist instruction plus field context line: location ±accuracy, farm name/area, elevation, weather, photo date, ≤2 history lines. Output JSON only: `{crop, condition, severity, confidence 0..1, symptoms_id, immediate_action_id, needs_review}` in Bahasa Indonesia; pesticide names only if `confidence ≥ 0.7`; never invent GPS/elevation.
- Economics: ~6K tok/job total; 16K TPM ÷ 6K ≈ 2.4 jobs/min; 14.4K RPD ≈ ~2,400 photos/day; a 20-photo burst drains in ~8 min at 25 s pacing.
- **Model routes: every router route is accepted, including non-Gemma/non-Gemini models (`openai/gpt-4o-mini`), `gemma-*-local` combos and plain combo names. The console rejects only an empty route or one containing spaces. The defaults stay on direct `gemini/gemma-*` routes.**

## 8. Telemetry + legacy diagnose

- Telemetry fans out (15 s timeout, `return_exceptions`, degrade to nulls): Open-Meteo elevation API, Open-Meteo forecast (`current=temperature_2m,relative_humidity_2m`), BigDataCloud reverse-geocode-client (`localityLanguage=id`, city + top-2 admin names).
- Legacy `POST /api/diagnose`: Plant.id (Kindwise) when key set (healthy-or-no-disease → Healthy; top disease `p ≥ 0.6` → Severe else Moderate); otherwise elevation heuristic (`>800` highland mist/leaf-spot Moderate; `≥400` midland rust Severe; else lowland fruit-spot Moderate). Always honest fallback text: AI is a first suggestion, confirm in the field.

## 9. Data model + seeds

`db.json`: `{records[], daily[], farms[], queue[]}`. Record: `id, cropId, cropName, timestampMs, crop, condition, severity, lat, lng, elevation, locationName, accuracy, date, symptoms, geocorrelation, immediate_action, suitability, imageUrl`. Daily: `id, date, timestampMs, title, summary, actions[], sourceRecordIds[], zones[]`. Farm: `id, name, crop, note, ring[[lat,lng] closed], areaM2 (client-computed via Turf), source, createdMs, updatedMs`. Job: `id, status, attempts, createdMs, updatedMs, claimedMs, worker, deviceId, image_b64, context{lat,lng,elevation,locationName,accuracy,weather,photoDate,photoTimestampMs,farmId}, triage, diagnosis, error, acked`. Seeds: 4 Bogor crop records (kopi/cabai/jagung/teh), 1 daily entry, 2 farm polygons. Deleting `db.json` resets to seeds.

## 10. Env config (`.env`, never committed)

`NINEROUTER_URL` (default `http://localhost:20128`), `NINEROUTER_KEY` (only if router requires auth), `GEMINI_TRIAGE_MODEL`, `GEMINI_DIAGNOSE_MODEL` (defaults above), `GEMINI_API_KEY` (fallback only, not needed), `N8N_ANALYZE_WEBHOOK` (optional), `QUEUE_PACER_SECONDS=25`, `QUEUE_STALE_CLAIM_SEC=300`, `QUEUE_MAX_ATTEMPTS=3`, `PLANT_ID_API_KEY` (legacy, optional).

## 11. n8n (optional, replaces or augments worker)

9 nodes: Webhook (analyze job) → Respond-to-webhook ACK → HTTP Router triage (Gemma 26B) → Code parse-triage → IF usable? → HTTP Router diagnose (Gemma 31B, `max_tokens` 2500) → Code confidence gate → HTTP post-result / HTTP post-rejection. Concurrency 1. Backend also best-effort pushes each new job to the webhook, but the `queue/next` poll loop is the reliable path.

## 12. Non-functional requirements

Single uvicorn worker (`threading.Lock` DB, one process); photo caps above; Indonesian-language AI and UI; coordinates EPSG:4326, areas in m²; offline-tolerant queue polling; vendored Geoman + Turf so the map works offline (Leaflet core, Tailwind, Lucide, exifr stay CDN).

## 13. Acceptance criteria

1. `GET /api/health` reports models + queue depth. 2. Telemetry returns elevation/weather/place with no keys. 3. Enqueue → claim → triage → result round-trip completes end-to-end; phone poll shows position then diagnosis. 4. Triage rejects a non-plant photo with reason; junk never spends diagnose tokens. 5. Confidence gate downgrades + strips pesticide names at low confidence (unit-testable without models). 6. Stale claims requeue after 300 s; unacked done jobs resume after phone restart. 7. Seeds load on first run; PWA installs (manifest + icons + offline shell). 8. No secret is reachable from the phone or committed to disk.

## 14. Out of scope / known limits

No auth or multi-user (`deviceId` is client-set; queue/records global). JSON-file DB does not scale past one process (path: SQLite, then Postgres). No automated tests in the MVP (first upgrade: `pytest` + router mock). Direct `gemini/` routes bill the router's Gemini provider account.
