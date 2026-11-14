# Fast-tier quota backend handoff

## Policy and API contract

- Fast-only caps by persisted role: `user` (Normal) = 3 per Jakarta calendar day; `priority` = 20; `admin` = unlimited (`fastQuota: null`). Normal-mode jobs do not consume fast capacity.
- Account payloads from `/api/auth/me`, login, and admin account rows include `fastQuota`, `fastUsed`, `fastRemaining` (null for unlimited), `resetAt` (ISO-8601 next Jakarta midnight with `+07:00`), and `timezone: "Asia/Jakarta"`. Legacy `dailyQuota` is retained as computed tier display (0 for unlimited); stored/posted legacy `daily_quota` and `dailyQuota` cannot loosen or change role caps.
- Admission reloads persisted role/active state and counts `analysisTier == "fast"` jobs inside SQLite's serialized writer transaction. Historical jobs are only charged when their context explicitly says fast. Admitted jobs count regardless of terminal/failure status; rejected admissions do not. Matching `clientRequestId` retries remain idempotent, including at cap.
- Daily-cap rejection is HTTP 429 with a daily-quota-specific Indonesian detail and `Retry-After` seconds until the next Asia/Jakarta midnight. Native sync code already honors `Retry-After`.
- Registration continues forcing `user`; only admin account creation/update may assign `priority`. `priority` has no admin-route access. `DEFAULT_DAILY_QUOTA` is labeled deprecated and ignored for caps.

## Verification

Run from this app folder with `/opt/jagakebond/venv/bin/python`:

- `tests/test_fast_tiers.py` — passed (isolated temporary SQLite DB; tier caps, normal jobs, daily boundary, idempotency at cap, failure conservatism, stale/forged roles, promotion/demotion, fixed role display, signup non-escalation, Jakarta reset, quota response header).
- `tests/test_api_contract.py` — passed (existing ownership/idempotency/validation/ack contracts adapted to fixed quota semantics, including transactional race).
- `python -m unittest tests.test_foundation` — passed, 82/82.
- `python -m compileall -q backend tests/test_fast_tiers.py verify_mvp.py` — passed.
- `verify_mvp.py` was updated for fixed quotas and `/me` display, but the end-to-end harness was not run: it requires a separate ephemeral loopback server/database setup. No production service, credentials, data, or network target was used.

The test suite invokes real handler functions against a temporary database. Prior synthetic account fixtures had default role `user`, cap 3; the API-contract concurrency fixture now primes fast-mode usage at the cap before racing two actual handler calls.

## Release note

Backend policy requires deploying the backend changes; an APK/frontend-only release does not enforce it. No app/backend version bump was made in this task. Parent owns packaging/version changes.

## Touched task files

- `backend/api_admin.py`
- `backend/api_app.py`
- `backend/auth.py`
- `backend/db.py`
- `backend/queue.py`
- `backend/settings_store.py`
- `tests/test_fast_tiers.py` (new)
- `tests/test_api_contract.py`
- `verify_mvp.py`
- `review/FAST-TIERS-HANDOFF.md` (this file)

No schema migration is required; role is stored as unconstrained text in existing accounts schema. The existing repository workspace contains other concurrent/unrelated edits from outside this task, so these are the recorded SHA-256 values of this task's exact current source files:

```text
backend/api_admin.py       a85a686fdb24c7c42ba43f5989bc05de929360816b0aa39b425823846e89f136
backend/api_app.py         461b4de208ca02091cbd0ed21355477bde3f9ba61a8f77fcbfec9bd62f7203bb
backend/auth.py            8b33e23e1a4ce880468ab49a8ad92916a08d66dc1152af1472e32e66eb05f15e
backend/db.py              eb991ef23146a4ebf8d1b1b29203091aa4f90fa3557502df61bd64b9f05a8736
backend/queue.py           a11014897cb097ea2ffe2a24c6047625ac883c4227332a9c482dc39f3f5881db
backend/settings_store.py  77a95649bcbedca27edf250c8022f46e12db224d567a0583c6bf145df517791a
tests/test_fast_tiers.py   89e2997763df5324db99985057dfad0f7ef0004092ad8bae722212d72535a3e6
tests/test_api_contract.py f02c13b578c0144f1be2f16c2f4d5c55170deab14cb3e652c1b8b50cc1c783a4
verify_mvp.py              dd844c0790fc03b2a0412014bd061d56e77c34f258b66296dbb3475d4ad2c187
```.
