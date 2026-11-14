"""Isolated release policy tests. No application imports or host effects."""
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC=importlib.util.spec_from_file_location('release_policy',Path(__file__).resolve().parents[1]/'deploy/release_ops.py')
ops=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(ops)

class Policy(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(dir=os.environ['TMPDIR'],prefix='jk-policy-')
        self.root=Path(self.tmp.name);self.release=self.root/'release';self.current=self.root/'current'
        for tree in [self.release,self.current]:
            (tree/'backend').mkdir(parents=True);(tree/'worker').mkdir();(tree/'frontend/vendor').mkdir(parents=True)
            (tree/'backend/version.py').write_text('APP_VERSION="2.1.0"\nRELEASE_VERSION="0.2.4.18"\n')
            (tree/'requirements.txt').write_text('')
            (tree/'requirements-tested.txt').write_text('fixture pinned requirements\n')
            for name in ops.REQUIRED_ASSETS:(tree/'frontend'/name).write_text('')
            (tree/'frontend/index.html').write_text('<link href="styles.css"><script src="vendor/runtime.js"></script>')
            (tree/'frontend/vendor/runtime.js').write_text('void 0;')
            (tree/'frontend/styles.css').write_text('@font-face {src:url("vendor/font.woff")}')
            (tree/'frontend/vendor/font.woff').write_bytes(b'SYNTHETIC FONT FIXTURE')
            (tree/'frontend/sw.js').write_text("const SHELL_ASSETS = ['/index.html', '/offline-sync.js'];")
            (tree/'frontend/manifest.webmanifest').write_text('{"icons":[]}')
        self.runtime=self.root/'runtime';(self.runtime/'bin').mkdir(parents=True)
        python=self.runtime/'bin/python';python.write_text('SYNTHETIC EXECUTABLE FIXTURE');python.chmod(0o755)
    def tearDown(self):self.tmp.cleanup()
    def test_real_runtime_executes_without_an_application_link(self):
        import subprocess,sys
        runtime=self.root/'real-runtime'
        subprocess.run([sys.executable,'-m','venv','--copies','--without-pip',str(runtime)],check=True,capture_output=True,text=True)
        result=subprocess.run([str(runtime/'bin/python'),'-c','import sqlite3,sys;print(sys.prefix)'],check=True,capture_output=True,text=True)
        self.assertTrue(result.stdout.strip())
        self.assertEqual(Path(result.stdout.strip()).resolve(),runtime.resolve())
        self.assertEqual(ops.approved_runtime(runtime_path=runtime),runtime)
        self.assertFalse((self.current/'venv').exists())
    def test_dependency_check_generated_code_executes_without_application_imports(self):
        import subprocess,sys
        runtime=self.root/'dependency-runtime'
        subprocess.run([sys.executable,'-m','venv','--copies','--system-site-packages',str(runtime)],check=True,capture_output=True,text=True)
        (self.release/'requirements.txt').write_text('fastapi>=0.115\nuvicorn[standard]>=0.30\npython-multipart>=0.0.18\nhttpx>=0.27\npillow>=10.0\ncryptography>=42\n')
        calls=[]
        def fixture_runner(*args,cwd=None):
            self.assertEqual(args[:4],('runuser','-u','jagakebond','--'))
            calls.append(args)
            environment=os.environ.copy()
            fixture_sites=[p for p in sys.path if 'site-packages' in p and Path(p).is_dir()]
            if fixture_sites:
                environment['PYTHONPATH']=os.pathsep.join(fixture_sites+[environment.get('PYTHONPATH','')])
            subprocess.run(args[4:],cwd=cwd,check=True,capture_output=True,text=True,env=environment)
        ops.validate_installed_dependencies(self.release,fixture_runner,runtime_path=runtime)
        self.assertEqual(len(calls),2)
    def test_missing_html_dependency_fails(self):
        (self.release/'frontend/vendor/runtime.js').unlink()
        with self.assertRaises(ValueError):ops.validate_release_source(self.release)
    def test_missing_css_font_fails(self):
        (self.release/'frontend/vendor/font.woff').unlink()
        with self.assertRaises(ValueError):ops.validate_release_source(self.release)
    def test_cache_dependency_missing_fails(self):
        (self.release/'frontend/sw.js').write_text("const SHELL_ASSETS = ['/index.html','/vendor/missing.js'];")
        with self.assertRaises(ValueError):ops.validate_release_source(self.release)
    def test_traversing_local_asset_fails(self):
        (self.release/'frontend/index.html').write_text('<script src="../backend/version.py"></script>')
        with self.assertRaises(ValueError):ops.validate_release_source(self.release)
    def test_inventory_may_add_new_vendored_dependency(self):
        (self.release/'frontend/vendor/new.js').write_text('void 0;')
        ops.validate_release_source(self.release,self.current)
    def test_application_tree_rejects_embedded_runtime(self):
        (self.current/'venv/bin').mkdir(parents=True)
        p=self.current/'venv/bin/python';p.write_text('OLD SYNTHETIC EXECUTABLE');p.chmod(0o755)
        with self.assertRaisesRegex(ValueError,'must not contain a virtualenv'):
            ops.validate_tree(self.current)
        self.assertEqual(ops.approved_runtime(runtime_path=self.runtime),self.runtime)
        self.assertEqual(p.read_text(),'OLD SYNTHETIC EXECUTABLE')
    def test_runtime_symlink_is_rejected(self):
        linked=self.root/'linked-runtime';linked.symlink_to(self.runtime,target_is_directory=True)
        with self.assertRaises(ValueError):ops.approved_runtime(runtime_path=linked)
    def test_runtime_path_is_stable_for_identical_manifests_and_changes_when_manifest_changes(self):
        first=ops.runtime_path_for(self.current)
        self.assertEqual(first,ops.runtime_path_for(self.current))
        (self.current/'requirements-tested.txt').write_text('updated pin\n')
        self.assertNotEqual(first,ops.runtime_path_for(self.current))
    def test_release_directory_matches_release_version_not_api_protocol_version(self):
        releases=self.root/'releases';release=releases/'0.2.4.18'
        release.mkdir(parents=True)
        (release/'backend').mkdir()
        (release/'backend/version.py').write_text('APP_VERSION="2.1.0"\nRELEASE_VERSION="0.2.4.18"\n')
        (release/'backend/version.py').chmod(0o644)
        (release/'backend').chmod(0o755)
        release.chmod(0o755)
        wrong=releases/'2.1.0';wrong.mkdir();(wrong/'backend').mkdir()
        (wrong/'backend/version.py').write_text('APP_VERSION="2.1.0"\nRELEASE_VERSION="0.2.4.18"\n')
        with patch.object(ops,'RELEASES_ROOT',releases):
            self.assertEqual(ops.validate_release_location(release),release)
            with self.assertRaisesRegex(ValueError,'directory name'):
                ops.validate_release_location(wrong)
            release.chmod(0o775)
            with self.assertRaisesRegex(ValueError,'writable by group'):
                ops.validate_release_location(release)
    def test_cli_uses_release_folder_version_not_api_protocol_version(self):
        import shutil
        releases = self.root / 'releases'
        releases.mkdir()
        release = releases / '0.2.4.18'
        shutil.copytree(self.release, release)
        lock_file = self.root / 'release.lock'
        fd = os.open(lock_file, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            with (
                patch.object(ops, 'APP_ROOT', self.current),
                patch.object(ops, 'RELEASES_ROOT', releases),
                patch.object(ops, 'BACKUPS_ROOT', self.root / 'backups'),
                patch.object(ops, 'JOURNAL_PATH', self.root / 'journal'),
                patch.object(ops, 'LOCK_PATH', lock_file),
                patch.object(ops.os, 'geteuid', return_value=0),
                patch.object(ops, 'acquire_lock', return_value=fd),
                patch.object(ops, 'validate_tree'),
                patch.object(ops, 'validate_release_location', side_effect=lambda path: path),
                patch.object(ops, 'validate_service_configuration'),
                patch.object(ops, 'capacity_preflight'),
                patch.object(ops, 'deploy_transaction', return_value=self.root / 'snapshot') as deploy,
                patch.object(sys, 'argv', ['release_ops.py', 'deploy', '--release', str(release), '--execute']),
            ):
                ops.main()
            deploy.assert_called_once()
        finally:
            try:
                os.fstat(fd)
            except OSError:
                pass
            else:
                os.close(fd)
    def test_service_configuration_checks_api_and_both_workers(self):
        import subprocess
        app_root=self.root/'app-root'
        runtime_bin=str(self.runtime/'bin')
        env=str(app_root/'.env')
        data=str(app_root/'data')
        def show(args,**kwargs):
            service=args[2]
            if service==ops.APP_SERVICE:
                command=(f'{{ path={runtime_bin}/uvicorn ; argv[]={runtime_bin}/uvicorn backend.app:app '
                         '--host 127.0.0.1 --port 8010 --workers 1 --proxy-headers '
                         '--forwarded-allow-ips=127.0.0.1 }}')
                writable=data
            else:
                command=(f'{{ path={runtime_bin}/python ; argv[]={runtime_bin}/python '
                         '-u worker/gemini_worker.py }}')
                writable=''
            lane='WORKER_LANE=fast' if service==ops.FAST_WORKER_SERVICE else ''
            output=(f'User=jagakebond\nGroup=jagakebond\nWorkingDirectory={app_root}\n'
                    f'EnvironmentFiles={env} (ignore_errors=no)\nExecStart={command}\n'
                    f'ReadWritePaths={writable}\nEnvironment={lane}\n')
            return subprocess.CompletedProcess(args,0,output,'')
        with patch.object(ops.subprocess,'run',side_effect=show) as runner:
            ops.validate_service_configuration(app_root,self.runtime)
        self.assertEqual([call.args[0][2] for call in runner.call_args_list],list(ops.SERVICES))
    def test_service_configuration_rejects_fast_worker_on_old_root(self):
        import subprocess
        app_root=self.root/'app-root'
        runtime_bin=str(self.runtime/'bin')
        env=str(app_root/'.env')
        def show(args,**kwargs):
            service=args[2]
            working='/opt/jagakebond' if service==ops.FAST_WORKER_SERVICE else str(app_root)
            if service==ops.APP_SERVICE:
                command=(f'{{ path={runtime_bin}/uvicorn ; argv[]={runtime_bin}/uvicorn backend.app:app '
                         '--host 127.0.0.1 --port 8010 --workers 1 --proxy-headers '
                         '--forwarded-allow-ips=127.0.0.1 }}')
                writable=str(app_root/'data')
            else:
                command=(f'{{ path={runtime_bin}/python ; argv[]={runtime_bin}/python '
                         '-u worker/gemini_worker.py }}')
                writable=''
            lane='WORKER_LANE=fast' if service==ops.FAST_WORKER_SERVICE else ''
            output=(f'User=jagakebond\nGroup=jagakebond\nWorkingDirectory={working}\n'
                    f'EnvironmentFiles={env} (ignore_errors=no)\nExecStart={command}\n'
                    f'ReadWritePaths={writable}\nEnvironment={lane}\n')
            return subprocess.CompletedProcess(args,0,output,'')
        with patch.object(ops.subprocess,'run',side_effect=show):
            with self.assertRaisesRegex(RuntimeError,ops.FAST_WORKER_SERVICE):
                ops.validate_service_configuration(app_root,self.runtime)
    def test_capacity_checks_backup_and_target_mounts(self):
        backups=self.root/'backups'
        calls=[]
        with patch.object(ops,'capacity_preflight',side_effect=lambda path,size,**kw:calls.append((Path(path),size))):
            ops.transaction_capacity(self.current,self.release,backups)
        self.assertIn(self.current.parent,[p for p,s in calls]);self.assertIn(backups.parent,[p for p,s in calls])
        self.assertTrue(all(s>0 for p,s in calls))
    def test_capacity_failure_precedes_transaction_copy(self):
        with patch.object(ops,'transaction_capacity',side_effect=RuntimeError('capacity fixture')),patch.object(ops,'copy_tree') as copy:
            with self.assertRaisesRegex(RuntimeError,'capacity fixture'):
                ops.deploy_transaction(self.current,self.release,self.root/'backups',self.root/'journal',runtime_path=self.runtime)
            copy.assert_not_called()
    def test_readback_hashes_additional_vendor_assets(self):
        observed=[]
        def fake(url,**kw):
            observed.append(url)
            if url.endswith('/api/health'):return io.BytesIO(b'{"ok":true,"version":"2.1.0"}')
            return io.BytesIO((self.release/'frontend'/url.split('8010/',1)[1]).read_bytes())
        with patch.object(ops.urllib.request,'urlopen',side_effect=fake):ops.check_served_assets(self.release)
        self.assertTrue(any(u.endswith('/vendor/runtime.js')for u in observed))
        self.assertTrue(any(u.endswith('/vendor/font.woff')for u in observed))
    def test_rollback_readback_uses_restored_source_version(self):
        (self.release/'backend/version.py').write_text('APP_VERSION="2.0.0"')
        def fake(url,**kw):
            if url.endswith('/api/health'):return io.BytesIO(b'{"ok":true,"version":"2.0.0"}')
            return io.BytesIO((self.release/'frontend'/url.split('8010/',1)[1]).read_bytes())
        with patch.object(ops.urllib.request,'urlopen',side_effect=fake),patch.object(ops.time,'sleep'):
            ops.check_served_assets(self.release)
    def test_legacy_fastapi_version_can_be_verified_on_rollback(self):
        (self.release/'backend/version.py').unlink()
        (self.release/'backend/app.py').write_text('app = FastAPI(version="2.0")')
        self.assertEqual(ops.source_version(self.release),'2.0')
    def test_old_tree_is_private_after_publication(self):
        candidate=self.root/'current.candidate-test';candidate.mkdir();(candidate/'new.txt').write_text('fixture')
        journal=self.root/'private/journal.json';ops.publish_tree(candidate,self.current,journal)
        old=Path(json.loads(journal.read_text())['old'])
        self.assertEqual(old.stat().st_mode&0o777,0o700)
    def test_failed_tree_is_private_after_recovery(self):
        candidate=self.root/'current.candidate-test';candidate.mkdir();(candidate/'new.txt').write_text('fixture')
        journal=self.root/'private/journal.json';ops.publish_tree(candidate,self.current,journal);ops.recover_publication(journal,expected_target=self.current)
        self.assertTrue(journal.exists());failed=list(self.root.glob('current.failed-*'))
        self.assertEqual(len(failed),1);self.assertEqual(failed[0].stat().st_mode&0o777,0o700)
if __name__=='__main__':unittest.main()
