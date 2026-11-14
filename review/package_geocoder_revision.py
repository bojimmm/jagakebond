"""Build full backend revision from immutable 0.2.1.8 source; no live deploy."""
from pathlib import Path
import hashlib
import json
import os
import re
import subprocess
import tempfile
import zipfile

ROOT=Path(__file__).resolve().parents[1]
OLD=ROOT/'deliverables/jagakebond-0.2.1.8'
OUT=ROOT/'deliverables/jagakebond-0.2.1.8-geocoder'
PYTHON='/opt/jagakebond/venv/bin/python'
PREFIX='JagaKebond-0.2.1.8/'


def sha(data): return hashlib.sha256(data).hexdigest()


def save(path,text):
    if path.exists():path.read_bytes()
    path.write_text(text)


def main():
    OUT.mkdir(parents=True,exist_ok=True)
    report=json.loads((ROOT/'review/parent-independent/reverse-geocoder-review.json').read_text())
    assert type(report['passed'])is bool and report['passed']
    assert isinstance(report['security_concerns'],list)and not report['security_concerns']
    assert isinstance(report['logic_errors'],list)and not report['logic_errors']
    for name,expected in report['reviewed_sha256'].items():assert sha((ROOT/name).read_bytes())==expected,name
    checks=json.loads((ROOT/'review/final-evidence-geocoder/results.json').read_text())['checks']
    assert len(checks)==37 and all(x['exit_code']==0 for x in checks)
    old_archive=OLD/'jagakebond-0.2.1.8-source.zip'
    with zipfile.ZipFile(old_archive)as z:
        previous=json.loads(z.read(PREFIX+'SOURCE-SHA256.json'))['files']
        files={name:z.read(PREFIX+name)for name in previous}
    allowed={'app/backend/api_app.py','app/backend/settings_store.py','app/tests/test_telemetry_217.py'}
    changes=[]
    for name,expected in previous.items():
        if name.startswith(('app/','android-client/')):
            assert (ROOT/name).is_file(),name
            if sha((ROOT/name).read_bytes())!=expected:changes.append(name)
    assert set(changes)==allowed,changes
    for name in allowed|{'app/tests/test_reverse_geocode_218.py','review/verify_release.py',
                        'review/package_geocoder_revision.py','review/reverse-geocoder-review-brief.md',
                        'review/parent-independent/reverse-geocoder-review.json'}:
        files[name]=(ROOT/name).read_bytes()
    for p in (ROOT/'review/final-evidence-geocoder').iterdir():
        if p.is_file()and p.suffix in {'.json','.log'}:files[str(p.relative_to(ROOT))]=p.read_bytes()
    verification={'revision':'0.2.1.8-geocoder','apk_version':'0.2.1.8','apk_versionCode':11,
                  'apk_sha256':sha((OLD/'jagakebond-0.2.1.8-debug.apk').read_bytes()),'new_apk_required':False,
                  'source_base_sha256':sha(old_archive.read_bytes()),'changed_existing_application_files':sorted(changes),
                  'new_test_file':'app/tests/test_reverse_geocode_218.py','full_suites_passed':len(checks),
                  'review_report':'review/parent-independent/reverse-geocoder-review.json',
                  'review_hashes':report['reviewed_sha256'],'secret_installed':False,
                  'live_key_validated':False,'production_deployed':False,'schema':8,'api_compatibility':'2.1.0'}
    save(OUT/'VERIFICATION.json',json.dumps(verification,indent=2)+'\n')
    save(OUT/'BUILD.md',
         '# Backend-only reverse-geocoder revision\n\n'
         'No Android/frontend changes: keep the verified0.2.1.8 APK versionCode11. '
         'Build this full-source revision using `review/package_geocoder_revision.py` in the parent workspace '
         'with the immutable prior0.2.1.8 archive available. External dependencies/keys are excluded.\n\n'
         'From an extracted source root, run the tested Python3.12 environment against '
         '`app/tests/test_reverse_geocode_218.py`, `app/tests/test_telemetry_217.py`, '
         '`app/tests/test_telemetry_hooks_218.py` and `review/verify_release.py` '
         'with `JK_EVIDENCE_DIR=review/final-evidence-geocoder` and `JK_TEST_PYTHON` set explicitly. '
         '37suites passed in staging, not on a phone or live server. Tests use fake credentials only. '
         'Configure GEOCODE_API_KEY privately after guarded deployment; never put actual keys in source.\n')
    for name in ['HANDOVER.md','BUILD.md','VERIFICATION.json']:files[name]=(OUT/name).read_bytes()
    forbidden={'.env','data','node_modules','.git','debug.keystore','local.properties'}
    for name,data in files.items():
        assert not(set(Path(name).parts)&forbidden),name
        if name.endswith(('.py','.js','.json','.log','.md','.properties','.txt')):
            text=data.decode('utf-8',errors='ignore')
            assert not re.search(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-[A-Za-z0-9]{32,}\b|\bgh[pousr]_[A-Za-z0-9]{36,}\b',text),name
    manifest={'format':1,'files':{name:sha(data)for name,data in sorted(files.items())}}
    archive=OUT/'jagakebond-0.2.1.8-geocoder-source.zip'
    with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6)as z:
        for name,data in sorted(files.items()):z.writestr(PREFIX+name,data)
        z.writestr(PREFIX+'SOURCE-SHA256.json',json.dumps(manifest,indent=2))
    with zipfile.ZipFile(archive)as z:
        assert z.testzip()is None
        for name,expected in manifest['files'].items():assert sha(z.read(PREFIX+name))==expected,name
        extraction={'archive_sha256':sha(archive.read_bytes()),'manifest_files_verified':len(files),'checks':[]}
        with tempfile.TemporaryDirectory(prefix='jk-geocoder-revision-')as temp:
            z.extractall(temp);tree=Path(temp)/PREFIX
            for name in ['test_reverse_geocode_218.py','test_telemetry_217.py','test_telemetry_hooks_218.py']:
                command=[PYTHON,'app/tests/'+name]
                p=subprocess.run(command,cwd=tree,capture_output=True,text=True,timeout=60,
                                 env={**os.environ,'PYTHONDONTWRITEBYTECODE':'1'})
                extraction['checks'].append({'command':command,'exit_code':p.returncode,'output':p.stdout+p.stderr})
                assert p.returncode==0,p.stdout+p.stderr
    save(OUT/'SOURCE-EXTRACTION-TESTS.json',json.dumps(extraction,indent=2)+'\n')
    doc=(OLD/'SERVER-UPGRADE.md').read_text().split('\n0.2.1.8 additionally')[0]
    doc=doc.replace(str(OLD/'jagakebond-0.2.1.8-source.zip'),str(archive))
    doc=doc.replace(sha(old_archive.read_bytes()),sha(archive.read_bytes()))
    doc=doc.replace('DEST=/opt/jagakebond-releases/0.2.1.8','DEST=/opt/jagakebond-releases/0.2.1.8-geocoder')
    doc=doc.replace('# Authorized administrator deployment — JagaKebond 0.2.1.8 feature source',
                    '# Authorized administrator deployment: 0.2.1.8 reverse-geocoder revision')
    doc += ('\n## Required private configuration and functional acceptance\n\n'
            'This revision supersedes the old Open-Meteo-only address policy. Weather/elevation remain Open-Meteo; '
            'GPS coordinate-to-address lookup now uses fixed https://geocode.maps.co/reverse with JSON. '
            'No new APK is needed beyond the completed0.2.1.8 APK (versionCode11). Keep app data. '
            'The async HTTPX hook fix and all0.2.1.8 UI/source are included in this FULL guarded-deploy bundle.\n\n'
            'After authorized deployment, the administrator must privately set GEOCODE_API_KEY via the admin '
            'integration setting "Kunci Reverse Geocoding" (encrypted at rest), or the protected server environment '
            '(stored encrypted value takes precedence). The owner key was posted in chat: rotating it through '
            'the provider account is recommended; do not paste its replacement into chat or this file. '
            'Do not pass it on a shell command line or query URL. Backend requests use Authorization Bearer '
            'only for that fixed host and disable redirects. No real key is in the bundle and no key was installed by the builder.\n\n'
            'Verify the setting is marked configured using its masked admin indicator, then use an authorized '
            'phone/account to refresh location once. Expect a real address/locality with unchanged GPS coordinates, '
            'weather and elevation. Inspect non-secret locationProvider only if safely available: geocode.maps.co '
            'means reverse result; open-meteo means optional name-hint fallback. With no key/coverage or429, '
            'coordinate fallback is correct and weather must not vanish. No tight retry loop. '
            'The app retains hourly refresh/manual refresh; backend does not introduce global provider quota '
            'coordination. Monitor aggregate quota before wider rollout.\n\n'
            'Return only redacted service/health/schema/source-match/rollback and actual phone outcomes. '
            'Do not claim real key validity from the synthetic tests or print private positions/provider headers. '
            'The same-disk snapshot remains rollback, not an off-host backup or tested disaster recovery.\n')
    blocks=re.findall(r'```bash\n(.*?)```',doc,re.S)
    subprocess.run(['bash','-n'],input='\n'.join(blocks),text=True,capture_output=True,check=True)
    assert 'EXPECTED='+sha(archive.read_bytes())in doc
    save(OUT/'SERVER-UPGRADE.md',doc)
    save(OUT/'SHA256SUMS.txt',''.join(sha(p.read_bytes())+'  '+p.name+'\n'for p in sorted(OUT.iterdir())
                                   if p.is_file()and p.name!='SHA256SUMS.txt'))
    print(json.dumps({'revision':verification['revision'],'source_sha256':sha(archive.read_bytes()),
                      'source_manifest_files':len(files),'full_suites':len(checks),'extracted_test_commands':3,
                      'new_apk_required':False,'production_deployed':False,'secret_installed':False},indent=2))


if __name__=='__main__':main()
