"""Verify and package the frozen 2.1.7 private test candidate, never deploy it."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'deliverables/jagakebond-2.1.7'
PYTHON = '/opt/jagakebond/venv/bin/python'
TOOLS = Path('/home/ubuntu/.hermes/profiles/jimops/cache/scratch/android-sdk/build-tools/36.0.0')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path, value):
    if path.exists():
        path.read_bytes()
    path.write_text(json.dumps(value, indent=2) + '\n')


def run(args, cwd=ROOT):
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE='1')
    p = subprocess.run(args, cwd=cwd, env=env, capture_output=True, text=True, timeout=180)
    if p.returncode:
        raise RuntimeError(f'Command failed: {args}: {p.stdout[-1800:]} {p.stderr[-1800:]}')
    return p.stdout + p.stderr


def main():
    checks = json.loads((ROOT / 'review/final-evidence-217/results.json').read_text())['checks']
    assert len(checks) == 33 and all(x['exit_code'] == 0 for x in checks)
    ui = json.loads((ROOT / 'review/final-evidence-217/ui-parent-results.json').read_text())
    ui_checks = ui if isinstance(ui, list) else ui['checks']
    assert len(ui_checks) == 31 and all(x['ok'] is True for x in ui_checks)
    report_paths = ['backend-217-review.json', 'ui-217-corrected-review.json', 'layout-217-final-review.json']
    for name in report_paths:
        review = json.loads((ROOT / 'review/parent-independent' / name).read_text())
        assert type(review['passed']) is bool and review['passed'] is True
        for field in ['security_concerns', 'logic_errors']:
            assert isinstance(review[field], list) and not review[field]
    layout = json.loads((ROOT / 'review/parent-independent/layout-217-final-review.json').read_text())
    differences = [name for name, expected in layout['reviewed_sha256'].items() if sha(ROOT / name) != expected]
    assert differences == ['review/browser-tools/ui-217-parent.cjs'], differences
    final_hashes = {name: sha(ROOT / name) for name in layout['reviewed_sha256']}
    readback = {
        'passed': True, 'security_concerns': [], 'logic_errors': [],
        'reviewed_sha256': final_hashes,
        'independent_reports': report_paths,
        'post_review_changes': {
            'review/browser-tools/ui-217-parent.cjs':
                'Screenshot setup only: wait for real Leaflet zoom/pan completion and fit the fixture plot. '
                'No assertions removed; targeted final test rerun 31/31. Application sources unchanged.'},
        'scope': 'Parent readback, not an additional independent review. Original FAIL/corrective reports preserved.',
        'limitations': ['Synthetic media/API/map-tile fixtures; no physical device, live inference or deployment.']}
    save(ROOT / 'review/parent-independent/parent-217-final-readback.json', readback)

    apk = OUT / 'jagakebond-2.1.7-debug.apk'
    shutil.copy2(ROOT / 'android-client/android/app/build/outputs/apk/debug/app-debug.apk', apk)
    aapt = run([str(TOOLS / 'aapt'), 'dump', 'badging', str(apk)])
    signature = run([str(TOOLS / 'apksigner'), 'verify', '--verbose', '--print-certs', str(apk)])
    for name, text in [('aapt.txt', aapt), ('apksigner.txt', signature)]:
        p = OUT / name
        if p.exists():
            p.read_bytes()
        p.write_text(text)
    assert "name='jagake.bond.app'" in aapt and "versionCode='9'" in aapt and "versionName='2.1.7'" in aapt
    old = ROOT / 'deliverables/jagakebond-2.1.6/jagakebond-2.1.6-debug.apk'
    previous = run([str(TOOLS / 'apksigner'), 'verify', '--print-certs', str(old)])
    cert = lambda text: next(x for x in text.splitlines() if 'certificate SHA-256 digest:' in x)
    assert cert(previous) == cert(signature)
    assets = {}
    with zipfile.ZipFile(apk) as z:
        for p in sorted((ROOT / 'app/frontend').rglob('*')):
            if p.is_file() and p.name not in {'admin.html', 'sw.js'}:
                name = 'assets/public/' + p.relative_to(ROOT / 'app/frontend').as_posix()
                assert z.read(name) == p.read_bytes(), name
                assets[name] = sha(p)
    assert len(assets) == 57
    roots = [ET.parse(p).getroot() for p in (ROOT / 'android-client/android/app/build/test-results/testDebugUnitTest').glob('TEST-*.xml')]
    jvm = {key: sum(int(x.get(key, 0)) for x in roots) for key in ['tests', 'failures', 'errors', 'skipped']}
    assert jvm == {'tests': 33, 'failures': 0, 'errors': 0, 'skipped': 0}
    lint_path = ROOT / 'android-client/android/app/build/reports/lint-results-debug.xml'
    issues = ET.parse(lint_path).getroot().findall('issue')
    lint_errors = [x.get('id') for x in issues if x.get('severity') in {'Error', 'Fatal'}]
    assert not lint_errors, lint_errors
    artifact = {'version': '2.1.7', 'versionCode': 9, 'apk_sha256': sha(apk), 'apk_bytes': apk.stat().st_size,
                'same_certificate_as_2_1_6': True, 'frontend_asset_matches': len(assets), 'jvm': jvm,
                'lint_errors': lint_errors, 'lint_warnings': sum(x.get('severity') == 'Warning' for x in issues),
                'asset_manifest': assets}
    save(OUT / 'ARTIFACT-CHECKS.json', artifact)
    verification = {k: v for k, v in artifact.items() if k != 'asset_manifest'}
    verification.update({'captured_utc': datetime.now(timezone.utc).isoformat(), 'suite_count': len(checks),
                         'suite_failures': 0, 'focused_ui_checks': len(ui_checks), 'focused_ui_failures': 0,
                         'independent_review_readback': 'review/parent-independent/parent-217-final-readback.json',
                         'final_source_sha256': final_hashes, 'status': 'limited-owner-supervised-private-test-candidate',
                         'production_deployed': False, 'physical_device_validated': False,
                         'real_inference_validated': False, 'manual_200_percent_zoom_validated': False})
    save(OUT / 'VERIFICATION.json', verification)
    print(run([PYTHON, 'review/package_release.py', '--version', '2.1.7']))
    archive = OUT / 'jagakebond-2.1.7-source.zip'
    extraction = {'archive_sha256': sha(archive), 'manifest_files_verified': 0, 'tests': []}
    with zipfile.ZipFile(archive) as z:
        prefix = 'JagaKebond-2.1.7/'
        assert z.testzip() is None
        assert all(n.startswith(prefix) and '..' not in Path(n).parts and not Path(n).is_absolute() for n in z.namelist())
        manifest = json.loads(z.read(prefix + 'SOURCE-SHA256.json'))['files']
        for name, expected in manifest.items():
            assert hashlib.sha256(z.read(prefix + name)).hexdigest() == expected, name
            if name.startswith(('app/', 'android-client/')):
                assert sha(ROOT / name) == expected, name
        extraction['manifest_files_verified'] = len(manifest)
        required = ['app/frontend/daily-log.js', 'app/frontend/farm-membership.js', 'app/frontend/styles.css',
                    'android-client/android/gradlew', 'android-client/android/gradle/wrapper/gradle-wrapper.jar',
                    'review/feature-217-contract.md', 'review/finalize_217.py']
        assert all(name in manifest for name in required)
        with tempfile.TemporaryDirectory(prefix='jk217-extracted-') as tmp:
            z.extractall(tmp)
            tree = Path(tmp) / 'JagaKebond-2.1.7'
            commands = [[PYTHON, 'app/tests/test_telemetry_217.py'], [PYTHON, 'app/tests/test_history_media_216.py'],
                        ['node', 'app/tests/daily-log.test.cjs'], ['node', 'app/tests/farm-membership.test.cjs']]
            for args in commands:
                output = run(args, cwd=tree)
                extraction['tests'].append({'command': args, 'exit_code': 0, 'output': output[-1800:]})
    save(OUT / 'SOURCE-EXTRACTION-TESTS.json', extraction)
    old_doc = (ROOT / 'deliverables/jagakebond-2.1.6/SERVER-UPGRADE.md').read_text()
    old_sha = sha(ROOT / 'deliverables/jagakebond-2.1.6/jagakebond-2.1.6-source.zip')
    doc = old_doc.replace('2.1.6', '2.1.7').replace(old_sha, sha(archive))
    doc = doc.replace('cmp "$REL/frontend/offline-store.js" /opt/jagakebond/frontend/offline-store.js',
                      'cmp "$REL/frontend/offline-store.js" /opt/jagakebond/frontend/offline-store.js\n'
                      'for f in app.js index.html styles.css daily-log.js farm-membership.js sw.js vendor/tailwind.generated.css; do\n'
                      '  cmp "$REL/frontend/$f" "/opt/jagakebond/frontend/$f"\n'
                      'done')
    doc += '\n2.1.7 additionally requires real UI checks from HANDOVER.md: plot crop list/bolder boundary, '
    doc += 'location editing, dot-only GPS, current telemetry/name search, yesterday-only daily log and camera switching. '
    doc += 'Open-Meteo name search is not coordinate reverse geocoding; configured geocode.maps.co fallback remains. '
    doc += 'No production operation in this procedure was executed by the release finalizer.\n'
    target = OUT / 'SERVER-UPGRADE.md'
    if target.exists():
        target.read_bytes()
    target.write_text(doc)
    checksum_files = [p for p in OUT.iterdir() if p.is_file() and p.name != 'SHA256SUMS.txt']
    sums = OUT / 'SHA256SUMS.txt'
    sums.read_bytes()
    sums.write_text(''.join(sha(p) + '  ' + p.name + '\n' for p in sorted(checksum_files)))
    print(json.dumps({'apk_sha256': sha(apk), 'archive_sha256': sha(archive), 'manifest_files': len(manifest),
                      'extracted_test_commands_passed': len(extraction['tests']), 'suites': len(checks),
                      'ui_checks': len(ui_checks), 'jvm': jvm, 'assets': len(assets),
                      'production_deployed': False}, indent=2))


if __name__ == '__main__':
    main()
