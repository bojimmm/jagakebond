# Security policy

## Reporting a vulnerability

Report privately to the repository owner. Do not open a public issue for anything that
could expose farmer accounts, uploaded photos or location history. Include the affected
route or component, the version, and the smallest reproduction you can manage.

Expect an acknowledgement before any public disclosure is discussed. Please do not run
automated scans against the live installation at `jagake.bond`; use a local instance with
synthetic data.

## What is in scope

- Authentication, session handling and account approval (`app/backend/`).
- Photo upload, media serving and photo lifecycle rules.
- The analysis queue: leases, fencing, admission and quota accounting.
- SQLite record ownership, plot membership and cross-account access.
- The Android client: native bridges, local cache, offline outbox, WebView configuration.
- Public legal pages and the admin console.

## What is out of scope for this repository

The separately managed model-routing service, the host operating system, Dokploy itself
and the reverse proxy. Report those to their own maintainers.

## Handling rules for contributors

- No secret, token, password, private key, keystore, database, `.env` file or farmer
  photograph is ever committed, pasted into an issue, or attached to a release.
- Only `app/.env.example` is tracked. If you add a configuration key, document it there
  with a placeholder value.
- Nothing in the APK carries a provider API key. Secrets stay server-side.
- `tools/package-release.py` scans packaged source for credential-shaped strings and
  refuses to build the archive if one matches. Treat a match as a real leak, not a
  false positive to bypass.
- Android release keystores live outside the repository on the build machine, with the
  certificate SHA-256 recorded in
  [docs/operations/deployment.md](docs/operations/deployment.md). Never regenerate a key
  to work around a signing problem: it silently makes every installed app unupdatable.

## Known, accepted boundaries

These are documented limitations rather than vulnerabilities; report them only if you can
show impact beyond what is described.

- Model confidence is uncalibrated and is never presented to farmers as a probability.
- The Indonesian product catalog is a preliminary reference, not a verified
  registration database; application eligibility is closed by design.
- The offline shell caches the app, not map tiles, and does not imply offline maps.
- The queue API is global and unauthenticated by design: phones poll job state, they do
  not hold credentials for it.
- Server-side audit rows for client errors are masked, rate-limited and purged on a
  schedule; they are not a forensic log.

## Rotating a credential

If a key is exposed: revoke it at the provider first, then replace it in the deployment
environment, then redeploy and read back `/api/health`. Record what happened in the
deployment notes without reproducing the secret.