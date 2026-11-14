# Backend hardening handoff

Scope: staged source only; no production database, service, or credentials accessed.

## Changes

- `backend/db.py`: schema version 6 atomically publishes each migration with its DDL/data changes. Migration 6 adds nullable `jobs.client_request_id`, nullable `jobs.request_hash`, and partial unique index `idx_jobs_account_client_request` on `(account_id, client_request_id)` where the request ID is non-NULL.
- `backend/queue.py`: completion already performs read and state transition in one `BEGIN IMMEDIATE` transaction; this is preserved and covered by competing completion attempts. `usable` now accepts only the literal JSON boolean `true`. Old-image cleanup excludes queued/claimed jobs. Model-authored action/treatment/recommendation fields (including immediate/long-term aliases) are replaced with the same fixed nonchemical documentation/referral message at every confidence value.
- `backend/security.py`: credential backoff key is now a hash of the IP/email pair instead of an account-wide email key. This prevents a remote party from locking a named account across all IPs. IP throttling remains separately applied; `acct` threshold constant retained for source compatibility.
- Updated contradictory confidence and login assertions and added `tests/test_queue_hardening.py` with synthetic SQLite fixtures, including failed migration rollback and account-scoped request uniqueness.

## Verification

Commands run from `app/`:

- `PYTHONDONTWRITEBYTECODE=1 /opt/jagakebond/venv/bin/python tests/test_queue_hardening.py` — passed.
- `PYTHONDONTWRITEBYTECODE=1 /opt/jagakebond/venv/bin/python tests/test_foundation.py` — 82/82 passed.
- `PYTHONDONTWRITEBYTECODE=1 /opt/jagakebond/venv/bin/python tests/test_confidence_gate.py` — 64/64 passed.
- `PYTHONDONTWRITEBYTECODE=1 /opt/jagakebond/venv/bin/python -m py_compile backend/db.py backend/queue.py backend/security.py backend/auth.py tests/test_queue_hardening.py tests/test_foundation.py tests/test_confidence_gate.py` — passed.
- `git diff --check` — passed.

## Compatibility and limitations

- Existing jobs have NULL idempotency fields; existing inserts remain compatible because both columns are nullable. The index enforces a single non-NULL request ID per account. API request parsing, server fingerprint calculation, replay semantics, and changed-payload HTTP 409 behavior remain owned by the API implementation card and are not implemented here.
- Targeted lockouts are now per IP/email pair. Account-wide threshold constant remains available to existing callers, but no new account-only attempt rows are generated.
- The fixed action text intentionally supersedes shipped foundation/confidence expectations that previously permitted model-authored advice. `GATE_ISOLATE_TEXT` remains as a compatibility alias to the fixed safe text.
- No production rollout or migration against real data was performed. Parent acceptance and integration verification remain pending.
