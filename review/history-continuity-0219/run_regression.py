"""Run release regressions from a disposable source copy, preserving all old evidence."""
from pathlib import Path
import json, os, shutil, subprocess, tempfile, hashlib
ROOT=Path(__file__).resolve().parents[2]
OUT=Path(__file__).resolve().parent/'regression'
OUT.mkdir(exist_ok=True)
PY='/opt/jagakebond/venv/bin/python'
hashes={str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in (ROOT/'app/frontend').glob('*') if p.is_file()}
hashes['app/backend/api_app.py']=hashlib.sha256((ROOT/'app/backend/api_app.py').read_bytes()).hexdigest()
with tempfile.TemporaryDirectory(prefix='jk219-regression-',dir=os.environ['TMPDIR']) as temp:
 tree=Path(temp)
 shutil.copytree(ROOT/'app',tree/'app',ignore=shutil.ignore_patterns('.env','data','.git','__pycache__','venv','node_modules'))
 review=tree/'review';review.mkdir()
 for p in (ROOT/'review').glob('*.py'):shutil.copy2(p,review/p.name)
 for folder in ['browser-tools','ui-build','parent-independent','history-continuity-0219']:
  shutil.copytree(ROOT/'review'/folder,review/folder,ignore=shutil.ignore_patterns('node_modules','before','evidence','regression','*.log','*.json','*.png'))
 (review/'browser-tools/node_modules').symlink_to(ROOT/'review/browser-tools/node_modules')
 for p in (ROOT/'review/ui-build').glob('*.json'):shutil.copy2(p,review/'ui-build'/p.name)
 (review/'ui-build/node_modules').symlink_to(ROOT/'review/ui-build/node_modules')
 (tree/'android-client').symlink_to(ROOT/'android-client')
 for name in ['final-evidence','screenshots']:(review/name).mkdir(exist_ok=True)
 code="""import runpy,sys
m=runpy.run_path(sys.argv[1]);py=sys.argv[2]
m['COMMANDS'].extend([('history-'+slice,'review/history-continuity-0219',['node','browser.cjs',slice]) for slice in ['navigation','layout','drafts','continuity','daily']])
m['COMMANDS'].extend([('history-daily-unit','review/history-continuity-0219',['node','--test','daily.test.cjs']),('history-tree-sync','review/history-continuity-0219',['node','--test','tree-sync.test.cjs']),('history-tree-api','review/history-continuity-0219',[py,'-B','test_tree_api.py'])])
raise SystemExit(m['main']())
"""
 run=subprocess.run([PY,'-c',code,str(review/'verify_release.py'),PY],cwd=tree,env={**os.environ,'JK_TEST_PYTHON':PY,'JK_EVIDENCE_DIR':str(OUT),'PYTHONDONTWRITEBYTECODE':'1'})
 shutil.copytree(review,OUT/'fixture-output',ignore=shutil.ignore_patterns('node_modules','*.py','*.cjs','package*.json'),dirs_exist_ok=True)
 rows=json.loads((OUT/'results.json').read_text())['checks']
 summary={'expected_suites':45,'executed':len(rows),'passed':sum(r['exit_code']==0 for r in rows),'failed':[r['name'] for r in rows if r['exit_code']],'exit_code':run.returncode,'source':str(ROOT/'app'),'source_hashes':hashes,'scope':'Disposable copied source and synthetic real-browser/API fixtures. No production/device validation.'}
 (OUT/'summary.json').write_text(json.dumps(summary,indent=2));print(json.dumps(summary,indent=2))
 raise SystemExit(int(run.returncode!=0 or len(rows)!=45))
