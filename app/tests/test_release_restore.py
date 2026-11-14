"""Disposable restore/backup acceptance tests; never touches deployed files."""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'deploy' / 'release_ops.py'
spec = importlib.util.spec_from_file_location('release_ops', SCRIPT)
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)

class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ['TMPDIR'], prefix='jk-restore-test-')
        self.root = Path(self.temp.name)
        self.app = self.root / 'source'
        (self.app / 'data/uploads').mkdir(parents=True)
        (self.app / 'backend').mkdir()
        (self.app / 'frontend').mkdir()
        (self.app / 'backend/app.py').write_text('version=1\n')
        (self.app / 'frontend/index.html').write_text('<p>fixture</p>')
        (self.app / '.env').write_text('SYNTHETIC=fixture-only\n')
        self.connection = sqlite3.connect(self.app / 'data/db.sqlite3')
        self.connection.execute('PRAGMA journal_mode=WAL')
        self.connection.execute('CREATE TABLE photos(id TEXT,file_name TEXT)')
        self.connection.execute('CREATE TABLE events(id INTEGER,value TEXT)')
        self.connection.execute("INSERT INTO events VALUES(1,'from-wal')")
        self.connection.execute("INSERT INTO photos VALUES('fixture','fixture.jpg')")
        self.connection.commit()
        (self.app / 'data/uploads/fixture.jpg').write_bytes(b'fixture-photo')
        self.backups = self.root / 'backups'
    def tearDown(self):
        self.connection.close()
        self.temp.cleanup()
    def test_snapshot_wal_and_restore_without_source_imports(self):
        snap = ops.create_snapshot(self.app, self.backups, quiesced=True)
        ops.verify_snapshot(snap)
        restored = self.root / 'restored'
        ops.restore_snapshot(snap, restored)
        with sqlite3.connect(restored / 'data/db.sqlite3') as c:
            self.assertEqual(c.execute('SELECT value FROM events').fetchone()[0], 'from-wal')
            self.assertEqual(c.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
        self.assertEqual((restored/'data/uploads/fixture.jpg').read_bytes(),b'fixture-photo')
        self.assertEqual((restored/'.env').stat().st_mode & 0o777,0o600)
        self.assertFalse(list(self.backups.glob('*.partial')))
    def test_refuse_uncoordinated_snapshot(self):
        with self.assertRaises(ValueError):ops.create_snapshot(self.app,self.backups,quiesced=False)
    def test_missing_reference_is_not_success(self):
        (self.app/'data/uploads/fixture.jpg').unlink()
        with self.assertRaises(ValueError):ops.create_snapshot(self.app,self.backups,quiesced=True)
        self.assertFalse([p for p in self.backups.glob('*') if not p.name.endswith('.partial')])
    def test_reject_path_traversal_in_photo_table(self):
        self.connection.execute("UPDATE photos SET file_name='../unsafe'")
        self.connection.commit()
        with self.assertRaises(ValueError):ops.create_snapshot(self.app,self.backups,quiesced=True)
    def test_tampered_snapshot_refused_before_restore(self):
        snap=ops.create_snapshot(self.app,self.backups,quiesced=True)
        (snap/'data/uploads/fixture.jpg').write_bytes(b'tampered')
        dest=self.root/'restore'
        with self.assertRaises(ValueError):ops.restore_snapshot(snap,dest)
        self.assertFalse(dest.exists())
    def test_restore_only_to_empty_target(self):
        snap=ops.create_snapshot(self.app,self.backups,quiesced=True)
        dest=self.root/'existing';dest.mkdir();(dest/'keep').write_text('keep')
        with self.assertRaises(ValueError):ops.restore_snapshot(snap,dest)
        self.assertTrue((dest/'keep').exists())
    def test_snapshot_rejects_source_symlink(self):
        (self.app/'frontend/escape').symlink_to(self.root)
        with self.assertRaises(ValueError):ops.create_snapshot(self.app,self.backups,quiesced=True)

if __name__=='__main__':unittest.main()
