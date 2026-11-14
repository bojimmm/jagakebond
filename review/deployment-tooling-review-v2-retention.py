"""Supplemental independent retention tests for the parent's added review focus."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('retention_guard', HERE / 'deployment-tooling-review-v2-tests.py')
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)
ops = guard.ops


class RetentionTests(guard.IndependentTests):
    def test_previous_tree_is_privately_retained_not_world_traversable(self):
        self.target.chmod(0o755)
        (self.target / 'backend/app.py').chmod(0o666)
        self.deploy(forensic_copy=False)
        old, = self.root.glob('app.previous-*')
        self.assertEqual(old.stat().st_mode & 0o077, 0,
                         'Raw old tree is not private; source retains original mutable mode')

    def test_failed_tree_containing_account_data_is_privately_retained(self):
        def permissions(tree):
            tree.chmod(0o755)
        with self.assertRaises(RuntimeError):
            self.deploy(apply_permissions=permissions,
                        readback=lambda p: (_ for _ in ()).throw(RuntimeError('readback fail')),
                        forensic_copy=False)
        failed, = self.root.glob('app.failed-*')
        self.assertEqual(failed.stat().st_mode & 0o077, 0,
                         'Failed tree remains traversable with original service-readable data')

    def test_modified_previous_code_rejected_before_recovery(self):
        candidate = self.root / 'app.candidate-test'
        candidate.mkdir()
        (candidate / 'marker').write_text('new')
        ops.publish_tree(candidate, self.target, self.journal)
        old, = self.root.glob('app.previous-*')
        (old / 'backend/app.py').write_text('LABEL = "tampered-retained-code"\n')
        with self.assertRaises((ValueError, RuntimeError)):
            ops.recover_publication(self.journal, expected_target=self.target)
        self.assertTrue(self.journal.exists())


if __name__ == '__main__':
    names = ['test_previous_tree_is_privately_retained_not_world_traversable',
             'test_failed_tree_containing_account_data_is_privately_retained',
             'test_modified_previous_code_rejected_before_recovery']
    suite = unittest.TestSuite(RetentionTests(name) for name in names)
    stream = io.StringIO()
    result = unittest.TextTestRunner(stream=stream, verbosity=2).run(suite)
    summary = {'tests_run': result.testsRun, 'failures': len(result.failures), 'errors': len(result.errors),
               'audit': dict(guard.AUDIT),
               'source_sha256': hashlib.sha256(guard.SCRIPT.read_bytes()).hexdigest()}
    (HERE / 'deployment-tooling-review-v2-retention.log').write_text(stream.getvalue())
    (HERE / 'deployment-tooling-review-v2-retention.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(stream.getvalue())
    print(json.dumps(summary))
    raise SystemExit(0 if result.wasSuccessful() else 1)
