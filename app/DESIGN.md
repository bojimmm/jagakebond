# JagaKebond UI direction

## Reference adaptation

The supplied desktop reference uses a wide white canvas, promotional image collage at left, a narrow sign-in panel at right, and a thin divider. The JagaKebond sign-in keeps that hierarchy but uses supplied Jaga field/crop artwork, green brand accents, and Indonesian copy. No Meta/Facebook marks, social-feed imitation, or affiliation claims are used. At narrow viewports the brand panel is hidden and the form takes priority.

## Layout states

- Phone (<768px): full-viewport application, single-column content, four existing bottom destinations and a pinned camera capture flow. Camera frame keeps its measured 3:4 ratio; controls remain reachable. Zoom remains user-controlled.
- Tablet (768–1023px): full-viewport workspace with two-column home/history content and persistent horizontal four-tab navigation.
- Desktop (>=1024px): flat, full-height workspace with persistent left navigation, separate header/sync band, three-column dashboard composition, and a master-detail history grid. No handset bezel or mobile bottom bar.

## Typography, contrast and interaction

The UI uses the owner-requested Google Sans with system sans-serif fallback, bundled as a Latin WOFF subset (SIL Open Font License 1.1). Upstream commit, original and derived hashes, licence and trademark notice are retained in `frontend/vendor/fonts/google-sans/`. Inputs have explicit borders, readable placeholders and visible keyboard focus. Authentication secondary text and green-on-white copy use darker colors; touch controls have a 44px minimum target. Reduced-motion preferences are respected. Rounded UI corners stay compact (4–6px for controls).

## Bundled front-end dependencies

Runtime dependencies are pinned and served locally: Tailwind CSS 3.4.17 (MIT, compiled CSS), Lucide 0.468.0 (ISC UMD), Leaflet 1.9.4 (BSD-2-Clause JS/CSS/images), and Exifr 7.1.3 (MIT UMD). The existing Leaflet-Geoman and Turf files remain in `frontend/vendor/`. License copies and package version metadata are under `frontend/vendor/`. Build tool package manifest/lockfile and Tailwind config are under `../review/ui-build/` and `app/tools/`.

Rebuild Tailwind from app root:

`../review/ui-build/node_modules/.bin/tailwindcss -c tools/tailwind.config.cjs -i tools/tailwind.input.css -o frontend/vendor/tailwind.generated.css --minify`

The Tailwind config scans index.html, app.js (including template-literal utility usage), admin.html and styles.css; an explicit safelist covers runtime-generated color and arbitrary-value utility classes. No remote CSS/JS/font is required for the static page shell to render.

## Offline and map limits

Bundling boot dependencies removes runtime CDN dependence, but does not itself guarantee offline operation. The versioned HTML and all boot dependencies are included in the service-worker install cache; dynamically fetched map tiles and account/API data are separate network dependencies. Do not pre-cache map tiles or claim offline maps. The current basemap is OpenStreetMap standard with linked attribution. The service worker does not cache or prefetch tiles. No geographic metrics or diagnosis efficacy claims are added by this layout work.
