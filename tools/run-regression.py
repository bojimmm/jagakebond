"""Run the complete synthetic 0.2.4.28 regression against one unchanged source tree.

Set JK_TEST_PYTHON, JK_EVIDENCE_ROOT and JK_AUDIT_LABEL; results retain real exit
codes and before/after identities for all packaged source files. No production data.
"""
from pathlib import Path
import hashlib
import json
import os
import runpy
import sys

TREE = Path(os.environ.get('JK_AUDIT_TREE', Path(__file__).resolve().parents[1])).resolve()
LABEL = os.environ.get('JK_AUDIT_LABEL', 'g0259-final1')
OUT = Path(os.environ.get('JK_EVIDENCE_ROOT', TREE.parent / 'evidence'))
OUT.mkdir(parents=True, exist_ok=True)
PY = os.environ.get('JK_TEST_PYTHON', sys.executable)
TMP = Path(os.environ.get('JK_TEST_TMP', str(OUT / 'tmp')))
TMP.mkdir(exist_ok=True)
os.environ.update(JK_TEST_PYTHON=PY, JK_EVIDENCE_DIR=str(OUT / (LABEL + '-results')), PYTHONDONTWRITEBYTECODE='1', TMPDIR=str(TMP))
os.chdir(TREE)


sys.path.insert(0, str(TREE / 'tools'))
from release_source import source_hashes

def hashes():
    return source_hashes(TREE)

os.environ['NODE_PATH']=str(TREE / 'review/browser-tools/node_modules')
before_hashes = hashes()
m = runpy.run_path(str(TREE / 'review/verify_release.py'))
# verify_release.main() caps every suite at 300 s; the 0.2.2.0 screen audit walks ~120 browser states.
_orig_run = m['subprocess'].run
m['subprocess'].run = lambda *a, **k: _orig_run(*a, **{**k, 'timeout': 900})
os.environ.update(JK_FRONTEND=str(TREE / 'app/frontend'), JK_HISTORY_EVIDENCE=str(OUT / (LABEL + '-history')))
m['COMMANDS'].extend([('history-' + part, 'review/history-continuity-0219', ['node', str(TREE / 'review/browser-tools/history-browser-stable.cjs'), part])
                      for part in ['navigation', 'layout', 'drafts', 'continuity', 'daily']])
m['COMMANDS'].extend([
    ('history-daily-unit', 'review/history-continuity-0219', ['node', '--test', 'daily.test.cjs']),
    ('history-tree-sync', 'review/history-continuity-0219', ['node', '--test', 'tree-sync.test.cjs']),
    ('history-tree-api', 'review/history-continuity-0219', [PY, '-B', 'test_tree_api.py']),
])
os.environ.update(JK_AUDIT_APP=str(TREE / 'app'), JK_AUDIT_BROWSER_EVIDENCE=str(OUT / (LABEL + '-browser-fixes')))
m['COMMANDS'].extend([
    ('audit-backend', '.', [PY, '-B', str(TREE / 'tools/regression/test_backend_edges.py')]),
    ('audit-native-cancel', '.', ['node', '--test', str(TREE / 'tools/regression/native-cancel.test.cjs')]),
    ('audit-sync-validation', '.', ['node', '--test', str(TREE / 'tools/regression/sync-validation.test.cjs')]),
    ('audit-browser-fixes', '.', ['node', str(TREE / 'review/browser-tools/browser-fixes.cjs')]),
])
NEW = [
    ('0220-queue-backoff', 'app', [PY, 'tests/test_queue_backoff_0220.py']),
    ('0220-limits', 'app', [PY, 'tests/test_limits_0220.py']),
    ('0220-worker', 'app', [PY, 'tests/test_worker_0220.py']),
    ('0220-security', 'app', [PY, 'tests/test_security_0220.py']),
    ('0220-photo-lifecycle', 'app', [PY, 'tests/test_photo_lifecycle_0220.py']),
    ('0220-admin-api', 'app', [PY, 'tests/test_admin_0220.py']),
    ('0220-admin-browser', 'review/browser-tools', ['node', 'admin-0220.cjs']),
    ('0220-web-unit', 'app', ['node', '--test', 'tests/web-0220.test.cjs']),
    ('0220-web-browser', 'review/browser-tools', ['node', 'web-0220.cjs']),
    ('0220-ux-browser-audit', 'review/browser-tools', ['node', 'ux-0220.cjs']),
    ('0222-desktop-home', 'review/browser-tools', ['node', 'desktop-home-0222.cjs']),
    ('0230-google-api', 'app', [PY, 'tests/test_google_0230.py']),
    ('0230-google-browser', 'review/browser-tools', ['node', 'google-0230.cjs']),
    ('0231-public-pages', 'review/browser-tools', ['node', 'landing-0231.cjs']),
    ('0233-field-api', 'app', [PY, 'tests/test_field_0233.py']),
    ('0233-field-browser', 'review/browser-tools', ['node', 'field-0233.cjs']),
    ('0234-brand', 'app', [PY, 'tests/test_brand_0234.py']),
    ('0235-stamp', 'review/browser-tools', ['node', 'stamp-0235.cjs']),
    ('0236-advice-api', 'app', [PY, 'tests/test_advice_0236.py']),
    ('0236-advice-browser', 'review/browser-tools', ['node', 'advice-0236.cjs']),
    ('0237-map-browser', 'review/browser-tools', ['node', 'map-0237.cjs']),
    ('0238-viewer-api', 'app', [PY, 'tests/test_viewer_0238.py']),
    ('0238-viewer-browser', 'review/browser-tools', ['node', 'viewer-0238.cjs']),
]
NEW.append(('0252-tour-browser','review/browser-tools',['node','tour-0252.cjs']))  # replaces tour-0239 (card guide)
NEW.append(('0240-cards-browser','review/browser-tools',['node','cards-0240.cjs']))
NEW.append(('0241-reanalysis-api','app',[PY,'tests/test_reanalysis_0241.py']))
NEW.append(('0241-reanalysis-browser','review/browser-tools',['node','reanalysis-0241.cjs']))
NEW.append(('0245-fastlane','app',[PY,'-B','tests/test_fastlane_0245.py']))
NEW.append(('0246-reanalyze-direct','app',[PY,'-B','tests/test_reanalyze_0246.py']))
NEW.append(('0247-dialog-browser','review/browser-tools',['node','dialog-0247.cjs']))
NEW.append(('0250-riwayat-browser','review/browser-tools',['node','riwayat-0250.cjs']))
NEW.append(('0255-quality-api','app',[PY,'-B','tests/test_quality_0255.py']))
NEW.append(('0255-quality-browser','review/browser-tools',['node','quality-0255.cjs']))
NEW.append(('0256-hardening-browser','review/browser-tools',['node','hardening-0256.cjs']))
NEW.append(('0257-petak-api','app',[PY,'-B','tests/test_petak_0257.py']))
NEW.append(('0257-petak-browser','review/browser-tools',['node','petak-0257.cjs']))
os.environ['NODE_OPTIONS']='--require='+str(TREE/'review/browser-tools/tour-fixture.cjs')
NEW.append(('0259-integrity-api','app',[PY,'-B','tests/test_quality_0259.py']))
NEW.append(('0259-quality-browser','review/browser-tools',['node','quality-0259.cjs']))
NEW.append(('0259-source-staging','app',[PY,'-B','tests/test_stage_source_0259.py']))
m['COMMANDS'].extend(NEW)
expected = 49 + len(NEW)
code = m['main']()
rows = json.loads((OUT / (LABEL + '-results/results.json')).read_text())['checks']
after_hashes = hashes()
changed = sorted(k for k in set(before_hashes) | set(after_hashes) if before_hashes.get(k) != after_hashes.get(k))
summary = {'expected': expected, 'executed': len(rows), 'passed': sum(r['exit_code'] == 0 for r in rows),
           'failed': [r['name'] for r in rows if r['exit_code']], 'exit_code': code, 'source_hashes': after_hashes,
           'source_unchanged_during_tests': not changed, 'changed_during_tests': changed,
           'scope': 'Complete 0.2.4.28 source inventory; synthetic fixtures only; no expert accuracy claim'}
(OUT / (LABEL + '-summary.json')).write_text(json.dumps(summary, indent=2) + '\n')
print('REGRESSION', summary['expected'], summary['executed'], summary['passed'], summary['failed'], 'changed:', changed, flush=True)
raise SystemExit(int(code != 0 or len(rows) != expected or bool(changed)))
