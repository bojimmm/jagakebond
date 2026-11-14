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
  const KIND_LABEL = {
    hama: "Hama",
    penyakit: "Penyakit",
    hara: "Hara",
    lain: "Lainnya",
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
  const fmt = (n) => Math.round(n).toLocaleString("id-ID");
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
      ? items.join(" dan ")
      : items.slice(0, -1).join(", ") + ", dan " + items[items.length - 1];
  // Plants carry no names of their own, so lists count them per species: "2 tanaman Cabai dan 1 tanaman Kopi".
  const plants = (names) => {
    const n = new Map();
    for (const x of names) n.set(x, (n.get(x) || 0) + 1);
    return list([...n].map(([name, k]) => k + " tanaman " + name));
  };
  function band(m) {
    if (m === null) return null;
    const label =
      m < 400
        ? "Dataran Rendah"
        : m <= 700
          ? "Dataran Menengah"
          : "Dataran Tinggi";
    return {
      id: m < 400 ? "rendah" : m <= 700 ? "menengah" : "tinggi",
      label,
      note: "Perkiraan dari ketinggian foto yang tercatat. Kelembapan, suhu, dan penyebab gejala tidak dapat disimpulkan dari ketinggian saja.",
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
    ({
      Severe: "Kritis",
      Moderate: "Waspada",
      Healthy: "Sehat",
      Unknown: "Belum Pasti",
    })[severity] || "Belum Pasti";
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
      s.items.push({
        id: String(g.latest.id || ""),
        name: String(g.latest.cropName || g.cropName || sp),
        severity: sev,
        label,
        canReanalyze,
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
      ? { tone: "unknown", label: "Belum ada data" }
      : counts.Severe
        ? { tone: "severe", label: "Perlu tindakan" }
        : counts.Moderate
          ? { tone: "moderate", label: "Perlu dipantau" }
          : counts.Healthy === groups.length
            ? { tone: "healthy", label: "Baik" }
            : { tone: "unknown", label: "Belum pasti" };
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
    const out = [];
    for (const p of m.problems) {
      if (p.plants < 2) continue;
      out.push(
        `Dugaan ${p.label} tercatat pada ${p.plants} tanaman dari ${p.species.size} jenis (${list([...p.species])}). Periksa tanaman lain untuk mengetahui luas gejalanya; catatan ini belum membuktikan penularan.`,
      );
    }
    const worst = focusSpecies(m);
    if (worst)
      out.push(
        `${worst.sick} dari ${worst.plants} tanaman ${worst.name} yang tercatat memerlukan perhatian. Jumlah ini hanya mencakup tanaman yang didokumentasikan.`,
      );
    if (m.review.length)
      out.push(
        `Hasil yang memerlukan pemeriksaan langsung: ${plants(m.review)}.`,
      );
    if (m.worse.length)
      out.push(
        `Status pengamatan lebih berat dibanding catatan sebelumnya: ${plants(m.worse)}. Ini bukan bukti perubahan biologis atau hasil perawatan.`,
      );
    if (m.better.length)
      out.push(
        `Status pengamatan lebih ringan dibanding catatan sebelumnya: ${plants(m.better)}. Periksa kondisi tanaman secara langsung.`,
      );
    return out;
  }
  function advice(m) {
    if (!m.plants)
      return [
        "Foto tanaman yang berada di dalam batas petak ini untuk mulai mengisi ringkasan.",
      ];
    const out = [];
    if (m.severe.length)
      out.push(
        `Periksa langsung dahulu tanaman berstatus Kritis: ${plants(m.severe)}. Buka Riwayat dan ketuk nama tanaman untuk melihat langkah pemeriksaannya.`,
      );
    if (m.problems.length)
      out.push(
        "Periksa bagian tanaman dengan dugaan serupa, termasuk tanaman lain yang belum difoto. Catat letak dan jumlah gejalanya; jangan menyimpulkan penularan dari jumlah foto.",
      );
    if (m.problems.some((p) => p.kind === "hara"))
      out.push(
        "Minta pemeriksaan tanah atau daun bila dicurigai masalah hara. Foto dan ketinggian saja belum cukup untuk memilih pemupukan.",
      );
    if (m.review.length)
      out.push(
        `Minta penilaian penyuluh untuk hasil yang belum pasti: ${plants(m.review)}.`,
      );
    if (m.stale.length)
      out.push(
        `Belum difoto lebih dari ${STALE_DAYS} hari: ${plants(m.stale)}. Foto kembali bagian yang sama untuk memperbarui catatan.`,
      );
    if (!out.length)
      out.push(
        "Tidak ada gejala yang jelas pada foto-foto yang tercatat. Tetap periksa tanaman secara langsung; ringkasan ini bukan jaminan seluruh petak bebas masalah.",
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
      c = m.counts;
    const parts = m.plants
      ? [
          m.plants + " tanaman",
          c.Severe ? c.Severe + " Kritis" : null,
          c.Moderate ? c.Moderate + " Waspada" : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : "Belum ada tanaman";
    return (
      '<span class="plot-teaser-main"><span class="plot-teaser-title">Ringkasan petak</span><span class="plot-teaser-sub">' +
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
      farm = m.farm;
    const meta = [
      m.plants + " tanaman",
      m.photos + " foto",
      typeof root.formatArea === "function" && farm.areaM2
        ? root.formatArea(farm.areaM2)
        : null,
    ]
      .filter(Boolean)
      .join(" · ");
    const when =
      m.updated && typeof root.formatWhenId === "function"
        ? "Data terakhir berubah " + root.formatWhenId(m.updated)
        : "";
    // The same tiles as Beranda's plant summary (styles.css .stat-tile), here read-only.
    const stat = (key, label, cls) =>
      '<div class="stat-tile plot-stat ' +
      cls +
      '"><span class="stat-num">' +
      c[key] +
      '</span><span class="stat-label">' +
      label +
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
        '<section class="plot-block"><h4 class="plot-h">Kondisi Tanaman</h4><div class="plot-stats">' +
        stat("Severe", "Kritis", "stat-severe") +
        stat("Moderate", "Waspada", "stat-moderate") +
        stat("Healthy", "Sehat", "stat-healthy") +
        stat("Unknown", "Belum Pasti", "") +
        "</div></section>";
    html +=
      '<section class="plot-block"><h4 class="plot-h">Ketinggian Petak</h4>' +
      (m.band
        ? '<p class="plot-p"><b>' +
          esc(m.band.label) +
          "</b>, sekitar " +
          fmt(m.elevation) +
          ' m dpl.</p><p class="plot-p">' +
          esc(m.band.note) +
          "</p>"
        : '<p class="plot-p t-muted">Ketinggian belum tercatat. Foto tanaman dengan GPS menyala agar ketinggian petak terbaca.</p>') +
      "</section>";
    if (m.species.length)
      html +=
        '<section class="plot-block"><h4 class="plot-h">Jenis Tanaman dan Masalahnya</h4>' +
        m.species
          .map((s) => {
            const probs = [...s.problems.entries()].sort((a, b) => b[1] - a[1]);
            const items = s.items
              .map((item) => {
                const reanalyze =
                  item.canReanalyze && item.id
                    ? '<button type="button" class="btn btn-secondary btn-sm plot-reanalyze" data-act="JagaAssessment.reanalyze" data-args="' +
                      esc(JSON.stringify([item.id, "$this"])) +
                      '"><i data-lucide="refresh-cw" aria-hidden="true"></i><span>Analisis Ulang</span></button>'
                    : "";
                return (
                  '<div class="plot-plant-row"><div class="plot-plant-main"><b class="plot-plant-name">' +
                  esc(item.name) +
                  '</b><span class="' +
                  toneBadge(severityTone(item.severity)) +
                  '">' +
                  esc(severityLabel(item.severity)) +
                  '</span><span class="t-meta plot-plant-label">' +
                  esc(item.label) +
                  "</span></div>" +
                  reanalyze +
                  "</div>"
                );
              })
              .join("");
            return (
              '<div class="plot-species"><div class="plot-species-top"><b>' +
              esc(s.name) +
              '</b><span class="t-meta">' +
              s.plants +
              " tanaman" +
              (s.sick ? " · " + s.sick + " bermasalah" : " · sehat") +
              "</span></div>" +
              (probs.length
                ? '<ul class="plot-problems">' +
                  probs
                    .map(
                      ([label, n]) =>
                        '<li><span class="plot-kind plot-kind-' +
                        kindOf(label) +
                        '">' +
                        KIND_LABEL[kindOf(label)] +
                        "</span><span>" +
                        esc(label) +
                        '</span><span class="t-meta">' +
                        n +
                        " tanaman</span></li>",
                    )
                    .join("") +
                  "</ul>"
                : "") +
              '<div class="plot-plant-list">' +
              items +
              "</div></div>"
            );
          })
          .join("") +
        "</section>";
    if (m.findings.length)
      html +=
        '<section class="plot-block"><h4 class="plot-h">Temuan</h4><ul class="plot-list">' +
        m.findings.map((t) => "<li>" + esc(t) + "</li>").join("") +
        "</ul></section>";
    html +=
      '<section class="plot-block"><h4 class="plot-h">Saran Pengelolaan</h4><ul class="plot-list plot-advice">' +
      m.advice.map((t) => "<li>" + esc(t) + "</li>").join("") +
      "</ul></section>";
    html +=
      '<p class="plot-caveat">Dihitung dari foto terakhir setiap tanaman di petak ini dan diperbarui otomatis setiap ada perubahan. Ini panduan umum, bukan diagnosis pasti atau takaran obat. Untuk obat dan dosis, tanyakan penyuluh pertanian setempat.</p>';
    return html;
  }

  function sig(farm) {
    return (
      (root.recordsSig?.() || "") + "|" + farm.id + farm.name + farm.areaM2
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
      farm.name || "Petak";
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
