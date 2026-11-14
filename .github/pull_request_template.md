## What changed

<!-- One change set, tied to the release it belongs to. -->

## Why

## Verified

<!-- Real commands and results, not intentions. -->
- [ ] `python -B tools/run-regression.py` — full 88-suite pass, source unchanged
- [ ] Android checks (if touched): sync-assets, cap-sync, JVM tests, lint, release — all exit 0
- [ ] Packaging gates (if releasing): signer, versionCode, non-debuggable, asset parity
- [ ] Checked on a phone (if the change is visible to farmers)

## Validation boundary

<!-- What this change does NOT establish: deployment, phone acceptance, diagnostic accuracy. -->

## Documentation

- [ ] Release note added to `docs/releases/` and indexed in `docs/releases/README.md`
- [ ] `CHANGELOG.md` entry
- [ ] No secrets, `.env` file, keystore, database dump or farmer photo in the diff