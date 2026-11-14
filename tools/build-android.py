"""Build against a passing, unchanged regression inventory; retain each exit code."""
from pathlib import Path
from datetime import datetime, timezone
import argparse
import json
import os
import subprocess
from release_source import source_hashes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--regression', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    regression = json.loads(args.regression.read_text())
    if (regression['passed'] != regression['expected'] or regression['executed'] != 88
            or regression['failed'] or not regression['source_unchanged_during_tests']
            or source_hashes(root) != regression['source_hashes']):
        raise RuntimeError('Build requires a passing, unchanged 88-suite regression')
    args.out.mkdir(parents=True, exist_ok=False)
    commands = [('sync-assets', ['npm', 'run', 'sync-assets'], 'android-client'),
                ('cap-sync', ['npx', '--no-install', 'cap', 'sync', 'android'], 'android-client'),
                ('jvm', ['bash', './gradlew', '--no-daemon', '--max-workers=2', 'testDebugUnitTest'], 'android-client/android'),
                ('lint', ['bash', './gradlew', '--no-daemon', '--max-workers=2', 'lintDebug'], 'android-client/android'),
                ('release', ['bash', './gradlew', '--no-daemon', '--max-workers=2', 'assembleRelease'], 'android-client/android')]
    results = []
    for name, command, folder in commands:
        started = datetime.now(timezone.utc).isoformat()
        print(name, 'starting', flush=True)
        with (args.out / (name + '.log')).open('w') as log:
            run = subprocess.run(command, cwd=root / folder, stdout=log,
                                 stderr=subprocess.STDOUT, timeout=1800, env=os.environ)
        results.append({'name': name, 'exit_code': run.returncode, 'started': started,
                        'ended': datetime.now(timezone.utc).isoformat()})
        print(name, 'exit=' + str(run.returncode), flush=True)
        (args.out / 'BUILD-CHECKS.json').write_text(json.dumps({'checks': results,
            'source_hashes': source_hashes(root)}, indent=2) + '\n')
        if run.returncode:
            raise SystemExit(run.returncode)
    if source_hashes(root) != regression['source_hashes']:
        raise RuntimeError('Source changed during Android build')


if __name__ == '__main__':
    main()
