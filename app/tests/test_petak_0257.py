"""Synthetic 0.2.4.18: the farmer corrects species, date, status and pest/disease observations.
The AI's own species and the original time are kept, the plant's other photos follow the species, the
change is audited, a re-analysis keeps the farmer's species and a later photo of the plant inherits it."""
from __future__ import annotations

import tempfile
import time
from pathlib import Path

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


def refused(call, status: int) -> bool:
    try:
        call()
    except HTTPException as error:
        return error.status_code == status
    return False


with tempfile.TemporaryDirectory(prefix="jk-petak-0257-", ignore_cleanup_errors=True) as folder:
    root = Path(folder)
    db.close_all()
    db.DB_PATH = root / "fixture.sqlite3"
    db.migrate()
    now = db.now_ms()
    farmer = {"id": "petak-farmer", "role": "user", "email": "petani@fixture.invalid"}
    other = {"id": "petak-other", "role": "user", "email": "lain@fixture.invalid"}
    day = 86_400_000
    with db.transaction() as tx:
        for account in (farmer, other):
            tx.execute("INSERT INTO accounts(id,email,password_hash,role,created_ms,updated_ms) VALUES(?,?,?,?,?,?)",
                       (account["id"], account["email"], "synthetic", account["role"], now, now))
        for rid, crop_id, stamp in (("rec-a", "plant-1", now - 3 * day), ("rec-b", "plant-1", now - day), ("rec-c", "plant-2", now - day)):
            tx.execute("""INSERT INTO records(id,account_id,crop_id,crop_name,timestamp_ms,crop,condition,severity,date,source,
                                              confidence,extra_json,created_ms,updated_ms)
                          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                       (rid, farmer["id"], crop_id, None, stamp, "Kopi (Coffee)", "Karat daun", "Moderate",
                        time.strftime("%Y-%m-%d", time.localtime(stamp / 1000)), "ai", 0.8,
                        db.to_json({"assessment": {"version": 1, "findings": ["Karat."]}, "locationSource": "gps"}), now, now))

    update = api_app.update_record
    check(refused(lambda: update("rec-a", {"crop": "Teh"}, farmer), 409), "the AI crop field itself stays locked")
    check(refused(lambda: update("rec-a", {"correctedCrop": "  "}, farmer), 400), "a blank species is refused")
    check(refused(lambda: update("rec-a", {"correctedCrop": {"x": 1}}, farmer), 400), "a non-text species is refused")
    check(refused(lambda: update("rec-a", {"correctedTimestampMs": now + 3 * day}, farmer), 400), "a future date is refused")
    check(refused(lambda: update("rec-a", {"correctedTimestampMs": 0}, farmer), 400), "a date before 2000 is refused")
    check(refused(lambda: update("rec-a", {"correctedTimestampMs": True}, farmer), 400), "a boolean date is refused")
    check(refused(lambda: update("rec-a", {"correctedCrop": "Teh"}, other), 404), "another account cannot correct it")

    saved = update("rec-b", {"correctedCrop": "Kopi Arabika"}, farmer)
    check(saved["crop"] == "Kopi Arabika" and saved["cropName"] == "Kopi Arabika", "the species and the plant name change")
    check(saved["aiCrop"] == "Kopi" and saved["correctedFields"] == ["crop"], "the AI's species is kept beside the correction")
    check(saved["condition"] == "Karat daun" and saved["severity"] == "Moderate" and saved["confidence"] == 0.8
          and saved["assessment"] is not None, "the AI diagnosis is untouched")
    sibling = db.row_record(db.query_one("SELECT * FROM records WHERE id='rec-a'"))
    check(sibling["crop"] == "Kopi Arabika" and sibling["aiCrop"] == "Kopi" and sibling["correctedFields"] == ["crop"],
          "the plant's other photo follows the species")
    check(db.row_record(db.query_one("SELECT * FROM records WHERE id='rec-c'"))["crop"] == "Kopi", "another plant is untouched")
    audit = db.query("SELECT target, detail, actor_email FROM audit_log WHERE action='record.correct'")
    check(len(audit) == 1 and audit[0]["target"] == "rec-b" and "Kopi → Kopi Arabika" in audit[0]["detail"]
          and "+1 foto lain" in audit[0]["detail"] and audit[0]["actor_email"] == farmer["email"], "the correction is audited")

    observed = update("rec-b", {"observedSeverity": "Severe",
                                  "observedProblems": {"disease": "Hawar daun", "pest": "Wereng"}}, farmer)
    check(observed["observedSeverity"] == "Severe" and observed["severity"] == "Moderate"
          and observed["observedProblems"] == {"disease": "Hawar daun", "pest": "Wereng"},
          "farmer status and both observed problems stay separate from AI severity")
    check(refused(lambda: update("rec-a", {"severity": "Healthy"}, farmer), 409),
          "the AI severity cannot be directly replaced")
    check(refused(lambda: update("rec-a", {"observedProblems": {"disease": ["bad"], "pest": ""}}, farmer), 400)
          and refused(lambda: update("rec-a", {"observedProblems": {"disease": "Hawar", "pest": "", "other": "x"}}, farmer), 400),
          "problem labels reject non-text values and unknown fields")
    observed_audit = db.query("SELECT target, detail FROM audit_log WHERE action='record.observe'")
    check(len(observed_audit) == 1 and observed_audit[0]["target"] == "rec-b"
          and "status pengamatan" in observed_audit[0]["detail"] and "dugaan hama/penyakit" in observed_audit[0]["detail"],
          "status and pest/disease changes are audited")

    only = update("rec-c", {"correctedCrop": "Teh", "applyToPlant": False}, farmer)
    check(only["crop"] == "Teh", "applyToPlant false changes this photo")

    target = now - 10 * day
    dated = update("rec-a", {"correctedTimestampMs": target}, farmer)
    check(dated["timestampMs"] == target and dated["date"] == time.strftime("%Y-%m-%d", time.localtime(target / 1000)),
          "the photo date and its day change together")
    check(sorted(dated["correctedFields"]) == ["crop", "date"] and dated["captureTimeSource"] == "manual"
          and dated["captureTimeKnown"] is True, "the date is marked as corrected by hand")
    extra = db.from_json(db.query_one("SELECT extra_json FROM records WHERE id='rec-a'")["extra_json"], {})
    check(extra["originalTimestampMs"] == now - 3 * day and extra["locationSource"] == "gps", "the original time and other extras are kept")

    back = update("rec-b", {"correctedCrop": "Kopi (Coffee)", "applyToPlant": False}, farmer)
    check(back["correctedFields"] == [], "choosing the AI's species again clears the mark")
    update("rec-b", {"correctedCrop": "Kopi Arabika", "applyToPlant": False}, farmer)

    located = update("rec-b", {"lat": -6.2, "lng": 106.8, "locationSource": "manual"}, farmer)
    check(located["correctedFields"] == ["crop"] and located["locationSource"] == "manual", "a location edit keeps the correction")

    # A re-analysis keeps the farmer's species.
    with db.transaction() as tx:
        queue._apply_reanalysis_result(tx, {"account_id": farmer["id"], "context_json": db.to_json({"reanalysisRecordId": "rec-b"})},
                                       {"crop": "Kopi (Coffee)", "condition": "Bercak daun", "severity": "Moderate", "confidence": 0.7,
                                        "assessment": {"version": 1, "findings": ["Bercak."]}})
    after = db.row_record(db.query_one("SELECT * FROM records WHERE id='rec-b'"))
    check(after["crop"] == "Kopi Arabika" and after["condition"] == "Bercak daun", "re-analysis updates the diagnosis, not the corrected species")
    check(after["observedSeverity"] == "Severe" and after["observedProblems"] == {"disease": "Hawar daun", "pest": "Wereng"},
          "re-analysis preserves the farmer's status and pest/disease observations")
    with db.transaction() as tx:
        queue._apply_reanalysis_result(tx, {"account_id": farmer["id"], "context_json": db.to_json({"reanalysisRecordId": "rec-c"})},
                                       {"crop": "Teh (Tea)", "condition": "Tanaman Sehat", "severity": "Healthy", "confidence": 0.9})
    check(db.row_record(db.query_one("SELECT * FROM records WHERE id='rec-c'"))["crop"] == "Teh",
          "re-analysis of a corrected record keeps it too")

    # A later photo of the corrected plant inherits the species.
    later = api_app.create_record({"id": "rec-d", "cropId": "plant-1", "crop": "Kopi (Coffee)", "condition": "Sehat",
                                   "severity": "Healthy", "timestampMs": now, "source": "manual"}, farmer)
    check(later["crop"] == "Kopi Arabika" and later["aiCrop"] == "Kopi" and later["correctedFields"] == ["crop"],
          "a new photo of the plant keeps the farmer's species")
    changed_manual = update("rec-d", {"severity": "Severe"}, farmer)
    check(changed_manual["severity"] == "Severe", "a manual photo status can be edited")
    cleared_manual = update("rec-d", {"severity": None}, farmer)
    check(cleared_manual["severity"] is None, "a manual photo status can be cleared")

print(f"petak 0257: {checks} assertions passed")
