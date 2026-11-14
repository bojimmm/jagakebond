"""Reconcile the private release while preserving all operational acceptance gates."""
from pathlib import Path
import hashlib,json,subprocess
ROOT=Path(__file__).resolve().parents[2]
OUT=Path(__file__).resolve().parent
REL=ROOT/'deliverables/jagakebond-0.2.1.9'
def call(*args):return subprocess.check_output(['hermes','kanban','--board','a',*args],text=True)
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
 before=json.loads(call('list','--archived','--json'));(OUT/'kanban-release-before.json').write_text(json.dumps(before,indent=2))
 assert next(t for t in before if t['id']=='t_0078ed1b')['status']=='blocked'
 source=sha(REL/'jagakebond-0.2.1.9-source.zip');apk=sha(REL/'jagakebond-0.2.1.9-debug.apk')
 notice=f'''## CURRENT ACCEPTANCE TARGET: 0.2.1.9, versionCode12
This supersedes older release labels/instructions below. Staged source, automated fixtures and private APK build accepted only. Package jagake.bond.app, same signer as0.2.1.8. Source ZIP SHA256 {source}; APK SHA256 {apk}. Current guide: {REL}/SERVER-UPGRADE.md; HANDOVER.md and VERIFICATION.json in the same directory.45/45regression suites,35JVMtests,lint/assembly,57exactAPKassets,691source-manifestfiles and3fresh-extractedtestcommands verified. Independent re-review passes exact current hashes. No production deployment, provider-key installation/validation, physical-phone or manual200%zoom acceptance performed. Do not uninstall or clear app storage. All previous deployment/backup/secret/device safeguards remain.
'''
 scopes={
 't_dd198237':('Authorized deployment + private geocoder configuration, 0.2.1.9',
  'Administrator-only gate, remain BLOCKED. Deploy this full matching backend before APK update. Verify source/served assets/services/schema8 and health capabilities.treeContinuity=true (compatibility remains2.1.0). Linked drafts must stay on-device against old servers rather than silently losing tree IDs. Configure a rotated geocoder key privately if not already configured; confirm actual authorized address/weather/elevation. Guarded deployment and verified backup/recovery authorization still required. No autonomous dispatcher deployment.'),
 't_781b5591':('Physical Android and live workflow acceptance, 0.2.1.9',
  'Owner/device gate, remain BLOCKED. Install0.2.1.9code12 in place only after matching backend. Test Peta->Petak Saya->Riwayat (no leaked sheet); grouped drafts expand/collapse/preview/edit/cancel/export/resume; Foto tanaman ini -> photo -> navigation away/back -> offline enqueue/relaunch/reconnect -> one recovered result under original tree; account isolation, retained drafts and storage; normal camera capture remains separate; slimmer Google Sans location actions; Kamera FAB must not overlap shutter. Daily display and narration must share natural factual paragraph; real voice quality/availability remains device-owned. Recheck prior unperformed permission/Keystore/WorkManager/Doze/live outcome criteria, not waived by fixtures.'),
 't_18cf0a4e':('Manual accessibility acceptance, 200% zoom and device layout, 0.2.1.9',
  'Manual capability gate remains BLOCKED. Apply existing actual200%zoom/keyboard/portrait/landscape/cutout/navigation-bar acceptance to0.2.1.9 including grouped details, compact action hit areas, paragraph/narration controls and shutter clearance. Automated viewport tests and image inspection are not a completed manual-device/zoom assessment.')}
 for ident,(title,scope)in scopes.items():
  old=next(t for t in before if t['id']==ident)
  assert old['status']=='blocked'
  call('edit',ident,'--title',title,'--body',notice+'\n'+scope+'\n\n## Historical instructions and acceptance notes\n'+old['body'])
  call('comment',ident,notice+'\n'+scope)
 result=f'Parent accepts0.2.1.9 private staged source/build ONLY.45/45 suites,35JVMtests,lint/assembly,57byte-matchedAPKassets,same signer and correctcode12,691source-manifestentries,3fresh-extractedcommands all pass. Independent final review has no findings;23parent-verifiedsource/inputhashes match. Fixes Petak sheet leak,tree-grouped drafts,factual paragraph+matching narration,compact GoogleSans actions,tree-specific camera through offline/native/backend/recovery,and shutter clearance. SourceZIP{source};APK{apk}. Frozen earlier releases preserved. Operational gates t_dd198237/t_781b5591/t_18cf0a4e now target0.2.1.9 and remain BLOCKED; no deploy/key/device/manualzoom signoff. Evidence: {OUT}/parent-acceptance.json; release:{REL}.'
 call('complete','t_0078ed1b','--result',result,'--metadata',json.dumps({'release':'0.2.1.9','source_sha256':source,'apk_sha256':apk,'regression_suites':45,'jvm_tests':35,'production_deployed':False,'physical_device_validated':False}))
 for name in ['HANDOVER.md','VERIFICATION.json','SERVER-UPGRADE.md','SHA256SUMS.txt']:
  call('attach','t_0078ed1b',str(REL/name),'--author','JimBot')
 after=json.loads(call('list','--archived','--json'));aftermap={t['id']:t for t in after};assert len(after)==len(before)
 for t in before:
  assert aftermap[t['id']]['status']==('done'if t['id']=='t_0078ed1b'else t['status']),t['id']
 for ident in [*scopes,'t_0078ed1b']:
  full=json.loads(call('show',ident,'--json'));assert full['task']['workspace_path']==str(ROOT/'app')
  (OUT/(ident+'-readback.json')).write_text(json.dumps(full,indent=2))
 for a in json.loads(call('attachments','t_0078ed1b','--json')):
  if a['filename']in ['HANDOVER.md','VERIFICATION.json','SERVER-UPGRADE.md','SHA256SUMS.txt']:
   assert Path(a['stored_path']).read_bytes()==(REL/a['filename']).read_bytes(),a['filename']
 counts={s:sum(t['status']==s for t in after)for s in sorted({t['status']for t in after})};(OUT/'kanban-release-after.json').write_text(json.dumps({'counts':counts,'tasks':after,'readback_verified':True},indent=2));print(json.dumps(counts,indent=2))
if __name__=='__main__':main()
