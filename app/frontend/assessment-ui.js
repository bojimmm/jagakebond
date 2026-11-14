/* Structured assessments and explicit, record-scoped Indonesian input references. */
(function (root) {
  "use strict";
  let dialogToken = 0,
    dialogRecordId = null,
    reanalysisBusy = false,
    reanalysisToken = 0;
  /* Title case in Indonesian headings: every word starts with a capital letter. */
  const sections = [
    ["actions", "Rekomendasi Tindakan"],
    ["findings", "Temuan pada Foto"],
    ["possible_causes", "Dugaan Penyebab"],
    ["prevention", "Rekomendasi Pencegahan"],
    ["nutrition", "Kebutuhan Unsur Hara"],
    ["monitoring", "Pemantauan Lanjutan"],
    ["escalation", "Kapan Perlu Bantuan"],
  ];
  /* Active labels are reused by every card, list, map sheet and viewer. When the model
    supports coexisting problems, keep each short name and show them together; alternatives
    remain in possible_causes and are never promoted into the card title. */
  function node(tag, text, cls) {
    const el = document.createElement(tag);
    if (text) el.textContent = text;
    if (cls) el.className = cls;
    return el;
  }
  function properCaseLabel(value) {
    return String(value == null ? "" : value)
      .toLocaleLowerCase("id-ID")
      .replace(
        /(^|[\s/-])(\p{L})/gu,
        (_, separator, letter) => separator + letter.toLocaleUpperCase("id-ID"),
      );
  }
  const LABEL_PATTERNS = [
    ["Hama penggerek", /\b(?:hama\s+)?penggerek\b/i],
    ["Hama pengunyah", /\b(?:hama\s+)?pengunyah\b/i],
    ["Kutu daun", /\bkutu\s*daun\b|\baphid/i],
    ["Tungau", /\btungau\b|\bmite\b/i],
    ["Thrips", /\bthrips\b|\bthrip\b/i],
    ["Ulat", /\bulat\b|\bcaterpillar\b/i],
    ["Wereng", /\bwereng\b|\bplanthopper\b/i],
    ["Mosaik", /\bmosaik\b|\bmosaic\b/i],
    ["Bulai", /\bbulai\b|\bbuli\b|\bbule\b|downy\s*mildew|embun\s*bulu/i],
    ["Antraknosa", /antrakn|colletotrich/i],
    ["Bercak daun", /\bbercak\s*daun\b|\bleaf\s*spot\b|cercospora/i],
    ["Sigatoka pisang", /\bsigatoka\b|black\s*leaf\s*streak|mycosphaerella/i],
    ["Blas", /\bblast\b|\bblas\b|pyricular/i],
    ["Bercak kering", /\bbercak\s*kering\b|early\s*blight|alternaria/i],
    ["Busuk daun", /\bbusuk\s*daun\b|late\s*blight/i],
    ["Busuk buah", /\bbusuk\s*buah\b/i],
    ["Hawar daun", /\bhawar\s*daun\b/i],
    ["Karat daun", /\bkarat\s*daun\b|\brust\b/i],
  ];
  function shorten(value) {
    let text = String(value == null ? "" : value)
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return "";
    /* Strip explanatory wrappers before looking for the diagnosis: "Penyebab utama
     adalah..." must not become a card title. */
    for (let pass = 0; pass < 5; pass += 1) {
      const before = text;
      text = text.replace(
        /^(?:dugaan|diduga|kemungkinan|perkiraan|diagnosis|penyebab|utama(?:nya)?|adalah|akibat|disebabkan oleh|karena)\s+/i,
        "",
      );
      if (text === before) break;
    }
    text = text.replace(/^[\s\-–—:;,.•]+/, "");
    const nutrient = text.match(
      /\b(?:kekurangan|defisiensi)\s+(?:unsur\s+)?(?:hara\s+)?(nitrogen|fosfor|fosfat|kalium|kalsium|magnesium|belerang|sulfur|besi|mangan|boron|seng|zink|tembaga|molibdenum)\b/i,
    );
    if (nutrient) {
      const name =
        nutrient[1].charAt(0).toUpperCase() +
        nutrient[1].slice(1).toLowerCase();
      return properCaseLabel("Kekurangan " + name);
    }
    for (const [name, pattern] of LABEL_PATTERNS)
      if (pattern.test(text)) return properCaseLabel(name);
    const pest = text.match(
      /\b(hama)\s+(?!dan\b|atau\b|pada\b|tanaman\b)([A-Za-zÀ-ÿ-]+)/i,
    );
    if (pest) return properCaseLabel("Hama " + pest[2]);
    const first = text.split(/\s*[;•|]\s*/)[0].split(/\.\s/)[0];
    const colon = first.split(/\s*:\s*/);
    if (colon.length > 1) {
      const left = colon[0].trim(),
        right = colon.slice(1).join(":").trim();
      text =
        left.split(/\s+/).filter(Boolean).length >= 2 ? left : right || left;
    } else text = first;
    text = text.replace(
      /\s*[-\u2013\u2014]\s*(?:perlu|butuh|memerlukan|konfirmasi|cek).*$/i,
      "",
    );
    text = text.replace(
      /\s*\((?:perlu|butuh|memerlukan|belum)[^)]*\)\s*$/i,
      "",
    );
    text = text
      .replace(/[^\p{L}\p{N}\s/-]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    const words = text.split(" ").filter(Boolean).slice(0, 2);
    if (!words.length) return "";
    const short = words.join(" ");
    return properCaseLabel(short);
  }
  function shortLabels(values) {
    const items = Array.isArray(values) ? values : values ? [values] : [],
      out = [];
    for (const item of items) {
      if (typeof item !== "string" || !item.trim()) continue;
      for (const part of item.split(
        /\s*(?:\+|;|•|\||·|\s+dan\s+|\s+serta\s+)\s*/i,
      )) {
        const name = shorten(part);
        if (name && !out.includes(name)) out.push(name);
        if (out.length >= 3) return out;
      }
    }
    return out;
  }
  function label(record) {
    if (!record?.observedProblems && record?.observedSeverity === "Healthy")
      return "Tanaman Sehat";
    if (
      !record?.observedProblems &&
      /^(?:(?:belum|tidak)\s+(?:dapat|bisa)\s+(?:dipastikan|dikenali|diidentifikasi)|tidak diketahui|unknown|unclear)\b/i.test(
        String(record?.condition || ""),
      )
    )
      return "Belum Dapat Dipastikan";
    if (
      !record?.observedProblems &&
      (record?.assessment?.uncertain ||
        (record?.needs_review && Number(record?.confidence) < 0.5))
    )
      return "Belum Dapat Dipastikan";
    const observed = record?.observedProblems;
    if (observed && typeof observed === "object" && !Array.isArray(observed)) {
      const active = shortLabels(
        [observed.pest, observed.disease].filter(Boolean),
      );
      if (active.length) return active.join(" · ");
      if (record?.observedSeverity === "Healthy") return "Tanaman Sehat";
      if (
        record?.assessment?.uncertain ||
        (record?.needs_review && Number(record?.confidence) < 0.5)
      )
        return "Belum Dapat Dipastikan";
      if (String(record?.severity || "").toLowerCase() === "healthy")
        return "Tanaman Sehat";
      return "Belum Dapat Dipastikan";
    }
    if (
      String(
        record?.observedSeverity || record?.severity || "",
      ).toLowerCase() === "healthy"
    ) {
      const supported = [
        record?.condition,
        ...(record?.assessment?.active_conditions || []),
      ].some((value) => root.JagaProblems?.id(value));
      return supported && !record?.observedSeverity
        ? "Belum Dapat Dipastikan"
        : "Tanaman Sehat";
    }
    const active = shortLabels(record?.assessment?.active_conditions);
    if (active.length) return active.join(" · ");
    return shorten(record?.condition) || "Belum Dapat Dipastikan";
  }
  function problemKey(record) {
    return root.JagaProblems?.ids(record)?.[0] || "unknown";
  }
  function targetText(key) {
    return root.JagaProblems?.label(key) || "Belum Dapat Dipastikan";
  }
  function hypothesis(record) {
    return record?.condition || "Penyebab belum dapat dipastikan.";
  }
  function renderSummary(host, record, { showPrevious = true } = {}) {
    if (!host) return;
    host.replaceChildren();
    host.classList.add("assessment-summary");
    const current = label(record),
      healthy = current === "Tanaman Sehat";
    host.classList.toggle("assessment-summary-diagnosis", !healthy);
    host.append(
      node(
        "p",
        healthy ? "Penilaian Tanaman" : "Dugaan Hama / Penyakit",
        "assessment-summary-label",
      ),
      node("p", current, "assessment-summary-current"),
    );
    if (record?.observedProblems && typeof record.observedProblems === "object")
      host.append(
        node(
          "p",
          "Dugaan diperbarui manual. Rincian di bawah tetap dari analisis AI.",
          "assessment-note assessment-manual-correction",
        ),
      );
    else if (record?.observedSeverity)
      host.append(
        node(
          "p",
          "Status diperbarui manual. Rincian di bawah tetap dari analisis AI.",
          "assessment-note assessment-manual-correction",
        ),
      );
    if (showPrevious && record?.previousCondition) {
      const previous = node("p", null, "assessment-previous");
      previous.append(
        node("b", "Dugaan sebelum analisis ulang: "),
        document.createTextNode(record.previousCondition),
        node("span", " \u00b7 Belum terkonfirmasi."),
      );
      host.append(previous);
    }
  }
  function assessmentText(record) {
    const a = record?.assessment;
    if (a?.version !== 1) return record?.immediate_action || "";
    return (
      label(record) +
      "\nPenilaian foto adalah dugaan awal.\n\n" +
      sections
        .filter(([key]) => Array.isArray(a[key]) && a[key].length)
        .map(
          ([key, title]) =>
            title + ":\n" + a[key].map((t) => "\u2022 " + t).join("\n"),
        )
        .join("\n\n")
    );
  }
  function renderAssessment(
    host,
    record,
    { chemical = true, compact = false } = {},
  ) {
    if (!host) return;
    host.replaceChildren();
    host.classList.add("assessment-content");
    const a = record?.assessment;
    if (compact) {
      if (a?.version === 1) {
        const button = node("button", null, "btn btn-secondary");
        button.type = "button";
        button.append(node("span", "Analisis Lengkap", "btn-label"));
        button.onclick = () => openAssessment(record.id);
        host.append(button);
      }
      return;
    }
    if (a?.version === 1) {
      const overview = node("div", null, "assessment-overview");
      renderSummary(overview, record, { showPrevious: false });
      host.append(overview);
      host.append(
        node(
          "p",
          "Penilaian foto adalah dugaan awal. Periksa kondisi tanaman secara langsung.",
          "assessment-note assessment-caveat",
        ),
      );
      if (a.guidance_scope === "inspection-only")
        host.append(
          node(
            "p",
            "Langkah berikut membantu pemeriksaan. Penanganan khusus perlu disesuaikan dengan penyebab yang sudah dikonfirmasi di lapangan.",
            "assessment-note assessment-guidance",
          ),
        );
      for (const [key, title] of sections) {
        if (!Array.isArray(a[key]) || !a[key].length) continue;
        const section = node(
          "section",
          null,
          "assessment-section" +
            (key === "actions" ? " assessment-actions" : ""),
        );
        section.append(node("h4", title));
        const list = node("ul", null, "assessment-list");
        for (const item of a[key].slice(0, 6))
          if (typeof item === "string") list.append(node("li", item));
        section.append(list);
        host.append(section);
      }
    } else {
      host.append(
        node(
          "p",
          "Rincian analisis terstruktur belum tersedia untuk catatan ini. Ambil foto baru untuk penilaian terbaru.",
          "assessment-note",
        ),
      );
      if (record?.symptoms) {
        host.append(node("h4", "Temuan Tersimpan"), node("p", record.symptoms));
      }
      if (record?.immediate_action)
        host.append(node("p", record.immediate_action));
    }
    const copy = node("button", null, "btn btn-secondary assessment-copy");
    copy.type = "button";
    copy.append(node("span", "Salin Analisis", "btn-label"));
    const feedback = node("p", null, "assessment-note");
    feedback.setAttribute("role", "status");
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(assessmentText(record));
        feedback.textContent = "Analisis disalin.";
      } catch (_) {
        feedback.textContent =
          "Pilih teks analisis lalu gunakan Salin pada perangkat Anda.";
      }
    };
    host.append(copy, feedback);
    const provenance = record?.analysisProvenance;
    if (provenance && typeof provenance === "object") {
      const about = node("details", null, "assessment-about");
      about.append(node("summary", "Tentang Analisis"));
      about.append(
        node(
          "p",
          "Hasil ini dibuat AI dari foto. Tingkat ketepatannya belum diukur terhadap kumpulan kasus yang dinilai ahli.",
          "assessment-note",
        ),
      );
      if (provenance.diagnosis?.resolvedModel)
        about.append(
          node(
            "p",
            "Model yang dilaporkan penyedia: " +
              provenance.diagnosis.resolvedModel,
            "assessment-note",
          ),
        );
      else
        about.append(
          node(
            "p",
            "Penyedia tidak melaporkan model yang menjalankan analisis.",
            "assessment-note",
          ),
        );
      host.append(about);
    }
    if (chemical && record?.id) host.append(inputOptions(record));
  }
  function inputOptions(record) {
    const owner = String(currentAccount?.id || ""),
      generation = accountGeneration;
    const target = problemKey(record),
      targetLabel =
        (root.JagaProblems?.ids(record) || []).map(targetText).join(" · ") ||
        label(record);
    const details = node("details", null, "input-options");
    const summary = node("summary", "Tinjau Opsi Kimia / Pupuk");
    details.append(summary);
    details.append(
      node(
        "p",
        "Opsional. Referensi produk hanya dibuka setelah Anda menyetujui batasannya. Kolom kondisi lahan boleh dikosongkan bila belum diketahui.",
        "assessment-note",
      ),
    );
    const terms = node("div", null, "input-terms");
    terms.append(
      node(
        "p",
        "Referensi bukan resep dari foto. Pastikan diagnosis di lapangan, izin edar, tanaman/sasaran dan label terbaru. Ikuti APD, batas aplikasi, jeda panen dan masuk kembali pada label. Jangan mencampur produk tanpa petunjuk. Foto daun saja tidak cukup untuk menentukan kebutuhan pupuk.",
        "input-disclaimer",
      ),
    );
    const fields = {};
    function checkbox(key, text, required, host) {
      const wrap = node("label", null, "input-check");
      const input = node("input");
      input.type = "checkbox";
      input.name = key;
      input.required = required;
      wrap.append(input, node("span", text, "input-check-text"));
      host.append(wrap);
      fields[key] = input;
      return input;
    }
    const accepted = checkbox(
      "accepted",
      "Saya sudah membaca dan memahami batasan referensi produk ini.",
      true,
      terms,
    );
    checkbox(
      "fieldConfirmed",
      "Penyebab sudah dikonfirmasi di lapangan oleh penyuluh / petugas.",
      false,
      terms,
    );
    const gate = node(
      "p",
      "Centang pernyataan batasan referensi untuk membuka formulir referensi produk.",
      "assessment-note",
    );
    terms.append(gate);
    details.append(terms);
    const form = node("form", null, "input-options-form");
    const targetRow = node("p", null, "assessment-target");
    targetRow.append(
      node("b", "Sasaran yang ingin ditinjau: "),
      document.createTextNode(targetLabel),
      node("span", " (dari analisis foto ini)"),
    );
    form.append(
      node(
        "p",
        "Kondisi lahan boleh dikosongkan. Referensi disaring dari jenis tanaman dan sasaran aktif; isian ini tidak menghasilkan dosis atau resep pupuk pribadi.",
        "assessment-note",
      ),
      targetRow,
    );
    const problem = node("input");
    problem.type = "hidden";
    problem.name = "problem";
    problem.value = target;
    form.append(problem);
    fields.problem = problem;
    function field(key, fieldLabel) {
      const wrap = node("label", fieldLabel);
      const input = node("input");
      input.name = key;
      input.type = "text";
      input.maxLength = 240;
      input.placeholder = "Opsional; kosongkan bila belum diketahui";
      wrap.append(input);
      form.append(wrap);
      fields[key] = input;
    }
    field("growthStage", "Umur / fase pertumbuhan");
    field("symptomDuration", "Sejak kapan gejala muncul");
    field("affectedExtent", "Jumlah tanaman dan luas gejala");
    field("location", "Kabupaten / kondisi lahan");
    field("harvestWindow", "Perkiraan waktu panen");
    field("recentInputs", "Produk / pemupukan terakhir dan waktunya");
    const soilLabel = node("label", "Data tanah / uji hara (bila ada)");
    const soil = node("input");
    soil.name = "soilInformation";
    soil.maxLength = 240;
    soil.placeholder = "Opsional; kosongkan bila belum ada";
    soilLabel.append(soil);
    form.append(soilLabel);
    fields.soilInformation = soil;
    const button = node("button", null, "btn btn-secondary");
    button.type = "submit";
    button.append(node("span", "Cari referensi produk", "btn-label"));
    form.append(button);
    const result = node("div", null, "input-options-result");
    result.setAttribute("aria-live", "polite");
    details.append(form, result);
    function syncGate() {
      form.hidden = accepted.checked !== true;
      gate.hidden = accepted.checked === true;
    }
    accepted.addEventListener("change", syncGate);
    syncGate();
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (fields.accepted.checked !== true || !form.reportValidity()) return;
      if (
        owner !== String(currentAccount?.id || "") ||
        generation !== accountGeneration
      )
        return;
      const body = {
        recordId: record.id,
        disclaimerVersion: "id-inputs-1",
        accepted: fields.accepted.checked,
        fieldConfirmed: fields.fieldConfirmed.checked,
      };
      for (const [key, input] of Object.entries(fields))
        if (input.type !== "checkbox") body[key] = input.value.trim();
      body.problem = target;
      button.disabled = true;
      result.replaceChildren(node("p", "Memeriksa katalog…"));
      try {
        const reply = await api("/api/recommendations", {
          method: "POST",
          body,
        });
        if (
          owner !== String(currentAccount?.id || "") ||
          generation !== accountGeneration ||
          !details.isConnected
        )
          return;
        result.replaceChildren(
          node("p", reply.coverage_note, "assessment-note"),
        );
        for (const reason of reply.reasons || [])
          result.append(node("p", reason));
        for (const product of reply.references || []) {
          const card = node("section", null, "input-product");
          card.append(
            node("h4", product.name),
            node("p", product.composition),
            node("p", product.status_label, "assessment-note"),
          );
          if (product.targets?.length)
            card.append(
              node(
                "p",
                "Sasaran yang disebut sumber: " + product.targets.join("; "),
              ),
            );
          if (product.manufacturer_registration_number)
            card.append(
              node(
                "p",
                "Nomor menurut produsen: " +
                  product.manufacturer_registration_number +
                  "; status terkini belum dikonfirmasi.",
                "assessment-note",
              ),
            );
          card.append(
            node(
              "p",
              "Diperiksa " +
                product.checked_at +
                " \u00b7 Bukan konfirmasi stok atau izin edar aktif.",
              "assessment-note",
            ),
          );
          if (product.missing_evidence?.length)
            card.append(
              node(
                "p",
                "Belum lengkap: " + product.missing_evidence.join(", "),
                "assessment-note",
              ),
            );
          try {
            const url = new URL(product.source_url);
            if (url.protocol === "https:") {
              const link = node("a", "Buka sumber produsen");
              link.href = url.href;
              link.target = "_blank";
              link.rel = "noopener noreferrer";
              card.append(link);
            }
          } catch (_) {}
          result.append(card);
        }
        if (!reply.references?.length)
          result.append(
            node(
              "p",
              "Belum ada referensi untuk pasangan tanaman dan sasaran ini. Jangan memakai produk untuk tanaman lain sebagai pengganti.",
            ),
          );
      } catch (error) {
        if (
          owner === String(currentAccount?.id || "") &&
          generation === accountGeneration
        )
          result.replaceChildren(node("p", userMessage(error)));
      } finally {
        button.disabled = false;
      }
    });
    return details;
  }
  function reanalyzable(record) {
    if (!record || record.source !== "ai") return false;
    return /^\/api\/photos\/[A-Za-z0-9_-]+$/.test(
      String(record.serverImageUrl || record.imageUrl || ""),
    );
  }
  function reanalysisWait(ms, token) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (token !== reanalysisToken) reject(new Error("reanalysis_stale"));
        else resolve();
      }, ms);
      if (token !== reanalysisToken) {
        clearTimeout(timer);
        reject(new Error("reanalysis_stale"));
      }
    });
  }
  function renderAssessmentDialog(modal, record) {
    if (!modal || !record) return;
    const title = modal.querySelector("h3"),
      body = modal.querySelector(".assessment-dialog-body");
    if (title)
      title.textContent = record.cropName || record.crop || "Analisis tanaman";
    if (body) {
      body.replaceChildren();
      const content = node("div");
      renderAssessment(content, record);
      body.append(content);
    }
  }
  function setReanalysisTrigger(trigger, busy) {
    if (!trigger || !trigger.querySelector) return;
    const label =
      trigger.querySelector(".btn-label") || trigger.querySelector("span");
    if (label)
      label.textContent = busy ? "Menganalisis ulang…" : "Analisis ulang";
    trigger.disabled = !!busy;
    trigger.setAttribute("aria-busy", busy ? "true" : "false");
  }
  const REANALYSIS_PROGRESS = {
    "triage:start": 42,
    "triage:http": 48,
    "triage:done": 58,
    "diagnose:start": 66,
    "diagnose:http": 74,
    "diagnose:done": 88,
    "result:posted": 95,
    "worker:release": 28,
  };
  function reanalysisDialog() {
    return document.getElementById("reanalysis-dialog");
  }
  function setReanalysisStepStates(fill) {
    const dialog = reanalysisDialog();
    if (!dialog) return;
    // Analisis starts with triage (42 %), not when the diagnosis is already done (88 %).
    const thresholds = { prepare: 8, queue: 18, analyze: 40, finish: 100 };
    for (const [name, minimum] of Object.entries(thresholds)) {
      const step = dialog.querySelector(`[data-reanalysis-step="${name}"]`);
      if (!step) continue;
      const next = Object.entries(thresholds)
        .sort((a, b) => a[1] - b[1])
        .find(([, value]) => value > minimum);
      // The last step has no next one: it is done once the meter is full, not left "active" forever.
      step.dataset.state =
        fill >= minimum
          ? (next ? fill >= next[1] - 1 : fill >= 100)
            ? "done"
            : "active"
          : "pending";
    }
  }
  function setReanalysisProgress(percent, text, detail, options = {}) {
    const dialog = reanalysisDialog();
    const fill = Math.max(4, Math.min(100, Math.round(percent || 4)));
    if (dialog && options.open) {
      setDialogOpen("reanalysis-dialog", options.trigger);
    }
    if (fill > 0) {
      const bar = dialog?.querySelector("#reanalysis-meter");
      const track = dialog?.querySelector("#reanalysis-progress-fill");
      if (bar) bar.setAttribute("aria-valuenow", String(fill));
      if (track) track.style.transform = "scaleX(" + fill / 100 + ")";
      setReanalysisStepStates(fill);
    }
    if (text) {
      const status = dialog?.querySelector("#reanalysis-status");
      if (status) status.textContent = text;
    }
    if (detail) {
      const detailNode = dialog?.querySelector("#reanalysis-detail");
      if (detailNode) detailNode.textContent = detail;
    }
    if (dialog) dialog.dataset.tone = options.tone || "busy";
    if (
      options.toast &&
      dialog &&
      dialog.classList.contains("hidden") &&
      typeof showToast === "function"
    )
      showToast(text);
  }
  /* One progress dialog, two wordings: re-analysis of a saved record, or a new photo still in the queue (0.2.4.14). */
  const PROGRESS_TEXT = {
    reanalysis: {
      title: "Analisis ulang",
      first: "Foto asli",
      name: "Kemajuan analisis ulang",
      steps: "Tahapan analisis ulang",
      note: "Catatan yang sama akan diperbarui. Hasil lama tetap dapat dibaca sampai analisis baru selesai.",
    },
    photo: {
      title: "Analisis foto",
      first: "Terkirim",
      name: "Kemajuan analisis foto",
      steps: "Tahapan analisis foto",
      note: "Foto sudah ada di server. Jendela ini boleh ditutup; hasilnya tetap masuk ke Riwayat.",
    },
  };
  function setProgressMode(mode) {
    const dialog = reanalysisDialog(),
      text = PROGRESS_TEXT[mode];
    if (!dialog || !text) return;
    dialog.dataset.mode = mode;
    dialogNames["reanalysis-dialog"] = text.name;
    const set = (selector, value) => {
      const el = dialog.querySelector(selector);
      if (el) el.textContent = value;
    };
    const note = dialog.querySelector(".reanalysis-safe-note");
    if (note) note.hidden = false;
    set("#reanalysis-title", text.title);
    set('[data-reanalysis-step="prepare"] span', text.first);
    set(".reanalysis-safe-note p", text.note);
    dialog
      .querySelector("#reanalysis-meter")
      ?.setAttribute("aria-label", text.name);
    dialog
      .querySelector(".reanalysis-steps")
      ?.setAttribute("aria-label", text.steps);
    dialog
      .querySelector("#reanalysis-close")
      ?.setAttribute("aria-label", "Sembunyikan " + text.name.toLowerCase());
    for (const button of dialog.querySelectorAll(
      "#reanalysis-close, #reanalysis-close-button",
    ))
      button.onclick = () => closeDialog("reanalysis-dialog");
    const view = dialog.querySelector("#reanalysis-view");
    if (view) view.hidden = true;
    const close = dialog.querySelector("#reanalysis-close-label");
    if (close) close.textContent = "Sembunyikan";
    dialog.dataset.tone = "busy";
  }
  function prepareReanalysisDialog(record, trigger) {
    const dialog = reanalysisDialog();
    if (!dialog) return;
    watchToken += 1;
    setProgressMode("reanalysis");
    for (const button of dialog.querySelectorAll(
      "#reanalysis-close, #reanalysis-close-button",
    )) {
      button.onclick = () => closeDialog("reanalysis-dialog");
    }
    const photo = dialog.querySelector("#reanalysis-photo");
    const src = String(record?.serverImageUrl || record?.imageUrl || "");
    if (photo && src) {
      photo.src = src;
      photo.alt = "Foto tanaman yang akan dianalisis ulang";
      photo.hidden = false;
    } else if (photo) {
      photo.removeAttribute("src");
      photo.hidden = true;
    }
    const crop = dialog.querySelector("#reanalysis-crop");
    if (crop)
      crop.textContent = record?.cropName || record?.crop || "Foto tanaman";
    dialog.dataset.tone = "busy";
    const view = dialog.querySelector("#reanalysis-view");
    if (view) view.hidden = true;
    const close = dialog.querySelector("#reanalysis-close-label");
    if (close) close.textContent = "Sembunyikan";
    const detail = dialog.querySelector("#reanalysis-detail");
    if (detail)
      detail.textContent =
        "Foto asli tanpa cap lokasi disiapkan untuk analisis baru.";
    setReanalysisProgress(
      6,
      "Menyiapkan foto asli tanpa cap lokasi…",
      "Hasil lama tetap tersimpan dan dapat dibaca sampai analisis baru selesai.",
      { open: true, trigger },
    );
  }
  function updateReanalysisProgress(job) {
    const position =
      typeof job?.position === "number" ? Math.max(0, job.position) : null;
    const stage = String(job?.stage || "");
    const claimed = job?.status === "claimed";
    let percent = claimed ? 36 : 20;
    if (stage && REANALYSIS_PROGRESS[stage])
      percent = REANALYSIS_PROGRESS[stage];
    const current = Number(
      reanalysisDialog()
        ?.querySelector("#reanalysis-meter")
        ?.getAttribute("aria-valuenow") || 0,
    );
    percent = Math.max(current, percent);
    let status = job?.statusLabel || "";
    let detail = "Hasil lama tetap tersimpan sampai analisis baru selesai.";
    if (job?.status === "queued" && !stage) {
      status = "Menunggu giliran analisis ulang";
      if (position !== null)
        detail = `Posisi antrean: ${position + 1}. Hasil lama tetap tersimpan.`;
    } else if (!status && stage === "worker:release") {
      status = "Server sedang sibuk. Analisis dicoba lagi otomatis…";
    } else if (!status) {
      status = claimed
        ? "Sedang menganalisis ulang…"
        : "Memasukkan analisis ke antrean…";
    }
    if (position !== null && job?.status === "queued")
      detail = `Posisi antrean: ${position + 1}. Hasil lama tetap tersimpan.`;
    setReanalysisProgress(percent, status, detail, { tone: "busy" });
  }
  async function runReanalysis(record, trigger) {
    if (reanalysisBusy || !reanalyzable(record)) return;
    const owner = String(currentAccount?.id || ""),
      generation = accountGeneration,
      token = ++reanalysisToken;
    const stillCurrent = () =>
      owner === String(currentAccount?.id || "") &&
      generation === accountGeneration &&
      token === reanalysisToken &&
      farmRecords.some((row) => row.id === record.id);
    reanalysisBusy = true;
    setReanalysisTrigger(trigger, true);
    prepareReanalysisDialog(record, trigger);
    try {
      const receipt = await api(
        "/api/records/" + encodeURIComponent(record.id) + "/reanalyze",
        { method: "POST", body: {} },
      );
      if (!stillCurrent()) return;
      const jobId = receipt?.jobId || receipt?.job_id;
      if (!jobId)
        throw new Error(
          "Server belum memberi nomor analisis ulang. Coba lagi.",
        );
      setReanalysisProgress(
        18,
        "Analisis ulang masuk antrean…",
        receipt.source === "original-photo-no-stamp"
          ? "Foto asli tanpa cap berhasil disiapkan. Hasil lama tetap tersimpan."
          : "Hasil lama tetap tersimpan.",
        { tone: "busy" },
      );
      for (let attempt = 0; attempt < 300; attempt++) {
        await reanalysisWait(attempt === 0 ? 900 : 2500, token);
        let job;
        try {
          job = await api("/api/analyze/" + encodeURIComponent(jobId));
        } catch (error) {
          if (!stillCurrent()) return;
          if (attempt % 3 === 2)
            setReanalysisProgress(
              Number(
                reanalysisDialog()
                  ?.querySelector("#reanalysis-meter")
                  ?.getAttribute("aria-valuenow") || 18,
              ),
              "Koneksi terputus. Mencoba membaca hasil lagi…",
              "Analisis tetap berjalan di server. Hasil lama tetap tersimpan.",
              { tone: "busy" },
            );
          continue;
        }
        if (!stillCurrent()) return;
        if (job?.status === "queued" || job?.status === "claimed") {
          updateReanalysisProgress(job);
          continue;
        }
        if (job?.status === "done") {
          setReanalysisProgress(
            96,
            "Menyimpan hasil ke catatan yang sama…",
            "Analisis selesai. Memperbarui foto tanpa membuat catatan baru.",
            { tone: "busy" },
          );
          await refreshAllData();
          if (typeof hydrateLocalRecordPhotos === "function")
            await hydrateLocalRecordPhotos();
          if (!stillCurrent()) return;
          const updated = farmRecords.find((row) => row.id === record.id);
          if (!updated)
            throw new Error(
              "Catatan asli tidak ditemukan setelah analisis selesai.",
            );
          // The result already lives on the original record. Acknowledging the job prevents
          // launch recovery from saving the same result as a second crop.
          if (typeof acknowledgeJob === "function") acknowledgeJob(jobId);
          const dialog = reanalysisDialog(),
            view = dialog?.querySelector("#reanalysis-view");
          const close = dialog?.querySelector("#reanalysis-close-label");
          if (close) close.textContent = "Tutup";
          if (view) {
            view.hidden = false;
            view.onclick = () => {
              closeDialog("reanalysis-dialog");
              setTimeout(() => openAssessment(record.id), 0);
            };
          }
          setReanalysisProgress(
            100,
            "Analisis ulang selesai. Hasil sudah masuk ke catatan asli.",
            "Dugaan sebelumnya disimpan sebagai pembanding; catatan baru tidak dibuat.",
            { tone: "success", toast: true },
          );
          return;
        }
        if (["failed", "rejected", "cancelled"].includes(job?.status))
          throw new Error(
            job.error ||
              "Analisis ulang tidak selesai. Analisis lama tetap tersimpan.",
          );
      }
      setReanalysisProgress(
        97,
        "Analisis ulang masih diproses…",
        "Analisis tetap berjalan di server. Buka kembali catatan ini nanti; hasil lama tetap tersimpan.",
        { tone: "busy", toast: true },
      );
    } catch (error) {
      if (!stillCurrent() || error.message === "reanalysis_stale") return;
      const dialog = reanalysisDialog(),
        close = dialog?.querySelector("#reanalysis-close-label");
      if (close) close.textContent = "Tutup";
      setReanalysisProgress(
        Number(
          dialog
            ?.querySelector("#reanalysis-meter")
            ?.getAttribute("aria-valuenow") || 6,
        ),
        "Analisis ulang belum selesai",
        "Analisis ulang gagal: " +
          userMessage(error) +
          " Analisis lama tetap tersimpan.",
        { tone: "error", toast: true },
      );
    } finally {
      reanalysisBusy = false;
      if (trigger?.isConnected) setReanalysisTrigger(trigger, false);
    }
  } /* Riwayat "N sedang dianalisis": tapping a photo follows its job with the same bar and steps as Analisis ulang. */
  let watchToken = 0;
  function updatePhotoProgress(job) {
    const position =
        typeof job?.position === "number" ? Math.max(0, job.position) : null,
      stage = String(job?.stage || ""),
      claimed = job?.status === "claimed";
    let percent = claimed ? 36 : 20;
    if (stage && REANALYSIS_PROGRESS[stage])
      percent = REANALYSIS_PROGRESS[stage];
    percent = Math.max(
      Number(
        reanalysisDialog()
          ?.querySelector("#reanalysis-meter")
          ?.getAttribute("aria-valuenow") || 0,
      ),
      percent,
    );
    let status = job?.stageLabel || job?.statusLabel || "",
      detail = "Hasilnya masuk ke Riwayat setelah selesai.";
    if (job?.status === "queued" && !stage) {
      status = "Menunggu giliran analisis";
      if (position !== null) detail = "Posisi antrean: " + (position + 1) + ".";
    } else if (!status && stage === "worker:release")
      status = "Server sedang sibuk. Analisis dicoba lagi otomatis…";
    else if (!status)
      status = claimed ? "Sedang menganalisis foto…" : "Foto masuk antrean…";
    setReanalysisProgress(percent, status, detail, { tone: "busy" });
  }
  async function watchAnalysis({ jobId, crop, photo, trigger } = {}) {
    const dialog = reanalysisDialog();
    if (!dialog || !jobId || !currentAccount) return;
    if (reanalysisBusy) {
      showToast("Tunggu analisis ulang selesai dulu.");
      return;
    }
    const owner = String(currentAccount.id),
      generation = accountGeneration,
      token = ++watchToken;
    const live = () =>
      token === watchToken &&
      owner === String(currentAccount?.id || "") &&
      generation === accountGeneration &&
      !dialog.classList.contains("hidden");
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const current = () =>
      Number(
        dialog
          .querySelector("#reanalysis-meter")
          ?.getAttribute("aria-valuenow") || 18,
      );
    setProgressMode("photo");
    const cropNode = dialog.querySelector("#reanalysis-crop");
    if (cropNode) cropNode.textContent = crop || "Foto tanaman";
    const img = dialog.querySelector("#reanalysis-photo");
    if (img && photo) {
      img.src = photo;
      img.alt = "Foto tanaman yang sedang dianalisis";
      img.hidden = false;
    } else if (img) {
      img.removeAttribute("src");
      img.hidden = true;
    }
    dialog
      .querySelector("#reanalysis-meter")
      ?.setAttribute("aria-valuenow", "0");
    setReanalysisProgress(
      18,
      "Foto terkirim. Membaca status antrean…",
      "Hasilnya masuk ke Riwayat setelah selesai.",
      { open: true, trigger, tone: "busy" },
    );
    for (let attempt = 0; attempt < 400; attempt++) {
      let job;
      try {
        job = await api("/api/analyze/" + encodeURIComponent(jobId));
      } catch (error) {
        if (!live()) return;
        if (attempt % 3 === 2)
          setReanalysisProgress(
            current(),
            "Koneksi terputus. Mencoba membaca status lagi…",
            "Analisis tetap berjalan di server.",
            { tone: "busy" },
          );
        await sleep(2500);
        continue;
      }
      if (!live()) return;
      if (job?.status === "queued" || job?.status === "claimed") {
        updatePhotoProgress(job);
        await sleep(2500);
        if (!live()) return;
        continue;
      }
      const close = dialog.querySelector("#reanalysis-close-label");
      if (close) close.textContent = "Tutup";
      // Finished or refused: the reassurance "hasilnya tetap masuk ke Riwayat" no longer applies.
      const note = dialog.querySelector(".reanalysis-safe-note");
      if (note) note.hidden = true;
      if (job?.status === "done") {
        setReanalysisProgress(
          96,
          "Menyimpan hasil ke Riwayat…",
          "Analisis selesai.",
          { tone: "busy" },
        );
        // The Riwayat workflow saves a finished job as record_<jobId>; run it now instead of waiting for the next poll.
        let record = null;
        for (let i = 0; i < 3 && !record; i++) {
          try {
            if (typeof refreshWorkflow === "function") await refreshWorkflow();
          } catch (_) {
            /* the strip's own poll retries */
          }
          record =
            farmRecords.find((row) => row.id === "record_" + jobId) || null;
          if (!record) await sleep(1200);
        }
        if (!live()) return;
        const view = dialog.querySelector("#reanalysis-view");
        if (view && record) {
          view.hidden = false;
          view.onclick = () => {
            closeDialog("reanalysis-dialog");
            setTimeout(() => openAssessment(record.id), 0);
          };
        }
        const found = record
          ? [record.cropName || record.crop, record.condition]
              .filter(Boolean)
              .join(": ")
          : "";
        setReanalysisProgress(
          100,
          "Analisis selesai. Hasil sudah masuk ke Riwayat.",
          found || "Buka Riwayat untuk melihat hasilnya.",
          { tone: "success" },
        );
        return;
      }
      setReanalysisProgress(
        current(),
        "Analisis tidak selesai",
        (job?.error || "Server tidak dapat menyelesaikan analisis foto ini.") +
          " Lihat pilihan di daftar foto.",
        { tone: "error" },
      );
      return;
    }
  }
  function startReanalysis(id, trigger) {
    const record = farmRecords.find((row) => row.id === id);
    if (!record) return;
    if (!reanalyzable(record)) {
      showToast("Foto asli catatan ini tidak tersedia untuk analisis ulang.");
      return;
    }
    return runReanalysis(record, trigger);
  }
  function openAssessment(id) {
    const record = farmRecords.find((row) => row.id === id);
    if (!record || !currentAccount) return;
    dialogToken += 1;
    dialogRecordId = String(record.id);
    reanalysisBusy = false;
    let modal = document.getElementById("assessment-dialog");
    if (!modal) {
      modal = node("div", null, "assessment-dialog hidden");
      modal.id = "assessment-dialog";
      const panel = node("section", null, "assessment-dialog-panel"),
        head = node("header", null, "assessment-dialog-head");
      const actions = node("div", null, "assessment-dialog-actions");
      const close = node("button", null, "btn btn-quiet btn-icon btn-sm");
      close.type = "button";
      close.setAttribute("aria-label", "Tutup analisis");
      close.title = "Tutup analisis";
      const closeIcon = node("i");
      closeIcon.setAttribute("data-lucide", "x");
      closeIcon.setAttribute("aria-hidden", "true");
      close.append(closeIcon);
      close.onclick = () => {
        dialogToken += 1;
        closeDialog("assessment-dialog");
      };
      actions.append(close);
      head.append(node("h3", "Analisis tanaman"), actions);
      panel.append(head, node("div", null, "assessment-dialog-body"));
      modal.append(panel);
      document.body.append(modal);
      dialogNames["assessment-dialog"] = "Analisis tanaman";
      try {
        if (typeof lucide !== "undefined") lucide.createIcons();
      } catch (_) {}
    }
    renderAssessmentDialog(modal, record);
    setDialogOpen("assessment-dialog");
  }
  function clear() {
    dialogToken += 1;
    dialogRecordId = null;
    reanalysisBusy = false;
    reanalysisToken += 1;
    const progress = document.getElementById("reanalysis-dialog");
    if (progress && !progress.classList.contains("hidden"))
      closeDialog("reanalysis-dialog");
    const modal = document.getElementById("assessment-dialog");
    if (modal) {
      closeDialog("assessment-dialog");
      modal.remove();
    }
    for (const id of [
      "res-assessment",
      "sheet-assessment",
      "viewer-assessment",
    ])
      document.getElementById(id)?.replaceChildren();
  }
  root.JagaAssessment = {
    render: renderAssessment,
    summary: renderSummary,
    text: assessmentText,
    label,
    problem: problemKey,
    open: openAssessment,
    canReanalyze: reanalyzable,
    reanalyze: startReanalysis,
    watch: watchAnalysis,
    clear,
  };
})(window);
