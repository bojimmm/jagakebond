"""Complete synthetic model reply for tests that exercise storage, not output validation."""
from copy import deepcopy


def diagnosis(**changes):
    value = {'crop':'Cabai','condition':'Bercak Daun','severity':'Moderate','confidence':.9,
             'needs_review':False,'symptoms_id':'Bercak terlihat pada daun.',
             'assessment':{'version':1,'active_conditions':['Bercak Daun'],
                'findings':['Bercak terlihat pada daun.'],'possible_causes':['Bercak daun; perlu diperiksa langsung.'],
                'actions':['Periksa permukaan atas dan bawah daun.'],'prevention':['Catat kondisi lahan.'],
                'nutrition':[],'monitoring':['Foto kembali bagian yang sama.'],'escalation':['Hubungi penyuluh bila meluas.']}}
    value.update(deepcopy(changes))
    return value
