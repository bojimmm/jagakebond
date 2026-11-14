"""Run isolated acceptance checks and retain each real exit code/output."""
from pathlib import Path
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

ROOT=Path(__file__).resolve().parents[1]
PYTHON=os.environ.get('JK_TEST_PYTHON',sys.executable)
COMMANDS=[
 ('foundation','app',[PYTHON,'tests/test_foundation.py']),
 ('confidence','app',[PYTHON,'tests/test_confidence_gate.py']),
 ('queue','app',[PYTHON,'tests/test_queue_hardening.py']),
 ('api-contract','app',[PYTHON,'tests/test_api_contract.py']),
 ('fast-tiers','app',[PYTHON,'tests/test_fast_tiers.py']),
 ('history-media','app',[PYTHON,'tests/test_history_media_216.py']),
 ('telemetry-217','app',[PYTHON,'tests/test_telemetry_217.py']),
 ('telemetry-hooks-218','app',[PYTHON,'tests/test_telemetry_hooks_218.py']),
 ('reverse-geocode','app',[PYTHON,'tests/test_reverse_geocode_218.py']),
 ('ui-218','review/browser-tools',['node','ui-218.cjs']),
 ('daily-log','app',['node','--test','tests/daily-log.test.cjs']),
 ('ui-217','review/browser-tools',['node','ui-217.cjs']),
 ('ui-217-parent','review/browser-tools',['node','ui-217-parent.cjs']),
 ('retry-after','app',['node','--test','tests/retry_after.test.cjs']),
 ('ui-contract','app',[PYTHON,'tests/test_ui_contract.py']),
 ('worker-transport','app',[PYTHON,'tests/test_worker_transport.py']),
 ('release-policy','app',[PYTHON,'-m','unittest','discover','-s','tests','-p','test_release_*.py','-q']),
 ('independent-release','.',[PYTHON,'-B','review/parent-independent/deployment-final-tests.py']),
 ('frontend-syntax','app',[PYTHON,'tools/check_frontend.py']),
 ('farm-membership','app',['node','--test','tests/farm-membership.test.cjs']),
 ('native-login','review/browser-tools',['node','native-login.cjs']),
 ('android-usability','review/browser-tools',['node','android-usability.cjs']),
 ('photo-draft-regression','review/browser-tools',['node','photo-draft-regression.cjs']),
 ('workflow-state','app',['node','--test','tests/workflow-state.test.cjs']),
 ('workflow-browser','review/browser-tools',['node','workflow-216.cjs']),
 ('tier-ui','review/browser-tools',['node','tier-ui.cjs']),
 ('polygon-edit','review/browser-tools',['node','polygon-edit.cjs']),
 ('location-hourly','review/browser-tools',['node','location-hourly.cjs']),
 ('native-photo-reuse','review/browser-tools',['node','native-image-reuse.cjs']),
 ('indexeddb','app',['node','tests/test_offline_browser.cjs']),
 ('http','.',[PYTHON,'review/run_http_acceptance.py']),
 ('browser','.',[PYTHON,'review/run_browser_acceptance.py']),
 ('security-ui','review/browser-tools',['node','security-ui.cjs']),
 ('offline-faults','review/browser-tools',['node','offline-faults.cjs']),
 ('account-races','review/browser-tools',['node','account-races.cjs']),
 ('responsive-a11y','review/browser-tools',['node','audit-ui.cjs']),
 ('plan-only','app',[PYTHON,'deploy/release_ops.py','deploy']),
]

def main():
 evidence=ROOT/os.environ.get('JK_EVIDENCE_DIR','review/final-evidence');evidence.mkdir(exist_ok=True,parents=True)
 results=[]
 for name,cwd,command in COMMANDS:
  started=datetime.now(timezone.utc).isoformat()
  try:
   run=subprocess.run(command,cwd=ROOT/cwd,env={**os.environ,'PYTHONDONTWRITEBYTECODE':'1','JK_TEST_PYTHON':PYTHON},capture_output=True,text=True,timeout=300)
   output=run.stdout+run.stderr;exit_code=run.returncode
  except subprocess.TimeoutExpired as error:
   output=str(error);exit_code=124
  (evidence/(name+'.log')).write_text(output)
  results.append({'name':name,'command':command,'cwd':cwd,'started_utc':started,'exit_code':exit_code,'log':name+'.log'})
  (evidence/'results.json').write_text(json.dumps({'scope':'Disposable fixtures, no production deployment or physical Android validation','checks':results},indent=2))
  print(name, 'PASS' if exit_code==0 else 'FAIL', 'exit='+str(exit_code),flush=True)
  if exit_code:print(output[-2000:],flush=True)
 return int(any(r['exit_code']for r in results))

if __name__=='__main__':raise SystemExit(main())
