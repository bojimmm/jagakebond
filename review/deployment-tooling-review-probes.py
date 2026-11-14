"""Read-only tooling review probes. All real filesystem I/O uses synthetic temp trees.

These tests document current behavior (including bugs), not desired acceptance.
CLI --execute control flow is exercised ONLY with service/mutation helpers mocked.
No application imports, production reads, network access, or service operations.
"""
import argparse
from contextlib import ExitStack
import hashlib
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
import sqlite3
import tempfile
import unittest
from unittest.mock import Mock, patch

SCRIPT = Path(__file__).resolve().parents[1] / 'app/deploy/release_ops.py'
spec = importlib.util.spec_from_file_location('review_release_ops', SCRIPT)
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)


class ReviewProbes(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ['TMPDIR'], prefix='jk-independent-review-')
        self.root = Path(self.temp.name)
        self.app = self.root / 'app'
        for name in ['backend', 'frontend', 'worker', 'data/uploads']:
            (self.app / name).mkdir(parents=True)
        (self.app / 'backend/app.py').write_text('version=1\n')
        (self.app / 'requirements.txt').write_text('synthetic-only\n')
        (self.app / '.env').write_text('SYNTHETIC=fixture-only\n')
        (self.app / 'data/uploads/photo.jpg').write_bytes(b'synthetic-photo')
        with sqlite3.connect(self.app / 'data/db.sqlite3') as c:
            c.execute('CREATE TABLE photos(file_name TEXT)')
            c.execute("INSERT INTO photos VALUES('photo.jpg')")
        self.backups = self.root / 'backups'

    def tearDown(self):
        self.temp.cleanup()

    def snapshot(self):
        return ops.create_snapshot(self.app, self.backups, quiesced=True)

    def cli_mocks(self, action):
        args = SimpleNamespace(action=action, release=self.root / 'release',
                               snapshot=self.root / 'supplied-snapshot',
                               target=Path('/opt/jagakebond'), backups=self.backups,
                               execute=True, confirm_data_restore=True)
        args.release.mkdir()
        (args.release / 'requirements.txt').write_text('synthetic-only\n')
        stack = ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.object(argparse.ArgumentParser, 'parse_args', return_value=args))
        stack.enter_context(patch.object(ops.os, 'geteuid', return_value=0))
        real_resolve = Path.resolve
        def fixture_resolve(path, *a, **k):
            if str(path) == '/opt/jagakebond':
                return path  # Sentinel only; never inspect production symlinks/metadata.
            return real_resolve(path, *a, **k)
        stack.enter_context(patch.object(Path, 'resolve', fixture_resolve))
        mocks = {}
        for name in ['digest', 'stop_services', 'start_services', 'create_snapshot',
                     'verify_snapshot', 'replace_code', 'permissions', 'run',
                     'check_served_assets', 'copy_tree']:
            mocks[name] = stack.enter_context(patch.object(ops, name))
        mocks['digest'].return_value = 'synthetic-digest'
        mocks['create_snapshot'].return_value = self.root / 'retained-snapshot'
        mocks['rmtree'] = stack.enter_context(patch.object(ops.shutil, 'rmtree'))
        stack.enter_context(patch.object(ops.subprocess, 'run', side_effect=AssertionError('Real subprocess forbidden')))
        stack.enter_context(patch.object(ops.urllib.request, 'urlopen', side_effect=AssertionError('Network forbidden')))
        return mocks

    def test_restore_snapshot_failure_leaves_services_stopped(self):
        mocks = self.cli_mocks('restore')
        mocks['create_snapshot'].side_effect = OSError('synthetic snapshot failure')
        with self.assertRaisesRegex(OSError, 'synthetic snapshot failure'):
            ops.main()
        mocks['stop_services'].assert_called_once()
        mocks['start_services'].assert_not_called()
        mocks['replace_code'].assert_not_called()

    def test_restore_copy_failure_has_no_recovery(self):
        mocks = self.cli_mocks('restore')
        mocks['copy_tree'].side_effect = OSError('synthetic data copy failure')
        with self.assertRaisesRegex(OSError, 'synthetic data copy failure'):
            ops.main()
        mocks['replace_code'].assert_called_once()
        mocks['rmtree'].assert_called_once_with(Path('/opt/jagakebond/data'))
        mocks['start_services'].assert_not_called()
        mocks['create_snapshot'].assert_called_once()

    def test_deploy_forensic_copy_failure_blocks_rollback(self):
        mocks = self.cli_mocks('deploy')
        self.backups.mkdir()
        mocks['replace_code'].side_effect = OSError('synthetic deployment failure')
        mocks['copy_tree'].side_effect = OSError('synthetic forensic copy failure')
        with self.assertRaisesRegex(OSError, 'synthetic forensic copy failure'):
            ops.main()
        self.assertEqual(mocks['stop_services'].call_count, 2)
        mocks['verify_snapshot'].assert_not_called()
        mocks['start_services'].assert_not_called()
        self.assertEqual(mocks['replace_code'].call_count, 1)

    def test_deploy_snapshot_failure_restarts_old_services(self):
        mocks = self.cli_mocks('deploy')
        mocks['create_snapshot'].side_effect = OSError('synthetic snapshot failure')
        with self.assertRaisesRegex(OSError, 'synthetic snapshot failure'):
            ops.main()
        mocks['start_services'].assert_called_once()
        mocks['replace_code'].assert_not_called()

    def test_incomplete_release_detected_only_after_service_stop(self):
        mocks = self.cli_mocks('deploy')
        calls = []
        mocks['stop_services'].side_effect = lambda: calls.append('stop')
        mocks['create_snapshot'].side_effect = lambda *a, **k: (calls.append('snapshot') or self.root / 'retained')
        mocks['replace_code'].side_effect = lambda *a, **k: calls.append('replace')
        ops.main()
        self.assertEqual(calls, ['stop', 'snapshot', 'replace'])
        # The synthetic release has no backend/frontend/worker; main did not preflight them.

    def test_replace_code_late_symlink_failure_deletes_old_code(self):
        incoming = self.root / 'incoming'
        for name in ['backend', 'frontend', 'worker']:
            (incoming / name).mkdir(parents=True)
        (incoming / 'backend/new.py').write_text('version=2\n')
        (incoming / 'frontend/late-link').symlink_to(self.root / 'outside')
        with self.assertRaisesRegex(ValueError, 'Symlinks'):
            ops.replace_code(incoming, self.app)
        self.assertFalse((self.app / 'backend/app.py').exists())
        self.assertTrue((self.app / 'data/db.sqlite3').exists())
        self.assertTrue((self.app / '.env').exists())

    def test_source_database_symlink_followed(self):
        external = self.root / 'outside.sqlite3'
        (self.app / 'data/db.sqlite3').rename(external)
        (self.app / 'data/db.sqlite3').symlink_to(external)
        snap = self.snapshot()
        ops.verify_snapshot(snap)
        self.assertFalse((snap / 'data/db.sqlite3').is_symlink())

    def test_restore_target_symlink_ancestor_followed(self):
        snap = self.snapshot()
        outside = self.root / 'outside'
        outside.mkdir()
        alias = self.root / 'alias'
        alias.symlink_to(outside, target_is_directory=True)
        ops.restore_snapshot(snap, alias / 'restored')
        self.assertTrue((outside / 'restored/data/db.sqlite3').is_file())

    def test_verify_accepts_directory_symlink_then_restore_is_partial(self):
        snap = self.snapshot()
        (snap / 'code/frontend/empty-link').symlink_to(self.root / 'nonexistent', target_is_directory=True)
        ops.verify_snapshot(snap)
        dest = self.root / 'restored'
        with self.assertRaisesRegex(ValueError, 'Symlinks'):
            ops.restore_snapshot(snap, dest)
        self.assertTrue(dest.exists())

    def test_snapshot_manifest_symlink_accepted(self):
        snap = self.snapshot()
        external = self.root / 'external-manifest.json'
        (snap / 'snapshot.json').rename(external)
        (snap / 'snapshot.json').symlink_to(external)
        ops.verify_snapshot(snap)

    def test_extra_data_not_retained_by_snapshot(self):
        (self.app / 'data/db.json').write_text('{"synthetic":true}\n')
        (self.app / 'data/operator-notes.txt').write_text('synthetic-only\n')
        snap = self.snapshot()
        dest = self.root / 'restored'
        ops.restore_snapshot(snap, dest)
        self.assertFalse((dest / 'data/db.json').exists())
        self.assertFalse((dest / 'data/operator-notes.txt').exists())

    def test_snapshot_data_directory_not_fsynced_after_database_creation(self):
        calls = []
        real = ops.sync_dir
        with patch.object(ops, 'sync_dir', side_effect=lambda p: (calls.append(p), real(p))[1]):
            snap = self.snapshot()
        self.assertFalse(any(p.name == 'data' for p in calls))
        self.assertTrue(any(p.name.endswith('.partial') for p in calls))
        self.assertTrue(any(p == self.backups for p in calls))
        ops.verify_snapshot(snap)

    def test_snapshot_private_boundary_modes(self):
        snap = self.snapshot()
        self.assertEqual(self.backups.stat().st_mode & 0o777, 0o700)
        self.assertEqual(snap.stat().st_mode & 0o777, 0o700)
        self.assertEqual((snap / 'code/.env').stat().st_mode & 0o777, 0o600)
        self.assertEqual((snap / 'snapshot.json').stat().st_mode & 0o777, 0o600)

    def test_asset_readback_port_not_matching_shipped_unit(self):
        unit = SCRIPT.parent / 'jagakebond.service'
        self.assertIn('--port 8000', unit.read_text())
        urls = []
        def fail(url, **kwargs):
            urls.append(url)
            raise OSError('synthetic readback failure')
        with patch.object(ops.urllib.request, 'urlopen', side_effect=fail), patch.object(ops.time, 'sleep'):
            with self.assertRaisesRegex(RuntimeError, 'readback failed'):
                ops.check_served_assets(self.app)
        self.assertTrue(urls)
        self.assertTrue(all(url == 'http://127.0.0.1:8010/api/health' for url in urls))


if __name__ == '__main__':
    print('Reviewed release_ops.py SHA256:', hashlib.sha256(SCRIPT.read_bytes()).hexdigest(), flush=True)
    unittest.main(verbosity=2)
