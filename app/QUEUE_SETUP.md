# QUEUE_SETUP — antrean AI, worker, dan n8n

Antrean bersifat global (tanpa autentikasi). Ponsel hanya mengunggah sekali dan
melakukan polling; server tidak pernah menahan permintaan selama proses AI.

## 1. Mesin status

```
queued ──(/api/queue/next)──> claimed ──> done       (triase usable)
                                    └──> rejected    (triase usable=false)
```

- `claimed` yang lebih tua dari `QUEUE_STALE_CLAIM_SEC` (default 300 s) otomatis
  dikembalikan ke `queued` pada pemanggilan claim berikutnya — ini yang membuat
  worker yang mati tidak menyandera pekerjaan.
- `attempts` naik setiap kali claim. `QUEUE_MAX_ATTEMPTS` (default 3) ditegakkan
  oleh **worker**, bukan server.
- `acked=true` di-set ponsel setelah petani melihat hasilnya. Selama belum
  di-`ack`, hasil akan muncul lagi lewat `GET /api/queue/pending?deviceId=` saat
  aplikasi dibuka ulang.

## 2. Variabel lingkungan

| Variabel | Default | Keterangan |
|---|---|---|
| `NINEROUTER_URL` | `http://localhost:20128` | router OpenAI-compatible |
| `NINEROUTER_KEY` | — | **wajib**; worker menolak jalan tanpa ini |
| `GEMINI_TRIAGE_MODEL` | `gemini/gemma-4-26b-a4b-it` | triase, `max_tokens=600` |
| `GEMINI_DIAGNOSE_MODEL` | `gemini/gemma-4-31b-it` | diagnosis, `max_tokens=2500` |
| `QUEUE_PACER_SECONDS` | 25 | jeda saat antrean kosong |
| `QUEUE_STALE_CLAIM_SEC` | 300 | batas claim basi |
| `QUEUE_MAX_ATTEMPTS` | 3 | batas percobaan ulang (worker) |
| `QUEUE_BACKOFF_BASE` | 30 | awal backoff pada 429/503 |
| `API_BASE_URL` | `http://127.0.0.1:8000` | alamat backend untuk worker |
| `N8N_ANALYZE_WEBHOOK` | — | opsional, fan-out best-effort |

## 3. Menjalankan worker

```bash
python worker/gemini_worker.py
```

Worker hanya memakai pustaka standar (`urllib`), jadi bisa dijalankan di mesin
mana pun yang punya Python tanpa `pip install`.

Alur: claim → triase (600 token) → bila `usable` lanjut diagnosis (2500 token) →
`POST /result` → pacer.

Penanganan kegagalan:

| Kejadian | Perilaku |
|---|---|
| `429` / `503` | backoff berlipat dari 30 s (maks 600 s); pekerjaan dibiarkan ke requeue claim basi |
| `401` | worker berhenti dengan pesan memperbaiki `NINEROUTER_KEY` |
| jawaban kosong | satu percobaan ulang dengan +600 token, lalu pekerjaan gagal |
| galat lain | dicatat, jeda pacer, pekerjaan di-requeue server lewat claim basi |
| triase `usable=false` | **model diagnosis tidak dipanggil sama sekali** (nol token diagnosis) |

## 4. Ekonomi token

- triase ≈ 2,5 rb token/pekerjaan, diagnosis ≈ 3,3 rb token/pekerjaan (≈ 6 rb total).
- Pada 16 rb TPM: ≈ 2,4 pekerjaan/menit. Pada 14,4 rb RPD: ≈ 2.400 foto/hari.
- Ledakan 20 foto selesai ≈ 8 menit dengan pacer 25 s.

## 5. n8n (opsional)

Belum dibuat — sesuai urutan build, n8n dikerjakan terakhir dan hanya bila
diminta. Bila nanti dibutuhkan, workflow 9-node-nya adalah:

Webhook → ACK → HTTP triase (Gemma 26B) → Code parse triase → IF usable? →
HTTP diagnosis (Gemma 31B, `max_tokens` 2500) → Code gate keyakinan →
HTTP post-result / HTTP post-rejection.

Catatan: autentikasi Header `Authorization: Bearer <key>` pada kedua node router,
concurrency 1, dan `max_tokens` node diagnosis **2500**. Backend sudah mendorong
setiap pekerjaan baru ke `N8N_ANALYZE_WEBHOOK` (best-effort), tetapi jalur andal
tetap loop `queue/next` milik worker.

## 6. Memeriksa antrean

```bash
curl -s localhost:8000/api/queue | python -m json.tool          # depth, byStatus, recent
curl -s localhost:8000/api/queue/next?worker=manual | python -m json.tool
curl -s "localhost:8000/api/queue/pending?deviceId=demo" | python -m json.tool
```
