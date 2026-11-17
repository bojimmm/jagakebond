"""SQLite data layer for JagaKebond.

Replaces the single-JSON-file store. One connection per thread (FastAPI runs sync
endpoints in a threadpool) with WAL so readers never block the writer, and one
module-level lock around write transactions because SQLite allows a single writer.

Still a single-process design: run exactly one uvicorn worker. Moving to multiple
workers or processes means Postgres — see deploy/README.md.
"""

from __future__ import annotations

import json
import math
import sqlite3
import threading
import time
import uuid

from .crop_names import canonical_crop_name
from .assessment import clean_assessment, clean_previous_condition
from .analysis_contract import clean_provenance
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Sequence

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "db.sqlite3"
LEGACY_JSON_PATH = DATA_DIR / "db.json"

DATA_DIR.mkdir(parents=True, exist_ok=True)

_local = threading.local()
_write_lock = threading.Lock()

SCHEMA_VERSION = 12


def now_ms() -> int:
    return int(time.time() * 1000)


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


# ---------------------------------------------------------------------------
# Connection handling
# ---------------------------------------------------------------------------


def _configure(connection: sqlite3.Connection) -> None:
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute("PRAGMA busy_timeout=5000")
    connection.execute("PRAGMA synchronous=NORMAL")


def conn() -> sqlite3.Connection:
    """Thread-local connection. Safe to call from request handlers and the worker."""
    existing = getattr(_local, "connection", None)
    if existing is None:
        existing = sqlite3.connect(DB_PATH, timeout=5.0, isolation_level=None)
        _configure(existing)
        _local.connection = existing
    return existing


def close_all() -> None:
    existing = getattr(_local, "connection", None)
    if existing is not None:
        existing.close()
        _local.connection = None


# ---------------------------------------------------------------------------
# Query helpers
# ---------------------------------------------------------------------------


def query(sql: str, params: Sequence[Any] = ()) -> list[dict[str, Any]]:
    rows = conn().execute(sql, tuple(params)).fetchall()
    return [dict(row) for row in rows]


def query_one(sql: str, params: Sequence[Any] = ()) -> dict[str, Any] | None:
    row = conn().execute(sql, tuple(params)).fetchone()
    return dict(row) if row else None


def execute(sql: str, params: Sequence[Any] = ()) -> sqlite3.Cursor:
    """Single autocommit statement."""
    return conn().execute(sql, tuple(params))


def execute_many(sql: str, rows: Iterable[Sequence[Any]]) -> None:
    conn().executemany(sql, [tuple(row) for row in rows])


@contextmanager
def transaction() -> Iterator[sqlite3.Connection]:
    """Serialised write transaction: BEGIN IMMEDIATE, commit, or roll back."""
    with _write_lock:
        connection = conn()
        connection.execute("BEGIN IMMEDIATE")
        try:
            yield connection
        except BaseException:
            connection.execute("ROLLBACK")
            raise
        connection.execute("COMMIT")


def to_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def from_json(raw: Any, fallback: Any) -> Any:
    if raw is None or raw == "":
        return fallback
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return fallback


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS accounts (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name           TEXT NOT NULL DEFAULT '',
  role           TEXT NOT NULL DEFAULT 'user',
  password_hash  TEXT NOT NULL,
  is_active      INTEGER NOT NULL DEFAULT 1,
  daily_quota    INTEGER NOT NULL DEFAULT 0,
  created_ms     INTEGER NOT NULL,
  updated_ms     INTEGER NOT NULL,
  last_login_ms  INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_ms   INTEGER NOT NULL,
  expires_ms   INTEGER NOT NULL,
  user_agent   TEXT,
  ip           TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);

CREATE TABLE IF NOT EXISTS login_attempts (
  key             TEXT PRIMARY KEY,
  fails           INTEGER NOT NULL DEFAULT 0,
  locked_until_ms INTEGER NOT NULL DEFAULT 0,
  updated_ms      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  is_secret  INTEGER NOT NULL DEFAULT 0,
  updated_ms INTEGER,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_ms       INTEGER NOT NULL,
  account_id  TEXT,
  actor_email TEXT,
  action      TEXT NOT NULL,
  target      TEXT,
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts_ms DESC);

CREATE TABLE IF NOT EXISTS records (
  id               TEXT PRIMARY KEY,
  account_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  crop_id          TEXT,
  crop_name        TEXT,
  timestamp_ms     INTEGER,
  crop             TEXT,
  condition        TEXT,
  severity         TEXT,
  lat              REAL,
  lng              REAL,
  elevation        REAL,
  location_name    TEXT,
  accuracy         REAL,
  date             TEXT,
  symptoms         TEXT,
  geocorrelation   TEXT,
  immediate_action TEXT,
  suitability      TEXT,
  needs_review     INTEGER NOT NULL DEFAULT 0,
  confidence       REAL,
  farm_id          TEXT,
  device_id        TEXT,
  image_url        TEXT,
  source           TEXT,
  created_ms       INTEGER NOT NULL,
  updated_ms       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_account_ts ON records(account_id, timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS idx_records_farm ON records(farm_id);

CREATE TABLE IF NOT EXISTS daily (
  id                     TEXT PRIMARY KEY,
  account_id             TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date                   TEXT,
  timestamp_ms           INTEGER,
  title                  TEXT,
  summary                TEXT,
  actions_json           TEXT NOT NULL DEFAULT '[]',
  source_record_ids_json TEXT NOT NULL DEFAULT '[]',
  zones_json             TEXT NOT NULL DEFAULT '[]',
  created_ms             INTEGER NOT NULL,
  updated_ms             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_daily_account_ts ON daily(account_id, timestamp_ms DESC);

CREATE TABLE IF NOT EXISTS farms (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name        TEXT,
  crop        TEXT,
  note        TEXT,
  ring_json   TEXT NOT NULL,
  area_m2     REAL,
  source      TEXT,
  created_ms  INTEGER,
  updated_ms  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_farms_account ON farms(account_id, created_ms DESC);

CREATE TABLE IF NOT EXISTS jobs (
  id               TEXT PRIMARY KEY,
  account_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status           TEXT NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 0,
  created_ms       INTEGER NOT NULL,
  updated_ms       INTEGER NOT NULL,
  claimed_ms       INTEGER,
  worker           TEXT,
  device_id        TEXT,
  image_b64        TEXT,
  context_json     TEXT NOT NULL,
  triage_json      TEXT,
  diagnosis_json   TEXT,
  error            TEXT,
  acked            INTEGER NOT NULL DEFAULT 0,
  token_prompt     INTEGER,
  token_completion INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_ms);
CREATE INDEX IF NOT EXISTS idx_jobs_account ON jobs(account_id, created_ms DESC);

CREATE TABLE IF NOT EXISTS photos (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  file_name   TEXT NOT NULL,
  bytes       INTEGER NOT NULL DEFAULT 0,
  created_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_photos_account ON photos(account_id, created_ms DESC);
"""


def _statements(script: str) -> list[str]:
    """Split a DDL script into statements.

    sqlite3's executescript() issues an implicit COMMIT, which would break the
    explicit transaction the migration runs in, so the schema is executed one
    statement at a time. Safe here because the schema contains no semicolons
    inside string literals or trigger bodies.
    """
    return [part.strip() for part in script.split(";") if part.strip()]


# Every model call leaves a row here, so an operator can see that the worker
# really did contact the router — and what came back — instead of guessing.
SCHEMA_V2_SQL = """
CREATE TABLE IF NOT EXISTS job_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  ts_ms       INTEGER NOT NULL,
  stage       TEXT NOT NULL,
  model       TEXT,
  http_status INTEGER,
  latency_ms  INTEGER,
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id, ts_ms);
"""

# The farmer may type what they think the plant is (often a regional name such as
# "cengek"). That hint helps the model, but the record keeps the model's standardised
# name in `crop`; the raw wording is preserved here for traceability.
SCHEMA_V3_SQL = """
ALTER TABLE records ADD COLUMN crop_hint TEXT;
"""

# The activity queries all order by "when did this happen", falling back to the
# insert time: ORDER BY COALESCE(timestamp_ms, created_ms) DESC. That expression is
# not in any index, so SQLite had to materialise EVERY record an account owns, sort
# it, and discard all but the newest handful — on every claim, because the prompt
# context needs two history lines. An expression index makes it a range scan.
SCHEMA_V4_SQL = """
CREATE INDEX IF NOT EXISTS idx_records_account_activity
  ON records(account_id, COALESCE(timestamp_ms, created_ms) DESC);
CREATE INDEX IF NOT EXISTS idx_daily_account_activity
  ON daily(account_id, COALESCE(timestamp_ms, created_ms) DESC);
"""

# Every photo ever analysed used to keep its ~100-200 KB base64 payload in `jobs`
# forever, long after the job finished. New jobs are cleared on completion now; this
# empties the existing backlog. The phone never reads an image out of a job row
# (row_job omits it), so this cannot affect a farmer still waiting for a result.
SCHEMA_V5_SQL = """
UPDATE jobs SET image_b64 = NULL
 WHERE image_b64 IS NOT NULL AND status IN ('done','rejected','failed','cancelled');
"""

# Client retries use a stable account-scoped key. The digest is calculated by the
# server from the original uploaded bytes and normalized capture context.
SCHEMA_V6_SQL = """
ALTER TABLE jobs ADD COLUMN client_request_id TEXT;
ALTER TABLE jobs ADD COLUMN request_hash TEXT;
CREATE UNIQUE INDEX idx_jobs_account_client_request
  ON jobs(account_id, client_request_id) WHERE client_request_id IS NOT NULL;
"""

# Farmers may correct their visual observation without mutating authoritative AI output.
SCHEMA_V7_SQL = """
ALTER TABLE records ADD COLUMN observed_severity TEXT;
"""

SCHEMA_V8_SQL = """
ALTER TABLE records ADD COLUMN extra_json TEXT NOT NULL DEFAULT '{}';
"""

# 0.2.2.0. Queue fairness: a job the provider keeps failing on is released with a
# growing not-before delay instead of going straight back to the head of the FIFO,
# and is given up after a bounded number of releases (release_count/first_claimed_ms).
# The photo lifecycle tables (backend/storage.py) are part of this same version:
#   storage_meta     small key/value state; 'epoch' identifies the coherent DB/uploads
#                    generation (bumped by restore tooling, copied into every ticket).
#   storage_objects  registry of every file under data/uploads: immutable names,
#                    states reserved/published/retiring/retired, NO foreign key to accounts
#                    (an account cascade must never remove it). Names are unique and a
#                    retired name is never reused.
#   photo_cleanup    durable cleanup tickets (pending/blocked/done) with the captured
#                    file identity dev/ino/size, safe error code, retry schedule and epoch.
#                    No account foreign key either. At most one OPEN ticket per name.
# Existing photo rows are registered as 'published' by db._backfill_v9 right after the DDL,
# inside the same transaction as the version bump (duplicate/invalid names are reported
# through storage_objects.anomaly, never fixed).
SCHEMA_V9_SQL = """
ALTER TABLE jobs ADD COLUMN release_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN not_before_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN first_claimed_ms INTEGER;
CREATE INDEX IF NOT EXISTS idx_jobs_status_not_before
  ON jobs(status, not_before_ms, created_ms);
CREATE TABLE IF NOT EXISTS storage_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO storage_meta (key, value) VALUES ('epoch', '1');
CREATE TABLE IF NOT EXISTS storage_objects (
  name         TEXT PRIMARY KEY COLLATE NOCASE,
  photo_id     TEXT,
  owner_id     TEXT,
  state        TEXT NOT NULL CHECK (state IN ('reserved','published','retiring','retired')),
  anomaly      TEXT,
  bytes        INTEGER,
  origin       TEXT NOT NULL DEFAULT 'upload',
  created_ms   INTEGER NOT NULL,
  published_ms INTEGER,
  updated_ms   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_storage_objects_photo ON storage_objects(photo_id);
CREATE INDEX IF NOT EXISTS idx_storage_objects_owner_state ON storage_objects(owner_id, state);
CREATE TABLE IF NOT EXISTS photo_cleanup (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL COLLATE NOCASE,
  photo_id        TEXT,
  owner_id        TEXT,
  reason          TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('pending','blocked','done')),
  block_reason    TEXT,
  dev             INTEGER,
  ino             INTEGER,
  size            INTEGER,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_ms INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  epoch           INTEGER NOT NULL,
  created_ms      INTEGER NOT NULL,
  updated_ms      INTEGER NOT NULL,
  done_ms         INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_photo_cleanup_open_name
  ON photo_cleanup(name) WHERE state != 'done';
CREATE INDEX IF NOT EXISTS idx_photo_cleanup_due ON photo_cleanup(state, next_attempt_ms);
CREATE INDEX IF NOT EXISTS idx_photo_cleanup_photo ON photo_cleanup(photo_id);
"""


# 0.2.3.0. Sign in with Google (backend/google_auth.py):
#   google_identities      a verified Google account (`sub`) linked to one local account; the link
#                          goes with the account (ON DELETE CASCADE).
#   registration_requests  one row per Google `sub` that asked to join; an admin approves (a
#                          password-less 'user' account is created and linked) or rejects it.
#   auth_nonces            single-use sign-in nonces (10 minutes), purged when expired.
SCHEMA_V10_SQL = """
ALTER TABLE accounts ADD COLUMN admin_created INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN last_password_login_ms INTEGER;
UPDATE accounts SET last_password_login_ms = COALESCE(last_login_ms,
  CASE WHEN EXISTS (SELECT 1 FROM audit_log WHERE action = 'account.register'
    AND target = accounts.email COLLATE NOCASE AND ts_ms >= accounts.created_ms)
  THEN created_ms END);
UPDATE accounts SET admin_created = 1 WHERE role = 'admin' OR EXISTS (
  SELECT 1 FROM audit_log WHERE action = 'account.create' AND actor_email IS NOT NULL
    AND target = accounts.email COLLATE NOCASE
    AND ts_ms BETWEEN accounts.created_ms AND accounts.created_ms + 60000
);
-- Historical provenance can be missing after audit retention. Fail closed for
-- existing untrusted accounts rather than treating missing history as no login.
UPDATE accounts SET last_password_login_ms = COALESCE(last_password_login_ms, created_ms, 0)
  WHERE admin_created = 0;
CREATE TABLE IF NOT EXISTS google_identities (
  sub           TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email         TEXT,
  created_ms    INTEGER,
  last_login_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_google_identities_account ON google_identities(account_id);
CREATE TABLE IF NOT EXISTS registration_requests (
  id          TEXT PRIMARY KEY,
  sub         TEXT UNIQUE NOT NULL,
  email       TEXT NOT NULL,
  name        TEXT,
  status      TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
  created_ms  INTEGER,
  updated_ms  INTEGER,
  decided_ms  INTEGER,
  decided_by  TEXT,
  account_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_registration_requests_status ON registration_requests(status, created_ms);
CREATE TABLE IF NOT EXISTS auth_nonces (
  nonce      TEXT PRIMARY KEY,
  ip_hash    TEXT NOT NULL DEFAULT '',
  expires_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_nonces_expires ON auth_nonces(expires_ms);
CREATE INDEX IF NOT EXISTS idx_auth_nonces_ip ON auth_nonces(ip_hash, expires_ms);
CREATE TABLE IF NOT EXISTS google_request_limits (
  ip_hash TEXT PRIMARY KEY,
  window_start_ms INTEGER NOT NULL,
  requests INTEGER NOT NULL
);
"""


def _backfill_v9(tx: sqlite3.Connection) -> None:
    """Register every existing photo file in the storage registry (runs inside the v9 transaction)."""
    from . import storage
    storage.backfill_registry(tx)


SCHEMA_V11_SQL = """
ALTER TABLE jobs ADD COLUMN claim_token TEXT;
ALTER TABLE jobs ADD COLUMN claim_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN lease_expires_ms INTEGER;
UPDATE jobs SET status='queued', worker=NULL, claimed_ms=NULL WHERE status='claimed';
"""

SCHEMA_V12_SQL = """
ALTER TABLE accounts ADD COLUMN avatar_url TEXT NOT NULL DEFAULT '';
"""

MIGRATIONS: list[tuple[int, str]] = [
    (1, SCHEMA_SQL),
    (2, SCHEMA_V2_SQL),
    (3, SCHEMA_V3_SQL),
    (4, SCHEMA_V4_SQL),
    (5, SCHEMA_V5_SQL),
    (6, SCHEMA_V6_SQL),
    (7, SCHEMA_V7_SQL),
    (8, SCHEMA_V8_SQL),
    (9, SCHEMA_V9_SQL),
    (10, SCHEMA_V10_SQL),
    (11, SCHEMA_V11_SQL),
    (12, SCHEMA_V12_SQL),
]

# Python steps that run inside the SAME transaction as the version they belong to, right
# after that version's DDL (a data backfill that plain SQL cannot express).
MIGRATION_HOOKS: dict[int, Any] = {
    9: _backfill_v9,
}


def migrate() -> int:
    """Apply pending migrations in order. Returns the resulting schema version."""
    connection = conn()
    connection.execute(
        "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)"
    )
    row = connection.execute("SELECT version FROM schema_version").fetchone()
    current = int(row["version"]) if row else 0

    for version, script in MIGRATIONS:
        if current < version:
            # Publish DDL/data and the corresponding version in one commit. A
            # crash can therefore never advertise a migration that did not land.
            with transaction() as tx:
                row = tx.execute("SELECT version FROM schema_version").fetchone()
                applied = int(row["version"]) if row else 0
                if applied < version:
                    for statement in _statements(script):
                        tx.execute(statement)
                    hook = MIGRATION_HOOKS.get(version)
                    if hook is not None:
                        hook(tx)
                    tx.execute("DELETE FROM schema_version")
                    tx.execute("INSERT INTO schema_version (version) VALUES (?)", (version,))
            current = max(current, version)
    return current


def reset_for_tests() -> None:
    """Drop every row. Only used by the verification harness."""
    with transaction() as tx:
        for table in ("photo_cleanup", "storage_objects", "job_events", "photos", "jobs", "farms",
                      "daily", "records", "audit_log", "settings", "login_attempts", "sessions",
                      "google_identities", "registration_requests", "auth_nonces", "google_request_limits", "accounts"):
            tx.execute(f"DELETE FROM {table}")
        # The storage epoch is schema-level state, not data: keep (or restore) its row.
        tx.execute("DELETE FROM storage_meta WHERE key != 'epoch'")
        tx.execute("INSERT OR IGNORE INTO storage_meta (key, value) VALUES ('epoch', '1')")


# ---------------------------------------------------------------------------
# Row marshalling
# ---------------------------------------------------------------------------


def row_record(row: dict[str, Any]) -> dict[str, Any]:
    extra = from_json(row.get("extra_json"), {})
    extra = extra if isinstance(extra, dict) else {}
    confidence = row.get("confidence")
    uncertain = (isinstance(confidence, bool) or not isinstance(confidence, (int, float))
                 or not math.isfinite(confidence) or confidence < 0.5)
    return {
        "id": row["id"],
        "cropId": row["crop_id"],
        "cropName": canonical_crop_name(row["crop_name"]),
        "timestampMs": row["timestamp_ms"],
        "createdMs": row["created_ms"],
        "uploadedMs": extra.get("uploadedMs") or row["created_ms"],
        "assessment": clean_assessment(extra.get("assessment"), uncertain=uncertain),
        "analysisProvenance": clean_provenance(extra.get("analysisProvenance")),
        "previousCondition": clean_previous_condition(extra.get("previousCondition")),
        "captureTimeKnown": extra.get("captureTimeKnown"),
        "captureTimeSource": extra.get("captureTimeSource"),
        "photoTimestampMs": None if extra.get("captureTimeKnown") is False else row["timestamp_ms"],
        "updatedMs": row["updated_ms"],
        "crop": canonical_crop_name(row["crop"]),
        "condition": row["condition"],
        "severity": row["severity"],
        "observedSeverity": row["observed_severity"],
        "observedProblems": ({"disease": extra["observedProblems"].get("disease", "")[:80],
                              "pest": extra["observedProblems"].get("pest", "")[:80]}
                             if isinstance(extra.get("observedProblems"), dict)
                             and isinstance(extra["observedProblems"].get("disease", ""), str)
                             and isinstance(extra["observedProblems"].get("pest", ""), str) else None),
        "lat": row["lat"],
        "lng": row["lng"],
        "elevation": row["elevation"],
        "weather": extra.get("weather") if isinstance(extra.get("weather"), str) else None,
        "locationName": row["location_name"],
        "accuracy": row["accuracy"],
        "date": row["date"],
        "symptoms": row["symptoms"],
        "geocorrelation": row["geocorrelation"],
        "immediate_action": row["immediate_action"],
        "suitability": row["suitability"],
        "needs_review": bool(row["needs_review"]),
        "confidence": row["confidence"],
        "farmId": row["farm_id"],
        "deviceId": row["device_id"],
        "imageUrl": row["image_url"],
        "source": row["source"],
        "cropHint": row["crop_hint"],
        "locationSource": (lambda extra: extra.get("locationSource") if isinstance(extra, dict) else None)(from_json(row.get("extra_json"), {})),
        # Farmer corrections stay beside the original AI fields in extra_json.
        "correctedFields": [f for f in extra.get("corrected", []) if f in ("crop", "date")] if isinstance(extra.get("corrected"), list) else [],
        "aiCrop": canonical_crop_name(extra.get("aiCrop")) if isinstance(extra.get("aiCrop"), str) else None,
    }


def row_daily(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "date": row["date"],
        "timestampMs": row["timestamp_ms"],
        "title": row["title"],
        "summary": row["summary"],
        "actions": from_json(row["actions_json"], []),
        "sourceRecordIds": from_json(row["source_record_ids_json"], []),
        "zones": from_json(row["zones_json"], []),
    }


def row_farm(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "crop": row["crop"],
        "note": row["note"],
        "ring": from_json(row["ring_json"], []),
        "areaM2": row["area_m2"],
        "source": row["source"],
        "createdMs": row["created_ms"],
        "updatedMs": row["updated_ms"],
    }


def row_job(row: dict[str, Any], include_image: bool = False) -> dict[str, Any]:
    job = {
        "id": row["id"],
        "accountId": row["account_id"],
        "status": row["status"],
        "attempts": row["attempts"],
        "createdMs": row["created_ms"],
        "updatedMs": row["updated_ms"],
        "claimedMs": row["claimed_ms"],
        "worker": row["worker"],
        "deviceId": row["device_id"],
        "context": from_json(row["context_json"], {}),
        "triage": from_json(row["triage_json"], None),
        "diagnosis": from_json(row["diagnosis_json"], None),
        "error": row["error"],
        "acked": bool(row["acked"]),
    }
    if include_image:
        job["image_b64"] = row["image_b64"]
        job["claimToken"] = row.get("claim_token")
        job["claimGeneration"] = row.get("claim_generation")
        job["leaseExpiresMs"] = row.get("lease_expires_ms")
    return job


def public_avatar_url(stored: Any) -> str | None:
    """Return a displayable avatar URL, hiding opted-out ('hidden:...') values."""
    text = str(stored or "").strip()
    if not text or text.startswith("hidden:"):
        return None
    if text.startswith("https://") and len(text) <= 512:
        return text
    return None


def row_account(row: dict[str, Any]) -> dict[str, Any]:
    from . import queue
    tier = queue.fast_quota_snapshot(row)
    stored_avatar = str(row.get("avatar_url") or "")
    return {
        "id": row["id"],
        "email": row["email"],
        "name": row["name"],
        "role": row["role"],
        "avatarUrl": public_avatar_url(stored_avatar),
        "canRestoreGoogleAvatar": stored_avatar.startswith("hidden:https://"),
        "isActive": bool(row["is_active"]),
        "dailyQuota": tier["fastQuota"] or 0,
        **tier,
        "createdMs": row["created_ms"],
        "updatedMs": row["updated_ms"],
        "lastLoginMs": row["last_login_ms"],
    }


# ---------------------------------------------------------------------------
# Seeds — the PRD section 9 demo data, now owned by one account
# ---------------------------------------------------------------------------


def seed_for_account(account_id: str) -> dict[str, int]:
    """Insert the 4 Bogor records / 1 daily / 2 farms from PRD section 9."""
    now = now_ms()
    day = 86_400_000

    def record(index, crop_id, crop_name, crop, condition, severity, lat, lng, elev,
               place, acc, days_ago, symptoms, geo, action, suit, image_url=None):
        stamp = now - days_ago * day
        return {
            "id": f"rec_seed{index:06d}",
            "account_id": account_id,
            "crop_id": crop_id,
            "crop_name": crop_name,
            "timestamp_ms": stamp,
            "crop": crop,
            "condition": condition,
            "severity": severity,
            "lat": lat,
            "lng": lng,
            "elevation": elev,
            "location_name": place,
            "accuracy": acc,
            "date": time.strftime("%Y-%m-%d", time.localtime(stamp / 1000)),
            "symptoms": symptoms,
            "geocorrelation": geo,
            "immediate_action": action,
            "suitability": suit,
            "needs_review": 0,
            "confidence": None,
            "farm_id": None,
            "device_id": None,
            "image_url": image_url,
            "source": "seed",
            "created_ms": stamp,
            "updated_ms": stamp,
        }

    records = [
        record(1, "kopi", "Kopi Arabika", "Kopi", "Karat Daun (Hemileia vastatrix)", "Severe",
               -6.5950, 106.8160, 265, "Bogor Tengah, Jawa Barat", 12, 2,
               "Bercak oranye-kuning pada permukaan bawah daun, tepi daun menguning, daun rontok di bagian bawah tajuk.",
               "Kelembapan tinggi disertai curah hujan sore hari selama 5 hari terakhir mempercepat penyebaran spora karat daun.",
               "Pangkas dan musnahkan daun terinfeksi, perbaiki sirkulasi udara antar pohon, lalu konsultasikan jadwal aplikasi fungisida dengan POPT setempat.",
               "Lahan dataran menengah (200-400 m dpl) dengan drainase sedang; rotasi naungan disarankan."),
        record(2, "cabai", "Cabai Merah Keriting", "Cabai", "Bercak Daun (Cercospora capsici)", "Moderate",
               -6.6205, 106.7840, 320, "Bogor Barat, Jawa Barat", 15, 5,
               "Bercak bulat kecoklatan dengan pusat kelabu pada daun tua, sebagian daun berlubang.",
               "Percikan air hujan dari tanah membawa inokulum ke daun bawah; jarak tanam rapat memperlambat pengeringan daun.",
               "Kurangi kelembapan kanopi dengan penjarangan, mulsa untuk menekan percikan tanah, dan pantau 3-5 hari sebelum memutuskan aplikasi bahan aktif.",
               "Dataran menengah dengan suhu siang 27-30 C; cocok untuk cabai namun waspada bercak daun."),
        record(3, "jagung", "Jagung Manis", "Jagung", "Hawar Daun (Exserohilum turcicum)", "Moderate",
               -6.5410, 106.7430, 210, "Dramaga, Bogor, Jawa Barat", 9, 8,
               "Lesi memanjang berbentuk cerutu berwarna coklat keabu-abuan pada daun bagian bawah dan tengah.",
               "Sisa tanaman jagung musim sebelumnya di sekitar petak menjadi sumber inokulum; kelembapan pagi tinggi memperpanjang periode infeksi.",
               "Bersihkan sisa tanaman, rotasi dengan bukan inang, dan pantau perkembangan lesi setiap 3 hari.",
               "Dataran rendah-menengah (200-250 m dpl), curah hujan tinggi; potensi hawar daun meningkat di musim hujan."),
        record(4, "teh", "Teh Rakyat", "Teh", "Daun Sehat", "Healthy",
               -6.5660, 106.8500, 410, "Ciawi, Bogor, Jawa Barat", 14, 11,
               "Warna daun seragam hijau segar, tidak ada bercak atau defoliasi pada pucuk dan daun muda.",
               "Kelembapan relatif dan suhu saat ini berada pada rentang nyaman untuk pertumbuhan pucuk teh.",
               "Pertahankan pemupukan berimbang dan pemangkasan rutin; lanjutkan pemantauan mingguan.",
               "Dataran menengah atas (400-450 m dpl) dengan kabut pagi; sesuai untuk teh."),
    ]

    daily_rows = [{
        "id": "daily_seed000001",
        "account_id": account_id,
        "date": time.strftime("%Y-%m-%d", time.localtime((now - day) / 1000)),
        "timestamp_ms": now - day,
        "title": "Rekomendasi Harian — Priangan Barat",
        "summary": ("Kelembapan tinggi disertai hujan sore diperkirakan bertahan 3 hari ke depan. "
                    "Prioritaskan pemeriksaan daun bagian bawah pada kopi dan cabai karena kondisi ini "
                    "mempercepat penyebaran penyakit bercak dan karat daun."),
        "actions_json": to_json([
            "Periksa permukaan bawah daun kopi dan cabai pada 20 tanaman contoh per petak.",
            "Pangkas bagian kanopi yang terlalu rapat agar sirkulasi udara membaik.",
            "Tunda aplikasi bahan aktif sampai hasil pemantauan 3-5 hari selesai; konsultasikan dengan POPT.",
            "Pastikan drainase petak lancar menjelang hujan sore.",
        ]),
        "source_record_ids_json": to_json(["rec_seed000001", "rec_seed000002"]),
        "zones_json": to_json(["Bogor Tengah", "Bogor Barat", "Dramaga"]),
        "created_ms": now - day,
        "updated_ms": now - day,
    }]

    farm_rows = [
        {
            "id": "farm_seed000001", "account_id": account_id, "name": "Kebun Kopi Ciasmara",
            "crop": "Kopi", "note": "Petak utama, naungan sengon, drainase sedang.",
            "ring_json": to_json([[-6.5940, 106.8150], [-6.5962, 106.8175], [-6.5978, 106.8148],
                                  [-6.5955, 106.8122], [-6.5940, 106.8150]]),
            "area_m2": 61230.5, "source": "seed",
            "created_ms": now - 20 * day, "updated_ms": now - 3 * day,
        },
        {
            "id": "farm_seed000002", "account_id": account_id, "name": "Ladang Cabai Pasirkuda",
            "crop": "Cabai", "note": "Lahan sewa, mulsa plastik, dekat saluran irigasi.",
            "ring_json": to_json([[-6.6200, 106.7830], [-6.6225, 106.7852], [-6.6238, 106.7825],
                                  [-6.6212, 106.7805], [-6.6200, 106.7830]]),
            "area_m2": 44010.0, "source": "seed",
            "created_ms": now - 12 * day, "updated_ms": now - 5 * day,
        },
    ]

    with transaction() as tx:
        tx.executemany(
            """INSERT OR REPLACE INTO records
               (id, account_id, crop_id, crop_name, timestamp_ms, crop, condition, severity, lat, lng,
                elevation, location_name, accuracy, date, symptoms, geocorrelation, immediate_action,
                suitability, needs_review, confidence, farm_id, device_id, image_url, source,
                created_ms, updated_ms)
               VALUES (:id,:account_id,:crop_id,:crop_name,:timestamp_ms,:crop,:condition,:severity,
                       :lat,:lng,:elevation,:location_name,:accuracy,:date,:symptoms,:geocorrelation,
                       :immediate_action,:suitability,:needs_review,:confidence,:farm_id,:device_id,
                       :image_url,:source,:created_ms,:updated_ms)""",
            records,
        )
        tx.executemany(
            """INSERT OR REPLACE INTO daily
               (id, account_id, date, timestamp_ms, title, summary, actions_json,
                source_record_ids_json, zones_json, created_ms, updated_ms)
               VALUES (:id,:account_id,:date,:timestamp_ms,:title,:summary,:actions_json,
                       :source_record_ids_json,:zones_json,:created_ms,:updated_ms)""",
            daily_rows,
        )
        tx.executemany(
            """INSERT OR REPLACE INTO farms
               (id, account_id, name, crop, note, ring_json, area_m2, source, created_ms, updated_ms)
               VALUES (:id,:account_id,:name,:crop,:note,:ring_json,:area_m2,:source,:created_ms,:updated_ms)""",
            farm_rows,
        )
    return {"records": len(records), "daily": len(daily_rows), "farms": len(farm_rows)}


# ---------------------------------------------------------------------------
# Legacy JSON import (one time)
# ---------------------------------------------------------------------------


def import_legacy_json(account_id: str) -> dict[str, int] | None:
    """Import data/db.json into the given account, exactly once.

    Guararded by the settings flag `legacy_imported` so re-running never duplicates.
    """
    existing = query_one("SELECT value FROM settings WHERE key = 'legacy_imported'")
    if existing and existing["value"] == "1":
        return None
    if not LEGACY_JSON_PATH.exists():
        with transaction() as tx:
            tx.execute("INSERT OR REPLACE INTO settings (key, value, is_secret, updated_ms) "
                       "VALUES ('legacy_imported', '1', 0, ?)", (now_ms(),))
        return None

    try:
        payload = json.loads(LEGACY_JSON_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None

    counts = {"records": 0, "daily": 0, "farms": 0, "jobs": 0}
    with transaction() as tx:
        for record in payload.get("records") or []:
            stamp = record.get("timestampMs") or now_ms()
            tx.execute(
                """INSERT OR REPLACE INTO records
                   (id, account_id, crop_id, crop_name, timestamp_ms, crop, condition, severity,
                    lat, lng, elevation, location_name, accuracy, date, symptoms, geocorrelation,
                    immediate_action, suitability, needs_review, confidence, farm_id, device_id,
                    image_url, source, created_ms, updated_ms)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (record.get("id") or new_id("rec"), account_id, record.get("cropId"),
                 record.get("cropName"), stamp, record.get("crop"), record.get("condition"),
                 record.get("severity"), record.get("lat"), record.get("lng"),
                 record.get("elevation"), record.get("locationName"), record.get("accuracy"),
                 record.get("date"), record.get("symptoms"), record.get("geocorrelation"),
                 record.get("immediate_action"), record.get("suitability"),
                 1 if record.get("needs_review") else 0, record.get("confidence"),
                 record.get("farmId"), record.get("deviceId"), record.get("imageUrl"),
                 record.get("source") or "legacy", stamp, stamp),
            )
            counts["records"] += 1
        for entry in payload.get("daily") or []:
            stamp = entry.get("timestampMs") or now_ms()
            tx.execute(
                """INSERT OR REPLACE INTO daily
                   (id, account_id, date, timestamp_ms, title, summary, actions_json,
                    source_record_ids_json, zones_json, created_ms, updated_ms)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (entry.get("id") or new_id("daily"), account_id, entry.get("date"), stamp,
                 entry.get("title"), entry.get("summary"), to_json(entry.get("actions") or []),
                 to_json(entry.get("sourceRecordIds") or []), to_json(entry.get("zones") or []),
                 stamp, stamp),
            )
            counts["daily"] += 1
        for farm in payload.get("farms") or []:
            tx.execute(
                """INSERT OR REPLACE INTO farms
                   (id, account_id, name, crop, note, ring_json, area_m2, source, created_ms, updated_ms)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (farm.get("id") or new_id("farm"), account_id, farm.get("name"), farm.get("crop"),
                 farm.get("note"), to_json(farm.get("ring") or []), farm.get("areaM2"),
                 farm.get("source") or "legacy", farm.get("createdMs") or now_ms(),
                 farm.get("updatedMs") or now_ms()),
            )
            counts["farms"] += 1
        tx.execute("INSERT OR REPLACE INTO settings (key, value, is_secret, updated_ms) "
                   "VALUES ('legacy_imported', '1', 0, ?)", (now_ms(),))
    return counts
