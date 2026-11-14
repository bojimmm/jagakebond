"""Offline unit test for the PRD section 6 confidence gate.

No AI model, no network, no server:  python tests/test_confidence_gate.py

The gate is the safety boundary that stops a raw model severity from reaching the
farmer, so it is tested directly against the PRD's stated behaviours.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.app import (  # noqa: E402
    GATE_ISOLATE_TEXT,
    GATE_REPHOTO_TEXT,
    _apply_confidence_gate,
)

CASES: list[tuple[str, bool, str]] = []


def case(name: str, ok: bool, detail: str = "") -> None:
    CASES.append((name, bool(ok), detail))


def gate(**kwargs):
    return _apply_confidence_gate(kwargs)


# --- severity normalisation -------------------------------------------------
result = gate(severity="SEVERE", confidence=0.9)
case("unknown casing 'SEVERE' normalises to Moderate",
     result["severity"] == "Moderate", result["severity"])
result = gate(severity="Parah", confidence=0.9)
case("unknown severity word -> Moderate", result["severity"] == "Moderate", result["severity"])
result = gate(severity=None, confidence=0.9)
case("missing severity -> Moderate", result["severity"] == "Moderate", result["severity"])
result = gate(severity="Healthy", confidence=0.95)
case("Healthy @0.95 stays Healthy", result["severity"] == "Healthy", result["severity"])

# --- BUILD-INSTRUCTIONS 4.6 required cases ----------------------------------
result = gate(severity="Severe", confidence=0.4)
case("Severe @0.4 keeps urgency + needs_review",
     result["severity"] == "Severe" and result["needs_review"] is True,
     f"{result['severity']}/{result['needs_review']}")

result = gate(severity="Severe", confidence=0.6)
case("Severe @0.6 keeps urgency + needs_review",
     result["severity"] == "Severe" and result["needs_review"] is True,
     f"{result['severity']}/{result['needs_review']}")

result = gate(severity="Healthy", confidence=0.3)
case("Healthy @0.3 stays Healthy + needs_review",
     result["severity"] == "Healthy" and result["needs_review"] is True,
     f"{result['severity']}/{result['needs_review']}")

result = gate(severity="Moderate", confidence=0.65,
              immediate_action="Semprot fungisida berbahan aktif mankozeb.")
case("pesticide text @0.65 is stripped",
     "fungisida" not in result["immediate_action"].lower(), result["immediate_action"])
case("all confidence levels use fixed safe referral text",
     result["immediate_action"] == GATE_REPHOTO_TEXT, result["immediate_action"])
case("stripped text is the isolate-and-monitor text",
     result["immediate_action"] == GATE_ISOLATE_TEXT)

result = gate(severity="Moderate", confidence=1.5)
case("confidence >1 clamps to 1.0", result["confidence"] == 1.0, result["confidence"])
result = gate(severity="Moderate", confidence=-0.5)
case("negative confidence clamps to 0.0", result["confidence"] == 0.0, result["confidence"])
result = gate(severity="Moderate", confidence=0.123456)
case("confidence rounds to 3dp", result["confidence"] == 0.123, result["confidence"])
result = gate(severity="Moderate", confidence="0.6")
case("string confidence is coerced", result["confidence"] == 0.6, result["confidence"])
result = gate(severity="Moderate", confidence="not-a-number")
case("junk confidence -> 0.0 + needs_review + review text",
     result["confidence"] == 0.0 and result["needs_review"] is True
     and result["immediate_action"] == GATE_REPHOTO_TEXT, result["immediate_action"][:40])
result = gate(severity="Moderate")
case("missing confidence -> 0.0 (fails safe)", result["confidence"] == 0.0, result["confidence"])

# --- PRD section 6 exact wording --------------------------------------------
result = gate(severity="Severe", confidence=0.5)
case("Severe @0.5 (boundary) keeps Severe + needs_review",
     result["severity"] == "Severe" and result["needs_review"] is True, result["severity"])
result = gate(severity="Severe", confidence=0.699)
case("Severe @0.699 keeps Severe + needs_review", result["severity"] == "Severe", result["severity"])
result = gate(severity="Severe", confidence=0.7)
case("Severe @0.7 is trusted (stays Severe, no forced review)",
     result["severity"] == "Severe" and result["needs_review"] is False,
     f"{result['severity']}/{result['needs_review']}")
result = gate(severity="Severe", confidence=0.499)
case("Severe @0.499 keeps Severe + needs_review", result["severity"] == "Severe", result["severity"])

result = gate(severity="Moderate", confidence=0.4)
case("low-confidence Moderate keeps Moderate but forces review",
     result["severity"] == "Moderate" and result["needs_review"] is True, result["severity"])

# --- empty-action defaulting -----------------------------------------------
result = gate(severity="Severe", confidence=0.2, immediate_action="   ")
case("low confidence + blank action -> re-photo/consult default",
     result["immediate_action"] == GATE_REPHOTO_TEXT, result["immediate_action"][:40])
result = gate(severity="Severe", confidence=0.2, immediate_action="Pangkas daun terinfeksi.")
case("model-authored nonchemical action is replaced",
     result["immediate_action"] == GATE_REPHOTO_TEXT, result["immediate_action"])

# --- pesticide matching while consulted, or at high confidence --------------
result = gate(severity="Moderate", confidence=0.65,
              immediate_action="Aplikasikan fungisida setelah konsultasi dengan POPT.")
case("pesticide @0.65 WITH consultation is replaced",
     result["immediate_action"] == GATE_REPHOTO_TEXT, result["immediate_action"][:60])
result = gate(severity="Moderate", confidence=0.85,
              immediate_action="Aplikasikan fungisida berbahan aktif mankozeb.")
case("pesticide @0.85 is replaced",
     result["immediate_action"] == GATE_REPHOTO_TEXT, result["immediate_action"][:60])
for word in ("insektisida", "bakterisida", "pestisida"):
    result = gate(severity="Moderate", confidence=0.6,
                  immediate_action=f"Gunakan {word} dosis tinggi.")
    case(f"{word} @0.6 is stripped", word not in result["immediate_action"].lower(),
         result["immediate_action"][:40])

# --- immediate_action_id (what the diagnose model actually emits) -----------
result = gate(severity="Severe", confidence=0.6,
              immediate_action_id="Semprot fungisida sistemik.")
case("model key immediate_action_id is gated too",
     "fungisida" not in result["immediate_action"].lower()
     and "fungisida" not in str(result.get("immediate_action_id", "")).lower(),
     result["immediate_action"][:40])
case("gated text is mirrored onto immediate_action_id",
     result.get("immediate_action_id") == result["immediate_action"])
result = gate(severity="Severe", confidence=0.2, immediate_action_id="")
case("blank immediate_action_id gets the default text",
     result["immediate_action"] == GATE_REPHOTO_TEXT
     and result["immediate_action_id"] == GATE_REPHOTO_TEXT, result["immediate_action"][:40])

# --- non-finite and boolean confidence must not grant trust ------------------
# Regression: float("nan") and float("inf") parse successfully and min(1.0, nan)
# returns 1.0, so a confidence that was not a real number used to land on 1.0 —
# maximum trust — and skipped the downgrade, the needs_review flag and the
# pesticide strip completely. A router or fast fallback model emitting "nan"
# would have defeated the entire safety boundary.
for bogus in ("nan", "NaN", float("nan"), "inf", "-inf", float("inf"),
              True, False, None, [], {}, "0.5.5"):
    result = gate(severity="Severe", confidence=bogus,
                  immediate_action="Semprot fungisida berbahan aktif mankozeb.")
    case(f"confidence {bogus!r} means zero trust, not maximum",
         result["confidence"] == 0.0 and result["severity"] == "Severe"
         and result["needs_review"] is True,
         f"conf={result['confidence']} sev={result['severity']} review={result['needs_review']}")
    case(f"confidence {bogus!r} still strips the pesticide name",
         "mankozeb" not in result["immediate_action"].lower()
         and "fungisida" not in result["immediate_action"].lower(),
         result["immediate_action"][:60])

result = gate(severity="Severe", confidence="0.65")
case("a numeric string confidence is still honoured",
     result["confidence"] == 0.65 and result["severity"] == "Severe",
     f"{result['confidence']}/{result['severity']}")
result = gate(severity="Severe", confidence=0.8)
case("a high real confidence still lets Severe through",
     result["severity"] == "Severe" and result["needs_review"] is False,
     f"{result['severity']}/{result['needs_review']}")

# --- robustness -------------------------------------------------------------
case("None diagnosis does not crash",
     _apply_confidence_gate(None)["severity"] == "Moderate")
case("non-dict diagnosis does not crash",
     _apply_confidence_gate("garbage")["severity"] == "Moderate")
result = gate(severity="Severe", confidence=0.9, immediate_action=None)
case("None action becomes fixed safe text", result["immediate_action"] == GATE_REPHOTO_TEXT,
     repr(result["immediate_action"]))
original = {"severity": "Severe", "confidence": 0.9, "immediate_action": "Pangkas."}
gated = _apply_confidence_gate(original)
case("gate does not mutate its input", original == {"severity": "Severe", "confidence": 0.9,
                                                    "immediate_action": "Pangkas."}, original)
case("gate returns a normalised copy", gated["severity"] == "Severe")
result = gate(severity="Moderate", confidence=0.8, needs_review=True)
case("existing needs_review=True is preserved", result["needs_review"] is True)
result = gate(severity="Moderate", confidence=0.8)
case("needs_review defaults to False when trusted", result["needs_review"] is False)

passed = sum(1 for _, ok, _ in CASES if ok)
total = len(CASES)
print(f"confidence gate: {passed}/{total} assertions passed")
for name, ok, detail in CASES:
    if not ok:
        print("  FAILED:", name, "::", detail)
sys.exit(0 if passed == total else 1)
