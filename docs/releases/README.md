# Release notes

The implementation record for every change set shipped since 0.2.2.0. Each note explains
what changed, why, and — where relevant — what it deliberately does **not** claim.
Deployment, phone acceptance and diagnostic accuracy are separate evidence.

Newest first. Release identity and rollback state live in
[../operations/deployment.md](../operations/deployment.md).

| Version | Note | What changed |
| --- | --- | --- |
| 0.2.4.19 | [quality changes](v0.2.4.19-quality-changes.md) · [phone acceptance](v0.2.4.19-phone-acceptance.md) | Quality pass with audit disposition; owner device checklist |
| 0.2.4.18 | [edit plant status](v0.2.4.18-edit-plant-status.md) | Farmers can edit a photo's status, suspected disease and suspected pest |
| 0.2.4.17 | [plot summary and edit](v0.2.4.17-plot-summary-and-edit.md) | `Ringkasan petak`, plot edit sheet, species/date correction |
| 0.2.4.16 | [code hardening](v0.2.4.16-code-hardening.md) | Audit F10–F14: strict CSP, no re-assigned globals |
| 0.2.4.15 | [quality pass](v0.2.4.15-quality-pass.md) | Self-hosted error monitoring; audit items F8, F9, F15–F18 |
| 0.2.4.14 | [analysis progress](v0.2.4.14-analysis-progress.md) | Progress dialog for photos still being analysed in Riwayat |
| 0.2.4.13 | [guide and plot fixes](v0.2.4.13-guide-and-plot-sheet-fixes.md) | Owner phone fixes for the guide camera step and the plot sheet |
| 0.2.4.12 | [interactive guide](v0.2.4.12-interactive-guide.md) | Five-card modal guide replaced by an in-place guide |
| 0.2.4.11 | [Indonesian copy](v0.2.4.11-indonesian-copy.md) | KBBI wording pass and small display fixes |
| 0.2.4.10 | [Riwayat status](v0.2.4.10-riwayat-status.md) | One status control on mobile Riwayat |
| 0.2.4.9 | [assessment summary](v0.2.4.9-assessment-summary.md) | Summary rhythm, proper-case pest/disease names |
| 0.2.4.8 | [manual photo location](v0.2.4.8-manual-photo-location.md) | One current-location control in the manual location editor |
| 0.2.4.7 | [analysis dialog](v0.2.4.7-analysis-dialog.md) · [model routes](v0.2.4.7-model-routes.md) | Dialog header alignment; admin accepts non-Gemma routes |
| 0.2.4.5 | [fast lane](v0.2.4.5-fast-lane.md) | Fast queue lane; later folded into one server-chosen lane |
| 0.2.4.4 | [Riwayat layout](v0.2.4.4-riwayat-layout.md) | Full-width single-column desktop Riwayat |
| 0.2.4.3 | [coexisting findings](v0.2.4.3-coexisting-findings.md) | Pest and disease together; structured daily suggestions |
| 0.2.4.2 | [timeline camera](v0.2.4.2-timeline-camera.md) | Timeline camera target matches the tree card |
| 0.2.4.1 | [reanalysis](v0.2.4.1-reanalysis.md) | Reanalysis from the clean original; concise diagnoses |
| 0.2.4.0 | [card names and chemical gating](v0.2.4.0-card-names-and-chem-gating.md) | One short problem name per record; gated chemical references |
| 0.2.3.9 | [first-use guide](v0.2.3.9-first-use-guide.md) | Five-step guide and simpler navigation |
| 0.2.3.8 | [photo viewer](v0.2.3.8-photo-viewer.md) | Bounded report footer; historical hypotheses |
| 0.2.3.7 | [closer maps](v0.2.3.7-closer-maps.md) | Display zoom 22 and visible plot boundaries |
| 0.2.3.6 | [structured advice](v0.2.3.6-structured-advice.md) | Seven bounded output lists; confidence gating |
| 0.2.3.5 | [photo stamp](v0.2.3.5-photo-stamp.md) | Geotag stamp uses the brand PNG |
| 0.2.3.4 | [brand rollout](v0.2.3.4-brand-rollout.md) | All web and Android assets from the supplied sprout logo |
| 0.2.3.3 | [field feedback](v0.2.3.3-field-feedback.md) | Aligned photo rows, daily summary, stable species labels |
| 0.2.3.2 | [landing refinement](v0.2.3.2-landing-refinement.md) | Welcome background on the full-width gate |
| 0.2.3.1 | [public pages and login](v0.2.3.1-public-pages-and-login.md) | Privacy/terms pages and public login redesign |
| 0.2.3.0 | [brief](v0.2.3.0-google-signin-brief.md) · [contract](v0.2.3.0-google-signin-contract.md) · [security continuation](v0.2.3.0-security-continuation.md) | Google sign-in and admin registration inbox |
| 0.2.2.0 | [contract](v0.2.2.0-fix-all-contract.md) · [UX brief](v0.2.2.0-ux-brief.md) | "Fix-all" audit release: photo cleanup, UI/UX, deploy |

`0.2.4.6` has no note in this archive. Versions 0.2.4.20 → 0.2.4.27 likewise: they were
released without a note here, so the record for them is the deployment history and
[../records/](../records/), not a change description.

## Reading a note

- **Release / status** — the version the note belongs to and whether it shipped.
- Numbers in a note (`versionCode`, cache name) are those of that release, not current.
- "Validation boundary" paragraphs are not boilerplate: they say which claims the
  change does not support.