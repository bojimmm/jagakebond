# JagaKebond

Crop observation app for smallholder farmers: photograph a plant, keep its history,
record where it grows, and get an initial AI assessment the farmer can inspect and
correct. Indonesian-language web app plus a Capacitor Android client sharing one field
interface.

**Live:** production release `0.2.4.28` at `jagake.bond` · API compatibility `2.1.0` ·
schema `11` · offline cache `jk-v68` · Android `versionCode 56`.

A photo assessment is a hypothesis from visible evidence, not a confirmed field
diagnosis. Application/treatment eligibility stays closed and no unverified dose is
shown. See [docs/ai-evaluation.md](docs/ai-evaluation.md) for the evidence that would be
required before claiming diagnostic accuracy.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `app/frontend/` | HTML, JavaScript and CSS field app, separate admin console, public legal pages, offline shell |
| `app/backend/` | Python FastAPI API: auth, account approval, SQLite records, plots, queue, media, admin |
| `app/worker/` | Normal and fast queue consumers calling an OpenAI-compatible model gateway |
| `app/reference/` | Shared problem vocabulary and preliminary nutrient/product references |
| `app/deploy/` | systemd units, guarded release/recovery tooling, staging verifier |
| `android-client/` | Capacitor Android project, native camera/location/offline/HTTP bridges |
| `review/` | Synthetic browser and integration harnesses, pinned UI build dependencies |
| `tools/` | Regression runner, source inventory, Android build/package gates, evaluators |
| `docs/` | Design, architecture, operations, evidence notes and the release-note archive |

The backend is a **modular monolith**: related modules run in one FastAPI process
sharing SQLite, with normal and fast workers as separate processes in the same
deployment. Full component, data-flow and AI-pipeline detail is in
[docs/architecture.md](docs/architecture.md).

## Build and verify

Prerequisites: Python 3.12, Node 22, Java 21 and an Android SDK. Nothing in the build
needs production credentials, live farmer data or paid model requests.

```sh
python3.12 -m venv .venv
.venv/bin/python -m pip install -r app/requirements.txt -c app/requirements-tested.txt
npm ci --prefix review/browser-tools && npm ci --prefix android-client

.venv/bin/python -B tools/run-regression.py     # 88 suites, source hashed before and after
```

Follow [BUILD.md](BUILD.md) for the ordered commands, the Android build and the
packaging gates. A green build alone does not verify the signer: packaging checks the
APK signer certificate, `versionCode`, non-debuggable flag, asset parity and a
fresh-extraction test run before an immutable release folder is published.

## Documentation

| | |
| --- | --- |
| [docs/README.md](docs/README.md) | Documentation index |
| [docs/architecture.md](docs/architecture.md) | Components, data flow, AI pipeline, limits |
| [docs/design.md](docs/design.md) | Interface direction and interaction contracts |
| [docs/operations/deployment.md](docs/operations/deployment.md) | Production layout, release and rollback |
| [docs/releases/](docs/releases/) | Release-note archive, 0.2.2.0 → 0.2.4.19 |
| [CHANGELOG.md](CHANGELOG.md) | Version history |
| [SECURITY.md](SECURITY.md) | Reporting a vulnerability, secret-handling rules |

## What is never in this repository

Accounts, farmer photos, databases, signing keys, provider API keys and
machine-specific configuration. Only `app/.env.example` is tracked. `.gitignore`
blocks `.env*`, `data/`, keystores, APKs and build output; `tools/package-release.py`
additionally refuses to package any source file matching a credential-shaped pattern.

## License

Proprietary, all rights reserved — see [LICENSE](LICENSE). Bundled third-party front-end
dependencies and fonts keep their own licenses under `app/frontend/vendor/`.