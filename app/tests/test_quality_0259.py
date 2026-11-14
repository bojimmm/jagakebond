"""Synthetic behavioral contracts for result integrity, claim fencing and provider recovery."""
from __future__ import annotations
import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from backend import db,queue,assessment,problem_registry,model_probe
from backend.analysis_contract import validate_diagnosis,AnalysisContractError
spec=importlib.util.spec_from_file_location('quality_worker',ROOT/'worker/gemini_worker.py')
worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)
eval_spec=importlib.util.spec_from_file_location('quality_evaluator',ROOT.parent/'tools/evaluate-analysis.py')
evaluator=importlib.util.module_from_spec(eval_spec);eval_spec.loader.exec_module(evaluator)


def diagnosis():
    return {'crop':'Cabai','condition':'Antraknosa','severity':'Severe','confidence':.85,
        'needs_review':False,'symptoms_id':'Bercak terlihat pada buah.',
        'assessment':{'version':1,'active_conditions':['Antraknosa'],'findings':['Bercak terlihat pada buah.'],
            'possible_causes':['Dugaan antraknosa; perlu pemeriksaan langsung.'],
            'actions':['Periksa bagian buah yang berubah warna.'],'prevention':['Catat kondisi tanaman sebelum memilih tindakan.'],
            'nutrition':[],'monitoring':['Foto kembali bagian yang sama.'],'escalation':['Hubungi penyuluh bila gejala meluas.']}}


class QualityTests(unittest.TestCase):
    def setUp(self):
        self.folder=tempfile.TemporaryDirectory(prefix='jk-quality-synthetic-')
        self.old_path=db.DB_PATH;db.close_all();db.DB_PATH=Path(self.folder.name)/'fixture.sqlite3';db.migrate()
        now=db.now_ms()
        with db.transaction() as tx:
            tx.execute('INSERT INTO accounts(id,email,password_hash,created_ms,updated_ms) VALUES(?,?,?,?,?)',
                       ('quality-owner','quality@fixture.invalid','synthetic',now,now))
        worker._pending_result=None;worker._set_active_claim(None)
    def tearDown(self):
        worker._pending_result=None;worker._set_active_claim(None)
        db.close_all();db.DB_PATH=self.old_path;self.folder.cleanup()
    def new_job(self,context=None):
        now=db.now_ms();job_id=db.new_id('quality-job')
        with db.transaction() as tx:
            tx.execute('INSERT INTO jobs(id,account_id,status,created_ms,updated_ms,context_json,image_b64) VALUES(?,?,?,?,?,?,?)',
                       (job_id,'quality-owner','queued',now,now,json.dumps(context or {}),'c3ludGhldGlj'))
        return job_id
    def test_migration_is_repeatable_and_claims_are_private(self):
        self.assertEqual(db.migrate(),11)
        self.new_job();row,_=queue.claim_next('quality-worker',30)
        self.assertTrue(row['claim_token']);self.assertEqual(row['claim_generation'],1)
        self.assertNotIn('claimToken',db.row_job(row))
        self.assertEqual(db.row_job(row,include_image=True)['claimToken'],row['claim_token'])
    def test_invalid_reply_never_overwrites_existing_assessment(self):
        original={'assessment':diagnosis()['assessment'],'observedProblems':{'disease':'Dugaan manual','pest':''}}
        with db.transaction() as tx:
            tx.execute('INSERT INTO records(id,account_id,crop,condition,severity,source,extra_json,created_ms,updated_ms) VALUES(?,?,?,?,?,?,?,?,?)',
                ('quality-record','quality-owner','Cabai','Dugaan lama','Severe','ai',json.dumps(original),1,1))
        job=self.new_job({'reanalysisRecordId':'quality-record'});claim,_=queue.claim_next('quality-worker',30)
        before=db.query_one('SELECT * FROM records WHERE id=?',('quality-record',))
        with self.assertRaises(AnalysisContractError):
            queue.complete_job(job,{'usable':True,'is_plant':True,'reason':'Foto jelas.'},{},claim_token=claim['claim_token'])
        self.assertEqual(before,db.query_one('SELECT * FROM records WHERE id=?',('quality-record',)))
        self.assertEqual(db.query_one('SELECT status FROM jobs WHERE id=?',(job,))['status'],'claimed')
    def test_schema_rejects_wrong_types_empty_report_and_contradictions(self):
        validate_diagnosis(diagnosis())
        for change in ({'confidence':True},{'confidence':float('nan')},{'needs_review':'false'},{'assessment':{}},{'severity':'Healthy'}):
            data=diagnosis();data.update(change)
            with self.subTest(change=list(change)),self.assertRaises(AnalysisContractError):validate_diagnosis(data)
    def test_stale_claim_cannot_complete_or_release_new_attempt(self):
        job=self.new_job()
        with patch.object(db,'now_ms',return_value=100_000):first,_=queue.claim_next('old-worker',30)
        with patch.object(db,'now_ms',return_value=131_000):
            second,_=queue.claim_next('new-worker',30)
            self.assertEqual(second['claim_generation'],2)
            self.assertIsNone(queue.complete_job(job,{'usable':True,'is_plant':True,'reason':'Foto jelas.'},diagnosis(),claim_token=first['claim_token']))
            self.assertFalse(queue.renew_claim(job,first['claim_token'],30))
            self.assertEqual(queue.release_job(job,claim_token=first['claim_token'])['status'],'stale_claim')
            completed=queue.complete_job(job,{'usable':True,'is_plant':True,'reason':'Foto jelas.'},diagnosis(),claim_token=second['claim_token'])
            self.assertEqual(completed['status'],'done')
    def test_renewal_prevents_reclaim_but_cannot_revive_expired_lease(self):
        job=self.new_job()
        with patch.object(db,'now_ms',return_value=100_000):claim,_=queue.claim_next('worker',30)
        with patch.object(db,'now_ms',return_value=125_000):self.assertTrue(queue.renew_claim(job,claim['claim_token'],30))
        with patch.object(db,'now_ms',return_value=140_000):self.assertEqual(queue.requeue_stale(30),0)
        with patch.object(db,'now_ms',return_value=156_000):self.assertFalse(queue.renew_claim(job,claim['claim_token'],30))
    def test_all_nutrient_sections_block_application_fixtures(self):
        for nutrient in ['magnesium','boron','mangan','besi','molibdenum','nitrogen']:
            report=copy.deepcopy(diagnosis()['assessment']);report['actions']=['Berikan '+nutrient+' pada tanah setiap hari.'];report['nutrition']=['Tambahkan '+nutrient+' secara rutin.']
            cleaned=assessment.clean_assessment(report)
            self.assertTrue(cleaned['needs_review'])
            self.assertFalse(any('Berikan '+nutrient in t or 'Tambahkan '+nutrient in t for field in ('actions','nutrition') for t in cleaned[field]))
    def test_uncertainty_preserves_urgency_and_never_displays_nutrient_claim(self):
        data=diagnosis();data['confidence']=.2;data['assessment']['nutrition']=['Kekurangan Nitrogen.']
        gated=queue.apply_confidence_gate(data)
        self.assertEqual(gated['severity'],'Severe');self.assertTrue(gated['needs_review'])
        self.assertEqual(gated['assessment']['active_conditions'],[])
        self.assertNotIn('Nitrogen',' '.join(gated['assessment']['nutrition']))
    def test_retry_at_token_ceiling_runs_once_more_and_validates_schema(self):
        replies=['{}',json.dumps(diagnosis())];calls=[]
        def chat(*args,**kw):calls.append(args[3]);return replies.pop(0)
        with patch.object(worker,'_chat',side_effect=chat):
            result=worker.router_chat_json('synthetic-route','prompt','synthetic',4000,validator=validate_diagnosis)
        self.assertEqual(calls,[4000,4000]);self.assertEqual(result['crop'],'Cabai')
    def test_explicit_uncertainty_survives_cleaning_even_with_high_self_score(self):
        data=diagnosis();data['confidence']=.95;data['assessment']['uncertain']=True
        data['assessment']['nutrition']=['Kekurangan Nitrogen.']
        result=queue.apply_confidence_gate(queue.sanitize_diagnosis(data))
        self.assertTrue(result['assessment']['uncertain']);self.assertTrue(result['needs_review'])
        self.assertEqual(result['severity'],'Severe')
        self.assertEqual(result['assessment']['active_conditions'],[])
        self.assertNotIn('Nitrogen',' '.join(result['assessment']['nutrition']))
    def test_context_minimizes_location_and_identifiers(self):
        result=worker.build_context({'context':{'lat':-6.22222,'lng':106.33333,'locationName':'private-address','deviceId':'private-device','farmId':'private-plot','cropHint':'Cabai','elevation':100}})
        text=json.dumps(result)
        for private in ['-6.22222','106.33333','private-address','private-device','private-plot']:self.assertNotIn(private,text)
        self.assertEqual(result['crop_hint'],'Cabai')
    def test_failed_commit_retries_existing_result_without_new_inference(self):
        worker._set_active_claim({'id':'synthetic-job','claimToken':'x'*40})
        with patch.object(worker,'_http',side_effect=[(500,{}),(200,{})]),patch.object(worker,'refresh_config'),patch.object(worker,'post_status'),patch.object(worker,'process_job') as inference:
            self.assertFalse(worker._post_result('synthetic-job',{'usable':True},diagnosis()))
            self.assertIsNotNone(worker._pending_result)
            self.assertEqual(worker.run_cycle({}),0)
            inference.assert_not_called();self.assertIsNone(worker._pending_result)
    def test_health_retains_each_lane_failure(self):
        queue.record_worker_status({'worker':'fast','lane':'fast','authFailing':True,'lastError':'Synthetic failure'})
        state=queue.record_worker_status({'worker':'normal','lane':'normal','authFailing':False})
        self.assertTrue(state['authFailing']);self.assertEqual(len(state['workers']),2)
    def test_failed_commit_health_cannot_be_masked_by_another_lane(self):
        queue.record_worker_status({'worker':'fast','lane':'fast','hasError':True,'lastError':'Synthetic commit failure'})
        status=queue.record_worker_status({'worker':'normal','lane':'normal','hasError':False})
        self.assertTrue(status['hasError'])
        recovered=queue.record_worker_status({'worker':'fast','lane':'fast','hasError':False})
        self.assertFalse(recovered['hasError']);self.assertIsNotNone(recovered['lastError'])
    def test_targets_use_active_observations_and_never_differentials(self):
        record={'severity':'Moderate','condition':'Bulai','assessment':{'active_conditions':['Bulai'],'possible_causes':['Antraknosa tidak didukung foto.']}}
        self.assertEqual(problem_registry.active_problem_ids(record),['downy_mildew'])
        record['assessment']['active_conditions'].append('Kutu Daun')
        self.assertEqual(problem_registry.active_problem_ids(record),['downy_mildew','aphids'])
        record['assessment']['uncertain']=True
        self.assertEqual(problem_registry.active_problem_ids(record),[])
        record['observedProblems']={'disease':'Hawar Daun','pest':'Ulat'}
        self.assertEqual(problem_registry.active_problem_ids(record),['leaf_blight','caterpillar'])
    def test_inspection_checks_survive_cleaning_without_generated_treatment(self):
        raw=diagnosis()['assessment'];raw['inspection_checks']=['fruit','stem_base']
        raw['actions']=['Periksa buah, lalu berikan ramuan buatan sendiri.']
        first=assessment.clean_assessment(raw);second=assessment.clean_assessment(first)
        self.assertEqual(first['inspection_checks'],second['inspection_checks'])
        self.assertEqual(first['actions'],second['actions'])
        self.assertTrue(any('buah' in x for x in first['actions']))
        self.assertFalse(any('ramuan' in x for x in first['actions']))
    def test_synthetic_probe_checks_actual_visual_answer_and_json(self):
        expected={'background_color':'blue','shape_color':'red','shape':'circle'}
        valid={'choices':[{'message':{'content':json.dumps(expected)},'finish_reason':'stop'}],'model':'synthetic-resolved'}
        with patch.object(model_probe,'fixture',return_value=('SYNTHETIC_PNG',expected)),patch.object(model_probe,'request_json',return_value=(200,valid)) as call:
            self.assertTrue(model_probe.probe('http://localhost','SYNTHETIC_KEY','test-route')['ok'])
            self.assertNotIn('blue',call.call_args.args[1]['messages'][1]['content'][0]['text'])
            valid['choices'][0]['message']['content']='{"background_color":"red"}'
            self.assertFalse(model_probe.probe('http://localhost','SYNTHETIC_KEY','test-route')['ok'])
            valid['choices'][0]['message']['content']='{}'
            self.assertFalse(model_probe.probe('http://localhost','SYNTHETIC_KEY','test-route')['ok'])
    def test_evaluation_does_not_drop_missing_or_invalid_cases_from_denominators(self):
        label={'splitGroupId':'synthetic-plant','expertReviewed':True,'expertId':'synthetic-fixture-only','reviewedAt':'2026-11-07',
               'usable':True,'crop':'Cabai','problemIds':['anthracnose'],'severity':'Severe','inputHash':'fixture-hash','variant':'1024'}
        labels={str(i):dict(label,caseId=str(i)) for i in range(3)}
        provenance={'inputHash':'fixture-hash','promptHash':'fixture','referenceHash':'fixture','schemaVersion':'test','policyVersion':'test'}
        valid={'triage':{'usable':True,'is_plant':True,'reason':'Fixture'},'diagnosis':diagnosis(),'provenance':provenance}
        report=evaluator.evaluate(labels,{'0':valid,'1':dict(valid,diagnosis={})})
        self.assertEqual(report['missing'],1);self.assertEqual(report['invalid'],1)
        self.assertEqual(report['schemaValid']['denominator'],3)
        self.assertEqual(report['usablePhotoAcceptance']['denominator'],3)
        self.assertEqual(report['endToEndCropAndProblemExact']['numerator'],1)
        self.assertIsNone(report['expertUnsafeAmongReviewed']['rate'])
    def test_evaluation_requires_expert_labels_and_matching_image_identity(self):
        with self.assertRaises(ValueError):evaluator.evaluate({'0':{'caseId':'0'}},{})
        interval=evaluator.rate(0,3)
        self.assertAlmostEqual(interval['wilson95'][0],0)
        self.assertGreater(interval['wilson95'][1],0)
    def test_evaluation_counts_rejection_and_unsafe_invalid_output_honestly(self):
        label={'caseId':'nonplant','splitGroupId':'fixture','expertReviewed':True,'expertId':'fixture-only','reviewedAt':'2026-11-07',
               'usable':False,'crop':'Bukan Tanaman','problemIds':[],'severity':'Unknown','inputHash':'fixture','variant':'1024'}
        provenance={'inputHash':'fixture','promptHash':'fixture','referenceHash':'fixture','schemaVersion':'test','policyVersion':'test'}
        prediction={'triage':{'usable':False,'is_plant':False,'reason':'Synthetic non-plant'},'diagnosis':{},'provenance':provenance,'expertUnsafe':False}
        report=evaluator.evaluate({'nonplant':label},{'nonplant':prediction})
        self.assertEqual(report['endToEndTaskSuccess']['rate'],1)
        self.assertEqual(report['endToEndCropAndProblemExact']['denominator'],0)
        prediction['triage']={};prediction['expertUnsafe']=True
        report=evaluator.evaluate({'nonplant':label},{'nonplant':prediction})
        self.assertEqual(report['invalid'],1)
        self.assertEqual(report['expertUnsafeAmongReviewed']['rate'],1)


if __name__=='__main__':unittest.main()
