/* JagaKebond bilingual localization runtime (Bahasa Indonesia default + English toggle).
   Always defaults to 'id' on first visit regardless of browser locale, persists in localStorage ('jk_lang'),
   and re-renders DOM & dynamic scripts live on toggle without page reload. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JagaI18n = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const STORAGE_KEY = 'jk_lang';
  const origTextMap = typeof WeakMap === 'function' ? new WeakMap() : null;
  const origAttrMap = typeof WeakMap === 'function' ? new WeakMap() : null;
  const ATTRS = ['placeholder', 'aria-label', 'title', 'alt'];
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'DATALIST', 'TEXTAREA']);

  let currentLang = loadInitialLang();

  function loadInitialLang() {
    try {
      const saved = root.localStorage && root.localStorage.getItem(STORAGE_KEY);
      return saved === 'en' ? 'en' : 'id';
    } catch (_) {
      return 'id';
    }
  }

  function norm(str) {
    return String(str == null ? '' : str).replace(/\s+/g, ' ').trim();
  }

  /* ------------------------------------------------------------ Domain Translators */
  const CROPS_EN = {
    cabai: 'Chili',
    'cabai rawit': "Bird's Eye Chili",
    'cabai merah': 'Red Chili',
    'cabai keriting': 'Curly Chili',
    kopi: 'Coffee',
    'kopi arabika': 'Arabica Coffee',
    'kopi robusta': 'Robusta Coffee',
    padi: 'Rice',
    jagung: 'Corn',
    'jagung manis': 'Sweet Corn',
    teh: 'Tea',
    tomat: 'Tomato',
    terong: 'Eggplant',
    singkong: 'Cassava',
    kakao: 'Cacao',
    kentang: 'Potato',
    'bawang merah': 'Shallot',
    'bawang putih': 'Garlic',
    'kacang panjang': 'Yardlong Bean',
    mentimun: 'Cucumber',
    mangga: 'Mango',
    kelapa: 'Coconut',
    'jambu biji': 'Guava',
    pisang: 'Banana',
    ketapang: 'Sea Almond',
    durian: 'Durian',
    pepaya: 'Papaya',
    jeruk: 'Citrus',
    alpukat: 'Avocado',
    semangka: 'Watermelon',
    melon: 'Melon',
    kubis: 'Cabbage',
    sawi: 'Mustard Greens',
    bayam: 'Spinach',
    kedelai: 'Soybean',
    tanaman: 'Crop',
    'tanaman sehat': 'Healthy Crop',
  };

  const CONDITIONS_EN = {
    antraknosa: 'Anthracnose',
    'bercak daun': 'Leaf Spot',
    'bercak kering': 'Early Blight',
    'hawar daun': 'Leaf Blight',
    'busuk daun': 'Late Blight',
    'busuk buah': 'Fruit Rot',
    'busuk akar': 'Root Rot',
    'layu bakteri': 'Bacterial Wilt',
    'layu fusarium': 'Fusarium Wilt',
    'kutu putih': 'Mealybugs',
    'kutu daun': 'Aphids',
    'karat daun': 'Leaf Rust',
    'embun tepung': 'Powdery Mildew',
    'embun bulu': 'Downy Mildew',
    'jamur upas': 'Pink Disease',
    'sigatoka pisang': 'Banana Sigatoka',
    'ulat grayak': 'Armyworm',
    'lalat buah': 'Fruit Fly',
    'tungau': 'Mites',
    'trips': 'Thrips',
    'thrips': 'Thrips',
    'hama penggerek': 'Borer pest',
    'hama pengunyah': 'Chewing pest',
    'kuning keriting': 'Leaf Curl Mosaic',
    'virus kuning': 'Yellow Leaf Curl Virus',
    'sehat': 'Healthy',
    'tanaman sehat': 'Healthy Crop',
    'belum dapat dipastikan': 'Uncertain',
    'perlu pemeriksaan langsung': 'Needs Field Inspection',
    'tidak diketahui': 'Unknown',
    'tidak ditemukan gejala': 'No symptoms detected',
  };

  const SEVERITY_EN = {
    severe: 'Critical',
    kritis: 'Critical',
    moderate: 'Moderate',
    waspada: 'Moderate',
    healthy: 'Healthy',
    sehat: 'Healthy',
    unknown: 'Unsure',
    'belum pasti': 'Unsure',
    'belum dinilai': 'Not assessed',
    'belum dapat dipastikan': 'Uncertain',
  };

  const ID_MONTHS = { Jan: 'Jan', Feb: 'Feb', Mar: 'Mar', Apr: 'Apr', Mei: 'May', Jun: 'Jun', Jul: 'Jul', Agu: 'Aug', Sep: 'Sep', Okt: 'Oct', Nov: 'Nov', Des: 'Dec' };
  const ID_DAYS = { Minggu: 'Sun', Senin: 'Mon', Selasa: 'Tue', Rabu: 'Wed', Kamis: 'Thu', Jumat: 'Fri', Sabtu: 'Sat' };

  function translateCrop(name) {
    const raw = String(name || '').trim();
    if (!raw || currentLang !== 'en') return raw;
    const m = /^(.+?)\s+(\d+)$/.exec(raw);
    const base = (m ? m[1] : raw).trim();
    const mapped = CROPS_EN[base.toLowerCase()];
    if (mapped) return m ? `${mapped} ${m[2]}` : mapped;
    return raw;
  }

  function translateCondition(text) {
    const raw = String(text || '').trim();
    if (!raw || currentLang !== 'en') return raw;
    const lower = raw.toLowerCase();
    if (CONDITIONS_EN[lower]) return CONDITIONS_EN[lower];
    if (lower.startsWith('kekurangan ')) return raw.slice(11).trim() + ' deficiency';
    if (lower.startsWith('hama ')) return raw.slice(5).trim() + ' pest';
    if (lower.startsWith('penyakit ')) return raw.slice(9).trim();
    let out = raw;
    for (const [idTerm, enTerm] of Object.entries(CONDITIONS_EN)) {
      if (lower.includes(idTerm)) {
        const re = new RegExp(idTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        out = out.replace(re, enTerm);
      }
    }
    return out;
  }

  function translateSeverity(val) {
    const raw = String(val == null ? '' : val).trim();
    if (currentLang !== 'en') {
      if (raw.toLowerCase() === 'severe') return 'Kritis';
      if (raw.toLowerCase() === 'moderate') return 'Waspada';
      if (raw.toLowerCase() === 'healthy') return 'Sehat';
      return raw || 'Belum dinilai';
    }
    return SEVERITY_EN[raw.toLowerCase()] || raw || 'Not assessed';
  }

  function translateDateTokens(str) {
    if (currentLang !== 'en') return str;
    let s = String(str || '');
    s = s.replace(/\b(Minggu|Senin|Selasa|Rabu|Kamis|Jumat|Sabtu)\b/g, m => ID_DAYS[m] || m);
    s = s.replace(/\b(Mei|Agu|Okt|Des)\b/g, m => ID_MONTHS[m] || m);
    s = s.replace(/\bHari ini\b/g, 'Today').replace(/\bKemarin\b/g, 'Yesterday');
    return s;
  }

  /* ------------------------------------------------------------ Exact Dictionaries */
  const EXACT_EN = {
    // Document & Navigation
    'JagaKebond | Foto, Kenali, dan Rawat Tanaman Anda': 'JagaKebond | Snap, Identify, and Care for Your Crops',
    'JagaKebond — Foto, Kenali, dan Rawat Tanaman Anda': 'JagaKebond | Snap, Identify, and Care for Your Crops',
    'JagaKebond | Kebun Ciomas 3D': 'JagaKebond | Ciomas Farm 3D',
    'JagaKebond · Kebun Ciomas 3D': 'JagaKebond | Ciomas Farm 3D',
    'JagaKebond | Diorama 3D Interaktif Kebun Ciomas': 'JagaKebond | Ciomas Farm Interactive 3D Diorama',
    'JagaKebond · Diorama 3D Interaktif Kebun Ciomas': 'JagaKebond | Ciomas Farm Interactive 3D Diorama',
    'Konsol Admin | JagaKebond': 'Admin Console | JagaKebond',
    'Navigasi utama': 'Main navigation',
    'Navigasi halaman': 'Page navigation',
    'Menu utama': 'Main menu',
    'Menu navigasi ponsel': 'Mobile navigation menu',
    'Buka menu': 'Open menu',
    'Ciutkan menu': 'Collapse menu',
    'Buka menu navigasi': 'Open navigation menu',
    'Informasi layanan': 'Service information',
    'JagaKebond: kembali ke atas': 'JagaKebond: back to top',
    'JagaKebond: Beranda': 'JagaKebond: Home',
    'JagaKebond — Beranda': 'JagaKebond — Home',
    'Kelola akun & data': 'Manage account & data',
    'Akun saya': 'My account',

    // Topbar & Mobile Drawer
    'Video': 'Video',
    'Manfaat': 'Benefits',
    'Tutorial': 'Tutorial',
    'Tutorial interaktif': 'Interactive tutorial',
    'Unduh APK Android': 'Download Android APK',
    'Pasang Aplikasi Android JagaKebond': 'Install JagaKebond Android App',
    'Mendukung kamera lapangan, GPS & antrean sinkronisasi offline.': 'Supports field camera, GPS & offline sync queue.',
    'Unduh APK': 'Download APK',
    'v0.2.4.28 · 6,9 MB': 'v0.2.4.28 · 6.9 MB',
    'Pratinjau diagnosis gejala antraknosa daun cabai di aplikasi JagaKebond': 'Preview of chili leaf anthracnose symptom diagnosis in JagaKebond app',
    'Pratinjau riwayat kesehatan tanaman Cabai 1 dan Cabai 4': 'Preview of Chili 1 and Chili 4 crop health history',
    'Pratinjau peta kebun interaktif dengan pin tanaman Cabai 1 dan Kopi 2': 'Preview of interactive farm map with Chili 1 and Coffee 2 crop pins',
    'Pratinjau antrean draf offline Teh 7 yang siap disinkronkan': 'Preview of Tea 7 offline draft queue ready to sync',
    'FAQ': 'FAQ',
    'Masuk': 'Sign In',
    'Menu': 'Menu',
    'Masuk ke kebun Anda': 'Sign in to your farm',
    'Video panduan': 'Guide video',
    'Masalah dan solusi': 'Problem & solution',
    'Tutorial 3D interaktif': 'Interactive 3D tour',
    'Fitur utama': 'Key features',
    'Pertanyaan umum': 'Common questions',

    // Hero & Auth Gate
    'Kenali tanaman.': 'Know your crops.',
    'Rawat dengan tepat.': 'Care with confidence.',
    'Mulai dari satu foto. Kenali gejalanya, simpan catatannya, dan pantau perubahan tanaman Anda.': 'Start with one photo. Spot symptoms, keep field records, and track how every crop recovers over time.',
    'SELAMAT DATANG': 'WELCOME BACK',
    'Catatan tanaman Anda siap dilanjutkan.': 'Your crop logs are ready where you left off.',
    'Mulai catatan kebun Anda': 'Start your farm records',
    'Buat akun sesuai izin admin kebun Anda.': 'Create an account with your farm admin permission.',
    'Pendaftaran hanya terbuka bila admin mengizinkan.': 'Registration is open only when enabled by your farm admin.',
    'Nama': 'Name',
    'Nama Anda': 'Your name',
    'Email': 'Email',
    'nama@contoh.com': 'name@example.com',
    'Kata sandi': 'Password',
    'Masukkan kata sandi': 'Enter password',
    'Minimal 8 karakter': 'At least 8 characters',
    'Lihat': 'Show',
    'Sembunyikan': 'Hide',
    'Tampilkan kata sandi': 'Show password',
    'atau': 'or',
    'Masuk dengan Google': 'Sign in with Google',
    'Lupa kata sandi?': 'Forgot password?',
    'Hubungi admin kebun Anda untuk mengatur ulang kata sandi. Jangan kirim kata sandi Anda kepada siapa pun.': 'Contact your farm admin to reset your password. Never share your password with anyone.',
    'Belum punya akun? Hubungi admin kebun Anda.': 'No account yet? Contact your farm admin.',
    'Baru di JagaKebond? Buat akun untuk mulai mencatat.': 'New to JagaKebond? Create an account to start logging.',
    'Sudah punya akun? Masuk': 'Already have an account? Sign In',
    'Buat akun': 'Create account',
    'Dengan melanjutkan, Anda menyetujui': 'By continuing, you agree to our',
    'Ketentuan Layanan': 'Terms of Service',
    'Baca': 'Read our',
    'Kebijakan Privasi': 'Privacy Policy',
    'untuk penggunaan foto dan lokasi.': 'for photo and location usage.',

    // Video Section
    'Lihat cara kerja JagaKebond dari kebun hingga peta.': 'See how JagaKebond works from field to map.',
    'Tonton panduan singkat pengambilan foto gejala tanaman, pembacaan diagnosis awal AI, pemetaan petak kebun, hingga sinkronisasi antrean offline.': 'Watch a short walkthrough of taking crop symptom photos, reading AI initial assessments, mapping farm plots, and offline queue syncing.',
    'Beranda': 'Home',
    'Foto Tanaman': 'Scan Crop',
    'Diagnosis AI': 'AI Diagnosis',
    'Peta Petak': 'Plot Map',
    'Sinkron Offline': 'Offline Sync',
    'Pilih bab video': 'Select video chapter',

    // Problem to Solution (#masalah)
    'Catatan kebun sering tercecer di galeri.': 'Field notes often get lost in your gallery.',
    'Gejala muncul, foto menumpuk tanpa label lokasi, dan keputusan diambil dari ingatan. Seminggu kemudian, tidak ada catatan tanaman mana yang membaik atau memburuk.': 'Symptoms show up, photos pile up without location tags, and decisions rely on memory. A week later, there is no clear record of which crop improved or worsened.',
    'Tanpa JagaKebond': 'Without JagaKebond',
    'Foto gejala bercampur dengan foto lain di galeri ponsel': 'Symptom photos get mixed with everyday pictures in your phone gallery',
    'Sulit melacak tanaman atau bedeng yang pernah diperiksa': 'Hard to trace which crop or bed was previously checked',
    'Saran pemeriksaan hilang saat berpindah aplikasi pesan': 'Inspection notes get buried across messaging apps',
    'Dengan JagaKebond': 'With JagaKebond',
    'Setiap foto menjadi catatan yang terikat pada tanaman dan petaknya': 'Every photo becomes a structured record tied to its crop and plot',
    'Riwayat dikelompokkan per tanaman untuk memantau perkembangan': 'History is grouped per crop to track recovery over time',
    'Koreksi lapangan tersimpan terpisah dari penilaian awal model': 'Field corrections stay separated from the initial model assessment',

    // Tagline
    'Satu': 'One',
    'foto': 'photo',
    'hari': 'today.',
    'ini.': '',
    'Riwayat': 'History',
    'kebun': 'field',
    'yang': 'records',
    'tetap': 'stay',
    'rapi': 'organized',
    'esok': 'tomorrow.',

    // Benefits (#fitur)
    'Yang Anda dapat dari setiap foto.': 'What you get from every photo.',
    'Penilaian awal yang terstruktur': 'Structured initial assessment',
    'Unggah foto daun atau buah untuk melihat gejala visual, tingkat perhatian, dan daftar pemeriksaan lapangan dalam Bahasa Indonesia.': 'Upload a leaf or fruit photo to view visual symptoms, attention severity, and a field inspection checklist in clear language.',
    'Riwayat dikelompokkan per tanaman': 'History grouped per plant',
    'Semua pemeriksaan tersusun menurut tanaman yang sama dari waktu ke waktu, bukan sekadar urut tanggal unggah.': 'All inspections stay organized under the same plant over time, not scattered by upload date.',
    'Peta sesuai observasi nyata': 'Maps grounded in real observations',
    'Pin Sehat, Waspada, dan Kritis hanya menampilkan catatan yang benar ada di lapangan. Peta tidak menebak petak yang belum diperiksa.': 'Healthy, Moderate, and Critical pins only reflect recorded field inspections. Unchecked plots are never guessed.',
    'Tetap mencatat saat sinyal lemah': 'Keep logging on weak signal',
    'Draf foto dan lokasi tersimpan lebih dulu di perangkat saat jaringan terputus, lalu dikirim ulang otomatis ketika koneksi pulih.': 'Draft photos and GPS points stay safely on your device offline and sync automatically once signal returns.',

    // 3D Interactive Tour (#cara)
    'Langkah penggunaan JagaKebond secara visual.': 'Step-by-step visual guide to JagaKebond.',
    'Gunakan tombol panah di samping animasi atau scroll di layar desktop untuk melihat bagaimana pulau kebun 3D dan tampilan ponsel bergerak dari pengambilan foto hingga pemetaan petak.': 'Use the arrow buttons beside the animation or scroll on desktop to see how the 3D farm island and mobile screens flow from capture to plot mapping.',
    'Tampilkan diorama layar penuh': 'Show diorama full screen',
    'Keluar dari layar penuh': 'Exit full screen',
    'Layar penuh': 'Full screen',
    'Langkah sebelumnya': 'Previous step',
    'Langkah berikutnya': 'Next step',
    'Beranda: Ringkasan kebun dan cuaca': 'Home: Farm summary and weather',
    'Beranda: Cuaca petak, risiko kebun & GPS': 'Home: Plot weather, farm risk & GPS',
    'Foto Tanaman: Pindai gejala dan GPS': 'Scan Crop: Symptom scan and GPS',
    'Kamera: Bidik tanaman jarak 15–25 cm': 'Camera: Frame crop from 15–25 cm',
    'Riwayat: Status dan koreksi per tanaman': 'History: Per-plant status and corrections',
    'Diagnosis AI: Deteksi penyakit & panduan penanganan': 'AI Diagnosis: Disease detection & action guide',
    'Peta: Batas petak dan pin status': 'Map: Plot boundaries and status pins',
    'Peta Petak: Tindakan sesuai kondisi tiap petak': 'Plot Map: Actions tailored per plot condition',
    'Siap Mencatat: Antrean offline tersinkron': 'Ready to Log: Offline queue synced',
    'Offline & Cloud: Foto terunggah otomatis ke Cloud': 'Offline & Cloud: Photos upload automatically to Cloud',
    '1. Beranda': '1. Home',
    '2. Foto': '2. Scan',
    '3. Riwayat': '3. History',
    '3. Diagnosis AI': '3. AI Diagnosis',
    '4. Peta': '4. Map',
    '5. Offline': '5. Offline',
    'Kembali': 'Back',
    'Lanjut ke Foto': 'Next: Scan Crop',
    'Lanjut ke Riwayat': 'Next: History',
    'Lanjut ke Diagnosis AI': 'Next: AI Diagnosis',
    'Lanjut ke Peta': 'Next: Map',
    'Lanjut ke Offline': 'Next: Offline',
    'Kembali ke Beranda': 'Back to Home',
    'Buka Diorama 3D Interaktif': 'Open Interactive 3D Diorama',
    'Selamat Datang di JagaKebond': 'Welcome to JagaKebond',
    'Pantau Kondisi Cuaca dan Risiko Kebun': 'Monitor Weather Conditions and Farm Risk',
    'Beranda merangkum lokasi kebun, suhu serta kelembapan lapangan, jumlah tanaman tercatat, dan status perhatian Kritis atau Waspada di satu layar.': 'Home summarizes your farm location, temperature and humidity, tracked crop totals, and Critical or Moderate alerts on one screen.',
    'Beranda merangkum perekaman lokasi otomatis via GPS, suhu dan kelembapan petak Bedeng Cabai (24°C, RH 82%, 724 m dpl), jumlah tanaman tercatat, serta status perhatian Kritis atau Waspada di satu layar.': 'Home summarizes automatic GPS location capture, Bedeng Cabai plot weather (24°C, RH 82%, 724 m asl), tracked crop counts, and Critical or Moderate alerts on one screen.',
    'Di aplikasi asli, panduan ini dapat dibuka kembali kapan saja lewat Akun lalu Panduan Penggunaan.': 'In the live app, you can reopen this guide anytime via Account → User Guide.',
    'Foto Tanaman dan Lokasi': 'Crop Photo & Location',
    'Ambil Foto Tanaman': 'Capture Crop Photo',
    'Ambil foto daun atau buah yang bermasalah dari kamera atau galeri, pastikan koordinat GPS dan tanggalnya tepat, lalu ketuk Analisis.': 'Capture an affected leaf or fruit via camera or gallery, verify the GPS coordinates and date, then tap Analyze.',
    'Bidik bagian daun atau buah yang bermasalah dari jarak 15 hingga 25 cm memakai kamera atau galeri, lalu ketuk Analisis untuk memeriksa gejala awal.': 'Frame affected leaves or fruit from 15 to 25 cm using camera or gallery, then tap Analyze to inspect initial symptoms.',
    'Pindai visual aktif di atas bedeng cabai': 'Visual scan active over chili bed',
    'Gunakan foto jarak dekat yang terang dan fokus. Hasil analisis adalah dugaan awal yang perlu diperiksa ulang di kebun.': 'Take a well-lit, focused close-up photo. Analysis results are an initial hypothesis to confirm in the field.',
    'Riwayat Per Tanaman': 'Per-Crop History',
    'Diagnosis Awal Tanaman dengan AI': 'Initial Crop Diagnosis with AI',
    'Buka kartu tanaman untuk membaca dugaan awal, daftar pemeriksaan, saran pencegahan, foto lanjutan, dan catatan koreksi milik Anda sendiri.': 'Open any crop card to read the initial finding, field checklist, prevention tips, follow-up photos, and your own corrections.',
    'AI membaca gejala tanaman untuk menyajikan deteksi penyakit awal, panduan suara, serta 3 langkah penanganan dan daftar periksa yang bisa dicentang langsung per tanaman.': 'AI reads crop symptoms to deliver early disease detection, voice guidance, and 3 actionable treatment steps you can check off per plant.',
    'Panduan 3 langkah penanganan per tanaman': '3-step treatment checklist per plant',
    'Daftar tindakan dan catatan koreksi tersimpan rapi per tanaman sehingga perkembangan dari Kritis menuju Sehat terlihat jelas.': 'Action checklists and correction notes stay organized per plant so recovery from Critical to Healthy is easy to trace.',
    'Riwayat mengelompokkan kondisi per tanaman sehingga perkembangan dari Kritis menuju Sehat terlihat jelas.': 'History groups inspections by plant so recovery from Critical to Healthy stays easy to trace.',
    'Peta Batas Petak': 'Plot Boundary Map',
    'Kelola Kebun per Petak Tanaman': 'Manage Farm by Crop Plot',
    'Gambar batas poligon petak untuk mengelompokkan tanaman, lalu ketuk titik Sehat hijau, Waspada kuning, atau Kritis merah untuk melihat ringkasan bedeng.': 'Draw plot polygons to organize plants, then tap green Healthy, amber Moderate, or red Critical pins for bed summaries.',
    'Lihat batas poligon bedeng cabai serta titik status Sehat hijau, Waspada kuning, dan Kritis merah untuk membaca panduan tindakan sesuai kondisi tiap petak.': 'View chili bed boundaries and green Healthy, amber Moderate, or red Critical status pins to follow action steps tailored to each plot.',
    'Poligon bedeng cabai dan pin status petak tampil': 'Chili bed polygon & plot status pins shown',
    'Poligon bedeng dan empat pin status tampil': 'Plot polygon & four status pins shown',
    'Ringkasan peta memakai catatan pemeriksaan yang sudah tercatat dan tidak menebak petak yang belum dipotret.': 'Map summaries use verified recorded inspections and never guess plots without photos.',
    'Siap Mencatat Tanpa Khawatir Sinyal': 'Ready to Record Anywhere',
    'Tetap Aktif Offline, Sinkron Otomatis ke Cloud': 'Stay Active Offline, Auto-Sync to Cloud',
    'Foto yang diambil saat sinyal terputus disimpan aman di antrean perangkat dan otomatis terkirim ke server kebun ketika jaringan kembali.': 'Photos taken offline stay safe in the device queue and upload automatically when connectivity returns.',
    'Aplikasi tetap berjalan offline saat sinyal kebun terputus; foto dan catatan tersimpan di perangkat lalu terunggah otomatis ke Cloud saat perangkat kembali terhubung.': 'The app keeps working offline when signal drops in the field; photos and notes stay saved locally and upload automatically to Cloud once connected.',
    'Sinkronisasi foto & catatan otomatis ke Cloud': 'Photos & notes sync automatically to Cloud',
    'Setelah masuk, Anda bisa memperbarui data cuaca dan memantau sisa kuota analisis langsung dari panel Akun.': 'After signing in, you can refresh weather telemetry and check daily fast-analysis allowance from the Account modal.',

    // Proof & Trust (#bukti)
    'Alat bantu catatan, bukan penentu tunggal.': 'A field record assistant, not a sole decision-maker.',
    'Penilaian gambar adalah hipotesis awal yang perlu diperiksa ulang di kebun. Keputusan perawatan dan riwayat koreksi tetap dipegang pemilik serta admin kebun.': 'Image assessments are initial hypotheses to verify on site. Treatment choices and correction logs stay in the hands of farm owners and admins.',
    'Aplikasi Web': 'Web App',
    'Aplikasi Android': 'Android App',
    'Antarmuka Bilingual': 'Bilingual Interface',
    'Data Tersimpan di Cloud': 'Cloud-Saved Data',
    'Aplikasi Bekerja Offline*': 'Works Offline*',
    '*fitur ini bekerja di aplikasi native Android': '*this feature works in the native Android app',
    'Catatan terpadu lapangan hingga arsip': 'Unified records from field to archive',
    'Setiap pemotretan, pembaruan cuaca harian, gambar batas petak, dan koreksi catatan lapangan tersimpan rapi pada akun kebun Anda dan terenkripsi selama sinkronisasi.': 'Every photo capture, daily weather update, plot boundary, and field correction is stored cleanly under your farm account and encrypted during sync.',
    'Slot testimoni pengguna kebun': 'Farmer testimonial slot',
    'Bagian ini disiapkan sebagai placeholder bertanda': 'This slot is reserved with placeholder',
    'dan hanya diisi kutipan nyata setelah ada persetujuan pengguna lapangan.': 'and will only publish verified farmer quotes with permission.',

    // FAQ
    'Pertanyaan yang sering muncul.': 'Frequently asked questions.',
    'Apakah JagaKebond menggantikan diagnosis penyuluh pertanian?': 'Does JagaKebond replace advice from an agronomist?',
    'Tidak. Hasil analisis foto adalah catatan bantu dan hipotesis awal berdasarkan gejala visual, sedangkan keputusan budidaya dan pemeriksaan langsung tetap berada pada petani dan penyuluh.': 'No. Photo analysis provides structured field notes and an initial hypothesis from visual symptoms; cultivation decisions and direct inspection remain with farmers and extension officers.',
    'Bagaimana pemakaiannya saat berada di lahan tanpa sinyal?': 'How does it work on farms with no mobile signal?',
    'Foto serta catatan draf tetap tersimpan di perangkat saat offline. Pemrosesan analisis gambar dan pemuatan peta baru berjalan ketika koneksi internet kembali aktif.': 'Photos and draft notes stay saved on your device offline. Image analysis and map tiles resume as soon as an internet connection returns.',
    'Apakah foto yang sudah dianalisis bisa dikelompokkan ke tanaman yang sama?': 'Can analyzed photos be grouped under the same plant?',
    'Bisa. Saat foto baru diambil di dekat catatan tanaman sejenis, aplikasi menawarkan untuk menyimpannya ke riwayat tanaman tersebut agar pemantauan per tanaman tidak terputus.': 'Yes. When a new photo is taken near a previous record of the same crop, JagaKebond suggests linking it to that plant history for continuous tracking.',
    'Apa arti warna pin Sehat, Waspada, dan Kritis di peta?': 'What do the Healthy, Moderate, and Critical pin colors on the map mean?',
    'Setiap pin mewakili status catatan pemeriksaan terbaru untuk tanaman di titik tersebut. Peta hanya memvisualisasikan tanaman yang sudah diperiksa agar tidak menimbulkan asumsi palsu.': 'Each pin reflects the latest recorded status for the crop at that coordinate. Only inspected crops are plotted to avoid false assumptions.',
    'Bagaimana proses pendaftaran atau pembuatan akun baru?': 'How does registration or account creation work?',
    'Anda bisa masuk memakai akun dari admin kebun, mendaftar jika admin membuka pendaftaran kata sandi, atau memilih Masuk dengan Google dengan persetujuan admin server.': 'You can sign in with credentials from your farm admin, register when password signup is enabled, or choose Sign in with Google with server admin approval.',
    'Di mana foto dan data lokasi GPS saya disimpan?': 'Where are my photos and GPS coordinates stored?',
    'Foto tanaman dan titik lokasi disimpan di server kebun JagaKebond yang dikelola admin Anda. Rincian lengkapnya tersedia pada halaman': 'Crop photos and coordinates are stored on the JagaKebond farm server managed by your admin. Full details are in our',
    'Apakah bisa dipasang di ponsel Android maupun lewat browser?': 'Can it be installed on Android phones as well as used in a browser?',
    'Ya. JagaKebond berjalan di peramban modern sebagai aplikasi web yang bisa dipasang di layar utama, dan juga tersedia sebagai aplikasi Android dengan dukungan kamera serta sinkronisasi latar.': 'Yes. JagaKebond runs in modern browsers as an installable web app and is also available as a native Android app with camera integration and background sync.',

    // Final CTA & Footer
    'Mulai rapikan catatan kebun Anda hari ini.': 'Start organizing your farm records today.',
    'Gunakan akun kebun yang sudah diberikan admin Anda, atau ajukan pendaftaran lewat form masuk di atas.': 'Use the farm account provided by your admin, or submit a signup request above.',
    'Ketentuan lengkap tersedia di': 'Full terms are available at',
    'Pilih bahasa': 'Choose language',

    // App Sidebar, Topbar, Bottom Nav
    'Peta Kebun': 'Farm Map',
    'Peta': 'Map',
    'Kamera': 'Camera',
    'Foto & Analisis Tanaman': 'Crop Photo & Analysis',
    'Peta Kebun Interaktif': 'Interactive Farm Map',
    'Riwayat Tanaman & Petak': 'Crop & Plot History',
    'Semua Foto Terkirim': 'All Photos Synced',
    'Sinkron': 'Synced',
    'Data kebun tersimpan aman di perangkat & server.': 'Farm data stays safely synced on device & server.',
    'Menunggu Sinkron': 'Waiting to Sync',
    'Perlu Cek': 'Needs Check',
    'Mode Offline': 'Offline Mode',
    'Offline': 'Offline',
    'Foto disimpan lokal dan dikirim otomatis saat online.': 'Photos are saved locally and uploaded automatically online.',
    'Foto draf sedang diproses ke server.': 'Draft photos are syncing to the server.',
    'Petani': 'Farmer',
    'Admin': 'Admin',

    // Beranda Dashboard & Weather Telemetry
    'Lokasi dan cuaca': 'Location & weather',
    'Lokasi belum terbaca': 'Location not detected yet',
    'Zona Kebun': 'Farm Zone',
    'Menunggu GPS': 'Waiting for GPS',
    'GPS belum tersedia': 'GPS unavailable',
    'GPS belum terbaca. Coba di tempat terbuka.': 'GPS unavailable. Try an open area.',
    'Perbarui lokasi': 'Refresh location',
    'Suhu Udara': 'Air Temp',
    'Kelembapan (RH)': 'Humidity (RH)',
    'Ketinggian': 'Elevation',
    'm dpl': 'm asl',
    'meter dpl': 'meters asl',
    'Menunggu data cuaca lokal untuk peringatan kelembapan & jamur.': 'Waiting for local weather data for humidity & fungal alerts.',
    'Menunggu data lokasi dan cuaca': 'Waiting for location & weather data',
    'Menunggu lokasi & cuaca kebun…': 'Waiting for farm location & weather…',
    'Memuat zona…': 'Loading zone…',
    'Zona tidak tersedia': 'Zone unavailable',
    'Zona Dataran Rendah': 'Lowland Zone',
    'Zona Dataran Menengah': 'Midland Zone',
    'Zona Dataran Tinggi': 'Highland Zone',
    'Memuat cuaca lokal…': 'Loading local weather…',
    'Data cuaca tidak tersedia.': 'Weather data unavailable.',
    'Lembap tinggi: Waspada Jamur & Antraknosa.': 'High humidity: Watch for Fungus & Anthracnose.',
    'Lembap, waspada jamur': 'Humid, watch for fungus',
    'Udara kering': 'Dry air',
    'Kelembapan sedang': 'Moderate humidity',
    'Koordinat Terakhir': 'Last Coordinates',
    'Koordinat Terkunci': 'Coordinates Locked',
    'Koordinat: menunggu GPS': 'Coordinates: waiting for GPS',
    'Mulai dengan Memotret Satu Tanaman': 'Start by Snapping One Crop',
    'Foto satu daun atau buah. Hasil dan saran muncul di sini dan di Riwayat.': 'Snap a leaf or fruit. Results and advice appear here and in History.',
    'Ambil foto pertama': 'Take first photo',
    'Tanaman Total': 'Total Crops',
    'Kritis': 'Critical',
    'Waspada': 'Moderate',
    'Sehat': 'Healthy',
    'Belum Pasti': 'Unsure',
    'Belum dinilai': 'Not assessed',
    'Perlu Perhatian Segera': 'Needs Immediate Attention',
    'Lihat Semua': 'View All',
    'Foto Terbaru Kebun': 'Latest Farm Photos',
    'Catatan Harian': 'Daily Log',
    'Tulis Catatan': 'Write Note',
    'Semua tanaman terakhir terlihat sehat.': 'All recent crops look healthy.',
    'Belum ada foto tanaman.': 'No crop photos yet.',
    'Kamera berstempel GPS & panduan tindakan': 'GPS-stamped camera & action guide',
    'Lihat posisi petak dan titik tanaman': 'View plot boundaries and crop pins',
    'Progres pemulihan dan antrean offline': 'Recovery history and offline queue',
    'Lokasi GPS diperbarui.': 'GPS location updated.',
    'GPS tidak didukung perangkat.': 'GPS is not supported on this device.',
    'Izin lokasi ditolak. Aktifkan izin lokasi untuk situs ini di pengaturan browser.': 'Location permission denied. Enable location access for this site in browser settings.',
    'Lokasi belum tersedia. Coba lagi di tempat terbuka.': 'Location unavailable yet. Try again in an open area.',

    // Scan Flow & Camera
    'Potret daun atau buah yang bermasalah dari dekat.': 'Take a close-up photo of the affected leaf or fruit.',
    'Perbesar kamera 2x': '2x camera zoom',
    'Putar kamera depan atau belakang': 'Switch front/back camera',
    'Arahkan daun/buah ke dalam bingkai · Jarak 15–25 cm': 'Center the leaf or fruit inside the frame · 15–25 cm',
    'Kamera belum aktif. Izinkan akses kamera untuk memulai.': 'Camera inactive. Allow camera access to begin.',
    'Menyiapkan kamera…': 'Preparing camera…',
    'Pratinjau foto': 'Photo preview',
    'Perbesar foto': 'Enlarge photo',
    'Foto Siap Dianalisis': 'Photo Ready to Analyze',
    'Foto siap dikirim untuk analisis': 'Photo ready to send for analysis',
    'Foto dari galeri': 'Photo from gallery',
    'Offline. Foto dikirim otomatis saat ada sinyal.': 'Offline. Photo uploads automatically when signal returns.',
    'Ubah lokasi': 'Change location',
    'Atur tanggal': 'Set date',
    'Ambil ulang': 'Retake',
    'Pilih foto dari galeri': 'Choose photo from gallery',
    'Pilih dari galeri': 'Choose from gallery',
    'Ambil foto': 'Take photo',
    'Menyiapkan Foto…': 'Preparing Photo…',
    'Membaca gambar, tanggal, dan lokasi yang tersimpan pada foto.': 'Reading image, date, and location stored in the photo.',
    'Batal': 'Cancel',
    'Lokasi belum terbaca.': 'Location not detected yet.',
    'Pilih petak atau titik di peta supaya foto masuk ke tempat yang benar.': 'Pick a plot or pin on the map so this photo is saved to the right location.',
    'Atur lokasi': 'Set location',
    'Tambah jenis tanaman (opsional)': 'Add crop type (optional)',
    'Jenis tanaman': 'Crop type',
    'Contoh: cengek, cabe, ketela…': 'Example: chili, coffee, cassava…',
    'Nama daerah juga boleh. AI menyesuaikannya ke nama baku.': 'Local crop names are welcome; AI standardizes them.',
    'Analisis': 'Analyze',
    'Mengirim foto…': 'Uploading photo…',
    'Batalkan': 'Cancel',
    'Foto Terkirim': 'Photo Sent',
    'Foto tersimpan di HP': 'Photo Saved on Device',
    'Hasil biasanya muncul dalam beberapa menit.': 'Results usually arrive in a few minutes.',
    'Tersimpan di HP — dikirim otomatis saat ada sinyal.': 'Saved on phone — uploads automatically once online.',
    'Ambil foto berikutnya': 'Take next photo',
    'Lihat di Riwayat': 'View in History',
    'Analisis Gagal': 'Analysis Failed',
    'Coba lagi': 'Try again',
    'Coba Lagi': 'Try Again',
    'Kirim ulang': 'Resend',
    'Foto ulang': 'Retake photo',
    'Perlu dicek petugas': 'Needs field verification',
    'Yang Perlu Dilakukan': 'Recommended Actions',
    'Yang perlu dilakukan': 'Recommended actions',
    'Dengarkan': 'Listen',
    'AI Kurang Yakin': 'Low AI Confidence',
    'Simpan': 'Save',
    'Bagikan': 'Share',
    'Menyimpan foto di HP…': 'Saving photo to device…',
    'Foto Baru': 'New Photo',
    'Foto Galeri': 'Gallery Photo',
    'Hasil analisis': 'Analysis result',
    'Analisis belum selesai': 'Analysis incomplete',
    'Analisis selesai': 'Analysis complete',
    'Analisis sedang berjalan': 'Analysis in progress',
    'Analisis tidak selesai': 'Analysis did not finish',
    'Memeriksa foto…': 'Checking photo…',
    'Menyiapkan diagnosis…': 'Preparing diagnosis…',
    'Menganalisis gejala…': 'Analyzing symptoms…',
    'Menyusun hasil…': 'Compiling results…',
    'Menyiapkan hasil…': 'Preparing result…',
    'Sedang dianalisis…': 'Analyzing…',
    'Analisis cepat tanpa batas hari ini.': 'Unlimited fast analyses today.',
    'Kuota analisis cepat hari ini habis. Foto berikutnya dianalisis lewat antrean biasa.': 'Daily fast-analysis allowance reached. New photos use the standard queue.',
    'Bukti foto belum cukup. Perlu pemeriksaan langsung.': 'Photo evidence insufficient. Direct inspection needed.',
    'Dugaan dari foto, belum dikonfirmasi di lapangan.': 'Initial visual hypothesis; unconfirmed in field.',
    'Perlu Pemeriksaan Langsung': 'Needs Field Inspection',
    'Tanaman baru': 'New crop',
    'Foto tidak valid.': 'Invalid photo.',
    'Foto tidak dapat dibaca.': 'Unable to read photo.',

    // Map & Plots
    'Semua': 'All',
    'Jalan': 'Street',
    'Satelit': 'Satellite',
    'Petak': 'Plots',
    'Foto belum punya lokasi': 'Photos missing location',
    'Gambar batas petak': 'Draw plot boundary',
    'Jalan keliling batas kebun': 'Walk farm boundary',
    'Jalan keliling batas kebun (GPS mencatat titiknya)': 'Walk farm boundary (GPS tracks points)',
    'Ke lokasi saya': 'My location',
    'Memuat alat peta…': 'Loading map tools…',
    'Peta butuh sinyal. Titik dan petak Anda tetap terlihat.': 'Map tiles need signal. Your pins and plots remain visible.',
    'Hapus titik terakhir': 'Undo last point',
    'Selesai': 'Done',
    'Selesai menggeser': 'Done editing',
    'Waktu foto': 'Photo time',
    'Foto lagi': 'Photo again',
    'Ubah Data': 'Edit Data',
    'Simpan Petak': 'Save Plot',
    'Ubah Petak': 'Edit Plot',
    'Nama petak': 'Plot name',
    'Tanaman utama': 'Main crop',
    'Catatan (boleh dikosongkan)': 'Notes (optional)',
    'Batas petak dipakai untuk mengelompokkan hasil analisis foto per kebun.': 'Plot boundaries group crop analysis records per field block.',
    'Simpan petak': 'Save plot',
    'Simpan perubahan': 'Save changes',
    'Tanaman dalam Petak': 'Crops in Plot',
    'Tanaman dalam petak': 'Crops in plot',
    'Ubah petak': 'Edit plot',
    'Hapus petak': 'Delete plot',
    'Petak Saya': 'My Plots',
    'Gambar petak baru': 'Draw new plot',
    'Belum ada petak tersimpan': 'No saved plots yet',
    'Ringkasan dan saran petak': 'Plot summary & advice',
    'Ringkasan dan Saran Petak': 'Plot Summary & Advice',
    'Belum ada poligon atau pin kebun': 'No farm plots or pins yet',
    'Belum ada tanaman tercatat di petak ini.': 'No crops recorded in this plot yet.',

    // History, Drafts, & Plot Grouping
    'Tanaman': 'Crops',
    'Harian': 'Daily',
    'Cari tanaman atau penyakit': 'Search crop or disease',
    'Perlu dicek': 'Needs check',
    'Foto belum terkirim': 'Unsent photos',
    'Semua foto sudah terkirim': 'All photos synced',
    'Kirim sekarang': 'Send now',
    'Ketuk untuk melihat kemajuan': 'Tap to view progress',
    'Lihat foto': 'View photo',
    'Pilihan lain': 'More options',
    'Simpan ke galeri': 'Save to gallery',
    'Hapus': 'Delete',
    'Hapus Catatan': 'Delete Record',
    'Ubah Data Tanaman': 'Edit Crop Record',
    'Analisis Ulang': 'Re-analyze',
    'Lihat di Peta': 'View on Map',
    'Lihat di peta': 'View on map',
    'Lihat Analisis dan Pencegahan': 'View Analysis & Prevention',
    'Belum Ada Petak': 'No Plots Yet',
    'Gambar batas kebun di menu Peta untuk mengelompokkan riwayat.': 'Draw plot boundaries in Map to group crop history.',
    'Belum masuk petak': 'Outside any plot',
    'Lokasi kosong atau di luar batas petak': 'No coordinates or outside plot boundaries',
    'Tidak Ada Tanaman yang Cocok': 'No Matching Crops',
    'Coba pilih status lain atau hapus kata pencarian.': 'Try another status filter or clear your search.',
    'Tampilkan semua': 'Show all',
    'Terbaik': 'Best',
    'Semua tanaman': 'All crops',
    'Diagnosis': 'Diagnosis',

    // Modals (Crop Assign, Daily Log, Status, Record Edit, Plot Summary, Date Picker, Account, Reanalysis, Confirm)
    'Simpan ke Tanaman': 'Save to Crop',
    'Ada tanaman sejenis di dekat foto ini. Pilih yang sama, atau buat tanaman baru.': 'Similar plants exist nearby. Pick an existing one or create a new crop.',
    'Tulis Catatan Harian': 'Write Daily Note',
    'Untuk hari ini': 'For today',
    'Saran ringkasan': 'Suggested summary',
    'Pakai ringkasan': 'Use summary',
    'Catatan': 'Note',
    'Tulis kondisi kebun hari ini…': 'Write today\'s farm conditions…',
    'Judul atau tindakan (opsional)': 'Title or actions (optional)',
    'Judul': 'Title',
    'Otomatis, misalnya: Catatan 20 Okt': 'Auto, e.g.: Note 20 Oct',
    'Tindakan (satu per baris)': 'Actions (one per line)',
    'Contoh: periksa daun cabai bagian bawah': 'Example: inspect lower chili leaves',
    'Simpan catatan': 'Save note',
    'Ringkasan Hari Ini': 'Today\'s Summary',
    'Ubah Status': 'Change Status',
    'Pilih status sesuai hasil pengecekan di kebun': 'Select status matching field check',
    'Kritis · perlu diperiksa': 'Critical · needs attention',
    'Waspada · pantau terus': 'Moderate · keep monitoring',
    'Sehat · kondisi baik': 'Healthy · good condition',
    'Perbarui jenis, tanggal, status, atau dugaan hama dan penyakit pada foto ini.': 'Update crop type, date, status, or suspected pest/disease for this photo.',
    'Terapkan ke semua foto tanaman ini': 'Apply to all photos of this plant',
    'Status tanaman': 'Crop status',
    'Dugaan penyakit': 'Suspected disease',
    'Dugaan hama': 'Suspected pest',
    'Kosongkan bila tidak ada atau belum diketahui.': 'Leave blank if none or unknown.',
    'Tanggal foto': 'Photo date',
    'Lokasi': 'Location',
    'Status dan dugaan hama/penyakit berlaku untuk foto ini. Rincian analisis AI tetap tersimpan. Bila jenis tanaman diubah, Anda bisa meminta analisis ulang dengan jenis yang benar.': 'Status and suspected pest/disease apply to this photo. AI details remain saved. If crop type changes, you can request a re-analysis.',
    'Ringkasan Petak': 'Plot Summary',
    'Kondisi Tanaman': 'Crop Condition',
    'Ketinggian Petak': 'Plot Elevation',
    'Jenis Tanaman dan Masalahnya': 'Crop Types & Issues',
    'Saran Pengelolaan': 'Management Advice',
    'Perlu Tindakan': 'Needs Action',
    'Perlu Dipantau': 'Monitor',
    'Belum Ada Data': 'No Data Yet',
    'Kondisi sehat': 'Healthy condition',
    'Kondisi baik': 'Good condition',
    'Ketinggian belum tercatat. Foto tanaman dengan GPS menyala agar ketinggian petak terbaca.': 'Elevation not recorded yet. Take a photo with GPS on to record plot elevation.',
    'Perkiraan dari ketinggian foto yang tercatat. Kelembapan, suhu, dan penyebab gejala tidak dapat disimpulkan dari ketinggian saja.': 'Estimated from recorded photo altitudes. Humidity, temperature, and symptom causes cannot be inferred from altitude alone.',
    'Dataran Rendah': 'Lowland',
    'Dataran Menengah': 'Midland',
    'Dataran Tinggi': 'Highland',
    'Tutup': 'Close',
    'Tutup ringkasan': 'Close summary',
    'Kapan Foto Ini Diambil?': 'When Was This Photo Taken?',
    'Foto ini tidak punya tanggal. Pilih kapan foto diambil.': 'This photo has no date metadata. Select when it was taken.',
    'Hari ini': 'Today',
    'Kemarin': 'Yesterday',
    '3 hari lalu': '3 days ago',
    '1 minggu lalu': '1 week ago',
    'Atau pilih tanggal dan jam': 'Or pick date and time',
    'Pakai waktu ini': 'Use this time',
    'Peran': 'Role',
    'Analisis cepat hari ini': 'Fast analysis today',
    'Catatan tersimpan': 'Saved records',
    'Belum tersedia': 'Not available yet',
    'Tanpa batas': 'Unlimited',
    'Ganti kata sandi': 'Change password',
    'Kata sandi sekarang': 'Current password',
    'Kata sandi baru (minimal 8 karakter)': 'New password (min 8 characters)',
    'Simpan kata sandi baru': 'Save new password',
    'Perangkat lain akan keluar otomatis.': 'Other devices will be signed out automatically.',
    'Panduan penggunaan': 'User guide',
    'Panduan Penggunaan': 'User Guide',
    'Muat ulang data': 'Refresh data',
    'Simpan data ke file': 'Export data to file',
    'Keluar dari akun': 'Sign out',
    'Keluar dan hapus data HP': 'Sign out and clear device data',
    'Sembunyikan Foto Google': 'Hide Google Photo',
    'Tampilkan Foto Google': 'Show Google Photo',
    'Foto profil Google sedang disembunyikan. Anda dapat menampilkannya lagi kapan saja.': 'Your Google profile photo is hidden. You can show it again anytime.',
    'Masuk dengan Google untuk menampilkan foto profil akun Anda.': 'Sign in with Google to display your account profile photo.',
    'Menyiapkan foto asli…': 'Preparing original photo…',
    'Hasil lama tetap tersimpan.': 'Previous result stays saved.',
    'Foto asli': 'Original photo',
    'Antrean': 'Queue',
    'Hasil': 'Result',
    'Catatan yang sama akan diperbarui. Hasil lama tetap dapat dibaca sampai analisis baru selesai.': 'This same record will be updated. The prior result stays readable until re-analysis finishes.',
    'Lihat hasil terbaru': 'View latest result',
    'Hapus Catatan Ini?': 'Delete This Record?',
    'Hapus Catatan ini?': 'Delete this record?',
    'Tindakan ini tidak bisa dibatalkan.': 'This action cannot be undone.',
    'Pemberitahuan': 'Notification',
    'Data tersimpan ke file.': 'Data exported to file.',
    'Keluar': 'Sign out',
    'Keluar dari akun?': 'Sign out of account?',
    'Keluar dan hapus data HP?': 'Sign out and wipe phone data?',
    'Hapus dan keluar': 'Wipe and sign out',

    // Assessment UI
    'Rekomendasi Tindakan': 'Recommended Actions',
    'Temuan pada Foto': 'Photo Findings',
    'Dugaan Penyebab': 'Suspected Causes',
    'Rekomendasi Pencegahan': 'Prevention Advice',
    'Kebutuhan Unsur Hara': 'Nutrient Needs',
    'Pemantauan Lanjutan': 'Follow-up Monitoring',
    'Kapan Perlu Bantuan': 'When to Seek Help',
    'Penilaian Tanaman': 'Crop Assessment',
    'Dugaan Hama / Penyakit': 'Suspected Pest / Disease',
    'Dugaan diperbarui manual. Rincian di bawah tetap dari analisis AI.': 'Finding manually updated. Details below remain from AI analysis.',
    'Status diperbarui manual. Rincian di bawah tetap dari analisis AI.': 'Status manually updated. Details below remain from AI analysis.',
    'Analisis Lengkap': 'Full Analysis',
    'Penilaian foto adalah dugaan awal. Periksa kondisi tanaman secara langsung.': 'Photo assessment is an initial hypothesis. Inspect the crop in person.',
    'Langkah berikut membantu pemeriksaan. Penanganan khusus perlu disesuaikan dengan penyebab yang sudah dikonfirmasi di lapangan.': 'These steps guide field checks. Tailor specific treatment to the confirmed cause on site.',
    'Rincian analisis terstruktur belum tersedia untuk catatan ini. Ambil foto baru untuk penilaian terbaru.': 'Detailed analysis is not available for this record yet. Take a new photo for updated details.',
    'Temuan Tersimpan': 'Saved Findings',
    'Salin Analisis': 'Copy Analysis',
    'Analisis disalin.': 'Analysis copied.',
    'Tentang Analisis': 'About Analysis',
    'Hasil ini dibuat AI dari foto. Tingkat ketepatannya belum diukur terhadap kumpulan kasus yang dinilai ahli.': 'Generated by AI from a photo; accuracy has not been benchmarked against expert-graded cases.',
    'Tinjau Opsi Kimia / Pupuk': 'Review Chemical / Fertilizer Options',
    'Analisis tanaman': 'Crop analysis',
    'Analisis foto': 'Photo analysis',
    'Foto asli tanpa cap lokasi disiapkan untuk analisis baru.': 'Preparing un-stamped original photo for re-analysis.',
    'Menyiapkan foto asli tanpa cap lokasi…': 'Preparing original photo without watermark…',
    'Hasil lama tetap tersimpan sampai analisis baru selesai.': 'Previous result stays saved until the new analysis completes.',
    'Menunggu giliran analisis ulang': 'Waiting in re-analysis queue',
    'Server sedang sibuk. Analisis dicoba lagi otomatis…': 'Server busy. Retrying analysis automatically…',
    'Sedang menganalisis ulang…': 'Re-analyzing…',
    'Memasukkan analisis ke antrean…': 'Queueing analysis…',
    'Analisis ulang masuk antrean…': 'Re-analysis queued…',
    'Analisis ulang selesai. Hasil sudah masuk ke catatan asli.': 'Re-analysis complete. Updated on the original record.',
    'Analisis selesai. Hasil sudah masuk ke Riwayat.': 'Analysis complete. Result added to History.',
    'Tutup analisis': 'Close analysis',

    // Tour Overlay
    'Mulai': 'Start',
    'Lanjut': 'Next',
    'Lewati': 'Skip',
    'Ketuk Riwayat': 'Tap History',
    'Ketuk Peta': 'Tap Map',
    'Siap Mencatat': 'Ready to Log',
    'Lima langkah untuk mengenal Foto Tanaman, Riwayat, dan Peta.': 'Five quick steps to learn Scan Crop, History, and Map.',
    'Bisa dilewati dan dibuka kembali dari Akun → Panduan Penggunaan.': 'You can skip anytime and reopen via Account → User Guide.',
    'Ambil foto atau pilih dari galeri, pastikan lokasi dan tanggalnya, lalu ketuk Analisis. Tidak ada kamera atau izin yang dibuka oleh panduan ini.': 'Take a photo or choose from gallery, check GPS & date, then tap Analyze. This tour opens no real camera or permissions.',
    'Foto dekat, terang, dan fokus. Hasilnya merupakan dugaan awal yang perlu diperiksa di lapangan.': 'Take bright, focused close-ups. Findings are initial hypotheses to confirm on site.',
    'Cari tanaman dan saring statusnya. Buka tanaman untuk membaca dugaan, pemeriksaan dan pencegahan. Foto lagi lewat ikon kamera; koreksi atau analisis ulang lewat Lainnya. Tab Petak menampilkan ringkasan tiap kebun.': 'Search crops and filter statuses. Tap any crop for diagnosis, checklists, and prevention. Use Camera to add photos or More to edit/re-analyze. Plot tab summarizes each field block.',
    'Titik menunjukkan lokasi tanaman. Gambar batas petak untuk mengelompokkan tanaman; ketuk petak untuk membuka daftar tanaman dan ringkasannya.': 'Pins mark crop locations. Draw plot polygons to group plants; tap any plot for its crop list and summary.',
    'Ringkasan memakai catatan yang tersedia, bukan pemeriksaan seluruh kebun.': 'Summaries reflect recorded photos only, not an uninspected whole-farm survey.',
    'Mulai dengan satu tanaman. Foto yang menunggu sambungan disimpan di perangkat dan dikirim kembali saat tersambung.': 'Start with one crop. Offline photos stay safely on device until signal returns.',
    'Akun menyimpan sisa jatah analisis dan Panduan Penggunaan. Lokasi serta cuaca bisa diperbarui dari Beranda.': 'Account shows remaining fast allowance and User Guide. Refresh location & weather from Home.',

    // Legal Pages Common & Headers/TOC (privacy.html & terms.html)
    'Kebijakan Privasi | JagaKebond': 'Privacy Policy | JagaKebond',
    'Ketentuan Layanan | JagaKebond': 'Terms of Service | JagaKebond',
    'Kebijakan Privasi — JagaKebond': 'Privacy Policy — JagaKebond',
    'Ketentuan Layanan — JagaKebond': 'Terms of Service — JagaKebond',
    'Kembali ke JagaKebond →': 'Back to JagaKebond →',
    'INFORMASI LAYANAN': 'SERVICE INFORMATION',
    'Terakhir diperbarui: 29 Oktober 2026': 'Last updated: October 29, 2026',
    'DI HALAMAN INI': 'ON THIS PAGE',
    'Ada pertanyaan?': 'Questions?',
    'JagaKebond · Catatan kebun dalam genggaman.': 'JagaKebond · Farm records in your pocket.',
    'Hubungi pengelola': 'Contact maintainer',
    'Pahami data yang dipakai JagaKebond, tujuan pemrosesannya, dan cara mengatur atau meminta penghapusan data Anda.': 'Understand the data JagaKebond handles, how it is processed, and how to manage or request deletion.',
    'Panduan penggunaan JagaKebond, tanggung jawab akun, batas hasil AI, dan cara menghubungi pengelola.': 'Guidelines for using JagaKebond, account responsibilities, AI result limits, and maintainer contact.',
    'Tentang kebijakan ini': 'About this policy',
    'Data yang kami tangani': 'Data we handle',
    'Untuk apa data digunakan': 'How data is used',
    'Foto, lokasi, dan pemrosesan AI': 'Photos, location, and AI processing',
    'Akses dan penyedia layanan': 'Access and service providers',
    'Penyimpanan di perangkat': 'On-device storage',
    'Lama penyimpanan dan penghapusan': 'Retention and deletion',
    'Pilihan dan permintaan Anda': 'Your choices and requests',
    'Keamanan dan perubahan kebijakan': 'Security and policy updates',
    '1. Tentang kebijakan ini': '1. About this policy',
    '2. Data yang kami tangani': '2. Data we handle',
    '3. Untuk apa data digunakan': '3. How data is used',
    '4. Foto, lokasi, dan pemrosesan AI': '4. Photos, location, and AI processing',
    '5. Akses dan penyedia layanan': '5. Access and service providers',
    '6. Penyimpanan di perangkat': '6. On-device storage',
    '7. Lama penyimpanan dan penghapusan': '7. Retention and deletion',
    '8. Pilihan dan permintaan Anda': '8. Your choices and requests',
    '9. Keamanan dan perubahan kebijakan': '9. Security and policy updates',
    'Tentang layanan dan ketentuan ini': 'About the service and these terms',
    'Akun dan akses': 'Accounts and access',
    'Hasil AI adalah penilaian awal': 'AI results are initial assessments',
    'Foto dan catatan yang Anda unggah': 'Photos and records you upload',
    'Penggunaan yang diperbolehkan': 'Acceptable use',
    'Ketersediaan, batas, dan layanan pihak ketiga': 'Availability, limits, and third-party services',
    'Berhenti menggunakan dan penghapusan data': 'Stopping use and data deletion',
    'Tanggung jawab, perubahan, dan penyelesaian masalah': 'Liability, changes, and dispute resolution',
    '1. Tentang layanan dan ketentuan ini': '1. About the service and these terms',
    '2. Akun dan akses': '2. Accounts and access',
    '3. Hasil AI adalah penilaian awal': '3. AI results are initial assessments',
    '4. Foto dan catatan yang Anda unggah': '4. Photos and records you upload',
    '5. Penggunaan yang diperbolehkan': '5. Acceptable use',
    '6. Ketersediaan, batas, dan layanan pihak ketiga': '6. Availability, limits, and third-party services',
    '7. Berhenti menggunakan dan penghapusan data': '7. Stopping use and data deletion',
    '8. Tanggung jawab, perubahan, dan penyelesaian masalah': '8. Liability, changes, and dispute resolution',

    // Error & Network Messages (session.js, offline-sync.js, google-signin.js, workflow-ui.js)
    'Sesi berakhir. Silakan masuk lagi.': 'Session expired. Please sign in again.',
    'Akses ditolak.': 'Access denied.',
    'Data tidak ditemukan.': 'Data not found.',
    'Data bentrok dengan perubahan lain. Muat ulang lalu coba lagi.': 'Data conflicts with a newer change. Refresh and try again.',
    'Berkas terlalu besar.': 'File is too large.',
    'Data yang dikirim tidak lengkap atau tidak valid.': 'Submitted data is incomplete or invalid.',
    'Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.': 'Too many requests. Please wait a moment and try again.',
    'Server sedang bermasalah. Coba lagi nanti.': 'Server issue. Please try again later.',
    'Koneksi terlalu lambat. Coba lagi.': 'Connection timed out. Please try again.',
    'Tidak dapat menghubungi server. Periksa koneksi Anda.': 'Cannot reach server. Check your connection.',
    'Terjadi masalah. Coba lagi.': 'Something went wrong. Please try again.',
    'Penyimpanan HP penuh. Hapus foto lama atau kirim foto yang menunggu, lalu coba lagi.': 'Device storage is full. Clear old photos or upload pending drafts, then retry.',
    'Memeriksa akun Google…': 'Checking Google account…',
    'Permintaan masuk sudah dikirim. Tunggu persetujuan admin.': 'Sign-in request submitted. Waiting for admin approval.',
    'Permintaan masuk Anda ditolak admin. Hubungi admin bila ini keliru.': 'Sign-in request was rejected by admin. Contact admin if this is an error.',
    'Akun dinonaktifkan. Hubungi admin.': 'Account disabled. Contact admin.',
    'Masuk dengan Google gagal. Coba lagi.': 'Google sign-in failed. Try again.',
    'Menunggu dikirim': 'Waiting to upload',
    'Menunggu sinyal': 'Waiting for signal',
    'Sedang dikirim': 'Uploading',
    'Sedang dianalisis': 'Analyzing',
    'Siap dikirim': 'Ready to upload',
    'Gagal — coba lagi': 'Failed — try again',
    'Foto terlalu besar — foto ulang': 'Photo too large — retake',
    'Ditolak server — foto ulang': 'Rejected by server — retake',
    'Server belum bisa dicek — dicoba lagi otomatis': 'Server unreachable — retrying automatically',
    'Masuk lagi untuk mengirim': 'Sign in again to upload',
    'Akun berganti — masuk lagi': 'Account changed — sign in again',
    'Foto rusak — hapus lalu foto ulang': 'Corrupted photo — delete and retake',
    'Antrean Anda penuh — dikirim nanti': 'Queue full — will send later',
    'Server sibuk — dicoba lagi otomatis': 'Server busy — retrying automatically',
    'Sinyal lemah — dicoba lagi otomatis': 'Weak signal — retrying automatically',
    'Perlu dicek di Riwayat': 'Check in History',
    'Server belum bisa dihubungi. Menampilkan data terakhir.': 'Cannot reach server. Showing last cached data.',
    'Kata sandi diperbarui': 'Password updated',
    'Data tanaman disimpan.': 'Crop record saved.',
    'Catatan dihapus dari riwayat.': 'Record deleted from history.',
    'Catatan tersimpan di Riwayat > Harian.': 'Note saved in History > Daily.',
    'Catatan harian dihapus.': 'Daily note deleted.',
    'Petak dihapus.': 'Plot deleted.',
    'Semua foto sudah terkirim.': 'All photos are synced.',

    // Interactive 3D Diorama BEATS & HOTSPOT_INFO
    'Bidik daun cabai dengan jarak pas': 'Frame chili leaf at the right distance',
    'Retikel fokus · Jarak 15 hingga 25 cm · GPS terkunci': 'Focus reticle · Distance 15 to 25 cm · GPS locked',
    'Baca panduan suara & 3 langkah cek': 'Read voice guide & 3 check steps',
    'Antraknosa terdeteksi · Panduan audio siap diputar': 'Anthracnose detected · Audio guide ready',
    'Lihat sebaran titik kritis di blok kebun': 'View critical pin spread across plot blocks',
    'Poligon Bedeng Cabai 420 m² · 2 titik Kritis': 'Chili Bed Polygon 420 m² · 2 Critical pins',
    'Draf offline otomatis naik saat sinyal pulih': 'Offline drafts upload automatically when signal returns',
    '1 foto draf tersimpan aman · Sinkron ke server': '1 draft photo safely stored · Synced to server',
    'STASIUN CUACA & SAUNG': 'WEATHER STATION & GAZEBO',
    'Gazebo kayu beratap genteng dua susun dilengkapi anemometer berputar, sensor kelembapan mikro, dan lentera hangat sore.': 'Two-tier tiled timber gazebo equipped with a spinning anemometer, micro-humidity sensor, and warm evening lantern.',
    'Fokus ke 01 · Beranda': 'Focus on 01 · Home',
    'TANAMAN PRIORITAS': 'PRIORITY CROP',
    'Cabai 1 (Status Kritis)': 'Chili 1 (Critical Status)',
    'Terdeteksi bercak melingkar Antraknosa pada daun tengah di Bedeng Cabai. Disarankan membidik kamera 15 hingga 25 cm.': 'Concentric Anthracnose spots detected on mid-canopy leaves in Chili Bed. Aim camera 15 to 25 cm away.',
    'Aktifkan 02 · Kamera HUD': 'Activate 02 · Camera HUD',
    'BLOK TANAM': 'CROP BLOCK',
    'Poligon Bedeng Cabai': 'Chili Bed Polygon',
    'Hamparan 6 rumpun cabai di atas mulsa perak dengan ajir bambu. Dipantau dalam 1 poligon petak digital.': 'Six chili clumps on silver mulch with bamboo stakes, tracked in one digital plot polygon.',
    'Lihat 04 · Peta Petak': 'View 04 · Plot Map',
    'IRIGASI KEBUN': 'FARM IRRIGATION',
    'Kolam Resapan Kebun': 'Garden Catchment Pond',
    'Kolam tampung air kebun berbingkai batu kali dan daun teratai untuk menjaga ketersediaan air siram saat musim kemarau.': 'River-stone bordered garden catchment pond with lotus pads preserving dry-season watering supply.',
    'Lihat Tampilan Luas': 'View Wide Angle',
    'APLIKASI MOBILE WEB': 'MOBILE WEB APP',
    'Ponsel JagaKebond': 'JagaKebond Phone',
    'Antarmuka mobile app.jagake.bond yang menyatukan pantauan cuaca, kamera HUD, diagnosis suara AI, peta petak, dan antrean sinkron offline.': 'Mobile app.jagake.bond interface uniting weather alerts, camera HUD, voice AI diagnosis, plot map, and offline sync queue.',
    'Perbesar Layar Ponsel': 'Enlarge Phone Screen',
    'PANDUAN TINDAKAN AI': 'AI ACTION GUIDE',
    '3 Langkah Cek Hari Ini': '3 Checks for Today',
    'Daftar langkah praktis hasil diagnosis AI lengkap dengan panduan audio Bahasa Indonesia agar mudah diikuti langsung di kebun.': 'Practical AI-guided checklist with audio playback so you can follow along right in the field.',
    'Fokus ke 03 · Diagnosis AI': 'Focus on 03 · AI Diagnosis',
    'PEMETAAN PETAK': 'PLOT MAPPING',
    'Batas Poligon & 6 Pin Status': 'Polygon Boundary & 6 Status Pins',
    'Pagar batas ungu menandai blok Bedeng Cabai seluas 420 m² beserta sebaran pin merah (Kritis), kuning (Waspada), dan hijau (Sehat).': 'Purple perimeter fence marks the 420 m² Chili Bed block with red (Critical), amber (Moderate), and green (Healthy) status pins.',
    'Fokus ke 04 · Peta Petak': 'Focus on 04 · Plot Map',
    'SINKRONISASI OFFLINE': 'OFFLINE SYNC',
    'Awan Sinkronisasi Server': 'Server Sync Cloud',
    'Foto draf yang diambil saat sinyal kebun lemah tersimpan aman di perangkat dan otomatis naik ke server begitu sinyal pulih.': 'Draft photos taken in weak signal areas stay safe on device and upload automatically as soon as connectivity returns.',
    'Fokus ke 05 · Riwayat & Sinkron': 'Focus on 05 · History & Sync',
    'Suhu / RH': 'Temp / RH',
    'Risiko': 'Risk',
    'Waspada Jamur': 'Fungal Alert',
    'Lentera': 'Lantern',
    'Otomatis Sore': 'Auto Evening',
    'Keyakinan AI': 'AI Confidence',
    'Jarak Bidik': 'Shot Distance',
    '15 hingga 25 cm': '15 to 25 cm',
    'Akurasi GPS': 'GPS Accuracy',
    'Blok': 'Block',
    'Bedeng Cabai': 'Chili Bed',
    'Luas Petak': 'Plot Area',
    'Sumber': 'Source',
    'Mata Air Lereng': 'Hillside Spring',
    'Aliran': 'Flow',
    'Stabil': 'Steady',
    'Tenggara Petak': 'Southeast Plot',
    'Kondisi': 'Condition',
    'Jernih': 'Clear',
    'Layar Aktif': 'Active Views',
    '5 Modul': '5 Modules',
    'Resolusi UI': 'UI Viewport',
    'Draf Aman': 'Safe Drafts',
    'Bahasa': 'Language',
    'Indonesia': 'ID / EN',
    'Langkah 1': 'Step 1',
    'Petik Daun Bercak': 'Prune Spotted Leaves',
    'Langkah 2': 'Step 2',
    'Pangkas Tunas Air': 'Trim Water Shoots',
    'Langkah 3': 'Step 3',
    'Semprot Tembaga': 'Apply Copper Spray',
    '0:18 Siap Putar': '0:18 Ready to Play',
    'Luas Blok': 'Block Area',
    'Pin Aktif': 'Active Pins',
    '6 Titik': '6 Pins',
    'Prioritas': 'Priority',
    'Tampilan': 'View',
    'Sudut 50°': '50° Isometric',
    'Antrean Draf': 'Draft Queue',
    '1 Foto Aman': '1 Safe Photo',
    'Status': 'Status',
    'Sinkron Aktif': 'Active Sync',
    'Waktu': 'Time',

    // Additional Daily Log, Shell, Plot Summary, Workflow & Scan Strings
    'Saran:': 'Suggested:',
    'Catatan:': 'Notes:',
    '• Belum ada foto tanaman yang diunggah hari ini.': '• No crop photos uploaded today yet.',
    '• Tidak adanya foto bukan berarti semua tanaman sehat.': '• Having no photos does not mean all crops are healthy.',
    '• Foto tanaman yang ingin dicatat untuk mulai mengisi ringkasan hari ini.': '• Snap any crop you want to record to populate today\'s summary.',
    '• Foto ulang bagian yang sama dengan sudut dan cahaya yang sebanding.': '• Retake the same part using comparable angle and lighting.',
    '• Lengkapi foto tanaman yang belum dapat dinilai.': '• Complete photos for crops that remain uncertain.',
    '• Periksa langsung; hasil yang belum jelas tidak berarti tanaman sehat.': '• Inspect in person; an unclear result does not mean the crop is healthy.',
    '• Lanjutkan pemantauan rutin.': '• Continue routine monitoring.',
    '• Foto ulang bila terlihat perubahan pada tanaman.': '• Take a follow-up photo whenever plant changes appear.',
    '• Beberapa catatan lama tidak dihitung karena waktu unggahnya tidak diketahui.': '• Some older records are excluded because upload time was missing.',
    'Semua foto sudah terkirim': 'All photos synced',
    'Mengirim…': 'Uploading…',
    'Versi baru tersedia': 'New version available',
    'Muat ulang': 'Reload',
    'Muat ulang sekarang?': 'Reload now?',
    'Foto yang belum dianalisis akan hilang. Kirim dulu atau ketuk Lanjut untuk memuat ulang.': 'Unanalyzed photo drafts on screen will be cleared. Upload first or tap Continue to reload.',
    'Belum ada tanaman': 'No crops yet',
    '1 tanaman': '1 crop',
    'Belum dapat dipastikan': 'Uncertain',
    'Penyebab belum dapat dipastikan.': 'Cause remains uncertain.',
    'Penyebab belum dapat dipastikan. Periksa tanaman secara langsung.': 'Cause remains uncertain. Inspect the crop in person.',
    'Analisis ulang belum selesai': 'Re-analysis did not finish',
    'Analisis ulang masih diproses…': 'Re-analysis still running…',
    'Analisis tetap berjalan di server.': 'Analysis continues on the server.',
    'Menunggu giliran analisis': 'Waiting in analysis queue',
    'Sedang menganalisis foto…': 'Analyzing photo…',
    'Foto masuk antrean…': 'Photo queued…',
    'Foto terkirim. Membaca status antrean…': 'Photo uploaded. Checking queue status…',
    'Menyimpan hasil ke Riwayat…': 'Saving result to History…',
    'Analisis selesai.': 'Analysis complete.',
    'Buka Riwayat untuk melihat hasilnya.': 'Open History to view the result.',
    'Tunggu analisis ulang selesai dulu.': 'Wait for the current re-analysis to finish.',
    'Permintaan dibatalkan.': 'Request cancelled.',
    'Pengiriman dibatalkan.': 'Upload cancelled.',
    'Koneksi terlalu lambat. Dicoba lagi otomatis.': 'Connection slow. Retrying automatically.',
    'Tidak ada sinyal. Foto dikirim otomatis saat sinyal ada.': 'Offline. Photo uploads automatically once signal returns.',
    'Belum ada sinyal. Foto dikirim otomatis saat ada sinyal.': 'No signal yet. Photo will upload automatically when online.',
    'Foto terlalu besar untuk server. Ambil ulang foto.': 'Photo too large for server. Please retake.',
    'Foto atau datanya ditolak server. Ambil ulang foto.': 'Photo or metadata rejected by server. Please retake.',
    'Tanaman atau petak tidak ditemukan di server.': 'Crop or plot not found on server.',
    'Foto ini sudah pernah dikirim dengan data berbeda. Periksa di Riwayat.': 'This photo was already uploaded with different data. Check History.',
    'Server sedang bermasalah. Dicoba lagi otomatis.': 'Server issue. Retrying automatically.',
    'Server perlu diperbarui. Foto tetap tersimpan di HP.': 'Server needs an update. Photo remains safely saved on phone.',
    'Anda sudah keluar di jendela lain.': 'Signed out in another tab.',
    'Akun di perangkat ini sudah berganti. Muat ulang aplikasi.': 'Account on this device changed. Reload app.',
    'Sesi Anda berakhir. Silakan masuk lagi.': 'Session expired. Please sign in again.',
    'Belum ada akun Google di HP ini. Tambahkan akun Google di Setelan HP, lalu coba lagi.': 'No Google account on this device. Add one in Settings and retry.',
    'Masuk dengan Google belum bisa di HP ini. Masuk dengan email dan kata sandi.': 'Google sign-in unavailable on this device. Sign in with email and password.',
    'Perbarui APK untuk penyimpanan foto pribadi.': 'Update the APK for encrypted local photo storage.',
    'Cap lokasi belum tersedia di aplikasi ini.': 'Location stamp not available in this build.',
    'Foto lokal tidak dapat dibaca.': 'Cannot read local photo.',
    'Foto asli tidak dapat disimpan.': 'Cannot save original photo.',
    'Foto kualitas asli tidak ada di perangkat ini.': 'Full-resolution copy is not on this device.',
    'Ketuk peta untuk menaruh titik pertama': 'Tap map to place first point',
    'Ketuk untuk menambah titik': 'Tap to add point',
    'Ketuk titik pertama untuk menutup petak': 'Tap first point to close plot',
    'Petak butuh minimal 3 titik.': 'Plot requires at least 3 points.',
    'Beri nama petak minimal 2 huruf.': 'Enter at least 2 characters for the plot name.',
    'Batas tidak valid. Periksa koordinat atau garis yang berpotongan.': 'Invalid boundary. Check coordinates or crossing lines.',
    'Lokasi tersimpan': 'Location saved',
    'Lokasi petak': 'Plot location',
    'Tanpa petak (titik / koordinat)': 'No plot (custom pin / coordinates)',
    'Lokasi foto atau tanaman': 'Photo or crop location',
    'Lokasi Foto atau Tanaman': 'Photo or Crop Location',
    'Geser pin ke lokasi foto atau pilih petak tempat tanaman berada.': 'Drag the pin to the crop spot or pick the plot containing it.',
    'Atur Koordinat Manual': 'Set Manual Coordinates',
    'Lintang (derajat)': 'Latitude (degrees)',
    'Bujur (derajat)': 'Longitude (degrees)',
    'Memilih petak menaruh pin di tengah petak. Sesuaikan pin bila lokasi tanaman berbeda.': 'Selecting a plot centers the pin inside it. Adjust if the crop sits elsewhere.',
    'Simpan Lokasi': 'Save Location',
    'Memperbarui lokasi…': 'Updating location…',
    'Belum ada tanaman tercatat.': 'No tracked crops yet.',
    'Belum dipilih tanamannya': 'Crop not chosen yet',
    'Lokasi belum akurat': 'Inaccurate GPS location',
    'Lokasi belum tersedia': 'Location unavailable',
    'Kamera tidak didukung di sini.': 'Camera not supported here.',
    'Akses kamera ditolak. Aktifkan izin kamera atau pilih foto dari galeri.': 'Camera access denied. Enable permission or pick a gallery photo.',
    'Kamera belum tersedia. Coba lagi atau pilih foto dari galeri.': 'Camera unavailable. Retry or pick a gallery photo.',
    'Arahkan kamera ke tanaman dulu.': 'Point the camera at a crop first.',
    'Masuk untuk menyimpan foto.': 'Sign in to save photo.',
    'Tutup pengaturan lokasi': 'Close location picker',
    'Tutup foto': 'Close photo',
    'Tutup detail': 'Close details',
    'Foto tanaman': 'Crop photo',
    'Tanaman tidak ditemukan. Muat ulang riwayat terlebih dahulu.': 'Crop not found. Reload History first.',
    'Foto belum dikirim': 'Photo not yet uploaded',
    'Buang dan foto baru': 'Discard and take new',
    'tanaman ini': 'this crop',
    'Riwayat belum dapat dihubungkan:': 'Could not link history:',
    'Isi kata sandi saat ini dan kata sandi baru.': 'Enter both your current and new password.',
    'Akun': 'Account',
    'Lokasi Kebun': 'Farm Location',
    'Analisis tidak selesai. Ambil foto baru atau buang draf.': 'Analysis did not finish. Take a new photo or discard the draft.',
    'Foto terkirim. Hasilnya masuk ke Riwayat.': 'Photo sent. Results will appear in History.',
    'Sesi berakhir. Masuk lagi untuk mengirim foto yang tersimpan.': 'Session expired. Sign in again to upload saved photos.',
    'Hasil belum tersimpan:': 'Result not yet saved:',
    'Masuk dulu untuk mengirim foto yang tersimpan.': 'Sign in first to upload saved photos.',
    'Belum bisa mengirim:': 'Cannot send yet:',
    '· zona EXIF tidak diketahui': '· EXIF time zone unknown',
    '· waktu manual': '· manual timestamp',
    'Waktu foto tidak diketahui': 'Photo time unknown',
    'Lokasi tidak diketahui': 'Location unknown',
    'Lokasi belum terbaca. Coba lagi di tempat terbuka.': 'Location not yet read. Try again outdoors.',
    'Model yang dilaporkan penyedia:': 'Provider-reported model:',
    'GPS tidak tersedia': 'GPS unavailable',
    'Alat peta belum dapat dimuat. Sambungkan internet lalu coba lagi. Catatan tanaman tetap tersedia di Riwayat.': 'Map tools failed to load. Connect to the internet and retry. Your crop records remain available in History.',
    'Titik dan petak Anda tetap terlihat.': 'Your pins and plots remain visible.',
    'Di batas dua petak: pilih petaknya': 'On the boundary of two plots: choose one',
    'Di luar petak': 'Outside any plot',
    'menunggu GPS': 'waiting for GPS',
    '· butuh minimal 3': '· need at least 3',
    'Butuh minimal 3 titik.': 'At least 3 points are required.',
    'Petak belum bisa diselesaikan. Ketuk titik pertama untuk menutup.': 'Plot cannot be finished yet. Tap the first point to close it.',
    'Alat gambar peta belum siap. Muat ulang halaman.': 'Map drawing tools are not ready. Reload the page.',
    'Ketuk peta di setiap sudut petak.': 'Tap the map at each corner of the plot.',
    'Gagal memulai gambar petak.': 'Could not start drawing the plot.',
    'Gagal menyimpan petak:': 'Could not save plot:',
    'Belum ada petak. Ketuk ikon segi lima di kanan peta untuk menggambar petak, atau ikon jejak kaki sambil berjalan di batas kebun.': 'No plots yet. Tap the pentagon icon on the right side of the map to draw a plot, or the footprint icon while walking the boundary.',
    'Tanaman belum diisi': 'Crop not set',
    'Geser titik sudut untuk mengubah batas. Selesai menggeser membuka formulir; perubahan belum disimpan.': 'Drag corner points to adjust the boundary. Finishing opens the form; changes are not saved yet.',
    'Batas tidak valid': 'Invalid boundary',
    'Hapus Petak Ini?': 'Delete This Plot?',
    'Gagal menghapus petak:': 'Could not delete plot:',
    'Lokasi belum terbaca. Ketuk tombol perbarui di Beranda.': 'Location not yet available. Tap Refresh on Home.',
    'Peta sedang dimuat. Coba sebentar lagi.': 'Map is still loading. Try again in a moment.',
    'HP ini tidak punya GPS.': 'This device has no GPS.',
    'Berjalanlah di sekeliling batas kebun. Ketuk "Selesai jalan" bila sudah kembali ke titik awal.': 'Walk around the farm boundary. Tap "Finish walk" once back at the starting point.',
    'Jejak terlalu pendek. Berjalanlah mengelilingi batas kebun dulu.': 'Track is too short. Walk around the plot boundary first.',
    'Buka tanamannya, lalu Lainnya → Ubah lokasi untuk menaruhnya di peta.': 'Open the crop, then tap More → Edit location to place it on the map.',
    'Ketinggian tidak tersedia': 'Elevation unavailable',
    'Catatan ini belum punya foto tersimpan.': 'This record has no saved photo yet.',
    'Pratinjau foto tidak dapat dimuat. Periksa koneksi atau buka kembali Riwayat.': 'Photo preview failed to load. Check your connection or reopen History.',
    'Foto Analisis': 'Analysis Photo',
    'Sebelum analisis ulang:': 'Before re-analysis:',
    'Tidak tersedia': 'Unavailable',
    'Belum ada saran. Foto ulang bila perlu.': 'No advice yet. Take another photo if needed.',
    'Rekomendasi tindakan:': 'Recommended actions:',
    'Lainnya': 'More',
    'Belum Ada Foto Tanaman': 'No Crop Photos Yet',
    'Foto satu tanaman untuk memulai riwayatnya.': 'Photograph a crop to start its history.',
    'Pembacaan suara belum tersedia di perangkat ini.': 'Voice readout is not available on this device.',
    'Lihat Detail': 'View Details',
    'Status diperbarui:': 'Status updated:',
    'Gagal memperbarui status:': 'Could not update status:',
    'Belum ada lokasi': 'No location yet',
    'Isi jenis tanaman.': 'Enter the crop type.',
    'Tanggal foto tidak valid.': 'Invalid photo date.',
    'Tanggal foto tidak boleh setelah hari ini.': 'Photo date cannot be after today.',
    'Analisis ulang dengan jenis baru?': 'Re-analyze with new crop type?',
    'jenis lain': 'another crop type',
    'Analisis ulang': 'Re-analyze',
    'Gagal menyimpan:': 'Could not save:',
    'Gagal menghapus:': 'Could not delete:',
    'Hapus Catatan harian?': 'Delete Daily Log?',
    'Catatan ini akan dihapus dari arsip harian secara permanen.': 'This entry will be permanently removed from the daily archive.',
    'Belum ada foto tanaman diunggah hari ini.': 'No crop photos uploaded today.',
    'Tulis catatan dulu, atau ketuk "Pakai ringkasan".': 'Write a note first, or tap "Use summary".',
    'Menyimpan…': 'Saving…',
    'Catatan belum tersimpan:': 'Note not yet saved:',
    'Menunggu data cuaca': 'Waiting for weather data',
    'Ketuk untuk menandai batas petak di peta': 'Tap to mark plot boundaries on the map',
    'Pilih Tanaman': 'Select Crop',
    'Menunggu lokasi…': 'Waiting for location…',
    '. Aktifkan izin lokasi lalu ketuk Perbarui. Foto galeri dapat diberi pin secara manual.': '. Enable location permission then tap Refresh. Gallery photos can be pinned manually.',
    'Memperbarui lokasi dan cuaca…': 'Updating location and weather…',
    'Data belum dapat diperbarui. Koordinat tetap tersedia; coba tombol perbarui.': 'Could not update data yet. Coordinates remain available; try the refresh button.',
    'GPS tidak didukung': 'GPS not supported',
    'Aktifkan GPS sebelum mencari nama tempat di sekitar lokasi.': 'Enable GPS before looking up nearby place names.',
    'Konfirmasi': 'Confirm',
    'Tanaman dalam petak': 'Crops in plot',
    'Belum ada tanaman tercatat di petak ini.': 'No tracked crops in this plot yet.',
    'Simpan jejak petak': 'Save plot track',
    'GPS tidak didukung perangkat.': 'GPS is not supported on this device.',
    'Lokasi GPS diperbarui.': 'GPS location updated.',
    'Izin lokasi ditolak. Aktifkan izin lokasi untuk situs ini di pengaturan browser.': 'Location permission denied. Enable location permission for this site in browser settings.',
    'Lokasi belum tersedia. Coba lagi di tempat terbuka.': 'Location unavailable yet. Retry outdoors in an open area.',
    'Dugaan sebelum analisis ulang:': 'Estimate before re-analysis:',
    '· Belum terkonfirmasi.': '· Unconfirmed.',
    'Penilaian foto adalah dugaan awal.': 'Photo assessment is an initial estimate.',
    'Penyedia tidak melaporkan model yang menjalankan analisis.': 'Provider did not report which model ran the analysis.',
    'Sasaran yang ingin ditinjau:': 'Target condition to review:',
    '(dari analisis foto ini)': '(from this photo analysis)',
    'Opsional; kosongkan bila belum diketahui': 'Optional; leave blank if unknown',
    'Data tanah / uji hara (bila ada)': 'Soil / nutrient test data (if any)',
    'Opsional; kosongkan bila belum ada': 'Optional; leave blank if none',
    'Cari referensi produk': 'Find product references',
    'Memeriksa katalog…': 'Checking catalog…',
    'Sasaran yang disebut sumber:': 'Target cited by source:',
    'Belum lengkap:': 'Incomplete:',
    'Buka sumber produsen': 'Open manufacturer source',
    'Foto tanaman yang akan dianalisis ulang': 'Crop photo to re-analyze',
    'Server belum memberi nomor analisis ulang. Coba lagi.': 'Server did not return a re-analysis ID. Try again.',
    'Koneksi terputus. Mencoba membaca hasil lagi…': 'Connection lost. Retrying to load results…',
    'Menyimpan hasil ke catatan yang sama…': 'Saving result to the same record…',
    'Catatan asli tidak ditemukan setelah analisis selesai.': 'Original record was not found after analysis finished.',
    'Hasilnya masuk ke Riwayat setelah selesai.': 'Results are added to History once finished.',
    'Foto tanaman yang sedang dianalisis': 'Crop photo currently being analyzed',
    'Koneksi terputus. Mencoba membaca status lagi…': 'Connection lost. Retrying status check…',
    'Server tidak dapat menyelesaikan analisis foto ini.': 'Server could not finish analyzing this photo.',
    'Lihat pilihan di daftar foto.': 'See options in the photo list.',
    'Foto asli catatan ini tidak tersedia untuk analisis ulang.': 'Original photo for this record is not available for re-analysis.',
    'Masuk dengan akun pemilik foto.': 'Sign in with the photo owner\'s account.',
    'Akun berubah; foto tetap terkunci.': 'Account changed; photo stays locked.',
    'Data foto ditolak server. Ambil ulang foto.': 'Photo data rejected by server. Take a new photo.',
    'Server sedang sibuk. Dicoba lagi otomatis.': 'Server is busy. Retrying automatically.',
    'Server menolak kiriman ini. Muat ulang aplikasi atau masuk lagi.': 'Server rejected this upload. Reload the app or sign in again.',
    'Server gagal memproses foto ini berkali-kali. Coba kirim lagi nanti.': 'Server repeatedly failed to process this photo. Try again later.',
    'Baik': 'OK',
    'Foto tanaman yang berada di dalam batas petak ini untuk mulai mengisi ringkasan.': 'Photograph crops inside this plot boundary to start building its summary.',
    'Temuan': 'Findings',
    'Lokasi:': 'Location:',
    'Lokasi kurang akurat': 'Low GPS accuracy',
    'tercatat': 'recorded',
    'Diambil': 'Taken',
    'Kamera terhenti. Ketuk Putar atau buka lagi tab Kamera.': 'Camera paused. Tap Switch or reopen the Camera tab.',
    'Kamera tidak didukung di sini. Pilih foto dari galeri.': 'Camera is not supported here. Pick a photo from gallery.',
    'Gambar tidak dapat dibaca': 'Image unreadable',
    'zona perangkat tidak diketahui': 'device time zone unknown',
    'Berkas harus berupa gambar.': 'File must be an image.',
    'Berkas foto kosong.': 'Photo file is empty.',
    'Foto melebihi 12 MB. Pilih foto yang lebih kecil.': 'Photo exceeds 12 MB. Choose a smaller photo.',
    'Tanggal tidak valid.': 'Invalid date.',
    'Tanggal foto tidak boleh di masa depan.': 'Photo date cannot be in the future.',
    'Tanggal foto disimpan.': 'Photo date saved.',
    'Foto ditolak server. Ambil ulang foto.': 'Photo rejected by server. Retake photo.',
    'Foto belum bisa dikirim': 'Photo could not be uploaded yet',
    'Foto belum bisa disimpan. Coba lagi.': 'Photo could not be saved yet. Try again.',
    'Foto belum bisa disimpan': 'Photo could not be saved yet',
    'Dibatalkan. Foto masih ada di layar.': 'Cancelled. Photo remains on screen.',
    'Menunggu giliran': 'Waiting in queue',
    'nomor': 'number',
    'Anda boleh lanjut memotret.': 'You can keep taking photos.',
    'Server tidak dapat menyelesaikan analisis ini.': 'Server could not complete this analysis.',
    'Sebaiknya ambil foto lain yang lebih dekat dan jelas.': 'Consider taking a closer, clearer photo.',
    'Fotonya sudah tidak ada. Ambil ulang foto tanaman Anda.': 'The photo is no longer available. Retake your crop photo.',
    'Lengkapi dengan foto seluruh tanaman dan foto dekat bagian yang berubah. Gunakan cahaya yang cukup dan periksa kondisi tanaman langsung; beberapa penyebab memerlukan pemeriksaan petugas.': 'Add a photo of the whole plant and a close-up of affected parts. Use good lighting and inspect directly; some causes require an officer check.',
    'Belum ada saran. Periksa tanaman langsung.': 'No suggestions yet. Inspect the crop directly.',
    'Hasil belum masuk Riwayat. Dicoba lagi otomatis.': 'Result has not reached History yet. Retrying automatically.',
    'Pembacaan suara belum tersedia di HP ini.': 'Voice readout is not available on this phone.',
    '*Laporan Lapangan JagaKebond*': '*JagaKebond Field Report*',
    'Tanaman:': 'Crop:',
    'Kondisi:': 'Condition:',
    'Waktu:': 'Time:',
    'Belum ada hasil untuk ditampilkan di peta.': 'No results to show on map yet.',
    'Hasil tetap tersimpan di server:': 'Result remains saved on the server:',
    'Status belum diperbarui:': 'Status not yet updated:',
    'Kirim': 'Send',
    'Lihat kemajuan analisis:': 'View analysis progress:',
    'Foto tidak ditemukan di HP ini.': 'Photo not found on this device.',
    'Foto tidak ditemukan di HP ini. Hapus lalu foto ulang.': 'Photo not found on this device. Delete it and take a new photo.',
    'Daftar foto belum bisa dibuka:': 'Could not open photo list:',
    'Analisis sudah selesai; hasilnya disimpan di Riwayat.': 'Analysis completed; result saved to History.',
    'Ambil atau pilih foto terlebih dahulu.': 'Take or choose a photo first.',
    'Petak tidak tersedia.': 'Plot unavailable.',
    'Isi lintang −90…90 dan bujur −180…180, atau pilih petak.': 'Enter latitude −90…90 and longitude −180…180, or choose a plot.',
    'Draf tidak ditemukan.': 'Draft not found.',
    'Lokasi server tersimpan; salinan lokal belum diperbarui:': 'Server location saved; local copy not updated:',
    'Foto asli tidak tersedia.': 'Original photo unavailable.',
    'Foto bercap JagaKebond disimpan ke galeri.': 'JagaKebond-stamped photo saved to gallery.',
    'Buka foto dari Riwayat untuk ekspor.': 'Open the photo from History to export.',
    'Atur Lokasi': 'Set Location',
    'Peta pilih lokasi': 'Pick location on map',
    'Ubah lokasi foto ini dari Riwayat.': 'Change this photo\'s location from History.',
    'Foto bisa disimpan setelah masuk Riwayat.': 'Photo can be downloaded after it appears in History.',
    'Data kebun tersimpan aman di perangkat & server.': 'Farm data safely stored on device & server.',
    'Kelola akun & data': 'Manage account & data',
    'Contoh Peta Bedeng Cabai dengan empat tanaman.': 'Sample Chili Bed map showing four tracked plants.',
    'Contoh Beranda JagaKebond dengan ringkasan kebun.': 'Sample JagaKebond Home screen with farm summary.',
    'Contoh Riwayat Cabai dengan status Kritis dan tiga foto.': 'Sample Chili History with Critical status and three photos.',
    '. Baca': '. Read',
    'Di aplikasi, panduan ini dapat dibuka kembali kapan saja lewat Akun lalu Panduan Penggunaan.': 'In the app, you can reopen this guide anytime via Account → User Guide.',
    'Kartu riwayat bertingkat per tanaman': 'Layered per-plant history cards',
    'Poligon bedeng dan pin status tampil': 'Plot polygons and status pins shown',
    'Tetap Jalan Saat Sinyal Hilang': 'Keep Working Offline',
    'Saat sinyal kebun hilang, foto dan catatan harian tetap tersimpan sebagai draf di perangkat Anda lalu terkirim otomatis ketika koneksi kembali.': 'When field signal drops, photos and daily notes stay saved as local drafts and upload automatically once online.',
    'Sinkronisasi antrean draf ke awan': 'Sync queued drafts to cloud',
    'Ikon status di bilah atas selalu menunjukkan apakah koneksi sedang offline atau semua draf sudah tersinkron.': 'The status badge in the top bar always shows whether you are offline or all drafts are synced.',
    'Catatan terpadu lapangan hingga arsip': 'Unified records from field to archive',
    'Setiap pemotretan, pembaruan cuaca harian, gambar batas petak, dan koreksi catatan lapangan tersimpan rapi pada akun kebun Anda dan terenkripsi selama sinkronisasi.': 'Every photo, daily weather update, plot boundary, and field correction is stored neatly in your farm account and encrypted during sync.',
    'Status sinkronisasi belum tersedia': 'Sync status unavailable',
    'draf menunggu': 'pending',
    'Coba sinkronkan': 'Sync now',
    'Menunggu data cuaca lokal untuk peringatan kelembapan & jamur.': 'Waiting for local weather data for humidity & fungus alerts.',
    '(opsional)': '(optional)',
    'Bahasa / Language': 'Language',
    'Geser batas di peta': 'Edit boundary on map',
    'Contoh Peta Bedeng Cabai dengan empat tanaman, satu Kritis, satu Waspada, dan dua Sehat.': 'Sample Chili Bed map with four tracked plants: one Critical, one Moderate, and two Healthy.',
    'Contoh Riwayat Cabai dengan daun rusak, status Kritis, dan tiga foto.': 'Sample Chili History with damaged leaves, Critical status, and three photos.',
    'Pilihan akun': 'Account options',
    'Inti JagaKebond': 'JagaKebond Core Idea',
    'Animasi panduan 3D interaktif yang menjelaskan alur kerja JagaKebond': 'Interactive 3D guide animation explaining the JagaKebond workflow',
    'Pilih langkah panduan 3D': 'Choose 3D guide step',
    'Status sinkronisasi': 'Sync status',
    'Ringkasan tanaman': 'Crop summary',
    'Zoom 2x': '2x Zoom',
    'Putar kamera': 'Switch camera',
    'Pilih jenis tanaman': 'Choose crop type',
    'Kemajuan pengiriman': 'Upload progress',
    'Simpan foto ke galeri': 'Save photo to gallery',
    'Bagikan lewat WhatsApp': 'Share via WhatsApp',
    'Tampilkan berdasarkan status': 'Filter by status',
    'Jenis peta': 'Map layer',
    'Daftar petak': 'Plot list',
    'Menggambar petak': 'Drawing plot',
    'Ubah batas petak': 'Edit plot boundary',
    'Batalkan ubah batas': 'Cancel boundary edit',
    'Detail tanaman': 'Crop details',
    'Riwayat tanaman ini': 'History for this crop',
    'Ubah jenis, tanggal, atau lokasi': 'Edit crop type, date, or location',
    'Tampilan riwayat': 'History view',
    'Saring berdasarkan status': 'Filter by status',
    'Contoh: Kopi': 'e.g. Coffee',
    'Contoh: Hawar daun': 'e.g. Leaf blight',
    'Contoh: Wereng': 'e.g. Planthopper',
    'Kata sandi baru': 'New password',
    'Foto tanaman ukuran penuh': 'Full-size crop photo',
    'Contoh: Kebun Kopi Ciasmara': 'e.g. Ciasmara Coffee Plot',
    'Tutup daftar tanaman': 'Close crop list',
    'Tutup menu navigasi': 'Close navigation menu',
    'Buka ringkasan dan saran petak': 'Open plot summary & advice',
    'Tampilkan semua petak di peta': 'Show all plots on map',
    'Sembunyikan kemajuan analisis ulang': 'Hide re-analysis progress',
    'Kemajuan analisis ulang': 'Re-analysis progress',
    'Tahapan analisis ulang': 'Re-analysis stages',
    'Daftar isi': 'Table of contents',
    'Layar Berikutnya →': 'Next Screen →',
    'Putar / Jeda (Spasi)': 'Play / Pause (Space)',
    'Ganti suasana cahaya Pagi / Sore Emas (G)': 'Toggle Morning / Golden Hour light (G)',
    'Putar pulau perlahan otomatis (O)': 'Auto-orbit island slowly (O)',
    'Perbesar layar ponsel JagaKebond (P)': 'Zoom into JagaKebond phone screen (P)',
    'Kembalikan kamera ke posisi stasiun (R)': 'Reset camera to station view (R)',
    'Garis waktu 20 detik': '20-second timeline',
    'Izin lokasi ditolak': 'Location permission denied',
    '. Aktifkan izin lokasi lalu ketuk Perbarui. Foto galeri dapat diberi pin secara manual.': '. Enable location permission and tap Refresh. Gallery photos can be pinned manually.',
    'Periksa bagian tanaman dengan dugaan serupa, termasuk tanaman lain yang belum difoto. Catat letak dan jumlah gejalanya; jangan menyimpulkan penularan dari jumlah foto.': 'Inspect crops with similar suspected issues, including plants not yet photographed. Record symptom locations and counts; do not infer transmission rate from photo count.',
    'Minta pemeriksaan tanah atau daun bila dicurigai masalah hara. Foto dan ketinggian saja belum cukup untuk memilih pemupukan.': 'Request a soil or leaf test if a nutrient issue is suspected. Photos and elevation alone cannot determine fertilization needs.',
    'Tidak ada gejala yang jelas pada foto-foto yang tercatat. Tetap periksa tanaman secara langsung; ringkasan ini bukan jaminan seluruh petak bebas masalah.': 'No clear symptoms in recorded photos. Still inspect crops in person; this summary does not guarantee the entire plot is free of issues.',
    'Dihitung dari foto terakhir setiap tanaman di petak ini dan diperbarui otomatis setiap ada perubahan. Ini panduan umum, bukan diagnosis pasti atau takaran obat. Untuk obat dan dosis, tanyakan penyuluh pertanian setempat.': 'Calculated from each plant\'s latest photo in this plot and updated automatically on any change. This is general guidance, not a confirmed diagnosis or dosage. Consult a local agricultural extension officer for treatments and dosages.',
    'belakang': 'rear',
    'depan': 'front',
    'Kamera diganti ke {dir}': 'Camera switched to {dir}',
    'Tanggal foto: {label}': 'Photo date: {label}',
    '±{dist} m dari foto ini · {count} foto · terakhir {sev}': '±{dist} m from this photo · {count} photos · latest {sev}',
    'Belum bisa menyimpan tanaman: {err}': 'Could not save crop yet: {err}',
    '{n} hasil analisis yang tertunda sudah masuk ke Riwayat.': '{n} pending analysis results have been added to History.',
    '{n} sudut': '{n} corners',
    ' \u00b7 Belum terkonfirmasi.': ' \u00b7 Unconfirmed.',
    'Pilih teks analisis lalu gunakan Salin pada perangkat Anda.': 'Select the analysis text, then use Copy on your device.',
    'Opsional. Referensi produk hanya dibuka setelah Anda menyetujui batasannya. Kolom kondisi lahan boleh dikosongkan bila belum diketahui.': 'Optional. Product references unlock only after you accept the limitations. Field condition fields may be left blank if unknown.',
    'Referensi bukan resep dari foto. Pastikan diagnosis di lapangan, izin edar, tanaman/sasaran dan label terbaru. Ikuti APD, batas aplikasi, jeda panen dan masuk kembali pada label. Jangan mencampur produk tanpa petunjuk. Foto daun saja tidak cukup untuk menentukan kebutuhan pupuk.': 'References are not prescriptions from a photo. Verify the field diagnosis, registration status, crop/target, and current label. Follow PPE, application limits, pre-harvest, and re-entry intervals on the label. Do not tank-mix without label instructions. Leaf photos alone cannot determine fertilizer needs.',
    'Centang pernyataan batasan referensi untuk membuka formulir referensi produk.': 'Check the reference limitation statement to open the product reference form.',
    'Kondisi lahan boleh dikosongkan. Referensi disaring dari jenis tanaman dan sasaran aktif; isian ini tidak menghasilkan dosis atau resep pupuk pribadi.': 'Field conditions may be left blank. References are filtered by crop type and active target; these entries do not produce personalized dosages or fertilizer recipes.',
    'Nomor menurut produsen: {num}; status terkini belum dikonfirmasi.': 'Manufacturer number: {num}; current status unconfirmed.',
    'Diperiksa {date} \u00b7 Bukan konfirmasi stok atau izin edar aktif.': 'Checked {date} \u00b7 Not a confirmation of stock or active registration.',
    'Belum ada referensi untuk pasangan tanaman dan sasaran ini. Jangan memakai produk untuk tanaman lain sebagai pengganti.': 'No references yet for this crop and target pair. Do not use products labeled for other crops as substitutes.',
    'Hasil lama tetap tersimpan dan dapat dibaca sampai analisis baru selesai.': 'Previous result stays saved and readable until the new analysis completes.',
    'Posisi antrean: {pos}. Hasil lama tetap tersimpan.': 'Queue position: {pos}. Previous result stays saved.',
    'Foto asli tanpa cap berhasil disiapkan. Hasil lama tetap tersimpan.': 'Original un-stamped photo prepared. Previous result stays saved.',
    'Analisis tetap berjalan di server. Hasil lama tetap tersimpan.': 'Analysis is still running on the server. Previous result stays saved.',
    'Analisis selesai. Memperbarui foto tanpa membuat catatan baru.': 'Analysis complete. Updating photo without creating a new record.',
    'Dugaan sebelumnya disimpan sebagai pembanding; catatan baru tidak dibuat.': 'Previous finding kept for comparison; no new record was created.',
    'Analisis ulang tidak selesai. Analisis lama tetap tersimpan.': 'Re-analysis did not complete. Previous analysis stays saved.',
    'Analisis tetap berjalan di server. Buka kembali catatan ini nanti; hasil lama tetap tersimpan.': 'Analysis is still running on the server. Re-open this record later; previous result stays saved.',
    'Analisis ulang gagal: {reason} Analisis lama tetap tersimpan.': 'Re-analysis failed: {reason} Previous analysis stays saved.',
    'Posisi antrean: {pos}.': 'Queue position: {pos}.',
  };

  /* ------------------------------------------------------------ Parameterized Patterns */
  const PATTERNS_EN = [
    [/^Langkah (\d+) dari (\d+)$/, (_, a, b) => `Step ${a} of ${b}`],
    [/^(\d+) foto$/, (_, n) => `${n} ${Number(n) === 1 ? 'photo' : 'photos'}`],
    [/^(\d+) tanaman$/, (_, n) => `${n} ${Number(n) === 1 ? 'crop' : 'crops'}`],
    [/^(\d+) jenis$/, (_, n) => `${n} ${Number(n) === 1 ? 'species' : 'species'}`],
    [/^(\d+) titik$/, (_, n) => `${n} ${Number(n) === 1 ? 'point' : 'points'}`],
    [/^(\d+) petak aktif · (\d+) tanaman tercatat$/, (_, f, p) => `${f} active plots · ${p} tracked crops`],
    [/^(\d+) draf menunggu$/, (_, n) => `${n} pending drafts`],
    [/^(\d+) belum terkirim$/, (_, n) => `${n} unsent`],
    [/^(\d+) gagal$/, (_, n) => `${n} failed`],
    [/^(\d+) dianalisis$/, (_, n) => `${n} analyzing`],
    [/^(\d+) hasil baru(?:, (\d+) foto menunggu)?$/, (_, a, b) => `${a} new results` + (b ? `, ${b} photos pending` : '')],
    [/^(\d+) foto menunggu$/, (_, n) => `${n} photos pending`],
    [/^Offline · (\d+)$/, (_, n) => `Offline · ${n}`],
    [/^(\d+) petak tersimpan$/, (_, n) => `${n} ${Number(n) === 1 ? 'saved plot' : 'saved plots'}`],
    [/^(\d+) tanaman berdekatan$/, (_, n) => `${n} nearby ${Number(n) === 1 ? 'crop' : 'crops'}`],
    [/^(\d+) Tanaman Berdekatan$/, (_, n) => `${n} Nearby Crops`],
    [/^(\d+) tanaman belum punya lokasi$/, (_, n) => `${n} crops missing location`],
    [/^Diperbarui (.+)$/, (_, rest) => `Updated ${translateDateTokens(rest)}`],
    [/^Data terakhir berubah (.+)$/, (_, rest) => `Last updated ${translateDateTokens(rest)}`],
    [/^Lokasi: (.+?) ±(\d+) m$/, (_, place, m) => `Location: ${place} ±${m} m`],
    [/^Lokasi kurang akurat ±(\d+) m$/, (_, m) => `Weak GPS accuracy ±${m} m`],
    [/^Elevasi (\d+) m dpl$/, (_, m) => `Elevation ${m} m asl`],
    [/^Akurasi GPS (baik|sedang|rendah)$/, (_, q) => `GPS accuracy ${{ baik: 'good', sedang: 'fair', rendah: 'low' }[q]}`],
    [/^Analisis cepat hari ini: sisa (\d+) dari (\d+)\. Setelah habis, foto masuk antrean biasa\.$/, (_, left, max) => `Fast analysis today: ${left} of ${max} left. After that, photos use the standard queue.`],
    [/^(\d+) dari (\d+) tersisa$/, (_, left, max) => `${left} of ${max} left`],
    [/^Semua (\d+) foto$/, (_, n) => `All ${n} photos`],
    [/^Terapkan ke semua (\d+) foto tanaman ini$/, (_, n) => `Apply to all ${n} photos of this plant`],
    [/^Dikenali AI sebagai: (.+)$/, (_, c) => `Detected by AI as: ${translateCrop(c)}`],
    [/^Simpan ke (.+)$/, (_, c) => `Save to ${translateCrop(c)}`],
    [/^Foto (.+?) · (.+)$/, (_, c, d) => `Photo of ${translateCrop(c)} · ${translateDateTokens(d)}`],
    [/^(\d+) dari (\d+) tanaman (.+?) yang tercatat memerlukan perhatian\. Jumlah ini hanya mencakup tanaman yang didokumentasikan\.$/, (_, s, p, c) => `${s} of ${p} recorded ${translateCrop(c)} crops need attention. This count covers documented plants only.`],
    [/^Periksa langsung dahulu tanaman berstatus Kritis: (.+?)\. Buka Riwayat dan ketuk nama tanaman untuk melihat langkah pemeriksaannya\.$/, (_, list) => `Inspect Critical crops first: ${list}. Open History and tap the crop name for its inspection checklist.`],
    [/^Status pengamatan lebih berat dibanding catatan sebelumnya: (.+?)\. Ini bukan bukti perubahan biologis atau hasil perawatan\.$/, (_, list) => `More severe than the previous record: ${list}. This is not clinical proof of biological progression.`],
    [/^Status pengamatan lebih ringan dibanding catatan sebelumnya: (.+?)\. Periksa kondisi tanaman secara langsung\.$/, (_, list) => `Lighter than the previous record: ${list}. Verify plant condition directly in the field.`],
    [/^(\d+) bermasalah$/, (_, n) => `${n} with issues`],
    [/^(\d+) sehat$/, (_, n) => `${n} healthy`],
    [/^(\d+) Kritis$/, (_, n) => `${n} Critical`],
    [/^(\d+) Waspada$/, (_, n) => `${n} Moderate`],
    [/^Luas: (.+)$/, (_, v) => `Area: ${v}`],
    [/^Kamera diganti ke (belakang|depan)$/, (_, side) => `Camera switched to ${side === 'belakang' ? 'rear' : 'front'}`],
    [/^Hari ini \((.+)\)$/, (_, d) => `Today (${translateDateTokens(d)})`],
    [/^• (\d+) foto dari (\d+) tanaman\.$/, (_, a, b) => `• ${a} ${Number(a) === 1 ? 'photo' : 'photos'} from ${b} ${Number(b) === 1 ? 'crop' : 'crops'}.`],
    [/^• (\d+) tanaman lain tercatat hari ini\.$/, (_, n) => `• ${n} other ${Number(n) === 1 ? 'crop' : 'crops'} recorded today.`],
    [/^• Periksa (.+?) terlebih dahulu\. Buka hasilnya untuk langkah pemeriksaan\.$/, (_, c) => `• Inspect ${translateCrop(c)} first. Open the result for check steps.`],
    [/^Hasil siap: (.+?)\. Lihat di Riwayat\.$/, (_, s) => `Result ready: ${s}. Open History to view.`],
    [/^Sedang menganalisis (.+)\.\.\.$/, (_, c) => `Analyzing ${translateCrop(c)}...`],
    [/^Posisi antrean: (\d+)\.(.*)$/, (_, p, rest) => `Queue position: ${p}.${rest ? ' Previous result stays saved.' : ''}`],
    [/^(\d+) meter dpl$/, (_, n) => `${n} meters asl`],
    [/^(\d+)% selesai$/, (_, n) => `${n}% complete`],
    [/^Koordinat (.+?): ([\d.,\s-]+)$/, (_, kind, coords) => `Coordinates (${kind === 'terakhir' ? 'last known' : kind}): ${coords}`],
    [/^Petak "(.+?)" tersimpan \((.+?)\)$/, (_, name, area) => `Plot "${name}" saved (${area})`],
    [/^Hapus petak (.+)$/, (_, name) => `Delete plot ${name}`],
    [/^Ubah petak (.+)$/, (_, name) => `Edit plot ${name}`],
    [/^Model yang dilaporkan penyedia: (.+)$/, (_, m) => `Provider-reported model: ${m}`],
    [/^(\d+) perangkat lain dikeluarkan$/, (_, n) => `${n} other ${Number(n) === 1 ? 'device' : 'devices'} signed out`],
    [/^(\d+) Petak Aktif · (\d+) Tanaman Terpantau$/, (_, f, p) => `${f} Active ${Number(f) === 1 ? 'Plot' : 'Plots'} · ${p} Tracked ${Number(p) === 1 ? 'Crop' : 'Crops'}`],
    [/^(\d+) sudut$/, (_, n) => `${n} ${Number(n) === 1 ? 'corner' : 'corners'}`],
    [/^(.+?) akan dihapus\. Catatan analisis di dalamnya tetap tersimpan\.$/, (_, name) => `${name} will be deleted. Analysis records inside it remain saved.`],
    [/^Foto lanjutan: (.+?)\. Hasil akan masuk ke riwayat tanaman ini\.$/, (_, crop) => `Follow-up photo: ${translateCrop(crop)}. Result will join this plant's history.`],
    [/^Foto yang sedang terbuka belum dikirim\. Buang foto itu dan memotret (.+)\?$/, (_, crop) => `The open photo has not been sent yet. Discard it and photograph ${translateCrop(crop)}?`],
    [/^Diekspor (\d+)$/, (_, n) => `Exported ${n}`],
    [/^Ditambahkan (\d+)$/, (_, n) => `Added ${n}`],
    [/^Ringkasan (.+)$/, (_, name) => `${name} Summary`],
    [/^Catatan Harian — (.+)$/, (_, d) => `Daily Log — ${translateDateTokens(d)}`],
    [/^Catatan (.+)$/, (_, d) => `Log · ${translateDateTokens(d)}`],
    [/^• (.+?): (Kritis|Waspada|Sehat|Belum dinilai)(?: — (.+))?\.$/, (_, c, sev, cond) => `• ${translateCrop(c)}: ${({ Kritis: 'Critical', Waspada: 'Moderate', Sehat: 'Healthy', 'Belum dinilai': 'Not assessed' })[sev] || sev}${cond ? ' — ' + translateCondition(cond) : ''}.`],
    [/^(\d+) sedang dianalisis$/, (_, n) => `${n} analyzing`],
    [/^Diambil (.+)$/, (_, d) => `Taken ${translateDateTokens(d)}`],
    [/^Diagnosis sekarang dibuat saat AI mengira tanaman ini (.+?)\. Analisis ulang memakai foto yang sama dengan jenis (.+?)\.$/, (_, a, b) => `Current diagnosis was generated assuming this crop is ${translateCrop(a)}. Re-analyzing uses the same photo as ${translateCrop(b)}.`],
    [/^Foto (.+?) \((.+?)\) akan dihapus dari riwayat\. Tidak bisa dibatalkan\.$/, (_, c, d) => `Photo of ${translateCrop(c)} (${translateDateTokens(d)}) will be removed from History. This cannot be undone.`],
  ];

  function translateString(str) {
    if (str == null) return str;
    const raw = String(str);
    if (currentLang !== 'en') return raw;
    if (EXACT_EN[raw] !== undefined) return EXACT_EN[raw];
    const trimmed = raw.trim();
    if (!trimmed) return raw;
    if (EXACT_EN[trimmed] !== undefined) {
      return raw.replace(trimmed, EXACT_EN[trimmed]);
    }
    const n = norm(raw);
    if (EXACT_EN[n] !== undefined) {
      const lead = raw.match(/^\s*/)[0];
      const trail = raw.match(/\s*$/)[0];
      return lead + EXACT_EN[n] + trail;
    }
    for (const [re, fn] of PATTERNS_EN) {
      const m = re.exec(trimmed);
      if (m) {
        const res = fn(...m);
        return raw.replace(trimmed, res);
      }
    }
    return raw;
  }

  function t(idText, vars) {
    let out = translateString(idText);
    if (vars && typeof vars === 'object') {
      out = out.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : ''));
    }
    return out;
  }

  /* ------------------------------------------------------------ Lossless DOM Walker */
  function syncToggleButtons(lang) {
    if (typeof document === 'undefined') return;
    document.querySelectorAll('[data-lang-choice]').forEach(btn => {
      const on = btn.getAttribute('data-lang-choice') === lang;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', String(on));
    });
  }

  function processTextNode(node, lang) {
    if (!node || !node.parentElement) return;
    const tag = node.parentElement.tagName;
    if (SKIP_TAGS.has(tag)) return;
    if (node.parentElement.closest && node.parentElement.closest('#tagline, .lang-switch, [data-no-i18n]')) return;
    let orig = origTextMap ? origTextMap.get(node) : undefined;
    if (orig === undefined) {
      orig = node.nodeValue || '';
      if (!orig.trim()) return;
      if (origTextMap) origTextMap.set(node, orig);
    }
    const nextVal = lang === 'en' ? translateString(orig) : orig;
    if (node.nodeValue !== nextVal) node.nodeValue = nextVal;
  }

  function processElementAttrs(el, lang) {
    if (!el || el.nodeType !== 1 || SKIP_TAGS.has(el.tagName)) return;
    if (el.closest && el.closest('.lang-switch, [data-no-i18n]')) return;
    let saved = origAttrMap ? origAttrMap.get(el) : undefined;
    if (!saved) {
      saved = {};
      for (const attr of ATTRS) {
        if (el.hasAttribute(attr)) saved[attr] = el.getAttribute(attr);
      }
      if (origAttrMap) origAttrMap.set(el, saved);
    }
    for (const [attr, orig] of Object.entries(saved)) {
      const nextVal = lang === 'en' ? translateString(orig) : orig;
      if (el.getAttribute(attr) !== nextVal) el.setAttribute(attr, nextVal);
    }
  }

  function applyDom(targetRoot) {
    if (typeof document === 'undefined') return;
    const rootNode = targetRoot || document;
    const lang = currentLang;
    if (rootNode === document && document.documentElement) {
      document.documentElement.lang = lang;
      if (document.title) {
        if (!document.documentElement.dataset.jkOrigTitle) {
          document.documentElement.dataset.jkOrigTitle = document.title;
        }
        document.title = lang === 'en'
          ? translateString(document.documentElement.dataset.jkOrigTitle)
          : document.documentElement.dataset.jkOrigTitle;
      }
    }
    syncToggleButtons(lang);
    const body = rootNode === document ? document.body : rootNode;
    if (!body) return;

    if (body.querySelectorAll) {
      body.querySelectorAll('[data-legal-lang]').forEach(sec => {
        sec.hidden = sec.getAttribute('data-legal-lang') !== lang;
      });
    }
    const taglineEl = body.id === 'tagline' ? body : (body.querySelector ? body.querySelector('#tagline') : null);
    if (taglineEl) {
      if (!taglineEl.dataset.jkIdHtml) taglineEl.dataset.jkIdHtml = taglineEl.innerHTML;
      const nextHtml = lang === 'en'
        ? '<span class="w">One</span> <span class="w">photo</span> <span class="w">today.</span><br><span class="w">Neat</span> <span class="w">farm</span> <span class="w">records</span> <span class="w">tomorrow.</span>'
        : taglineEl.dataset.jkIdHtml;
      if (taglineEl.innerHTML !== nextHtml) taglineEl.innerHTML = nextHtml;
      const visible = taglineEl.classList.contains('is-in')
        || !!(typeof window !== 'undefined' && window.getComputedStyle && parseFloat(window.getComputedStyle(taglineEl).opacity || '0') > 0.1);
      if (visible) {
        taglineEl.querySelectorAll('.w').forEach(w => { w.style.opacity = '1'; w.style.transform = 'none'; });
      }
    }
    if (typeof document.createTreeWalker !== 'function') return;

    const walker = document.createTreeWalker(body, 4 /* NodeFilter.SHOW_TEXT */);
    const textNodes = [];
    let n;
    while ((n = walker.nextNode())) textNodes.push(n);
    textNodes.forEach(node => processTextNode(node, lang));

    if (body.querySelectorAll) {
      processElementAttrs(body, lang);
      body.querySelectorAll('[placeholder], [aria-label], [title], [alt]').forEach(el => processElementAttrs(el, lang));
    }
  }

  function setLang(next) {
    const target = next === 'en' ? 'en' : 'id';
    const changed = target !== currentLang;
    currentLang = target;
    try {
      if (root.localStorage) root.localStorage.setItem(STORAGE_KEY, target);
    } catch (_) {}
    applyDom(typeof document !== 'undefined' ? document : null);
    if (changed && typeof root.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
      try {
        root.dispatchEvent(new CustomEvent('jk:langchange', { detail: { lang: target } }));
      } catch (_) {}
    }
    return target;
  }

  function wireDocument() {
    if (typeof document === 'undefined') return;
    document.addEventListener('click', event => {
      const btn = event.target && event.target.closest ? event.target.closest('[data-lang-choice]') : null;
      if (!btn) return;
      const choice = btn.getAttribute('data-lang-choice');
      if (choice === 'id' || choice === 'en') setLang(choice);
    });
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => applyDom(document));
    } else {
      applyDom(document);
    }
  }

  if (typeof window !== 'undefined' && root === window) {
    wireDocument();
  }

  root.setAppLang = setLang;

  return {
    STORAGE_KEY,
    getLang: () => currentLang,
    isEn: () => currentLang === 'en',
    setLang,
    t,
    crop: translateCrop,
    condition: translateCondition,
    severity: translateSeverity,
    dateTokens: translateDateTokens,
    applyDom,
    EXACT_EN,
  };
});
