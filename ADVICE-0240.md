# Card names, structured report and gated chemical references (0.2.4.0)

Every card, list, map sheet and photo viewer now shows ONE short pest/disease
name per record. `JagaAssessment.label()` in assessment-ui.js owns that wording:
it prefers the first structured `possible_causes` entry, drops the leading
"Dugaan", keeps the name clause before `;`, `:` or `·`, and caps the result at
60 characters. A damage description stored in the legacy `condition` column is
used only when no structured analysis exists, so old and new records agree
across Beranda (carousel, Perlu perhatian), Riwayat (tree card, timeline), the
map sheet, the scan result card and the full-size photo viewer.

The structured report lists seven sections in proper case: Temuan pada Foto,
Dugaan Penyebab, Rekomendasi Tindakan, Rekomendasi Pencegahan, Dugaan
Kekurangan Hara, Pemantauan Lanjutan and Kapan Perlu Bantuan. Bullets replace
the numbered list, and the unrendered `missing_information` list is gone from
every displayed report, shared text and speech output. The backend still stores
and sanitizes it, so no data is lost.

Nutrition is now a first-class analysis field. The diagnose prompt asks for a
`nutrition` list beside the other six, limits `condition` to a 60-character
name, and receives a compact symptom reference built from
`app/reference/nutrient-deficiency.json`. That file records deficiency
signatures for N, P, K, Ca, Mg, S, Fe, Mn, Zn, B, Cu and Mo collected from
Indonesian extension material (JICA with Ditjen Hortikultura, Kementerian
Pertanian; BBPP Kupang, BPSDMP) plus the Kementerian Pertanian paddy fertilizer
recommendation that ties N to leaf greenness and P/K to soil status. It carries
no brand, dose or schedule: the reference-only limitation of the chemical
catalog is unchanged and `clean_assessment` still strips product and
application advice from every field.

Tinjau opsi kimia / pupuk now opens with the terms box: the long limitation
notice and both checkboxes appear first, the land form and its submit button
stay hidden until the required checkbox is ticked, and the "Sasaran yang ingin
ditinjau" dropdown is gone. The target is derived from the record analysis
(anthracnose, leaf spot, sigatoka, blast, early/late blight, nutrition or
unknown) and shown as read-only text beside a hidden `problem` field, so the
request cannot carry a target the photo analysis does not support.

Release 0.2.4.0 / versionCode 28 / cache jk-v33 / protocol 2.1.0 / schema 10.
No migration, no farmer-data access and no DNS change. Existing tutorial,
map/zoom, photo viewer, brand, daily summary and Google sign-in behaviour is
unchanged; the chemical reference limitation is preserved.