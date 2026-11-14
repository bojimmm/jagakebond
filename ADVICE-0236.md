# Structured crop assessments and Indonesian input references (0.2.3.6)

New analyses ask for seven bounded lists: observed findings, possible causes,
nonchemical actions, prevention, monitoring, escalation and missing information.
Model confidence is not a calibrated probability. Low-confidence causes/actions
are replaced with examination/photo requests. Product/dose/destructive instructions
are filtered from this assessment channel. Legacy action fields keep their fixed
referral fallback; old records are not re-diagnosed or charged automatically.

Assessment version1 persists from the authoritative owned job in records.extra_json,
survives edits/history/offline record caching, and renders as text-safe sections on
results, a standalone history dialog and photo viewing. The map detail sheet keeps
a short action and a link to full analysis. Sharing/speech use the structured lists.
No SQLite schema migration or API protocol bump.

An optional per-record product panel collects stage, symptom duration/extent,
location, harvest timing and previous inputs, plus optional soil information and
field-confirmation status. Server requires current disclaimer consent and owned
record access. POST /api/recommendations is the only new native bridge route;
queries/subroutes/GET remain denied. Async responses are account-generation guarded.

app/reference/indonesia-inputs.json is a versioned backend-owned reference database,
not a model answer. Initial five products: Amistar Top325SC, Anvil50SC, Score250EC,
Phonska Plus and SP-36. Source/checked date, exact crop-target mappings, manufacturer
registration claims and missing evidence are retained. Manufacturer presence is
not current registry approval or proof of local stock. SP-36 is clearly a general
composition reference, without a crop-use match. Fertilizer needs are not inferred
from leaf color. No doses or tank conversions are included in this version.

IMPORTANT LIMIT: Firecrawl could read manufacturer pages but could not retrieve
the Kementan registry. No product has verified current registration/full label,
PHI/REI and all application limits. All entries are reference-only, eligible=false;
the API returns no application recommendations even if the user checks the
disclaimer. This is a deliberate, explicit incomplete-data state, not silent
approval. A complete reviewed registry/label dataset and a validated selection
policy are required before adding application instructions in a later release.

Crop priorities are in app/reference/crop-priorities.json. Direct Firecrawl retrieval
of the BPS2025 horticulture summary and PDF contents confirmed national coverage.
The broad statistical research hit its credit cap; no invented national crop rank,
home-garden prevalence or plantation quantities are used. First wave: rice, maize,
chili, shallot, tomato, banana. Wider horticulture/plantation cohorts are a research
queue; presence in a crop list does not imply verified product coverage.

versionCode24/cachejk-v29/protocol2.1.0/schema10. Signing unchanged. Google remains
enabled per owner. Synthetic-only tests; actual model quality and phone acceptance
remain separate. Immutable older releases and real farmer data are untouched.

The IndexedDB storage fixture now uses a minimal local HTTP page, keeping real
app auth/health bootstrap traffic out of its deferred-upload network assertions.
The original persistence/retry assertions remain; browser/server close in finally.
