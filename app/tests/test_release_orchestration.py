"""End-to-end transaction fault tests using disposable trees and fixture SQLite."""
import importlib.util
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'deploy' / 'release_ops.py'
spec = importlib.util.spec_from_file_location('release_ops_orchestration', SCRIPT)
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)


class OrchestrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ['TMPDIR'], prefix='jk-orchestration-')
        self.root = Path(self.tmp.name)
        self.target = self.root / 'app'
        self.incoming = self.root / 'incoming'
        self.backups = self.root / 'backups'
        self.journal = self.root / 'private' / 'journal.json'
        self.make_tree(self.target, 'old', 'old-data')
        self.make_tree(self.incoming, 'new', None, release=True)
        self.runtime = self.root / 'approved-runtime' / 'venv'
        self.runtime.parent.mkdir()
        subprocess.run([sys.executable, '-m', 'venv', '--copies', str(self.runtime)], check=True)
        self.calls = []

    def tearDown(self):
        self.tmp.cleanup()

    def test_all_writers_stop_before_snapshot_and_start_in_dependency_order(self):
        calls=[]
        events=[]
        states={service:'active' for service in ops.SERVICES}
        def run(*args,**kwargs):
            calls.append(args)
            events.append(args)
            if args[1] == 'stop': states[args[2]] = 'inactive'
            if args[1] == 'start': states[args[2]] = 'active'
        def state(args, **kwargs):
            value = states[args[2]]
            return subprocess.CompletedProcess(args,0,value+'\n','')
        with patch.object(ops,'run',side_effect=run),patch.object(ops.subprocess,'run',side_effect=state), \
                patch.object(ops,'wait_for_api',side_effect=lambda:events.append(('api-ready',))):
            ops.stop_services()
            ops.start_services()
        self.assertEqual(calls[:len(ops.STOP_ORDER)],[
            ('systemctl','stop',ops.FAST_WORKER_SERVICE),
            ('systemctl','stop',ops.NORMAL_WORKER_SERVICE),
            ('systemctl','stop',ops.APP_SERVICE),
        ])
        self.assertEqual(calls[len(ops.STOP_ORDER):],[
            ('systemctl','start',ops.APP_SERVICE),
            ('systemctl','start',ops.NORMAL_WORKER_SERVICE),
            ('systemctl','start',ops.FAST_WORKER_SERVICE),
        ])
        self.assertLess(events.index(('api-ready',)),events.index(('systemctl','start',ops.NORMAL_WORKER_SERVICE)))

    def make_tree(self, root, version, value, release=False):
        for name in ('backend', 'frontend', 'worker'):
            (root / name).mkdir(parents=True, exist_ok=True)
        (root / 'backend/app.py').write_text(version)
        (root / 'backend/version.py').write_text('APP_VERSION = "2.1.0"\nRELEASE_VERSION = "0.2.4.18"\n')
        (root / 'frontend/index.html').write_text(version)
        for name in ops.REQUIRED_ASSETS:
            (root / 'frontend' / name).write_text('fixture ' + name)
        (root / 'frontend/manifest.webmanifest').write_text('{"icons":[]}')
        (root / 'frontend/vendor').mkdir(exist_ok=True)
        (root / 'frontend/vendor/fixture.js').write_text('fixture vendor')
        (root / 'worker/task.py').write_text('VALUE = 1\n')
        (root / 'requirements.txt').write_text('fixture requirements')
        (root / 'requirements-tested.txt').write_text('fixture pinned requirements\n')
        if release:
            return
        (root / 'data/uploads').mkdir(parents=True, exist_ok=True)
        (root / 'data/uploads/f.jpg').write_bytes(b'jpeg fixture')
        with sqlite3.connect(root / 'data/db.sqlite3') as db:
            db.execute('CREATE TABLE photos(id TEXT, file_name TEXT)')
            db.execute('CREATE TABLE values_table(value TEXT)')
            db.execute('INSERT INTO photos VALUES(?, ?)', ('fixture', 'f.jpg'))
            db.execute('INSERT INTO values_table VALUES(?)', (value,))

    def setup_effects(self, fail=None):
        def stop():
            self.calls.append('stop')
            if fail == 'stop': raise RuntimeError('stop injected')
        def start():
            self.calls.append('start')
            if fail == 'start':
                # Fail only the first start; recovery restart must still be attempted.
                if self.calls.count('start') == 1: raise RuntimeError('start injected')
        def permission(path):
            self.calls.append('permissions')
            if fail == 'permissions' and self.calls.count('permissions') == 1:
                raise RuntimeError('permissions injected')
        def run_command(*args, **kwargs):
            self.calls.append('migration')
            if fail == 'migration': raise RuntimeError('migration injected')
        def readback(path):
            self.calls.append('readback')
            if fail == 'readback' and self.calls.count('readback') == 1:
                raise RuntimeError('readback injected')
        return dict(service_stop=stop, service_start=start, apply_permissions=permission,
                    readback=readback, run_command=run_command,
                    dependency_check=lambda candidate, runner: None, runtime_path=self.runtime)

    def value(self, root):
        with sqlite3.connect(root / 'data/db.sqlite3') as db:
            return db.execute('SELECT value FROM values_table').fetchone()[0]

    def test_source_ast_version_assets_and_dependency_fail_before_stop(self):
        for change in ('syntax', 'version', 'asset', 'dependency', 'runtime-manifest'):
            with self.subTest(change=change):
                self.calls = []
                if change == 'syntax':
                    (self.incoming / 'backend/app.py').write_text('def broken(:\n')
                elif change == 'version':
                    (self.incoming / 'backend/version.py').write_text('APP_VERSION = "2.0.0"\n')
                elif change == 'asset':
                    (self.incoming / 'frontend/offline-sync.js').unlink()
                elif change == 'runtime-manifest':
                    (self.incoming / 'requirements-tested.txt').write_text('different runtime pin\n')
                effects = self.setup_effects()
                if change == 'dependency':
                    effects['dependency_check'] = lambda candidate, runner: (_ for _ in ()).throw(RuntimeError('dependency mismatch'))
                with self.assertRaises((ValueError, RuntimeError)):
                    ops.deploy_transaction(self.target, self.incoming, self.backups, self.journal,
                                           forensic_copy=False, **effects)
                self.assertNotIn('stop', self.calls)
                if change == 'syntax': (self.incoming / 'backend/app.py').write_text('new')
                if change == 'version': (self.incoming / 'backend/version.py').write_text('APP_VERSION = "2.1.0"\n')
                if change == 'asset': (self.incoming / 'frontend/offline-sync.js').write_text('fixture offline-sync.js')
                if change == 'runtime-manifest': (self.incoming / 'requirements-tested.txt').write_text('fixture pinned requirements\n')

    def test_restore_dependency_manifest_mismatch_fails_before_candidate_or_stop(self):
        snapshot = ops.create_snapshot(self.target, self.backups, quiesced=True)
        (self.target / 'requirements.txt').write_text('changed runtime requirements')
        candidate = self.root / 'app.candidate-restore'
        with self.assertRaisesRegex(ValueError, 'requirements differ'):
            ops.stage_restore(snapshot, self.target, candidate, runtime_path=self.runtime)
        self.assertFalse(candidate.exists())
        self.assertNotIn('stop', self.calls)

    def test_deploy_success_preserves_old_complete_snapshot_and_publishes_new_code(self):
        snap = ops.deploy_transaction(self.target, self.incoming, self.backups, self.journal,
                                      **self.setup_effects())
        self.assertEqual((self.target / 'backend/app.py').read_text(), 'new')
        self.assertEqual(self.value(self.target), 'old-data')
        self.assertEqual(self.value(snap), 'old-data')
        self.assertTrue((snap / 'data/uploads/f.jpg').is_file())
        self.assertFalse(self.journal.exists())
        self.assertEqual(self.calls, ['permissions', 'stop', 'permissions', 'migration', 'start', 'readback'])

    def test_staged_data_copy_failure_restarts_services_and_preserves_old_state(self):
        real_copy = ops.copy_tree
        def fail_snapshot_data_copy(source, destination, exclude=None):
            if Path(source).parent.name.startswith('jk-') and Path(source).name == 'data':
                raise OSError('staged data copy injected')
            return real_copy(source, destination, exclude)
        with patch.object(ops, 'copy_tree', side_effect=fail_snapshot_data_copy):
            with self.assertRaises(OSError):
                ops.deploy_transaction(self.target, self.incoming, self.backups, self.journal,
                                       forensic_copy=False, **self.setup_effects())
        self.assertEqual((self.target / 'backend/app.py').read_text(), 'old')
        self.assertEqual(self.value(self.target), 'old-data')
        self.assertIn('start', self.calls)

    def test_deploy_failures_restart_services_and_keep_old_tree(self):
        for fault in ('stop', 'snapshot', 'permissions', 'staged-code-copy', 'migration', 'start'):
            with self.subTest(fault=fault):
                target = self.root / ('failure-' + fault) / 'app'
                incoming = self.root / ('failure-' + fault) / 'incoming'
                backups = self.root / ('failure-' + fault) / 'backups'
                journal = self.root / ('failure-' + fault) / 'private' / 'journal.json'
                self.make_tree(target, 'old', 'old-data')
                self.make_tree(incoming, 'new', None, release=True)
                self.calls = []
                effects = self.setup_effects(fault if fault in {'stop','permissions','migration','start'} else None)
                if fault == 'snapshot':
                    ctx = patch.object(ops, 'create_snapshot', side_effect=RuntimeError('snapshot injected'))
                elif fault == 'staged-code-copy':
                    ctx = patch.object(ops, 'overlay_release', side_effect=RuntimeError('copy injected'))
                else:
                    ctx = patch.object(ops, 'create_snapshot', wraps=ops.create_snapshot)
                if fault in {'snapshot','staged-code-copy'}:
                    with ctx:
                        with self.assertRaises(RuntimeError):
                            ops.deploy_transaction(target, incoming, backups, journal,
                                                   forensic_copy=False, **effects)
                else:
                    with self.assertRaises(RuntimeError):
                        ops.deploy_transaction(target, incoming, backups, journal,
                                               forensic_copy=False, **effects)
                self.assertEqual((target / 'backend/app.py').read_text(), 'old')
                self.assertEqual(self.value(target), 'old-data')
                if fault == 'snapshot': self.assertIn('start', self.calls)
                if fault == 'migration': self.assertIn('start', self.calls)

    def test_post_publication_readback_failure_restores_old_tree(self):
        with self.assertRaises(RuntimeError):
            ops.deploy_transaction(self.target, self.incoming, self.backups, self.journal,
                                   forensic_copy=False, **self.setup_effects('readback'))
        self.assertEqual((self.target / 'backend/app.py').read_text(), 'old')
        self.assertEqual(self.value(self.target), 'old-data')
        self.assertFalse(self.journal.exists())
        self.assertGreaterEqual(self.calls.count('start'), 2)

    def test_optional_forensic_copy_failure_does_not_block_recovery(self):
        real_copy = ops.copy_tree
        def copy_with_forensic_failure(src, dst, exclude=None):
            if Path(dst).name == 'tree': raise OSError('forensic injected')
            return real_copy(src, dst, exclude)
        with patch.object(ops, 'copy_tree', side_effect=copy_with_forensic_failure):
            with self.assertRaises(RuntimeError):
                ops.deploy_transaction(self.target, self.incoming, self.backups, self.journal,
                                       **self.setup_effects('readback'))
        self.assertEqual((self.target / 'backend/app.py').read_text(), 'old')
        self.assertGreaterEqual(self.calls.count('start'), 2)

    def test_restore_success_and_postpublication_recovery(self):
        snap = ops.create_snapshot(self.target, self.backups, quiesced=True)
        (self.target / 'backend/app.py').write_text('changed')
        with self.assertRaises(RuntimeError):
            ops.restore_transaction(self.target, snap, self.backups, self.journal,
                                    forensic_copy=False, **self.setup_effects('readback'))
        self.assertEqual((self.target / 'backend/app.py').read_text(), 'changed')
        self.assertEqual(self.value(self.target), 'old-data')
        self.assertGreaterEqual(self.calls.count('start'), 2)

    def test_existing_journal_refuses_before_stopping_services(self):
        self.journal.parent.mkdir(mode=0o700)
        self.journal.write_text('preserve')
        effects = self.setup_effects()
        restore_effects = effects
        for operation in (lambda: ops.deploy_transaction(self.target,self.incoming,self.backups,self.journal,**effects),
                          lambda: ops.restore_transaction(self.target,self.root/'missing',self.backups,self.journal,**restore_effects)):
            with self.assertRaises(RuntimeError): operation()
        self.assertEqual(self.calls, [])
        self.assertEqual(self.journal.read_text(), 'preserve')

    def test_recovery_is_idempotent_at_prepared_oldrenamed_and_published(self):
        for phase in ('prepared','old-renamed','published'):
            with self.subTest(phase=phase):
                target = self.root / ('tree-' + phase)
                target.mkdir()
                (target/'version').write_text('old')
                candidate = target.with_name(target.name + '.candidate-x')
                candidate.mkdir(); (candidate/'version').write_text('new')
                old = target.with_name(target.name + '.previous-x')
                if phase in ('old-renamed','published'): target.rename(old)
                if phase == 'published': candidate.rename(target)
                journal = self.root / ('journal-' + phase)
                record = {'target':str(target),'candidate':str(candidate),'old':str(old),'phase':phase}
                ops.write_journal(journal, record)
                ops.recover_publication(journal, expected_target=target)
                self.assertEqual((target/'version').read_text(), 'old')
                self.assertTrue(journal.exists())

    def test_guarded_recovery_acknowledges_only_after_readback(self):
        candidate=self.target.with_name('app.candidate-recovery')
        candidate.mkdir();(candidate/'version').write_text('new')
        ops.publish_tree(candidate,self.target,self.journal)
        sequence=[]
        with patch.object(ops,'stop_services',side_effect=lambda:sequence.append('stop')), \
                patch.object(ops,'permissions',side_effect=lambda path:sequence.append('permissions')), \
                patch.object(ops,'start_services',side_effect=lambda:sequence.append('start')), \
                patch.object(ops,'check_served_assets',side_effect=lambda path:sequence.append('readback')):
            message=ops.recover_transaction(self.target,self.journal)
        self.assertEqual(message,'Previous tree restored from publication journal')
        self.assertEqual(sequence,['stop','permissions','start','readback'])
        self.assertEqual((self.target/'backend/app.py').read_text(),'old')
        self.assertFalse(self.journal.exists())

    def test_guarded_recovery_preserves_journal_when_readback_fails(self):
        candidate=self.target.with_name('app.candidate-recovery-fail')
        candidate.mkdir();(candidate/'version').write_text('new')
        ops.publish_tree(candidate,self.target,self.journal)
        with patch.object(ops,'stop_services'),patch.object(ops,'permissions'), \
                patch.object(ops,'start_services'),patch.object(ops,'check_served_assets',side_effect=RuntimeError('readback fixture')):
            with self.assertRaisesRegex(RuntimeError,'readback fixture'):
                ops.recover_transaction(self.target,self.journal)
        self.assertTrue(self.journal.exists())
        self.assertEqual((self.target/'backend/app.py').read_text(),'old')

    def test_rename_faults_preserve_or_restore_previous_tree(self):
        for occurrence in (1, 2):
            with self.subTest(rename=occurrence):
                target = self.root / f'rename-{occurrence}'
                target.mkdir(); (target/'version').write_text('old')
                candidate = target.with_name(target.name+'.candidate-test')
                candidate.mkdir(); (candidate/'version').write_text('new')
                journal = self.root / f'rename-{occurrence}.journal'
                original = Path.rename
                count = {'n':0}
                def failing_rename(path, dst):
                    if path in (target,candidate):
                        count['n'] += 1
                        if count['n'] == occurrence: raise OSError('rename injected')
                    return original(path,dst)
                with patch.object(Path,'rename',failing_rename):
                    with self.assertRaises(OSError): ops.publish_tree(candidate,target,journal)
                if target.exists(): self.assertEqual((target/'version').read_text(),'old')
                else: self.assertTrue(list(self.root.glob(target.name+'.previous-*')))

    def test_restore_snapshot_is_real_sqlite_backup_and_validates_photo_reference(self):
        snapshot = ops.create_snapshot(self.target,self.backups,quiesced=True)
        self.assertEqual(self.value(snapshot),'old-data')
        self.assertEqual((snapshot/'data/uploads/f.jpg').read_bytes(),b'jpeg fixture')
        ops.verify_snapshot(snapshot)

    def test_shared_service_port_parser_and_capacity_and_lock_preflight(self):
        self.assertIn('SERVICE_PORT', ops.check_served_assets.__code__.co_names)
        self.assertEqual(ops.SERVICE_PORT, 8010)
        ops.capacity_preflight(self.root, 1)
        lock = self.root/'lock'
        fd=ops.acquire_lock(lock)
        try:
            with self.assertRaises(RuntimeError): ops.acquire_lock(lock)
        finally: os.close(fd)

    def test_failure_to_recover_reports_critical_and_leaves_journal(self):
        with patch.object(ops, 'publish_tree', side_effect=RuntimeError('publication injected')):
            effects = self.setup_effects()
            effects['service_stop'] = lambda: None
            effects['service_start'] = lambda: (_ for _ in ()).throw(RuntimeError('restart injected'))
            with self.assertRaisesRegex(RuntimeError, 'CRITICAL recovery incomplete'):
                ops.deploy_transaction(self.target,self.incoming,self.backups,self.journal,**effects)


if __name__ == '__main__':
    unittest.main()
