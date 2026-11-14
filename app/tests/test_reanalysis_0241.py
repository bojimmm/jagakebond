"""Synthetic 0.2.4.7 re-analysis: clean source, ownership, idempotency, in-place result."""
from __future__ import annotations

import asyncio
import base64
import tempfile
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend import api_app, db, queue


checks = 0
def check(condition: bool, label: str) -> None:
    global checks
    if not condition:
        raise AssertionError(label)
    checks += 1


with tempfile.TemporaryDirectory(prefix="jk-reanalysis-0241-", ignore_cleanup_errors=True) as folder:
    root = Path(folder)
    db.close_all()
    db.DB_PATH = root / "fixture.sqlite3"
    api_app.UPLOAD_DIR = root / "uploads"
    api_app.UPLOAD_DIR.mkdir()
    db.migrate()
    now = db.now_ms()
    owner = {"id": "reanalysis-owner", "role": "user", "email": "owner@fixture.invalid"}
    other = {"id": "reanalysis-other", "role": "user", "email": "other@fixture.invalid"}
    with db.transaction() as tx:
        for account in (owner, other):
            tx.execute("INSERT INTO accounts(id,email,password_hash,role,created_ms,updated_ms) VALUES(?,?,?,?,?,?)",
                       (account["id"], account["email"], "synthetic", "user", now, now))
        tx.execute("INSERT INTO farms(id,account_id,name,ring_json,created_ms,updated_ms) VALUES(?,?,?,?,?,?)",
                   ("farm-clean", owner["id"], "Petak sintetis", "[]", now, now))
        tx.execute("INSERT INTO photos(id,account_id,file_name,bytes,created_ms) VALUES(?,?,?,?,?)",
                   ("photo-clean", owner["id"], "clean-original.jpg", len(b"CLEAN-ORIGINAL-NO-STAMP"), now))
        tx.execute("INSERT INTO photos(id,account_id,file_name,bytes,created_ms) VALUES(?,?,?,?,?)",
                   ("photo-missing", owner["id"], "missing-original.jpg", 24, now))
    clean_bytes = b"CLEAN-ORIGINAL-NO-STAMP"
    (api_app.UPLOAD_DIR / "clean-original.jpg").write_bytes(clean_bytes)
    with db.transaction() as tx:
        tx.execute(
            """INSERT INTO records(id,account_id,crop_id,crop_name,timestamp_ms,crop,condition,severity,
                                   lat,lng,elevation,location_name,accuracy,date,symptoms,geocorrelation,
                                   immediate_action,suitability,needs_review,confidence,farm_id,device_id,
                                   image_url,source,crop_hint,extra_json,created_ms,updated_ms)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            ("record-clean", owner["id"], "crop-clean", "Cabai", 1_700_000_000_000,
             "Cabai", "Dugaan antraknosa", "Moderate", -6.5, 106.7, 120, "Bogor", 4.0,
             "2023-11-14", "old-symptom", "old-geo", "old-action", "old-suitability", 0, 0.72,
             "farm-clean", "synthetic-device", "/api/photos/photo-clean", "ai", "Cabai",
             db.to_json({"captureTimeKnown": True, "captureTimeSource": "exif", "locationSource": "gps",
                         "uploadedMs": 1_700_000_000_000, "assessment": {"version": 1, "findings": ["old finding"]}}),
             1_700_000_000_000, 1),
        )
        tx.execute(
            """INSERT INTO records(id,account_id,crop,condition,image_url,source,extra_json,created_ms,updated_ms)
               VALUES(?,?,?,?,?,?,?,?,?)""",
            ("record-manual", owner["id"], "Cabai", "Catatan manual", "/api/photos/photo-clean", "manual", "{}", now, now),
        )
        tx.execute(
            """INSERT INTO records(id,account_id,crop,condition,image_url,source,extra_json,created_ms,updated_ms)
               VALUES(?,?,?,?,?,?,?,?,?)""",
            ("record-missing-photo", owner["id"], "Cabai", "Dugaan bercak", "/api/photos/photo-missing", "ai", "{}", now, now),
        )

    captured: list[bytes] = []
    def fake_thumb(data: bytes, _px: int, _quality: int) -> str:
        captured.append(data)
        return "synthetic-clean-thumbnail"

    with patch.object(api_app, "_thumbnail_b64_from_bytes", fake_thumb):
        receipt = asyncio.run(api_app.reanalyze_record("record-clean", account=owner))
    check(receipt["source"] == "original-photo-no-stamp", "response identifies clean source")
    check(receipt["jobId"] == receipt["job_id"], "receipt aliases one job")
    check(captured == [clean_bytes], "server sent exact clean original, never stamped client image")
    job_id = receipt["jobId"]
    job = db.query_one("SELECT * FROM jobs WHERE id=?", (job_id,))
    context = db.from_json(job["context_json"], {})
    check(job["image_b64"] == "synthetic-clean-thumbnail", "job holds clean thumbnail")
    check(context["reanalysisRecordId"] == "record-clean", "record id is server-owned")
    check(context["reanalysisSource"] == "original-photo-no-stamp", "source policy is persisted")
    check(context["reanalysisPhotoSha256"] == __import__("hashlib").sha256(clean_bytes).hexdigest(), "source hash proves clean bytes")
    check(context["farmId"] == "farm-clean" and context["cropId"] == "crop-clean", "tree and farm context retained")
    check(context["photoTimestampMs"] == 1_700_000_000_000, "capture timestamp retained")
    check(db.query_one("SELECT COUNT(*) n FROM jobs WHERE account_id=?", (owner["id"],))["n"] == 1, "one job queued")
    # The lane is chosen by the server exactly as for a fresh photo: the first re-analysis
    # of the day uses the fast allowance, and the receipt reports the same lane the job got.
    check(receipt["tier"] == "fast", "first re-analysis uses the daily fast allowance")
    check(context["analysisTier"] == receipt["tier"], "receipt and job agree on the re-analysis lane")

    with patch.object(api_app, "_thumbnail_b64_from_bytes", fake_thumb):
        replay = asyncio.run(api_app.reanalyze_record("record-clean", account=owner))
    check(replay["jobId"] == job_id, "repeated tap reuses active job")
    check(replay["tier"] == receipt["tier"], "repeated tap reports the same lane")
    check(db.query_one("SELECT COUNT(*) n FROM jobs WHERE account_id=?", (owner["id"],))["n"] == 1, "repeated tap creates no duplicate")

    for record_id, account, status in (("record-clean", other, 404), ("record-manual", owner, 409), ("record-missing-photo", owner, 404)):
        try:
            with patch.object(api_app, "_thumbnail_b64_from_bytes", fake_thumb):
                asyncio.run(api_app.reanalyze_record(record_id, account=account))
        except HTTPException as error:
            check(error.status_code == status, f"{record_id} refusal {status}")
        else:
            raise AssertionError(f"{record_id} unexpectedly accepted")

    before = dict(db.query_one("SELECT * FROM records WHERE id='record-clean'"))
    diagnosis = {
        "crop": "Cabai", "condition": "Bercak daun", "severity": "Severe", "confidence": 0.88,
        "symptoms_id": "new-symptom", "geocorrelation": "new-geo", "immediate_action_id": "new-action",
        "suitability": "new-suitability", "needs_review": False,
        "assessment": {"version": 1, "active_conditions":["Bercak daun"], "findings": ["Bercak melingkar pada daun."],
                       "possible_causes": ["Bercak daun"], "actions": ["Periksa permukaan daun yang berubah."],
                       "prevention": ["Catat kondisi lahan."], "nutrition": ["Bandingkan pola gejala dengan uji tanah."],
                       "monitoring": ["Foto daun yang sama tiga hari lagi."], "escalation": ["Hubungi penyuluh bila meluas."]},
    }
    claim,_=queue.claim_next("synthetic-reanalysis",300)
    check(claim["id"]==job_id,"reanalysis claimed by worker")
    completed = queue.complete_job(job_id, {"usable": True, "is_plant": True, "reason": "Foto jelas."}, diagnosis,claim_token=claim["claim_token"])
    check(completed is not None and completed["status"] == "done", "clean result completes job")
    after = dict(db.query_one("SELECT * FROM records WHERE id='record-clean'"))
    for field in ("id", "account_id", "crop_id", "crop_name", "timestamp_ms", "lat", "lng", "elevation",
                  "location_name", "accuracy", "date", "farm_id", "device_id", "image_url", "source",
                  "crop_hint", "created_ms"):
        check(after[field] == before[field], f"{field} preserved")
    check(after["condition"] == "Bercak daun" and after["severity"] == "Severe", "same record diagnosis replaced")
    check(after["confidence"] == 0.88 and after["needs_review"] == 0, "server confidence and review state applied")
    extra = db.from_json(after["extra_json"], {})
    check(extra["previousCondition"] == "Dugaan antraknosa", "previous hypothesis retained")
    check(extra["assessment"]["possible_causes"] == ["Bercak daun"], "structured report replaced")
    mapped = db.row_record(after)
    check(mapped["previousCondition"] == "Dugaan antraknosa" and mapped["imageUrl"] == "/api/photos/photo-clean",
          "public record preserves photo and previous comparison")

    with patch.object(api_app, "_thumbnail_b64_from_bytes", fake_thumb):
        second = asyncio.run(api_app.reanalyze_record("record-clean", account=owner))
    check(second["jobId"] != job_id, "a later deliberate reanalysis gets a new job")
    stable = dict(db.query_one("SELECT * FROM records WHERE id='record-clean'"))
    second_claim,_=queue.claim_next("synthetic-reanalysis",300)
    check(second_claim["id"]==second["jobId"],"retry claimed by worker")
    failed = queue.complete_job(second["jobId"], {"usable": False, "is_plant": True, "reason": "Foto terlalu buram."},
                                {"crop": "Bukan tanaman", "condition": "Salah", "severity": "Healthy",
                                 "confidence": 0.99, "assessment": {"version": 1, "findings": ["wrong"]}},claim_token=second_claim["claim_token"])
    check(failed is not None and failed["status"] == "rejected", "unusable reanalysis rejects")
    unchanged = dict(db.query_one("SELECT * FROM records WHERE id='record-clean'"))
    check(unchanged["condition"] == stable["condition"] and unchanged["extra_json"] == stable["extra_json"],
          "failed reanalysis preserves prior analysis")

    with db.transaction() as tx:
        for index in range(queue.MAX_PENDING_PER_ACCOUNT):
            tx.execute("INSERT INTO jobs(id,account_id,status,created_ms,updated_ms,context_json) VALUES(?,?,?,?,?,?)",
                       (f"cap-{index}", owner["id"], "queued", now + index + 1, now, "{}"))
    try:
        with patch.object(api_app, "_thumbnail_b64_from_bytes", fake_thumb):
            asyncio.run(api_app.reanalyze_record("record-clean", account=owner))
    except HTTPException as error:
        check(error.status_code == 429, "queue admission cap still applies")
    else:
        raise AssertionError("queue admission cap bypassed")

    audit = db.query_one("SELECT action,target,detail FROM audit_log WHERE action='record.reanalyze.queued' ORDER BY id LIMIT 1")
    check(audit and audit["target"] == "record-clean" and "original-photo-no-stamp" in audit["detail"], "request audited")
    db.close_all()

print(f"reanalysis-0241: {checks} clean-source/ownership/idempotency/preservation assertions passed")

