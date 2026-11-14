"""Build and verify a new immutable private release after parent acceptance."""
from pathlib import Path
import hashlib,json,os,re,shutil,subprocess,tempfile,zipfile
import xml.etree.ElementTree as ET

ROOT=Path(__file__).resolve().parents[2]
REVIEW=Path(__file__).resolve().parent
OUT=ROOT/'deliverables/jagakebond-0.2.1.9'
SDK=Path('/home/ubuntu/.hermes/profiles/jimops/cache/scratch/android-sdk/build-tools/36.0.0')
PY='/opt/jagakebond/venv/bin/python'
os.environ['JAVA_HOME']='/home/ubuntu/.local/share/jimops-android-toolchain/jdk-21.0.12.1+1'
os.environ['PATH']=os.environ['JAVA_HOME']+'/bin:'+os.environ['PATH']
VERSION='0.2.1.9';PREFIX='JagaKebond-'+VERSION+'/'
def sha(data):return hashlib.sha256(data).hexdigest()
def jsonsave(path,value):path.write_text(json.dumps(value,indent=2)+'\n')
def command(args):return subprocess.check_output([str(a)for a in args],text=True)

def main():
 OUT.mkdir(exist_ok=True,parents=True)
 assert not (OUT/('jagakebond-'+VERSION+'-source.zip')).exists(),'Frozen release exists; create a revision instead of overwriting'
 regress=json.loads((REVIEW/'regression/summary.json').read_text());assert regress['passed']==regress['expected_suites']==45 and not regress['failed']
 accepted=json.loads((REVIEW/'parent-acceptance.json').read_text());assert accepted['passed'] is True
 for name,digest in accepted['hashes'].items():assert sha((ROOT/name).read_bytes())==digest,name
 apk=ROOT/'android-client/android/app/build/outputs/apk/debug/app-debug.apk'
 badging=command([SDK/'aapt','dump','badging',apk]);assert "name='jagake.bond.app'" in badging and "versionCode='12'" in badging and "versionName='0.2.1.9'" in badging
 signer=command([SDK/'apksigner','verify','--print-certs',apk]);old=command([SDK/'apksigner','verify','--print-certs',ROOT/'deliverables/jagakebond-0.2.1.8/jagakebond-0.2.1.8-debug.apk'])
 cert=lambda s:re.search(r'Signer #1 certificate SHA-256 digest: (\S+)',s).group(1)
 assert cert(signer)==cert(old)
 xml=list((ROOT/'android-client/android/app/build/test-results/testDebugUnitTest').glob('TEST-*.xml'))
 jvm={k:sum(int(ET.parse(p).getroot().get(k,0))for p in xml)for k in ['tests','failures','errors','skipped']};assert jvm['tests']==35 and jvm['failures']==jvm['errors']==0
 matches=[]
 with zipfile.ZipFile(apk)as z:
  assert z.testzip()is None
  for p in (ROOT/'app/frontend').rglob('*'):
   if not p.is_file() or p.name in {'admin.html','sw.js'}:continue
   relative=p.relative_to(ROOT/'app/frontend').as_posix();assert z.read('assets/public/'+relative)==p.read_bytes(),relative;matches.append(relative)
  assert 'assets/public/sw.js'not in z.namelist() and 'assets/public/admin.html'not in z.namelist()
 assert len(matches)==57
 destination=OUT/('jagakebond-'+VERSION+'-debug.apk');shutil.copy2(apk,destination)
 (OUT/'aapt.txt').write_text(badging);(OUT/'apksigner.txt').write_text(signer)
 shutil.copy2(REVIEW/'android-build-final.log',OUT/'android-build.log')
 artifacts={'application_id':'jagake.bond.app','version':VERSION,'versionCode':12,'same_signer_as_0218':True,'apk_sha256':sha(apk.read_bytes()),'frontend_assets_byte_matched':len(matches),'jvm':jvm,'production_deployed':False,'physical_device_validated':False}
 jsonsave(OUT/'ARTIFACT-CHECKS.json',artifacts)
 verification={**artifacts,'regression':regress,'source_hashes':accepted['hashes'],'schema':8,'api_compatibility':'2.1.0','tree_capability':'capabilities.treeContinuity === true','private_test_candidate':True}
 jsonsave(OUT/'VERIFICATION.json',verification)
 # Start with immutable geocoder release to retain all earlier source and provenance.
 base=ROOT/'deliverables/jagakebond-0.2.1.8-geocoder/jagakebond-0.2.1.8-geocoder-source.zip'
 with zipfile.ZipFile(base)as z:
  old_prefix='JagaKebond-0.2.1.8/';manifest=json.loads(z.read(old_prefix+'SOURCE-SHA256.json'))['files'];files={n:z.read(old_prefix+n)for n in manifest if n.startswith(('app/','android-client/','review/'))}
 import importlib.util
 spec=importlib.util.spec_from_file_location('release_packager',ROOT/'review/package_release.py');pack=importlib.util.module_from_spec(spec);spec.loader.exec_module(pack)
 for group in ['app','android-client']:
  for p in pack.files_under(ROOT/group):
   rel=p.relative_to(ROOT).as_posix()
   if '/artifacts/'in rel or '/src/main/assets/'in rel:continue
   if group=='app' and p.relative_to(ROOT/'app').parts[0] in {'review'}:continue
   files[rel]=p.read_bytes()
 for p in REVIEW.rglob('*'):
  if not p.is_file()or any(s in p.relative_to(REVIEW).parts for s in ['before','regression-first-attempt','regression-attempt1','fixture-output']):continue
  if p.suffix not in {'.py','.cjs','.json','.md','.log','.png'}:continue
  files[p.relative_to(ROOT).as_posix()]=p.read_bytes()
 for name in ['HANDOVER.md','BUILD.md','VERIFICATION.json','ARTIFACT-CHECKS.json']:
  files[name]=(OUT/name).read_bytes()
 forbidden={'.env','data','node_modules','.git','.gradle','local.properties','debug.keystore'}
 for name,data in files.items():
  assert not(set(Path(name).parts)&forbidden),name
  assert not name.endswith(('.jks','.keystore','.db','.sqlite3','.pyc')),name
  if name.endswith(('.py','.js','.json','.log','.md','.txt','.properties')):
   assert not re.search(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-[A-Za-z0-9]{32,}\b|\bgh[pousr]_[A-Za-z0-9]{36,}\b',data),name
 manifest={'format':1,'files':{n:sha(b)for n,b in sorted(files.items())}}
 archive=OUT/('jagakebond-'+VERSION+'-source.zip')
 with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6)as z:
  for n,b in sorted(files.items()):z.writestr(PREFIX+n,b)
  z.writestr(PREFIX+'SOURCE-SHA256.json',json.dumps(manifest,indent=2))
 extracted=[]
 with zipfile.ZipFile(archive)as z:
  assert z.testzip()is None
  for n,digest in manifest['files'].items():assert sha(z.read(PREFIX+n))==digest,n
  with tempfile.TemporaryDirectory(prefix='jk219-extract-',dir=os.environ['TMPDIR'])as temp:
   z.extractall(temp);tree=Path(temp)/PREFIX
   for args in [[PY,'-B','review/history-continuity-0219/test_tree_api.py'],['node','--test','review/history-continuity-0219/daily.test.cjs','review/history-continuity-0219/tree-sync.test.cjs'],[PY,'-B','app/tests/test_reverse_geocode_218.py']]:
    run=subprocess.run(args,cwd=tree,capture_output=True,text=True,env={**os.environ,'PYTHONDONTWRITEBYTECODE':'1'},timeout=120)
    extracted.append({'command':args,'exit_code':run.returncode,'output':run.stdout+run.stderr});assert run.returncode==0,run.stdout+run.stderr
 jsonsave(OUT/'SOURCE-EXTRACTION-TESTS.json',{'source_sha256':sha(archive.read_bytes()),'manifest_files_verified':len(files),'checks':extracted})
 # Path/version-only administrator companion preserves existing guarded deploy procedure.
 guide=(ROOT.parent/'SERVER-UPGRADE.md').read_text()
 guide=guide.replace('0.2.1.8-geocoder','0.2.1.9').replace('JagaKebond-0.2.1.8/app','JagaKebond-0.2.1.9/app')
 guide=guide.replace('1d02bfb329a3559640dd0c08092294a13885b4bb06e25fc1ed2c7f9d2cc5f072',sha(archive.read_bytes()))
 guide=guide.replace('No new APK is needed beyond the completed0.2.1.8 APK (versionCode11).','This revision needs the NEW0.2.1.9 APK (versionCode12), installed in place after backend deployment.')
 guide=guide.replace('0.2.1.8 reverse-geocoder revision','0.2.1.9 history-continuity revision')
 guide+='\n## Tree continuity acceptance\n\nDeploy this matching backend before installing the new private APK. Health must include `capabilities.treeContinuity: true` in addition to compatibility2.1.0. Old servers keep linked drafts on-device rather than silently losing tree identity. Verify exact backend/source/frontend hashes against VERIFICATION.json, not just the unchanged health version. Test Foto tanaman ini -> offline draft -> reconnect -> one completed result under the original tree; cancellation/account switch; Peta/Petak Saya -> Riwayat; compact Google Sans controls and unobscured shutter; identical daily display/read-aloud content. Existing geocoder key configuration remains private and required for live address lookup. No live deployment, phone acceptance or new provider-key validation was performed by the builder.\n'
 assert str(archive)in guide
 for block in re.findall(r'```bash\n(.*?)```',guide,re.S):subprocess.run(['bash','-n'],input=block,text=True,check=True)
 (OUT/'SERVER-UPGRADE.md').write_text(guide)
 (OUT/'SHA256SUMS.txt').write_text(''.join(sha(p.read_bytes())+'  '+p.name+'\n'for p in sorted(OUT.iterdir())if p.is_file()and p.name!='SHA256SUMS.txt'))
 print(json.dumps({'version':VERSION,'apk':str(destination),'source':str(archive),'manifest_files':len(files),'extracted_test_commands':len(extracted),'checks':artifacts},indent=2))
if __name__=='__main__':main()
