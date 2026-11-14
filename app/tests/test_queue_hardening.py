"""Regression tests for queue safety and migration publication."""
from __future__ import annotations

import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))

from backend import db, queue, security  # noqa: E402
from backend.analysis_contract import AnalysisContractError
from model_fixture import diagnosis as fixture_diagnosis

TEST_DB = BASE / "data" / "test_queue_hardening.sqlite3"
for suffix in ("", "-wal", "-shm"):
    Path(str(TEST_DB) + suffix).unlink(missing_ok=True)
db.DB_PATH = TEST_DB
db.close_all()


def account(account_id: str) -> None:
    now = db.now_ms()
    with db.transaction() as tx:
        tx.execute("INSERT INTO accounts (id,email,password_hash,created_ms,updated_ms) VALUES (?,?,?,?,?)",
                   (account_id, f"{account_id}@example.test", "unused", now, now))


def job(job_id: str, status: str, updated: int, image: str = "image") -> None:
    now = db.now_ms()
    with db.transaction() as tx:
        tx.execute("INSERT INTO jobs (id,account_id,status,created_ms,updated_ms,image_b64,context_json) "
                   "VALUES (?,?,?,?,?,?,?)", (job_id, "acct_test", status, now, updated, image, "{}"))


def check(label: str, condition: bool) -> None:
    if not condition:
        raise AssertionError(label)


check("migration version", db.migrate() == db.SCHEMA_VERSION)
check("migration6 idempotency columns retained", {"client_request_id", "request_hash"} <=
      {r["name"] for r in db.query("PRAGMA table_info(jobs)")})
check("migration7 observed severity", "observed_severity" in {r["name"] for r in db.query("PRAGMA table_info(records)")})
account("acct_test")
cols = {r["name"] for r in db.query("PRAGMA table_info(jobs)")}
check("idempotency columns", {"client_request_id", "request_hash"} <= cols)
idx = db.query_one("SELECT sql FROM sqlite_master WHERE name='idx_jobs_account_client_request'")
check("partial account-scoped unique index", "WHERE client_request_id IS NOT NULL" in idx["sql"])
job("active", "claimed", db.now_ms() - 10 * 86_400_000)
job("finished", "done", db.now_ms() - 10 * 86_400_000)
queue.purge_old_jobs()
check("active claim keeps its image", db.query_one("SELECT image_b64 FROM jobs WHERE id='active'")["image_b64"] == "image")
check("old finished job drops image", db.query_one("SELECT image_b64 FROM jobs WHERE id='finished'")["image_b64"] is None)

for marker in ("usable", "TRUE", 1, "false", None, [], {}):
    job_id = "strict_" + str(marker).replace(" ", "_")
    job(job_id, "queued", db.now_ms())
    try:
        queue.complete_job(job_id, {"usable": marker}, {})
    except AnalysisContractError:
        pass
    else:
        raise AssertionError("Malformed triage accepted")
    check("malformed triage leaves job retryable",db.query_one("SELECT status FROM jobs WHERE id=?",(job_id,))["status"]=="queued")

# Completion races require the current lease; terminal transitions cannot be repeated.
job("race", "claimed", db.now_ms())
token="synthetic-current-claim-for-race"
with db.transaction() as tx:
    tx.execute("UPDATE jobs SET claim_token=?,lease_expires_ms=? WHERE id='race'",(token,db.now_ms()+60_000))
first = queue.complete_job("race", {"usable":True,"is_plant":True,"reason":"Synthetic usable photo"}, fixture_diagnosis(),claim_token=token)
second = queue.complete_job("race", {"usable":False,"is_plant":True,"reason":"Synthetic unusable photo"}, {},claim_token=token)
check("one terminal completion only", first is not None and second is None)

# Account lockout can only affect the same IP/email pair, never the named account globally.
security.login_reset("198.51.100.7", "farmer@example.test")
for _ in range(security.THRESHOLDS["pair"][0]):
    security.login_record_failure("198.51.100.7", "farmer@example.test")
check("pair gets throttled", security.login_locked_for_ms("198.51.100.7", "farmer@example.test") > 0)
check("same email elsewhere is not locked", security.login_locked_for_ms("198.51.100.8", "farmer@example.test") == 0)
security.login_reset("198.51.100.7", "farmer@example.test")

# A migration error rolls back both DDL and version publication.
BROKEN_DB = BASE / "data" / "test_migration_atomicity.sqlite3"
for suffix in ("", "-wal", "-shm"):
    Path(str(BROKEN_DB) + suffix).unlink(missing_ok=True)
db.close_all()
db.DB_PATH = BROKEN_DB
db.MIGRATIONS = [(1, "CREATE TABLE marker (id INTEGER);"),
                 (2, "CREATE TABLE partial (id INTEGER); INVALID SQL;")]
try:
    db.migrate()
except Exception:
    pass
else:
    raise AssertionError("broken migration unexpectedly succeeded")
check("failed migration leaves last committed version", db.query_one("SELECT version FROM schema_version")["version"] == 1)
check("failed migration DDL rolled back", db.query_one("SELECT name FROM sqlite_master WHERE name='partial'") is None)

print("queue hardening: all assertions passed")
