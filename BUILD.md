# Build and release JagaKebond

Use a disposable Linux build checkout with Python 3.12, Node 22, Java 21, Android SDK/platform/build-tools required by the Gradle project, Chrome and the existing private signing identity. The runtime dependency manifests remain unchanged. Never generate a replacement signing key or put keys, production `.env`, databases or farmer photos in a source archive.

## Prepare a clean source tree

```sh
python3.12 -m venv /private/build-venv
/private/build-venv/bin/python -m pip install -r app/requirements.txt -c app/requirements-tested.txt
npm ci --prefix review/browser-tools
npm ci --prefix review/ui-build
npm ci --prefix android-client
npm --prefix review/ui-build run build:css
python3.12 tools/sync-problem-vocabulary.py
npm --prefix android-client run sync-assets
npm --prefix android-client run cap:sync
```

Use `python tools/sync-problem-vocabulary.py --check` to verify without writing. Keep SDK location in the build environment or private `android/local.properties`. Java 21 and the original signing identity must already be available to Gradle. Their contents are not inspected or copied by the package tool.

## Freeze, test and build

Choose a new empty evidence folder and final label. Every shipped source file is hashed before and after the 88-suite regression. Generated results, caches, private state and Android's copied assets are excluded from the source inventory. A source change invalidates the result; start a fresh regression label after any change.

```sh
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
export ANDROID_HOME=/private/android-sdk
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
export JK_TEST_PYTHON=/private/build-venv/bin/python
export JK_EVIDENCE_ROOT=/private/evidence/0259-final1
export JK_AUDIT_LABEL=g0259-final1
"$JK_TEST_PYTHON" -B tools/run-regression.py > "$JK_EVIDENCE_ROOT-runner.log" 2>&1
"$JK_TEST_PYTHON" -B tools/build-android.py \
  --regression "$JK_EVIDENCE_ROOT/g0259-final1-summary.json" \
  --out /private/evidence/0259-final1-android
```

The browser suites use synthetic accounts/images, local fixture servers and Chrome. They do not require live farmer data or paid model requests. Individual browser suites need `NODE_OPTIONS=--require=<absolute-source>/review/browser-tools/tour-fixture.cjs`. POSIX media-security tests must run on Linux, rather than weakening their filesystem protections for Windows.

The Android tool synchronizes assets and Capacitor, then runs JVM tests, lint and the release build sequentially. It records each real exit code and confirms that the source remains unchanged. A successful build alone does not verify the signer, native logos or source package.

## Package atomically

```sh
"$JK_TEST_PYTHON" -B tools/package-release.py \
  --regression "$JK_EVIDENCE_ROOT/g0259-final1-summary.json" \
  --android-evidence /private/evidence/0259-final1-android \
  --sdk-build-tools "$ANDROID_HOME/build-tools/35.0.0" \
  --reference-apk /private/previous-installed-release.apk \
  --out /private/releases/jagakebond-0.2.4.28
```

Packaging requires the passing, exact 88-suite inventory, all Android command exits, at least 158 JVM tests with no failures/errors/skips, no lint errors, versionCode 56, a non-debuggable APK and the same public signer certificate as the prior installed APK. It compares frontend assets byte-for-byte and 26 compiled native logo resources by pixels. It verifies the source manifest and representative tests from a fresh extraction. It publishes the output folder only after all checks succeed, and refuses to replace an existing release.

Deliver the APK, source ZIP, verification JSON and checksums. Retain the complete synthetic regression/build evidence privately. Never mutate a frozen package to add a deployment claim; write a separate delivery record.

## Guarded production staging

Transfer the source ZIP and `app/deploy/stage_release.sh` to a private temporary location on the VPS. Supply the source ZIP's SHA-256 from the verified delivery checksums. The canonical runtime and release tool must match; a dependency/tool change needs its own reviewed preparation.

```sh
sudo bash /private/stage_release.sh stage 0.2.4.28 SOURCE_ZIP_SHA256 /private/source.zip
sudo bash /private/stage_release.sh plan 0.2.4.28
sudo bash /private/stage_release.sh execute 0.2.4.28
```

`execute` waits for a fresh encrypted off-host backup, then invokes the canonical guarded deploy. It does not substitute an old embedded deployment tool. Ensure Caddy treats `/api/analyze/<id>/renew` as worker-only alongside result/trace/release; validate its configuration before a reload. Preserve every other site's configuration and the live model router.

Confirm public release/schema/cache/assets, API and both worker services, private-route 404s, no open transaction journal and the verified rollback snapshot. Follow [PHONE-ACCEPTANCE-0259.md](PHONE-ACCEPTANCE-0259.md) for owner device checks. See the canonical runbook for interrupted publication recovery; never restore database/photos independently.
