# n8n — belum dibuat (sesuai urutan build)

`PRD.md` bagian 11 mencantumkan workflow 9-node `jagakebond-analyze.json`, dan
`BUILD-INSTRUCTIONS.md` bagian 9 menempatkannya **terakhir dan opsional**
("n8n only if asked"). Karena itu langkah ini sengaja belum dikerjakan; tidak ada
berkas workflow di sini supaya tidak ada konfigurasi setengah jadi yang
menyesatkan.

Yang sudah ada di backend dan siap dipakai n8n:

- `N8N_ANALYZE_WEBHOOK` — bila diisi, setiap pekerjaan baru didorong ke webhook
  secara *fire-and-forget* (`backend/app.py`: `_maybe_trigger_n8n`). Kegagalan
  webhook tidak pernah menggagalkan permintaan unggah.
- `GET /api/queue/next?worker=n8n` — pengambilan pekerjaan dengan requeue claim basi.
- `POST /api/analyze/{id}/result` — gate keyakinan diterapkan ulang di sini,
  jadi jalur n8n tidak bisa melewati gate.

Bila nanti diminta, urutan node-nya:

```
Webhook → Respond to Webhook (ACK) → HTTP Router triase (gemma-4-26b-a4b-it, 600)
        → Code parse triase → IF usable?
             ├─ true  → HTTP Router diagnosis (gemma-4-31b-it, 2500)
             │          → Code gate keyakinan → HTTP post-result
             └─ false → HTTP post-rejection
```

Penyiapan yang wajib diingat:

- Header Auth `Authorization: Bearer <NINEROUTER_KEY>` pada **kedua** node HTTP router.
- Node diagnosis: `max_tokens` **2500** (di bawah ~800 jawaban kosong).
- Concurrency **1** (antrean global, tanpa autentikasi).
- Perbaiki URL backend di node post-result/post-rejection agar menunjuk host n8n.
- Loop `queue/next` milik worker tetap jalur yang andal; webhook hanya pelengkap.
