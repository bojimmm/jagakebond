/* 0.2.4.19: Ringkasan petak reflects farmer-edited status and problem labels as well as AI labels. It remains
   an evaluation of one plot computed on the phone from the plot's own records -
   elevation band, the latest condition of every plant, which species carry which pests and diseases, and
   general management advice. No AI call, so it is instant, works offline and costs no quota. The dialog
   redraws itself whenever the records or plots change (hook "history-shown"), so an added photo, a
   re-analysis, a corrected species or date, a moved plant or a deleted record shows at once.
   General guidance only: no chemicals and no doses (no verified Indonesian catalogue is available). */
(function (root) {
  "use strict";
  const STALE_DAYS = 14,
    DAY = 86400000;
  const PEST =
    /^(hama|kutu|tungau|thrips|ulat|wereng|kepik|lalat|belalang|kumbang|nematoda|keong|tikus)/i;
  const NUTRIENT = /^(kekurangan|defisiensi)/i;
  const DISEASE =
    /^(mosaik|bulai|antrakn|bercak|sigatoka|blas|busuk|hawar|karat|layu|embun|jamur|virus|bakteri|kudis|keriting|kanker|gosong|tungro|kerdil|cacar|mati)/i;
  const tr = (s, v) =>
    root.JagaI18n && typeof root.JagaI18n.t === "function"
      ? root.JagaI18n.t(s, v)
      : s;
  const isEn = () =>
    !!(
      root.JagaI18n &&
      typeof root.JagaI18n.isEn === "function" &&
      root.JagaI18n.isEn()
    );
  const trCrop = (s) =>
    root.JagaI18n && typeof root.JagaI18n.crop === "function"
      ? root.JagaI18n.crop(s)
      : s;
  const trCond = (s) =>
    root.JagaI18n && typeof root.JagaI18n.condition === "function"
      ? root.JagaI18n.condition(s)
      : s;
  const KIND_LABEL_ID = {
    hama: "Hama",
    penyakit: "Penyakit",
    hara: "Hara",
    lain: "Lainnya",
  };
  const KIND_LABEL_EN = {
    hama: "Pest",
    penyakit: "Disease",
    hara: "Nutrient",
    lain: "Other",
  };
  const SEV_RANK = { Severe: 0, Moderate: 1, Unknown: 2, Healthy: 3 };
  const NOT_A_PROBLEM =
    /^(tanaman sehat|sehat|belum dapat dipastikan|belum pasti|belum diketahui|proses penuaan)$/i;
  let openFarmId = null,
    lastSig = "";
  const esc = (value) =>
    String(value == null ? "" : value).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const fmt = (n) => Math.round(n).toLocaleString(isEn() ? "en-US" : "id-ID");
  const kindOf = (label) =>
    PEST.test(label)
      ? "hama"
      : NUTRIENT.test(label)
        ? "hara"
        : DISEASE.test(label)
          ? "penyakit"
          : "lain";
  const speciesOf = (group) =>
    String(group.latest.crop || group.cropName || "Tanaman")
      .replace(/\s*\([^)]*\)\s*$/, "")
      .trim() || "Tanaman";
  const list = (items) =>
    items.length <= 2
      ? items.join(isEn() ? " and " : " dan ")
      : items.slice(0, -1).join(", ") +
        (isEn() ? ", and " : ", dan ") +
        items[items.length - 1];
  // Plants carry no names of their own, so lists count them per species: "2 tanaman Cabai dan 1 tanaman Kopi".
  const plants = (names) => {
    const n = new Map();
    for (const x of names) {
      const label = trCrop(x);
      n.set(label, (n.get(label) || 0) + 1);
    }
    return list(
      [...n].map(([name, k]) =>
        isEn() ? `${k} ${name} ${k === 1 ? "plant" : "plants"}` : `${k} tanaman ${name}`,
      ),
    );
  };
  function band(m) {
    if (m === null) return null;
    const label = tr(
      m < 400
        ? "Dataran Rendah"
        : m <= 700
          ? "Dataran Menengah"
          : "Dataran Tinggi",
    );
    return {
      id: m < 400 ? "rendah" : m <= 700 ? "menengah" : "tinggi",
      label,
      note: tr(
        "Perkiraan dari ketinggian foto yang tercatat. Kelembapan, suhu, dan penyebab gejala tidak dapat disimpulkan dari ketinggian saja.",
      ),
    };
  }
  function median(values) {
    if (!values.length) return null;
    const s = [...values].sort((a, b) => a - b),
      i = Math.floor(s.length / 2);
    return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
  }
  // app.js keeps these as top-level `let`s: shared by name across the classic scripts, not on window.
  const allRecords = () =>
    typeof farmRecords !== "undefined" && Array.isArray(farmRecords)
      ? farmRecords
      : [];
  const allFarms = () =>
    typeof farmList !== "undefined" && Array.isArray(farmList) ? farmList : [];
  function records(farmId) {
    return allRecords().filter((r) => r && r.farmId === farmId);
  }
  function hasReportedProblem(rec) {
    const observed = rec?.observedProblems;
    if (
      observed &&
      typeof observed === "object" &&
      !Array.isArray(observed) &&
      [observed.disease, observed.pest].some((v) => String(v || "").trim())
    )
      return true;
    const label = String(root.recordLabel?.(rec) || "").trim();
    return !!label && !NOT_A_PROBLEM.test(label);
  }
  // Share the effective farmer/AI status with every other view.
  function summarySeverity(rec) {
    return root.recSeverity(rec);
  }
  const severityLabel = (severity) =>
    tr(
      {
        Severe: "Kritis",
        Moderate: "Waspada",
        Healthy: "Sehat",
        Unknown: "Belum Pasti",
      }[severity] || "Belum Pasti",
    );
  const severityTone = (severity) =>
    ({ Severe: "severe", Moderate: "moderate", Healthy: "healthy" })[
      severity
    ] || "unknown";

  /* The model: everything the dialog and the plot-sheet teaser show, from the plot's records. */
  function build(farm, recs) {
    const groups = root.groupRecordsByCrop(recs),
      now = Date.now();
    const counts = { Severe: 0, Moderate: 0, Healthy: 0, Unknown: 0 },
      problems = new Map(),
      species = new Map(),
      severe = [],
      stale = [],
      worse = [],
      better = [],
      review = [];
    for (const g of groups) {
      const sev = summarySeverity(g.latest);
      counts[sev] += 1;
      const sp = speciesOf(g);
      if (!species.has(sp))
        species.set(sp, {
          name: sp,
          plants: 0,
          sick: 0,
          counts: { Severe: 0, Moderate: 0, Healthy: 0, Unknown: 0 },
          problems: new Map(),
          items: [],
        });
      const s = species.get(sp);
      s.plants += 1;
      s.counts[sev] += 1;
      const label = root.recordLabel(g.latest) || "Belum dapat dipastikan";
      let canReanalyze = false;
      try {
        canReanalyze = root.JagaAssessment?.canReanalyze?.(g.latest) === true;
      } catch (_) {}
      const rawName = String(g.latest.cropName || g.cropName || sp);
      const itemName =
        typeof root.canonicalCropName === "function"
          ? root.canonicalCropName(rawName)
          : rawName.replace(/\s*\([^)]*\)\s*$/, "").trim() || sp;
      s.items.push({
        id: String(g.latest.id || ""),
        name: itemName,
        severity: sev,
        label,
        canReanalyze,
        needsReview: g.latest.needs_review === true || sev === "Unknown",
      });
      if (sev === "Severe") severe.push(sp);
      if (g.latest.needs_review === true) review.push(sp);
      const ms = root.recordMs(g.latest);
      if (ms && now - ms > STALE_DAYS * DAY) stale.push(sp);
      const prev = g.records[1];
      if (
        prev &&
        !prev.needs_review &&
        !g.latest.needs_review &&
        prev.source === g.latest.source &&
        root.recordMs(prev) < root.recordMs(g.latest)
      ) {
        const a = SEV_RANK[summarySeverity(prev)],
          b = SEV_RANK[sev];
        if (a !== 2 && b !== 2) {
          if (b < a) worse.push(sp);
          else if (b > a) better.push(sp);
        }
      }
      if (sev === "Severe" || sev === "Moderate") {
        s.sick += 1;
        if (!problems.has(label))
          problems.set(label, {
            label,
            kind: kindOf(label),
            plants: 0,
            severe: 0,
            species: new Set(),
          });
        const p = problems.get(label);
        p.plants += 1;
        if (sev === "Severe") p.severe += 1;
        p.species.add(sp);
        s.problems.set(label, (s.problems.get(label) || 0) + 1);
      }
    }
    const heights = recs
      .map((r) => r.elevation)
      .filter((v) => v !== null && v !== undefined && v !== "")
      .map(Number)
      .filter((v) => Number.isFinite(v) && v > -500 && v < 6000);
    const elevation = median(heights);
    const b = band(elevation === null ? null : Math.round(elevation));
    const model = {
      farm,
      plants: groups.length,
      photos: recs.length,
      counts,
      species: [...species.values()].sort(
        (a, b) => b.sick - a.sick || b.plants - a.plants,
      ),
      problems: [...problems.values()].sort(
        (a, b) => b.plants - a.plants || b.severe - a.severe,
      ),
      severe,
      stale,
      worse,
      better,
      review,
      elevation,
      band: b,
      updated: Math.max(
        0,
        ...recs.map(
          (r) => Number(r.updatedMs || r.timestampMs || r.createdMs) || 0,
        ),
      ),
    };
    model.status = !groups.length
      ? { tone: "unknown", label: tr("Belum Ada Data") }
      : counts.Severe
        ? { tone: "severe", label: tr("Perlu Tindakan") }
        : counts.Moderate
          ? { tone: "moderate", label: tr("Perlu Dipantau") }
          : counts.Healthy === groups.length
            ? { tone: "healthy", label: tr("Baik") }
            : { tone: "unknown", label: tr("Belum Pasti") };
    model.findings = findings(model);
    model.advice = advice(model);
    return model;
  }

  // The one species clearly worse off than the rest of the plot (at least 2 plants, 60 % or more with a problem,
  // and 30 points above every other species), or null.
  function focusSpecies(m) {
    if (m.species.length < 2) return null;
    const rate = (s) => s.sick / s.plants,
      ranked = [...m.species].sort((a, b) => rate(b) - rate(a)),
      top = ranked[0];
    return top.plants >= 2 &&
      rate(top) >= 0.6 &&
      ranked.slice(1).every((s) => rate(s) <= rate(top) - 0.3)
      ? top
      : null;
  }
  /* Correlations between species, problems and the plot. */
  function findings(m) {
    const out = [],
      en = isEn();
    for (const p of m.problems) {
      if (p.plants < 2) continue;
      const condName = trCond(p.label),
        spNames = list([...p.species].map(trCrop));
      out.push(
        en
          ? `Suspected ${condName} recorded on ${p.plants} plants across ${p.species.size} ${p.species.size === 1 ? "type" : "types"} (${spNames}). Inspect other plants to check the spread; this log does not prove transmission.`
          : `Dugaan ${p.label} tercatat pada ${p.plants} tanaman dari ${p.species.size} jenis (${list([...p.species])}). Periksa tanaman lain untuk mengetahui luas gejalanya; catatan ini belum membuktikan penularan.`,
      );
    }
    const worst = focusSpecies(m);
    if (worst) {
      const wName = trCrop(worst.name);
      out.push(
        en
          ? `${worst.sick} of ${worst.plants} recorded ${wName} plants need attention. This count only includes documented plants.`
          : `${worst.sick} dari ${worst.plants} tanaman ${worst.name} yang tercatat memerlukan perhatian. Jumlah ini hanya mencakup tanaman yang didokumentasikan.`,
      );
    }
    if (m.review.length)
      out.push(
        en
          ? `Results needing direct inspection: ${plants(m.review)}.`
          : `Hasil yang memerlukan pemeriksaan langsung: ${plants(m.review)}.`,
      );
    if (m.worse.length)
      out.push(
        en
          ? `Observed status more severe than previous log: ${plants(m.worse)}. This is not proof of biological progression or treatment outcome.`
          : `Status pengamatan lebih berat dibanding catatan sebelumnya: ${plants(m.worse)}. Ini bukan bukti perubahan biologis atau hasil perawatan.`,
      );
    if (m.better.length)
      out.push(
        en
          ? `Observed status milder than previous log: ${plants(m.better)}. Check plant conditions directly.`
          : `Status pengamatan lebih ringan dibanding catatan sebelumnya: ${plants(m.better)}. Periksa kondisi tanaman secara langsung.`,
      );
    return out;
  }
  function advice(m) {
    const en = isEn();
    if (!m.plants)
      return [
        tr("Foto tanaman yang berada di dalam batas petak ini untuk mulai mengisi ringkasan."),
      ];
    const out = [];
    if (m.severe.length)
      out.push(
        en
          ? `Inspect Critical-status plants directly first: ${plants(m.severe)}. Open History and tap the crop name to view check steps.`
          : `Periksa langsung dahulu tanaman berstatus Kritis: ${plants(m.severe)}. Buka Riwayat dan ketuk nama tanaman untuk melihat langkah pemeriksaannya.`,
      );
    if (m.problems.length)
      out.push(
        tr(
          "Periksa bagian tanaman dengan dugaan serupa, termasuk tanaman lain yang belum difoto. Catat letak dan jumlah gejalanya; jangan menyimpulkan penularan dari jumlah foto.",
        ),
      );
    if (m.problems.some((p) => p.kind === "hara"))
      out.push(
        tr(
          "Minta pemeriksaan tanah atau daun bila dicurigai masalah hara. Foto dan ketinggian saja belum cukup untuk memilih pemupukan.",
        ),
      );
    if (m.review.length)
      out.push(
        en
          ? `Ask an extension officer to review uncertain results: ${plants(m.review)}.`
          : `Minta penilaian penyuluh untuk hasil yang belum pasti: ${plants(m.review)}.`,
      );
    if (m.stale.length)
      out.push(
        en
          ? `Not photographed for over ${STALE_DAYS} days: ${plants(m.stale)}. Re-photograph the same area to refresh logs.`
          : `Belum difoto lebih dari ${STALE_DAYS} hari: ${plants(m.stale)}. Foto kembali bagian yang sama untuk memperbarui catatan.`,
      );
    if (!out.length)
      out.push(
        tr(
          "Tidak ada gejala yang jelas pada foto-foto yang tercatat. Tetap periksa tanaman secara langsung; ringkasan ini bukan jaminan seluruh petak bebas masalah.",
        ),
      );
    return out;
  }

  const toneBadge = (t) =>
    "badge " +
    ({
      severe: "badge-severe",
      moderate: "badge-moderate",
      healthy: "badge-healthy",
    }[t] || "badge-unknown");
  function teaserHtml(farm) {
    const m = build(farm, records(farm.id)),
      c = m.counts,
      en = isEn();
    const parts = m.plants
      ? [
          en ? `${m.plants} ${m.plants === 1 ? "plant" : "plants"}` : m.plants + " tanaman",
          c.Severe ? c.Severe + " " + tr("Kritis") : null,
          c.Moderate ? c.Moderate + " " + tr("Waspada") : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : tr("Belum ada tanaman");
    return (
      '<span class="plot-teaser-main"><span class="plot-teaser-title">' +
      esc(tr("Ringkasan Petak")) +
      '</span><span class="plot-teaser-sub">' +
      esc(parts) +
      "</span></span>" +
      '<span class="' +
      toneBadge(m.status.tone) +
      '">' +
      esc(m.status.label) +
      '</span><i data-lucide="chevron-right" aria-hidden="true"></i>'
    );
  }

  function bodyHtml(m) {
    const c = m.counts,
      farm = m.farm,
      en = isEn(),
      KIND_LABEL = en ? KIND_LABEL_EN : KIND_LABEL_ID;
    const meta = [
      en ? `${m.plants} ${m.plants === 1 ? "plant" : "plants"}` : m.plants + " tanaman",
      en ? `${m.photos} ${m.photos === 1 ? "photo" : "photos"}` : m.photos + " foto",
      typeof root.formatArea === "function" && farm.areaM2
        ? root.formatArea(farm.areaM2)
        : null,
    ]
      .filter(Boolean)
      .join(" · ");
    const when =
      m.updated && typeof root.formatWhenId === "function"
        ? (en ? "Last updated " : "Data terakhir berubah ") + root.formatWhenId(m.updated)
        : "";
    // The same tiles as Beranda's plant summary (styles.css .stat-tile), here read-only.
    const stat = (key, label, cls) =>
      '<div class="stat-tile plot-stat ' +
      cls +
      '"><span class="stat-num">' +
      c[key] +
      '</span><span class="stat-label">' +
      esc(label) +
      "</span></div>";
    let html =
      '<section class="plot-status plot-tone-' +
      m.status.tone +
      '"><div class="plot-status-top"><span class="' +
      toneBadge(m.status.tone) +
      '">' +
      esc(m.status.label) +
      '</span><span class="t-meta">' +
      esc(meta) +
      "</span></div>" +
      (when
        ? '<p class="t-meta" id="plot-summary-updated">' + esc(when) + "</p>"
        : "") +
      "</section>";
    if (m.plants)
      html +=
        '<section class="plot-block"><h4 class="plot-h">' +
        esc(tr("Kondisi Tanaman")) +
        '</h4><div class="plot-stats">' +
        stat("Severe", tr("Kritis"), "stat-severe") +
        stat("Moderate", tr("Waspada"), "stat-moderate") +
        stat("Healthy", tr("Sehat"), "stat-healthy") +
        stat("Unknown", tr("Belum Pasti"), "") +
        "</div></section>";
    html +=
      '<section class="plot-block"><h4 class="plot-h">' +
      esc(tr("Ketinggian Petak")) +
      "</h4>" +
      (m.band
        ? '<p class="plot-p"><b>' +
          esc(m.band.label) +
          "</b>" +
          (en ? ", approx. " + fmt(m.elevation) + " m a.s.l." : ", sekitar " + fmt(m.elevation) + " m dpl.") +
          '</p><p class="plot-p">' +
          esc(m.band.note) +
          "</p>"
        : '<p class="plot-p t-muted">' +
          esc(tr("Ketinggian belum tercatat. Foto tanaman dengan GPS menyala agar ketinggian petak terbaca.")) +
          "</p>") +
      "</section>";
    if (m.species.length)
      html +=
        '<section class="plot-block"><h4 class="plot-h">' +
        esc(tr("Jenis Tanaman dan Masalahnya")) +
        "</h4>" +
        '<div class="plot-species-list">' +
        m.species
          .map((s) => {
            const spDisplay = trCrop(s.name);
            const renderIssueTag = (item) => {
              if (item.severity === "Healthy") {
                return '<span class="t-meta plot-plant-label">' + esc(tr("Kondisi sehat")) + "</span>";
              }
              const k = kindOf(item.label);
              const kindBadge =
                k !== "lain"
                  ? '<span class="plot-kind plot-kind-' +
                    k +
                    '">' +
                    KIND_LABEL[k] +
                    "</span>"
                  : "";
              return (
                '<div class="plot-issue-wrap">' +
                kindBadge +
                '<span class="t-meta plot-plant-label">' +
                esc(trCond(item.label)) +
                "</span></div>"
              );
            };
            const reanalyzeBtn = (item) => {
              const iName = trCrop(item.name);
              return item.canReanalyze && item.id && item.needsReview
                ? '<button type="button" class="btn btn-secondary btn-icon btn-sm plot-reanalyze" data-act="JagaAssessment.reanalyze" data-args="' +
                  esc(JSON.stringify([item.id, "$this"])) +
                  '" aria-label="' +
                  esc(en ? `Re-analyze photo of ${iName}` : `Analisis ulang foto ${iName}`) +
                  '" title="' +
                  esc(tr("Analisis ulang")) +
                  '"><i data-lucide="refresh-cw" aria-hidden="true"></i></button>'
                : "";
            };
            if (s.items.length === 1) {
              const single = s.items[0];
              return (
                '<div class="plot-species"><div class="plot-species-top"><div class="plot-species-title"><b>' +
                esc(spDisplay) +
                '</b><span class="t-meta">' +
                esc(en ? "1 plant" : "1 tanaman") +
                '</span></div><span class="' +
                toneBadge(severityTone(single.severity)) +
                '">' +
                esc(severityLabel(single.severity)) +
                '</span></div><div class="plot-species-single-foot">' +
                renderIssueTag(single) +
                reanalyzeBtn(single) +
                "</div></div>"
              );
            }
            const items = s.items
              .map((item) => {
                return (
                  '<div class="plot-plant-row"><div class="plot-plant-main"><b class="plot-plant-name">' +
                  esc(trCrop(item.name)) +
                  '</b><span class="' +
                  toneBadge(severityTone(item.severity)) +
                  '">' +
                  esc(severityLabel(item.severity)) +
                  "</span></div><div class=\"plot-plant-side\">" +
                  renderIssueTag(item) +
                  reanalyzeBtn(item) +
                  "</div></div>"
                );
              })
              .join("");
            return (
              '<div class="plot-species"><div class="plot-species-top"><div class="plot-species-title"><b>' +
              esc(spDisplay) +
              "</b></div>" +
              '<span class="t-meta">' +
              esc(
                en
                  ? `${s.plants} ${s.plants === 1 ? "plant" : "plants"}` + (s.sick ? ` · ${s.sick} affected` : " · all healthy")
                  : s.plants + " tanaman" + (s.sick ? " · " + s.sick + " bermasalah" : " · semua sehat"),
              ) +
              '</span></div><div class="plot-plant-list">' +
              items +
              "</div></div>"
            );
          })
          .join("") +
        "</div></section>";
    if (m.findings.length)
      html +=
        '<section class="plot-block"><h4 class="plot-h">' +
        esc(tr("Temuan")) +
        '</h4><ul class="plot-list">' +
        m.findings.map((t) => "<li>" + esc(t) + "</li>").join("") +
        "</ul></section>";
    html +=
      '<section class="plot-block"><h4 class="plot-h">' +
      esc(tr("Saran Pengelolaan")) +
      '</h4><ul class="plot-list plot-advice">' +
      m.advice.map((t) => "<li>" + esc(t) + "</li>").join("") +
      "</ul></section>";
    html +=
      '<p class="plot-caveat">' +
      esc(
        tr(
          "Dihitung dari foto terakhir setiap tanaman di petak ini dan diperbarui otomatis setiap ada perubahan. Ini panduan umum, bukan diagnosis pasti atau takaran obat. Untuk obat dan dosis, tanyakan penyuluh pertanian setempat.",
        ),
      ) +
      "</p>";
    return html;
  }

  function sig(farm) {
    return (
      (isEn() ? "en" : "id") +
      "|" +
      (root.recordsSig?.() || "") +
      "|" +
      farm.id +
      farm.name +
      farm.areaM2
    );
  }
  function render() {
    const farm = allFarms().find((f) => f.id === openFarmId),
      box = document.getElementById("plot-summary-body");
    if (!farm || !box) return false;
    const signature = sig(farm);
    if (signature === lastSig && box.childElementCount) return true;
    const scroller = box.closest(".modal-sheet"),
      top = scroller ? scroller.scrollTop : 0;
    lastSig = signature;
    document.getElementById("plot-summary-title").textContent =
      farm.name || tr("Petak");
    box.innerHTML = bodyHtml(build(farm, records(farm.id)));
    root.icons?.();
    document
      .getElementById("plot-summary-map")
      ?.classList.toggle(
        "hidden",
        typeof currentMenuName !== "undefined" && currentMenuName === "map",
      );
    if (scroller) scroller.scrollTop = top;
    return true;
  }
  function isOpen() {
    const d = document.getElementById("modal-plot-summary");
    return !!d && !d.classList.contains("hidden") && !!openFarmId;
  }
  function open(farmId) {
    if (!allFarms().some((f) => f.id === farmId)) return;
    openFarmId = farmId;
    lastSig = "";
    if (!render()) return;
    root.setDialogOpen("modal-plot-summary");
  }
  function close() {
    openFarmId = null;
    lastSig = "";
    root.closeDialog("modal-plot-summary");
  }
  function showOnMap() {
    const id = openFarmId;
    close();
    if (!id) return;
    root.navigateToMenu("map");
    setTimeout(() => root.focusFarm(id), 250);
  }
  // Live: the open summary follows every change to the plot's records or to the plot itself.
  function refresh() {
    if (!isOpen()) return;
    if (!allFarms().some((f) => f.id === openFarmId)) {
      close();
      return;
    }
    render();
  }
  root.JagaHooks?.on("history-shown", refresh);
  root.JagaHooks?.on("account-reset", () => {
    if (isOpen()) close();
    openFarmId = null;
  });
  root.addEventListener("jk:langchange", () => {
    lastSig = "";
    refresh();
  });
  root.JagaPlotSummary = {
    build,
    open,
    close,
    refresh,
    showOnMap,
    teaserHtml,
    isOpen,
    openFarmId: () => openFarmId,
  };
})(window);
