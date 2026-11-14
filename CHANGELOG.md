# Changelog

All notable changes to JagaKebond. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
`0.2.<series>.<patch>`. Per-change implementation notes, including what each change
deliberately does not claim, live in [docs/releases/](docs/releases/).

## [Unreleased]

### Changed

- Documentation reorganised: every release note that used to sit in the repository root
  now lives in `docs/releases/` with a version-prefixed filename, and the root README is
  a project front door instead of a release handover.
- Added [docs/architecture.md](docs/architecture.md),
  [docs/operations/deployment.md](docs/operations/deployment.md),
  [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and this changelog.
- Fixed line endings, trailing whitespace and encoding damage in the archived notes.
- Updated the release tooling for the new document paths: `tools/release_source.py` now
  inventories `docs/` so documentation still ships inside the source package, and
  `tools/package-release.py` checks the phone-acceptance and quality notes at their new
  locations.

## [0.2.4.28] — 2026-11-14

### Added

- New Android release signing identity: alias `jagakebond-release`, certificate SHA-256
  `d78cbbab8880fcd163e2d38706df2746962d79734d6e3327c1ba668fc2e71cbd`, valid to 2056.
  Replaces a debug keystore whose private key could not be recovered.

### Changed

- Build fixes: `JK_KEYSTORE` is pinned to an explicit path instead of picking up the
  first `debug.keystore` found on disk, and packaging fails loudly on a wrong signer
  instead of failing at the last gate.
- Production rebuilt and redeployed on the containerised Dokploy install; schema
  migrated to 11 and pre-existing claimed jobs requeued so old workers cannot publish
  unfenced results.

### Verified

- 88/88 regression suites with the source unchanged during the run; 158 JVM tests, no
  failures; lint 0 errors.
- APK `versionName 0.2.4.28`, `versionCode 56`, not debuggable, signed by
  `CN=JagaKebond Release`.
- Live `/api/health` reports release `0.2.4.28`, API `2.1.0`, all capabilities true.

### Known cost

- Phones on 0.2.4.27 need one uninstall and reinstall because the signer changed; web
  users are unaffected. About four minutes of `502` occurred during the container
  recreate. Dokploy still has no scheduled backup configured.

## Earlier releases

0.2.2.0 → 0.2.4.19 are documented one by one in
[docs/releases/](docs/releases/README.md), which lists the release, the note and a
one-line summary for each. Highlights:

| Version | Headline |
| --- | --- |
| 0.2.4.19 | Quality pass and audit disposition |
| 0.2.4.16 | Strict CSP, no re-assigned globals (audit F10–F14) |
| 0.2.4.15 | Self-hosted error monitoring; audit items F8, F9, F15–F18 |
| 0.2.4.11 | KBBI Indonesian copy pass |
| 0.2.4.5 | Fast queue lane, later folded into one server-chosen lane |
| 0.2.4.1 | Reanalysis from the clean original photo |
| 0.2.4.0 | One short problem name per record; gated chemical references |
| 0.2.3.6 | Seven bounded advice lists with confidence gating |
| 0.2.3.4 | Brand rollout from the supplied sprout logo |
| 0.2.3.1 | Public privacy/terms pages and login redesign |
| 0.2.3.0 | Google sign-in and admin registration inbox |
| 0.2.2.0 | "Fix-all" audit release |