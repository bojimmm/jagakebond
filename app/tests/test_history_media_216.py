"""Isolated backend regressions for feature 2.1.6 queue/history/media contract."""
from __future__ import annotations

import sys
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from PIL import Image

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE))
from backend import api_app, db  # noqa: E402


class Feature216BackendTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="feature216-", dir=__import__("os").environ["TMPDIR"])
        root = Path(self.temp.name)
        db.close_all()
        db.DB_PATH = root / "fixture.sqlite3"
        api_app.UPLOAD_DIR = root / "uploads"
        api_app.UPLOAD_DIR.mkdir()
        db.migrate()
        now = db.now_ms()
        with db.transaction() as tx:
            for aid in ("a", "b"):
                tx.execute("INSERT INTO accounts(id,email,password_hash,created_ms,updated_ms) VALUES(?,?,?,?,?)",
                           (aid, aid + "@test.invalid", "unused", now, now))
            tx.execute("INSERT INTO farms(id,account_id,name,ring_json,created_ms,updated_ms) VALUES(?,?,?,?,?,?)",
                       ("farm-a", "a", "Farm A", "[]", now, now))
            for ident, status, owner in (("queued", "queued", "a"), ("claimed", "claimed", "a"),
                                         ("done", "done", "a"), ("failed", "failed", "a"),
                                         ("rejected", "rejected", "a"), ("cancelled", "cancelled", "a"),
                                         ("foreign", "failed", "b")):
                tx.execute("INSERT INTO jobs(id,account_id,status,created_ms,updated_ms,image_b64,context_json) VALUES(?,?,?,?,?,?,?)",
                           (ident, owner, status, now, now, "image", "{}"))

    def tearDown(self):
        db.close_all()
        self.temp.cleanup()

    @staticmethod
    def account(ident="a"):
        return {"id": ident, "role": "user"}

    def test_pending_lists_every_unacked_job_status_and_scopes_owner(self):
        found = {job["id"] for job in api_app.queue_pending(account=self.account())}
        self.assertEqual(found, {"queued", "claimed", "done", "failed", "rejected", "cancelled"})
        with db.transaction() as tx:
            tx.execute("UPDATE jobs SET acked=1 WHERE id='failed'")
        self.assertNotIn("failed", {job["id"] for job in api_app.queue_pending(account=self.account())})
        self.assertEqual({job["id"] for job in api_app.queue_pending(account=self.account("b"))}, {"foreign"})

    def test_daily_log_references_only_owned_saved_updates(self):
        now = db.now_ms()
        with db.transaction() as tx:
            for ident, owner in (("own-update", "a"), ("foreign-update", "b")):
                tx.execute("INSERT INTO records(id,account_id,created_ms,updated_ms) VALUES(?,?,?,?)",
                           (ident, owner, now, now))
        saved=api_app.upsert_daily({"title":"Yesterday log","sourceRecordIds":["own-update"]},account=self.account())
        self.assertEqual(saved['sourceRecordIds'],['own-update'])
        for refs in [['foreign-update'],['missing-update'],'own-update',[123]]:
            with self.subTest(refs=refs), self.assertRaises(HTTPException):
                api_app.upsert_daily({"title":"Bad references","sourceRecordIds":refs},account=self.account())

    def test_cancel_owner_terminal_idempotence_retention_and_late_worker_guards(self):
        response = api_app.analyze_cancel("claimed", account=self.account())
        self.assertEqual(response["status"], "cancelled")
        row = db.query_one("SELECT status,acked,image_b64 FROM jobs WHERE id='claimed'")
        self.assertEqual((row["status"], row["acked"], row["image_b64"]), ("cancelled", 0, "image"))
        self.assertEqual(api_app.analyze_cancel("claimed", account=self.account())["status"], "cancelled")
        with self.assertRaises(HTTPException) as exc:
            api_app.analyze_result("claimed", {"triage": {"usable": True}, "diagnosis": {}}, _worker=None)
        self.assertEqual(exc.exception.status_code, 409)
        with self.assertRaises(HTTPException) as exc:
            api_app.analyze_cancel("foreign", account=self.account())
        self.assertEqual(exc.exception.status_code, 404)
        self.assertEqual(api_app.analyze_cancel("done", account=self.account())["status"], "done")
        with self.assertRaises(HTTPException) as exc:
            api_app.analyze_release("claimed", {}, _worker=None)
        self.assertEqual(exc.exception.status_code,409)
        self.assertEqual(db.query_one("SELECT status FROM jobs WHERE id='claimed'")["status"], "cancelled")

    def test_store_photo_bound_and_quality(self):
        source = Image.new("RGB", (2400, 1800), (80, 130, 45))
        buf = BytesIO()
        source.save(buf, format="JPEG", quality=95)
        photo_id = api_app._store_photo_sync(buf.getvalue(), "a", "bounded")
        # The file name is an internal token since 0.2.2.0 (storage.py); the photos row names it.
        blob = (api_app.UPLOAD_DIR / db.query_one("SELECT file_name FROM photos WHERE id=?", (photo_id,))["file_name"]).read_bytes()
        stored = Image.open(BytesIO(blob))
        self.assertLessEqual(max(stored.size), 1280)
        self.assertEqual(stored.format, "JPEG")
        self.assertEqual(len(blob), db.query_one("SELECT bytes FROM photos WHERE id=?", (photo_id,))["bytes"])
        self.assertEqual(api_app._STORE_PHOTO_QUALITY, 78)
        # The inference path remains independently 1024px, quality 80.
        self.assertEqual(api_app._PHONE_THUMB_PX, 1024)
        from base64 import b64decode
        inference = Image.open(BytesIO(b64decode(api_app._thumbnail_b64_from_bytes(blob, 1024, 80))))
        self.assertLessEqual(max(inference.size), 1024)
        self.assertGreaterEqual(min(inference.size), 1)
        self.assertEqual(inference.format, "JPEG")

    def test_record_manual_coordinates_pair_range_and_farm_assignment(self):
        now = db.now_ms()
        with db.transaction() as tx:
            tx.execute("INSERT INTO records(id,account_id,created_ms,updated_ms,source) VALUES(?,?,?,?,?)",
                       ("record-a", "a", now, now, "ai"))
        with self.assertRaises(HTTPException) as exc:
            api_app.update_record("record-a", {"lat": 1.0}, account=self.account())
        self.assertEqual(exc.exception.status_code, 400)
        updated = api_app.update_record("record-a", {"lat": -6.2, "lng": 106.8, "farmId": "farm-a"}, account=self.account())
        self.assertEqual((updated["lat"], updated["lng"], updated["farmId"]), (-6.2, 106.8, "farm-a"))
        updated = api_app.update_record("record-a", {"lat": 0, "lng": 0, "locationSource": "manual", "locationName": "Manual zero"}, account=self.account())
        self.assertEqual(updated["locationSource"], "manual")
        self.assertEqual(updated["locationName"], "Manual zero")
        self.assertIsNone(updated["accuracy"])
        self.assertEqual(db.migrate(), db.SCHEMA_VERSION)
        for payload in ({"lat": 91, "lng": 0}, {"lat": 0, "lng": float("nan")}):
            with self.assertRaises(HTTPException):
                api_app.update_record("record-a", payload, account=self.account())
        with self.assertRaises(HTTPException) as exc:
            api_app.update_record("record-a", {"lat": 0, "lng": 0, "farmId": "foreign-farm"}, account=self.account())
        self.assertEqual(exc.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
