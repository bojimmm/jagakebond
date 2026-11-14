"""Synthetic structured assessment, authority, catalog and opt-in regression."""
import os
import sys
import tempfile
import json
from pathlib import Path
from copy import deepcopy
from fastapi import HTTPException

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from backend import api_app, db, queue, input_catalog
from backend.assessment import FIELDS, clean_assessment

checks=0
def check(value):
    global checks
    assert value
    checks+=1
raw={"version":1,"active_conditions":["Antraknosa","Ulat grayak"],"findings":["Bercak pada buah cabai dan daun berlubang."],"possible_causes":["Dugaan antraknosa; periksa buah lain dan minta konfirmasi.","Dugaan ulat grayak; periksa bagian bawah daun."],
     "actions":["Periksa buah pada tanaman yang sama dan catat bagian yang berubah."],
     "prevention":["Periksa drainase petak bila genangan terlihat."],"monitoring":["Foto bagian yang sama saat memeriksa perubahan."],
     "escalation":["Minta penilaian petugas bila gejala meluas."],"missing_information":["Berapa umur tanaman dan sejak kapan gejala terlihat?"]}
for confidence in [0.8,0.2,float('nan'),True]:
    gated=queue.apply_confidence_gate(queue.sanitize_diagnosis({'crop':'Cabai','severity':'Severe','confidence':confidence,'assessment':raw}))
    check(gated['assessment']['version']==1)
    check(bool(gated['assessment']['prevention']))
    if confidence==0.8:check(gated['assessment']['guidance_scope']=='inspection-only' and any('buah' in item for item in gated['assessment']['actions']))
    else:check('Penyebab belum' in gated['assessment']['possible_causes'][0] and gated['needs_review'])
for bad in ['Gunakan Amistar Top.', 'Berikan urea.', 'Tambahkan nitrogen.', 'Berikan pupuk seimbang.', 'Campur larutan mimba.', 'Semprot fungisida 1 ml/l.', 'Tebang tanaman sekarang.']:
    item=deepcopy(raw);item['actions']=[bad]
    clean=clean_assessment(item)
    check(bad not in clean['actions'] and clean['needs_review'])
check(set(FIELDS)=={'active_conditions','findings','possible_causes','actions','prevention','nutrition','monitoring','escalation','missing_information'})
check(clean_assessment(raw)['active_conditions']==['Antraknosa','Ulat grayak'])
check(clean_assessment(raw,uncertain=True)['active_conditions']==[])
unsafe_dual=deepcopy(raw);unsafe_dual['active_conditions']=['Antraknosa','Semprot fungisida 1 ml/l.']
check(clean_assessment(unsafe_dual)['active_conditions']==['Antraknosa'] and clean_assessment(unsafe_dual)['needs_review'])
check(clean_assessment(raw)['missing_information']==raw['missing_information'])
check(clean_assessment(raw)['nutrition']==['Kekurangan hara tidak dapat dipastikan dari foto; bandingkan pola gejala antar tanaman dan lengkapi dengan uji tanah atau daun sebelum memupuk.'])
with_nutrition=deepcopy(raw);with_nutrition['nutrition']=['Dugaan kekurangan kalium: tepi daun tua menguning lalu mengering.']
check(clean_assessment(with_nutrition)['nutrition']==with_nutrition['nutrition'])
dosed=deepcopy(raw);dosed['nutrition']=['Berikan pupuk KCl 100 kg/ha setiap pekan.']
check(all('KCl' not in item for item in clean_assessment(dosed)['nutrition']) and clean_assessment(dosed)['needs_review'])
check(clean_assessment({'version':True,'actions':['a']}) is None)
check(clean_assessment({'version':1,'actions':{'bad':'value'}}) is None)
huge=deepcopy(raw);huge['findings']=['x'*1000]*100
check(len(clean_assessment(huge)['findings'])<=6 and len(clean_assessment(huge)['findings'][0])<=320)
unicode_heavy={'version':1,**{key:['🌱'*320+str(i) for i in range(6)] for key in raw if key!='version'}}
check(len(json.dumps(clean_assessment(unicode_heavy),ensure_ascii=False).encode('utf-8'))<6500)
check(queue.apply_confidence_gate({'confidence':0.99,'immediate_action':'Semprot pestisida.'})['immediate_action']==queue.GATE_REPHOTO_TEXT)

with tempfile.TemporaryDirectory(prefix='jk-advice-0236-',dir=os.environ.get('TMPDIR')) as tmp:
    db.close_all();db.DB_PATH=Path(tmp)/'fixture.sqlite3';db.migrate()
    owner={'id':'advice-a','role':'user'};other={'id':'advice-b','role':'user'};now=db.now_ms()
    with db.transaction() as tx:
        for account in [owner,other]:
            tx.execute('INSERT INTO accounts(id,email,password_hash,role,created_ms,updated_ms) VALUES(?,?,?,?,?,?)',(account['id'],account['id']+'@example.test','fixture','user',now,now))
        diagnosis=queue.apply_confidence_gate(queue.sanitize_diagnosis({'crop':'Cabai','severity':'Moderate','confidence':0.8,'assessment':raw}))
        tx.execute('INSERT INTO jobs(id,account_id,status,created_ms,updated_ms,context_json,diagnosis_json) VALUES(?,?,?,?,?,?,?)',('advice',owner['id'],'done',now,now,'{}',db.to_json(diagnosis)))
    record=api_app.create_record({'id':'record_advice','source':'ai','assessment':{'actions':['FORGED']}},account=owner)
    check(record['assessment']['actions']==clean_assessment(raw)['actions'])
    check(record['assessment']['prevention']==clean_assessment(raw)['prevention'])
    try:api_app.update_record(record['id'],{'assessment':{'version':1,'actions':['FORGED']}},account=owner);raise AssertionError('AI assessment mutation')
    except HTTPException as error:check(error.status_code==409)
    api_app.update_record(record['id'],{'observedSeverity':'Healthy'},account=owner)
    reread=next(row for row in api_app.list_records(limit=None,cursor=None,account=owner) if row['id']==record['id'])
    check(reread['assessment']['actions']==clean_assessment(raw)['actions'])
    api_app.update_record(record['id'],{'observedSeverity':'Moderate'},account=owner)
    manual=api_app.create_record({'id':'manual','crop':'Cabai','assessment':raw},account=owner)
    check(manual['assessment'] is None)
    body={'recordId':record['id'],'accepted':True,'disclaimerVersion':'id-inputs-1','problem':'anthracnose','fieldConfirmed':False,
          'growthStage':'berbuah','symptomDuration':'3 hari','affectedExtent':'2 tanaman','location':'kabupaten contoh','harvestWindow':'tidak tahu','recentInputs':'belum pernah'}
    for changes,code in [({'accepted':False},422),({'disclaimerVersion':'wrong'},422),({'growthStage':[]},422),({'location':'x'*241},422)]:
        try:api_app.input_references({**body,**changes},account=owner);raise AssertionError('Expected refusal')
        except HTTPException as error:check(error.status_code==code)
    blank=api_app.input_references({**body,'growthStage':'','symptomDuration':'','affectedExtent':'','recentInputs':'','location':'','harvestWindow':''},account=owner)
    check(blank['catalog_version'] and isinstance(blank['references'],list))
    try:api_app.input_references(body,account=other);raise AssertionError('Account isolation')
    except HTTPException as error:check(error.status_code==404)
    reply=api_app.input_references(body,account=owner)
    check(bool(reply['references']) and not reply['eligible_products'])
    tampered=api_app.input_references({**body,'problem':'FORGED'},account=owner)
    check(tampered['targets']==reply['targets'] and [r['id'] for r in tampered['references']]==[r['id'] for r in reply['references']])
    check(all(row['registration_status']=='unverified' and not row['eligible'] for row in reply['references']))
    check(all('dose' not in row and 'rate' not in row for row in reply['references']))
    unsupported=input_catalog.options({'crop':'Ketapang','needs_review':False},{**body,'problem':'sigatoka'})
    check(not unsupported['references'] and not unsupported['eligible_products'])
    nutrients=input_catalog.options({'crop':'Padi','severity':'Moderate','condition':'Kekurangan Hara','needs_review':False},{**body,'problem':'nutrition'})
    check(any(row['category']=='pupuk' for row in nutrients['references']))
    check(any(row['crop_specific'] is False for row in nutrients['references']))
    check(not nutrients['eligible_products'])
    db.close_all()
print(f'advice-0236: {checks} API/assessment/catalog assertions passed')

