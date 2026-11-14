# Deployment and operations

Two deployment shapes exist for this project, and they must not be confused.

## What production actually is

The live installation is **Tencent VPS 2**, running JagaKebond as a containerised
Dokploy application (`jagakebond` plus `jagakebond-worker-1` and
`jagakebond-worker-fast-1`). HTTPS terminates at the Dokploy router; the application
image is `local/jagakebond:vps2-20261113`.

Current live identity, read back from `https://jagake.bond/api/health`:

| Field | Value |
| --- | --- |
| Release | `0.2.4.28` |
| API compatibility | `2.1.0` |
| Schema | `11` |
| Capabilities | `treeContinuity`, `recordsPaging`, `accountBinding`, `photoLifecycle`, `googleSignIn` — all true |

## What the packaged runbook describes

`app/deploy/` and [../app/deploy/RELEASE-RUNBOOK.md](../../app/deploy/RELEASE-RUNBOOK.md)
describe the **packaged** layout: real directories under `/srv/sites/jagake.bond/`
(`app`, immutable `runtime/venvs/sha256-<id>`, immutable `releases/<version>`, `ops`),
Caddy in front, systemd managing the API and both workers, with only application
`data/` writable by the service account.

> `app/deploy/stage_release.sh` targets `/srv/sites/jagake.bond` and calls
> `systemctl start jagakebond-backup.service`. It is correct for that layout and **must
> not be run against the Dokploy host**. Confirm which shape you are on before running
> any release command.

## Release procedure that was used for 0.2.4.28

1. Build and verify from a clean checkout (see [../../BUILD.md](../../BUILD.md)).
   Regression, JVM tests, lint and packaging gates must all pass with real exit codes.
2. Take a pre-deploy backup of the database and photo uploads, checksum it, and copy it
   **off the host**.
3. Cut a rollback image tag before touching the running containers
   (`local/jagakebond:rollback-<previous version>`).
4. Rebuild and recreate the application containers together with both workers.
5. Read back `/api/health`, confirm workers are `Up` (not restarting), confirm protected
   endpoints answer `401` rather than `500`, and scan the container log for real errors.

The 0.2.4.28 switch had roughly four minutes of `502` while file permissions from the
source archive were corrected and the image rebuilt. That is recorded rather than
smoothed over: the recreate is not atomic, so plan a window.

## Rollback

- Image: `local/jagakebond:rollback-0.2.4.27` (VPS 2) restores the previous application.
- Source: git tag `v0.2.4.28` marks the exact released tree; earlier releases are in the
  history.
- Data: a rollback of the image does not roll back the schema. Restoring a database
  snapshot can discard submissions made after it was taken, so it requires owner
  reconciliation and explicit authorization — never restore database and photos
  independently of each other.

## Backups

- Pre-0.2.4.28 backup: `pre-0.2.4.28-20261114T141127Z` — `db.sqlite3` and
  `uploads.tar.gz` with sidecar checksums, one copy on VPS 2 and one off-host.
- **Dokploy has no scheduled backup configured.** The schedule table is empty and both
  `/etc/dokploy/schedules` and `/volume-backups` are empty. Until a nightly job exists,
  the only backups protecting this installation are the manual ones.
- A snapshot on the same disk as the thing it protects is not a backup. Copy off-host.
- SQLite must be captured with a consistent method (`sqlite3 .backup` or a write-locked
  window), never by copying a live WAL database file.

## Android client

- Signing identity for 0.2.4.28 onward: alias `jagakebond-release`, certificate
  SHA-256 `d78cbbab8880fcd163e2d38706df2746962d79734d6e3327c1ba668fc2e71cbd`, valid to
  2056. The keystore is **not** in this repository.
- Releases up to 0.2.4.27 were signed by an Android debug keystore whose private key is
  unrecoverable. Phones still on 0.2.4.27 therefore need **one uninstall and reinstall**
  to reach 0.2.4.28; in-place update is impossible with a different signer. Web users
  are unaffected. Phone-side offline drafts are lost in that uninstall.
- After installing, confirm the device checklist in
  [../releases/v0.2.4.19-phone-acceptance.md](../releases/v0.2.4.19-phone-acceptance.md),
  adjusted for the current version.
- Never put a keystore, `.p12`, `.jks`, provider key or production `.env` in this
  repository or in a source archive.

## Operator checklist before any future release

- [ ] Backup taken, checksummed, copied off-host, and restorable.
- [ ] Rollback image tag exists **and has been tested once** — an untested tag is not a
      rollback plan.
- [ ] Release built from a clean checkout, with the signer verified rather than assumed.
- [ ] Both workers recreated with the API; a worker/admission mismatch fails closed.
- [ ] `/api/health` read back, protected routes `401`, log scanned for real errors.
- [ ] Users told in advance about anything they will notice, including an uninstall.