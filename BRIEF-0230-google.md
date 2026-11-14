# Implementer brief: JagaKebond 0.2.3.0 (Sign in with Google + admin registration inbox)

Continuation amendment (2026-10-29): the branch now includes deployed 0.2.2.3.
Use versionCode **18**, cache **jk-v23**, and the current asset pins. The earlier
versionCode/cache instructions below predate the merge. The owner allows admins
to sign in with Google. See CONTRACT-0230-google.md and SECURITY-0230-20261029.md
for the account-provenance guard, IP budgets, retention, JWKS recovery and tests.
The final runner label is `g0230-security-final` and all 62 suites must pass.

Read `CONTRACT-0230-google.md` first. It is the spec and the owner's decisions. This brief says where and how to work.

## Where

- Local git work tree (Windows): `E:\Agent\Claude\VPS Management\jagakebond-0220\work`, branch `g0230`. Commit there; never commit to `master`.
- Sandbox test copy:
  - path: `/data/workspace/software-development/jagakebond/jagakebond-improvements/review/claude-fixall-20261021/work-g0230`;
  - create it once with `ssh jagakebond-sandbox 'cp -a .../work-final .../work-g0230'`, after the lead says work-final is the 0.2.2.2 state.
- Helpers in `E:\Agent\Claude\VPS Management\jagakebond-0220\tools` (bash):
  - `jk-push.sh work-g0230 <paths…>` copies local files into the sandbox copy;
  - `jk-run.sh work-g0230 '<cmd>'` runs a command there. It provides `$PY` (backend venv python), `$JAVA_HOME`, `$ANDROID_HOME` and `$TMPDIR`.
- Long runs (regression, gradle) must use `nohup … </dev/null >log 2>&1 &`, then a separate wait loop: ssh drops kill attached runs.

## What to build

1. **Backend:**
   - `app/backend/google_auth.py`: JWKS fetch and cache with `httpx`, RS256 verification with `cryptography` (no new dependency; `requirements.txt` must not change), and the claim checks in the contract.
   - Nonce table and limits.
   - Routes:
     - `GET /api/auth/google/config`
     - `POST /api/auth/google/nonce`
     - `POST /api/auth/google`
     - admin: `GET /api/admin/registrations`, `POST /api/admin/registrations/{id}/approve|reject` (with current-password confirmation like the other sensitive admin actions).
   - Schema 10 migration in `db.py`, with `reset_for_tests` covering the new tables.
   - Approval creates the account with an unusable password hash.
   - `/api/health` capabilities gain `googleSignIn: <enabled>`.
   - Bump everything that pins schema 9 (`release_ops.py` and its tests, health tests) to 10 only where it describes the CURRENT schema. Migration tests from older versions must still pass.
2. **CSP:** add the Google origins for the field app only (`security.py`). `/admin` stays strict. Check COOP for the GIS popup.
3. **Web (`app/frontend`):**
   - the login card shows a "Masuk dengan Google" button only when `/api/auth/google/config` says enabled;
   - load GIS lazily, pass the nonce, POST the credential;
   - show `registration_pending` and `registration_rejected` as clear Bahasa messages;
   - no Google UI when disabled;
   - follow `ui-kit.css` and the 12/8 corner rule.
4. **Admin console (`admin.html` / `admin.js`):** a "Pendaftaran" card listing pending requests, with Setujui and Tolak, CSP-strict (no inline script).
5. **Android:**
   - add `androidx.credentials:credentials`, `androidx.credentials:credentials-play-services-auth` and `com.google.android.libraries.identity.googleid:googleid` (pick current stable versions that build with this project's AGP/compileSdk);
   - `JagaSyncPlugin.googleSignIn({serverClientId, nonce})` → `{idToken}` using `GetSignInWithGoogleOption`;
   - map cancel and no-credential to distinct error codes;
   - JS uses the native path when `window.Capacitor?.isNativePlatform()`, else GIS;
   - JVM unit tests for the result mapping.
   - Do NOT change the signing config or keystore.
6. **Version:** 0.2.3.0, versionCode 17 (`backend/version.py`, `build.gradle`, `NativeHttp.APP_VERSION`, `ReleaseContractTest`, `test_limits_0220.py`, `verify_mvp.py`).
   - Service-worker cache becomes `jk-v22`.
   - Bump `?v=` on every changed frontend asset, in `index.html`, `admin.html` and `sw.js`, plus the tests that pin them.

## Tests (must all pass)

- New `app/tests/test_google_0230.py`. It signs synthetic tokens with a locally generated RSA key and serves that key through a patched JWKS fetch. It covers:
  - good token → linked login;
  - email match → link;
  - unknown → pending (202);
  - repeat → still one request;
  - rejected → 403;
  - approve → login works;
  - each claim failure (bad signature, wrong aud, wrong iss, expired, future iat, unverified email, missing, reused or expired nonce) → 401;
  - inactive account → 403;
  - cap of 200 pending;
  - throttle;
  - disabled (no client ID) → config `enabled: false`, and POST returns 404 or 403.
- New browser check `review/browser-tools/google-0230.cjs`. GIS is mocked by routing `accounts.google.com/gsi/client` to a stub that calls the callback. It covers:
  - the button is shown only when enabled;
  - the pending message;
  - admin inbox approve and reject;
  - no console or CSP errors.
- The full regression: `run_final.py` with the two new suites appended (expected count +2), label `g0230`. The lead runs it; you may run it too. Report exact counts.
- Android: `./gradlew testDebugUnitTest lintDebug assembleRelease` passes; lint has 0 errors.

## Rules

- Never read or print `.env`, secrets or real data.
- Synthetic fixtures only.
- No production changes.
- Never touch `/data/home/.android/debug.keystore`.
- Patch files with the Edit tool or script files, not inline python heredocs with escapes.
- Match the surrounding code style and comment density.
- When done, report in your final message: files changed, test counts, anything not done, and open questions.
