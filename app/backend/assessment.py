"""Structured, non-chemical photo assessment. Catalog products use a separate opt-in route."""
from __future__ import annotations

import re
from typing import Any
from . import textsafe
from .advice_policy import INSPECTION_CHECKS, prohibited, inspection_only, inspection_plan

REPORT_FIELDS = ("findings", "possible_causes", "actions", "prevention", "nutrition", "monitoring", "escalation", "missing_information")
FIELDS = REPORT_FIELDS + ("active_conditions",)
_FIELD_LIMITS = {"active_conditions": (3, 80)}
_PRODUCT = re.compile(r"\b(?:amistar\s*top|anvil|score\s*250|phonska|urea|npk|kcl|sp[- ]?36|za|neem|mimba|semprot|spray|campur|larutan)\b|\bbakar\b|\btebang\b|cabut semua", re.I)
_NUTRIENT = re.compile(r"pupuk|fertiliz|nitrogen|fosfor|kalium|kalsium|belerang|sulfur", re.I)
_APPLY = re.compile(r"beri|tambah|gunakan|aplik|tabur|campur|apply|add ", re.I)


def clean_previous_condition(value: Any) -> str | None:
    """Historical hypothesis only; never expose product/application instructions."""
    if not isinstance(value, str):
        return None
    text = textsafe.one_line(value, 240)
    if not text or textsafe.contains_chemical_advice(text) or _PRODUCT.search(text):
        return None
    return text

def clean_assessment(raw: Any, *, uncertain: bool = False) -> dict[str, Any] | None:
    if not isinstance(raw, dict) or type(raw.get("version")) is not int or raw["version"] != 1:
        return None
    uncertain = uncertain or raw.get("uncertain") is True
    result: dict[str, Any] = {"version": 1}
    filtered = raw.get("policy_filtered") is True
    for field in FIELDS:
        items = raw.get(field)
        clean = []
        remaining_bytes = 800
        item_limit, text_limit = _FIELD_LIMITS.get(field, (6, 320))
        if isinstance(items, list):
            for item in items[:item_limit]:
                if not isinstance(item, str):
                    continue
                text = textsafe.one_line(item, text_limit)
                if not text:
                    continue
                if prohibited(text) or _PRODUCT.search(text):
                    filtered = True
                    continue
                if field in ("actions", "prevention", "monitoring", "escalation") and not inspection_only(text):
                    filtered = True
                    continue
                text = text.encode("utf-8")[:remaining_bytes].decode("utf-8", "ignore").rstrip()
                if not text:
                    break
                if text not in clean:
                    clean.append(text)
                    remaining_bytes -= len(text.encode("utf-8"))
        result[field] = clean
    if not any(result[field] for field in FIELDS):
        return None
    if uncertain:
        result["active_conditions"] = []
        result["possible_causes"] = ["Penyebab belum dapat dipastikan dari bukti yang tersedia."]
        result["nutrition"] = ["Bukti foto belum cukup untuk menilai kebutuhan unsur hara. Minta pemeriksaan tanah atau daun bila gejala berlanjut."]
    result["inspection_checks"] = list(dict.fromkeys(
        item for item in raw.get("inspection_checks", [])
        if isinstance(item, str) and item in INSPECTION_CHECKS
    ))[:6] if isinstance(raw.get("inspection_checks"), list) else []
    result["actions"] = inspection_plan(raw, uncertain=uncertain)
    result["prevention"] = ["Catat perawatan terakhir dan kondisi lahan sebelum memilih penanganan. Pencegahan khusus memerlukan penyebab yang sudah diperiksa."]
    result["monitoring"] = ["Bandingkan bagian tanaman yang sama pada foto berikutnya; catat gejala baru dan jumlah tanaman yang berubah."]
    result["escalation"] = ["Hubungi penyuluh atau petugas perlindungan tanaman bila gejala meluas, tanaman cepat layu, atau penyebab tetap tidak jelas."]
    if not result["nutrition"]:
        result["nutrition"] = ["Kekurangan hara tidak dapat dipastikan dari foto; bandingkan pola gejala antar tanaman dan lengkapi dengan uji tanah atau daun sebelum memupuk."]
    result["needs_review"] = uncertain or filtered or raw.get("needs_review") is True
    result["policy_filtered"] = filtered
    result["uncertain"] = uncertain
    result["guidance_scope"] = "inspection-only"
    if filtered:
        result["policy_note"] = "Sebagian instruksi perawatan tidak ditampilkan karena belum didukung panduan yang ditinjau. Langkah di sini membantu pemeriksaan, bukan resep perawatan."
    return result


