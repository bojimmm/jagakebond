# Architecture

JagaKebond records crop photos, their location and history, and an initial AI assessment
that farmers can inspect and correct. The web app and the Android app share the same
field interface; the server owns accounts, records, media and the analysis queue.

- Release identity: `0.2.4.28`, Android `versionCode 56`, API compatibility `2.1.0`,
  schema `11`, offline cache `jk-v68`.

## Components

| Directory | Responsibility |
| --- | --- |
| `app/frontend/` | HTML, JavaScript and CSS field app, separate admin console, public legal pages and offline shell |
| `app/backend/` | Python FastAPI API, authentication, account approval, SQLite records, plots, queue, media and administration |
| `app/worker/` | Independent normal/fast queue consumers calling an OpenAI-compatible model gateway |
| `app/reference/` | Shared problem vocabulary and preliminary nutrient/product references |
| `app/deploy/` | Canonical systemd sources, guarded release/recovery tool and staging verifier |
| `android-client/` | Capacitor Android project, native camera/location/offline/HTTP integrations and asset synchronization |
| `review/` | Synthetic browser and integration test harnesses, pinned browser/UI build dependencies |
| `tools/` | Regression runner, source inventory, Android build/package checks, vocabulary generator and offline expert evaluator |

The backend is a **modular monolith**: related modules run in one FastAPI process and
share SQLite. Normal and fast workers are separate processes in the same application
deployment. Caddy terminates HTTPS and proxies the API; systemd manages all three
processes in the packaged layout. External model routing is a separately managed
service and must not be restarted by this application's release.

The frontend uses plain JavaScript, local Tailwind output, shared CSS tokens, local
fonts and Lucide icons. Leaflet, Geoman and Turf support maps and plot editing; EXIFR
and photo helpers support import/export. These features load on demand from bundled
assets. Map tiles and geographic lookup services still require connectivity; the
offline shell is not an offline basemap.

Android uses Capacitor, Java, CameraX, WorkManager, location/EXIF support and Google
Credential Manager. Native hooks preserve locally queued photos and use the same API
ownership and account rules as the browser. No provider API key belongs in the APK.
See [android-client/ANDROID-HANDOFF.md](../android-client/ANDROID-HANDOFF.md).

## Map and history model

Peta uses green Sehat, yellow Waspada and red Kritis pins. Close zoom shows a
white-bordered crop thumbnail that grows as the user zooms in. Overlapping plants use a
stack of up to three pin layers carrying the full count; tapping a stack lets the user
choose any crop. Riwayat groups observations by plant rather than by upload date.

## Main workflows

1. Sign in using the configured password or Google workflow; account approval and
   administration remain server-side.
2. Capture or import a photo. Keep the original separate from the display timestamp.
   Gallery photos can receive a manually pinned location; a current-location button
   recentres the map without silently moving that pin.
3. Submit an idempotent job. The server assigns the daily fast allowance: 20 admitted
   jobs for regular accounts, 50 for priority; later jobs use the paced normal lane, and
   administrators keep an unlimited allowance. Admission, not successful diagnosis,
   consumes the allowance.
4. A worker claims a renewable, fenced lease. Triage checks usability, then diagnosis
   produces a strict structured result. Invalid results cannot replace the saved
   assessment, and a validated result can retry its commit without repeating inference.
5. Riwayat groups observations by plant; Peta and plot summaries describe recorded
   observations and coverage. Re-analysis updates the same photo/plant record and
   preserves the prior result on failure. Farmer corrections remain separate from AI
   output.
6. Full analysis presents short coexisting pest/disease labels, inspection steps,
   findings, possible causes, descriptive nutrient information, monitoring and
   escalation. Daily notes summarize the day's uploaded observations; upload dates alone
   do not establish biological improvement.

## AI pipeline

The server creates a bounded, oriented JPEG inference derivative (currently up to
1024 px). The model receives minimized supporting context and same-plant history, not
exact GPS, account or plot identifiers. Router aliases are configurable in the admin
console; the legacy worker filename does not require a Gemini model. Provenance records
provider-reported model identifiers when supplied, request metadata and
input/prompt/reference hashes.

Model-generated application/treatment text is replaced with controlled, relevant
inspection tasks. Detailed findings and possible causes remain available; uncertainty
does not reduce observed urgency. The chemical/fertilizer flow is consent-gated and
derives targets from active recorded problems, not from alternative diagnoses or
editable browser targets. Optional fields do not create a prescription.

The Indonesian product catalog contains preliminary references, not a verified
registration or label database. Application eligibility remains closed and no
unverified dose is provided. Expert-labelled diagnostic benchmarking, reviewed
treatment guidance and physical Android acceptance remain separate evidence
requirements — see [ai-evaluation.md](ai-evaluation.md).

## Limits that must not be papered over

- An assessment is a hypothesis from visible evidence, not a confirmed field diagnosis.
- Model confidence is not a calibrated probability and is never shown as one.
- Counts on Peta describe recorded observations, not the health of unobserved plants.
- A passing regression, browser suite or synthetic image probe does not establish
  diagnostic accuracy.

## Further reading

- [design.md](design.md) — interface direction, tokens, states, content boundaries.
- [operations/deployment.md](operations/deployment.md) — how the app is deployed.
- [releases/](releases/) — what changed in each release and why.
- [../BUILD.md](../BUILD.md) — building, testing and packaging.