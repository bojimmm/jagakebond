"""Package the completed screenshot corrections as 0.2.1.8; never deploy."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zipfile
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'deliverables/jagakebond-0.2.1.8'
OLD = ROOT / 'deliverables/jagakebond-0.2.1.7'
PYTHON = '/opt/jagakebond/venv/bin/python'
TOOLS = Path('/home/ubuntu/.hermes/profiles/jimops/cache/scratch/android-sdk/build-tools/36.0.0')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def put(path, text):
    if path.exists(): path.read_bytes()
    path.write_text(text)


def save(path, data):
    put(path, json.dumps(data, indent=2) + '\n')


def run(args, cwd=ROOT):
    p = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=120,
        env={**os.environ, 'PYTHONDONTWRITEBYTECODE':'1', 'NODE_PATH':str(ROOT/'review/browser-tools/node_modules')})
    if p.returncode: raise RuntimeError(f'{args}: {p.stdout[-1600:]} {p.stderr[-1600:]}')
    return p.stdout + p.stderr


def main():
    evidence = ROOT / 'review/final-evidence-0218'
    full = json.loads((evidence/'results.json').read_text())['checks']
    assert len(full) == 36 and all(c['exit_code'] == 0 for c in full)
    ui = json.loads((evidence/'ui-218-results.json').read_text())['checks']
    assert len(ui) == 15 and all(c['ok'] is True for c in ui)
    original = json.loads((ROOT/'review/parent-independent/ui-0218-review.json').read_text())
    assert original['passed'] is True and not original['security_concerns'] and not original['logic_errors']
    report = json.loads((ROOT/'review/parent-independent/ui-0218-final-icon-review.json').read_text())
    assert type(report['passed']) is bool and report['passed']
    assert isinstance(report['security_concerns'],list) and not report['security_concerns']
    assert isinstance(report['logic_errors'],list) and not report['logic_errors']
    for name, expected in report['reviewed_sha256'].items(): assert sha(ROOT/name) == expected, name
    apk = OUT/'jagakebond-0.2.1.8-debug.apk'
    shutil.copy2(ROOT/'android-client/android/app/build/outputs/apk/debug/app-debug.apk',apk)
    aapt = run([str(TOOLS/'aapt'),'dump','badging',str(apk)])
    sig = run([str(TOOLS/'apksigner'),'verify','--verbose','--print-certs',str(apk)])
    put(OUT/'aapt.txt',aapt); put(OUT/'apksigner.txt',sig)
    assert "name='jagake.bond.app'" in aapt and "versionCode='11'" in aapt and "versionName='0.2.1.8'" in aapt
    cert = lambda text:next(line for line in text.splitlines() if 'certificate SHA-256 digest:' in line)
    assert cert(sig) == cert(run([str(TOOLS/'apksigner'),'verify','--print-certs',str(OLD/'jagakebond-0.2.1.7-debug.apk')]))
    assets = {}; icons = []
    with zipfile.ZipFile(apk) as package:
        for p in sorted((ROOT/'app/frontend').rglob('*')):
            if p.is_file() and p.name not in {'admin.html','sw.js'}:
                name = 'assets/public/'+p.relative_to(ROOT/'app/frontend').as_posix()
                assert package.read(name) == p.read_bytes(),name
                assets[name] = sha(p)
        for p in (ROOT/'android-client/android/app/src/main/res').glob('mipmap-*/*.png'):
            if not p.name.startswith('ic_launcher'): continue
            matches = [n for n in package.namelist() if n.startswith('res/'+p.parent.name+'-') and n.endswith('/'+p.name)]
            assert len(matches) == 1, str(p)
            actual=Image.open(io.BytesIO(package.read(matches[0]))).convert('RGBA')
            expected=Image.open(p).convert('RGBA')
            assert actual.size==expected.size and actual.tobytes()==expected.tobytes(),str(p)
            icons.append(matches[0])
    assert len(assets)==57 and len(icons)==15
    roots=[ET.parse(p).getroot() for p in (ROOT/'android-client/android/app/build/test-results/testDebugUnitTest').glob('TEST-*.xml')]
    jvm={k:sum(int(x.get(k,0)) for x in roots) for k in ['tests','failures','errors','skipped']}
    assert jvm=={'tests':33,'failures':0,'errors':0,'skipped':0}
    issues=ET.parse(ROOT/'android-client/android/app/build/reports/lint-results-debug.xml').getroot().findall('issue')
    assert not [x for x in issues if x.get('severity') in {'Error','Fatal'}]
    artifact={'version':'0.2.1.8','versionCode':11,'package':'jagake.bond.app','apk_sha256':sha(apk),
              'apk_bytes':apk.stat().st_size,'same_certificate_as_0_2_1_7':True,'jvm':jvm,
              'frontend_asset_matches':len(assets),'launcher_png_pixels_verified':len(icons),
              'lint_errors':0,'lint_warnings':sum(x.get('severity')=='Warning' for x in issues),'asset_manifest':assets,
              'packaged_launcher_pngs':icons}
    save(OUT/'ARTIFACT-CHECKS.json',artifact)
    verification={k:v for k,v in artifact.items() if k!='asset_manifest'}
    verification.update({'captured_utc':datetime.now(timezone.utc).isoformat(),'backend_protocol':'2.1.0','schema':8,
                         'full_suites_passed':len(full),'focused_ui_passed':len(ui),'physical_device_validated':False,
                         'production_deployed':False,'live_inference_validated':False,
                         'independent_report':'review/parent-independent/ui-0218-final-icon-review.json',
                         'prior_source_review':'review/parent-independent/ui-0218-review.json',
                         'review_hashes':report['reviewed_sha256'],
                         'real_upstream_staging_probe':json.loads((evidence/'upstream-readiness.json').read_text()),
                         'scope':'New private debug candidate, not final/public or device-validated release'})
    save(OUT/'VERIFICATION.json',verification)
    print(run([PYTHON,'review/package_release.py','--version','0.2.1.8']))
    archive=OUT/'jagakebond-0.2.1.8-source.zip';extraction={'archive_sha256':sha(archive),'checks':[]}
    with zipfile.ZipFile(archive) as z:
        prefix='JagaKebond-0.2.1.8/';assert z.testzip() is None
        assert all(n.startswith(prefix) and '..' not in Path(n).parts for n in z.namelist())
        manifest=json.loads(z.read(prefix+'SOURCE-SHA256.json'))['files']
        for name,want in manifest.items():
            assert hashlib.sha256(z.read(prefix+name)).hexdigest()==want,name
            if name.startswith(('app/','android-client/')):assert sha(ROOT/name)==want,name
        extraction['manifest_files_verified']=len(manifest)
        for name in ['app/tests/test_telemetry_hooks_218.py','review/browser-tools/ui-218.cjs','review/build_launcher_218.py','review/finalize_0218_ui.py']:
            assert name in manifest,name
        with tempfile.TemporaryDirectory(prefix='jk-0218-extract-') as tmp:
            z.extractall(tmp);tree=Path(tmp)/'JagaKebond-0.2.1.8'
            for args in [[PYTHON,'app/tests/test_telemetry_hooks_218.py'],[PYTHON,'app/tests/test_telemetry_217.py'],
                         [PYTHON,'app/tests/test_history_media_216.py'],['node','review/browser-tools/ui-218.cjs']]:
                extraction['checks'].append({'command':args,'exit_code':0,'output':run(args,tree)[-1800:]})
    save(OUT/'SOURCE-EXTRACTION-TESTS.json',extraction)
    doc=(OLD/'SERVER-UPGRADE.md').read_text().split('\nVersion relabel only:')[0]
    doc=doc.replace('0.2.1.7','0.2.1.8').replace(sha(OLD/'jagakebond-0.2.1.7-source.zip'),sha(archive))
    doc=doc.replace('Open-Meteo name search is not coordinate reverse geocoding; configured geocode.maps.co fallback remains.',
                    'Open-Meteo has no reverse GPS geocoding; coordinates are shown honestly when a name is absent.')
    doc=doc.replace('cmp "$REL/backend/api_app.py" /opt/jagakebond/backend/api_app.py',
                    'cmp "$REL/backend/api_app.py" /opt/jagakebond/backend/api_app.py\n'
                    'cmp "$REL/backend/settings_store.py" /opt/jagakebond/backend/settings_store.py')
    doc=doc.replace('app.js index.html styles.css daily-log.js','app.js index.html styles.css native-adapter.js workflow-ui.js daily-log.js')
    doc += ('\n## Mandatory new backend fix\n\n'
            'This is NOT a label-only change. Deploy matching backend/api_app.py: _validate_request_url must be async '
            'for HTTPX AsyncClient. The previously deployed sync hook fails before provider transport and yields missing '
            'weather/elevation. Do not claim installing the APK fixes the server. Existing allowlist/redirect security remains. '
            'Provider policy is Open-Meteo only; no reverse geocoder/key is called. Compatibility health stays2.1.0 and schema8. '
            'The archive hash above pins the completed UI/icon/hook candidate, not an earlier partial build.\n\n'
            'After deployment check real telemetry via the owner phone/account without publishing credentials or private coordinates. '
            'Parent staging weather/elevation probes succeeded using public sample0,0, not production authentication. '
            'Root-only snapshot is local rollback, not off-host backup. No deployment was executed by this packaging script.\n')
    assert 'EXPECTED='+sha(archive) in doc
    blocks=re.findall(r'```bash\n(.*?)```',doc,re.S)
    subprocess.run(['bash','-n'],input='\n'.join(blocks),capture_output=True,text=True,check=True)
    put(OUT/'SERVER-UPGRADE.md',doc)
    for name in ['home.png','location-editor.png','launcher-icons-preview.png']:
        shutil.copy2(evidence/name,OUT/name)
    put(OUT/'SHA256SUMS.txt',''.join(sha(p)+'  '+p.name+'\n' for p in sorted(OUT.iterdir()) if p.is_file() and p.name!='SHA256SUMS.txt'))
    print(json.dumps({'version':'0.2.1.8','apk_sha256':sha(apk),'source_sha256':sha(archive),'suites':len(full),
                      'ui_checks':len(ui),'jvm':jvm,'asset_matches':len(assets),'verified_launcher_pngs':len(icons),
                      'extracted_commands_passed':len(extraction['checks']),'production_deployed':False},indent=2))


if __name__=='__main__':main()
