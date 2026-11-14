"""Text hygiene shared by the farmer API, the job queue and the confidence gate.

Pure functions, no I/O and no imports from the rest of the package, so every layer
(and the tests) can use them without creating import cycles.

Two jobs live here:

1. Making user- and model-supplied strings safe to store and to paste into a model
   prompt: control characters and invisible direction/zero-width characters removed,
   newlines collapsed when the text is prompt-bound, hard length caps.
2. Spotting pesticide / dosage language. The product policy is non-chemical: the app
   never shows model-authored treatment text, so any free-text field that talks about
   spraying a named product or a dose is replaced by the fixed isolate-and-consult text.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any

# Lone surrogates survive json.loads() ("\ud800") but make sqlite3 raise
# UnicodeEncodeError on bind, which used to surface as a 500.
_INVISIBLE_RE = re.compile(
    "[­​-‏‪-‮⁠-⁤⁦-⁩﻿]"
)
_LINE_BREAKS_RE = re.compile("[\t\n\r\x0b\x0c\x85  ]+")
_CONTROL_RE = re.compile("[\x00-\x1f\x7f-\x9f]")
_BLOCK_CONTROL_RE = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x84\x86-\x9f]")
_SPACES_RE = re.compile("[  ]{2,}")
_BLANK_LINES_RE = re.compile("\n{3,}")
_TRAILING_SPACE_RE = re.compile("[ \t ]+\n")


def _as_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        value = value.decode("utf-8", "replace")
    elif not isinstance(value, str):
        value = str(value)
    # Drop lone surrogates, then the invisible formatting characters.
    value = value.encode("utf-8", "ignore").decode("utf-8")
    return _INVISIBLE_RE.sub("", value)


def truncate(text: str, limit: int) -> str:
    """Hard cut. Input fields are TRUNCATED, never rejected, so old drafts still send."""
    return text if len(text) <= limit else text[:limit]


def one_line(value: Any, limit: int) -> str:
    """Single-line text for fields that end up in a prompt or a list row."""
    text = _LINE_BREAKS_RE.sub(" ", _as_text(value))
    text = _CONTROL_RE.sub("", text)
    text = _SPACES_RE.sub(" ", text).strip()
    return truncate(text, limit).rstrip()


def block(value: Any, limit: int) -> str:
    """Multi-line text (notes, symptoms): control characters out, line breaks normalised."""
    text = _as_text(value)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = text.replace(" ", "\n").replace(" ", "\n").replace("\x85", "\n")
    text = _BLOCK_CONTROL_RE.sub("", text)
    text = _TRAILING_SPACE_RE.sub("\n", text)
    text = _BLANK_LINES_RE.sub("\n\n", text)
    return truncate(text.strip(), limit).rstrip()


# ---------------------------------------------------------------------------
# Pesticide / dosage language
# ---------------------------------------------------------------------------

_CHEMICAL_TERMS = (
    # product classes (Indonesian and English)
    "pestisida", "pestisid", "fungisida", "fungsida", "insektisida", "bakterisida",
    "herbisida", "akarisida", "nematisida", "rodentisida", "moluskisida", "larvasida",
    "pesticide", "fungicide", "insecticide", "bactericide", "herbicide", "acaricide",
    "miticide", "nematicide", "molluscicide", "rodenticide", "larvicide",
    "racun hama", "racun serangga", "racun rumput", "racun tikus", "obat hama",
    "obat semprot", "obat kimia", "obat tanaman", "obat pertanian", "bahan aktif",
    "zat aktif", "active ingredient", "agrokimia", "agrochemical",
    # active ingredients, Indonesian and international spellings
    "mankozeb", "mancozeb", "maneb", "zineb", "propineb", "klorotalonil", "chlorothalonil",
    "karbendazim", "carbendazim", "benomil", "benomyl", "tiofanat", "thiophanate",
    "metalaksil", "metalaxyl", "mefenoksam", "mefenoxam", "simoksanil", "cymoxanil",
    "dimetomorf", "dimethomorph", "fosetil", "fosetyl", "iprodion", "azoksistrobin",
    "azoxystrobin", "piraklostrobin", "pyraclostrobin", "trifloksistrobin",
    "trifloxystrobin", "tebukonazol", "tebuconazole", "difenokonazol", "difenoconazole",
    "heksakonazol", "hexaconazole", "propikonazol", "propiconazole", "flutriafol",
    "captan", "folpet", "tembaga hidroksida", "kupri hidroksida", "copper hydroxide",
    "copper oxychloride", "tembaga oksiklorida", "copper sulfate", "tembaga sulfat",
    "bubur bordo", "bordeaux", "imidakloprid", "imidacloprid", "tiametoksam",
    "thiamethoxam", "asetamiprid", "acetamiprid", "klotianidin", "clothianidin",
    "dinotefuran", "abamektin", "abamectin", "emamektin", "emamectin", "spinosad",
    "spinetoram", "klorpirifos", "chlorpyrifos", "profenofos", "dimetoat", "dimethoate",
    "malation", "malathion", "diazinon", "sipermetrin", "cypermethrin", "deltametrin",
    "deltamethrin", "permetrin", "permethrin", "sihalotrin", "cyhalothrin", "bifentrin",
    "bifenthrin", "fipronil", "indoksakarb", "indoxacarb", "klorantraniliprol",
    "chlorantraniliprole", "fenvalerat", "fenvalerate", "karbofuran", "carbofuran",
    "karbosulfan", "carbosulfan", "metomil", "methomyl", "buprofezin", "piridaben",
    "pyridaben", "amitraz", "propargit", "propargite", "glifosat", "glyphosate",
    "parakuat", "paraquat", "atrazin", "atrazine", "diuron", "metsulfuron", "glufosinat",
    "glufosinate", "bromadiolon", "brodifakum", "brodifacoum", "fosfin", "phosphine",
    "metaldehid", "metaldehyde",
    # widely sold brand names (distinctive ones only)
    "dithane", "antracol", "curzate", "ridomil", "previcur", "amistartop", "curacron",
    "furadan", "confidor", "gramoxone", "roundup", "round up", "sidamethrin", "dursban",
    "lannate", "agrimec",
    # dosage language
    "dosis", "takaran", "dosage",
    # short tokens that need word boundaries
    "bpmc", "2,4-d",
)

_UNITS = (r"ml|cc|l|lt|ltr|liter|litre|g|gr|gram|kg|mg|sdm|sdt|sendok(?:\s+makan|\s+teh)?|"
          r"tutup(?:\s+botol)?|botol|kapsul|tablet")
_PER = r"(?:/|per\b|tiap\b|setiap\b|ke\s+dalam\b|dalam\b|untuk\b|pada\b|di\b|ke\b)"
_VOLUMES = (r"l|lt|ltr|liter|litre|ha|hektar|hektare|tangki|ember|gelas|botol|m2|m²|are|"
            r"pohon|tanaman|air|knapsack")

_DOSAGE_RE = re.compile(
    rf"\d+(?:[.,]\d+)?\s*(?:{_UNITS})\s*{_PER}\s*\d*(?:[.,]\d+)?\s*(?:{_VOLUMES})\b"
)
_CONCENTRATION_RE = re.compile(
    r"\d+(?:[.,]\d+)?\s*(?:ppm|%\s*(?:b/v|v/v|w/v)|\s?(?:ec|wp|sc|sl|wg|wdg)\b)"
)


def _term_pattern(term: str) -> str:
    escaped = re.escape(term).replace(r"\ ", r"\s+")
    # Distinctive long names match as substrings (so "fungisidanya" is caught);
    # short tokens need word boundaries to avoid accidental hits.
    if len(term) >= 5 and term not in ("2,4-d", "bpmc"):
        return escaped
    return rf"(?<![a-z0-9]){escaped}(?![a-z0-9])"


_CHEMICAL_RE = re.compile("|".join(_term_pattern(term) for term in _CHEMICAL_TERMS))


def _normalised(text: str) -> str:
    text = unicodedata.normalize("NFKC", _as_text(text)).casefold()
    return re.sub(r"\s+", " ", text)


def contains_chemical_advice(text: Any) -> bool:
    """True when `text` names a pesticide class/product or gives a dose."""
    if not isinstance(text, str) or not text:
        return False
    normalised = _normalised(text)
    return bool(_CHEMICAL_RE.search(normalised) or _DOSAGE_RE.search(normalised)
                or _CONCENTRATION_RE.search(normalised))
