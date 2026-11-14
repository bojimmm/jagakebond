"""Independent desired-behavior tests. Only disposable fixtures; no host effects.

Run with the requested interpreter and -B. Red tests are acceptance failures,
not defect-reproduction tests presented as green. The audit hook rejects actual
production/staged data opens, subprocesses, and network connections.
"""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import runpy
import sqlite3
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

APP = Path(__file__).resolve().parents[1] / 'app'
REVIEW = Path(__file__).resolve().parent
SCRIPT = APP / 'deploy/release_ops.py'
TMP = Path(os.environ['TMPDIR']).absolute()
AUDIT = {'forbidden_file_attempts': 0, 'subprocess_attempts': 0, 'network_attempts': 0}
FIXTURE_CLEANUP = False


def audit(event, args):
    if event in {'subprocess.Popen', 'os.system', 'os.posix_spawn'}:
        AUDIT['subprocess_attempts'] += 1
        raise RuntimeError('Audit: subprocess forbidden')
    if event in {'socket.connect', 'socket.connect_ex', 'socket.bind'}:
        AUDIT['network_attempts'] += 1
        raise RuntimeError('Audit: network forbidden')
    if event in {'open', 'sqlite3.connect', 'os.listdir', 'os.scandir'} and args:
        value = args[0]
        if isinstance(value, (str, bytes, os.PathLike)):
            text = os.fsdecode(value)
            # shutil.rmtree uses fd-relative directory names; the open audit
            # event omits dir_fd. Do not resolve those names against app cwd.
            # This exemption is scoped exclusively to known fixture cleanup.
            if FIXTURE_CLEANUP and not Path(text).is_absolute():
                return
            # SQLite URI paths are forbidden when production-rooted too.
            p = Path(os.path.abspath(text.removeprefix('file:').split('?', 1)[0]))
            forbidden = (p == Path('/opt/jagakebond') or p.is_relative_to('/opt/jagakebond')
                         or p.is_relative_to('/var/backups/jagakebond')
                         or p.is_relative_to('/var/lib/jagakebond')
                         or p.is_relative_to(APP / 'data')
                         or (p.name == '.env' and not p.is_relative_to(TMP)))
            if forbidden:
                AUDIT['forbidden_file_attempts'] += 1
                raise RuntimeError('Audit: production or non-fixture secret access forbidden')


sys.addaudithook(audit)
spec = importlib.util.spec_from_file_location('independent_release_ops_v2', SCRIPT)
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)
ASSETS = ['app.js', 'styles.css', 'index.html', 'native-adapter.js',
          'offline-store.js', 'offline-sync.js']


class IndependentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=TMP, prefix='jk-independent-v2-')
        self.root = Path(self.tmp.name)
        self.target = self.root / 'app'
        self.incoming = self.root / 'incoming'
        self.backups = self.root / 'backups'
        self.journal = self.root / 'private/journal.json'
        self.calls = []
        self.make_tree(self.target, 'old', data=True)
        self.make_tree(self.incoming, 'new', data=False)

    def tearDown(self):
        global FIXTURE_CLEANUP
        self.assertTrue(self.root.is_relative_to(TMP))
        FIXTURE_CLEANUP = True
        try:
            self.tmp.cleanup()
        finally:
            FIXTURE_CLEANUP = False

    def make_tree(self, root, label, *, data):
        for name in ('backend', 'frontend', 'worker'):
            (root / name).mkdir(parents=True)
        (root / 'backend/app.py').write_text('LABEL = ' + repr(label) + '\n')
        (root / 'backend/version.py').write_text('APP_VERSION = "2.1.0"\n')
        (root / 'requirements.txt').write_text('fixture-package==1.0\n')
        for name in ASSETS + ['sw.js', 'manifest.webmanifest']:
            (root / 'frontend' / name).write_text(label + ':' + name)
        if data:
            (root / '.env').write_text('SYNTHETIC=fixture-only\n')
            (root / 'data/uploads').mkdir(parents=True)
            (root / 'data/uploads/old.jpg').write_bytes(b'fixture-photo')
            with sqlite3.connect(root / 'data/db.sqlite3') as db:
                db.execute('CREATE TABLE photos(id TEXT, file_name TEXT)')
                db.execute('CREATE TABLE events(value TEXT, account_id TEXT)')
                db.execute('INSERT INTO photos VALUES(?, ?)', ('old', 'old.jpg'))
                db.execute('INSERT INTO events VALUES(?, ?)', ('old-data', 'fixture-account-a'))

    def effects(self):
        return dict(service_stop=lambda: self.calls.append('stop'),
                    service_start=lambda: self.calls.append('start'),
                    apply_permissions=lambda p: self.calls.append('permissions'),
                    run_command=lambda *a, **k: self.calls.append('migration'),
                    readback=lambda p: self.calls.append('readback'))

    def deploy(self, **overrides):
        options = self.effects()
        options.update(overrides)
        return ops.deploy_transaction(self.target, self.incoming, self.backups,
                                      self.journal, **options)

    def restore(self, snapshot, **overrides):
        options = self.effects()
        options.pop('run_command')
        options.update(overrides)
        return ops.restore_transaction(self.target, snapshot, self.backups,
                                       self.journal, **options)

    def read_events(self, root):
        with sqlite3.connect(root / 'data/db.sqlite3') as db:
            return [r[0] for r in db.execute('SELECT value FROM events')]

    def test_default_plan_has_zero_host_side_effects(self):
        before = dict(AUDIT)
        stream = io.StringIO()
        with patch.object(sys, 'argv', [str(SCRIPT), 'deploy']), contextlib.redirect_stdout(stream):
            ops.main()
        self.assertIn('PLAN ONLY', stream.getvalue())
        self.assertEqual(AUDIT, before)

    def test_deploy_accepts_normal_interpreter_symlinks_without_losing_venv(self):
        venv = self.target / 'venv'
        (venv / 'bin').mkdir(parents=True)
        (venv / 'bin/python-real').write_text('synthetic executable; never run')
        (venv / 'bin/python-real').chmod(0o755)
        (venv / 'bin/python').symlink_to('python-real')
        self.deploy(forensic_copy=False)
        self.assertTrue((self.target / 'venv/bin/python').exists())
        self.assertIn('stop', self.calls)

    def test_deploy_copied_venv_remains_executable_and_account_traversable(self):
        venv = self.target / 'venv'
        (venv / 'bin').mkdir(parents=True)
        (venv / 'bin/python').write_text('fixture never executed')
        (venv / 'bin/python').chmod(0o755)
        account = types.SimpleNamespace(pw_uid=12345, pw_gid=12345)
        def permissions(candidate):
            with patch.object(ops.pwd, 'getpwnam', return_value=account), patch.object(ops.os, 'chown'):
                ops.permissions(candidate)
            observed = (bool((candidate / 'venv/bin/python').stat().st_mode & 0o111),
                        (candidate / 'venv/bin').stat().st_mode & 0o005)
            self.assertEqual(observed, (True, 0o005),
                             'Copied venv must retain executable bits and account traversal')
        self.deploy(apply_permissions=permissions, forensic_copy=False)

    def test_restore_rejects_untrusted_top_level_venv_symlink_before_copy(self):
        snapshot = ops.create_snapshot(self.target, self.backups, quiesced=True)
        outside = self.root / 'outside-venv'
        outside.mkdir()
        (outside / 'marker').write_text('outside')
        (self.target / 'venv').symlink_to(outside, target_is_directory=True)
        candidate = self.root / 'app.candidate-restore'
        with self.assertRaises(ValueError):
            ops.stage_restore(snapshot, self.target, candidate)
        self.assertFalse(candidate.exists())

    def test_missing_required_asset_rejected_before_stop(self):
        (self.incoming / 'frontend/offline-sync.js').unlink()
        with self.assertRaises(ValueError):
            self.deploy(forensic_copy=False)
        self.assertNotIn('stop', self.calls)

    def test_invalid_source_rejected_before_stop(self):
        (self.incoming / 'backend/app.py').write_text('def invalid(:\n')
        with self.assertRaises((ValueError, SyntaxError)):
            self.deploy(forensic_copy=False)
        self.assertNotIn('stop', self.calls)

    def test_wrong_release_version_rejected_before_stop(self):
        (self.incoming / 'backend/version.py').write_text('APP_VERSION = "2.0.0"\n')
        with self.assertRaises(ValueError):
            self.deploy(forensic_copy=False)
        self.assertNotIn('stop', self.calls)

    def test_restore_incompatible_dependency_manifest_rejected_before_stop(self):
        snapshot = ops.create_snapshot(self.target, self.backups, quiesced=True)
        (self.target / 'requirements.txt').write_text('fixture-package==9.0\n')
        with self.assertRaises(ValueError):
            self.restore(snapshot, forensic_copy=False)
        self.assertNotIn('stop', self.calls)

    def test_deploy_partial_stop_failure_attempts_restart(self):
        def stop():
            self.calls.append('stop')
            raise RuntimeError('worker stopped; web stop failed')
        with self.assertRaises(RuntimeError):
            self.deploy(service_stop=stop, forensic_copy=False)
        self.assertIn('start', self.calls)
        self.assertIn('old', (self.target / 'backend/app.py').read_text())

    def test_restore_partial_stop_failure_attempts_restart(self):
        snapshot = ops.create_snapshot(self.target, self.backups, quiesced=True)
        def stop():
            self.calls.append('stop')
            raise RuntimeError('worker stopped; web stop failed')
        with self.assertRaises(RuntimeError):
            self.restore(snapshot, service_stop=stop, forensic_copy=False)
        self.assertIn('start', self.calls)

    def test_failed_rollback_restart_retains_recovery_journal(self):
        def start():
            self.calls.append('start')
            if self.calls.count('start') == 2:
                raise RuntimeError('rollback restart failed')
        def readback(p):
            raise RuntimeError('readback failed')
        with self.assertRaisesRegex(RuntimeError, 'CRITICAL recovery incomplete'):
            self.deploy(service_start=start, readback=readback, forensic_copy=False)
        self.assertTrue(self.journal.exists(), 'Journal deleted before rollback restart succeeded')
        self.assertIn('old', (self.target / 'backend/app.py').read_text())

    def test_failed_rollback_permissions_retains_recovery_journal(self):
        def permissions(p):
            if p == self.target:
                raise RuntimeError('rollback permissions failed')
        with self.assertRaisesRegex(RuntimeError, 'CRITICAL recovery incomplete'):
            self.deploy(apply_permissions=permissions,
                        readback=lambda p: (_ for _ in ()).throw(RuntimeError('readback failed')),
                        forensic_copy=False)
        self.assertTrue(self.journal.exists(), 'Journal deleted before rollback permissions succeeded')

    def test_poststart_submissions_retained_in_failed_tree_on_rollback(self):
        def readback(p):
            (p / 'data/uploads/new.jpg').write_bytes(b'new fixture photo')
            with sqlite3.connect(p / 'data/db.sqlite3') as db:
                db.execute('INSERT INTO events VALUES(?, ?)', ('new-submission', 'fixture-account-a'))
                db.execute('INSERT INTO photos VALUES(?, ?)', ('new', 'new.jpg'))
            raise RuntimeError('readback failure after accepted submission')
        with self.assertRaises(RuntimeError):
            self.deploy(readback=readback, forensic_copy=False)
        failed = list(self.root.glob('app.failed-*'))
        self.assertEqual(len(failed), 1)
        self.assertIn('new-submission', self.read_events(failed[0]))
        with sqlite3.connect(failed[0] / 'data/db.sqlite3') as db:
            self.assertEqual(db.execute('SELECT account_id FROM events WHERE value=?',
                                       ('new-submission',)).fetchone()[0], 'fixture-account-a')
        self.assertEqual((failed[0] / 'data/uploads/new.jpg').read_bytes(), b'new fixture photo')
        ops.validate_database(failed[0] / 'data/db.sqlite3', failed[0] / 'data/uploads')
        self.assertEqual(self.read_events(self.target), ['old-data'])

    def test_optional_forensic_error_does_not_prevent_rollback(self):
        real_copy = ops.copy_tree
        def copy(source, dest, exclude=None):
            if dest.name == 'tree':
                raise OSError('optional forensic ENOSPC')
            return real_copy(source, dest, exclude)
        with patch.object(ops, 'copy_tree', side_effect=copy):
            with self.assertRaisesRegex(RuntimeError, 'readback failure'):
                self.deploy(readback=lambda p: (_ for _ in ()).throw(RuntimeError('readback failure')))
        self.assertIn('old', (self.target / 'backend/app.py').read_text())
        self.assertEqual(self.calls.count('start'), 2)

    def test_journal_update_failure_after_old_rename_is_recoverable(self):
        candidate = self.root / 'app.candidate-test'
        candidate.mkdir()
        (candidate / 'marker').write_text('new')
        real_write = ops.write_journal
        def write(path, record):
            if record['phase'] == 'old-renamed':
                raise OSError('phase update failure')
            return real_write(path, record)
        with patch.object(ops, 'write_journal', side_effect=write):
            with self.assertRaises(OSError):
                ops.publish_tree(candidate, self.target, self.journal)
        self.assertEqual(json.loads(self.journal.read_text())['phase'], 'prepared')
        ops.recover_publication(self.journal, expected_target=self.target)
        self.assertIn('old', (self.target / 'backend/app.py').read_text())

    def test_all_publication_phases_use_atomic_journal_replace(self):
        candidate = self.root / 'app.candidate-test'
        candidate.mkdir()
        records = []
        replaces = []
        real_write, real_replace = ops.write_journal, ops.os.replace
        def write(path, record):
            records.append(record['phase'])
            return real_write(path, record)
        def replace(src, dst):
            replaces.append((src, dst))
            return real_replace(src, dst)
        with patch.object(ops, 'write_journal', side_effect=write), patch.object(ops.os, 'replace', side_effect=replace):
            ops.publish_tree(candidate, self.target, self.journal)
        self.assertEqual(records, ['prepared', 'old-renamed', 'published'])
        self.assertEqual(len(replaces), 3)
        self.assertTrue(all(dst == self.journal for _, dst in replaces))

    def test_snapshot_syncs_intermediate_data_directory(self):
        seen = []
        real_sync = ops.sync_dir
        def sync(path):
            seen.append(path)
            real_sync(path)
        with patch.object(ops, 'sync_dir', side_effect=sync):
            ops.create_snapshot(self.target, self.backups, quiesced=True)
        self.assertTrue(any(p.name == 'data' and p.parent.name.endswith('.partial') for p in seen))

    def test_snapshot_retains_extra_operator_data(self):
        (self.target / 'data/db.json').write_text('{"synthetic": true}')
        (self.target / 'data/notes.txt').write_text('retain')
        snap = ops.create_snapshot(self.target, self.backups, quiesced=True)
        self.assertEqual((snap / 'data/notes.txt').read_text(), 'retain')
        self.assertTrue((snap / 'data/db.json').is_file())
        ops.verify_snapshot(snap)

    def test_database_symlink_rejected_before_backup_creation(self):
        realdb = self.target / 'data/db.sqlite3'
        outside = self.root / 'outside.sqlite3'
        realdb.rename(outside)
        realdb.symlink_to(outside)
        with self.assertRaises(ValueError):
            ops.create_snapshot(self.target, self.backups, quiesced=True)
        self.assertFalse(self.backups.exists())

    def test_dangling_snapshot_directory_symlink_rejected(self):
        snap = ops.create_snapshot(self.target, self.backups, quiesced=True)
        (snap / 'dangling-dir').symlink_to(self.root / 'missing', target_is_directory=True)
        with self.assertRaises(ValueError):
            ops.verify_snapshot(snap)

    def test_account_specific_permissions_without_real_chown(self):
        account = types.SimpleNamespace(pw_uid=12345, pw_gid=12345)
        with patch.object(ops.pwd, 'getpwnam', return_value=account) as lookup, patch.object(ops.os, 'chown') as chown:
            ops.permissions(self.target)
        lookup.assert_called_once_with('jagakebond')
        self.assertEqual((self.target / '.env').stat().st_mode & 0o777, 0o640)
        self.assertEqual((self.target / 'data').stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.target / 'data/db.sqlite3').stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.target / 'backend').stat().st_mode & 0o777, 0o755)
        self.assertEqual((self.target / 'backend/app.py').stat().st_mode & 0o777, 0o644)
        self.assertIn(unittest.mock.call(self.target / 'data/db.sqlite3', 12345, 12345), chown.call_args_list)
        self.assertIn(unittest.mock.call(self.target / 'backend/app.py', 0, 12345), chown.call_args_list)

    def test_lock_contention_fails_without_service_effects(self):
        fd = ops.acquire_lock(self.root / 'lock')
        try:
            with self.assertRaises(RuntimeError):
                ops.acquire_lock(self.root / 'lock')
        finally:
            os.close(fd)
        self.assertEqual(self.calls, [])

    def test_capacity_rejects_insufficient_bytes_and_inodes(self):
        for bytes_available, inodes_available in ((0, 1000), (1000000, 0)):
            stats = types.SimpleNamespace(f_bavail=bytes_available, f_frsize=1, f_favail=inodes_available)
            with patch.object(ops.os, 'statvfs', return_value=stats):
                with self.assertRaises(RuntimeError):
                    ops.capacity_preflight(self.root, 1)
        self.assertEqual(self.calls, [])

    def url_responder(self, *, health_version='2.1.0', bad_sw=False, seen=None):
        def respond(url, timeout=None):
            if seen is not None:
                seen.append(url)
            if url.endswith('/api/health'):
                payload = json.dumps({'ok': True, 'version': health_version}).encode()
            else:
                name = url.rsplit('/', 1)[-1]
                payload = (self.target / 'frontend' / name).read_bytes()
                if bad_sw and name == 'sw.js':
                    payload = b'wrong service worker'
            return io.BytesIO(payload)
        return respond

    def test_readback_rejects_wrong_health_version(self):
        with patch.object(ops.urllib.request, 'urlopen', side_effect=self.url_responder(health_version='2.0.0')), patch.object(ops.time, 'sleep'):
            with self.assertRaises(RuntimeError):
                ops.check_served_assets(self.target)

    def test_readback_verifies_service_worker_not_just_six_assets(self):
        with patch.object(ops.urllib.request, 'urlopen', side_effect=self.url_responder(bad_sw=True)), patch.object(ops.time, 'sleep'):
            with self.assertRaises(RuntimeError):
                ops.check_served_assets(self.target)

    def test_readback_uses_named_service_port_without_network(self):
        seen = []
        with patch.object(ops.urllib.request, 'urlopen', side_effect=self.url_responder(seen=seen)):
            ops.check_served_assets(self.target)
        self.assertTrue(seen)
        self.assertTrue(all(url.startswith('http://127.0.0.1:8010/') for url in seen))
        self.assertIn('--port 8010', (APP / 'deploy/jagakebond.service').read_text())

    def test_named_service_configuration_checks_correct_unit_without_host_call(self):
        result = types.SimpleNamespace(stdout='User=jagakebond\nWorkingDirectory=/opt/jagakebond\nExecStart=uvicorn backend.app:app --host 127.0.0.1 --port 8010\n')
        with patch.object(ops.subprocess, 'run', return_value=result) as mocked:
            ops.validate_service_configuration()
        self.assertEqual(mocked.call_args.args[0],
                         ['systemctl', 'show', 'jagakebond.service', '--property=User,WorkingDirectory,ExecStart'])

    def test_service_port_prefix_is_not_accepted_as_exact_8010(self):
        result = types.SimpleNamespace(stdout='User=jagakebond\nWorkingDirectory=/opt/jagakebond\nExecStart=uvicorn backend.app:app --host 127.0.0.1 --port 80100\n')
        with patch.object(ops.subprocess, 'run', return_value=result):
            with self.assertRaises(RuntimeError):
                ops.validate_service_configuration()


if __name__ == '__main__':
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(IndependentTests)
    stream = io.StringIO()
    result = unittest.TextTestRunner(stream=stream, verbosity=2).run(suite)
    log = stream.getvalue()
    summary = {
        'source_sha256': hashlib.sha256(SCRIPT.read_bytes()).hexdigest(),
        'tests_run': result.testsRun,
        'passed': result.testsRun - len({t.id() for t, _ in result.failures + result.errors}),
        'failures': [{'test': t.id(), 'traceback': detail} for t, detail in result.failures],
        'errors': [{'test': t.id(), 'traceback': detail} for t, detail in result.errors],
        'audit': AUDIT,
        'scope': 'synthetic fixture-only; callbacks mocked; no CLI execute',
    }
    (REVIEW / 'deployment-tooling-review-v2-results.json').write_text(json.dumps(summary, indent=2) + '\n')
    (REVIEW / 'deployment-tooling-review-v2-tests.log').write_text(log)
    print(log)
    print(json.dumps({k: summary[k] for k in ('source_sha256', 'tests_run', 'passed', 'audit')}))
    sys.exit(0 if result.wasSuccessful() else 1)
