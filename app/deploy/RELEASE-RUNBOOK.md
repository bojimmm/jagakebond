# JagaKebond production release and recovery

The VPS keeps one real directory per responsibility. No application or runtime symlinks are used:

| Path | Purpose |
| --- | --- |
| `/srv/sites/jagake.bond/app` | Live application, private `.env`, SQLite database and photos |
| `/srv/sites/jagake.bond/runtime/venvs/sha256-<id>` | Read-only Python runtime identified by both requirements manifests |
| `/srv/sites/jagake.bond/releases/<release-version>` | Immutable, unpacked application release; directory name must match `RELEASE_VERSION` |
| `/srv/sites/jagake.bond/ops` | Administrator release tool, systemd unit sources and this runbook |
| `/var/backups/jagakebond` | Private local transaction snapshots |
| `/var/lib/jagakebond/release-transaction.json` | Private publication recovery journal |

Caddy continues proxying to `127.0.0.1:8010`. Its active site configuration points to the canonical paths; do not restore old `/opt` or `/var/www` paths into active configuration.

## Ownership and runtime identity

- Application source and operations files are owned by `root:jagakebond`, read-only to the service account. Only `app/data/` is writable by `jagakebond`.
- `app/.env` is `root:jagakebond`, mode `0640`; it never belongs in a release package. Do not print or copy its contents into logs.
- Each runtime directory is owned by `root:jagakebond`, not writable by the service account, and kept in place for as long as a systemd unit references it.
- The runtime path is deterministic from `requirements.txt` and `requirements-tested.txt`. Ask the tool for it:

```sh
OPS=/srv/sites/jagake.bond/ops/release_ops.py
APP=/srv/sites/jagake.bond/app
RUNTIME=$(python3.12 "$OPS" runtime-path --target "$APP")
printf '%s\n' "$RUNTIME"
```

If `app/` is unavailable, use the runtime path already named in the active `ExecStart` lines for `jagakebond.service`; do not guess or rebuild the runtime as part of recovery.

Create a missing runtime once, using the versioned release manifests. Do not move or overwrite a runtime that a live unit is using:

```sh
REL=/srv/sites/jagake.bond/releases/0.2.4.18
sudo install -d -o root -g jagakebond -m 0750 "$(dirname "$RUNTIME")"
sudo python3.12 -m venv --copies "$RUNTIME"
sudo "$RUNTIME/bin/python" -m pip install -r "$REL/requirements.txt" -c "$REL/requirements-tested.txt"
sudo "$RUNTIME/bin/python" -m pip check
sudo -u jagakebond "$RUNTIME/bin/python" -c 'import fastapi, uvicorn, multipart, httpx, PIL, cryptography, sqlite3'
sudo chown -R root:jagakebond "$RUNTIME"
sudo chmod -R go-w "$RUNTIME"
```

The release tool rejects changes to either runtime manifest. A dependency update needs a separately prepared, tested runtime and reviewed service-unit path before an application deployment. Keep the older runtime until no unit or rollback release depends on it.

## Release preparation and deployment

1. Build and review the release away from production. Extract the application root (the directory containing `backend/`, `frontend/`, `worker/`, and `requirements.txt`) to `/srv/sites/jagake.bond/releases/<RELEASE_VERSION>`, owned by `root:jagakebond` and not group/other writable. Do not modify an existing release directory.
2. Exclude `.env`, `data/`, virtual environments, build output and caches. The tool requires a complete, symlink-free release and an exact release-directory name.
3. Create and verify a fresh encrypted off-host backup. The backup must complete before the maintenance window; a local snapshot is not a substitute.
4. Inspect all three active service definitions. The API must bind only to `127.0.0.1:8010`; both workers must use the same app/runtime roots, have no writable paths, and the fast unit must identify `WORKER_LANE=fast`.
5. Run the plan command. It does not inspect production or perform mutation:

```sh
python3.12 "$OPS" deploy --release /srv/sites/jagake.bond/releases/0.2.4.28
```

6. After the owner-authorized maintenance window, deploy only through the canonical tool:

```sh
sudo "$RUNTIME/bin/python" "$OPS" deploy \
  --release /srv/sites/jagake.bond/releases/0.2.4.28 --execute
```

The tool locks out concurrent release actions; validates service paths, source syntax/assets, runtime manifests, installed dependencies, disk and inode capacity; stages a same-filesystem candidate; quiesces all three services fast worker → normal worker → API; creates a coordinated SQLite/photo/environment snapshot; migrates the staged database; publishes through journaled sibling renames; starts API → waits for matching API health → starts normal worker → fast worker; and verifies local health and every served asset hash. The backup and rollback snapshot are retained.

After deployment, check `https://jagake.bond/api/health`, all three services, the Caddy HTTPS response and an authorized sign-in / photo flow. Keep the release package and old runtime in place until the checks pass.

## Recovery and data restore

**Publication recovery** returns the application tree to the previous side of an interrupted directory swap. It does not rewind database submissions. Preserve the journal and sibling `app.previous-*`, `app.failed-*`, and candidate trees until recovery health checks pass:

```sh
sudo "$RUNTIME/bin/python" "$OPS" recover --execute
```

The recovery path stops the three services in writer-first order, restores the previous tree, reapplies permissions, starts the API and verifies matching health before starting either worker. It keeps the journal until local asset readback succeeds. If it reports `CRITICAL`, leave all evidence in place and repair the service or filesystem issue before retrying.

**Snapshot restore** rewinds SQLite and photos together. It can discard submissions made after that snapshot, so use it only after explicit owner confirmation and reconciliation planning:

```sh
sudo "$RUNTIME/bin/python" "$OPS" verify-snapshot \
  --snapshot /var/backups/jagakebond/SNAPSHOT
sudo "$RUNTIME/bin/python" "$OPS" restore \
  --snapshot /var/backups/jagakebond/SNAPSHOT \
  --confirm-data-restore --execute
```

Keep the post-failure state and verified off-host backup until later submissions are reconciled. Never copy a live SQLite file, delete WAL files, restore photos without the matching database, edit a snapshot manifest, or remove evidence to make a retry pass.

## Photo cleanup state after restore

Restore increments the storage epoch in the recovered database. Tickets from the restored copy are blocked until reviewed. Inspect `GET /api/admin/storage`; requeue only an individually verified ticket with `from backend import storage; storage.requeue_blocked("<ticket id>")`. Never edit `photo_cleanup` directly or delete `uploads/` files to resolve a ticket.

## Legacy install retention

The former `/opt/jagakebond`, `/opt/jagakebond-runtime`, and `/opt/jagakebond-releases` trees are rollback material after cutover. They must not be referenced by running services or Caddy. Keep them intact until the new install, scheduled backup and off-host readback have all passed and the owner approves retiring the rollback copy.
