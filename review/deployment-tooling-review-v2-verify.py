"""Guarded review runner: default CLI plan plus the three supplied fixture suites."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import runpy
import sys
import unittest

REVIEW = Path(__file__).resolve().parent
APP = REVIEW.parent / 'app'
spec = importlib.util.spec_from_file_location('independent_v2', REVIEW / 'deployment-tooling-review-v2-tests.py')
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)
paths = [APP / 'deploy/release_ops.py', APP / 'tests/test_release_restore.py',
         APP / 'tests/test_release_transaction.py', APP / 'tests/test_release_orchestration.py',
         APP / 'deploy/README.md', APP / 'deploy/jagakebond.service',
         REVIEW / 'DEPLOYMENT-TOOLING-REVIEW.md']
hashes_before = {str(p.relative_to(REVIEW.parent)): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
plan_output = io.StringIO()
with contextlib.redirect_stdout(plan_output), guard.patch.object(sys, 'argv', [str(guard.SCRIPT), 'deploy']):
    runpy.run_path(str(guard.SCRIPT), run_name='__main__')
assert 'PLAN ONLY' in plan_output.getvalue()
assert all(value == 0 for value in guard.AUDIT.values())
# fd-relative cleanup names in supplied tempfile tests resolve harmlessly under
# TMPDIR, not staged app cwd. Tests import only their exact tooling file.
os.chdir(guard.TMP)
suite = unittest.TestSuite()
for filename in ('test_release_restore.py', 'test_release_transaction.py', 'test_release_orchestration.py'):
    test_spec = importlib.util.spec_from_file_location('supplied_' + filename[:-3], APP / 'tests' / filename)
    module = importlib.util.module_from_spec(test_spec)
    test_spec.loader.exec_module(module)
    suite.addTests(unittest.defaultTestLoader.loadTestsFromModule(module))
stream = io.StringIO()
result = unittest.TextTestRunner(stream=stream, verbosity=2).run(suite)
hashes_after = {str(p.relative_to(REVIEW.parent)): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
summary = {
    'plan_output': plan_output.getvalue().strip(),
    'tests_run': result.testsRun,
    'failures': len(result.failures),
    'errors': len(result.errors),
    'audit': dict(guard.AUDIT),
    'hashes_before': hashes_before,
    'hashes_unchanged': hashes_before == hashes_after,
    'scope': 'Default deploy CLI only; synthetic test transactions with injected callbacks; no CLI execute',
}
(REVIEW / 'deployment-tooling-review-v2-supplied.log').write_text(plan_output.getvalue() + stream.getvalue())
(REVIEW / 'deployment-tooling-review-v2-supplied.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary, indent=2))
assert result.wasSuccessful()
assert summary['hashes_unchanged']
assert all(value == 0 for value in guard.AUDIT.values())
