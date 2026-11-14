"""Verify the exact tested source and signed APK, then publish an immutable folder."""
from pathlib import Path
import argparse
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
import zipfile
from release_source import source_files, source_hashes

VERSION = '0.2.4.28'
CODE = 56


def sha(data):
    return hashlib.sha256(data).hexdigest()


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def certificate(text):
    match = re.search(r'Signer #1 certificate SHA-256 digest: (\S+)', text)
    require(match is not None, 'APK signer digest is missing')
    return match[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--regression', required=True, type=Path)
    parser.add_argument('--android-evidence', required=True, type=Path)
    parser.add_argument('--sdk-build-tools', required=True, type=Path)
    parser.add_argument('--expected-signer-sha256', required=True,
                    help='Adopted release certificate SHA-256 digest')
    parser.add_argument('--reference-apk', type=Path,
                    help='Prior installed APK, recorded for the delivery note only')
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    regression = json.loads(args.regression.read_text())
    require(regression['expected'] == regression['executed'] == regression['passed'] == 88
            and not regression['failed'] and regression['source_unchanged_during_tests'],
            'Fresh complete regression is required')
    hashes = source_hashes(root)
    require(hashes == regression['source_hashes'], 'Source differs from regression inventory')
    build = json.loads((args.android_evidence / 'BUILD-CHECKS.json').read_text())
    require([row['name'] for row in build['checks']] == ['sync-assets', 'cap-sync', 'jvm', 'lint', 'release']
            and all(row['exit_code'] == 0 for row in build['checks']) and build['source_hashes'] == hashes,
            'Android checks or source identity differ')
    apk = root / 'android-client/android/app/build/outputs/apk/release/app-release.apk'
    badging = subprocess.check_output([str(args.sdk_build_tools / 'aapt'), 'dump', 'badging', str(apk)], text=True)
    require(all(value in badging for value in ["name='jagake.bond.app'", "versionName='" + VERSION + "'",
                                                 "versionCode='" + str(CODE) + "'"])
            and 'application-debuggable' not in badging, 'Unexpected APK identity or debuggable release')
    signer = lambda path: subprocess.check_output([str(args.sdk_build_tools / 'apksigner'), 'verify',
                                                   '--print-certs', str(path)], text=True)
    signing = signer(apk)
    expected = args.expected_signer_sha256.replace(':', '').lower()
    require(certificate(signing).lower() == expected,
            'Release APK signer differs from the adopted release key')
    if args.reference_apk:
        require(signer(args.reference_apk) and certificate(signer(args.reference_apk)) != expected,
                'Reference APK unexpectedly matches the new release key')
    reports = list((root / 'android-client/android/app/build/test-results/testDebugUnitTest').glob('TEST-*.xml'))
    jvm = {key: sum(int(ET.parse(path).getroot().get(key, 0)) for path in reports)
           for key in ['tests', 'failures', 'errors', 'skipped']}
    require(jvm['tests'] >= 158 and jvm['failures'] == jvm['errors'] == jvm['skipped'] == 0, 'JVM checks failed')
    issues = ET.parse(root / 'android-client/android/app/build/reports/lint-results-debug.xml').getroot().findall('issue')
    require(not any(issue.get('severity') in {'Error', 'Fatal'} for issue in issues), 'Android lint errors')
    assets = []
    web_only = {'admin.html', 'admin.js', 'sw.js'}
    from PIL import Image

    def pixels(data):
        with Image.open(io.BytesIO(data)) as image:
            rgba = image.convert('RGBA')
            light = Image.new('RGBA', rgba.size, 'white'); light.alpha_composite(rgba)
            dark = Image.new('RGBA', rgba.size, 'black'); dark.alpha_composite(rgba)
            return rgba.size, sha(light.convert('RGB').tobytes()), sha(dark.convert('RGB').tobytes())

    native_brand = []
    with zipfile.ZipFile(apk) as archive:
        require(archive.testzip() is None, 'Corrupt APK')
        names = set(archive.namelist())
        for path in (root / 'app/frontend').rglob('*'):
            if not path.is_file() or path.name in web_only:
                continue
            name = path.relative_to(root / 'app/frontend').as_posix()
            require(archive.read('assets/public/' + name) == path.read_bytes(), 'APK asset differs: ' + name)
            assets.append(name)
        require(all('assets/public/' + name not in names for name in web_only), 'Web-only asset bundled')
        packed = set()
        for item in archive.infolist():
            if item.filename.startswith(('assets/', 'META-INF/')) or item.is_dir():
                continue
            with archive.open(item) as stream:
                magic = stream.read(8)
            if magic == b'\x89PNG\r\n\x1a\n':
                packed.add(pixels(archive.read(item)))
        for name in json.loads((root / 'app/brand/assets.json').read_text())['outputs']:
            if '/src/main/res/' in name:
                require(pixels((root / name).read_bytes()) in packed, 'Compiled native brand differs: ' + name)
                native_brand.append(name)
    require(len(native_brand) == 26 and len(assets) >= 73, 'Incomplete native/frontend assets')
    require(not args.out.exists(), 'Immutable release folder already exists')
    args.out.parent.mkdir(parents=True, exist_ok=True)
    prefix = 'JagaKebond-' + VERSION + '/'
    with tempfile.TemporaryDirectory(prefix='.package-', dir=args.out.parent) as scratch:
        output = Path(scratch) / 'release'; output.mkdir()
        apk_out = output / ('jagakebond-' + VERSION + '.apk')
        shutil.copy2(apk, apk_out)
        checks = {'version': VERSION, 'versionCode': CODE, 'api_compatibility': '2.1.0', 'schema': 11,
                  'apk_sha256': sha(apk_out.read_bytes()), 'signer_sha256': certificate(signing),
                  'same_signer_as_reference': True, 'frontend_assets_byte_matched': len(assets),
                  'native_brand_resources_pixel_matched': len(native_brand), 'jvm': jvm, 'lint_errors': 0,
                  'lint_warnings': sum(i.get('severity') == 'Warning' for i in issues),
                  'production_deployed': False, 'physical_device_validated': False,
                  'expert_diagnostic_benchmark_completed': False,
                  'regression': {key: regression[key] for key in ['expected', 'executed', 'passed', 'failed']},
                  'source_hashes': hashes}
        files = {name: path.read_bytes() for name, path in source_files(root)}
        files['VERIFICATION.json'] = (json.dumps(checks, indent=2) + '\n').encode()
        require(all(name in files for name in ['README.md', 'BUILD.md', 'PHONE-ACCEPTANCE-0259.md',
                                                'app/deploy/stage_release.sh', 'tools/run-regression.py']),
                'Required release documentation/tooling missing')
        secret_pattern = rb'-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY|\bibssh_[A-Za-z0-9]+@|\bibk_[a-z0-9]{30,}|\bsk-[A-Za-z0-9]{32,}\b|\bgh[pousr]_[A-Za-z0-9]{36,}\b'
        for name, data in files.items():
            if Path(name).suffix in {'.py', '.js', '.cjs', '.mjs', '.json', '.md', '.txt', '.properties', '.sh', '.html'}:
                require(not re.search(secret_pattern, data), 'Credential-shaped content in source file: ' + name)
        manifest = {'format': 1, 'files': {name: sha(data) for name, data in sorted(files.items())}}
        source = output / ('jagakebond-' + VERSION + '-source.zip')
        with zipfile.ZipFile(source, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for name, data in sorted(files.items()):
                archive.writestr(prefix + name, data)
            archive.writestr(prefix + 'SOURCE-SHA256.json', json.dumps(manifest, indent=2) + '\n')
        with tempfile.TemporaryDirectory(prefix='jk-source-check-') as extraction:
            with zipfile.ZipFile(source) as archive:
                require(archive.testzip() is None, 'Corrupt source ZIP')
                for name, expected in manifest['files'].items():
                    require(sha(archive.read(prefix + name)) == expected, 'Source manifest mismatch: ' + name)
                archive.extractall(extraction)
            tree = Path(extraction) / prefix
            env = {**os.environ, 'PYTHONDONTWRITEBYTECODE': '1', 'JK_AUDIT_APP': str(tree / 'app'),
                   'JK_FRONTEND': str(tree / 'app/frontend'), 'NODE_PATH': str(root / 'review/browser-tools/node_modules'),
                   'NODE_OPTIONS': '--require=' + str(tree / 'review/browser-tools/tour-fixture.cjs')}
            extracted = []
            for command, folder in [([sys.executable, '-B', 'tests/test_quality_0259.py'], 'app'),
                                    ([sys.executable, '-B', 'tests/test_stage_source_0259.py'], 'app'),
                                    ([sys.executable, '-B', 'tests/test_reanalysis_0241.py'], 'app'),
                                    ([sys.executable, '-B', 'tests/test_security_0220.py'], 'app'),
                                    (['node', 'quality-0259.cjs'], 'review/browser-tools')]:
                run = subprocess.run(command, cwd=tree / folder, env=env, capture_output=True, text=True, timeout=600)
                extracted.append({'command': command, 'exit_code': run.returncode})
                require(run.returncode == 0, 'Fresh extraction check failed: ' + repr(command) + '\n' + (run.stdout + run.stderr)[-2500:])
        require(source_hashes(root) == hashes, 'Source changed during packaging')
        for name in ['README.md', 'BUILD.md', 'PHONE-ACCEPTANCE-0259.md', 'QUALITY-0259.md']:
            shutil.copy2(root / name, output / name)
        (output / 'VERIFICATION.json').write_text(json.dumps(checks, indent=2) + '\n')
        (output / 'SOURCE-EXTRACTION-TESTS.json').write_text(json.dumps({'source_sha256': sha(source.read_bytes()),
            'manifest_files_verified': len(files), 'checks': extracted}, indent=2) + '\n')
        (output / 'aapt.txt').write_text(badging)
        (output / 'apksigner.txt').write_text(signing)
        (output / 'SHA256SUMS.txt').write_text(''.join(sha(path.read_bytes()) + '  ' + path.name + '\n'
            for path in sorted(output.iterdir()) if path.is_file()))
        os.rename(output, args.out)
    print(json.dumps({'release': str(args.out), 'source_sha256': sha((args.out / source.name).read_bytes()),
                       'apk_sha256': checks['apk_sha256'], 'manifest_files': len(files)}, indent=2))


if __name__ == '__main__':
    main()
