"""Tree continuity using disposable DB/uploads and actual upload/record handlers."""
import asyncio
import inspect
from io import BytesIO
import os
from pathlib import Path
import sys
import tempfile
import unittest
from fastapi import UploadFile, HTTPException
from PIL import Image

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'app'))
from backend import api_app, db

class TreeContinuity(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='jk-tree219-',dir=os.environ['TMPDIR']);self.root=Path(self.temp.name)
  db.close_all();db.DB_PATH=self.root/'fixture.sqlite3';api_app.UPLOAD_DIR=self.root/'uploads';api_app.UPLOAD_DIR.mkdir();db.migrate()
  now=db.now_ms()
  with db.transaction() as tx:
   for owner in ['a','b']:
    tx.execute('INSERT INTO accounts(id,email,password_hash,created_ms,updated_ms) VALUES(?,?,?,?,?)',(owner,owner+'@fixture.invalid','synthetic',now,now))
    tx.execute('INSERT INTO records(id,account_id,crop_id,crop_name,crop,created_ms,updated_ms) VALUES(?,?,?,?,?,?,?)',('r-'+owner,owner,'tree-'+owner,'Mangga '+owner,'Mangga',now,now))
  data=BytesIO();Image.new('RGB',(32,32),(10,90,30)).save(data,format='JPEG');self.image=data.getvalue()
 def tearDown(self):db.close_all();self.temp.cleanup()
 def submit(self,tree='tree-a',key='request-219',owner='a'):
  self.assertIn('cropId',inspect.signature(api_app.analyze).parameters,'upload must retain tree identity')
  kwargs={k:None for k in inspect.signature(api_app.analyze).parameters if k not in ['image','account']}
  kwargs.update(cropId=tree,clientRequestId=key)
  return asyncio.run(api_app.analyze(image=UploadFile(filename='fixture.jpg',file=BytesIO(self.image)),account={'id':owner,'role':'user'},**kwargs))
 def test_upload_persists_owned_tree_in_job_context(self):
  result=self.submit();job=db.row_job(db.query_one('SELECT * FROM jobs WHERE id=?',(result['job_id'],)));self.assertEqual(job['context']['cropId'],'tree-a')
 def test_foreign_and_missing_tree_are_rejected_before_admission(self):
  for tree in ['tree-b','missing-tree']:
   with self.assertRaises(HTTPException) as err:self.submit(tree=tree)
   self.assertEqual(err.exception.status_code,404)
  self.assertEqual(db.query_one('SELECT COUNT(*) n FROM jobs')['n'],0)
 def test_same_tree_retry_is_same_job_changed_tree_conflicts(self):
  first=self.submit();self.assertEqual(self.submit()['job_id'],first['job_id'])
  with self.assertRaises(HTTPException) as err:self.submit(tree=None)
  self.assertEqual(err.exception.status_code,409)
 def test_recovered_result_uses_job_tree_when_client_omits_assignment(self):
  result=self.submit();now=db.now_ms()
  with db.transaction() as tx:tx.execute("UPDATE jobs SET status='done',diagnosis_json=? WHERE id=?",(db.to_json({'crop':'Mangga','condition':'Fixture only','severity':'Healthy'}),result['job_id']))
  saved=api_app.create_record({'id':'record_'+result['job_id'],'source':'ai'},account={'id':'a','role':'user'})
  self.assertEqual(saved['cropId'],'tree-a');self.assertEqual(saved['cropName'],'Mangga a')

if __name__=='__main__':unittest.main()
