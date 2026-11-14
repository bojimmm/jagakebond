# Field feedback 0.2.3.3

Owner requested aligned photo/status bottoms, a daily summary based on today's
uploads, stable species labels, and no flashing icons when the desktop menu opens.

List photos are 72px. The text column is at least the same height; the status
row sits at its bottom. Both Beranda and Riwayat retain their existing actions.

Daily summaries now use the device's current local calendar day, including
midnight and daylight-saving boundaries. New AI records retain the server job's
upload time in extra_json.uploadedMs (no schema change). Earlier records fall
back to their creation time; EXIF capture dates and later edits do not move a
record into today. Manual notes without a photo are not counted as uploads.
The total counts all today's photos and uses the latest uploaded photo per plant
for its condition/status. Repeated saves preserve original creation time, and
location updates preserve the upload metadata. Upload day survives job cleanup.

The live summary appears on Beranda and at the top of Riwayat > Harian. It updates
when new analysis results are collected, at local midnight and when the app
becomes visible. Open suggestions refresh without overwriting typed notes.
Archived personal notes remain explicit snapshots; rendering creates no writes.

Known exact Ketapang/Sea Almond/Tropical Almond/Indian Almond/Terminalia catappa
aliases use Ketapang (Tropical Almond). This applies in diagnosis sanitization,
API output and offline-cached display. The prompt requests the same wording.
Unknown labels, other species and custom nicknames remain unchanged, as do
plant IDs; separate trees are never merged because their species matches.
Original stored record wording is preserved on read.

The sidebar regression reproduced SVG widths collapsing from about18px to0px
while labels re-entered during expansion. Icons now have flex:none, while text
can shrink/clip inside its row. A browser test checks every animation frame for
visibility, constant width/position and the original connected SVG nodes.

Required validation: 65 full suites (including new field API/browser suites),
Android JVM/lint/build and byte-for-byte source/APK asset validation. Focused
tests cover 320/390/1440px, midnight, new uploads, typed notes, account isolation,
delayed results, replays and alias preservation. Synthetic fixtures only.

Identity: 0.2.3.3/versionCode21/cache jk-v26/protocol2.1.0/schema10. Google stays
disabled and the Android signing configuration remains unchanged.
