"""Versioned Indonesian input references. Manufacturer evidence is not registration approval."""
from __future__ import annotations

from functools import lru_cache
import json
from pathlib import Path
from typing import Any
from .problem_registry import active_problem_ids, target_labels

DISCLAIMER_VERSION = "id-inputs-1"
DISCLAIMER = "Pilihan produk merupakan referensi, bukan resep dari foto. Pastikan penyebab di lapangan, izin edar, kecocokan tanaman dan sasaran, serta label produk yang berlaku. Ikuti alat pelindung, batas aplikasi, jeda panen dan masuk kembali pada label. Jangan mencampur produk tanpa petunjuk label. Pupuk memerlukan riwayat pemupukan dan penilaian tanah; daun menguning saja tidak membuktikan kekurangan hara."

@lru_cache(maxsize=1)
def catalog() -> dict[str, Any]:
    return json.loads((Path(__file__).resolve().parent.parent / "reference/indonesia-inputs.json").read_text(encoding="utf-8"))

def crop_key(name: str) -> str | None:
    text = name.casefold().split("(")[0].strip()
    for key, aliases in {"cabai":("cabai", "cabe"), "tomat":("tomat",), "pisang":("pisang",), "padi":("padi",), "jagung":("jagung",), "bawang_merah":("bawang merah",), "mangga":("mangga",), "jeruk":("jeruk",)}.items():
        if any(text == alias or text.startswith(alias + " ") for alias in aliases):
            return key
    return None

def options(record: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    data = catalog()
    crop = crop_key(str(record.get("crop") or ""))
    selected = active_problem_ids(record)
    references = []
    for product in data["products"]:
        matches = [use for use in product["uses"] if use["crop"] == crop and use["problem"] in selected]
        general = product.get("general_reference") is True and "nutrition" in selected
        if not matches and not general:
            continue
        # Only independently reviewed registry + complete label evidence can unlock operational advice.
        # This initial catalog intentionally has no such entries; never infer approval from a sales page.
        references.append({"id":product["id"], "name":product["name"], "category":product["category"],
            "composition":product["composition"], "source_url":product["source_url"],
            "checked_at":product["checked_at"], "registration_status":product["registration_status"],
            "status_label":"Komposisi umum; kecocokan tanaman belum dinilai" if general else "Referensi produsen; izin dan label lengkap belum diverifikasi",
            "crop_specific":not general,
            "manufacturer_registration_number":product.get("manufacturer_registration_number"),
            "targets":[use.get("target_name", use["problem"]) for use in matches],
            "missing_evidence":product["missing_evidence"], "eligible":False})
    reasons = ["Rekomendasi aplikasi belum dibuka: status izin edar terkini dan label lengkap perlu diverifikasi untuk pasangan tanaman–sasaran ini."]
    if not crop:
        reasons.insert(0,"Tanaman ini belum tercakup dalam katalog Indonesia yang tersedia.")
    if context.get("fieldConfirmed") is not True:
        reasons.append("Dugaan penyebab dari foto perlu dikonfirmasi di lapangan bersama petugas.")
    if record.get("needs_review"):
        reasons.append("Hasil foto ini masih memerlukan pemeriksaan; skor AI tidak menentukan kelayakan penggunaan produk.")
    if not selected:
        reasons.insert(0,"Belum ada sasaran aktif yang dapat dipetakan dengan pasti dari catatan ini.")
    if "nutrition" in selected and not context.get("soilInformation"):
        reasons.append("Data tanah atau hasil pemeriksaan hara belum tersedia; kebutuhan pupuk tidak dapat dihitung dari foto.")
    return {"catalog_version":data["version"], "disclaimer_version":DISCLAIMER_VERSION,
        "disclaimer":DISCLAIMER, "crop":crop, "targets":selected, "target_labels":target_labels(selected), "references":references,
        "eligible_products":[], "reasons":reasons, "registration_source":data["registration_source"],
        "coverage_note":"Katalog awal bersumber dari produsen Indonesia; stok toko dan izin edar terkini belum dikonfirmasi."}
