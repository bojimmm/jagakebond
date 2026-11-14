"""Synthetic-only tests for guarded filesystem transaction primitives."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'deploy' / 'release_ops.py'
spec = importlib.util.spec_from_file_location('release_ops_transaction', SCRIPT)
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)


class TransactionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ['TMPDIR'], prefix='jk-transaction-test-')
        self.root = Path(self.temp.name)
        self.target = self.root / 'app'
        self.target.mkdir()
        (self.target / 'version').write_text('old')
        self.journal = self.root / 'private' / 'transaction.json'

    def tearDown(self):
        self.temp.cleanup()

    def test_publication_keeps_previous_tree_and_recovery_restores_it(self):
        candidate = self.root / 'app.candidate-test'
        candidate.mkdir()
        (candidate / 'version').write_text('new')
        ops.publish_tree(candidate, self.target, self.journal)
        self.assertEqual((self.target / 'version').read_text(), 'new')
        self.assertTrue(list(self.root.glob('app.previous-*')))
        self.assertEqual(ops.recover_publication(self.journal), 'Previous tree restored from publication journal')
        self.assertEqual((self.target / 'version').read_text(), 'old')
        self.assertTrue(self.journal.exists())
        ops.acknowledge_recovery(self.journal)
        self.assertFalse(self.journal.exists())

    def test_recovery_when_interrupted_after_first_rename(self):
        old = self.root / 'app.previous-test'
        self.target.rename(old)
        candidate = self.root / 'app.candidate-test'
        candidate.mkdir()
        (candidate / 'version').write_text('new')
        self.journal.parent.mkdir(mode=0o700)
        self.journal.write_text(json.dumps({'target': str(self.target), 'candidate': str(candidate), 'old': str(old), 'phase': 'old-renamed'}))
        self.journal.chmod(0o600)
        ops.recover_publication(self.journal)
        self.assertEqual((self.target / 'version').read_text(), 'old')

    def test_existing_journal_is_not_overwritten(self):
        candidate = self.root / 'app.candidate-test'
        candidate.mkdir()
        (candidate / 'version').write_text('new')
        self.journal.parent.mkdir(mode=0o700)
        self.journal.write_text('retain evidence')
        self.journal.chmod(0o600)
        with self.assertRaises(RuntimeError):
            ops.publish_tree(candidate, self.target, self.journal)
        self.assertEqual(self.journal.read_text(), 'retain evidence')
        self.assertEqual((self.target / 'version').read_text(), 'old')

    def test_journal_write_is_atomic_private_and_durable(self):
        record = {'target': str(self.target), 'candidate': str(self.root / 'app.candidate-x'),
                  'old': str(self.root / 'app.previous-x'), 'phase': 'prepared'}
        self.journal.parent.mkdir(mode=0o700)
        ops.write_journal(self.journal, record)
        self.assertEqual(json.loads(self.journal.read_text()), record)
        self.assertEqual(self.journal.stat().st_mode & 0o777, 0o600)
        self.assertFalse(list(self.journal.parent.glob('*.tmp-*')))

    def test_recovery_rejects_foreign_paths_and_no_old_state(self):
        candidate = self.root / 'app.candidate-test'
        candidate.mkdir()
        self.journal.parent.mkdir(mode=0o700)
        ops.write_journal(self.journal, {'target': str(self.target), 'candidate': str(candidate),
                                         'old': str(self.root / 'elsewhere'), 'phase': 'prepared'})
        with self.assertRaises(RuntimeError):
            ops.recover_publication(self.journal, expected_target=self.target)
        self.assertTrue(self.journal.exists())

    def test_publication_journal_write_failure_preserves_target(self):
        candidate = self.root / 'app.candidate-test'
        candidate.mkdir()
        (candidate / 'version').write_text('new')
        from unittest.mock import patch
        with patch.object(ops, 'write_journal', side_effect=OSError('injected journal failure')):
            with self.assertRaises(OSError):
                ops.publish_tree(candidate, self.target, self.journal)
        self.assertEqual((self.target / 'version').read_text(), 'old')
        self.assertFalse(self.journal.exists())

    def test_restore_candidate_is_complete_before_any_live_tree_change(self):
        source = self.root / 'source'
        (source / 'data/uploads').mkdir(parents=True)
        for name in ('backend', 'frontend', 'worker'):
            (source / name).mkdir()
        (source / 'backend/version.py').write_text('APP_VERSION = "2.1.0"\nRELEASE_VERSION = "0.2.4.18"\n')
        (source / 'requirements.txt').write_text('fixture requirements')
        (source / 'requirements-tested.txt').write_text('fixture pinned requirements\n')
        for name in ops.REQUIRED_ASSETS:
            (source / 'frontend' / name).write_text('fixture')
        (source / 'frontend/manifest.webmanifest').write_text('{"icons":[]}')
        (source / 'frontend/vendor').mkdir()
        (source / 'frontend/vendor/fixture.js').write_text('fixture')
        import sqlite3
        with sqlite3.connect(source / 'data/db.sqlite3') as db:
            db.execute('CREATE TABLE events (id INTEGER)')
        snapshot = ops.create_snapshot(source, self.root / 'backups', quiesced=True)
        candidate = self.root / 'app.candidate-restore'
        live = self.root / 'live'
        live.mkdir()
        (live / 'sentinel').write_text('untouched')
        (live / 'requirements.txt').write_text('fixture requirements')
        (live / 'requirements-tested.txt').write_text('fixture pinned requirements\n')
        (live / 'frontend').mkdir()
        runtime = self.root / 'runtime' / 'venv'
        import subprocess, sys
        subprocess.run([sys.executable, '-m', 'venv', '--copies', str(runtime)], check=True)
        ops.stage_restore(snapshot, live, candidate, runtime_path=runtime)
        self.assertTrue((candidate / 'data/db.sqlite3').is_file())
        self.assertEqual((live / 'sentinel').read_text(), 'untouched')

    def test_release_overlay_rejects_nested_symlink_before_target_publication(self):
        incoming = self.root / 'release'
        for name in ('backend', 'frontend', 'worker'):
            (incoming / name).mkdir(parents=True, exist_ok=True)
        (incoming / 'backend/unsafe').symlink_to(self.root / 'outside')
        candidate = self.root / 'app.candidate-release'
        candidate.mkdir()
        (candidate / 'version').write_text('old candidate')
        with self.assertRaises(ValueError):
            ops.overlay_release(incoming, candidate)
        self.assertEqual((candidate / 'version').read_text(), 'old candidate')

    def test_snapshot_rejects_manifest_symlink_and_ancestor_symlink(self):
        snap = self.root / 'snapshot'
        snap.mkdir()
        (snap / 'snapshot.json').symlink_to(self.root / 'missing')
        with self.assertRaises(ValueError):
            ops.verify_snapshot(snap)
        alias = self.root / 'alias'
        alias.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError):
            ops.restore_snapshot(snap, alias / 'restored')

    def test_validate_tree_rejects_dangling_symlink(self):
        (self.target / 'dangling').symlink_to(self.root / 'not-present')
        with self.assertRaises(ValueError):
            ops.validate_tree(self.target)

    def test_lock_is_exclusive(self):
        lock = self.root / 'lock'
        fd = ops.acquire_lock(lock)
        try:
            with self.assertRaises(RuntimeError):
                ops.acquire_lock(lock)
        finally:
            os.close(fd)

    def test_snapshot_retains_non_sidecar_data(self):
        source = self.root / 'source'
        (source / 'data/uploads').mkdir(parents=True)
        (source / 'backend').mkdir()
        (source / 'frontend').mkdir()
        (source / 'worker').mkdir()
        (source / 'data/notes.txt').write_text('preserve me')
        (source / 'data/db.sqlite3-wal').write_bytes(b'regenerable')
        import sqlite3
        with sqlite3.connect(source / 'data/db.sqlite3') as db:
            db.execute('CREATE TABLE events (id INTEGER)')
        snap = ops.create_snapshot(source, self.root / 'backups', quiesced=True)
        self.assertEqual((snap / 'data/notes.txt').read_text(), 'preserve me')
        self.assertFalse((snap / 'data/db.sqlite3-wal').exists())
        ops.verify_snapshot(snap)


if __name__ == '__main__':
    unittest.main()
