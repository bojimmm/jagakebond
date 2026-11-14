"""Offline evaluation of expert labels and captured model replies. Never calls a provider.

python tools/evaluate-analysis.py --labels private/labels.jsonl --predictions private/predictions.jsonl --out report.json
"""
from __future__ import annotations
import argparse
from collections import Counter, defaultdict
import hashlib
import json
import math
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'app'))
from backend.analysis_contract import AnalysisContractError, validate_diagnosis, validate_triage
from backend.crop_names import canonical_crop_name
from backend.problem_registry import active_problem_ids


def rows(path):
    data = [json.loads(line) for line in Path(path).read_text(encoding='utf-8').splitlines() if line.strip()]
    keys = [row['caseId'] for row in data]
    if len(keys) != len(set(keys)):
        raise ValueError('Duplicate caseId')
    return {row['caseId']: row for row in data}


def rate(hits, total):
    if not total:
        return {'numerator': hits, 'denominator': 0, 'rate': None, 'wilson95': None}
    p, z = hits / total, 1.959963984540054
    denominator = 1 + z*z/total
    middle = (p + z*z/(2*total))/denominator
    half = z*math.sqrt(p*(1-p)/total + z*z/(4*total*total))/denominator
    return {'numerator': hits, 'denominator': total, 'rate': p,
            'wilson95': [max(0, middle-half), min(1, middle+half)]}


def percentile(values, fraction):
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered)*fraction)-1)]


def evaluate(labels, predictions):
    counts = Counter(); groups = defaultdict(Counter); confusion = Counter()
    latency = []; tokens = Counter(); routes = set(); problems = []
    required = {'caseId', 'splitGroupId', 'expertId', 'reviewedAt', 'usable', 'crop', 'problemIds', 'severity', 'inputHash', 'variant'}
    for case_id, label in labels.items():
        if not required <= label.keys() or label.get('expertReviewed') is not True:
            raise ValueError('Labels require an accountable expert review and input identity')
        if (type(label['usable']) is not bool or not isinstance(label['problemIds'], list)
                or label['severity'] not in ('Healthy', 'Moderate', 'Severe', 'Unknown')
                or not all(isinstance(label[k], str) and label[k].strip() for k in ('expertId','reviewedAt','splitGroupId','inputHash','variant'))):
            raise ValueError('Invalid expert label')
        if 'expectedAbstention' in label and type(label['expectedAbstention']) is not bool:
            raise ValueError('expectedAbstention must be a boolean')
        counts['cases'] += 1
        counts['usableCases'] += label['usable']
        counts['unusableCases'] += not label['usable']
        group = groups[str(label['crop']) + ' / ' + label['variant']]
        group['cases'] += 1
        reply = predictions.get(case_id)
        if not reply:
            counts['missing'] += 1; continue
        if type(reply.get('expertUnsafe')) is bool:
            counts['safetyReviewed'] += 1; counts['unsafe'] += reply['expertUnsafe']
        total_latency = reply.get('totalLatencyMs')
        if type(total_latency) in (int,float) and math.isfinite(total_latency) and total_latency >= 0:
            latency.append(total_latency)
        provenance = reply.get('provenance', {})
        if not isinstance(provenance,dict):
            raise ValueError('Prediction lacks reproducible provenance')
        if provenance.get('inputHash') != label['inputHash']:
            raise ValueError('Prediction/label input hash mismatch')
        if not all(provenance.get(k) for k in ('promptHash','referenceHash','schemaVersion','policyVersion')):
            raise ValueError('Prediction lacks reproducible provenance')
        has_usage = False
        for phase in ('triage','diagnosis'):
            meta = provenance.get(phase, {})
            if not isinstance(meta,dict):
                continue
            if meta:
                requested = meta.get('requestedRoute') if isinstance(meta.get('requestedRoute'),str) else None
                resolved = meta.get('resolvedModel') if isinstance(meta.get('resolvedModel'),str) else None
                routes.add((phase,requested,resolved))
            for key in ('inputTokens','outputTokens'):
                if type(meta.get(key)) is int and 0 <= meta[key] <= 100_000_000:
                    tokens[key] += meta[key]; has_usage = True
        counts['usageCasesReported'] += has_usage
        try:
            validate_triage(reply.get('triage'))
            triage = reply['triage']['usable']
            if triage:
                validate_diagnosis(reply.get('diagnosis'))
        except AnalysisContractError:
            counts['invalid'] += 1; continue
        counts['valid'] += 1; group['valid'] += 1
        counts['triageCorrect'] += triage == label['usable']
        counts['usableAccepted'] += label['usable'] and triage
        counts['unusableRejected'] += not label['usable'] and not triage
        if not label['usable'] and not triage:
            counts['taskCorrect'] += 1; group['pipelineCorrect'] += 1
        if label['usable'] and triage:
            diagnosis = reply['diagnosis']
            abstained = diagnosis.get('assessment', {}).get('uncertain') is True or diagnosis.get('confidence',0) < .5
            counts['assessed'] += 1; counts['abstained'] += abstained
            crop_ok = ((label['crop'] is None and label.get('expectedAbstention') is True)
                       or canonical_crop_name(diagnosis['crop']) == canonical_crop_name(label['crop']))
            predicted = set(active_problem_ids(diagnosis))
            actual = set(label['problemIds'])
            expected_abstention = label.get('expectedAbstention') is True
            if expected_abstention:
                condition_ok = abstained
            else:
                condition_ok = predicted == actual and not abstained
            counts['cropCorrect'] += crop_ok; counts['problemExact'] += condition_ok
            counts['pipelineCorrect'] += crop_ok and condition_ok
            counts['taskCorrect'] += crop_ok and condition_ok
            group['pipelineCorrect'] += crop_ok and condition_ok
            counts['problemTP'] += len(predicted & actual)
            counts['problemFP'] += len(predicted - actual)
            counts['problemFN'] += len(actual - predicted)
            if label['severity'] != 'Unknown':
                counts['severityKnownAssessed'] += 1
                counts['severityCorrect'] += diagnosis['severity'] == label['severity']
                confusion[(label['severity'], diagnosis['severity'])] += 1
    if set(predictions)-set(labels): problems.append('Predictions without labels are excluded.')
    if len(labels) < 100: problems.append('Small sample: fewer than 100 cases; subgroup evidence is especially limited.')
    if counts['safetyReviewed'] < counts['cases']: problems.append('Safety review is incomplete; no whole-dataset unsafe-advice claim is supported.')
    if not routes or any(not route[2] for route in routes): problems.append('Some provider responses did not identify the resolved model.')
    return {'cases': counts['cases'], 'missing': counts['missing'], 'invalid': counts['invalid'],
        'schemaValid': rate(counts['valid'],counts['cases']),
        'endToEndCropAndProblemExact': rate(counts['pipelineCorrect'],counts['usableCases']),
        'endToEndTaskSuccess': rate(counts['taskCorrect'],counts['cases']),
        'usablePhotoAcceptance': rate(counts['usableAccepted'],counts['usableCases']),
        'unusablePhotoRejection': rate(counts['unusableRejected'],counts['unusableCases']),
        'abstentionAmongAssessed': rate(counts['abstained'],counts['assessed']),
        'severityAccuracyAmongAssessedWithKnownTruth': rate(counts['severityCorrect'],counts['severityKnownAssessed']),
        'problemMicroPrecision': rate(counts['problemTP'],counts['problemTP']+counts['problemFP']),
        'problemMicroRecall': rate(counts['problemTP'],counts['problemTP']+counts['problemFN']),
        'expertUnsafeAmongReviewed': rate(counts['unsafe'],counts['safetyReviewed']),
        'safetyReviewed': counts['safetyReviewed'], 'latencyMs':{'n':len(latency),'p50':percentile(latency,.5),'p95':percentile(latency,.95)},
        'tokensReported':dict(tokens),'usageCasesReported':counts['usageCasesReported'],
        'routes':[{'stage':r[0],'requested':r[1],'resolved':r[2]} for r in sorted(routes,key=str)],
        'subgroups':{k:rate(v['pipelineCorrect'],v['cases']) for k,v in groups.items()},
        'severityConfusion':[{'actual':a,'predicted':p,'count':n} for (a,p),n in confusion.items()],
        'limitations':problems, 'note':'Offline estimates on this labelled set only. No production accuracy or release approval is implied.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ('labels','predictions','out'): parser.add_argument('--'+key, required=True)
    args = parser.parse_args()
    labels, predictions = rows(args.labels), rows(args.predictions)
    if not labels: raise ValueError('Empty label set')
    report = evaluate(labels,predictions)
    report['labelsHash'] = hashlib.sha256(Path(args.labels).read_bytes()).hexdigest()
    report['predictionsHash'] = hashlib.sha256(Path(args.predictions).read_bytes()).hexdigest()
    Path(args.out).write_text(json.dumps(report,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
    print('Evaluated',len(labels),'labelled cases; report saved. No provider calls were made.')


if __name__ == '__main__': main()
