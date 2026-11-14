"""Exercise the actual staging verifier without root or production paths."""
from pathlib import Path
import hashlib
import json
import os
import shlex
import subprocess
import sys
import tempfile
import unittest
import zipfile

SCRIPT = Path(__file__).resolve().parents[1] / 'deploy/stage_release.sh'
VERIFY = SCRIPT.read_text().split("<<'PY'\n", 1)[1].split('\nPY\n', 1)[0]
VERSION = '0.2.4.19'
PREFIX = 'JagaKebond-' + VERSION + '/'


class StageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.addCleanup(self.temp.cleanup)
        self.app = self.root / 'app'
        self.releases = self.root / 'releases'
        self.app.mkdir(); self.releases.mkdir()
        self.ops = self.root / 'release_ops.py'
        self.ops.write_text('# synthetic canonical tool\n')
        for name in ('requirements.txt', 'requirements-tested.txt'):
            (self.app / name).write_text('# synthetic dependencies\n')
        self.files = {'app/backend/version.py': b'RELEASE_VERSION = "0.2.4.19"\n',
                      'app/deploy/release_ops.py': self.ops.read_bytes(),
                      **{'app/' + name: (self.app / name).read_bytes()
                         for name in ('requirements.txt', 'requirements-tested.txt')}}

    def run_stage(self, *, tamper=False, extra=None):
        archive = self.root / 'source.zip'
        manifest = {'files': {name: hashlib.sha256(data).hexdigest()
                              for name, data in self.files.items()}}
        with zipfile.ZipFile(archive, 'w') as out:
            for name, data in self.files.items():
                out.writestr(PREFIX + name, data + (b' ' if tamper else b''))
            out.writestr(PREFIX + 'SOURCE-SHA256.json', json.dumps(manifest))
            if extra:
                out.writestr(PREFIX + extra, b'unsafe')
        return subprocess.run([sys.executable, '-B', '-c', VERIFY, str(archive), VERSION,
                               str(self.releases), str(self.app), str(self.ops)],
                              capture_output=True, text=True)

    @unittest.skipIf(os.name == 'nt', 'POSIX staging launcher runs on the Linux release host')
    def test_launcher_executes_the_interpreter_inside_the_runtime_directory(self):
        runtime = self.root / 'runtime'; (runtime / 'bin').mkdir(parents=True)
        interpreter = runtime / 'bin/python'
        interpreter.write_text('#!/bin/sh\nprintf "synthetic-interpreter"\n')
        interpreter.chmod(0o755)
        self.ops.write_text('print(' + repr(str(runtime)) + ')\n')
        source = SCRIPT.read_text()
        start = source.index('RUNTIME=$(')
        header = source[start:source.index('case "$ACTION"', start)]
        header = header.replace('/usr/bin/python3', shlex.quote(sys.executable))
        run = subprocess.run(['bash', '-c', 'set -e; OPS=' + shlex.quote(str(self.ops)) +
                              '; APP=' + shlex.quote(str(self.app)) + '; ' + header + '\n"$PY"'],
                             capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(run.stdout, 'synthetic-interpreter')

    def test_valid_bundle_publishes_once(self):
        self.assertEqual(self.run_stage().returncode, 0)
        self.assertEqual((self.releases / VERSION / 'backend/version.py').read_bytes(),
                         self.files['app/backend/version.py'])
        self.assertNotEqual(self.run_stage().returncode, 0)

    def test_corrupt_bundle_and_unsafe_path_never_publish(self):
        self.assertNotEqual(self.run_stage(tamper=True).returncode, 0)
        self.assertNotEqual(self.run_stage(extra='../escape').returncode, 0)
        self.assertFalse((self.releases / VERSION).exists())
        self.assertFalse((self.root / 'escape').exists())

    def test_runtime_tool_and_version_mismatch_never_publish(self):
        for name, data in [('app/requirements.txt', b'changed'),
                           ('app/deploy/release_ops.py', b'changed'),
                           ('app/backend/version.py', b'RELEASE_VERSION = "0.0.0.0"\n')]:
            with self.subTest(name=name):
                previous = self.files[name]
                self.files[name] = data
                self.assertNotEqual(self.run_stage().returncode, 0)
                self.assertFalse((self.releases / VERSION).exists())
                self.files[name] = previous

    def test_private_runtime_state_is_not_publishable(self):
        self.files['app/.env'] = b'SYNTHETIC_FIXTURE=1'
        self.assertNotEqual(self.run_stage().returncode, 0)
        self.assertFalse((self.releases / VERSION).exists())


if __name__ == '__main__':
    unittest.main()
