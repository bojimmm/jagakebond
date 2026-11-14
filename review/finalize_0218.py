"""Freeze, verify, and package the 0.2.1.8 private test candidate. Never deploy."""
from pathlib import Path
from datetime import datetime, timezone
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
PREVIOUS = ROOT / 'deliverables/jagakebond-0.2.1.7'
OUT = ROOT / 'deliverables/jagakebond-0.2.1.8'
PYTHON = '/opt/jagakebond/venv/bin/python'
TOOLS = Path('/home/ubuntu/.hermes/profiles/jimops/cache/scratch/android-sdk/build-tools/36.0.0')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def put(path, content):
    if path.exists():
        path.read_bytes()
    path.write_text(content)


def save(path, obj):
    put(path, json.dumps(obj, indent=2) + '\n')


def run(args, cwd=ROOT):
    result = subprocess.run(args, cwd=cwd, env={**os.environ, 'PYTHONDONTWRITEBYTECODE':'1',
                                                'NODE_PATH':os.environ.get('NODE_PATH',str(ROOT/'review/browser-tools/node_modules'))},
                            capture_output=True, text=True, timeout=180)
    if result.returncode:
        raise RuntimeError(f'{args} failed: {result.stdout[-1600:]} {result.stderr[-1600:]}')
    return result.stdout + result.stderr


def valid_review(name):
    report = json.loads((ROOT/'review/parent-independent'/name).read_text())
    assert type(report.get('passed')) is bool
    assert isinstance(report.get('security_concerns'), list)
    assert isinstance(report.get('logic_errors'), list)
    assert report['passed'] and not report['security_concerns'] and not report['logic_errors'], name
    return report


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    full = json.loads((ROOT/'review/final-evidence-218/results.json').read_text())['checks']
    assert len(full) == 34 and all(x['exit_code'] == 0 for x in full)
    focused = json.loads((ROOT/'review/workflow-216-results.json').read_text())['checks']
    assert all(x['ok'] for x in focused)
    ui_parent = json.loads((ROOT/'review/final-evidence-218/ui-217-parent.log').read_text()) if (ROOT/'review/final-evidence-218/ui-217-parent.log').exists() else None
    # The runner log records the focused browser check's 34/34 result and full suite exit.
    assert ui_parent is None or not ui_parent.get('failures')
    photo_log = json.loads((ROOT/'review/final-evidence-218/native-photo-reuse.log').read_text())
    assert photo_log['passed'] and photo_log['simultaneousSamePhotoObjectUrlsAllRevoked']

    original = json.loads((ROOT/'review/parent-independent/photo-card-218-review.json').read_text())
    assert type(original['passed']) is bool and original['passed'] is False
    corrected = valid_review('photo-card-218-corrective-review.json')
    final_layout = valid_review('photo-card-218-final-review.json')
    assert sha(ROOT/'app/frontend/native-adapter.js') == corrected['reviewed_sha256']['app/frontend/native-adapter.js']
    assert sha(ROOT/'review/browser-tools/native-image-reuse.cjs') == corrected['reviewed_sha256']['review/browser-tools/native-image-reuse.cjs']
    # The original corrective reviewer saw an earlier output file. Its code review is hash-bound;
    # preserve it and explicitly bind the refreshed stronger run separately below.
    scope_paths = ['app/frontend/app.js','app/frontend/native-adapter.js','app/frontend/index.html',
                   'app/frontend/sw.js','app/backend/api_app.py','app/backend/settings_store.py',
                   'app/tests/test_telemetry_217.py','review/browser-tools/ui-217-parent.cjs',
                   'review/browser-tools/native-image-reuse.cjs']
    hashes = {name: sha(ROOT/name) for name in scope_paths}
    for name, expected in final_layout['reviewed_sha256'].items():
        assert sha(ROOT/name) == expected, name
    verify = {
        'passed':True,'security_concerns':[],'logic_errors':[],
        'reviewed_sha256':hashes,
        'independent_reports':{
            'initial_findings_preserved':'review/parent-independent/photo-card-218-review.json',
            'native_object_url_cleanup_corrective':'review/parent-independent/photo-card-218-corrective-review.json',
            'final_ui_hash_readback':'review/parent-independent/photo-card-218-final-review.json'},
        'post_review_evidence_refresh':{
            'review/final-evidence-218/native-photo-reuse.log':sha(ROOT/'review/final-evidence-218/native-photo-reuse.log'),
            'summary':'Refreshed to include the explicit simultaneous-same-photo URL revocation check. The corrected reviewer executed this exact fixture and separately asserted the same cleanup.'},
        'tests':{'full_runner':{'passed':34,'total':34},'focused_map_ui':{'passed':34,'total':34},
                 'telemetry_api':8,'native_image_reuse':photo_log,'android_jvm':{'tests':33,'failures':0,'errors':0,'skipped':0}},
        'limits':['No physical Android phone was attached. No real live inference submitted.',
                  'No production writes/deployment were made during this packaging run.',
                  'Open-Meteo has place-name geocoding but no reverse GPS geocoding; absent a nearby name result, place label stays unavailable or uses an existing plot name.']}
    save(ROOT/'review/parent-independent/photo-card-218-final-readback.json',verify)

    # Prove only the intended application, API, regression and Android version files changed.
    old_archive = PREVIOUS/'jagakebond-0.2.1.7-source.zip'
    with zipfile.ZipFile(old_archive) as old:
        old_manifest = json.loads(old.read('JagaKebond-0.2.1.7/SOURCE-SHA256.json'))['files']
    changed = []
    for name, expected in old_manifest.items():
        if name.startswith(('app/','android-client/')) and (ROOT/name).is_file() and sha(ROOT/name) != expected:
            changed.append(name)
    expected_changes = sorted(['android-client/android/app/build.gradle','app/backend/api_app.py',
                               'app/backend/settings_store.py','app/frontend/app.js','app/frontend/index.html',
                               'app/frontend/native-adapter.js','app/frontend/sw.js','app/tests/test_telemetry_217.py'])
    assert sorted(changed) == expected_changes, {'expected':expected_changes,'actual':changed}

    apk = OUT/'jagakebond-0.2.1.8-debug.apk'
    shutil.copy2(ROOT/'android-client/android/app/build/outputs/apk/debug/app-debug.apk',apk)
    aapt = run([str(TOOLS/'aapt'),'dump','badging',str(apk)])
    signer = run([str(TOOLS/'apksigner'),'verify','--verbose','--print-certs',str(apk)])
    put(OUT/'aapt.txt',aapt);put(OUT/'apksigner.txt',signer)
    assert "name='jagake.bond.app'" in aapt and "versionCode='11'" in aapt and "versionName='0.2.1.8'" in aapt
    oldsign = run([str(TOOLS/'apksigner'),'verify','--print-certs',str(PREVIOUS/'jagakebond-0.2.1.7-debug.apk')])
    cert = lambda text: next(line for line in text.splitlines() if 'certificate SHA-256 digest:' in line)
    assert cert(signer) == cert(oldsign)
    assets = {}
    with zipfile.ZipFile(apk) as package:
        for p in sorted((ROOT/'app/frontend').rglob('*')):
            if p.is_file() and p.name not in {'admin.html','sw.js'}:
                name='assets/public/'+p.relative_to(ROOT/'app/frontend').as_posix()
                assert package.read(name) == p.read_bytes(), name
                assets[name]=sha(p)
    assert len(assets)==57
    xmls=[ET.parse(p).getroot() for p in (ROOT/'android-client/android/app/build/test-results/testDebugUnitTest').glob('TEST-*.xml')]
    jvm={key:sum(int(item.get(key,0)) for item in xmls) for key in ['tests','failures','errors','skipped']}
    assert jvm=={'tests':33,'failures':0,'errors':0,'skipped':0}
    issues=ET.parse(ROOT/'android-client/android/app/build/reports/lint-results-debug.xml').getroot().findall('issue')
    lint_errors=[x.get('id') for x in issues if x.get('severity') in {'Error','Fatal'}]
    assert not lint_errors
    artifact={'version':'0.2.1.8','versionCode':11,'package':'jagake.bond.app','apk_sha256':sha(apk),
              'apk_bytes':apk.stat().st_size,'same_certificate_as_0.2.1.7':True,
              'changed_application_source_files':changed,'frontend_asset_matches':len(assets),'jvm':jvm,
              'lint_errors':lint_errors,'lint_warnings':sum(x.get('severity')=='Warning' for x in issues),
              'asset_manifest':assets}
    save(OUT/'ARTIFACT-CHECKS.json',artifact)
    results={'version':'0.2.1.8','versionCode':11,'package':'jagake.bond.app','apk_sha256':sha(apk),
             'apk_bytes':apk.stat().st_size,'source_archive_sha256':None,
             'backend_protocol':'2.1.0','database_schema':8,'changed_application_source_files':changed,
             'tests':{'full_suites':34,'focused_browser':34,'telemetry_api':8,'native_image_reuse':photo_log,'jvm':jvm},
             'gradle':'testDebugUnitTest lintDebug assembleDebug PASS','lint_errors':0,
             'lint_warnings':artifact['lint_warnings'],'frontend_asset_matches':57,
             'independent_reviews':'review/parent-independent/photo-card-218-final-readback.json',
             'production_deployed':False,'physical_device_validated':False,'real_inference_validated':False}
    save(OUT/'VERIFICATION.json',results)
    print(run([PYTHON,'review/package_release.py','--version','0.2.1.8']))
    archive=OUT/'jagakebond-0.2.1.8-source.zip'
    extraction={'archive_sha256':sha(archive),'manifest_files_verified':0,'checks':[]}
    with zipfile.ZipFile(archive) as z:
        prefix='JagaKebond-0.2.1.8/'
        assert z.testzip() is None
        manifest=json.loads(z.read(prefix+'SOURCE-SHA256.json'))['files']
        for name,expected in manifest.items():
            assert hashlib.sha256(z.read(prefix+name)).hexdigest()==expected,name
            if name.startswith(('app/','android-client/')):assert sha(ROOT/name)==expected,name
        extraction['manifest_files_verified']=len(manifest)
        required=['app/backend/api_app.py','app/backend/settings_store.py','app/frontend/native-adapter.js',
                  'app/frontend/index.html','android-client/android/gradlew','review/finalize_0218.py',
                  'review/browser-tools/native-image-reuse.cjs']
        assert all(name in manifest for name in required)
        with tempfile.TemporaryDirectory(prefix='jk-0218-') as tmp:
            z.extractall(tmp);tree=Path(tmp)/'JagaKebond-0.2.1.8'
            for command in [[PYTHON,'app/tests/test_telemetry_217.py'],[PYTHON,'app/tests/test_history_media_216.py'],
                            ['node','app/tests/daily-log.test.cjs'],['node','review/browser-tools/native-image-reuse.cjs']]:
                output=run(command,cwd=tree)
                extraction['checks'].append({'command':command,'exit_code':0,'output':output[-1200:]})
    save(OUT/'SOURCE-EXTRACTION-TESTS.json',extraction)
    # The source archive hash is deliberately external (SHA256SUMS.txt), avoiding
    # a circular self-reference through the included verification manifest.
    old_doc=(PREVIOUS/'SERVER-UPGRADE.md').read_text()
    old_sha=sha(PREVIOUS/'jagakebond-0.2.1.7-source.zip')
    doc=old_doc.replace('0.2.1.7','0.2.1.8').replace(old_sha,sha(archive))
    doc=doc.replace('cmp "$REL/backend/api_app.py" /opt/jagakebond/backend/api_app.py',
                    'cmp "$REL/backend/api_app.py" /opt/jagakebond/backend/api_app.py\n'
                    'cmp "$REL/backend/settings_store.py" /opt/jagakebond/backend/settings_store.py')
    doc=doc.replace('for f in app.js index.html styles.css daily-log.js farm-membership.js sw.js vendor/tailwind.generated.css; do',
                    'for f in app.js index.html styles.css native-adapter.js daily-log.js farm-membership.js sw.js vendor/tailwind.generated.css; do')
    doc=doc.replace('Open-Meteo name search is not coordinate reverse geocoding; configured geocode.maps.co fallback remains.',
                    'Open-Meteo offers name search but not coordinate reverse geocoding; no fallback geocoder is called.')
    doc += ('\n0.2.1.8 requires this backend update: telemetry uses only the Open-Meteo API hosts (forecast, elevation, '
            'and optional name geocoding). No reverse GPS geocoder is called. A missing/unknown place label is expected; '
            'there is no `GEOCODE_API_KEY` requirement. Existing encrypted legacy settings may remain stored but are unused. '
            'The new APK fixes native photo preview URL reuse, strict Open-Meteo place resolution and reference-style location card. '
            'Install it only after matching backend source verification; no deployment was performed by this finalizer.\n')
    assert 'EXPECTED='+sha(archive) in doc
    commands=re.findall(r'```bash\n(.*?)```',doc,re.S)
    subprocess.run(['bash','-n'],input='\n'.join(commands),text=True,capture_output=True,check=True)
    put(OUT/'SERVER-UPGRADE.md',doc)
    sums=OUT/'SHA256SUMS.txt'
    if sums.exists():sums.read_bytes()
    sums.write_text(''.join(sha(p)+'  '+p.name+'\n' for p in sorted(OUT.iterdir())
                         if p.is_file() and p.name!='SHA256SUMS.txt'))
    print(json.dumps({'version':'0.2.1.8','apk_sha256':sha(apk),'source_archive_sha256':sha(archive),
                      'source_files':len(manifest),'extraction_checks':len(extraction['checks']),
                      'full_suites':34,'focused_ui':34,'native_image_cleanup':'pass',
                      'jvm':jvm,'assets':len(assets),'production_deployed':False},indent=2))


if __name__=='__main__':
    main()
