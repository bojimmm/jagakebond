"""Package the reviewed source without credentials, data or generated runtimes."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import zipfile
import argparse
import re

ROOT=Path(__file__).resolve().parents[1]

DENY={'.git','.venv','venv','data','node_modules','__pycache__','.pytest_cache','.gradle','build','www','.idea','.env','local.properties','debug.keystore','release.keystore'}

def files_under(folder):
    for base,dirs,files in os.walk(folder,followlinks=False):
        dirs[:]=sorted(d for d in dirs if d not in DENY and not (Path(base)/d).is_symlink())
        for name in sorted(files):
            p=Path(base)/name
            if name in DENY or p.is_symlink() or name.endswith(('.pyc','.pyo','.apk','.aab','.jks','.sqlite3','.sqlite','.db','.DS_Store')):continue
            if name.startswith('.env') and name!='.env.example':continue
            yield p

def release_version(value):
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:\.\d+)?', value):
        raise argparse.ArgumentTypeError('Numeric three- or four-part release version required')
    return value

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--version',type=release_version,default='0.2.1.8')
    args=parser.parse_args()

    version=args.version
    OUT=ROOT/('deliverables/jagakebond-'+version)
    OUT.mkdir(exist_ok=True,parents=True)
    selected={}
    for p in files_under(ROOT/'app'):
        relative=p.relative_to(ROOT/'app')
        if len(relative.parts)==1 and relative.name not in {'README.md','DESIGN.md','.env.example','requirements.txt','requirements-tested.txt','verify_mvp.py','make_icons.py','vendor_assets.py'}:continue
        if len(relative.parts)>1 and relative.parts[0] not in {'backend','frontend','worker','tests','tools','deploy'}:continue
        selected['app/'+relative.as_posix()]=p
    for p in files_under(ROOT/'android-client'):
        relative=p.relative_to(ROOT/'android-client')
        if relative.parts[0]=='artifacts':continue
        if relative.parts[:5]==('android','app','src','main','assets'):continue
        selected['android-client/'+relative.as_posix()]=p
    for group in ['browser-tools','ui-build','final-evidence','final-evidence-217','final-evidence-218','final-evidence-0218','parent-independent','screenshots']:
        for p in files_under(ROOT/'review'/group):selected[p.relative_to(ROOT).as_posix()]=p
    for name in ['verify_release.py','package_release.py','test_release_version.py','relabel_0217.py','finalize_217.py','finalize_0218.py','finalize_0218_ui.py','build_launcher_218.py','ui-0218-review-brief.md','UI-0218-ACCEPTANCE.md','run_http_acceptance.py','run_browser_acceptance.py',
                 'browser-offline-results.json','browser-baseline.json','security-ui-results.json',
                 'offline-faults-results.json','account-races-results.json','native-login-results.json',
                 'android-usability-results.json','photo-draft-results.json','tier-ui-results.json','polygon-edit-results.json',
                 'location-hourly-results.json','offline-e2e.json','offline-e2e-output.txt','FAST-TIERS-HANDOFF.md','POLYGON-EDIT-HANDOFF.md',
                 'LOCATION-HOURLY-HANDOFF.md','tier-ui-red-results.json']:
        p=ROOT/'review'/name
        if p.is_file():selected['review/'+name]=p
    for name in ['PHOTO-DRAFT-215-DIAGNOSIS.md', 'native-215-review-brief.md',
                 'feature-216-contract.md','NATIVE-216-HANDOFF.md','NATIVE-216-INTEGRATION.md',
                 'BACKEND-216-HANDOFF.md','workflow-216-results.json','workflow-216-review-brief.md','native-216-review-brief.md',
                 'FEATURE-216-STATUS.md','corrections-216-review-brief.md','corrections-216-final-review-brief.md','collision-216-final-review-brief.md',
                 'UI-217-HANDOFF.md','ui-217-results.json','ui-217-implementation-brief.md','backend-217-review-brief.md',
                 'feature-217-contract.md','FEATURE-217-STATUS.md','ui-217-final-review-brief.md',
                 'ui-217-corrective-review-brief.md','layout-217-review-brief.md',
                 'photo-card-218-review-brief.md','photo-card-218-corrective-review-brief.md','FEATURE-218-STATUS.md']:
        p=ROOT/'review'/name
        if p.is_file():selected['review/'+name]=p
    for p in (ROOT/'android-client/android/app/build/test-results/testDebugUnitTest').glob('TEST-*.xml'):
        selected['verification/android/jvm/'+p.name]=p
    if (OUT/'RELEASE-HOLD.md').is_file():selected['RELEASE-HOLD.md']=OUT/'RELEASE-HOLD.md'
    for name in ['NATIVE-CRYPTO-HANDOFF.md']:
        p=ROOT/'android-client/artifacts'/name
        selected['verification/android/'+name]=p
    for name in ['HANDOVER.md','BUILD.md','VERIFICATION.json','ARTIFACT-CHECKS.json','apksigner.txt','aapt.txt','android-build.log']:
        selected[name]=OUT/name
    manifest={'format':1,'files':{name:hashlib.sha256(p.read_bytes()).hexdigest()for name,p in sorted(selected.items())}}
    archive=OUT/('jagakebond-'+version+'-source.zip')
    prefix='JagaKebond-'+version+'/'
    with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6)as z:
        for name,p in sorted(selected.items()):z.write(p,prefix+name)
        z.writestr(prefix+'SOURCE-SHA256.json',json.dumps(manifest,indent=2))
    with zipfile.ZipFile(archive)as z:
        assert z.testzip() is None
        for name,expected in manifest['files'].items():assert hashlib.sha256(z.read(prefix+name)).hexdigest()==expected
        forbidden=[name for name in z.namelist()if set(Path(name).parts)&DENY]
        assert not forbidden,forbidden
        assert not any(name.endswith(('.keystore','.jks','.sqlite3','.db'))for name in z.namelist())
    checksums={p.name:hashlib.sha256(p.read_bytes()).hexdigest()for p in [archive,OUT/('jagakebond-'+version+'-debug.apk'),OUT/'HANDOVER.md',OUT/'BUILD.md']}
    (OUT/'SHA256SUMS.txt').write_text(''.join(value+'  '+name+'\n'for name,value in checksums.items()))
    print(json.dumps({'archive':archive.name,'source_files':len(selected),'bytes':archive.stat().st_size,'sha256':checksums},indent=2))

if __name__=='__main__':main()
