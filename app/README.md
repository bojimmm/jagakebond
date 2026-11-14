# JagaKebond 2.1.0

Indonesian-language crop observation app with a responsive desktop/tablet/phone web UI and a bundled Android private-test client (`jagake.bond.app`). Capture is local-first; AI processing happens on the server after an authenticated, duplicate-safe upload.

**Release boundary:** source/build verification is separate from production deployment and physical Android validation. Read the release handover and verification report before rollout. A debug-signed APK is for private testing, not a Google Play release. New clients must wait for a compatible 2.x backend (minor version 1 or later) rather than upload to the earlier 2.0 API.

## Main behavior

- The phone camera preserves a portrait 3:4 viewfinder and aligned shutter/gallery controls. Desktop uses a navigation rail and wider working layouts rather than a handset frame.
- Web captures are committed to account-partitioned IndexedDB before sending. Reload/reconnection reuses the same `clientRequestId`; an identical retry returns the same server job without an additional quota charge. Changed content under that key is rejected.
- Android bundles the UI locally. Its native bridge uses app-private Keystore/JCA AES-GCM session/outbox storage and WorkManager with a network constraint. Logout locks retained drafts; the same account must authenticate again to resume.
- An accepted upload continues through the server queue independently of whether the phone remains open. Completed owned jobs create authoritative records and retain the actual photo. Results are acknowledged only after successful record persistence.
- AI severity, score and classification are distinct from editable farmer observations (`observedSeverity`). The model score is **not a calibrated disease probability**. Structured nonchemical assessments provide findings, causes, actions, prevention, monitoring and escalation. Chemical/fertilizer product references require explicit opt-in and field context; unverified registration/labels never unlock application instructions. Legacy treatment fields retain their fixed fallback. The legacy heuristic diagnosis endpoint is disabled.
- Farm rings are WGS84 decimal-degree `[latitude, longitude]`; GeoJSON/Turf uses `[longitude, latitude]`. Farm area is a client spherical estimate in m², **not an ellipsoidal cadastral/survey measurement**. Phone GPS, EXIF, terrain elevation and timestamps have uncertainty; missing values must remain missing, and zero is valid.

## Local development

The tested backend interpreter is Python 3.12.3; Node 22 and Java 21 are used for build tooling. `requirements.txt` remains compatible with the existing deployment. Use an isolated virtualenv and keep real credentials only in a private `.env` file:

```sh
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
cp .env.example .env
chmod 600 .env
```

Set `SECRET_KEY`, `WORKER_TOKEN`, and explicit first-run admin credentials privately. Registration is closed by default. Configure the private AI gateway/model routes from the administrator console; keys never belong in the APK or browser source.

Run one application worker:

```sh
.venv/bin/python -m uvicorn backend.app:app --host 127.0.0.1 --port 8010 --workers 1
.venv/bin/python worker/gemini_worker.py
```

For local HTTP testing only, set `COOKIE_SECURE=0`; production stays HTTPS with secure cookies. The worker's `API_BASE_URL` must point to the same loopback application port. Camera/geolocation require a secure browser context (localhost or HTTPS).

SQLite serializes writes; it does not inherently corrupt merely because another process exists. This application's queue pacing and some locks are process-local, so the supported deployment deliberately remains **one uvicorn process**. Scaling requires a separately reviewed design.

## UI rebuild

Runtime CSS, JS, fonts and map-editing libraries are bundled locally. No runtime CDN is required for the app shell. From the project root, install the pinned UI build dependencies, then build from their documented working directory:

```sh
npm ci --prefix review/ui-build
npm --prefix review/ui-build run build:css
```

The build resolves content paths relative to its configuration; regression tests verify the compiled stylesheet contains essential layout/visibility utilities. Map tiles are a separate online dependency: do not bulk-download or promise an offline basemap. Provider attribution and licence terms still apply.

## Verification

Use only disposable fixtures, never a live production database or deployment port. The HTTP harness refuses its former production-like default. From the project root:

```sh
JK_TEST_PYTHON="$PWD/app/.venv/bin/python" app/.venv/bin/python review/run_http_acceptance.py
npm ci --prefix review/browser-tools
JK_TEST_PYTHON="$PWD/app/.venv/bin/python" app/.venv/bin/python review/run_browser_acceptance.py
```

Standalone suites from `app/`:

```sh
.venv/bin/python tests/test_foundation.py
.venv/bin/python tests/test_confidence_gate.py
.venv/bin/python tests/test_queue_hardening.py
.venv/bin/python tests/test_api_contract.py
.venv/bin/python -m unittest tests.test_release_restore tests.test_release_transaction tests.test_release_orchestration
.venv/bin/python tools/check_frontend.py
```

Browser tests use real Chromium, IndexedDB, a service worker and a disposable FastAPI server. Their worker diagnoses are **explicit synthetic fixtures**, not evidence of live model performance or agronomic validity. Read the verification report for the exact executed commands, results and device-testing limits.

## Android build and deployment

See `android-client/FINAL-ANDROID-HANDOFF.md` / `ANDROID-HANDOFF.md` for the actual build toolchain and commands. Re-sync/rebuild the APK after any frontend change; verify bundled-asset hashes, application identity, minimum/target SDK and signature.

Production replacement is an administrator action, not a source-copy shortcut. The canonical VPS tool is `/srv/sites/jagake.bond/ops/release_ops.py`; its embedded source copy in an application release is not the production entry point. See `deploy/README.md` and `deploy/RELEASE-RUNBOOK.md` for the real app/runtime/release layout, fresh off-host backup requirement, journaled publication and recovery boundaries. Restore rewinds data and requires reconciliation of later submissions. Do not weaken source permissions or bypass host privilege restrictions.
