"""Synthetic-only: historical hypotheses stay distinct, sanitized and server-owned."""
import json
import os
import sys
import tempfile
from pathlib import Path
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend import api_app, db, queue
from backend.assessment import clean_previous_condition

checks = 0
def check(ok):
    global checks
    assert ok
    checks += 1

for raw in [None, True, 5, {}, [], '', '   ', 'Gunakan Amistar Top.', 'Semprot fungisida 1 ml/l.']:
    check(clean_previous_condition(raw) is None)
check(clean_previous_condition(' Dugaan ulat grayak\n(Spodoptera sp.) ') == 'Dugaan ulat grayak (Spodoptera sp.)')
check(len(clean_previous_condition('x' * 999)) == 240)

with tempfile.TemporaryDirectory(prefix='jk-viewer-0238-', dir=os.environ.get('TMPDIR')) as tmp:
    db.close_all(); db.DB_PATH = Path(tmp) / 'fixture.sqlite3'; db.migrate()
    now = db.now_ms(); owner = {'id':'viewer-a','role':'user'}
    with db.transaction() as tx:
        tx.execute('INSERT INTO accounts(id,email,password_hash,role,created_ms,updated_ms) VALUES(?,?,?,?,?,?)', (owner['id'],'fixture@example.test','fixture','user',now,now))
        raw = {'crop':'Cabai','condition':'Kerusakan daun','severity':'Moderate','confidence':0.8,
               'assessment':{'version':1,'possible_causes':['Dugaan ulat pemakan daun.'],'findings':['Lubang pada daun.'],'actions':['Periksa bagian bawah daun.']}}
        diagnosis = queue.apply_confidence_gate(queue.sanitize_diagnosis(raw))
        tx.execute('INSERT INTO jobs(id,account_id,status,created_ms,updated_ms,context_json,diagnosis_json) VALUES(?,?,?,?,?,?,?)', ('viewer',owner['id'],'done',now,now,'{}',db.to_json(diagnosis)))
    record = api_app.create_record({'id':'record_viewer','source':'ai'}, account=owner)
    check(record['previousCondition'] is None)
    before_assessment = record['assessment']
    row = db.query_one('SELECT extra_json FROM records WHERE id=?', (record['id'],))
    extra = json.loads(row['extra_json']); extra['previousCondition'] = 'Dugaan ulat grayak (Spodoptera sp.)'
    with db.transaction() as tx:
        tx.execute('UPDATE records SET extra_json=? WHERE id=?', (db.to_json(extra),record['id']))
    r = db.row_record(db.query_one('SELECT * FROM records WHERE id=?', (record['id'],)))
    check(r['condition'] == 'Kerusakan daun')
    check(r['previousCondition'] == extra['previousCondition'])
    check(r['assessment'] == before_assessment)
    r = api_app.update_record(record['id'], {'observedSeverity':'Healthy'}, account=owner)
    check(r['previousCondition'] == extra['previousCondition'] and r['assessment'] == before_assessment)
    try:
        api_app.update_record(record['id'], {'previousCondition':'FORGED'}, account=owner)
        raise AssertionError('Historical AI field was editable')
    except HTTPException as error:
        check(error.status_code == 409)
    manual = api_app.create_record({'id':'manual-viewer','crop':'Cabai','previousCondition':'FORGED'}, account=owner)
    check(manual['previousCondition'] is None)
    for bad in [None, {'bad':True}, 'Berikan urea.']:
        extra['previousCondition'] = bad
        with db.transaction() as tx:
            tx.execute('UPDATE records SET extra_json=? WHERE id=?', (db.to_json(extra),record['id']))
        check(db.row_record(db.query_one('SELECT * FROM records WHERE id=?', (record['id'],)))['previousCondition'] is None)
print(f'viewer-0238: {checks} historical-hypothesis assertions passed')
