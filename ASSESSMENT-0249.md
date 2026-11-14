# Assessment summary refinements — 0.2.4.9 candidate

The analysis summary now uses a tighter vertical rhythm between the pest/disease name and the initial-assessment note. For suspected pest/disease results, `Dugaan Hama / Penyakit` increases from 16 px to 17 px, and the name increases from 15 px to 16 px. The healthy-state `Penilaian Tanaman` sizing stays unchanged. The unused lower padding and note gap are reduced.

Pest and disease names are normalized to proper case word by word across shared result labels. For example, `Hawar daun` becomes `Hawar Daun`, and `Hama penggerek` becomes `Hama Penggerek`. When active pest and disease findings coexist, each name is formatted separately and shown together.

The Android WebView asset mirror was synchronized. This is a source candidate for Android versionCode 37, cache `jk-v43`; production remains on 0.2.4.8 until release verification and deployment.