"""Job queue helpers, fenced leases, and the observation-guidance boundary.

Observation severity is preserved independently of an uncalibrated self-score.
Uncertainty limits cause/target claims and treatment text. The gate remains
re-exported from app.py for existing importers and synthetic tests.

0.2.2.0 additions: released jobs wait behind the rest of the queue (persistent
backoff), a job the provider keeps failing on is eventually given up instead of
blocking everyone, the stored diagnosis is rebuilt from an allowlist of fields, and
the worker's heartbeat is recorded for the admin console.
"""

from __future__ import annotations

import math
import re
import secrets
import threading
from typing import Any

from . import db, textsafe
from .assessment import clean_assessment, clean_previous_condition
from .crop_names import canonical_crop_name
from .analysis_contract import validate_diagnosis, validate_triage, clean_provenance

_SEVERITIES = ("Severe", "Moderate", "Healthy")

GATE_REPHOTO_TEXT = (
    "Dokumentasikan gejala dan pantau perubahan. Untuk penilaian dan tindakan yang sesuai, "
    "hubungi penyuluh pertanian atau petugas perlindungan tanaman setempat."
)
GATE_ISOLATE_TEXT = GATE_REPHOTO_TEXT


def apply_confidence_gate(diagnosis: dict[str, Any] | None) -> dict[str, Any]:
    """Re-apply the PRD section 6 gate. Never trust a raw model severity."""
    d = dict(diagnosis) if isinstance(diagnosis, dict) else {}

    severity = d.get("severity")
    severity = severity.strip() if isinstance(severity, str) else ""
    if severity not in _SEVERITIES:
        severity = "Moderate"

    # float("nan") and float("inf") both parse successfully, and min(1.0, nan)
    # returns 1.0 — so a confidence the model should never have sent would grant
    # MAXIMUM trust and skip every check below, pesticide strip included. A bool
    # is not a confidence either (float(True) == 1.0). Anything that is not a
    # finite real number means "we do not know", and not knowing means zero.
    raw_confidence = d.get("confidence")
    if isinstance(raw_confidence, bool):
        confidence = 0.0
    else:
        try:
            confidence = float(raw_confidence)
        except (TypeError, ValueError):
            confidence = 0.0
        if not math.isfinite(confidence):
            confidence = 0.0
    confidence = round(max(0.0, min(1.0, confidence)), 3)

    # Never expose model-authored treatment text, even at a nominally high
    # confidence. It is uncalibrated and may use local chemical aliases.
    needs_review = bool(d.get("needs_review"))
    if confidence < 0.5:
        needs_review = True
    elif confidence < 0.7:
        needs_review = True
    d["severity"] = severity
    d["confidence"] = confidence
    for key, value in tuple(d.items()):
        normalized = key.casefold()
        if ("action" in normalized or "treatment" in normalized or
                "recommendation" in normalized) and value is not None:
            d[key] = GATE_REPHOTO_TEXT
    d["immediate_action"] = GATE_REPHOTO_TEXT
    d["immediate_action_id"] = GATE_REPHOTO_TEXT
    d["long_term_action"] = GATE_REPHOTO_TEXT
    d["long_term_action_id"] = GATE_REPHOTO_TEXT
    raw_report = d.get("assessment")
    unknown_cause = isinstance(d.get("condition"),str) and bool(re.match(
        r"^(?:(?:belum|tidak)\s+(?:dapat|bisa)\s+(?:dipastikan|dikenali|diidentifikasi)|tidak diketahui|unknown|unclear)\b", d["condition"], re.I))
    uncertain = confidence < 0.5 or unknown_cause or (isinstance(raw_report, dict) and raw_report.get("uncertain") is True)
    if uncertain:
        needs_review = True
    structured = clean_assessment(raw_report, uncertain=uncertain)
    if structured:
        d["assessment"] = structured
        needs_review = needs_review or structured["needs_review"]
    else:
        d.pop("assessment", None)
    d["needs_review"] = needs_review
    if isinstance(d.get("provenance"), dict):
        provenance = clean_provenance(d["provenance"])
        provenance["gate"] = {"uncertain":uncertain,
                              "policyFiltered":bool(structured and structured.get("policy_note")),
                              "needsReview":needs_review}
        d["provenance"] = provenance
    return d


# Kept for the existing test suite and any external importer.
_apply_confidence_gate = apply_confidence_gate


# ---------------------------------------------------------------------------
# Model output hygiene
#
# The gate above decides WHAT the farmer may act on. This section decides which of
# the model's fields are stored at all: anything outside the allowlist is dropped,
# everything kept is coerced to a capped string (a list or dict used to flow into
# SQLite and turn into a 500 when the record was collected), and free text that
# talks about spraying a product or a dose is replaced by the fixed referral text
# whatever the model's confidence was.
# ---------------------------------------------------------------------------

# (field, cap, single line)
_DIAGNOSIS_TEXT_FIELDS = (
    ("crop", 200, True),
    ("condition", 200, True),
    ("symptoms_id", 500, False),
    ("symptoms", 500, False),
    ("geocorrelation", 500, False),
    ("suitability", 500, False),
)
# Written by the gate itself (fixed safe text); kept when a stored row is re-read.
_GATE_ACTION_FIELDS = ("immediate_action", "immediate_action_id",
                       "long_term_action", "long_term_action_id")
TRIAGE_REASON_LIMIT = 300
DEFAULT_TRIAGE_REASON = "Foto tidak dapat dianalisis"


def _coerce_text(value: Any, limit: int, single_line: bool) -> str | None:
    """A capped string, or None when the value carries no usable text."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (list, tuple)):
        parts = [_coerce_text(item, limit, True) for item in value[:10]
                 if isinstance(item, (str, int, float)) and not isinstance(item, bool)]
        value = "; ".join(part for part in parts if part)
    elif isinstance(value, float):
        value = repr(value) if math.isfinite(value) else None
    elif isinstance(value, int):
        value = str(value)
    elif not isinstance(value, str):
        return None
    if value is None:
        return None
    text = textsafe.one_line(value, limit) if single_line else textsafe.block(value, limit)
    return text or None


def sanitize_diagnosis(raw: Any) -> dict[str, Any]:
    """Rebuild a diagnosis from the allowlist of fields. Does not apply the gate.

    Free text that names a pesticide/dosage is replaced by GATE_ISOLATE_TEXT and
    forces `needs_review`, at any confidence: the policy is non-chemical.
    """
    source = raw if isinstance(raw, dict) else {}
    clean: dict[str, Any] = {}
    unsafe = False
    unsafe_identity = False
    for name, limit, single_line in _DIAGNOSIS_TEXT_FIELDS:
        text = _coerce_text(source.get(name), limit, single_line)
        if text is None:
            continue
        if textsafe.contains_chemical_advice(text):
            if name in ("crop","condition"):
                text = "Tanaman Belum Dikenali" if name == "crop" else "Belum Dapat Dipastikan"
                unsafe_identity = True
            else:
                text = GATE_ISOLATE_TEXT
            unsafe = True
        clean[name] = text
    if "crop" in clean:
        clean["crop"] = canonical_crop_name(clean["crop"])
    for name in _GATE_ACTION_FIELDS:
        # Only the fixed text is ever legitimate here; anything else is re-gated.
        if source.get(name) is not None:
            clean[name] = GATE_REPHOTO_TEXT
    structured = clean_assessment(source.get("assessment"), uncertain=unsafe_identity)
    if structured:
        clean["assessment"] = structured
        unsafe = unsafe or structured["needs_review"]
    clean["severity"] = source.get("severity")
    clean["confidence"] = source.get("confidence")
    clean["needs_review"] = bool(source.get("needs_review")) or unsafe
    if source.get("provenance"):
        clean["provenance"] = clean_provenance(source["provenance"])
    return clean


def sanitize_triage(raw: Any) -> dict[str, Any]:
    """Triage as stored and shown: exact-bool usable, capped one-line reason."""
    source = raw if isinstance(raw, dict) else {}
    is_plant = source.get("is_plant")
    reason = _coerce_text(source.get("reason"), TRIAGE_REASON_LIMIT, True) or ""
    if reason and textsafe.contains_chemical_advice(reason):
        reason = DEFAULT_TRIAGE_REASON
    return {"usable": source.get("usable") is True,
            "is_plant": is_plant if isinstance(is_plant, bool) else None,
            "reason": reason}


# ---------------------------------------------------------------------------
# Queue queries
# ---------------------------------------------------------------------------

# Columns a phone (or the admin list) may read. The 100-200 KB image_b64 is
# deliberately absent: it used to be dragged through memory by `SELECT *` on every
# poll. db.row_job() needs exactly these.
JOB_PUBLIC_COLUMNS = ("id, account_id, status, attempts, created_ms, updated_ms, claimed_ms, "
                      "worker, device_id, context_json, triage_json, diagnosis_json, error, acked")


def queue_position(job_id: str) -> int | None:
    """0-based FIFO position, or None when the job is not waiting.

    Counts ahead of the job instead of loading every pending row. The previous
    version read `SELECT *` from `jobs`, which pulled each waiting photo's
    ~100-200 KB base64 payload through memory just to compute one integer — on
    every single phone poll, once per pending job.
    """
    row = db.query_one("SELECT id, status, created_ms FROM jobs WHERE id = ?", (job_id,))
    if row is None or row["status"] not in ("queued", "claimed"):
        return None
    ahead = db.query_one(
        """SELECT COUNT(*) AS n FROM jobs
            WHERE status IN ('queued','claimed')
              AND (created_ms < ? OR (created_ms = ? AND id < ?))""",
        (row["created_ms"], row["created_ms"], row["id"]),
    )
    return int(ahead["n"]) if ahead else 0


def queue_depth() -> int:
    row = db.query_one("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','claimed')")
    return int(row["n"]) if row else 0


def queue_by_status() -> dict[str, int]:
    rows = db.query("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status")
    return {row["status"]: int(row["n"]) for row in rows}


# Admission caps (status queued + claimed, any tier). Idempotent replays never reach
# them: api_app answers a replay before it asks.
MAX_PENDING_PER_ACCOUNT = 30
MAX_PENDING_GLOBAL = 600


def pending_counts(account_id: str, tx: Any = None) -> tuple[int, int]:
    """(this account's pending jobs, everyone's pending jobs)."""
    run = tx.execute if tx is not None else db.conn().execute
    mine = run("SELECT COUNT(*) AS n FROM jobs WHERE account_id = ? AND status IN ('queued','claimed')",
               (account_id,)).fetchone()
    total = run("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','claimed')").fetchone()
    return int(mine["n"]), int(total["n"])


JOBS_RETENTION_DAYS = 30
# A result nobody has collected yet is kept so the phone can still pick it up — but its
# photo is not worth holding indefinitely once the farmer has clearly not come back.
UNACKED_IMAGE_RETENTION_DAYS = 7
# An unacknowledged terminal job older than this has been abandoned for good: the
# farmer's phone either collected it long ago or never will.
UNACKED_JOB_RETENTION_DAYS = 90
_TERMINAL = "('done','rejected','failed','cancelled')"
_purge_lock = threading.Lock()
_last_purge_ms = 0


def purge_old_jobs(retention_days: int = JOBS_RETENTION_DAYS) -> int:
    """Delete acked, finished jobs past retention. Their events cascade with them.

    Nothing ever pruned these tables: `jobs` grew by a base64 thumbnail per photo
    plus a row per job, and `job_events` by about seven rows per job, forever. Only
    ACKED terminal jobs are removed — an unacknowledged one has not been collected
    by the phone yet, and deleting it would destroy a diagnosis the farmer never
    got to see.
    """
    now = db.now_ms()
    # Unacknowledged rows survive so the result stays collectable, but their thumbnail
    # is dropped after a week: it is the single biggest thing in the row and the farmer
    # has had ample opportunity to collect it by then.
    with db.transaction() as tx:
        tx.execute(
            f"""UPDATE jobs SET image_b64 = NULL
                WHERE image_b64 IS NOT NULL AND acked = 0
                  AND status IN {_TERMINAL}
                  AND COALESCE(updated_ms, created_ms) < ?""",
            (now - UNACKED_IMAGE_RETENTION_DAYS * 86_400_000,),
        )

    cutoff = now - retention_days * 86_400_000
    with db.transaction() as tx:
        cursor = tx.execute(
            f"""DELETE FROM jobs
                WHERE status IN {_TERMINAL}
                  AND acked = 1
                  AND COALESCE(updated_ms, created_ms) < ?""",
            (cutoff,),
        )
    return cursor.rowcount or 0


def purge_abandoned_jobs(retention_days: int = UNACKED_JOB_RETENTION_DAYS, chunk: int = 500) -> int:
    """Delete terminal jobs that were never acknowledged and are older than retention.

    Without this they accumulated forever (purge_old_jobs deliberately spares them).
    Deleted in chunks so the single SQLite writer is never held for long.
    """
    cutoff = db.now_ms() - retention_days * 86_400_000
    removed = 0
    for _ in range(200):
        with db.transaction() as tx:
            cursor = tx.execute(
                f"""DELETE FROM jobs WHERE id IN (
                        SELECT id FROM jobs
                         WHERE status IN {_TERMINAL} AND acked = 0
                           AND COALESCE(updated_ms, created_ms) < ?
                         LIMIT ?)""",
                (cutoff, chunk),
            )
        count = cursor.rowcount or 0
        removed += count
        if count < chunk:
            break
    return removed


def run_maintenance() -> dict[str, Any]:
    """Hourly housekeeping, called from the platform's maintenance thread.

    Replaces the old purge that ran inline on the analyze request. Never raises: a
    failing step is reported in the result and the next step still runs.
    """
    result: dict[str, Any] = {}
    for name, step in (("purged", purge_old_jobs), ("abandoned", purge_abandoned_jobs)):
        try:
            result[name] = step()
        except Exception as error:  # noqa: BLE001 - housekeeping must never take the service down
            result[name] = 0
            result.setdefault("errors", []).append(f"{name}: {type(error).__name__}: {error}")
    return result


def purge_old_jobs_occasionally(min_interval_ms: int = 3_600_000) -> int:
    """Run the retention sweep at most once per interval.

    No longer called from request handlers (it ran blocking SQLite work on the event
    loop); kept for external importers. Use run_maintenance() from a background thread.
    """
    global _last_purge_ms
    now = db.now_ms()
    with _purge_lock:
        if now - _last_purge_ms < min_interval_ms:
            return 0
        _last_purge_ms = now
    return purge_old_jobs()


def requeue_stale(stale_seconds: int) -> int:
    """Demote stale `claimed` jobs back to `queued`. Returns how many were requeued."""
    with db.transaction() as tx:
        cursor = tx.execute(
            """UPDATE jobs
                  SET status = 'queued', worker = NULL, claimed_ms = NULL, claim_token = NULL,
                      lease_expires_ms = NULL, updated_ms = ?
                WHERE status = 'claimed'
                  AND COALESCE(lease_expires_ms, COALESCE(claimed_ms, updated_ms, created_ms) + ?) <= ?""",
            (db.now_ms(), stale_seconds * 1000, db.now_ms()),
        )
    return cursor.rowcount or 0


# Claim lanes. "Cepat" (fast) has its own model pair and its own consumer, so it is
# taken out of the normal queue: a `fast` lane only claims fast jobs, `normal` only the
# rest, and `all` (the default) prefers fast so a quick analysis never waits behind the
# jobs already queued in normal mode on a single consumer.
CLAIM_LANES = ("all", "fast", "normal")
_TIER_SQL = ("COALESCE(CASE WHEN json_valid(context_json) "
             "THEN json_extract(context_json, '$.analysisTier') END, 'normal')")


def claim_next(worker: str, stale_seconds: int,
               lane: str = "all") -> tuple[dict[str, Any] | None, int]:
    """Requeue stale claims, then take the oldest queued job that is due for this lane.

    A released job carries a `not_before_ms`; until then it is skipped so one photo the
    provider keeps failing on can no longer sit at the head of the queue forever.
    """
    requeued = requeue_stale(stale_seconds)
    lane = lane if lane in CLAIM_LANES else "all"
    where = "status = 'queued' AND not_before_ms <= ?"
    if lane == "fast":
        where += f" AND {_TIER_SQL} = 'fast'"
    elif lane == "normal":
        where += f" AND {_TIER_SQL} <> 'fast'"
    order = f"CASE WHEN {_TIER_SQL} = 'fast' THEN 0 ELSE 1 END, " if lane == "all" else ""
    now = db.now_ms()
    claim_token = secrets.token_urlsafe(32)
    with db.transaction() as tx:
        row = tx.execute(
            f"SELECT id FROM jobs WHERE {where} ORDER BY {order}created_ms ASC, id ASC LIMIT 1",
            (now,),
        ).fetchone()
        if row is None:
            return None, requeued
        job_id = row["id"]
        cursor = tx.execute(
            """UPDATE jobs
                  SET status = 'claimed', attempts = attempts + 1, worker = ?,
                      claimed_ms = ?, updated_ms = ?,
                      first_claimed_ms = COALESCE(first_claimed_ms, ?),
                      claim_token = ?, claim_generation = claim_generation + 1, lease_expires_ms = ?
                WHERE id = ? AND status = 'queued'""",
            (worker, now, now, now, claim_token, now + stale_seconds * 1000, job_id),
        )
        # The status guard matters the moment a second claimer exists (a second
        # worker, or n8n augmenting it): without it, a job still running under a
        # long model call is claimable again once the lease looks stale.
        if not cursor.rowcount:
            return None, requeued
        claimed = tx.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    return (dict(claimed) if claimed else None), requeued


def owns_claim(row: Any, claim_token: str | None, now: int | None = None) -> bool:
    if row is None or not isinstance(claim_token, str) or not 20 <= len(claim_token) <= 128:
        return False
    values = dict(row)
    stored = values.get("claim_token")
    return (values.get("status") == "claimed" and isinstance(stored, str)
            and secrets.compare_digest(stored, claim_token)
            and int(values.get("lease_expires_ms") or 0) > (db.now_ms() if now is None else now))


def renew_claim(job_id: str, claim_token: str | None, lease_seconds: int) -> bool:
    now = db.now_ms()
    with db.transaction() as tx:
        row = tx.execute("SELECT status, claim_token, lease_expires_ms FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not owns_claim(row, claim_token, now):
            return False
        tx.execute("UPDATE jobs SET lease_expires_ms=? WHERE id=? AND claim_token=?",
                   (now + max(30, min(7200, lease_seconds)) * 1000, job_id, claim_token))
    return True


# Wait before a released job may be claimed again: 1, 2, 4, 8, 16, then 30 minutes.
RELEASE_BACKOFF_MINUTES = (1, 2, 4, 8, 16, 30)
MAX_RELEASES = 10
GIVE_UP_AFTER_MS = 3 * 3_600_000
# Router authentication / configuration problems are the operator's to fix: the job
# waits a fixed five minutes and the release does not count against it.
OPERATOR_RELEASE_DELAY_MS = 5 * 60_000
PROVIDER_GIVE_UP_REASON = ("Server analisis sedang bermasalah. Foto Anda aman — kirim ulang "
                           "nanti dari Riwayat.")
PROVIDER_GIVE_UP_CODE = "provider_unavailable"
RELEASE_KINDS = ("provider", "auth", "config")


def release_backoff_ms(release_number: int) -> int:
    minutes = RELEASE_BACKOFF_MINUTES[min(max(release_number, 1), len(RELEASE_BACKOFF_MINUTES)) - 1]
    return minutes * 60_000


def release_job(job_id: str, reason: str = "", kind: str = "provider", *,
                claim_token: str | None = None) -> dict[str, Any]:
    """Hand a claimed job back to the queue without spending one of its attempts.

    A timeout, a 429 or a 5xx is a provider problem, not evidence that the photo was
    bad, so the attempt is refunded. What is NOT refunded is the queue position: the
    job waits out a persistent backoff behind the rest of the queue, and after
    MAX_RELEASES provider releases (or GIVE_UP_AFTER_MS since its first claim) it is
    given up with a message that blames the server, not the farmer's photo.

    Only a `claimed` job is released. Releasing one that is already queued is a no-op.
    """
    now = db.now_ms()
    kind = kind if kind in RELEASE_KINDS else "provider"
    detail = str(reason or "")[:200]
    outcome: dict[str, Any] = {"released": False, "status": "missing", "givenUp": False,
                               "notBeforeMs": None, "releaseCount": 0}
    with db.transaction() as tx:
        row = tx.execute(
            "SELECT status, attempts, release_count, first_claimed_ms, claimed_ms, claim_token, lease_expires_ms "
            "FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if row is None:
            return outcome
        outcome["status"] = row["status"]
        outcome["releaseCount"] = int(row["release_count"] or 0)
        if not owns_claim(row, claim_token, now):
            outcome["status"] = "stale_claim"
            return outcome
        releases = outcome["releaseCount"] + (1 if kind == "provider" else 0)
        first = int(row["first_claimed_ms"] or row["claimed_ms"] or now)
        attempts = max(0, int(row["attempts"] or 0) - 1)
        if releases >= MAX_RELEASES or now - first >= GIVE_UP_AFTER_MS:
            triage = {"usable": False, "is_plant": None, "reason": PROVIDER_GIVE_UP_REASON,
                      "code": PROVIDER_GIVE_UP_CODE}
            tx.execute(
                """UPDATE jobs
                      SET status = 'rejected', worker = NULL, claimed_ms = NULL,
                          claim_token = NULL, lease_expires_ms = NULL, attempts = ?,
                          release_count = ?, error = ?, triage_json = ?, acked = 0, updated_ms = ?
                    WHERE id = ? AND status = 'claimed'""",
                (attempts, releases, PROVIDER_GIVE_UP_REASON, db.to_json(triage), now, job_id),
            )
            outcome.update(status="rejected", givenUp=True, releaseCount=releases)
        else:
            delay = release_backoff_ms(releases) if kind == "provider" else OPERATOR_RELEASE_DELAY_MS
            tx.execute(
                """UPDATE jobs
                      SET status = 'queued', worker = NULL, claimed_ms = NULL,
                          claim_token = NULL, lease_expires_ms = NULL, attempts = ?,
                          release_count = ?, not_before_ms = ?, updated_ms = ?
                    WHERE id = ? AND status = 'claimed'""",
                (attempts, releases, now + delay, now, job_id),
            )
            outcome.update(released=True, status="queued", notBeforeMs=now + delay,
                           releaseCount=releases)
    # Tracing opens its own transaction, so it must run after the one above.
    if outcome["givenUp"]:
        add_event(job_id, "worker:giveup", detail=f"{kind}: {detail}"[:500])
    else:
        wait_min = round((outcome["notBeforeMs"] - now) / 60_000)
        add_event(job_id, "worker:release",
                  detail=f"{kind}: {detail} | coba lagi ±{wait_min} menit"[:500])
    return outcome


def reset_release_state(tx: Any, job_id: str) -> None:
    """For an operator requeue: clear the backoff so the job is claimable at once and
    gets a fresh release budget. Call inside the caller's transaction."""
    tx.execute("UPDATE jobs SET not_before_ms = 0, release_count = 0, first_claimed_ms = NULL "
               "WHERE id = ?", (job_id,))


def _apply_reanalysis_result(tx: Any, job_row: Any, diagnosis: dict[str, Any]) -> None:
    """Update the original owned record in the completion transaction.

    Only the AI-owned diagnosis fields change. The record id, tree/farm links,
    coordinates, original photo reference and capture/upload timestamps stay put.
    The prior visible hypothesis is copied to ``previousCondition`` and remains
    explicitly unconfirmed by the client renderer.
    """
    context = db.from_json(job_row["context_json"], {})
    record_id = context.get("reanalysisRecordId") if isinstance(context, dict) else None
    if not isinstance(record_id, str) or not record_id:
        return
    record = tx.execute(
        "SELECT * FROM records WHERE id = ? AND account_id = ? AND source = 'ai'",
        (record_id, job_row["account_id"]),
    ).fetchone()
    if record is None:
        return
    extra = db.from_json(record["extra_json"], {})
    extra = dict(extra) if isinstance(extra, dict) else {}
    previous = clean_previous_condition(record["condition"])
    condition = diagnosis.get("condition") if isinstance(diagnosis.get("condition"), str) else record["condition"]
    if previous and previous != condition:
        extra["previousCondition"] = previous
    extra["assessment"] = diagnosis.get("assessment")
    extra["analysisProvenance"] = clean_provenance(diagnosis.get("provenance"))
    # A species the farmer corrected by hand stays; the re-analysis was asked with it as the hint.
    farmer_crop = isinstance(extra.get("corrected"), list) and "crop" in extra["corrected"]
    tx.execute(
        """UPDATE records
              SET crop = ?, condition = ?, severity = ?, symptoms = ?,
                  geocorrelation = ?, immediate_action = ?, suitability = ?,
                  needs_review = ?, confidence = ?, extra_json = ?, updated_ms = ?
            WHERE id = ? AND account_id = ? AND source = 'ai'""",
        (record["crop"] if farmer_crop else (diagnosis.get("crop") or record["crop"]), condition, diagnosis.get("severity") or record["severity"],
         diagnosis.get("symptoms_id", diagnosis.get("symptoms", record["symptoms"])),
         diagnosis.get("geocorrelation", record["geocorrelation"]),
         diagnosis.get("immediate_action", diagnosis.get("immediate_action_id", record["immediate_action"])),
         diagnosis.get("suitability", record["suitability"]), 1 if diagnosis.get("needs_review") else 0,
         diagnosis.get("confidence"), db.to_json(extra), db.now_ms(), record_id, job_row["account_id"]),
    )


def complete_job(job_id: str, triage: dict[str, Any], diagnosis: dict[str, Any], *,
                 claim_token: str | None = None) -> dict[str, Any] | None:
    """Terminal transition. The gate is applied here and nowhere else."""
    validate_triage(triage)
    if triage["usable"]:
        validate_diagnosis(diagnosis)
    clean_triage = sanitize_triage(triage)
    gated = apply_confidence_gate(sanitize_diagnosis(diagnosis))
    usable = clean_triage["usable"]
    with db.transaction() as tx:
        job_row = tx.execute(
            "SELECT status, account_id, context_json, claim_token, lease_expires_ms FROM jobs WHERE id = ?", (job_id,)
        ).fetchone()
        row = job_row
        if row is None:
            return None
        if not owns_claim(row, claim_token):
            return None
        tx.execute(
            """UPDATE jobs
                  SET status = ?, triage_json = ?, diagnosis_json = ?, error = ?,
                      updated_ms = ?, claim_token = NULL, lease_expires_ms = NULL
                WHERE id = ?""",
            ("done" if usable else "rejected",
             db.to_json(clean_triage), db.to_json(gated),
             None if usable else (clean_triage["reason"] or DEFAULT_TRIAGE_REASON),
             db.now_ms(), job_id),
        )
        if usable and job_row is not None:
            _apply_reanalysis_result(tx, job_row, gated)
        updated = tx.execute(f"SELECT {JOB_PUBLIC_COLUMNS} FROM jobs WHERE id = ?", (job_id,)).fetchone()
    return dict(updated) if updated else None


def jobs_created_since(account_id: str, since_ms: int) -> int:
    row = db.query_one(
        "SELECT COUNT(*) AS n FROM jobs WHERE account_id = ? AND created_ms >= ?",
        (account_id, since_ms),
    )
    return int(row["n"]) if row else 0


# ---------------------------------------------------------------------------
# Per-job trace
#
# The worker records every step here — including each HTTP call to the router
# with its status and latency — so an operator can prove what happened instead
# of guessing whether the provider was ever contacted.
# ---------------------------------------------------------------------------


def add_event(job_id: str, stage: str, model: str | None = None,
              http_status: int | None = None, latency_ms: int | None = None,
              detail: str | None = None, *, claim_token: str | None = None) -> bool:
    try:
        with db.transaction() as tx:
            if claim_token is not None:
                row = tx.execute("SELECT status, claim_token, lease_expires_ms FROM jobs WHERE id=?", (job_id,)).fetchone()
                if not owns_claim(row, claim_token):
                    return False
            tx.execute(
                "INSERT INTO job_events (job_id, ts_ms, stage, model, http_status, latency_ms, detail) "
                "VALUES (?,?,?,?,?,?,?)",
                (job_id, db.now_ms(), stage, model,
                 int(http_status) if http_status is not None else None,
                 int(latency_ms) if latency_ms is not None else None,
                 (detail or "")[:500] or None),
            )
        return True
    except Exception:  # noqa: BLE001 - tracing must never break a job
        return False


def job_events(job_id: str, limit: int = 50) -> list[dict[str, Any]]:
    rows = db.query(
        "SELECT ts_ms, stage, model, http_status, latency_ms, detail FROM job_events "
        "WHERE job_id = ? ORDER BY ts_ms ASC, id ASC LIMIT ?",
        (job_id, limit),
    )
    return [
        {"tsMs": row["ts_ms"], "stage": row["stage"], "model": row["model"],
         "httpStatus": row["http_status"], "latencyMs": row["latency_ms"],
         "detail": row["detail"]}
        for row in rows
    ]


def latest_event(job_id: str) -> dict[str, Any] | None:
    row = db.query_one(
        "SELECT ts_ms, stage, model, http_status, latency_ms, detail FROM job_events "
        "WHERE job_id = ? ORDER BY ts_ms DESC, id DESC LIMIT 1",
        (job_id,),
    )
    if not row:
        return None
    return {"tsMs": row["ts_ms"], "stage": row["stage"], "model": row["model"],
            "httpStatus": row["http_status"], "latencyMs": row["latency_ms"],
            "detail": row["detail"]}


# What a farmer may be told about a job's progress. The raw trace (router host and
# port, provider JSON) stays on the admin routes; these labels are fixed text.
STAGE_LABELS = {
    "triage:start": "Model triase memeriksa foto…",
    "triage:http": "Model triase sedang bekerja…",
    "triage:done": "Triase selesai, menyiapkan diagnosis…",
    "diagnose:start": "Model diagnosis menganalisis gejala…",
    "diagnose:http": "Model diagnosis sedang bekerja…",
    "diagnose:done": "Menyusun hasil…",
    "result:posted": "Menyiapkan hasil…",
    "worker:release": "Server sedang sibuk. Analisis dicoba lagi otomatis…",
}


def stage_label(stage: str | None) -> str | None:
    return STAGE_LABELS.get(stage or "")


# ---------------------------------------------------------------------------
# Worker heartbeat (shown in the admin overview)
# ---------------------------------------------------------------------------

WORKER_STATUS_KEY = "worker_status"
WORKER_STALE_MS = 3 * 60_000
_WORKER_ERROR_LIMIT = 300


def _stored_worker_status() -> dict[str, Any]:
    row = db.query_one("SELECT value FROM settings WHERE key = ?", (WORKER_STATUS_KEY,))
    stored = db.from_json(row["value"], {}) if row else {}
    return stored if isinstance(stored, dict) else {}


def _sane_ms(value: Any, now: int, max_age_ms: int | None = None) -> int | None:
    """An epoch-ms timestamp that is a real number, not in the future, optionally not too old."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    value = int(value)
    if value <= 0 or value > now + 300_000:
        return None
    return None if max_age_ms is not None and now - value > max_age_ms else value


def record_worker_status(payload: dict[str, Any] | None) -> dict[str, Any]:
    report = payload if isinstance(payload,dict) else {}
    now = db.now_ms()
    lane = report.get("lane") if report.get("lane") in ("normal","fast","all") else "all"
    worker = textsafe.one_line(report.get("worker") or "legacy",80)
    key = lane + ":" + worker
    with db.transaction() as tx:
        row = tx.execute("SELECT value FROM settings WHERE key=?",(WORKER_STATUS_KEY,)).fetchone()
        previous = db.from_json(row["value"],{}) if row else {}
        workers = previous.get("workers",{}) if isinstance(previous,dict) else {}
        workers = dict(workers) if isinstance(workers,dict) else {}
        workers = {key:value for key,value in workers.items() if isinstance(key,str) and isinstance(value,dict)}
        old = workers.get(key) or {}
        message = textsafe.one_line(report.get("lastError"),_WORKER_ERROR_LIMIT) if isinstance(report.get("lastError"),str) else ""
        workers[key] = {"worker":worker,"lane":lane,"lastSeenMs":now,
            "lastError":message or old.get("lastError"),
            "lastErrorMs":(_sane_ms(report.get("lastErrorMs"),now,86_400_000) or now) if message else old.get("lastErrorMs"),
            "authFailing":report.get("authFailing") is True,"hasError":report.get("hasError") is True}
        workers = dict(sorted(workers.items(),key=lambda item:_sane_ms(item[1].get("lastSeenMs"),now) or 0,reverse=True)[:16])
        tx.execute("INSERT OR REPLACE INTO settings(key,value,is_secret,updated_ms) VALUES(?,?,0,?)",
                   (WORKER_STATUS_KEY,db.to_json({"workers":workers}),now))
    return worker_status()


def worker_status() -> dict[str, Any]:
    stored = _stored_worker_status()
    now = db.now_ms()
    raw = stored.get("workers") if isinstance(stored,dict) else None
    rows = list(raw.values()) if isinstance(raw,dict) else ([stored] if stored else [])
    views = []
    for row in rows:
        if not isinstance(row,dict):
            continue
        seen = _sane_ms(row.get("lastSeenMs"),now)
        views.append({"worker":row.get("worker","legacy"),"lane":row.get("lane","all"),
            "lastSeenMs":seen,"lastError":row.get("lastError"),"lastErrorMs":row.get("lastErrorMs"),
            "authFailing":row.get("authFailing") is True,"hasError":row.get("hasError") is True,
            "stale":seen is None or now-seen>WORKER_STALE_MS})
    # One configured consumer per lane. A retired host must not keep its replacement
    # unhealthy forever; keep earlier identities only in the stored history.
    current = {}
    for view in views:
        lane = view["lane"]
        if lane not in current or (view["lastSeenMs"] or 0) > (current[lane]["lastSeenMs"] or 0):
            current[lane] = view
    active = list(current.values())
    if any(v["lane"] in ("normal","fast") for v in active):
        active = [v for v in active if v["lane"] in ("normal","fast")]
    lanes = {v["lane"] for v in active}
    missing = [] if "all" in lanes else sorted({"normal","fast"}-lanes)
    latest_error = max((v for v in active if v.get("lastError")),key=lambda v:v.get("lastErrorMs") or 0,default={})
    return {"lastSeenMs":min((v["lastSeenMs"] for v in active if v["lastSeenMs"] is not None),default=None),
        "lastError":latest_error.get("lastError"),"lastErrorMs":latest_error.get("lastErrorMs"),
        "authFailing":any(v["authFailing"] for v in active),
        "hasError":any(v["hasError"] for v in active),
        "stale":not active or bool(missing) or any(v["stale"] for v in active),"workers":active,"missingLanes":missing}


# ---------------------------------------------------------------------------
# Fast-path quota
#
# The farmer no longer picks a mode per photo. Every upload is admitted on the fast
# pair while the account's daily allowance lasts and on the paced normal pair once it
# is used up, so `fast_quota_snapshot` is what the admission decision reads.
# ---------------------------------------------------------------------------


def start_of_today_ms() -> int:
    """UTC epoch milliseconds for midnight in the quota's explicit timezone."""
    return _day_window()[0]


def _day_window(now_ms: int | None = None) -> tuple[int, int, str]:
    from datetime import datetime, time, timedelta
    from zoneinfo import ZoneInfo

    zone = ZoneInfo("Asia/Jakarta")
    now = datetime.fromtimestamp((now_ms if now_ms is not None else db.now_ms()) / 1000, zone)
    start = datetime.combine(now.date(), time.min, zone)
    end = datetime.combine(now.date() + timedelta(days=1), time.min, zone)
    return int(start.timestamp() * 1000), int(end.timestamp() * 1000), end.isoformat(timespec="seconds")


def fast_quota_snapshot(account: dict[str, Any], now_ms: int | None = None,
                        tx: Any = None) -> dict[str, Any]:
    """Return fast usage/caps; invalid or unknown JSON is conservatively uncounted."""
    role = account.get("role", "user")
    cap = {"user": 20, "priority": 50, "admin": None}.get(role, 20)
    start, end, reset_at = _day_window(now_ms)
    query = tx.execute if tx is not None else db.conn().execute
    row = query(
        """SELECT COUNT(*) AS n FROM jobs
             WHERE account_id = ? AND created_ms >= ? AND created_ms < ?
               AND CASE WHEN json_valid(context_json)
                        THEN json_extract(context_json, '$.analysisTier')
                        ELSE NULL END = 'fast'""",
        (account["id"], start, end),
    ).fetchone()
    used = int(row["n"])
    return {"fastQuota": cap, "fastUsed": used,
            "fastRemaining": None if cap is None else max(0, cap - used),
            "resetAt": reset_at, "timezone": "Asia/Jakarta"}
