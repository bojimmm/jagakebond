# Contributing

This is a single-owner product repository. Changes land through a branch and a pull
request so that every change has a reviewable diff, a build result and a rollback point.

## Before you start

- Never commit accounts, farmer photos, databases, keystores, provider keys or a real
  `.env`. Only `app/.env.example` is tracked. `.gitignore` blocks the common cases, and
  `tools/package-release.py` refuses to package a source file matching a
  credential-shaped pattern — but neither replaces care.
- Never generate a replacement signing key to make a build pass. If the signer is wrong,
  stop and fix the signer configuration.

## Local setup

```sh
python3.12 -m venv .venv
.venv/bin/python -m pip install -r app/requirements.txt -c app/requirements-tested.txt
npm ci --prefix review/browser-tools
npm ci --prefix review/ui-build
npm --prefix review/ui-build run build:css
npm --prefix android-client run sync-assets && npm --prefix android-client run cap:sync
```

Java 21 and an Android SDK are only needed for the Android build. Keep the SDK path in
the environment or a private `android/local.properties`, never in the repository.

## The gate that matters

```sh
.venv/bin/python -B tools/run-regression.py
```

The runner hashes every shipped source file before and after the suite and fails if the
tree changed mid-run. A passing run is only valid for the exact tree it hashed; edit one
file afterwards and the evidence is void, so start a fresh label rather than reusing one.

Android and packaging steps are in [BUILD.md](BUILD.md). Packaging refuses to publish
unless the regression is a complete 88-suite pass, the Android checks all exited 0, the
APK carries the expected `versionCode`, is not debuggable, and matches the expected
signer certificate.

## Changing behaviour

1. One change set per pull request, tied to the release it belongs to.
2. Add or adjust tests in `app/tests/` (Python) or `review/browser-tools/` (browser).
   Browser suites use synthetic accounts and images, local fixtures and Chrome — never
   live farmer data or paid model requests.
3. Write the release note in `docs/releases/v<version>-<slug>.md`, register it in
   [docs/releases/README.md](docs/releases/README.md) and add a
   [CHANGELOG.md](CHANGELOG.md) entry.
4. State the validation boundary plainly: what was tested, and which claims — deployment,
   phone acceptance, diagnostic accuracy — the change does not establish.

## Documentation conventions

- `docs/` holds the narrative: architecture, design, operations, evidence, release notes.
  Handoffs that describe a specific directory stay beside that code
  (`app/handoff.md`, `android-client/ANDROID-HANDOFF.md`).
- Relative links only. No absolute machine paths or operator-specific locations outside
  `docs/operations/`.
- Files are UTF-8, LF, one `# ` title, blank line around headings and tables, no trailing
  whitespace.

## Commits and branches

- Branch names: `docs/<topic>`, `fix/<topic>`, `feat/<topic>`.
- Commit subject in the imperative mood, under 72 characters; the body says what was
  verified and with which commands.
- Tag every release `v<version>` on the exact tree that was built and deployed. The tag
  is the recovery point when a later commit invalidates a package's hashes.