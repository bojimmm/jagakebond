"""Isolated API ownership, idempotency, and source-authority regressions."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import math
import sys
import tempfile
import threading
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException, UploadFile
from PIL import Image

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))
from backend import api_app, api_admin, db  # noqa: E402


def check(label: str, condition: bool) -> None:
    if not condition:
        raise AssertionError(label)


with tempfile.TemporaryDirectory(prefix="jagakebond-api-contract-", dir=Path(__import__("os").environ["TMPDIR"])) as folder:
    root = Path(folder)
    db.close_all()
    db.DB_PATH = root / "fixture.sqlite3"
    api_app.UPLOAD_DIR = root / "uploads"
    api_app.UPLOAD_DIR.mkdir()
    db.migrate()
    now = db.now_ms()
    with db.transaction() as tx:
        for ident, quota in (("a", 1), ("b", 1), ("c", 1)):
            tx.execute("INSERT INTO accounts(id,email,password_hash,created_ms,updated_ms,daily_quota) VALUES(?,?,?,?,?,?)",
                       (ident, f"{ident}@fixture.invalid", "synthetic", now, now, quota))
        tx.execute("INSERT INTO photos(id,account_id,file_name,bytes,created_ms) VALUES(?,?,?,?,?)",
                   ("shared", "b", "shared.jpg", 4, now))
        tx.execute("INSERT INTO photos(id,account_id,file_name,bytes,created_ms) VALUES(?,?,?,?,?)",
                   ("owned", "a", "owned.jpg", 4, now))
        tx.execute("INSERT INTO records(id,account_id,image_url,created_ms,updated_ms) VALUES(?,?,?,?,?)",
                   ("owner-b-record", "b", "/api/photos/shared", now, now))
        tx.execute("INSERT INTO records(id,account_id,image_url,created_ms,updated_ms) VALUES(?,?,?,?,?)",
                   ("a-first-ref", "a", "/api/photos/owned", now, now))
        tx.execute("INSERT INTO records(id,account_id,image_url,created_ms,updated_ms) VALUES(?,?,?,?,?)",
                   ("a-second-ref", "a", "/api/photos/owned", now, now))
        tx.execute("INSERT INTO farms(id,account_id,name,ring_json,created_ms,updated_ms) VALUES(?,?,?,?,?,?)",
                   ("farm-a", "a", "A farm", "[]", now, now))
        tx.execute("INSERT INTO farms(id,account_id,name,ring_json,created_ms,updated_ms) VALUES(?,?,?,?,?,?)",
                   ("farm-b", "b", "B farm", "[]", now, now))
    (api_app.UPLOAD_DIR / "shared.jpg").write_bytes(b"safe")
    (api_app.UPLOAD_DIR / "owned.jpg").write_bytes(b"owned")
    (api_app.UPLOAD_DIR / "shared.jpg").write_bytes(b"safe")
    try:
        api_app.create_record({"id": "owner-a-record", "imageUrl": "/api/photos/shared"}, account={"id": "a", "role": "user"})
    except HTTPException as exc:
        check("foreign photo reference rejected", exc.status_code == 404)
    else:
        raise AssertionError("foreign photo reference accepted")
    check("foreign photo row preserved", db.query_one("SELECT id FROM photos WHERE id='shared'") is not None)
    check("foreign photo file preserved", (api_app.UPLOAD_DIR / "shared.jpg").exists())
    for call, label in (
        (lambda: api_app.update_farm("farm-b", {"name": "stolen"}, account={"id": "a", "role": "user"}),
         "foreign farm update rejected"),
        (lambda: api_app.delete_farm("farm-b", account={"id": "a", "role": "user"}),
         "foreign farm delete rejected"),
    ):
        try:
            call()
        except HTTPException as exc:
            check(label, exc.status_code == 404)
        else:
            raise AssertionError(f"{label}: access accepted")
    check("foreign farm unchanged", db.query_one("SELECT name FROM farms WHERE id='farm-b'")["name"] == "B farm")
    for payload in ({"id": "farm-b", "ring": [[0, 0], [0, 1], [1, 0]]},
                    {"id": "farm-valid-area", "ring": [[0, 0], [0, 1], [1, 0]], "areaM2": "NaN"},
                    {"id": "farm-negative-area", "ring": [[0, 0], [0, 1], [1, 0]], "areaM2": -1}):
        try:
            api_app.create_farm(payload, account={"id": "a", "role": "user"})
        except HTTPException as exc:
            check("farm collision / invalid area rejected", exc.status_code in (400, 409))
        else:
            raise AssertionError(f"foreign farm overwrite or invalid area accepted: {payload['id']}")
    check("foreign farm still intact after attempted overwrite",
          db.query_one("SELECT name FROM farms WHERE id='farm-b'")["name"] == "B farm")
    api_app.upsert_daily({"id": "daily-b", "title": "owner b"}, account={"id": "b", "role": "user"})
    try:
        api_app.upsert_daily({"id": "daily-b", "title": "overwritten"}, account={"id": "a", "role": "user"})
    except HTTPException as exc:
        check("foreign daily ID cannot be overwritten", exc.status_code == 409)
    else:
        raise AssertionError("foreign daily ID overwritten")
    check("foreign daily unchanged", db.query_one("SELECT title FROM daily WHERE id='daily-b'")["title"] == "owner b")
    request = type("Request", (), {"cookies": {"session": "foreign"}})()
    with patch.object(api_app.security, "session_account", return_value={"id": "a", "role": "user"}):
        try:
            api_app.get_photo("shared", request)
        except HTTPException as exc:
            check("foreign photo read rejected", exc.status_code == 404)
        else:
            raise AssertionError("foreign photo read accepted")

    api_app.delete_record("a-first-ref", account={"id": "a", "role": "user"})
    check("shared owned photo row survives first unlink", db.query_one("SELECT id FROM photos WHERE id='owned'") is not None)
    check("shared owned photo file survives first unlink", (api_app.UPLOAD_DIR / "owned.jpg").exists())
    api_app.delete_record("a-second-ref", account={"id": "a", "role": "user"})
    check("last unlink deletes owned photo row", db.query_one("SELECT id FROM photos WHERE id='owned'") is None)
    check("last unlink deletes owned photo file", not (api_app.UPLOAD_DIR / "owned.jpg").exists())
    try:
        asyncio.run(api_app.diagnose())
    except HTTPException as exc:
        check("legacy diagnosis endpoint disabled", exc.status_code == 410)
    else:
        raise AssertionError("legacy fabricated fallback diagnosis remained enabled")
    check("foreign photo row preserved", db.query_one("SELECT id FROM photos WHERE id='shared'") is not None)
    check("foreign photo file preserved", (api_app.UPLOAD_DIR / "shared.jpg").exists())

    check("finite zero retained", api_app._strict_number("0", "lat") == 0.0)
    for bad in ("NaN", "Infinity", "-Infinity", "junk"):
        try:
            api_app._strict_number(bad, "lat")
        except HTTPException:
            continue
        raise AssertionError(f"invalid numeric input accepted: {bad}")
    for lat, lng in (("91", "0"), ("0", "181")):
        try:
            api_app._validate_coordinates(lat, lng)
        except HTTPException:
            continue
        raise AssertionError("out of range coordinate accepted")

    async def read_upload(upload):
        return await upload.read()

    def thumb(data, size, quality):
        return "thumb:" + data.hex()

    async def submit(key, image_bytes, *, lat="0", farm=None):
        return await api_app.analyze(
            image=UploadFile(file=BytesIO(image_bytes), filename="capture.jpg"),
            lat=lat, lng="0", elevation=None, locationName=None, accuracy=None,
            weather=None, photoDate=None, photoTimestampMs=None, farmId=farm,
            deviceId="device", cropHint=None, tier="fast",
            clientRequestId=key, account={"id": "a", "daily_quota": 1, "role": "user"},
        )

    with patch.object(api_app, "_read_capped", read_upload), patch.object(api_app, "_thumbnail_b64_from_bytes", thumb):
        first = asyncio.run(submit("draft-1", b"original image"))
        retry = asyncio.run(submit("draft-1", b"original image", lat="0.0"))
        check("identical normalized retry same job", first["job_id"] == retry["job_id"])
        for kw in ({"image_bytes": b"changed image"}, {"image_bytes": b"original image", "lat": "1"}):
            try:
                asyncio.run(submit("draft-1", **kw))
            except HTTPException as exc:
                check("same key changed payload conflicts", exc.status_code == 409)
            else:
                raise AssertionError("changed payload reused idempotency key")
        for invalid_lat, invalid_lng in (("NaN", "0"), ("Infinity", "0"), ("0", "-Infinity"),
                                         ("91", "0"), ("0", "181"), ("0", None)):
            try:
                asyncio.run(api_app.analyze(
                    image=UploadFile(file=BytesIO(b"validation image"), filename="capture.jpg"),
                    lat=invalid_lat, lng=invalid_lng, elevation=None, locationName=None,
                    accuracy=None, weather=None, photoDate=None, photoTimestampMs=None,
                    farmId=None, deviceId=None, cropHint=None, tier=None,
                    clientRequestId=None, account={"id": "a", "daily_quota": 1, "role": "user"},
                ))
            except HTTPException as exc:
                check("invalid upload coordinates rejected with 400", exc.status_code == 400)
            else:
                raise AssertionError(f"invalid coordinates accepted: {invalid_lat}, {invalid_lng}")
        for field, value in (("elevation", "NaN"), ("accuracy", "Infinity"),
                             ("photoTimestampMs", "-Infinity")):
            params = dict(image=UploadFile(file=BytesIO(b"validation image"), filename="capture.jpg"),
                          lat="0", lng="0", elevation=None, locationName=None, accuracy=None,
                          weather=None, photoDate=None, photoTimestampMs=None, farmId=None,
                          deviceId=None, cropHint=None, tier=None, clientRequestId=None,
                          account={"id": "a", "daily_quota": 1, "role": "user"})
            params[field] = value
            try:
                asyncio.run(api_app.analyze(**params))
            except HTTPException as exc:
                check(f"non-finite {field} rejected with 400", exc.status_code == 400)
            else:
                raise AssertionError(f"non-finite {field} accepted")
        asyncio.run(submit("draft-2", b"different image"))
        asyncio.run(submit("draft-3", b"another image"))
        # A stale daily_quota in the request cannot shrink the role allowance: the old
        # three-photo cap is gone and every one of these still runs on the fast pair.
        receipts = [asyncio.run(submit(f"draft-{index}", b"allowance image"))
                    for index in range(4, 9)]
        check("stale daily_quota does not shrink the role allowance",
              all(receipt["tier"] == "fast" for receipt in receipts))

    # Leave exactly one fast admission at the boundary, then race two calls: one keeps
    # the fast pair, the other falls back to the paced lane, and both are admitted.
    with db.transaction() as tx:
        for index in range(19):
            tx.execute("INSERT INTO jobs(id,account_id,status,created_ms,updated_ms,context_json) VALUES(?,?,?,?,?,?)",
                       (f"c-fast-{index}", "c", "failed", db.now_ms(), db.now_ms(), '{"analysisTier":"fast"}'))
    barrier = threading.Barrier(2, timeout=10)
    def concurrent_thumb(data, size, quality):
        barrier.wait()
        return "thumb"
    def call_concurrent(index):
        return asyncio.run(api_app.analyze(
            image=UploadFile(file=BytesIO(f"parallel-{index}".encode()), filename="capture.jpg"),
            lat=None, lng=None, elevation=None, locationName=None, accuracy=None, weather=None,
            photoDate=None, photoTimestampMs=None, farmId=None, deviceId=None, cropHint=None,
            tier="fast", clientRequestId=f"parallel-{index}",
            account={"id": "c", "daily_quota": 1, "role": "user"},
        ))
    def run_thread(index, outcomes):
        try:
            outcomes.append(call_concurrent(index))
        except HTTPException as exc:
            outcomes.append(exc.status_code)
    outcomes = []
    with patch.object(api_app, "_read_capped", read_upload), patch.object(api_app, "_thumbnail_b64_from_bytes", concurrent_thumb):
        threads = [threading.Thread(target=run_thread, args=(i, outcomes)) for i in range(2)]
        for thread in threads: thread.start()
        for thread in threads: thread.join(timeout=15)
    tiers = sorted(str(item.get("tier") if isinstance(item, dict) else item) for item in outcomes)
    check("quota boundary concurrency admits one fast and one normal", tiers == ["fast", "normal"])
    check("quota boundary concurrency persists both photos", db.query_one("SELECT COUNT(*) n FROM jobs WHERE account_id='c'")["n"] == 21)

    row = db.query_one("SELECT id FROM jobs WHERE account_id='a' LIMIT 1")
    job_id = row["id"]
    try:
        api_app.analyze_ack(job_id, account={"id": "a", "role": "user"})
    except HTTPException as exc:
        check("ack rejects queued job", exc.status_code == 409)
    else:
        raise AssertionError("queued job was acknowledged")
    check("queued ack keeps input image", db.query_one("SELECT image_b64 FROM jobs WHERE id=?", (job_id,))["image_b64"] is not None)
    try:
        api_app.analyze_ack(job_id, account={"id": "b", "role": "user"})
    except HTTPException as exc:
        check("foreign job ack rejected", exc.status_code == 404)
    else:
        raise AssertionError("foreign job acknowledged")
    with db.transaction() as tx:
        tx.execute("UPDATE jobs SET status='claimed', image_b64='retained' WHERE id=?", (job_id,))
    try:
        api_app.analyze_ack(job_id, account={"id": "a", "role": "user"})
    except HTTPException as exc:
        check("claimed ack rejected", exc.status_code == 409)
    else:
        raise AssertionError("claimed job was acknowledged")
    check("claimed ack keeps input image", db.query_one("SELECT image_b64 FROM jobs WHERE id=?", (job_id,))["image_b64"] == "retained")
    source_image = Image.new("RGB", (18, 12), (211, 37, 89))
    image_buffer = BytesIO()
    source_image.save(image_buffer, format="JPEG", quality=100)
    source_image_bytes = image_buffer.getvalue()
    with db.transaction() as tx:
        tx.execute("UPDATE jobs SET status='done', diagnosis_json=?, image_b64=? WHERE id=?",
                   ('{"crop":"server crop","condition":"server result","severity":"Moderate",'
                    '"symptoms_id":"server symptom","immediate_action_id":"safe", "confidence":0.6}',
                    base64.b64encode(source_image_bytes).decode("ascii"), job_id))
    ai_record = api_app.create_record({"id": f"record_{job_id}", "source": "ai",
                                       "crop": "tampered", "condition": "tampered", "severity": "tampered",
                                       "immediate_action": "tampered"}, account={"id": "a", "role": "user"})
    check("AI record retains owned original-photo endpoint", ai_record["imageUrl"] == f"/api/photos/photo_{job_id}")
    saved_photo = db.query_one("SELECT account_id,file_name FROM photos WHERE id=?", (f"photo_{job_id}",))
    check("retained image is owned by job account", saved_photo and saved_photo["account_id"] == "a")
    saved_image = Image.open(api_app.UPLOAD_DIR / saved_photo["file_name"])
    check("retained photo endpoint contains original image content", saved_image.size == (18, 12) and
          saved_image.getpixel((0, 0))[0] > 180 and saved_image.getpixel((0, 0))[2] > 50)
    with patch.object(api_app.security, "session_account", return_value={"id": "a", "role": "user"}):
        recovered_response = api_app.get_photo(f"photo_{job_id}", SimpleNamespace(cookies={"session": "fixture"}))
    check("owned photo GET returns retained source file", Path(recovered_response.path) == api_app.UPLOAD_DIR / saved_photo["file_name"])
    check("completed ack succeeds", api_app.analyze_ack(job_id, account={"id": "a", "role": "user"})["ok"] is True)
    acknowledged = db.query_one("SELECT acked, image_b64 FROM jobs WHERE id=?", (job_id,))
    check("ack clears queue input but retained photo remains", acknowledged["acked"] == 1 and acknowledged["image_b64"] is None and
          (api_app.UPLOAD_DIR / saved_photo["file_name"]).exists() and
          db.query_one("SELECT image_url FROM records WHERE id=?", (f"record_{job_id}",))["image_url"] == f"/api/photos/photo_{job_id}")
    original = api_app.update_record(f"record_{job_id}", {"observedSeverity": "Severe"}, account={"id": "a", "role": "user"})
    check("observed severity does not rewrite AI severity/confidence",
          original["observedSeverity"] == "Severe" and original["severity"] == "Moderate" and original["confidence"] == 0.6)
    cleared = api_app.update_record(f"record_{job_id}", {"observedSeverity": None}, account={"id": "a", "role": "user"})
    check("observed severity can clear independently", cleared["observedSeverity"] is None)
    try:
        api_app.update_record(f"record_{job_id}", {"observedSeverity": "unknown"}, account={"id": "a", "role": "user"})
    except HTTPException as exc:
        check("observed severity exact enum", exc.status_code == 400)
    else:
        raise AssertionError("invalid observed severity accepted")
    try:
        api_app.update_record(f"record_{job_id}", {"observedSeverity": "Severe"}, account={"id": "b", "role": "user"})
    except HTTPException as exc:
        check("observed severity account ownership", exc.status_code == 404)
    else:
        raise AssertionError("foreign account changed observed severity")
    try:
        api_app.create_record({"id": "record_manual-test", "condition": "forged"}, account={"id": "a", "role": "user"})
    except HTTPException as exc:
        check("record namespace reserved even without source", exc.status_code == 409)
    else:
        raise AssertionError("reserved record ID accepted without source")
    try:
        api_app.create_record({"id": "record_missing", "source": "ai", "condition": "forged"}, account={"id": "a", "role": "user"})
    except HTTPException as exc:
        check("AI source requires owned completed job", exc.status_code == 409)
    else:
        raise AssertionError("unowned/nonexistent AI job accepted")
    try:
        api_app.create_record({"id": "rec_foreign", "imageUrl": "/api/photos/shared"}, account={"id": "a", "role": "user"})
    except HTTPException as exc:
        check("foreign photo cannot be referenced", exc.status_code == 404)
    else:
        raise AssertionError("foreign photo linked to account")
    try:
        api_app.create_record({"id": "rec_foreign_farm", "farmId": "foreign-farm"}, account={"id": "a", "role": "user"})
    except HTTPException as exc:
        check("foreign farm cannot be referenced", exc.status_code == 404)
    else:
        raise AssertionError("foreign farm linked to account")
    try:
        api_app.create_record({"id": "owner-b-record", "condition": "overwrite"}, account={"id": "a", "role": "user"})
    except HTTPException as exc:
        check("foreign record id cannot be replaced", exc.status_code == 409)
    else:
        raise AssertionError("foreign record ID overwritten")
    
    job_created = db.query_one("SELECT created_ms FROM jobs WHERE id=?", (job_id,))["created_ms"]
    check("AI record uses server-owned diagnosis", ai_record["condition"] == "server result" and ai_record["crop"] == "server crop")
    check("AI record capture time comes from job not client", ai_record["timestampMs"] == job_created)
    timeline = api_app.create_record({"id": "rec-timeline-one", "cropId": "new-crop-timeline"}, account={"id": "a", "role": "user"})
    followup = api_app.create_record({"id": "rec-timeline-two", "cropId": "new-crop-timeline"}, account={"id": "a", "role": "user"})
    check("new crop timeline and same-owner follow-up accepted", timeline["cropId"] == followup["cropId"] == "new-crop-timeline")
    with db.transaction() as tx:
        tx.execute("INSERT INTO records(id,account_id,crop_id,created_ms,updated_ms) VALUES(?,?,?,?,?)",
                   ("b-crop-record", "b", "owned-by-b", now, now))
    try:
        api_app.create_record({"id": "rec-foreign-crop", "cropId": "owned-by-b"}, account={"id": "a", "role": "user"})
    except HTTPException as exc:
        check("known foreign crop association rejected", exc.status_code == 404)
    else:
        raise AssertionError("foreign crop timeline accepted")
    unchanged = api_app.create_record({"id": f"record_{job_id}", "source": "ai", "condition": "rewritten"},
                                      account={"id": "a", "role": "user"})
    check("AI record retry immutable", unchanged["condition"] == "server result")
    for source in (None, "manual", "analisis"):
        payload = {"id": f"record_{job_id}", "condition": "overwrite"}
        if source is not None:
            payload["source"] = source
        try:
            api_app.create_record(payload, account={"id": "a", "role": "user"})
        except HTTPException as exc:
            check(f"reserved AI id blocks source {source}", exc.status_code == 409)
        else:
            raise AssertionError(f"reserved AI result overwritten with source={source}")
    check("symptoms_id authoritative", db.query_one("SELECT symptoms FROM records WHERE id=?", (f"record_{job_id}",))["symptoms"] == "server symptom")
    for url in ("http://evil.invalid/x", "https://api.open-meteo.com.evil.invalid/x",
                "https://user:pass@api.open-meteo.com/x", "https://api.open-meteo.com/x#fragment",
                "https://api.open-meteo.com:444/x"):
        try:
            api_app._validate_outbound_url(url)
        except HTTPException:
            continue
        raise AssertionError(f"unsafe outbound URL accepted: {url}")
    for url in ("https://api.open-meteo.com/v1/forecast", "http://localhost:20128/v1/models"):
        api_app._validate_outbound_url(url)
    with patch.object(api_admin.settings_store, "as_str", side_effect=lambda key: {
            "NINEROUTER_URL": "https://api.open-meteo.com", "GEMINI_TRIAGE_MODEL": "triage",
            "GEMINI_DIAGNOSE_MODEL": "diagnose"}[key]), \
         patch.object(api_admin.settings_store, "secret_value", return_value="fixture-secret"), \
         patch.object(api_admin.httpx, "Client") as client_factory:
        client = client_factory.return_value.__enter__.return_value
        client.get.return_value.status_code = 302
        client.get.return_value.headers = {"location": "https://attacker.invalid/steal"}
        result = api_admin.test_router(admin={"id": "admin"})
        check("admin router probe does not follow redirects", client_factory.call_args.kwargs.get("follow_redirects") is False)
        check("admin router probe never requests redirect target", client.get.call_count == 1 and "attacker.invalid" not in str(client.get.call_args))
        check("admin router probe does not leak exception details", "fixture-secret" not in str(result))
    print("api contract: ownership, idempotency, quota, validation, ack, SSRF and result assertions passed")
