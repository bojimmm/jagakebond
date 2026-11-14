"""Repackage the reviewed 2.1.7 candidate as 0.2.1.7; no deployment."""
from pathlib import Path
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[1]
OLD = ROOT / 'deliverables/jagakebond-2.1.7'
OUT = ROOT / 'deliverables/jagakebond-0.2.1.7'
PYTHON = '/opt/jagakebond/venv/bin/python'
TOOLS = Path('/home/ubuntu/.hermes/profiles/jimops/cache/scratch/android-sdk/build-tools/36.0.0')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path, content):
    if path.exists():
        path.read_bytes()
    path.write_text(content)


def save(path, content):
    write(path, json.dumps(content, indent=2) + '\n')


def run(args, cwd=ROOT):
    p = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=120,
                       env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'})
    if p.returncode:
        raise RuntimeError(f'{args}: {p.stdout[-2000:]} {p.stderr[-2000:]}')
    return p.stdout + p.stderr


def main():
    OUT.mkdir(exist_ok=True, parents=True)
    changed = []
    with zipfile.ZipFile(OLD / 'jagakebond-2.1.7-source.zip') as z:
        prefix = 'JagaKebond-2.1.7/'
        manifest = json.loads(z.read(prefix + 'SOURCE-SHA256.json'))['files']
        for name, expected in manifest.items():
            if name.startswith(('app/', 'android-client/')) and sha(ROOT / name) != expected:
                changed.append(name)
        assert changed == ['android-client/android/app/build.gradle'], changed
        before = z.read(prefix + changed[0]).decode()
        expected = before.replace('versionCode 9', 'versionCode 10').replace('versionName "2.1.7"', 'versionName "0.2.1.7"')
        assert (ROOT / changed[0]).read_text() == expected
    for name in ['HANDOVER.md', 'BUILD.md']:
        text = (OLD / name).read_text().replace('2.1.7', '0.2.1.7')
        text = text.replace('versionCode 9', 'versionCode 10').replace('versionCode 9', 'versionCode 10')
        text += ('\n## Version-label correction\n\n'
                 'This candidate supersedes the previously labelled 2.1.7 APK. '
                 'Only Android versionName (0.2.1.7) and versionCode (10) changed; '
                 'application ID, signer, backend protocol 2.1.0, schema 8 and feature behavior are unchanged. '
                 'Internal npm tooling retains its existing three-part package version; the four-part label is Android/release identity, not an npm SemVer claim. '
                 'The original feature-suite/browser evidence is inherited by exact implementation hash comparison, not described as a new 33-suite run. '
                 'Gradle tests/lint/assembly and version-parser tests were executed again for this label. '
                 'Use review/relabel_0217.py for the current rebuild/package checks; finalize_217.py is a historical helper for the original label. '
                 'The source archive contains historical reports with their original names. '
                 'No production change or phone validation was performed.\n')
        write(OUT / name, text)
    apk = OUT / 'jagakebond-0.2.1.7-debug.apk'
    shutil.copy2(ROOT / 'android-client/android/app/build/outputs/apk/debug/app-debug.apk', apk)
    aapt = run([str(TOOLS / 'aapt'), 'dump', 'badging', str(apk)])
    sig = run([str(TOOLS / 'apksigner'), 'verify', '--verbose', '--print-certs', str(apk)])
    write(OUT / 'aapt.txt', aapt)
    write(OUT / 'apksigner.txt', sig)
    assert "name='jagake.bond.app'" in aapt and "versionCode='10'" in aapt and "versionName='0.2.1.7'" in aapt
    cert = lambda text: next(x for x in text.splitlines() if 'certificate SHA-256 digest:' in x)
    assert cert(sig) == cert((OLD / 'apksigner.txt').read_text())
    assets = {}
    with zipfile.ZipFile(apk) as z, zipfile.ZipFile(OLD / 'jagakebond-2.1.7-debug.apk') as previous:
        for p in sorted((ROOT / 'app/frontend').rglob('*')):
            if p.is_file() and p.name not in {'admin.html', 'sw.js'}:
                name = 'assets/public/' + p.relative_to(ROOT / 'app/frontend').as_posix()
                assert z.read(name) == previous.read(name) == p.read_bytes(), name
                assets[name] = sha(p)
    assert len(assets) == 57
    roots = [ET.parse(p).getroot() for p in (ROOT / 'android-client/android/app/build/test-results/testDebugUnitTest').glob('TEST-*.xml')]
    jvm = {k: sum(int(x.get(k, 0)) for x in roots) for k in ['tests', 'failures', 'errors', 'skipped']}
    assert jvm == {'tests': 33, 'failures': 0, 'errors': 0, 'skipped': 0}
    issues = ET.parse(ROOT / 'android-client/android/app/build/reports/lint-results-debug.xml').getroot().findall('issue')
    assert not [x for x in issues if x.get('severity') in {'Error', 'Fatal'}]
    parser_tests = run([PYTHON, 'review/test_release_version.py'])
    old_checks = json.loads((OLD / 'VERIFICATION.json').read_text())
    for name, expected in old_checks['final_source_sha256'].items():
        assert sha(ROOT / name) == expected, name
    artifact = {'version': '0.2.1.7', 'versionCode': 10, 'package': 'jagake.bond.app',
                'apk_sha256': sha(apk), 'apk_bytes': apk.stat().st_size,
                'same_certificate_as_2_1_7': True, 'frontend_asset_matches': len(assets),
                'jvm': jvm, 'lint_errors': 0,
                'lint_warnings': sum(x.get('severity') == 'Warning' for x in issues), 'asset_manifest': assets}
    save(OUT / 'ARTIFACT-CHECKS.json', artifact)
    verify = {k: v for k, v in artifact.items() if k != 'asset_manifest'}
    verify.update({'scope': 'Version metadata only; limited private test candidate, not production release',
                   'backend_protocol': '2.1.0', 'schema': 8, 'changed_application_files': changed,
                   'old_feature_evidence': {'source': '2.1.7', 'suites_passed': 33, 'focused_ui_passed': 31,
                                            'status': 'Inherited by unchanged implementation fingerprints; not rerun'},
                   'version_parser_tests': parser_tests, 'gradle': 'testDebugUnitTest lintDebug assembleDebug PASS',
                   'production_modified': False, 'physical_device_validated': False})
    save(OUT / 'VERIFICATION.json', verify)
    print(run([PYTHON, 'review/package_release.py', '--version', '0.2.1.7']))
    archive = OUT / 'jagakebond-0.2.1.7-source.zip'
    extraction = {'archive_sha256': sha(archive), 'checks': []}
    with zipfile.ZipFile(archive) as z:
        prefix = 'JagaKebond-0.2.1.7/'
        assert z.testzip() is None
        manifest = json.loads(z.read(prefix + 'SOURCE-SHA256.json'))['files']
        for name, expected in manifest.items():
            assert hashlib.sha256(z.read(prefix + name)).hexdigest() == expected, name
            if name.startswith(('app/', 'android-client/')):
                assert sha(ROOT / name) == expected, name
        extraction['manifest_files_verified'] = len(manifest)
        assert all(n.startswith(prefix) and '..' not in Path(n).parts for n in z.namelist())
        with tempfile.TemporaryDirectory(prefix='jk0217-version-') as tmp:
            z.extractall(tmp)
            tree = Path(tmp) / 'JagaKebond-0.2.1.7'
            for args in [[PYTHON, 'review/test_release_version.py'],
                         [PYTHON, 'app/tests/test_telemetry_217.py'],
                         ['node', 'app/tests/daily-log.test.cjs']]:
                extraction['checks'].append({'command': args, 'exit_code': 0, 'output': run(args, tree)[-1600:]})
    save(OUT / 'SOURCE-EXTRACTION-TESTS.json', extraction)
    doc = (OLD / 'SERVER-UPGRADE.md').read_text().replace('2.1.7', '0.2.1.7')
    doc = doc.replace(sha(OLD / 'jagakebond-2.1.7-source.zip'), sha(archive))
    doc += ('\nVersion relabel only: backend feature sources are byte-identical to the previous 2.1.7 bundle. '
            'If that exact source was already deployed and verified, do not redeploy solely to change the APK label. '
            'Compatibility version remains 2.1.0; schema remains 8. '
            'The new label does not establish a deployment or expand production authorization.\n')
    blocks = re.findall(r'```bash\n(.*?)```', doc, re.S)
    syntax = subprocess.run(['bash', '-n'], input='\n'.join(blocks), capture_output=True, text=True, check=True)
    assert 'EXPECTED=' + sha(archive) in doc
    write(OUT / 'SERVER-UPGRADE.md', doc)
    write(OUT / 'SHA256SUMS.txt', ''.join(sha(p) + '  ' + p.name + '\n' for p in sorted(OUT.iterdir())
                                        if p.is_file() and p.name != 'SHA256SUMS.txt'))
    print(json.dumps({'version': '0.2.1.7', 'versionCode': 10, 'apk_sha256': sha(apk),
                      'source_sha256': sha(archive), 'jvm': jvm, 'assets': len(assets),
                      'extracted_commands_passed': len(extraction['checks']), 'production_modified': False}, indent=2))


if __name__ == '__main__':
    main()
