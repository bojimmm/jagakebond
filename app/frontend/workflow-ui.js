/* Shared account-scoped draft reconciliation and explicit photo-location editing. */
let workflowJobs = new Map();
let workflowRefresh = null;
let workflowOwnerGeneration = -1;
let workflowLocationTarget = null;
let workflowLocationMap = null;
let workflowLocationMarker = null;
let workflowLocationPlots = null;
let workflowLocationLocate = null;
let workflowDrafts = [];
const expandedDraftTrees = new Set();
const workflowPreviews = new Map();
const workflowTerminal = new Set(["done", "failed", "rejected", "cancelled"]);
const workflowGuard = (owner, generation) =>
  String(currentAccount?.id) === owner && accountGeneration === generation;
const trWorkflow = (text, vars) =>
  window.JagaI18n && typeof window.JagaI18n.t === "function"
    ? window.JagaI18n.t(text, vars)
    : vars
      ? String(text).replace(/\{(\w+)\}/g, (_, k) =>
          k in vars ? String(vars[k]) : "{" + k + "}",
        )
      : text;
const trWorkflowCrop = (name) =>
  window.JagaI18n && typeof window.JagaI18n.crop === "function"
    ? window.JagaI18n.crop(name)
    : name;

function locationMetadata(value) {
  const number = (v) =>
    v === null || v === undefined || v === "" ? null : Number(v);
  return {
    ...value,
    lat: number(value?.lat),
    lng: number(value?.lng),
    accuracy: number(value?.accuracy),
    locationSource: value?.locationSource || value?.source || "unknown",
  };
}

async function archiveReceiptPhoto(receipt, job) {
  const owner = String(currentAccount.id),
    generation = accountGeneration,
    photoId = "record_" + job.id;
  const existing = await JagaMedia.get({ accountId: owner, photoId });
  if (!workflowGuard(owner, generation) || existing.imageBase64) return;
  const found = await JagaMedia.draftGet({
    accountId: owner,
    clientRequestId: receipt.clientRequestId,
  });
  if (!workflowGuard(owner, generation)) return;
  if (!found.draft?.imageBase64)
    throw Error(
      trWorkflow(
        "Foto asli draf belum tersedia; hasil belum dihapus dari antrean.",
      ),
    );
  const original =
    (await JagaMedia.dataUrl(receipt.clientRequestId)) ||
    "data:image/jpeg;base64," + found.draft.imageBase64;
  const metadata = locationMetadata({ ...found.draft.fields, ...job.context });
  // Keep the private original; render the current stamp on viewing/export.
  if (!workflowGuard(owner, generation)) return;
  await JagaMedia.put({
    accountId: owner,
    photoId,
    imageBase64: original.split(",")[1],
    metadata: { ...metadata, stampState: "original" },
  });
}

// saveRecordToServer (app.js) does the server save; this adds the on-phone photo (0.2.4.16: no re-assignment).
async function saveRecord(record) {
  const owner = String(currentAccount?.id || ""),
    generation = accountGeneration;
  const clean = { ...record };
  if (clean.imageUrl?.startsWith("data:")) clean.imageUrl = null;
  const saved = await saveRecordToServer(clean);
  if (!saved || !workflowGuard(owner, generation)) return null;
  // Receipts are the durable source for resumed analyses. Foreground captures
  // also keep their rendered result locally, without uploading that full image.
  if (
    (fullCapturePhoto || capturePhotoSnapshot) &&
    activeJobId &&
    record.id === "record_" + activeJobId
  ) {
    await JagaMedia.put({
      accountId: owner,
      photoId: record.id,
      imageBase64: (fullCapturePhoto || capturePhotoSnapshot).split(",")[1],
      metadata: {
        ...stampMetadata(record, selectedPhotoMetadata || {}),
        stampState: "original",
      },
    });
  }
  await hydrateLocalRecordPhotos();
  return saved;
}
async function hydrateLocalRecordPhotos() {
  const owner = String(currentAccount?.id || ""),
    generation = accountGeneration;
  if (!owner) return;
  for (const rec of farmRecords.slice(0, 80)) {
    try {
      let image = workflowPreviews.get(rec.id);
      if (!image) {
        const original = await JagaMedia.dataUrl(rec.id);
        if (!workflowGuard(owner, generation)) return;
        if (original) {
          image = await JagaMedia.preview(original);
          workflowPreviews.set(rec.id, image);
          if (workflowPreviews.size > 80)
            workflowPreviews.delete(workflowPreviews.keys().next().value);
        }
      }
      if (!workflowGuard(owner, generation)) return;
      if (image) {
        rec.serverImageUrl = rec.serverImageUrl || rec.imageUrl;
        rec.imageUrl = image;
      }
    } catch (_) {
      if (!workflowGuard(owner, generation)) return;
    }
  }
  if (workflowGuard(owner, generation)) refreshAllHistoryViews();
}

async function refreshWorkflow() {
  const owner = String(currentAccount?.id || ""),
    generation = accountGeneration;
  if (!owner) return;
  if (workflowRefresh && workflowOwnerGeneration === generation)
    return workflowRefresh;
  workflowOwnerGeneration = generation;
  const operation = (async () => {
    try {
      const local = (await JagaNative.list({ accountId: owner })).drafts || [];
      if (!workflowGuard(owner, generation)) return;
      let jobs = null;
      try {
        jobs = await api("/api/queue/pending");
      } catch (_) {
        /* Offline: retain durable local status and last observed job state. */
      }
      if (!workflowGuard(owner, generation)) return;
      if (Array.isArray(jobs))
        workflowJobs = new Map(jobs.map((j) => [j.id, j]));
      for (const receipt of local.filter((d) => d.status === "submitted")) {
        if (!workflowGuard(owner, generation)) return;
        // The scan screen is already following this job (scan-flow.js trackSubmittedJob); do not save it twice.
        if (
          typeof foregroundJobId !== "undefined" &&
          foregroundJobId &&
          receipt.jobId === foregroundJobId
        )
          continue;
        let job = workflowJobs.get(receipt.jobId);
        if (!job)
          try {
            job = await api(
              "/api/analyze/" + encodeURIComponent(receipt.jobId),
            );
          } catch (_) {
            continue;
          }
        if (!workflowGuard(owner, generation) || !job) continue;
        workflowJobs.set(job.id, job);
        if (job.status === "done" && job.diagnosis) {
          try {
            await archiveReceiptPhoto(receipt, job);
            if (!workflowGuard(owner, generation)) return;
            const saved = await saveRecord(
              buildRecordFromJob(job, job.diagnosis, null),
            );
            if (!saved || !workflowGuard(owner, generation)) continue;
            await api("/api/analyze/" + encodeURIComponent(job.id) + "/ack", {
              method: "POST",
              body: {},
            });
            if (!workflowGuard(owner, generation)) return;
            await JagaNative.remove({
              accountId: owner,
              clientRequestId: receipt.clientRequestId,
            });
            workflowJobs.delete(job.id);
            receiptFailures.delete(receipt.clientRequestId);
            if (window.JagaShell) JagaShell.noteResult(saved);
          } catch (error) {
            if (workflowGuard(owner, generation))
              showToast(
                trWorkflow("Hasil tetap tersimpan di server:") +
                  " " +
                  userMessage(error),
              );
          }
        } else if (["failed", "rejected", "cancelled"].includes(job.status)) {
          receiptFailures.set(receipt.clientRequestId, {
            jobId: job.id,
            error: job.error || "Analisis tidak selesai.",
          });
          try {
            await JagaMedia.draftMark({
              accountId: owner,
              clientRequestId: receipt.clientRequestId,
              status: job.status,
              error: job.error || "Analisis tidak selesai.",
              jobId: job.id,
            });
          } catch (_) {
            /* Keep server receipt visible even if the local state write fails. */
          }
        }
      }
      // Terminal results created by another session remain visible until the user
      // deletes them. Successful orphan receipts become history before acknowledgement.
      const localJobIds = new Set(local.map((d) => d.jobId).filter(Boolean));
      let reapplied = 0;
      for (const job of jobs || []) {
        if (!workflowGuard(owner, generation)) return;
        // A re-analysis writes its result onto the original record on the server
        // (queue.complete_job) and has no local draft, so saving the job here as well is
        // what used to leave a second crop for the same photo in Riwayat. Acknowledge it
        // instead, then pull the updated record.
        if (
          job.context &&
          typeof job.context.reanalysisRecordId === "string" &&
          job.context.reanalysisRecordId
        ) {
          if (
            ["done", "failed", "rejected", "cancelled"].includes(job.status)
          ) {
            try {
              await api("/api/analyze/" + encodeURIComponent(job.id) + "/ack", {
                method: "POST",
                body: {},
              });
            } catch (_) {
              /* retried on the next refresh */
            }
            if (workflowGuard(owner, generation)) workflowJobs.delete(job.id);
          }
          if (job.status === "done") reapplied += 1;
          continue;
        }
        if (
          job.status === "done" &&
          job.diagnosis &&
          !localJobIds.has(job.id)
        ) {
          const saved = await saveRecord(
            buildRecordFromJob(job, job.diagnosis, null),
          );
          if (!saved || !workflowGuard(owner, generation)) continue;
          await api("/api/analyze/" + encodeURIComponent(job.id) + "/ack", {
            method: "POST",
            body: {},
          });
          if (workflowGuard(owner, generation)) {
            workflowJobs.delete(job.id);
            if (window.JagaShell) JagaShell.noteResult(saved);
          }
        }
      }
      if (reapplied && workflowGuard(owner, generation)) {
        await refreshAllData();
        if (workflowGuard(owner, generation))
          showToast(
            trWorkflow(
              "{n} hasil analisis ulang sudah diterapkan ke catatan aslinya.",
              { n: reapplied },
            ),
          );
      }
      if (workflowGuard(owner, generation)) {
        syncNotice = "";
        await updateOfflineDraftCount();
      }
    } catch (error) {
      if (workflowGuard(owner, generation)) {
        syncNotice =
          error && error.offline
            ? ""
            : trWorkflow("Status belum diperbarui:") + " " + userMessage(error);
        await updateOfflineDraftCount();
      }
    }
  })();
  workflowRefresh = operation;
  try {
    await operation;
  } finally {
    if (workflowRefresh === operation) workflowRefresh = null;
  }
}
resumeSubmittedDrafts = refreshWorkflow;
recoverPendingAnalyses = refreshWorkflow;

/* ---------------------------------------------------------------------------------------------------------
   Drafts strip in Riwayat (UX brief D1) and the header chip / Riwayat badge counts (G8, G9).
   One row per photo: thumbnail, tree name, ONE status chip, ONE primary action; rare actions in "⋯".
   --------------------------------------------------------------------------------------------------------- */
let draftsExpanded = false;
let quarantineNoticeShown = false;
const PERMANENT_UPLOAD_ERRORS = new Set([
  "http_413",
  "http_422",
  "http_400",
  "photo_too_large",
  "image_missing",
  "image_unreadable",
]);
const ACTIVE_JOB = new Set(["queued", "claimed"]);
function draftTime(draft, job) {
  const value =
    Number(draft?.fields?.photoTimestampMs) ||
    Number(draft?.createdMs) ||
    Number(job?.createdMs);
  return Number.isFinite(value) && value > 0 ? friendlyTime(value) : "";
}
function draftPlace(fields) {
  const name = String(fields?.locationName || "")
    .split(",")[0]
    .trim();
  if (name && !/^-?\d+(\.\d+)?,\s*-?\d/.test(name)) return name;
  const p = locationMetadata(fields || {});
  return JagaWorkflow.validPoint(p.lat, p.lng)
    ? fields?.locationSource === "plot"
      ? trWorkflow("Lokasi petak")
      : trWorkflow("Lokasi tersimpan")
    : trWorkflow("Lokasi belum terbaca");
}
function isPermanentUpload(draft) {
  return (
    PERMANENT_UPLOAD_ERRORS.has(String(draft?.errorCode || "")) ||
    PERMANENT_UPLOAD_ERRORS.has(String(draft?.error || "")) ||
    String(draft?.error || "").startsWith("invalid:")
  );
}
/* What one row shows: {kind, chip, tone, reason, primary:{label,attr,run,style}} */
function draftRowModel(draft, job) {
  const jobStatus = job?.status,
    status = draft?.status;
  const rawReason =
    job?.error ||
    (draft && draft.error && !/^[a-z_]+(:.*)?$/.test(draft.error)
      ? draft.error
      : "");
  const reason = rawReason ? trWorkflow(rawReason) : "";
  const analysisFailed =
    ["failed", "rejected", "cancelled"].includes(jobStatus) ||
    (!!draft?.jobId && ["failed", "rejected", "cancelled"].includes(status));
  if (analysisFailed) {
    const providerDown =
      job?.triage?.code === "provider_unavailable" ||
      /server analisis sedang bermasalah/i.test(rawReason);
    const refused = (jobStatus || status) === "rejected" && !providerDown;
    if (!draft)
      return {
        kind: "failed",
        chip: trWorkflow(refused ? "Foto ditolak" : "Gagal"),
        tone: "bad",
        reason,
        primary: {
          label: trWorkflow("Hapus"),
          attr: "data-discard-draft",
          style: "btn-danger",
          run: () => discardWorkflow(null, job),
        },
      };
    return {
      kind: "failed",
      chip: trWorkflow(refused ? "Foto ditolak — foto ulang" : "Gagal — coba lagi"),
      tone: "bad",
      reason,
      primary: refused
        ? {
            label: trWorkflow("Hapus"),
            attr: "data-discard-draft",
            style: "btn-danger",
            run: () => discardWorkflow(draft, job),
          }
        : {
            label: trWorkflow("Kirim ulang"),
            attr: "data-resend-draft",
            style: "btn-primary",
            run: () => resendDraft(draft, job),
          },
    };
  }
  if (status === "submitted" || (!draft && ACTIVE_JOB.has(jobStatus))) {
    const position = typeof job?.position === "number" ? job.position : null;
    const label = job?.stageLabel
      ? trWorkflow(job.stageLabel)
      : trWorkflow(
          jobStatus === "claimed" || position === 0
            ? "Sedang dianalisis"
            : jobStatus === "queued"
              ? "Menunggu giliran"
              : "Sedang dianalisis",
        );
    return {
      kind: "processing",
      chip: label,
      tone: "busy",
      reason: "",
      primary: null,
    };
  }
  if (status === "uploading")
    return {
      kind: "unsent",
      chip: trWorkflow("Sedang dikirim"),
      tone: "busy",
      reason: "",
      primary: null,
    };
  if (status === "editing")
    return {
      kind: "unsent",
      chip: trWorkflow("Siap dikirim"),
      tone: "wait",
      reason: "",
      primary: {
        label: trWorkflow("Kirim"),
        attr: "data-resume-draft",
        style: "btn-primary",
        run: () => resumeDraft(draft),
      },
    };
  if (
    ["failed", "conflict", "blocked", "rejected", "cancelled"].includes(status)
  ) {
    if (isPermanentUpload(draft))
      return {
        kind: "failed",
        chip: trWorkflow(draftSyncLabel(draft)),
        tone: "bad",
        reason,
        primary: {
          label: trWorkflow("Hapus"),
          attr: "data-discard-draft",
          style: "btn-danger",
          run: () => discardWorkflow(draft, job),
        },
      };
    return {
      kind: "failed",
      chip: trWorkflow(draftSyncLabel(draft)),
      tone: "bad",
      reason,
      primary: {
        label: trWorkflow("Coba lagi"),
        attr: "data-retry-draft",
        style: "btn-primary",
        run: () => retryDraft(draft),
      },
    };
  }
  return {
    kind: "unsent",
    chip: trWorkflow(draftSyncLabel(draft)),
    tone: "wait",
    reason: "",
    primary: {
      label: trWorkflow("Kirim"),
      attr: "data-send-draft",
      style: "btn-primary",
      run: () => sendDraftNow(draft),
    },
  };
}
function draftButton(label, icon, className, attr, id, handler) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn " + className;
  if (icon) {
    const i = document.createElement("i");
    i.setAttribute("data-lucide", icon);
    b.append(i);
  }
  const span = document.createElement("span");
  span.className = "btn-label";
  span.textContent = label;
  b.append(span);
  if (attr) b.setAttribute(attr, id);
  b.addEventListener("click", (event) => {
    event.stopPropagation();
    const menu = b.closest("details");
    if (menu) menu.open = false;
    Promise.resolve(handler()).catch((error) => showToast(userMessage(error)));
  });
  return b;
}
function renderDraftThumb(holder, draft, owner, generation) {
  holder.className = "thumb thumb-sm draft-thumb";
  if (!draft) return;
  const key = "draft:" + draft.clientRequestId;
  const show = (url) => {
    if (!workflowGuard(owner, generation) || !url) return;
    const img = document.createElement("img");
    img.alt = "";
    img.src = url;
    img.onerror = () => img.classList.add("is-broken");
    holder.replaceChildren(img);
  };
  const cached = workflowPreviews.get(key);
  if (cached) {
    show(cached);
    return;
  }
  JagaMedia.draftGet({
    accountId: owner,
    clientRequestId: draft.clientRequestId,
  })
    .then(async (value) => {
      if (!value.draft?.imageBase64 || !workflowGuard(owner, generation))
        return;
      const url = await JagaMedia.preview(
        "data:image/jpeg;base64," + value.draft.imageBase64,
        160,
        0.7,
      );
      if (!workflowGuard(owner, generation)) return;
      workflowPreviews.set(key, url);
      if (workflowPreviews.size > 80)
        workflowPreviews.delete(workflowPreviews.keys().next().value);
      show(url);
    })
    .catch(() => {});
}
function renderWorkflowRow(list, draft, job, owner, generation) {
  const model = draftRowModel(draft, job),
    id = draft?.clientRequestId || job?.id,
    fields = draft?.fields || job?.context || {};
  const row = document.createElement("article");
  row.className = "draft-row offline-draft-row";
  row.dataset.draftId = id;
  row.dataset.kind = model.kind;
  const thumb = document.createElement("span");
  renderDraftThumb(thumb, draft, owner, generation);
  // A photo still being analysed opens its progress (0.2.4.14); the copy block is that button, the thumb forwards to it.
  const jobId = job?.id || draft?.jobId,
    watchable =
      model.kind === "processing" && !!jobId && !!window.JagaAssessment?.watch;
  const copy = document.createElement(watchable ? "button" : "div");
  copy.className = "draft-row-copy";
  const title = document.createElement("strong");
  title.className = "draft-row-title";
  title.textContent = fields.cropName
    ? trWorkflowCrop(fields.cropName)
    : fields.cropHint
      ? trWorkflowCrop(fields.cropHint)
      : trWorkflow("Belum dipilih tanamannya");
  const meta = document.createElement("span");
  meta.className = "draft-row-meta";
  meta.textContent = [draftTime(draft, job), draftPlace(fields)]
    .filter(Boolean)
    .join(" · ");
  const chip = document.createElement("span");
  chip.className = "draft-chip";
  chip.dataset.tone = model.tone;
  chip.textContent = model.chip;
  const reason = document.createElement("span");
  reason.className = "draft-row-reason";
  reason.textContent = model.reason || "";
  copy.append(title, meta, chip, reason);
  if (watchable) {
    const crop = fields.cropName
      ? trWorkflowCrop(fields.cropName)
      : fields.cropHint
        ? trWorkflowCrop(fields.cropHint)
        : trWorkflow("Foto tanaman");
    copy.type = "button";
    copy.classList.add("draft-row-open");
    copy.setAttribute(
      "aria-label",
      trWorkflow("Lihat kemajuan analisis: ") + crop,
    );
    if (!model.reason) {
      reason.textContent = trWorkflow("Ketuk untuk melihat kemajuan");
      reason.classList.add("is-hint");
    }
    copy.addEventListener("click", () =>
      JagaAssessment.watch({
        jobId,
        crop,
        photo: draft
          ? workflowPreviews.get("draft:" + draft.clientRequestId)
          : null,
        trigger: copy,
      }),
    );
    thumb.addEventListener("click", () => copy.click());
    thumb.classList.add("is-tappable");
  }
  const actions = document.createElement("div");
  actions.className = "draft-row-actions";
  if (model.primary)
    actions.append(
      draftButton(
        model.primary.label,
        null,
        model.primary.style + " btn-sm",
        model.primary.attr,
        id,
        model.primary.run,
      ),
    );
  // Rare actions live in the overflow menu.
  const more = document.createElement("details");
  more.className = "draft-more";
  const summary = document.createElement("summary");
  summary.className = "btn btn-quiet btn-icon";
  summary.setAttribute("aria-label", trWorkflow("Pilihan lain"));
  summary.title = trWorkflow("Pilihan lain");
  const dots = document.createElement("i");
  dots.setAttribute("data-lucide", "more-horizontal");
  summary.append(dots);
  const menu = document.createElement("div");
  menu.className = "draft-more-menu";
  if (draft)
    menu.append(
      draftButton(
        trWorkflow("Lihat foto"),
        "image",
        "btn-quiet btn-sm",
        "data-view-draft",
        id,
        async () => {
          const image = await JagaMedia.draftGet({
            accountId: String(currentAccount.id),
            clientRequestId: draft.clientRequestId,
          });
          if (image.draft?.imageBase64)
            openPhotoViewer(
              "data:image/jpeg;base64," + image.draft.imageBase64,
              trWorkflow("Foto belum terkirim"),
              model.chip,
              "",
              null,
            );
          else showToast(trWorkflow("Foto tidak ditemukan di HP ini."));
        },
      ),
    );
  if (
    draft &&
    [
      "pending",
      "blocked",
      "failed",
      "rejected",
      "cancelled",
      "editing",
    ].includes(draft.status)
  )
    menu.append(
      draftButton(
        trWorkflow("Ubah lokasi"),
        "map-pin",
        "btn-quiet btn-sm",
        "data-edit-draft",
        id,
        () => openLocationEditor("draft", draft.clientRequestId),
      ),
    );
  if (draft)
    menu.append(
      draftButton(
        trWorkflow("Simpan ke galeri"),
        "download",
        "btn-quiet btn-sm",
        "data-export-draft",
        id,
        async () => {
          const owner = String(currentAccount.id);
          const existing = await JagaMedia.get({
            accountId: owner,
            photoId: draft.clientRequestId,
          });
          if (!existing.imageBase64) {
            const source = (
              await JagaMedia.draftGet({
                accountId: owner,
                clientRequestId: draft.clientRequestId,
              })
            ).draft;
            if (!source)
              throw Error(trWorkflow("Foto tidak ditemukan di HP ini."));
            await JagaMedia.put({
              accountId: owner,
              photoId: draft.clientRequestId,
              imageBase64: source.imageBase64,
              metadata: locationMetadata(source.fields),
            });
          }
          await exportPrivatePhoto(draft.clientRequestId);
        },
      ),
    );
  const primaryDiscards =
    model.primary && model.primary.attr === "data-discard-draft";
  if (!primaryDiscards && draft?.status !== "uploading" && (draft || job))
    menu.append(
      draftButton(
        trWorkflow(model.kind === "processing" ? "Batalkan" : "Hapus"),
        "trash-2",
        "btn-quiet btn-sm",
        "data-discard-draft",
        id,
        () => discardWorkflow(draft, job),
      ),
    );
  if (menu.children.length) {
    more.append(summary, menu);
    actions.append(more);
  }
  row.append(thumb, copy, actions);
  list.append(row);
}
/* "Kirim": this draft first, now, ignoring its backoff deadline. */
async function sendDraftNow(draft) {
  if (navigator.onLine === false) {
    showToast(
      trWorkflow("Belum ada sinyal. Foto dikirim otomatis saat ada sinyal."),
    );
    return;
  }
  if (JagaNative.isNative()) {
    await syncPendingDrafts();
    return;
  }
  await JagaOfflineSync.run({ manual: true, first: draft.clientRequestId });
  await updateOfflineDraftCount();
}
async function retryDraft(draft) {
  const owner = String(currentAccount?.id || "");
  if (!owner) return;
  if (JagaNative.isNative()) {
    await resendDraft(draft, null);
    return;
  }
  await JagaOfflineStore.draftRetry({
    accountId: owner,
    clientRequestId: draft.clientRequestId,
  });
  await sendDraftNow(draft);
}
async function resumeDraft(draft) {
  await JagaMedia.draftResume({
    accountId: String(currentAccount.id),
    clientRequestId: draft.clientRequestId,
  });
  await syncPendingDrafts();
}
/* A finished-and-failed job is bound to its request id: sending the photo again needs a fresh id (same photo, same
   fields). The private original follows the draft; the old job is acknowledged so it is not listed twice. */
async function resendDraft(draft, job) {
  const owner = String(currentAccount?.id || ""),
    generation = accountGeneration;
  if (!owner) return;
  const prior = (
    await JagaMedia.draftGet({
      accountId: owner,
      clientRequestId: draft.clientRequestId,
    })
  ).draft;
  if (!workflowGuard(owner, generation)) return;
  if (!prior || !prior.imageBase64)
    throw Error(
      trWorkflow("Foto tidak ditemukan di HP ini. Hapus lalu foto ulang."),
    );
  const newId = crypto.randomUUID();
  const original = await JagaMedia.get({
    accountId: owner,
    photoId: draft.clientRequestId,
  }).catch(() => ({}));
  if (original && original.imageBase64)
    await JagaMedia.tryPut({
      accountId: owner,
      photoId: newId,
      imageBase64: original.imageBase64,
      metadata: original.metadata || locationMetadata(prior.fields),
    });
  if (!workflowGuard(owner, generation)) return;
  await JagaMedia.draftEdit({
    accountId: owner,
    clientRequestId: draft.clientRequestId,
    newClientRequestId: newId,
    fields: prior.fields || {},
  });
  JagaMedia.deleteQuietly({ accountId: owner, photoId: draft.clientRequestId });
  const jobId = job?.id || prior.jobId;
  if (jobId) {
    api("/api/analyze/" + encodeURIComponent(jobId) + "/ack", {
      method: "POST",
      body: {},
    }).catch(() => undefined);
    workflowJobs.delete(jobId);
  }
  receiptFailures.delete(draft.clientRequestId);
  await JagaMedia.draftResume({ accountId: owner, clientRequestId: newId });
  if (!workflowGuard(owner, generation)) return;
  showToast(
    trWorkflow(
      navigator.onLine === false
        ? "Foto dikirim ulang saat ada sinyal."
        : "Foto dikirim ulang.",
    ),
  );
  if (!JagaNative.isNative() && navigator.onLine !== false)
    await JagaOfflineSync.run({ manual: true, first: newId });
  await updateOfflineDraftCount();
  if (window.JagaShell) JagaShell.kick();
}
function draftCounts(all) {
  const counts = { unsent: 0, processing: 0, failed: 0, active: 0 };
  let uploading = 0;
  const rows = [];
  const represented = new Set();
  for (const draft of all) {
    const job = workflowJobs.get(draft.jobId);
    if (job) represented.add(job.id);
    if (job?.status === "done") continue;
    rows.push({ draft, job });
  }
  for (const job of workflowJobs.values())
    if (!represented.has(job.id) && job.status !== "done")
      rows.push({ draft: null, job });
  for (const row of rows) {
    const model = draftRowModel(row.draft, row.job);
    row.model = model;
    counts[model.kind] += 1;
    if (row.draft?.status === "uploading") uploading += 1;
  }
  counts.active = rows.length;
  rows.sort((a, b) => {
    const rank = { failed: 0, unsent: 1, processing: 2 };
    return (
      rank[a.model.kind] - rank[b.model.kind] ||
      (Number(b.draft?.createdMs) || 0) - (Number(a.draft?.createdMs) || 0)
    );
  });
  return { counts, uploading, rows };
}
function draftSummaryText(counts) {
  // Short enough for the strip head at 360 px; the rows say exactly what is wrong with each photo.
  // A photo the server analysed and refused was sent: count it as failed, never as "belum terkirim".
  const parts = [];
  if (counts.failed) parts.push(trWorkflow("{n} gagal", { n: counts.failed }));
  if (counts.unsent)
    parts.push(trWorkflow("{n} belum terkirim", { n: counts.unsent }));
  if (parts.length) return parts.join(" · ");
  if (counts.processing)
    return trWorkflow("{n} sedang dianalisis", { n: counts.processing });
  return trWorkflow("Semua foto sudah terkirim");
}
function setDraftsExpanded(open) {
  draftsExpanded = !!open;
  const toggle = document.getElementById("drafts-toggle"),
    list = document.getElementById("offline-drafts-list");
  if (toggle) toggle.setAttribute("aria-expanded", String(draftsExpanded));
  if (list) list.hidden = !draftsExpanded;
}
window.JagaDraftsStrip = {
  expand() {
    setDraftsExpanded(true);
  },
  collapse() {
    setDraftsExpanded(false);
  },
  isExpanded: () => draftsExpanded,
};

async function updateOfflineDraftCount() {
  const owner = String(currentAccount?.id || ""),
    generation = accountGeneration;
  if (!owner) return;
  try {
    const listed = await JagaNative.list({ accountId: owner });
    const all = listed.drafts || [];
    if (!workflowGuard(owner, generation)) return;
    workflowDrafts = all;
    noteQuarantine(owner, listed);
    const { counts, uploading, rows } = draftCounts(all);
    const issueRow =
      rows.find((r) => r.model.kind === "failed") ||
      rows.find(
        (r) =>
          r.draft &&
          r.draft.status !== "submitted" &&
          (r.draft.error ||
            Number(r.draft.nextAttemptAtMs) > Date.now() ||
            r.draft.status === "uploading"),
      );
    const label =
      syncNotice ||
      (issueRow
        ? issueRow.draft
          ? trWorkflow(draftSyncLabel(issueRow.draft)) +
            (issueRow.model.reason ? " · " + issueRow.model.reason : "")
          : issueRow.model.chip +
            (issueRow.model.reason ? " · " + issueRow.model.reason : "")
        : draftSummaryText(counts));
    const status = document.getElementById("sync-status");
    if (status) status.textContent = label;
    const count = document.getElementById("sync-pending-count");
    if (count) count.textContent = String(counts.unsent);
    // Show or hide the Riwayat strip before the header chip renders: on phones the chip hides while the strip shows.
    const section = document.getElementById("offline-drafts");
    if (section) {
      section.hidden = rows.length === 0;
      section.dataset.tone = counts.failed
        ? "bad"
        : counts.unsent
          ? "wait"
          : "busy";
    }
    if (window.JagaShell) {
      JagaShell.setDraftState({ label, attention: false, counts, uploading });
      // A server too old for this app blocks every photo: that one problem is worth the attention strip.
      const outdated =
        (syncNotice && /Server perlu diperbarui/.test(syncNotice)) ||
        all.some((d) => d.error === "server_update_required");
      if (outdated)
        JagaShell.setAttention(
          "server",
          trWorkflow("Server perlu diperbarui. Foto tetap tersimpan di HP."),
          { tone: "warn", label: trWorkflow("Coba lagi") },
        );
      else JagaShell.clearAttention("server");
    }
    const summary = document.getElementById("drafts-summary");
    if (summary) summary.textContent = draftSummaryText(counts);
    const send = document.getElementById("drafts-send");
    if (send)
      send.classList.toggle(
        "hidden",
        !(
          counts.unsent ||
          rows.some((r) => r.model.primary?.attr === "data-retry-draft")
        ),
      );
    const list = document.getElementById("offline-drafts-list");
    if (!list) return;
    setDraftsExpanded(draftsExpanded && rows.length > 0);
    list.replaceChildren();
    for (const row of rows)
      renderWorkflowRow(list, row.draft, row.job, owner, generation);
    if (!rows.length) {
      const text = document.createElement("p");
      text.className = "drafts-empty";
      text.textContent = trWorkflow("Semua foto sudah terkirim.");
      list.append(text);
    }
    if (typeof icons === "function" && section && !section.hidden) icons();
  } catch (error) {
    if (workflowGuard(owner, generation)) {
      const status = document.getElementById("sync-status");
      if (status)
        status.textContent =
          trWorkflow("Daftar foto belum bisa dibuka:") +
          " " +
          userMessage(error);
    }
  }
}
/* Android 0.2.2.0 sets aside drafts it can no longer decrypt: tell the farmer once, then acknowledge. */
function noteQuarantine(owner, listed) {
  const n = Number(listed && listed.quarantined) || 0;
  if (!n || quarantineNoticeShown) return;
  quarantineNoticeShown = true;
  const text = trWorkflow(
    listed.quarantinedApprox
      ? "Beberapa foto lama tidak bisa dibuka lagi di HP ini dan disisihkan. Foto lain aman."
      : "{n} foto lama tidak bisa dibuka lagi di HP ini dan disisihkan. Foto lain aman.",
    { n },
  );
  if (window.JagaShell)
    JagaShell.setAttention("quarantine", text, { tone: "warn" });
  showToast(text);
  Promise.resolve(
    JagaNative.quarantineAck
      ? JagaNative.quarantineAck({ accountId: owner })
      : null,
  ).catch(() => undefined);
  setTimeout(() => {
    if (window.JagaShell) JagaShell.clearAttention("quarantine");
  }, 20000);
}
async function discardWorkflow(draft, job) {
  const owner = String(currentAccount?.id || ""),
    generation = accountGeneration;
  if (!owner) return;
  const id = job?.id || draft?.jobId;
  const running = !!id && !!job && ACTIVE_JOB.has(job.status);
  if (
    !(await confirmAction({
      title: trWorkflow(running ? "Batalkan analisis?" : "Hapus foto ini?"),
      message: trWorkflow(
        running
          ? "Foto ini tidak akan dianalisis. Kuota yang sudah terpakai tidak kembali."
          : "Foto yang belum terkirim akan dihapus dari HP ini.",
      ),
      okLabel: trWorkflow(running ? "Batalkan" : "Hapus"),
    }))
  )
    return;
  if (!workflowGuard(owner, generation)) return;
  if (id) {
    let current = job || (await api("/api/analyze/" + encodeURIComponent(id)));
    if (!workflowTerminal.has(current.status))
      current = await api(
        "/api/analyze/" + encodeURIComponent(id) + "/cancel",
        { method: "POST", body: {} },
      );
    if (!workflowGuard(owner, generation)) return;
    // A completion that wins the cancellation race must be recovered, not erased.
    if (current.status === "done") {
      await refreshWorkflow();
      showToast(
        trWorkflow("Analisis sudah selesai; hasilnya disimpan di Riwayat."),
      );
      return;
    }
    await api("/api/analyze/" + encodeURIComponent(id) + "/ack", {
      method: "POST",
      body: {},
    });
    if (!workflowGuard(owner, generation)) return;
    workflowJobs.delete(id);
  }
  if (draft)
    await JagaNative.remove({
      accountId: owner,
      clientRequestId: draft.clientRequestId,
    });
  if (workflowGuard(owner, generation)) {
    receiptFailures.delete(draft?.clientRequestId);
    syncNotice = "";
    await updateOfflineDraftCount();
  }
}

async function openLocationEditor(kind, id) {
  if (!currentAccount) return;
  const owner = String(currentAccount.id),
    generation = accountGeneration;
  let value =
    kind === "capture"
      ? selectedPhotoMetadata
      : kind === "record"
        ? farmRecords.find((r) => r.id === id)
        : workflowDrafts.find((d) => d.clientRequestId === id)?.fields;
  if (kind === "capture" && !selectedImageBase64) {
    showToast(trWorkflow("Ambil atau pilih foto terlebih dahulu."));
    return;
  }
  if (!value) value = {};
  workflowLocationTarget = { kind, id, owner, generation };
  const meta = locationMetadata(value);
  document.getElementById("location-lat").value = Number.isFinite(meta.lat)
    ? meta.lat
    : "";
  document.getElementById("location-lng").value = Number.isFinite(meta.lng)
    ? meta.lng
    : "";
  const select = document.getElementById("location-plot");
  select.replaceChildren(
    new Option(trWorkflow("Tanpa petak (titik / koordinat)"), ""),
  );
  for (const farm of farmList) select.add(new Option(farm.name, farm.id));
  select.value = value.farmId || "";
  document.getElementById("location-error").textContent = "";
  setDialogOpen("modal-location");
  try {
    await JagaFeatures.load("map");
  } catch (error) {
    if (workflowGuard(owner, generation))
      document.getElementById("location-error").textContent =
        userMessage(error);
    return;
  }
  if (
    !workflowGuard(owner, generation) ||
    workflowLocationTarget?.kind !== kind ||
    workflowLocationTarget?.id !== id
  )
    return;
  requestAnimationFrame(() => {
    if (
      !workflowGuard(owner, generation) ||
      !workflowLocationTarget ||
      document.getElementById("modal-location").classList.contains("hidden")
    )
      return;
    if (typeof L === "undefined") return;
    if (!workflowLocationMap) {
      workflowLocationMap = L.map("location-map", { maxZoom: MAP_MAX_ZOOM });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "© OpenStreetMap contributors",
        maxZoom: MAP_MAX_ZOOM,
        maxNativeZoom: 19,
      }).addTo(workflowLocationMap);
      workflowLocationMap.on("click", (event) =>
        setEditorPin(event.latlng.lat, event.latlng.lng),
      );
    }
    if (!workflowLocationLocate)
      workflowLocationLocate = addLocationLocateControl(workflowLocationMap);
    workflowLocationMap.invalidateSize();
    const fix = JagaWorkflow.validPoint(meta.lat, meta.lng)
      ? [meta.lat, meta.lng]
      : JagaWorkflow.validPoint(currentCoords.lat, currentCoords.lng)
        ? [currentCoords.lat, currentCoords.lng]
        : [-2.5, 118];
    workflowLocationMap.setView(
      fix,
      JagaWorkflow.validPoint(meta.lat, meta.lng) ? 16 : 5,
    );
    if (!workflowLocationPlots)
      workflowLocationPlots = L.featureGroup().addTo(workflowLocationMap);
    workflowLocationPlots.clearLayers();
    for (const farm of farmList) {
      if (
        !Array.isArray(farm.ring) ||
        farm.ring.length < 3 ||
        !farm.ring.every(
          (p) => Array.isArray(p) && JagaWorkflow.validPoint(p[0], p[1]),
        )
      )
        continue;
      const polygon = L.polygon(farm.ring, {
        ...farmBoundaryStyle(farm.id === select.value),
        farmId: farm.id,
        bubblingMouseEvents: false,
      }).addTo(workflowLocationPlots);
      const label = document.createElement("span");
      label.textContent = farm.name;
      polygon.bindTooltip(label);
      polygon.on("click", () => {
        if (!workflowGuard(owner, generation)) return;
        select.value = farm.id;
        select.dispatchEvent(new Event("change"));
      });
    }
    if (workflowLocationMarker) {
      workflowLocationMarker.remove();
      workflowLocationMarker = null;
    }
    if (JagaWorkflow.validPoint(meta.lat, meta.lng))
      setEditorMarker(meta.lat, meta.lng);
    const selected = farmList.find((f) => f.id === select.value);
    if (selected?.ring?.length >= 3) {
      const bounds = L.latLngBounds(selected.ring);
      if (JagaWorkflow.validPoint(meta.lat, meta.lng))
        bounds.extend([meta.lat, meta.lng]);
      workflowLocationMap.fitBounds(bounds, {
        padding: [24, 24],
        maxZoom: 21,
        animate: false,
      });
    } else if (
      !JagaWorkflow.validPoint(meta.lat, meta.lng) &&
      workflowLocationPlots.getLayers().length
    )
      workflowLocationMap.fitBounds(workflowLocationPlots.getBounds(), {
        padding: [24, 24],
        maxZoom: 21,
        animate: false,
      });
  });
}
function addLocationLocateControl(map) {
  // The same tool as the Peta tab's "Ke lokasi saya". A gallery photo often carries no GPS,
  // so the farmer needs one tap to bring the map to where the phone actually is before
  // tapping the spot where the plant stands.
  const Locate = L.Control.extend({
    options: { position: "topright" },
    onAdd() {
      const wrap = L.DomUtil.create("div", "leaflet-bar location-locate");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "location-locate-btn";
      button.title = trWorkflow("Ke lokasi saya");
      button.setAttribute("aria-label", trWorkflow("Ke lokasi saya"));
      button.innerHTML =
        '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="2" x2="5" y1="12" y2="12"></line><line x1="19" x2="22" y1="12" y2="12"></line><line x1="12" x2="12" y1="2" y2="5"></line><line x1="12" x2="12" y1="19" y2="22"></line><circle cx="12" cy="12" r="7"></circle><circle cx="12" cy="12" r="3"></circle></svg>';
      L.DomEvent.disableClickPropagation(wrap);
      L.DomEvent.disableScrollPropagation(wrap);
      button.addEventListener("click", (event) => {
        event.preventDefault();
        centerLocationMapOnMe(button);
      });
      wrap.append(button);
      return wrap;
    },
  });
  return new Locate().addTo(map);
}
function centerLocationMapOnMe(button) {
  if (!workflowLocationMap) return;
  const show = (lat, lng) =>
    workflowLocationMap.setView(
      [lat, lng],
      Math.max(workflowLocationMap.getZoom() || 0, 17),
      { animate: false },
    );
  if (JagaWorkflow.validPoint(currentCoords.lat, currentCoords.lng)) {
    show(currentCoords.lat, currentCoords.lng);
    return;
  }
  if (!navigator.geolocation) {
    showToast(trWorkflow("HP ini tidak punya GPS."));
    return;
  }
  if (button) button.disabled = true;
  navigator.geolocation.getCurrentPosition(
    (position) => {
      if (button) button.disabled = false;
      show(position.coords.latitude, position.coords.longitude);
    },
    () => {
      if (button) button.disabled = false;
      showToast(trWorkflow("Lokasi belum terbaca. Coba lagi di tempat terbuka."));
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
  );
}
function setEditorMarker(lat, lng) {
  if (!workflowLocationMap) return;
  if (workflowLocationMarker) workflowLocationMarker.setLatLng([lat, lng]);
  else {
    workflowLocationMarker = L.marker([lat, lng], { draggable: true }).addTo(
      workflowLocationMap,
    );
    workflowLocationMarker.on("dragend", () => {
      const p = workflowLocationMarker.getLatLng();
      setEditorPin(p.lat, p.lng);
    });
  }
}
function setEditorPin(lat, lng) {
  document.getElementById("location-lat").value = lat.toFixed(6);
  document.getElementById("location-lng").value = lng.toFixed(6);
  document.getElementById("location-plot").value = "";
  setEditorMarker(lat, lng);
}
async function saveLocationEditor() {
  const target = workflowLocationTarget;
  if (!target || !workflowGuard(target.owner, target.generation)) return;
  const button = document.getElementById("location-save");
  button.disabled = true;
  try {
    const parse = (id) => {
      const s = document.getElementById(id).value.trim();
      return s === "" ? NaN : Number(s);
    };
    let lat = parse("location-lat"),
      lng = parse("location-lng");
    let farmId = document.getElementById("location-plot").value;
    if (farmId) {
      const farm = farmList.find((f) => f.id === farmId);
      if (!farm) throw Error(trWorkflow("Petak tidak tersedia."));
      [lat, lng] = JagaWorkflow.plotPoint(farm.ring);
    }
    if (!JagaWorkflow.validPoint(lat, lng))
      throw Error(
        trWorkflow("Isi lintang −90…90 dan bujur −180…180, atau pilih petak."),
      );
    if (!farmId && typeof farmContainingPoint === "function") {
      farmId = farmContainingPoint(lat, lng) || "";
    }
    const farm = farmList.find((f) => f.id === farmId);
    const saveBtn = document.getElementById("location-save");
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = trWorkflow("Memperbarui lokasi…");
    }
    let telem = null;
    try {
      if (navigator.onLine !== false) {
        telem = await Promise.race([
          api("/api/telemetry?lat=" + encodeURIComponent(lat) + "&lng=" + encodeURIComponent(lng)),
          new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
        ]);
      }
    } catch (_) {
      telem = null;
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = trWorkflow("Simpan Lokasi");
      }
    }
    if (!workflowGuard(target.owner, target.generation)) return;
    const rawElev = Array.isArray(telem?.elevation) ? telem.elevation[0] : telem?.elevation;
    const elev = Number.isFinite(Number(rawElev)) ? Math.round(Number(rawElev)) : null;
    const placeName = typeof telem?.locationName === "string" && telem.locationName.trim() ? telem.locationName.trim() : null;
    const weather = typeof telem?.weather === "string" && telem.weather.trim() ? telem.weather.trim() : null;
    const locationLabel = farm && placeName
      ? farm.name + " · " + placeName
      : placeName ||
        (farm
          ? trWorkflow("Petak ") + farm.name
          : lat.toFixed(5) + ", " + lng.toFixed(5));
    const patch = {
      lat,
      lng,
      farmId: farmId || null,
      accuracy: null,
      elevation: elev,
      weather,
      locationName: locationLabel,
      locationSource: farmId ? "plot" : "manual",
    };
    if (target.kind === "capture") {
      if (!Number.isFinite(selectedPhotoTimestampMs)) {
        const now = new Date();
        selectedPhotoTimestampMs = now.getTime();
        selectedPhotoDateString = typeof formatPhotoDate === "function" ? formatPhotoDate(now, "waktu unggah perangkat") : null;
      }
      selectedPhotoMetadata = Object.freeze({
        ...selectedPhotoMetadata,
        ...patch,
        captureTimeMs: selectedPhotoTimestampMs,
        photoDate: selectedPhotoDateString,
      });
      activeOfflineCapture = null;
      document.getElementById("capture-location-summary").textContent =
        patch.locationName;
      if (typeof renderScanHead === "function") renderScanHead(scanState, {});
      if (typeof updateScanLocationChip === "function")
        updateScanLocationChip();
    } else if (target.kind === "draft") {
      const prior = (
        await JagaMedia.draftGet({
          accountId: target.owner,
          clientRequestId: target.id,
        })
      ).draft;
      if (!workflowGuard(target.owner, target.generation)) return;
      if (!prior) throw Error(trWorkflow("Draf tidak ditemukan."));
      const fields = Object.fromEntries(
        Object.entries({
          ...prior.fields,
          ...patch,
          lat: String(lat),
          lng: String(lng),
        }).map(([key, value]) => [key, value == null ? null : String(value)]),
      );
      const newId = crypto.randomUUID();
      const original = await JagaMedia.get({
        accountId: target.owner,
        photoId: target.id,
      });
      if (!workflowGuard(target.owner, target.generation)) return;
      await JagaMedia.put({
        accountId: target.owner,
        photoId: newId,
        imageBase64: original.imageBase64 || prior.imageBase64,
        metadata: { ...original.metadata, ...patch },
      });
      if (!workflowGuard(target.owner, target.generation)) return;
      await JagaMedia.draftEdit({
        accountId: target.owner,
        clientRequestId: target.id,
        newClientRequestId: newId,
        fields,
      });
      JagaMedia.deleteQuietly({ accountId: target.owner, photoId: target.id }); // the original moved to the new id
      if (prior.jobId && workflowGuard(target.owner, target.generation)) {
        await api("/api/analyze/" + encodeURIComponent(prior.jobId) + "/ack", {
          method: "POST",
          body: {},
        });
        if (workflowGuard(target.owner, target.generation))
          workflowJobs.delete(prior.jobId);
      }
      if (workflowGuard(target.owner, target.generation))
        await updateOfflineDraftCount();
    } else {
      const saved = await api("/api/records/" + encodeURIComponent(target.id), {
        method: "PUT",
        body: patch,
      });
      if (!workflowGuard(target.owner, target.generation)) return;
      const i = farmRecords.findIndex((r) => r.id === target.id);
      if (i >= 0) farmRecords[i] = { ...farmRecords[i], ...saved, ...patch };
      try {
        const photo = await JagaMedia.get({
          accountId: target.owner,
          photoId: target.id,
        });
        if (photo.imageBase64)
          await JagaMedia.put({
            accountId: target.owner,
            photoId: target.id,
            imageBase64: photo.imageBase64,
            metadata: { ...photo.metadata, ...patch },
          });
      } catch (error) {
        showToast(
          trWorkflow("Lokasi server tersimpan; salinan lokal belum diperbarui:") +
            " " +
            userMessage(error),
        );
      }
      refreshAllHistoryViews();
    }
    if (workflowGuard(target.owner, target.generation)) {
      closeDialog("modal-location");
      workflowLocationTarget = null;
      showToast(
        trWorkflow(
          farmId
            ? "Lokasi disimpan sebagai lokasi petak."
            : "Lokasi disimpan sebagai lokasi manual.",
        ),
      );
    }
  } catch (error) {
    document.getElementById("location-error").textContent = userMessage(error);
  } finally {
    button.disabled = false;
  }
}
const renderedPhotoCache = new Map();
function clearRenderedPhotoCache(photoId) {
  for (const [key, value] of renderedPhotoCache)
    if (!photoId || value.metadata?.id === photoId)
      renderedPhotoCache.delete(key);
  if (photoId && viewerRecordId === photoId) closePhotoViewer();
}
function stampMetadata(record, prior = {}) {
  const m = locationMetadata({ ...prior, ...record });
  m.photoTimestampMs =
    record.captureTimeKnown === false
      ? null
      : (record.photoTimestampMs ??
        record.timestampMs ??
        prior.photoTimestampMs ??
        prior.captureTimeMs);
  m.photoDate =
    record.captureTimeKnown === false ? null : prior.photoDate || record.date;
  if (record.captureTimeSource === "exif")
    m.photoDate = (m.photoDate || "") + " (EXIF)";
  if (record.captureTimeSource === "manual")
    m.photoDate = (m.photoDate || "") + " (manual)";
  m.addedTimeMs = record.uploadedMs ?? record.createdMs ?? prior.importedAtMs;
  const sources = [
    "gps",
    "camera-capture",
    "gallery-exif",
    "manual",
    "plot",
    "gallery-unknown",
    "unknown",
  ];
  m.locationSource = sources.includes(record.locationSource)
    ? record.locationSource
    : sources.includes(prior.locationSource)
      ? prior.locationSource
      : "unknown";
  if (
    ["unknown", "manual", "plot", "gallery-unknown"].includes(m.locationSource)
  )
    m.accuracy = null;
  return m;
}
async function renderRecordPhoto(record) {
  const owner = String(currentAccount?.id || ""),
    generation = accountGeneration;
  if (!owner) return null;
  const key =
    owner +
    "|" +
    JSON.stringify([
      record.id,
      record.updatedMs,
      record.crop,
      record.condition,
      record.severity,
      record.observedSeverity,
      record.lat,
      record.lng,
      record.photoTimestampMs,
      record.timestampMs,
      record.captureTimeKnown,
      record.captureTimeSource,
      record.serverImageUrl || record.imageUrl,
    ]);
  if (renderedPhotoCache.has(key)) return renderedPhotoCache.get(key);
  let local = {};
  try {
    local =
      (await JagaMedia.get({ accountId: owner, photoId: record.id })) || {};
  } catch (_) {}
  if (!workflowGuard(owner, generation)) return null;
  const metadata = stampMetadata(record, local.metadata || {});
  let source = null;
  if (local.imageBase64 && local.metadata?.stampState === "original")
    source = "data:image/jpeg;base64," + local.imageBase64;
  const server = record.serverImageUrl || record.imageUrl;
  if (!source && /^\/api\/photos\/[A-Za-z0-9_-]+$/.test(server || "")) {
    try {
      source = await JagaNative.resolveImageUrl(server);
    } catch (_) {}
  }
  let dataUrl = source
    ? await bakeStampIntoCanvas(source, metadata, record)
    : null;
  if (!workflowGuard(owner, generation)) return null;
  // A legacy burned-in stamp cannot be removed without its original. Never stamp over it twice.
  const stamped = !!dataUrl;
  if (!dataUrl && local.imageBase64)
    dataUrl = "data:image/jpeg;base64," + local.imageBase64;
  if (!dataUrl) return null;
  const result = { dataUrl, metadata, stamped };
  if (stamped) {
    renderedPhotoCache.set(key, result);
    if (renderedPhotoCache.size > 2)
      renderedPhotoCache.delete(renderedPhotoCache.keys().next().value);
  }
  return result;
}
async function exportPrivatePhoto(photoId) {
  const owner = String(currentAccount?.id || ""),
    generation = accountGeneration;
  try {
    const record = farmRecords.find((r) => r.id === photoId);
    let rendered;
    if (record) {
      rendered = await renderRecordPhoto(record);
      if (!rendered?.stamped)
        throw Error(
          trWorkflow(
            "Sambungkan internet untuk memperbarui cap dari foto asli.",
          ),
        );
    } else {
      const p = await JagaMedia.get({ accountId: owner, photoId });
      if (!workflowGuard(owner, generation)) return;
      if (!p.imageBase64) throw Error(trWorkflow("Foto asli tidak tersedia."));
      const metadata = { ...p.metadata, exportedAtMs: Date.now() };
      rendered = {
        dataUrl: await bakeStampIntoCanvas(
          "data:image/jpeg;base64," + p.imageBase64,
          metadata,
        ),
        metadata,
      };
    }
    if (!workflowGuard(owner, generation) || !rendered?.dataUrl) return;
    await JagaMedia.saveGallery({
      accountId: owner,
      photoId,
      imageBase64: rendered.dataUrl.split(",")[1],
      metadata: rendered.metadata,
    });
    if (workflowGuard(owner, generation))
      showToast(trWorkflow("Foto bercap JagaKebond disimpan ke galeri."));
  } catch (error) {
    if (workflowGuard(owner, generation)) showToast(userMessage(error));
  }
}

// Hook registrations (0.2.4.16): these used to re-assign the app.js functions of the same name.
JagaHooks.on("telemetry-shown", () => {
  if (typeof setAccuracyDot === "function")
    setAccuracyDot(currentCoords.accuracy);
});
JagaHooks.on("menu-shown", (menu) => {
  if (currentAccount) {
    updateOfflineDraftCount();
    if (menu === "log" && window.JagaShell) JagaShell.markSeen();
  }
});
JagaHooks.on("account-reset", () => {
  renderedPhotoCache.clear();
  fullCapturePhoto = null;
  workflowJobs.clear();
  workflowPreviews.clear();
  expandedDraftTrees.clear();
  workflowDrafts = [];
  workflowLocationTarget = null;
  workflowLocationPlots?.clearLayers();
  if (workflowLocationMarker) {
    workflowLocationMarker.remove();
    workflowLocationMarker = null;
  }
  workflowRefresh = null;
  workflowOwnerGeneration = -1;
});
JagaHooks.on("before-live-camera", () => {
  fullCapturePhoto = null;
});
JagaHooks.on("data-refreshed", () => hydrateLocalRecordPhotos());
async function downloadStampedPhoto() {
  const photoId = activeJobId ? "record_" + activeJobId : viewerRecordId;
  if (photoId) await exportPrivatePhoto(photoId);
  else showToast(trWorkflow("Buka foto dari Riwayat untuk ekspor."));
}

function applyWorkflowStaticCopy() {
  const modal = document.getElementById("modal-location");
  if (modal) {
    const h2 = modal.querySelector("header h2");
    if (h2) h2.textContent = trWorkflow("Atur Lokasi");
    const closeBtn = document.getElementById("location-close");
    if (closeBtn)
      closeBtn.setAttribute(
        "aria-label",
        trWorkflow("Tutup pengaturan lokasi"),
      );
    const intro = modal.querySelector("section > p:first-of-type");
    if (intro)
      intro.textContent = trWorkflow(
        "Geser pin ke lokasi foto atau pilih petak tempat tanaman berada.",
      );
    const mapEl = document.getElementById("location-map");
    if (mapEl)
      mapEl.setAttribute("aria-label", trWorkflow("Peta pilih lokasi"));
    const plotOpt = document.querySelector('#location-plot option[value=""]');
    if (plotOpt)
      plotOpt.textContent = trWorkflow("Tanpa petak (titik / koordinat)");
    const plotLabel = modal.querySelector("section > label");
    if (plotLabel && plotLabel.firstChild?.nodeType === 3)
      plotLabel.firstChild.nodeValue = trWorkflow("Petak");
    const manualSummary = modal.querySelector(".loc-manual summary");
    if (manualSummary)
      manualSummary.textContent = trWorkflow("Atur Koordinat Manual");
    const coordLabels = modal.querySelectorAll(
      ".workflow-coordinate-grid label",
    );
    if (coordLabels[0]?.firstChild?.nodeType === 3)
      coordLabels[0].firstChild.nodeValue = trWorkflow("Lintang (derajat)");
    if (coordLabels[1]?.firstChild?.nodeType === 3)
      coordLabels[1].firstChild.nodeValue = trWorkflow("Bujur (derajat)");
    const errEl = document.getElementById("location-error");
    const hintP = errEl?.nextElementSibling;
    if (hintP && hintP.tagName === "P")
      hintP.textContent = trWorkflow(
        "Memilih petak menaruh pin di tengah petak. Sesuaikan pin bila lokasi tanaman berbeda.",
      );
    const saveBtn = document.getElementById("location-save");
    if (saveBtn && !saveBtn.disabled)
      saveBtn.textContent = trWorkflow("Simpan Lokasi");
    dialogNames["modal-location"] = trWorkflow("Lokasi Foto atau Tanaman");
  }
  document.querySelectorAll(".location-locate-btn").forEach((btn) => {
    btn.title = trWorkflow("Ke lokasi saya");
    btn.setAttribute("aria-label", trWorkflow("Ke lokasi saya"));
  });
  const editLoc = document.getElementById("viewer-edit-location");
  if (editLoc) editLoc.textContent = trWorkflow("Ubah lokasi");
  const saveGal = document.getElementById("viewer-save-gallery");
  if (saveGal) saveGal.textContent = trWorkflow("Simpan ke galeri");
}

function installWorkflowUi() {
  // This component owns the location dialog markup and copy.
  // 0.2.2.0: the drafts strip (index.html #offline-drafts) and the scan screen's "Ubah lokasi" link are real markup now;
  // the header status chip (shell.js) replaces the old "Buka draf" banner button.
  const toggle = document.getElementById("drafts-toggle");
  if (toggle)
    toggle.addEventListener("click", () => setDraftsExpanded(!draftsExpanded));
  document.addEventListener("click", (event) => {
    document.querySelectorAll(".draft-more[open]").forEach((menu) => {
      if (!menu.contains(event.target)) menu.open = false;
    });
  });
  const modal = document.createElement("div");
  modal.id = "modal-location";
  modal.className = "hidden workflow-modal";
  modal.innerHTML =
    '<section class="workflow-dialog" role="document"><header><h2>Atur Lokasi</h2><button type="button" id="location-close" class="btn btn-secondary btn-sm" aria-label="Tutup pengaturan lokasi"><i data-lucide="x" aria-hidden="true"></i></button></header><p>Geser pin ke lokasi foto atau pilih petak tempat tanaman berada.</p><div id="location-map" aria-label="Peta pilih lokasi"></div><label>Petak<select id="location-plot"></select></label><details class="fold loc-manual"><summary class="btn btn-secondary btn-block">Atur Koordinat Manual</summary><div class="workflow-coordinate-grid"><label>Lintang (derajat)<input id="location-lat" type="number" step="any" min="-90" max="90" inputmode="decimal"></label><label>Bujur (derajat)<input id="location-lng" type="number" step="any" min="-180" max="180" inputmode="decimal"></label></div></details><p id="location-error" role="alert"></p><p>Memilih petak menaruh pin di tengah petak. Sesuaikan pin bila lokasi tanaman berbeda.</p><button type="button" id="location-save" class="btn btn-primary btn-block">Simpan Lokasi</button></section>';
  document.body.append(modal);
  dialogNames["modal-location"] = trWorkflow("Lokasi Foto atau Tanaman");
  document.getElementById("location-close").onclick = () =>
    closeDialog("modal-location");
  document.getElementById("location-save").onclick = saveLocationEditor;
  document.getElementById("location-plot").onchange = () => {
    const farm = farmList.find(
      (f) => f.id === document.getElementById("location-plot").value,
    );
    if (!farm) return;
    try {
      const [lat, lng] = JagaWorkflow.plotPoint(farm.ring);
      document.getElementById("location-lat").value = lat.toFixed(6);
      document.getElementById("location-lng").value = lng.toFixed(6);
      setEditorMarker(lat, lng);
      workflowLocationPlots?.eachLayer((layer) =>
        layer.setStyle(farmBoundaryStyle(layer.options.farmId === farm.id)),
      );
      workflowLocationMap?.fitBounds(L.latLngBounds(farm.ring), {
        padding: [24, 24],
        maxZoom: 21,
        animate: false,
      });
    } catch (error) {
      document.getElementById("location-error").textContent =
        userMessage(error);
    }
  };
  for (const id of ["location-lat", "location-lng"])
    document.getElementById(id).addEventListener("input", () => {
      document.getElementById("location-plot").value = "";
    });
  const viewer = document.getElementById("photo-viewer-caption");
  const actions = document.createElement("div");
  actions.className = "btn-row viewer-actions";
  actions.innerHTML =
    '<button type="button" id="viewer-edit-location" class="btn btn-light">Ubah lokasi</button><button type="button" id="viewer-save-gallery" class="btn btn-light">Simpan ke galeri</button>';
  viewer.after(actions);
  document.getElementById("viewer-edit-location").onclick = () => {
    if (viewerRecordId) openLocationEditor("record", viewerRecordId);
    else showToast(trWorkflow("Ubah lokasi foto ini dari Riwayat."));
  };
  document.getElementById("viewer-save-gallery").onclick = () => {
    if (viewerRecordId) exportPrivatePhoto(viewerRecordId);
    else showToast(trWorkflow("Foto bisa disimpan setelah masuk Riwayat."));
  };
  applyWorkflowStaticCopy();
  window.addEventListener("jk:langchange", () => {
    applyWorkflowStaticCopy();
    if (typeof currentAccount !== "undefined" && currentAccount)
      updateOfflineDraftCount();
  });

  window.addEventListener("focus", () => {
    if (currentAccount) {
      refreshWorkflow();
      renderDailyRecommendations();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && currentAccount) renderDailyRecommendations();
  });
}
installWorkflowUi();
