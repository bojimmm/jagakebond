# Handoff — JagaKebond (real-use build)

Multi-account PWA + FastAPI backend + FIFO AI worker + admin console, built for a VPS.
Supersedes the MVP described in `PRD.md`; deviations are listed at the bottom.

## Status

| Suite | Result |
|---|---|
| `python verify_mvp.py` (12 suites: migration, auth, CSRF, tenancy, photos, worker boundary, queue + gate, stale claim, admin API, secret leaks, quota, cleanup) | **129/129** |
| `python tests/test_foundation.py` (data + security primitives, offline) | **74/74** |
| `python tests/test_confidence_gate.py` (PRD §6 regression) | **38/38** |
| `python tools/check_frontend.py` (undefined refs, duplicate defs) | **OK** |
| `python -m compileall backend worker tests` | clean |
| Browser: real-use farmer flow (auth gate → real telemetry → enqueue → poll → gated result → logout) | **0 failures** |
| Browser: admin console (login gate, 5 tabs, secret masking, save-only-changes, non-admin denied) | pass, 0 page errors |

## Running it

```bash
pip install -r requirements.txt
cp .env.example .env      # set SECRET_KEY, WORKER_TOKEN, ADMIN_EMAIL/ADMIN_PASSWORD

python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000 --workers 1
python worker/gemini_worker.py           # second terminal
```

Two hard rules:

- **Exactly one uvicorn worker.** SQLite allows one writer; `--workers 2` corrupts data.
  Scaling out means Postgres first (`deploy/README.md` §9).
- **`WORKER_TOKEN` must match** between the `.env` the app reads and the one the worker
  reads. The worker refuses to start without it, and `/api/queue/next` rejects anything
  that is not the worker.

First boot creates the admin from `ADMIN_EMAIL` / `ADMIN_PASSWORD` (or prints a generated
password once), then serves an **empty** install — no demo data.

For a VPS: `deploy/README.md` (systemd units, nginx + TLS, backups, key rotation).

## What "real use" changed

**Demo removed**

- No seeded records. The 4 invented Bogor crops, 1 daily entry and 2 farm polygons are no
  longer inserted; `db.seed_for_account()` remains and runs only when `SEED_DEMO_DATA=1`
  (read once, at first boot).
- `data/db.json` (the demo JSON store) deleted. `db.import_legacy_json()` is kept so an
  upgrade from the old build can still migrate real data.
- The farmer app's hardcoded arrays are gone — `farmRecords` / `dailyRecommendations` start
  empty and load from the API.
- Deleted from the app: `generateLocalAgronomicDiagnosis()` (a three-branch elevation `if`
  that claimed to analyse the photo), `startSimulatedLiveJitter()` (fabricated GPS accuracy
  with no "simulated" label), the fake three-step progress animation, hardcoded 23°C / 85% RH,
  hardcoded elevation 640 / "Zona Sedang", Unsplash stock photos, the "Mode Demo" badge, and
  the invented agronomy claims in placeholder text.
- Registration is **closed by default** (`ALLOW_REGISTRATION=0`); create farmer accounts in
  the console. An open sign-up form on a public box spends your AI quota.

**Made real**

- The farmer app authenticates: auth gate, login, self-service password change, account menu,
  logout. Every list is account-scoped server data.
- `executeCropPathologyAnalysis()` is the real contract: one `POST /api/analyze` returns
  `{job_id, position}` immediately, then polls 4 s → 8 s → up to 120 attempts, offline-tolerant
  (network failures never consume an attempt). The server never holds a request open.
- Telemetry, temperature, humidity and place name come from `/api/telemetry`.
- The stamped photo is uploaded to `/api/photos` and referenced by URL instead of living as a
  multi-megabyte data URL in memory.
- Honest placeholders: elevation / weather / place show `—` until a real reading arrives.

## Two bugs this round, both mine

1. **`initMap()` crashed `window.onload`.** Making the coordinate defaults `null` meant
   `L.map().setView([null, null])`, which throws. That aborted the rest of `onload`, so the
   auth form was never wired, the clock never started and `boot()` never ran — the app looked
   like a dead login screen. The map now opens at country scale and recentres on the first real
   GPS fix.
2. **`cropId` was not writable.** The record PUT allowlist (from the PRD) omitted it, so the
   crop-timeline assignment silently did nothing. Added alongside `farmId`; `needs_review` and
   `confidence` stay server-owned so a client cannot clear a review flag.

Also fixed while testing: the login throttle used to lock the **IP** after 5 failures, which in
rural Indonesia would lock out a whole village behind one CGNAT address. The per-account limit
stays 5; per-IP is now 50.

## Live model calls — VERIFIED (2026-10-12)

A router key was saved and the worker ran against the real provider. Three jobs
processed end to end; every call is now recorded in `job_events` and visible in the
console's **Antrean → Jejak** button:

| Job | Result |
|---|---|
| `job_84203e2a15ca` | triage HTTP 200 (3.9 s) → usable; diagnose HTTP 200 (4.8 s) → Severe 0.85 → posted |
| `job_41a9ed591044` | triage HTTP 200 (3.7 s) → `usable=false, is_plant=false` ("Foto terlalu gelap") → **rejected, diagnose never called** — zero diagnose tokens, proven on a real model |
| `job_5f97a37d2617` | triage HTTP 200 (4.4 s) → usable; diagnose HTTP 200 (4.0 s) → Severe 0.95 → posted |

So the previously-unverified path is now proven: the worker reaches the router, the
prompts return parseable JSON, the triage gate skips the diagnose model for junk, and
the confidence gate is applied server-side to real model output.

Three things to know:

- **Your router reports the served model, not the requested one.** With the models set to
  `gemini-flash-latest` the response body said `"model": "gemini-3.5-flash-lite"`. Check the
  trace detail when you care which model actually answered.
- **Model choice dominates latency.** The same job took **~4 s per call** on
  `gemini-flash-latest` versus **15 s triage / 26 s diagnose** on
  `gemini/gemma-4-26b-a4b-it`. If analysis feels slow, that is the cause — not the queue.
- The two model fields are currently set to the **same** model (`gemini/gemma-4-26b-a4b-it`
  for both triage and diagnose). The PRD wants `gemini/gemma-4-31b-it` for diagnosis.

### Tracing

Every worker step is stored per job (`triage:start`, `triage:http` with status + latency,
`triage:done`, `diagnose:*`, `result:posted`) and surfaced in the console, so "did it
actually contact the provider?" is answerable instead of guessed. The phone also shows the
live stage ("Model triase memeriksa foto…") from the same data.

## NOT verified — read before trusting

1. **`deploy/` has never been executed.** The systemd units, nginx config and runbook are
   written but no service has started and no proxy has run. Treat them as unreviewed-by-runner.
2. **The `cryptography`-missing fallback** is implemented and the console reports it, but it
   was never tested by actually uninstalling the package.
3. **Plant.id** (legacy `/api/diagnose`) is unverified — no key.
4. **n8n** is still deliberately unbuilt (`n8n/README.md`).
5. The token-budget claims (diagnose returning empty below ~800 tokens, the `+600` retry)
   were never triggered, because no call came back empty at the configured budgets.
6. **The harness needs the queue to itself.** With a worker actively claiming, `verify_mvp.py`
   detects it and skips the enqueue→claim→gate round-trip (printing a NOTE) rather than
   reporting a false failure. The gate stays covered by `tests/test_confidence_gate.py`.

## Deviations from PRD.md

| PRD said | Now | Why |
|---|---|---|
| No auth / multi-user | Accounts, roles, per-account scoping | Requested; PRD §14 listed this as a known limit |
| JSON file + one `threading.Lock` | SQLite (WAL) + migrations | Requested for VPS hosting; JSON cannot do multi-account |
| `deviceId` is the only identity | `deviceId` kept as a client hint; ownership is by account | Photos and records must not cross accounts |
| Record PUT allowlist: severity, condition, crop, cropName, immediate_action | + `farmId`, `cropId` | The crop-timeline and farm-assignment flows need them |
| Seeds on first run | Opt-in via `SEED_DEMO_DATA` | Requested: no demo in a real install |
| `GET /api/health` reports models + queue depth | Public health returns `{ok, version}`; detail behind admin auth | It was leaking configuration to anonymous callers |
| `/uploads` static mount | `GET /api/photos/{id}` with an ownership check | The old mount served every user's photos to anyone |

## Environment

All of it is documented in `.env.example`.

| Key | Notes |
|---|---|
| `SECRET_KEY` | Encrypts stored API keys (AES-GCM). Rotating it makes stored keys unreadable — the console flags them and you re-enter. |
| `WORKER_TOKEN` | Shared app↔worker secret. Required. |
| `COOKIE_SECURE` | `1` for HTTPS; `0` only for local http testing. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | First boot only. Change the password after signing in. |
| `ALLOW_REGISTRATION` | Default `0`. |
| `SEED_DEMO_DATA` | Default `0`. Read once, at first boot. |
| `NINEROUTER_URL` / `NINEROUTER_KEY` | Also settable from the console, which wins. The worker re-reads every 60 s. |

## Console (`/admin`)

Ringkasan (accounts, sessions, queue, worker heartbeat, DB size, encryption status) ·
Akun (create / disable / quota / reset / delete, with typed-email delete confirmation) ·
Kredensial API (masked, write-only, "Uji koneksi router") · Antrean (pacing, retries, job
requeue/cancel) · Audit (who changed what, when).
