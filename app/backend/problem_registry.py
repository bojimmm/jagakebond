"""Canonical active targets shared with the generated frontend registry. No differential matching."""
import json
import re
from pathlib import Path
from functools import lru_cache


@lru_cache(maxsize=1)
def vocabulary():
    return json.loads((Path(__file__).resolve().parent.parent/'reference/problem-vocabulary.json').read_text(encoding='utf-8'))


def problem_id(value):
    if not isinstance(value,str):
        return None
    text=re.sub(r'\s+',' ',value.casefold().strip())
    text=re.sub(r'^(?:dugaan|diduga)\s+','',text)
    for item in vocabulary()['problems']:
        if any(text==alias or text.startswith(alias+' (') for alias in item['aliases']):
            return item['id']
    return None


def active_problem_ids(record):
    observed=record.get('observedProblems')
    if isinstance(observed,dict):
        values=[observed.get('disease'),observed.get('pest')]
    else:
        if record.get('observedSeverity') == 'Healthy':
            return []
        report=record.get('assessment') or {}
        confidence=record.get('confidence')
        if report.get('uncertain') or (record.get('needs_review') and type(confidence) in (int,float) and confidence<.5):
            return []
        if str(record.get('severity','')).casefold()=='healthy':
            return []
        values=report.get('active_conditions') or [record.get('condition')]
    result=[]
    for value in values:
        for part in re.split(r'\s*(?:\+|·|;)\s*',str(value or '')):
            key=problem_id(part)
            if key and key not in result:
                result.append(key)
    return result[:3]


def target_labels(ids):
    labels={p['id']:p['label'] for p in vocabulary()['problems']}
    return [labels[k] for k in ids if k in labels]
