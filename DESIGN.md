# JagaKebond interface direction

JagaKebond helps farmers keep a photo history of a plant, inspect changes, and locate those observations within a plot. The interface should make the next useful action clear, keep observations separate from guesses, and recover visibly from interrupted work.

## Identity and presentation

Keep the supplied sprout logo, Google Sans, green primary action, magenta plot boundary, and text-plus-color plant statuses. Use `app/frontend/design-tokens.css` as the shared palette, spacing, radius and layer source. `ui-kit.css` owns controls; feature CSS owns feature layout. Avoid new local color palettes, decorative gradients, floating rotated screenshots, and redundant status cards.

- Body text 15 px; secondary text at least 13 px. Section headings are one step above their content.
- Controls have a minimum 44 px target. Use 8 px corners for controls and 12 px for cards/dialogs. Circles remain appropriate for camera, location markers and status dots.
- Use green for the primary action; Kritis, Waspada, Sehat and Perlu Dicek always include words. Never imply a precise diagnostic probability from a model's uncalibrated confidence.
- Product previews must show the current app and be labelled Data contoh. They are evidence of the workflow, not decoration.

## Workflow hierarchy

Beranda answers what is recorded and where the user is. Riwayat groups photos by plant and exposes filters before results. Peta adds spatial context; counts describe recorded observations, not the health of unobserved plants. A full report starts with the shared short suspected problem and the next inspection steps, then presents findings, differentials and supporting detail.

Keep disease and pest together when both are supported. Alternative diagnoses never become the main label or a product target. Farmer corrections remain distinguishable from AI output. Re-analysis stays on the same record, preserves the previous result on failure, and shows the actual queue/stage state.

## Interaction ownership and states

Build a component's final markup in its own module. Do not rewrite another component by matching its prose. Expose an explicit hook when coordination is necessary. Keep report text selectable and offer copying.

Every write needs a pending state and an error inside the active surface, preserving input. Closed sheets are inert and hidden from accessibility APIs. Dialogs include native summaries in their focus loop and exclude collapsed contents. Restore focus to the opener. Geolocation failure must replace waiting text with an actionable state. Network retries must preserve account-generation guards.

Load map and photo libraries on demand from pinned local assets; keep them available in the offline shell and Android bundle. Respect reduced motion. Validate mobile portrait, landscape, desktop, keyboard-only use and synthetic network failure before release.

## Content boundaries

Use short Indonesian labels and concrete steps. Avoid repeated generic paragraphs, speculative plot-wide spread/humidity claims, and unsupported product eligibility. Describe the current catalog as preliminary manufacturer references. Filling optional fields does not create a personalized prescription. Show uncertainty and evidence limitations where they affect a decision; keep technical provenance in optional detail.

The synthetic capability probe establishes basic image/JSON behavior. It does not establish crop diagnostic accuracy. Expert-labelled evaluation and reviewed crop/problem guidance are separate evidence requirements.
