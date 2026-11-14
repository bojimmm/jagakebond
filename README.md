# JagaKebond 0.2.4.28

JagaKebond records crop photos, their location and history, and an initial AI assessment that farmers can inspect and correct. The web app and Android app share the same field interface. A photo assessment is a hypothesis from visible evidence, not a confirmed field diagnosis.

This source package contains the application and build/recovery instructions. It intentionally excludes accounts, photos, databases, credentials, signing keys and machine-specific configuration. Installation data remains on the production server and its encrypted backups.

Peta uses green Sehat, yellow Waspada, and red Kritis pins. Close zoom shows a white-bordered crop thumbnail that grows as the user zooms in. Overlapping plants use a stack of up to three pin layers with the full count. Tap a stack to choose any crop.

## Stack and directories

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

The backend is a **modular monolith**: related modules run in one FastAPI process and share SQLite. Normal and fast workers are separate processes in the same application deployment. Caddy terminates HTTPS and proxies the API; systemd manages all three processes. Production currently runs without Docker. External model routing is a separately managed service and must not be restarted by this application's release.

The frontend uses plain JavaScript, local Tailwind output, shared CSS tokens, local fonts and Lucide icons. Leaflet, Geoman and Turf support maps/plot editing; EXIFR and photo helpers support import/export. These features load on demand from bundled assets. Map tiles and geographic lookup services still require connectivity; the offline shell is not an offline basemap.

Android uses Capacitor, Java, CameraX, WorkManager, location/EXIF support and Google Credential Manager. Native hooks preserve locally queued photos and use the same API ownership and account rules as the browser. No provider API key belongs in the APK.

## Main workflows

1. Sign in using the configured password or Google workflow; account approval and administration remain server-side.
2. Capture/import a photo. Keep the original separate from the display timestamp. Gallery photos can receive a manually pinned location; a current-location button recentres the map without silently moving that pin.
3. Submit an idempotent job. The server assigns the daily fast allowance: 20 admitted jobs for regular accounts, 50 for priority; later jobs use the paced normal lane. Administrators have the existing unlimited allowance. Admission, rather than successful diagnosis, consumes this allowance.
4. A worker claims a renewable, fenced lease. Triage checks usability, then diagnosis produces a strict structured result. Invalid results cannot replace the saved assessment. A validated result can retry its commit without repeating inference.
5. Riwayat groups observations by plant; Peta and plot summaries describe recorded observations and coverage. Re-analysis updates the same photo/plant record and preserves the prior result on failure. Farmer corrections remain separate from AI output.
6. Full analysis presents short coexisting pest/disease labels, inspection steps, findings, possible causes, descriptive nutrient information, monitoring and escalation. Daily notes summarize the day's uploaded observations; upload dates alone do not establish biological improvement.

The server creates a bounded, oriented JPEG inference derivative (currently up to 1024 px). The model receives minimized supporting context and same-plant history, not exact GPS/account/plot identifiers. Router aliases are configurable in the admin console; the legacy worker filename does not require a Gemini model. Provenance records provider-reported model identifiers when supplied, request metadata and input/prompt/reference hashes.

## Recommendation and evidence limits

Model-generated application/treatment text is replaced with controlled, relevant inspection tasks. Detailed findings and possible causes remain available; uncertainty does not reduce observed urgency. The chemical/fertilizer flow is consent-gated and derives targets from active recorded problems, not from alternative diagnoses or editable browser targets. Optional fields do not create a prescription.

The Indonesian product catalog contains preliminary references, not a verified registration/label database. Application eligibility remains closed; no unverified dose is provided. Firecrawl was used for research, not as a live tool in every crop analysis. Expert-labelled diagnostic benchmarking, reviewed treatment guidance and physical Android acceptance remain separate evidence requirements. See [AI-EVALUATION.md](AI-EVALUATION.md).

## Build, operate and recover

Start with [BUILD.md](BUILD.md), then [app/README.md](app/README.md) for development and [app/deploy/RELEASE-RUNBOOK.md](app/deploy/RELEASE-RUNBOOK.md) for operations. Use [DESIGN.md](DESIGN.md) for interface contracts and [QUALITY-0259.md](QUALITY-0259.md) for this release's changes and audit disposition.

Release identity is 0.2.4.28, Android versionCode 56, API compatibility 2.1.0, schema 11 and offline cache `jk-v68`. The schema migration requeues pre-existing claimed jobs so old workers cannot publish unfenced results. Deploy API and both workers together through the guarded transaction.

Production uses real directories under `/srv/sites/jagake.bond/`: `app`, immutable `runtime/venvs/sha256-<id>`, immutable `releases/<version>` and `ops`. Only application `data/` is writable by the service account. Before deployment, finish a fresh encrypted off-host backup. Publication recovery differs from snapshot restore; restoring a snapshot can discard later submissions and requires owner reconciliation/authorization.

`VERIFICATION.json` in a packaged release records actual artifact checks. It deliberately does not certify deployment, expert accuracy or phone acceptance. Production readback and rollback identifiers belong in the separate delivery record. Install APK updates over the existing app without uninstalling or clearing data.
