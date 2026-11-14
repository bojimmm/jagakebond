"""Observation guidance policy. Unreviewed generated treatment is never an approved action."""
import re
from . import textsafe

NUTRIENTS = re.compile(r"\b(?:pupuk|fertili[sz]\w*|nitrogen|fosfor|fosfat|phosph\w*|kalium|potassium|kalsium|calcium|magnesium|belerang|sulfur|sulphur|besi|iron|mangan|manganese|boron|seng|zink|zinc|tembaga|copper|molibdenum|molybdenum)\b", re.I)
APPLICATION = re.compile(r"\b(?:beri\w*|pemberian|tambah\w*|penambahan|guna\w*|penggunaan|aplik\w*|tabur\w*|penaburan|campur\w*|pencampuran|oles\w*|tuang\w*|larut\w*|semprot\w*|spray\w*|apply|add|feed|dose|mix|use|supplement)\b", re.I)
INTERVENTION = re.compile(r"\b(?:siram\w*|pangkas\w*|potong\w*|buang\w*|cabut\w*|bakar\w*|tebang\w*|musnah\w*|rendam\w*|fumiga\w*|sterili\w*|basmi\w*|babat\w*|semprot\w*|tabur\w*|oles\w*|tuang\w*|mix|spray|drench|burn|destroy|eradicate)\b", re.I)
OBSERVATION_START = re.compile(r"^(?:periksa|amati|bandingkan|catat|foto|ambil foto|dokumentasikan|tandai|pantau|minta (?:bantuan|pemeriksaan|penilaian)|hubungi|konsultasikan|lengkapi|cocokkan|simpan|ukur|pastikan)\b", re.I)


def prohibited(text: str) -> bool:
    return bool(textsafe.contains_chemical_advice(text) or INTERVENTION.search(text)
                or (NUTRIENTS.search(text) and APPLICATION.search(text)))


def inspection_only(text: str) -> bool:
    return bool(OBSERVATION_START.search(text)) and not prohibited(text)


INSPECTION_CHECKS = {
    "whole_plant": "Ambil foto seluruh tanaman dan bagian yang berubah, tanpa mengubah kondisi tanaman terlebih dahulu.",
    "leaf_surfaces": "Periksa permukaan atas dan bawah daun yang berubah; foto bagian yang terlihat berbeda dari daun di sekitarnya.",
    "leaf_age_pattern": "Bandingkan daun muda dan daun tua pada tanaman yang sama; catat bagian mana yang lebih dahulu berubah.",
    "stem_base": "Amati batang dan pangkal tanaman yang terlihat; dokumentasikan bagian yang berubah tanpa melukai tanaman.",
    "fruit": "Foto dekat buah yang bergejala dan buah pembanding yang tampak normal pada tanaman yang sama.",
    "affected_extent": "Catat jumlah tanaman dengan gejala serupa dan letaknya; jumlah foto belum membuktikan penyebaran penyakit.",
    "comparable_photo": "Foto kembali bagian yang sama dengan sudut dan cahaya yang sebanding untuk memperbarui catatan.",
    "field_review": "Hubungi penyuluh untuk pemeriksaan langsung bila gejala meluas, tanaman cepat layu, atau penyebab belum jelas.",
    "sucking_pest_trace": "Periksa pucuk dan bagian bawah daun untuk serangga kecil atau cairan lengket; ambil foto dekat bila ditemukan.",
    "borer_trace": "Amati bagian luar batang untuk lubang atau serbuk; foto bagian tersebut tanpa membelah batang atau mencabut tanaman.",
    "chewing_trace": "Periksa tepi dan lubang daun serta bagian bawahnya; foto ulat atau bekas kotoran bila terlihat.",
    "fruit_lesion_pattern": "Foto dekat batas bercak pada buah dan buah pembanding yang tampak normal; catat apakah bercaknya berubah pada foto berikutnya.",
    "leaf_lesion_pattern": "Foto dekat batas bercak dan bagian daun yang masih hijau, lalu bandingkan dengan daun lain pada tanaman yang sama.",
}


def inspection_plan(raw: dict, *, uncertain: bool = False) -> list[str]:
    """Only approved inspection tasks reach the action list; model prose cannot add treatment."""
    ids = raw.get("inspection_checks")
    chosen = [key for key in ids if isinstance(key,str) and key in INSPECTION_CHECKS] if isinstance(ids,list) else []
    from .problem_registry import active_problem_ids
    problems = set(active_problem_ids({"severity":"Moderate", "assessment":raw}))
    targeted = []
    if problems & {"aphids","mites","thrips","planthopper"}:
        targeted.append("sucking_pest_trace")
    if "borer" in problems:
        targeted.append("borer_trace")
    if "caterpillar" in problems:
        targeted.append("chewing_trace")
    evidence = " ".join(str(x) for x in raw.get("findings",[]) if isinstance(x,str)).casefold()
    if problems & {"anthracnose","fruit_rot"} and "buah" in evidence:
        targeted.append("fruit_lesion_pattern")
    elif problems & {"leaf_spot","sigatoka","blast","early_blight","late_blight","leaf_blight","rust"}:
        targeted.append("leaf_lesion_pattern")
    chosen = list(dict.fromkeys(targeted + chosen))
    if not chosen:
        if "daun" in evidence:
            chosen.extend(["leaf_surfaces","leaf_age_pattern"])
        if "buah" in evidence:
            chosen.append("fruit")
        if "batang" in evidence or "pangkal" in evidence:
            chosen.append("stem_base")
    if uncertain:
        chosen = ["whole_plant","comparable_photo","field_review"]
    return [INSPECTION_CHECKS[key] for key in dict.fromkeys(chosen + ["affected_extent","comparable_photo"])][:4]
