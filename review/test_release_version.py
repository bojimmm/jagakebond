"""Validate release labels without building, packaging or importing production."""
from pathlib import Path
import importlib.util
import unittest
import argparse

path = Path(__file__).with_name('package_release.py')
spec = importlib.util.spec_from_file_location('package_release_fixture', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ReleaseVersionTest(unittest.TestCase):
    def test_accepts_original_and_requested_numeric_labels(self):
        for value in ['2.1.7', '0.2.1.7']:
            self.assertEqual(module.release_version(value), value)

    def test_rejects_unsafe_and_malformed_labels(self):
        for value in ['../0.2.1.7', '0.2.1.7/else', '0.2.1.7\n', 'v0.2.1.7', '0.2', '0.2.1.7.1', '', '-1.2.3']:
            with self.assertRaises(argparse.ArgumentTypeError, msg=value):
                module.release_version(value)


if __name__ == '__main__':
    unittest.main()
