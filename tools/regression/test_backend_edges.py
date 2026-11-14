"""Disposable-fixture regressions for audit findings; never import live data."""
import os
from pathlib import Path
import sys
import tempfile
import unittest

DEFAULT_APP = Path(__file__).parent / 'work-copy/app'
if not DEFAULT_APP.exists():
    DEFAULT_APP = Path(__file__).resolve().parents[2] / 'app'
APP = Path(os.environ.get('JK_AUDIT_APP', str(DEFAULT_APP))).resolve()
assert not (APP / '.env').exists(), 'Refuse source with private environment'
sys.path.insert(0, str(APP))
from backend import api_app, api_admin, db
from unittest.mock import patch
from fastapi import HTTPException


class BackendEdges(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        db.close_all()
        db.DB_PATH = Path(self.tmp.name) / 'fixture.sqlite3'
        api_app.UPLOAD_DIR = Path(self.tmp.name) / 'uploads'
        api_app.UPLOAD_DIR.mkdir()
        db.migrate()
        self.account = {'id': 'fixture', 'role': 'user'}
        now = db.now_ms()
        with db.transaction() as tx:
            tx.execute('INSERT INTO accounts(id,email,password_hash,created_ms,updated_ms) VALUES(?,?,?,?,?)', ('fixture', 'fixture@invalid.test', 'synthetic', now, now))
        self.ring = [[0, 0], [0, 1], [1, 0]]
        self.ring = api_app.create_farm({'id': 'farm_fixture', 'ring': self.ring, 'areaM2': 100}, account=self.account)['ring']

    def tearDown(self):
        db.close_all()
        self.tmp.cleanup()

    def test_invalid_area_does_not_partially_commit_new_ring(self):
        changed = [[0, 0], [0, 2], [2, 0]]
        with self.assertRaises(HTTPException):
            api_app.update_farm('farm_fixture', {'ring': changed, 'areaM2': -1}, account=self.account)
        saved = api_app.list_farms(account=self.account)[0]
        self.assertEqual(saved['ring'], self.ring)
        self.assertEqual(saved['areaM2'], 100)

    def test_account_delete_removes_uploaded_files(self):
        now = db.now_ms()
        photo = api_app.UPLOAD_DIR / 'fixture.jpg'
        photo.write_bytes(b'synthetic')
        with db.transaction() as tx:
            tx.execute('INSERT INTO photos(id,account_id,file_name,bytes,created_ms) VALUES(?,?,?,?,?)', ('photo_fixture', 'fixture', photo.name, 9, now))
        result = api_admin.admin_delete_account('fixture', admin={'id': 'admin_fixture', 'email': 'admin@invalid.test'})
        self.assertTrue(result['ok'])
        self.assertFalse(photo.exists())
        self.assertIsNone(db.query_one('SELECT id FROM photos WHERE id=?', ('photo_fixture',)))

    def test_account_delete_reports_unlink_failure_without_false_success_claim(self):
        now = db.now_ms()
        photo = api_app.UPLOAD_DIR / 'blocked.jpg'
        photo.write_bytes(b'synthetic')
        with db.transaction() as tx:
            tx.execute('INSERT INTO photos(id,account_id,file_name,bytes,created_ms) VALUES(?,?,?,?,?)', ('photo_fixture', 'fixture', photo.name, 9, now))
        # 0.2.2.0: deletion writes a durable cleanup ticket; the drainer unlinks via os.unlink(dir_fd=...).
        # An unlink failure must keep the file AND the ticket, and the response must not claim it was cleaned.
        import os as _os
        real_unlink = _os.unlink
        def failing_unlink(path, *args, **kwargs):
            if str(path).endswith('blocked.jpg'):
                raise PermissionError('fixture')
            return real_unlink(path, *args, **kwargs)
        with patch.object(_os, 'unlink', side_effect=failing_unlink):
            result = api_admin.admin_delete_account('fixture', admin={'id': 'admin_fixture', 'email': 'admin@invalid.test'})
        self.assertEqual(result['photoCleanupFailures'], 1)
        self.assertEqual(result['photoCleanup']['cleaned'], 0)
        self.assertTrue(photo.exists())
        self.assertIn('dijadwalkan dibersihkan', db.query_one("SELECT detail FROM audit_log WHERE action='account.delete'")['detail'])
        self.assertEqual(db.query_one("SELECT COUNT(*) AS n FROM photo_cleanup WHERE state='pending'")['n'], 1)

    def test_recovery_with_echoed_deleted_plot_still_collects_result(self):
        now = db.now_ms()
        with db.transaction() as tx:
            tx.execute('INSERT INTO jobs(id,account_id,status,created_ms,updated_ms,context_json,diagnosis_json) VALUES(?,?,?,?,?,?,?)', ('job_echo', 'fixture', 'done', now, now, db.to_json({'farmId': 'farm_fixture'}), db.to_json({'crop': 'Mangga', 'severity': 'Healthy'})))
        api_app.delete_farm('farm_fixture', account=self.account)
        saved = api_app.create_record({'id': 'record_job_echo', 'source': 'ai', 'farmId': 'farm_fixture'}, account=self.account)
        self.assertIsNone(saved['farmId'])

    def test_valid_farm_update_commits_all_fields(self):
        changed = [[0, 0], [0, 2], [2, 0]]
        saved = api_app.update_farm('farm_fixture', {'ring': changed, 'areaM2': 200, 'name': 'Updated'}, account=self.account)
        self.assertEqual(saved['areaM2'], 200)
        self.assertEqual(saved['name'], 'Updated')
        self.assertEqual(saved['ring'][1], [0, 2])

    def test_manual_record_rejects_missing_farm(self):
        with self.assertRaises(HTTPException) as error:
            api_app.create_record({'id': 'manual_fixture', 'farmId': 'missing'}, account=self.account)
        self.assertEqual(error.exception.status_code, 404)

    def test_recovery_after_plot_deletion_does_not_save_dangling_reference(self):
        now = db.now_ms()
        with db.transaction() as tx:
            tx.execute('INSERT INTO jobs(id,account_id,status,created_ms,updated_ms,context_json,diagnosis_json) VALUES(?,?,?,?,?,?,?)', ('job_fixture', 'fixture', 'done', now, now, db.to_json({'farmId': 'farm_fixture'}), db.to_json({'crop': 'Mangga', 'severity': 'Healthy'})))
        api_app.delete_farm('farm_fixture', account=self.account)
        saved = api_app.create_record({'id': 'record_job_fixture', 'source': 'ai'}, account=self.account)
        self.assertIsNone(saved['farmId'])


if __name__ == '__main__':
    unittest.main()
