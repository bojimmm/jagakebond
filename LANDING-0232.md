# Landing refinement 0.2.3.2

The welcome background now belongs to the full-width gate. The centered brand
panel is transparent, so its left edge cannot create a color discontinuity.
Phones retain their plain white sign-in surface.

The two decorative HTML cards are replaced by browser screenshots of the actual
app, rendered from app/frontend with the existing synthetic API fixtures. No
production accounts, real photos, farmer records or credentials were accessed.
Visible captions say “Data contoh”. The farmer illustration is unchanged.

Reproduce: in review/browser-tools, run:
`node ux-screens-0220.cjs --landing-assets --out <new-evidence-folder>`
It captures the real Beranda viewport (390x844, DPR2, clip x0/y56/390x276)
and the real `.tl-hero` after `openTreeTimeline('tree_cabai1')`.
The PNG bytes are copied directly; no repainting or image generation is used.
Full frames and provenance JSON remain in the sandbox g0232-landing-assets folder.
The existing screenshot harness's --only dependencies are unchanged.

Both screenshots and the farmer image download only on desktop, and are cached
on demand rather than mandatory service-worker install downloads.
Identity: versionCode20, cache jk-v25, protocol2.1.0, schema10. Existing Android
signer/config unchanged. Google remains disabled per owner instruction.

Screenshot SHA-256:
- landing-app-home.png: `099b5d035225236c845bccff1fb2c9b0bcd70a9e21fae98935cd5deb36bda820`
- landing-app-history.png: `dc85c6e4ee268a4f5d64630ec042826ad06f5dfd90d2d3687f65f52502f91bbf`
