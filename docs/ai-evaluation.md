# Evidence required for crop-analysis quality

No expert-labelled benchmark has been completed for the configured JagaKebond routes. Passing unit/browser tests or the synthetic admin image probe does not establish diagnosis accuracy. The application keeps application/product eligibility closed and distinguishes observations, possible causes and uncertainty.

## Dataset and review

Use consented photos or appropriately licensed public material. Keep photos, precise locations, account identifiers and expert label files outside the source tree and source ZIP. An agronomist should review crop identity, usable image quality, active coexisting problems, observation severity, and cases in which the photo cannot establish a cause. Record the reviewer and review date. Do not create ground truth by accepting another model's guess.

Include healthy plants, pests, diseases, nutrient-like symptoms, ambiguous/mixed cases, poor images, and non-plants. Cover common Indonesian crops, field conditions and modest phones. Keep all photos of the same plant/site in one split (`splitGroupId`) to avoid leakage. Report performance by crop and image variant rather than a single flattering aggregate. The overall sample needs a documented sampling plan; 100 cases alone is not certification.

For each case compare the current 1024 px inference derivative with an appropriate higher-resolution variant from the same original. Compare both configured normal/fast routes and triage outcomes. Freeze route/model identifiers, preprocessing parameters, prompt/reference hashes and timestamps. A router combo can change its resolved model; an alias alone is insufficient for reproducibility.

## Offline evaluator

`python tools/evaluate-analysis.py --labels /private/labels.jsonl --predictions /private/predictions.jsonl --out /private/report.json`

This command makes no model/API calls. It reports missing/invalid results, triage behavior, exact coexisting problem matches, micro precision/recall, end-to-end correctness, abstention, severity confusion, Wilson intervals, crop/variant subgroups, token usage and latency. Cost requires dated provider prices and accounting beyond reported token counts. Safety rates only cover replies actually reviewed by an expert; unreviewed replies cannot count as safe.

Each labels JSONL row requires:

```json
{"caseId":"licensed-example-001","splitGroupId":"plant-001","expertReviewed":true,"expertId":"reviewer-reference","reviewedAt":"YYYY-MM-DD","usable":true,"crop":"Cabai","problemIds":["anthracnose"],"severity":"Moderate","inputHash":"sha256-of-exact-inference-image","variant":"1024"}
```

This is a schema example, not an approved label. Replace every placeholder with genuine reviewed evidence. Problem IDs come from `app/reference/problem-vocabulary.json`; unknown problems require explicit vocabulary/review expansion instead of forced mapping.

For genuinely ambiguous photos, an expert can set `expectedAbstention: true`; use `crop: null` only when crop identity also cannot be established. Correct rejection of unusable photos counts toward overall task success, while crop/problem accuracy uses usable cases. Unsafe outputs and their reported latency/usage remain counted even when their schema is invalid.

Each predictions row requires `caseId`, the complete `triage` and `diagnosis`, and `provenance` from the tested pipeline. Optional `totalLatencyMs` must cover preprocessing through result commit. Add `expertUnsafe: true/false` only after accountable review of the displayed recommendation. Do not include credentials, raw account data or precise coordinates in evaluation reports.

## Decision record

Before making crop-accuracy claims, agree acceptance thresholds with the owner and an agronomist. Review missed severe cases, false healthy labels, unsupported nutrient claims, unnecessary treatments, abstention and subgroup gaps. Compare confidence scores against outcomes before using numerical confidence as probability or urgency. Publish limitations and record the exact tested model/prompt/reference identities. Repeat evaluation when those identities or preprocessing change.

Expert data, expert review and physical Android acceptance remain external evidence requirements. This tooling and synthetic regression coverage must never be reported as having completed them.
