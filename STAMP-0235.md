# Photo stamp 0.2.3.5

The geotag stamp loads the current supplied JagaKebond PNG instead of drawing JK.
Capture/import results, history viewing and gallery export use the same renderer.
Crop aliases and observed status match the current record. Each render owns its
canvas, loads the logo with a bounded timeout, and preserves account-generation
guards. Missing logo/image fails safely rather than claiming an updated stamp.

Imports preserve EXIF capture time and GPS. Missing capture time stays explicitly
unknown; a separate Ditambahkan/Diekspor timestamp states the actual added/export
time. Missing GPS is never replaced by the device's current location. EXIF zone
uncertainty and manual time are labelled. Epoch0 remains a valid capture time.
New AI records persist capture-time provenance in existing extra_json (no schema
change); legacy timestamp ordering remains compatible.

New private archives keep originals rather than burned-in result images. A stamp
is rendered transiently for viewing/export, without replacing originals. Old
already-stamped copies are refreshed from the owned server original when online.
If that original is unavailable, viewing can retain the old copy; export asks
for the original rather than double-stamping or falsely claiming a new logo.
Rendered cache is bounded, cleared on account changes and photo deletion.

Browser/native gallery export accepts a rendered JPEG without overwriting the
private original. Android validates encoded/decoded size, JPEG header/dimensions,
metadata, owner/generation and permission/publish boundaries. No signing change.

Focus:11 browser checks (including imports without EXIF, zeroGPS, epoch0, actual
logo drawing, server-only history, native export payload, deletion and account
changes) and four JVM payload checks. Full required67 suites, Android157 tests,
source/APK and native-brand verification. versionCode23/cachejk-v28/schema10/
protocol2.1.0. Google remains disabled. Synthetic fixtures only.
