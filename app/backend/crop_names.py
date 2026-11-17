"""Stable display names for known equivalent crop labels; unknown names are preserved."""
import re

CANONICAL_KETAPANG = "Ketapang"
ALIASES = {"ketapang", "sea almond", "tropical almond", "indian almond", "terminalia catappa"}
_ENGLISH_SUFFIX_RE = re.compile(r"\s*\([^()]+\)\s*$")


def canonical_crop_name(value):
    if not isinstance(value, str):
        return value
    cleaned = re.sub(r"\s+", " ", value).strip()
    if not cleaned:
        return cleaned
    key = cleaned.casefold()
    parts = re.fullmatch(r"([^()]+)\s*\(([^()]+)\)", key)
    if key in ALIASES or (parts and (parts[1].strip() in ALIASES or parts[2].strip() in ALIASES)):
        return CANONICAL_KETAPANG
    stripped = _ENGLISH_SUFFIX_RE.sub("", cleaned).strip()
    if stripped and stripped.casefold() in ALIASES:
        return CANONICAL_KETAPANG
    return stripped or cleaned
