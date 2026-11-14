# JagaKebond 0.2.2.0 "fix-all" — shared contract for all implementers

The owner approved fixing the audit findings (`E:/Agent/Claude/VPS Management/JagaKebond-audit-20261021.md`, read it),
implementing the reviewed photo-cleanup design (card t_5bdaea7a), optimizing the UI/UX, and deploying. The lead
(orchestrator) integrates, runs the full regression, packages and deploys. You implement ONE area. Quality over
breadth: the owner will test the app on a real phone and wants it in a good state. Do not break existing behaviour;
never weaken an existing test to get green.

## 1. Ground rules

- Local working tree (a git repo, baseline committed): `E:/Agent/Claude/VPS Management/jagakebond-0220/work`
  (below: `work/`; note the SPACE in the path — always quote it). Edit ONLY files in your ownership list (section 4).
  Do NOT `git commit`, `git checkout`, `git stash`, `git reset` or `git clean` — the lead commits after review.
  Several implementers edit this tree at the same time: always Read a file immediately before each Edit; if an Edit
  fails because the file changed, Read again.
- Never touch production (the VPS, jagake.bond), never read `.env`/secrets/real data, never install system packages,
  never change the Android signing key. Tests use synthetic fixtures only.
- UI language is Bahasa Indonesia (all new user-visible text, simple words for farmers). Keep the green/white
  field-journal identity, Google Sans, the leaf branding and the camera workflow. Touch targets >= 44 px.
- Preserve: account-scoped drafts, `clientRequestId` idempotency, tree `cropId` continuity, missing GPS stays missing,
  manual positions never claim GPS accuracy, server-owned diagnosis/safety fields, the non-chemical safety policy.
- Every fix gets a regression test where a test setup exists (backend Python test scripts in `app/tests/`, Node
  `node --test` files, Playwright/Chromium harnesses in `review/browser-tools/`, Android JVM tests). Prefer a test
  that fails without the fix. Keep tests deterministic and fast.
- Keep diffs focused. No drive-by refactors, no new dependencies (Python, npm, Gradle) unless your brief says so.

## 2. Testing on the InstaBox sandbox (where the toolchain lives)

Helpers (Git Bash): `T="E:/Agent/Claude/VPS Management/jagakebond-0220/tools"`
- `"$T/jk-push.sh" <your-work> <paths...>` copies your CURRENT local files (paths relative to `work/`, e.g.
  `app/backend app/tests/test_x.py`) into your own sandbox test copy. Push only your own paths.
- `"$T/jk-run.sh" <your-work> '<command>'` runs a shell command there (cwd = the copy root, which contains `app/`,
  `android-client/`, `review/`). Env: `$PY` (Python 3.13 with deps), `$TMPDIR` (short path, required for Chromium),
  `JAVA_HOME`, `ANDROID_HOME`, `$E` (evidence dir). Examples:
  - `"$T/jk-run.sh" work-be1 'cd app && $PY tests/test_queue_hardening.py'`
  - `"$T/jk-run.sh" work-web 'cd review/browser-tools && node offline-faults.cjs'`
  - `"$T/jk-run.sh" work-and 'cd android-client/android && ./gradlew --no-daemon --max-workers=2 testDebugUnitTest'`
- `"$T/jk-pull.sh" <your-work> <remote relative path> <local dir>` copies files back (screenshots, logs) to look at.
  Put pulled files under `E:/Agent/Claude/VPS Management/jagakebond-0220/pulled/<your-work>/`.
- The full suite list is in `review/verify_release.py` (+ history/focused suites added by the lead's runner). Run the
  existing suites that cover your area plus your new tests. The lead runs the full 49+ regression on the merged tree.
- Baseline on the unchanged copy: 49/49 suites PASS (2026-10-21). Any failure after your change is yours to explain.
- Be gentle with the machine (4 vCPU, shared with the owner's live browser): one heavy job at a time.

## 3. Release identity

- Release **0.2.2.0**. Android versionCode **14**, versionName `0.2.2.0`. Protocol `APP_VERSION` stays `2.1.0` (clients
  gate on major 2 / minor >= 1; release tooling pins 2.1.0). Schema version is **9** (the lead already added the
  v9 migration skeleton in `app/backend/db.py` with the job backoff columns; BE2 appends the storage tables to v9).
- `/api/health` keeps `{ok, version:"2.1.0", capabilities:{treeContinuity:true, ...}}` and ADDS capability flags
  `recordsPaging:true`, `accountBinding:true`, `photoLifecycle:true`, plus `release:"0.2.2.0"`.
- Web cache: service worker shell cache becomes `jk-v19` (single source of truth, see 5.7). Bump the `?v=` query of
  every web module you change (index.html and sw.js SHELL_ASSETS must agree).

## 4. Ownership (edit only your files; new files inside your area are fine)

| Implementer | Owns |
|---|---|
| **BE1** queue, worker, field API (sandbox copy `work-be1`) | `app/backend/api_app.py` (EXCEPT the three functions owned by BE2 below), `app/backend/queue.py`, `app/backend/version.py`, `app/worker/**`; existing tests `test_queue_hardening.py`, `test_api_contract.py`, `test_confidence_gate.py`, `test_fast_tiers.py`, `test_history_media_216.py`, `test_telemetry_217.py`, `test_telemetry_hooks_218.py`, `test_reverse_geocode_218.py`, `test_worker_transport.py`; new `app/tests/*_0220.py` files for its fixes |
| **BE3** platform security (`work-be3`) | `app/backend/app.py`, `app/backend/auth.py`, `app/backend/security.py`, `app/deploy/jagakebond.service`, `app/deploy/jagakebond-worker.service`, `app/deploy/nginx.conf`, `app/.env.example`; existing test `test_foundation.py`; new `app/tests/test_security_0220.py` |
| **BE2** photo lifecycle (`work-be2`) | new `app/backend/storage.py`, `app/backend/db.py` (extend the schema 9 migration; helpers), `app/deploy/release_ops.py` + `app/deploy/RELEASE-RUNBOOK.md` (only for storage/snapshot integration), existing tests `test_release_*.py`; in `api_app.py` ONLY the functions `_store_photo_sync`, `_delete_photo_for_url` and the recovered-photo block inside `create_record` (the `record_<job>` image publication, around lines 500-520); new `app/tests/test_photo_lifecycle_0220.py` |
| **ADM** admin console (`work-adm`) | `app/frontend/admin.html`, new `app/frontend/admin.js`, `app/backend/api_admin.py`, `app/backend/settings_store.py`, `review/browser-tools/security-ui.cjs` (if it covers admin), new `app/tests/test_admin_0220.py`, new `review/browser-tools/admin-0220.cjs` |
| **WEB** field app (`work-web`) | `app/frontend/` (everything EXCEPT `admin.html`/`admin.js`), `app/tools/check_frontend.py`, `app/tools/tailwind.*`, `app/tests/*.cjs`, existing `app/tests/test_ui_contract.py`, `review/browser-tools/*.cjs` (except security-ui.cjs), `review/history-continuity-0219/*` harness files, CSS rebuild via `review/ui-build` |
| **UX** field-app UI/UX (`work-ux`) | shares `app/frontend/` with WEB exactly as split in `work/UX-BRIEF-0220.md` ("Ownership split"): Beranda, Peta, Riwayat lists/timeline/daily, other modals, login, `styles.css`, `daily-log.js`, Tailwind rebuild; WEB keeps the scan flow, drafts/sync and its reliability list. Both must Read immediately before every Edit. |
| **AND** Android (`work-and`) | `android-client/**` except `android-client/www/` (the lead syncs `www/` from `app/frontend` at the end) |

If you need a change in someone else's file, do not make it: describe it exactly in your final report ("request to X").
Edit only the existing test files you own; add new test files freely. If a change legitimately breaks an assertion in
a test you do not own, report it (file:line, old vs new expectation) instead of editing it.
`app/frontend/vendor/tailwind.generated.css` is a generated file shared by the field app and the admin page: rebuild it
locally to test, but the lead regenerates it once at merge time.

Startup hooks (BE3 owns `app.py`): BE3's lifespan starts ONE background maintenance thread that every hour calls
`queue.run_maintenance()` (BE1 provides: job purge incl. unacked terminal jobs > 90 days) and
`security.purge_retention()` (BE3: login_attempts > 30 days, audit_log > 400 days), and calls
`storage.start_background_drainer(app)` (BE2 provides). Until the other side lands, guard each call with
`getattr(module, name, None)` so the app still starts. BE1 removes the inline `purge_old_jobs_occasionally()` call
from the analyze route.

## 5. Cross-cutting decisions (all implementers follow these exactly)

### 5.1 Records paging (BE1 server, WEB client)
`GET /api/records` without `limit` keeps the legacy response (full JSON array, same order as today) for old clients.
With `?limit=N` (1..500) and optional `&cursor=<opaque>` it returns `{"items":[...], "next": "<opaque>" | null}` in
the SAME order as the legacy list. The cursor is opaque to clients. WEB fetches pages of 200 until `next` is null.
The native bridge must allow `limit`/`cursor` query strings on `/api/records` (AND verifies its allowlist).

### 5.2 Account binding (BE3 server in `auth.current_account`, WEB client)
Web requests to `/api/*` (except `/api/auth/login`, `/api/auth/register`, `/api/health`) send header
`X-JK-Account: <account id>` when an account is active in the tab. If the header is present and differs from the
session's account, the server answers **409** `{"detail":"Akun di perangkat ini sudah berganti. Muat ulang aplikasi.","code":"account_mismatch"}`
and does nothing. No header = allowed (old clients, native bridge). WEB: on `account_mismatch` stop sync, keep drafts,
force a reload/sign-out of the stale tab. WEB also broadcasts login/logout across tabs with `BroadcastChannel('jk-account')`.

### 5.3 Error shape and new limits (BE1)
Errors stay `{"detail": "<Bahasa message>"}`, optionally with `"code"`. New limits:
- Pending analyses per account (status queued+claimed, any tier): max **30** -> `429` `code:"queue_full"`,
  `Retry-After: 60`. Global queued+claimed max **600** -> `429` `code:"queue_busy"`, `Retry-After: 120`.
  Idempotent replays of an existing `clientRequestId` are never blocked by the caps.
- Text fields are sanitised (control characters removed, newlines collapsed for prompt-bound fields) and TRUNCATED
  (not rejected, so old offline drafts still send): `locationName` 200, `weather` 120, `photoDate` 40, `deviceId` 64,
  `cropHint` 80 (existing), farm `name` 120, farm `crop` 80, farm `note` 2000, record `crop`/`condition` 200,
  record free-text fields 2000, daily-log text 4000. Polygon rings: max 2000 points -> 422 with Bahasa message.
- `POST /api/photos`: keep the route (old APKs may call it) but per-account limit 200 uploads per 24 h -> 429.
- Clients: WEB and AND treat `429` + `Retry-After` as "wait and retry" (already implemented — keep), `413` as
  permanent "Foto terlalu besar", `409 account_mismatch` as above, `422` as permanent with the server `detail`.

### 5.4 Worker (BE1)
- Provider 429/5xx/transport failure: release the job with the attempt refunded AND a persistent backoff, using the
  schema 9 columns the lead added: `jobs.release_count INTEGER NOT NULL DEFAULT 0`,
  `jobs.not_before_ms INTEGER NOT NULL DEFAULT 0`, `jobs.first_claimed_ms INTEGER` (index on status, not_before_ms,
  created_ms). `claim_next` skips jobs with `not_before_ms > now`. Backoff per release: 1, 2, 4, 8, 16, 30, 30...
  minutes. After 10 releases or 3 h since `first_claimed_ms`, the job becomes `rejected` with the farmer-facing reason
  "Server analisis sedang bermasalah. Foto Anda aman — kirim ulang nanti dari Riwayat." (not "ambil foto ulang").
- Router 401/403 (`AuthFailed`): release the job (attempt refunded, `not_before_ms` = now + 5 min), report it, sleep
  300 s, re-fetch `/api/worker/config`, continue. Never exit-loop on auth failure.
- New `POST /api/worker/status` (worker token) records `{lastSeenMs, lastError, lastErrorMs, authFailing}`; BE1 exposes
  `queue.worker_status() -> dict` (same keys, plus `stale: bool` when lastSeen > 3 min ago). ADM shows it in Overview.
- Worker-side router URL policy (same rule as ADM's save-time validation in 5.8).

### 5.5 Photo lifecycle API (BE2 provides, ADM and BE1 call)
`backend/storage.py` (BE2) exposes, all safe to call inside an existing `db.transaction()` where noted:
- `storage_lock()` — context manager: process-wide thread lock + `fcntl.flock` on `data/storage.lock`. Lock order
  everywhere: `storage_lock()` -> `db.transaction()` (which takes the DB write lock) -> SQL.
- `retire_account_objects(tx, account_id: str) -> dict` — call INSIDE the same transaction that deletes the account
  (caller already holds `storage_lock()`); creates durable cleanup tickets for every photo/reserved object of the
  account; returns `{"queued": int, "blocked": int}`.
- `retire_photo_if_unreferenced(tx, photo_id: str) -> str` — for record deletion paths; returns
  `"queued" | "kept" | "blocked"`.
- `drain(max_items: int = 50) -> dict` — bounded drainer; returns `{"done": n, "pending": n, "blocked": n}`.
  BE2 also provides `start_background_drainer(app)` (startup + every 60 s, background thread); BE3 calls it.
- `status() -> dict` — `{"pending": n, "blocked": n, "done": n, "oldestPendingMs": int|null, "lastDrainMs": int|null, "blockedReasons": {reason: n}}`.
- `inventory() -> dict` — REPORT-ONLY scan of `data/uploads`: `{"scannedMs", "files": n, "referenced": n,
  "unreferenced": [{"name", "size", "mtimeMs"}...] (max 500), "unreferencedCount": n, "unreferencedBytes": n}`.
  Never deletes or moves anything.
Account deletion (ADM, `api_admin.py`): `with storage.storage_lock(): with db.transaction() as tx:` re-check
self/last-admin inside the transaction, call `retire_account_objects(tx, id)`, delete the account, write the audit row;
after commit call `storage.drain(50)` opportunistically; respond `{"ok":true,"accountRemoved":true,"photoCleanup":{"queued":q,"blocked":b,"pendingAfterDrain":p}}`
(keep `photoCleanupFailures` = blocked + pending for old UI compatibility). ADM adds `GET /api/admin/storage`
(-> `storage.status()`) and `POST /api/admin/storage/inventory` (-> `storage.inventory()`, audited) and shows them.

### 5.6 Native photo delete (AND provides, WEB calls)
New plugin method `JagaSync.photoDelete({photoId: string}) -> {deleted: boolean}` — deletes the encrypted archived
photo file AND its Keystore alias for the active account; idempotent (missing = `deleted:false`, no error).
WEB adds `JagaMedia.delete({photoId})` in `local-media.js`: native -> `photoDelete`; browser -> delete the IndexedDB
`photo:<id>` cache entry. WEB calls it when a record or draft is deleted/discarded and when a draft photo is no longer
needed after a confirmed server record.

### 5.7 Headers, CSP, caching (BE3 server, WEB/ADM make their pages compatible)
- BE3 sets one consistent header set in `app.py` for every response (the Caddy duplicates are removed by the lead).
- `/admin` and `/admin.html` CSP (strict): `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none';
  frame-ancestors 'none'; form-action 'self'`. => ADM must remove ALL inline `<script>` blocks and inline event
  handlers from admin.html (move JS to a new `frontend/admin.js`, use `addEventListener`/delegation) and load only
  local assets (`/vendor/tailwind.generated.css`, `/vendor/lucide-0.468.0.umd.min.js`, the bundled Google Sans).
  No CDN, no Google Fonts.
- Field app CSP (all other HTML): `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob: https://tile.openstreetmap.org https://*.tile.openstreetmap.org https://server.arcgisonline.com; font-src 'self' data:;
  connect-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self'; manifest-src 'self'; object-src 'none';
  base-uri 'none'; frame-ancestors 'none'; form-action 'self'`. (Inline handlers stay for now — out of scope.)
  WEB must make sure nothing else external is loaded/fetched (WhatsApp share stays a normal link navigation).
- Static caching: `Cache-Control: no-cache` for all app HTML/JS/CSS/webmanifest (revalidated with ETag); `sw.js`
  stays `no-store`; API stays `no-store`. Disable FastAPI `/docs`, `/redoc`, `/openapi.json` unless env
  `JK_ENABLE_API_DOCS=1`.
- WEB: the shell cache name lives in ONE place (sw.js); page code asks the service worker to purge via `postMessage`
  instead of hard-coding cache names. `jk-v19`.

### 5.7b Owner's UX decisions (2026-10-21)
Primary users: farm workers on low-end Android phones (APK), often offline — optimize the phone app first (big
targets, fewest steps, very simple Bahasa). All four flows matter (Scan -> AI result -> tree timeline; Map & plots;
Riwayat & daily log; Beranda overview). Pain points to fix: too many steps, hard to find things, unclear text/results,
slow or buggy feel. Map: add a switchable satellite layer (Esri World Imagery,
`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}`, attribution
"Citra © Esri, Maxar, Earthstar Geographics", online only, never cached by the service worker) next to OpenStreetMap.

### 5.8 Router URL policy (ADM save-time + test; BE1 worker-side)
Allowed router base URLs: scheme `http` or `https`; no userinfo, no query, no fragment; host is `127.0.0.1`,
`localhost` or `::1` (any port), OR one of the hosts already allowed by the existing probe allowlist, OR a host listed
in env `JK_ROUTER_ALLOWED_HOSTS` (comma-separated, exact hostnames). Anything else: rejected on save (422, Bahasa) and
refused by the worker (treated like a config error, job released, no request sent).

### 5.9 Timeouts (WEB, AND)
JSON API calls 20 s, uploads 90 s, health checks 10 s. A timeout is a retryable network failure.

## 6. Out of scope (do not do)
Converting the field app's ~90 inline `onclick` handlers; merging `workflow-ui.js` overrides into `app.js`; changing
the Android signing key; changing protocol 2.1.0; Cloudflare dashboard rules; running anything against production;
physical deletion of existing (old) orphan files. UI/UX work keeps the identity (colors, font, branding, tab structure)
and is guided by the lead's UX brief.

## 7. Your final report (markdown)
1. Summary (3 lines). 2. Changes: file -> what/why (map each to the audit finding IDs). 3. Tests added/changed and the
exact commands you ran on the sandbox with their real results (paste the PASS/FAIL lines). 4. Anything not done and
why. 5. Requests to other implementers (exact). 6. Risks the lead should re-check on a phone.
