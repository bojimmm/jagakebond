# JagaKebond deployment operations

Production is organized under `/srv/sites/jagake.bond/` as separate real directories for `app/`, `runtime/`, `releases/`, and `ops/`. The authoritative VPS tool lives at `/srv/sites/jagake.bond/ops/release_ops.py`; release packages are immutable roots named for their `RELEASE_VERSION` under `releases/`.

Read [RELEASE-RUNBOOK.md](RELEASE-RUNBOOK.md) for deployment, backup, runtime preparation, interrupted publication recovery, and data restore. Do not run an old release package's embedded deployment script against production. Caddy remains the HTTPS proxy and should not be replaced with the optional nginx examples.

The API runs as one Uvicorn process. The normal and fast workers are separate services. A deployment stops fast worker → normal worker → API, then starts API → confirms API health → normal worker → fast worker. Only application `data/` is writable by the service account. Dependency manifests are tied to an immutable runtime directory; dependency changes require a prepared and reviewed runtime update.
