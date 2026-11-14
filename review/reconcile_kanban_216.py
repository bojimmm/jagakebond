"""Reconcile board a to existing 2.1.6 evidence, without dispatch/deployment."""
from pathlib import Path
from datetime import datetime, timezone
from collections import Counter
import subprocess
import hashlib
import json
import zipfile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'review/kanban-reconciliation-216'
OUT.mkdir(exist_ok=True)

def cli(*args):
    p = subprocess.run(['hermes', 'kanban', '--board', 'a', *args], cwd=ROOT,
                       capture_output=True, text=True, timeout=30)
    if p.returncode:
        raise RuntimeError(f'Kanban command failed: {args[0]}: {p.stderr}')
    return p.stdout

def show(task_id):
    return json.loads(cli('show', task_id, '--json'))

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

before = json.loads(cli('list', '--json'))
snapshot = OUT / 'BEFORE.json'
if snapshot.exists():
    preserved = json.loads(snapshot.read_text())
    before = preserved['cards']
else:
    preserved = {'captured_utc': datetime.now(timezone.utc).isoformat(),
                 'cards': before, 'details': {t['id']: show(t['id']) for t in before}}
    snapshot.write_text(json.dumps(preserved, indent=2))
if any(t['status'] in ('running', 'ready') for t in before):
    raise RuntimeError('Unexpected active/dispatchable work; no writes performed')

release = ROOT / 'deliverables/jagakebond-2.1.6'
results = json.loads((ROOT / 'review/final-evidence/results.json').read_text())
assert len(results['checks']) == 29 and all(x['exit_code'] == 0 for x in results['checks'])
verification = json.loads((release / 'VERIFICATION.json').read_text())
assert verification['jvm'] == {'tests': 33, 'failures': 0, 'errors': 0, 'skipped': 0}
assert sha(release / 'jagakebond-2.1.6-debug.apk') == verification['apk_sha256']
with zipfile.ZipFile(release / 'jagakebond-2.1.6-source.zip') as z:
    prefix = 'JagaKebond-2.1.6/'
    manifest = json.loads(z.read(prefix + 'SOURCE-SHA256.json'))['files']
    for name, expected in manifest.items():
        assert hashlib.sha256(z.read(prefix + name)).hexdigest() == expected, name
        if name.startswith(('app/', 'android-client/')):
            assert sha(ROOT / name) == expected, name
independent = json.loads((ROOT / 'review/parent-independent/deployment-final-results.json').read_text())
assert independent['source_sha256'] == sha(ROOT / 'app/deploy/release_ops.py')
assert independent['tests_run'] == independent['passed'] == 35
assert not independent['failures'] and not independent['errors']
collision = json.loads((ROOT / 'review/parent-independent/collision-216-final-review.json').read_text())
assert collision['passed'] is True and not collision['security_concerns'] and not collision['logic_errors']
for name, expected in collision['reviewed_sha256'].items():
    assert sha(ROOT / name) == expected, name

common = ('Parent reconciliation to the checksum-verified 2.1.6 private test candidate. '
          'Accepted scope is staged source/browser-fixture/build evidence only, NOT physical-device validation, '
          'live inference, or production rollout. Earlier reports/comments remain historical and unchanged. '
          'Evidence: deliverables/jagakebond-2.1.6/VERIFICATION.json, ARTIFACT-CHECKS.json, '
          'SOURCE-EXTRACTION-TESTS.json; review/final-evidence/results.json (29/29). ')

# Create blocked residual gates BEFORE closing any source-only handoff.
def residual(title, key, body):
    d = json.loads(cli('create', title, '--body', body, '--assignee', 'default',
                       '--workspace', 'dir:' + str(ROOT / 'app'), '--initial-status', 'blocked',
                       '--model', 'gpt-6.1-sol', '--provider', 'openai-codex',
                       '--parent', 't_63f7efe9', '--created-by', 'JimBot',
                       '--idempotency-key', key, '--max-retries', '1', '--json'))
    if isinstance(d, dict) and 'task' in d:
        task_id = d['task']['id']
    elif isinstance(d, dict) and 'id' in d:
        task_id = d['id']
    else:
        raise RuntimeError('Unexpected create response: inspect board before retry')
    current = show(task_id)
    assert current['task']['status'] == 'blocked'
    assert 't_63f7efe9' in current.get('parents', [])
    return task_id

device = residual(
    'Physical Android and live workflow acceptance — 2.1.6',
    'jk-216-physical-and-live-acceptance',
    'Human/device capability gate; do not auto-dispatch, deploy, authenticate or mutate production from a worker. '
    'Private build evidence is accepted separately. Install versionCode 8 over 2.1.5 with the same signer; '
    'do not uninstall or clear storage. Record device/Android version and APK SHA256. Verify original-owner '
    'draft retention, camera/gallery permissions and denial recovery, real GPS, manual/plot coordinates and '
    'neutral accuracy, private originals and actual EXIF Gallery export, Android 24–28 permission continuation '
    'including switch-away-and-back, Keystore storage/relaunch, offline/reload/reconnect/lost-response recovery, '
    'account isolation and WorkManager under background/Doze/reboot subject to Android limits. '
    'Local checks can begin before backend deployment. LIVE checks wait for t_6c23adde matching-backend '
    'infrastructure verification and an authorized test account/photo: submit, preserve one admission/job, '
    'recover completed/failed/cancelled outcomes, explicit delete and edits, cross-menu counts, '
    'small server JPEG with original retained locally. Synthetic diagnoses/JVM policies do not satisfy these gates. '
    'Use HANDOVER.md checklist; record real observed outcomes, not invented or assumed passes. '
    'Parent accepts only after real device/operator evidence. No Play publication or broad rollout approval.')

ui = residual(
    'Manual accessibility acceptance — 200% zoom and device layout',
    'jk-216-manual-zoom-and-layout-acceptance',
    'Residual acceptance transferred explicitly from t_1d8b6782/t_a9f8b272, not waived. '
    'Existing responsive/axe and keyboard fixture evidence is source-level only; 200% browser zoom has not '
    'been verified. Human/browser acceptance: at 200% actual browser zoom (not merely devicePixelRatio), '
    'verify login, all four views, populated history/result/error, manual-location picker and photo/draft '
    'dialogs for readable text, no lost controls/obscured content, scrollability, focus containment, Tab/Shift-Tab, '
    'Escape and restored trigger. Check real Android portrait/landscape/cutout/keyboard/navigation-bar layout. '
    'Retain screenshots plus browser/device/viewport/zoom observations. Do not claim zero axe proves zoom '
    'or physical layout. Remains blocked pending manual acceptance capability/input; no automatic coding '
    'or worker dispatch. Any reproducible defect becomes a narrowly scoped follow-up before rollout.')

accepted = {
 't_1bbd33f4': ('Durable account-isolated offline capture and web outbox — staged acceptance',
     'Web outbox, stable idempotency, receipt retention and account fences accepted from current '
     'HTTP/IndexedDB/service-worker and fault/race fixtures. No closed-browser scheduling guarantee.'),
 't_a9f8b272': ('Desktop, tablet and phone layouts — staged UI acceptance',
     f'Rendered responsive/axe and security-dialog fixtures accepted; manual zoom/device acceptance remains {ui}.'),
 't_8659649b': ('Private WorkManager APK — source/build acceptance',
     f'Final 2.1.6 APK has 33 passing JVM tests, lint/build success, 56 matching frontend assets and '
     f'same signer as 2.1.5. Actual Keystore/permissions/MediaStore/WorkManager behaviour remains {device}.'),
 't_2fba25cb': ('Administrator deploy/restore tooling — fixture acceptance',
     'Final tooling source is fingerprint-bound to 35/35 independent fixture checks plus current '
     'release-policy suite; stable runtime/rollback/journal/capacity improvements supersede early handoff. '
     'No privileged service or live restore is established; t_6c23adde retains administrator preflight/deployment.'),
 't_05e66138': ('Independent deployment tooling review — reconciled fixture acceptance',
     'Historical v1/v2 FAIL reports are preserved. Later deployment-review.md and '
     'deployment-parent-readback.md distinguish original reviewed source from final-source rerun. '
     'deployment-final-results.json matches current release_ops.py and records 35/35 with zero audit '
     'file/subprocess/network violations. Acceptance is fixture-only, not an independent privileged/live review.'),
 't_1d8b6782': ('Compiled CSS and responsive layouts — staged correction accepted',
     f'CSS selector/build and responsive regression are verified by current UI contract/browser evidence; '
     f'Escape/focus fixtures now pass. Original unverified 200% zoom criterion explicitly remains {ui}, not Done.'),
 't_46ba463d': ('Offline metadata, retries and native recovery — staged correction accepted',
     f'Old 20/21/null.lat and incomplete XSS/focus handoff superseded by current browser HTTP 25 checks, '
     f'workflow 27, account-race 5, fault 9 and hostile-data/dialog security fixtures. Native bridge fixture '
     f'is not real hardware; remaining device/live acceptance is {device}.'),
 't_63f7efe9': ('2.1.6 staged integration and private-test build acceptance',
     f'Parent accepts existing chained independent corrective review and current 29-suite integration '
     f'plus exact APK/source verification for LIMITED OWNER-SUPERVISED TESTING only. '
     f'Original physical/live/manual acceptance is split explicitly into {device}, {ui}, and '
     't_6c23adde. This source/build milestone is not the final product rollout approval.')
}

changes = []
for task_id, (title, detail) in accepted.items():
    original = preserved['details'][task_id]
    assert original['task']['status'] == 'blocked', task_id
    current = show(task_id)
    assert current['task']['status'] in ('blocked', 'done'), task_id
    assert not any(x.get('status') == 'running' for x in current.get('runs', [])), task_id
    note = common + detail + f' Residual cards: {device}, {ui}; deployment remains t_6c23adde.'
    body = original['task']['body'] + '\n\n## Parent scope reconciliation — 2.1.6\n' + note
    cli('edit', task_id, '--title', title, '--body', body)
    assert show(task_id)['task']['body'] == body
    if not any(c['body'] == note for c in show(task_id)['comments']):
        cli('comment', task_id, note, '--author', 'JimBot')
    assert show(task_id)['comments'][-1]['body'] == note
    if show(task_id)['task']['status'] != 'done':
        cli('complete', task_id, '--result', note)
    readback = show(task_id)
    assert readback['task']['status'] == 'done'
    assert readback['task']['result'] == note
    changes.append({'id': task_id, 'before': 'blocked', 'after': 'done', 'scope': detail})
    print('Accepted staged handoff:', task_id, flush=True)

# Keep the real operational gate blocked; never unblock it to a dispatcher.
deployment = show('t_6c23adde')
assert deployment['task']['status'] == 'blocked'
opsnote = ('2.1.6 board reconciliation: source/build milestone t_63f7efe9 is accepted only for the '
           'checksum-verified private candidate. This card remains BLOCKED on authorized administrator '
           'capability/maintenance acceptance, not on model routing or stale implementation. No server '
           'change was performed. The earlier 2.1.5/compatibility-2.1.0 deployment is historical, not '
           'proof of matching 2.1.6 source/schema. Next administrator action: review '
           'deliverables/jagakebond-2.1.6/SERVER-UPGRADE.md and checksum-pinned archive; verify encrypted '
           'off-host backup/restore, stable runtime, service config and guarded plan before separately '
           'authorized --execute. Read back exact deployed source/assets, schema and both service/health '
           'statuses. Health compatibility version 2.1.0 alone cannot distinguish feature releases. '
           f'Phone/live functional acceptance stays open on {device}; manual UI acceptance on {ui}. '
           'Do not close this card on a prepared script or fixture success, and do not dispatch it automatically.')
opsbody = deployment['task']['body'] + '\n\n## Current operational gate — 2.1.6\n' + opsnote
cli('edit', 't_6c23adde', '--body', opsbody)
assert show('t_6c23adde')['task']['body'] == opsbody
cli('comment', 't_6c23adde', opsnote, '--author', 'JimBot')
assert show('t_6c23adde')['comments'][-1]['body'] == opsnote

final = json.loads(cli('list', '--json'))
counts = dict(Counter(x['status'] for x in final))
assert len(final) == len(before) + 2
assert counts == {'done': 19, 'blocked': 3}, counts
assert all(show(t)['task']['status'] == 'blocked' for t in [device, ui, 't_6c23adde'])
preview = json.loads(cli('dispatch', '--dry-run', '--max', '3', '--json'))
assert not preview.get('spawned') and not preview.get('promoted')
record = {'board': 'a', 'completed_utc': datetime.now(timezone.utc).isoformat(),
          'scope': 'Board metadata/evidence only; no implementation, production, worker or profile change',
          'before_counts': dict(Counter(x['status'] for x in before)), 'after_counts': counts,
          'transitions': changes, 'new_residual_cards': {'device_live': device, 'manual_ui': ui},
          'retained_deployment_gate': 't_6c23adde', 'dispatcher_dry_run': preview,
          'evidence': {'suites': 29, 'jvm': 33, 'apk_sha256': verification['apk_sha256'],
                       'source_zip_sha256': sha(release / 'jagakebond-2.1.6-source.zip'),
                       'deployment_fixture_source_sha256': independent['source_sha256']},
          'cards': final}
(OUT / 'AFTER.json').write_text(json.dumps(record, indent=2))
report = ('# Kanban reconciliation — JagaKebond 2.1.6\n\n'
          'Board a: 20 original cards plus 2 explicit residual acceptance cards. '
          'After readback: **19 Done, 3 Blocked, none running/ready**.\n\n'
          'Eight stale handoffs were accepted only for staged implementation/fixture/build scope; '
          'original requirements/comments and negative reviews are preserved. '
          'Outstanding criteria were transferred explicitly, not silently waived.\n\n'
          + '\n'.join('- `' + c['id'] + '`: ' + c['scope'] for c in changes)
          + '\n\n## Open gates\n\n'
          + f'- `t_6c23adde`: authorized administrator matching-backend deployment and infrastructure readback.\n'
          + f'- `{device}`: physical Android and authorized live end-to-end acceptance; local tests may begin now, live checks wait for the matching backend.\n'
          + f'- `{ui}`: 200% real browser zoom and physical layout acceptance.\n\n'
          'Exact existing artifacts were checksum-verified and implementation matched the source ZIP. '
          'Saved test evidence: 29 suites, 33 JVM tests, 56 matching bundled frontend assets; '
          '35 independent deployment fixture checks fingerprint-bound to the current tooling. '
          'These are not fresh physical-device/live/privileged checks.\n\n'
          'No app source, APK, production data/service, worker dispatch or profile configuration changed. '
          'Dispatcher dry-run has no eligible work; no need to press Run Dispatcher. '
          'See BEFORE.json for the preserved original board and AFTER.json for exact readback.\n')
(OUT / 'RECONCILIATION.md').write_text(report)
for task_id in [*accepted, 't_6c23adde', device, ui]:
    cli('attach', task_id, str(OUT / 'RECONCILIATION.md'), '--name', 'KANBAN-216-RECONCILIATION.md', '--author', 'JimBot')
    attachments = json.loads(cli('attachments', task_id, '--json'))
    # Keep the exact provider readback without assuming its wrapper shape.
    (OUT / (task_id + '-attachments.json')).write_text(json.dumps(attachments, indent=2))
    assert 'KANBAN-216-RECONCILIATION.md' in json.dumps(attachments)
print(json.dumps({'counts': counts, 'residual_cards': record['new_residual_cards'],
                  'deployment': 't_6c23adde', 'report': str(OUT / 'RECONCILIATION.md')}, indent=2))
