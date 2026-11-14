"""Synthetic-only API regression for crop aliases and stable upload-day metadata."""
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend import api_app, db, queue
from backend.crop_names import canonical_crop_name

with tempfile.TemporaryDirectory(prefix='jk-field-0233-', dir=os.environ.get('TMPDIR')) as tmp:
    db.close_all()
    db.DB_PATH = Path(tmp) / 'fixture.sqlite3'
    db.migrate()
    now = 1793275200000
    owner = {'id': 'synthetic-a', 'role': 'user'}
    other = {'id': 'synthetic-b', 'role': 'user'}
    with db.transaction() as tx:
        for account in (owner, other):
            tx.execute('INSERT INTO accounts(id,email,password_hash,role,created_ms,updated_ms) VALUES(?,?,?,?,?,?)',
                       (account['id'], account['id']+'@example.test', 'fixture', 'user', now, now))
    expected = 'Ketapang (Tropical Almond)'
    for alias in ['Ketapang (Sea Almond)', 'Ketapang (Tropical Almond)', 'Sea Almond', 'Terminalia catappa', ' ketapang (INDIAN ALMOND) ']:
        assert canonical_crop_name(alias) == expected
        assert queue.sanitize_diagnosis({'crop': alias})['crop'] == expected
    for label in ['Almond', 'Ketapang depan rumah', 'Ketapang Kencana', 'Ketapang (unknown)', 'Pisang (Banana)']:
        assert canonical_crop_name(label) == label
    with patch.object(db, 'now_ms', return_value=now):
        for ident, alias in [('a','Ketapang (Sea Almond)'), ('b','Ketapang (Tropical Almond)')]:
            got=api_app.create_record({'id':ident,'cropId':'plant-'+ident,'crop':alias,'cropName':alias},account=owner)
            assert got['crop'] == got['cropName'] == expected
            assert got['uploadedMs'] == got['createdMs'] == now
        custom=api_app.create_record({'id':'custom','crop':'Sea Almond','cropName':'Ketapang depan rumah'},account=owner)
        assert custom['cropName'] == 'Ketapang depan rumah'
        api_app.create_record({'id':'foreign','crop':'Sea Almond'},account=other)
    rows=api_app.list_records(limit=None,cursor=None,account=owner)
    assert len(rows)==3 and all(row['id']!='foreign' for row in rows)
    assert {row['cropId'] for row in rows if row['id'] in ('a','b')} == {'plant-a','plant-b'}
    # Display canonicalization preserves the original stored wording and existing plant identity.
    assert db.query_one('SELECT crop FROM records WHERE id=?',('a',))['crop']=='Ketapang (Sea Almond)'
    with patch.object(db,'now_ms',return_value=now+86400000):
        edited=api_app.update_record('a',{'condition':'Sehat'},account=owner)
        assert edited['updatedMs']==now+86400000 and edited['uploadedMs']==now
        replay=api_app.create_record({'id':'a','cropId':'plant-a','crop':'Sea Almond'},account=owner)
        assert replay['createdMs']==replay['uploadedMs']==now
    # An upload whose analysis finishes tomorrow still belongs to its original upload day.
    with db.transaction() as tx:
        tx.execute('INSERT INTO jobs(id,account_id,status,created_ms,updated_ms,context_json,diagnosis_json) VALUES(?,?,?,?,?,?,?)',
                   ('job-late',owner['id'],'done',now,now+86400000,db.to_json({'cropId':'late','photoTimestampMs':0}),
                    db.to_json({'crop':'Ketapang (Sea Almond)','severity':'Healthy','confidence':0.95})))
    with patch.object(db,'now_ms',return_value=now+86400000):
        late=api_app.create_record({'id':'record_job-late','source':'ai'},account=owner)
        assert late['uploadedMs']==now and late['createdMs']==now+86400000 and late['timestampMs']==0
        assert late['crop']==expected
        assert late['captureTimeKnown'] is True and late['photoTimestampMs']==0
        located=api_app.update_record(late['id'],{'lat':-6.2,'lng':106.8,'locationSource':'manual'},account=owner)
        assert located['uploadedMs']==now and located['locationSource']=='manual'
        api_app.update_record(late['id'],{'observedSeverity':'Moderate'},account=owner)
        with db.transaction() as tx:
            tx.execute('DELETE FROM jobs WHERE id=?',('job-late',))
        persisted=api_app.list_records(limit=None,cursor=None,account=owner)
        assert next(row for row in persisted if row['id']==late['id'])['uploadedMs']==now
    with db.transaction() as tx:
        tx.execute('INSERT INTO jobs(id,account_id,status,created_ms,updated_ms,context_json,diagnosis_json) VALUES(?,?,?,?,?,?,?)',
                   ('job-import-unknown',owner['id'],'done',now,now,'{}',db.to_json({'crop':'Pisang','severity':'Healthy','confidence':0.95})))
    unknown=api_app.create_record({'id':'record_job-import-unknown','source':'ai'},account=owner)
    assert unknown['captureTimeKnown'] is False and unknown['photoTimestampMs'] is None
    assert unknown['uploadedMs']==now
    db.close_all()
print('field-0233: API aliases, account isolation, upload time, edits, replays and delayed results PASS')
