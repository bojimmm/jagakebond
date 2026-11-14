# Android client handoff (private test build)

## Implementation scope

Capacitor 8 app in this directory, `appId=jagake.bond.app`, bundled `www/` assets (no `server.url`), min SDK 24 / compile+target 36. `scripts/sync-assets.mjs` copies `../app/frontend`, excludes `admin.html` and service worker. Finalized shared frontend scripts are included in current snapshot. Native code is in `android/app/src/main/java/jagake/bond/app/`:

- `JagaSyncPlugin`: Capacitor JagaSync methods, strict relative path/method allowlist based on staged backend routes, fixed `https://jagake.bond`, redirects disabled, JSON-only bridge bodies, login cookie handling, authenticated photo image base64.
- `NativeStore`: app no-backup private files, Keystore AES/GCM encrypted account-scoped session and outbox, per-account hashed names, atomic fsync+rename, account generation and synchronized storage.
- `UploadWorker` / `UploadEngine` / `UploadPolicy`: CONNECTED constraint, `clientRequestId` multipart upload streamed with a fixed length, network I/O outside the storage/account lock. Since 0.2.2.0 a server receipt is always persisted into the draft's own account outbox even if the account or generation changed meanwhile; network failures never fail a draft (30 s .. 1 h back-off), server failures fail it only after 10 over 24 h, 429/503 Retry-After are honoured, 413/422 are permanent, 401/403 and 409 `account_mismatch` block until sign-in.
- `OutboxStore` (0.2.2.0): one encrypted file per draft plus a small encrypted index; crash-safe lossless migration from the old single-blob outbox; undecryptable data is quarantined (renamed, never deleted) and counted in `list().quarantined`.
- `RecoveryPlanner` / `UploadScheduler`: on app start, `activate` and sign-in, rows stuck in `uploading` without work go back to `pending`, network back-offs are released and recoverable failures/blocks are re-queued.
- `PhotoArchive` (`photoPut/photoGet/photoDelete`), `RevokeQueue`/`RevokeWorker` (offline logout revoked later), `BackPolicy` + `MainActivity` (back button -> document event `jagaBack`; web calls `JagaSync.exitApp()`).

No backend or production files changed from this Android task. No server auth scheme or cookies were changed.

## Build / tests

Build environment was installed user-local (no sudo): Java 21 at `/home/ubuntu/.local/share/jimops-android-toolchain/jdk-21.0.12.1+1`; Android SDK at `/home/ubuntu/.hermes/profiles/jimops/cache/scratch/android-sdk`. Run from `android-client/`:

```sh
export JAVA_HOME=/home/ubuntu/.local/share/jimops-android-toolchain/jdk-21.0.12.1+1
export ANDROID_HOME=/home/ubuntu/.hermes/profiles/jimops/cache/scratch/android-sdk
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/build-tools/36.0.0:$PATH"
npm ci
npm run sync-assets
npm run cap:sync
cd android
./gradlew --no-daemon --max-workers=2 clean testDebugUnitTest assembleDebug
```

Gradle heap is capped at 768 MiB and workers at 2.

### Release 0.2.2.0 (versionCode 14)

```sh
./gradlew --no-daemon --max-workers=2 testDebugUnitTest lintDebug assembleDebug assembleRelease
```

Result on the InstaBox sandbox copy (2026-10-28): `BUILD SUCCESSFUL`; **146 JVM tests in 17 suites, 0 failures**; app lint
0 errors (22 warnings). The JVM suite runs the real outbox, migration, photo archive, revoke queue, recovery planner and
upload state machine against a software AES-GCM vault and a fault-injecting file layer (no device, no new dependencies).

- `assembleRelease` -> `app/build/outputs/apk/release/app-release.apk`: not debuggable, minify off,
  `webContentsDebuggingEnabled:false`, `loggingBehavior:"none"` (from `src/release/assets/capacitor.config.json`).
  It is signed with the SAME key as every APK installed so far (the standard debug keystore
  `~/.android/debug.keystore`, alias `androiddebugkey`), so it updates 0.2.1.x in place. Override with
  `-Pjk.keystore=... -Pjk.keystore.alias=... -Pjk.keystore.password=... -Pjk.key.password=...` or `JK_KEYSTORE`,
  `JK_KEY_ALIAS`, `JK_KEYSTORE_PASSWORD`, `JK_KEY_PASSWORD`. The build never creates or replaces the keystore.
  Moving to a dedicated release key later forces ONE uninstall on every phone (drafts on the phone are lost) — plan it.
- `assembleDebug` keeps WebView debugging and Capacitor logging (`src/debug/assets/capacitor.config.json`).
- Signing certificate SHA-256 of both builds and of 0.2.1.10: `81ac5ee2773151f80c7d994f4452da18feaeb32dbc44d5dc76e5482709ab3e56`.

Older note (0.2.0 scaffold): the first JVM suite had 10 tests; that APK used the platform debug key and was not a Play publication.

## Required review / known limits

- Physical Android device lifecycle, WebView bridge behaviour, actual WorkManager scheduling, reboot/Doze/force-stop, Keystore hardware backing/invalidation, network logout and browser-to-native photo rendering have not been device-tested. WorkManager is best-effort and not a latency/SLA guarantee.
- The manifest declares CAMERA and coarse/fine location only, with camera hardware optional. Runtime permission denial UX and Android camera/geolocation permission prompts still need device verification; no microphone, background location or broad storage permission is requested.
- Staged frontend assets contain `native-adapter.js`, `offline-store.js`, `offline-sync.js`; their integration and offline behavior are not certified by the Java tests. Parent/release reviewer must rerun end-to-end browser and device tests.
- Bridge allowlist is intentionally narrow, but full allowed routes must be compared against finalized frontend request call sites before signoff; specifically inspect actual crop routes and any list/read dependencies. No admin/worker/result/trace/release paths are exposed.
- Verify actual approved account profile and session expiry behavior against backend tests. Logout immediately clears local session/active account and cancels tagged workers, preserving drafts.
- A request already accepted remotely cannot be rolled back after local account lock; generation checks prevent stale completion writes or cross-account visibility.
- No offline/remote integration, production credentials, live server, Play signing/publication, or production edits were exercised.

## APK verification commands

```sh
aapt dump badging android/app/build/outputs/apk/debug/app-debug.apk | grep -E 'package:|sdkVersion|targetSdkVersion'
apksigner verify --verbose android/app/build/outputs/apk/debug/app-debug.apk
sha256sum android/app/build/outputs/apk/debug/app-debug.apk
unzip -l android/app/build/outputs/apk/debug/app-debug.apk | grep -E 'assets/public/(admin.html|sw.js|native-adapter.js|offline-store.js|offline-sync.js)'
```

Expected: package `jagake.bond.app`, min 24, target 36; `admin.html` and `sw.js` absent from assets, and bridge/offline scripts present. Current `adb devices` is empty (no physical device attached). Final parent acceptance still needs asset-source comparison and device checks.
