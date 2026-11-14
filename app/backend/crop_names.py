"""Stable display names for known equivalent crop labels; unknown names are preserved."""
import re

CANONICAL_KETAPANG = "Ketapang (Tropical Almond)"
ALIASES = {"ketapang", "sea almond", "tropical almond", "indian almond", "terminalia catappa"}

def canonical_crop_name(value):
    if not isinstance(value, str):
        return value
    key = re.sub(r"\s+", " ", value.strip()).casefold()
    parts = re.fullmatch(r"([^()]+)\s*\(([^()]+)\)", key)
    if key in ALIASES or (parts and parts[1].strip() in ALIASES and parts[2].strip() in ALIASES):
        return CANONICAL_KETAPANG
    return value
