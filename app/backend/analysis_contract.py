"""Pure protocol validation: malformed model replies must never replace an assessment."""
from __future__ import annotations

import math
from typing import Any

SCHEMA_VERSION = "assessment-2"
POLICY_VERSION = "inspection-only-1"
REPORT_FIELDS = ("findings", "possible_causes", "actions", "prevention", "nutrition", "monitoring", "escalation")


class AnalysisContractError(ValueError):
    """Provider returned a syntactically or semantically incomplete assessment."""


def _text(value: Any, field: str, limit: int) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise AnalysisContractError("invalid_" + field)
    return value.strip()


def validate_triage(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise AnalysisContractError("invalid_triage")
    if type(value.get("usable")) is not bool or type(value.get("is_plant")) is not bool:
        raise AnalysisContractError("invalid_triage_flags")
    _text(value.get("reason"), "triage_reason", 600)
    if value["usable"] and not value["is_plant"]:
        raise AnalysisContractError("contradictory_triage")
    return value


def validate_diagnosis(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise AnalysisContractError("invalid_diagnosis")
    _text(value.get("crop"), "crop", 200)
    _text(value.get("condition"), "condition", 200)
    _text(value.get("symptoms_id"), "symptoms", 1000)
    if value.get("severity") not in ("Healthy", "Moderate", "Severe"):
        raise AnalysisContractError("invalid_severity")
    confidence = value.get("confidence")
    if type(confidence) not in (int, float) or not math.isfinite(confidence) or not 0 <= confidence <= 1:
        raise AnalysisContractError("invalid_confidence")
    if type(value.get("needs_review")) is not bool:
        raise AnalysisContractError("invalid_review_flag")
    report = value.get("assessment")
    if not isinstance(report, dict) or type(report.get("version")) is not int or report["version"] != 1:
        raise AnalysisContractError("invalid_assessment_version")
    for field in REPORT_FIELDS + ("active_conditions",):
        items = report.get(field)
        maximum = 3 if field == "active_conditions" else 6
        if not isinstance(items, list) or len(items) > maximum:
            raise AnalysisContractError("invalid_" + field)
        for item in items:
            _text(item, field, 320)
    if not report["findings"] or not report["actions"] or not report["monitoring"]:
        raise AnalysisContractError("incomplete_assessment")
    if "inspection_checks" in report:
        from .advice_policy import INSPECTION_CHECKS
        checks = report["inspection_checks"]
        if (not isinstance(checks, list) or len(checks) > 6
                or any(not isinstance(item, str) or item not in INSPECTION_CHECKS for item in checks)):
            raise AnalysisContractError("invalid_inspection_checks")
    if "uncertain" in report and type(report["uncertain"]) is not bool:
        raise AnalysisContractError("invalid_uncertainty_flag")
    if value["severity"] == "Healthy" and report["active_conditions"]:
        raise AnalysisContractError("healthy_with_active_problem")
    if value["severity"] == "Healthy":
        from .problem_registry import problem_id
        if problem_id(value["condition"]):
            raise AnalysisContractError("healthy_with_named_problem")
    return value


def clean_provenance(value: Any) -> dict[str, Any]:
    """Allowlisted operational evidence; no response content, coordinates or credentials."""
    if not isinstance(value, dict):
        return {}
    result: dict[str, Any] = {}
    for key in ("schemaVersion", "policyVersion", "promptHash", "referenceHash", "inputHash"):
        item = value.get(key)
        if isinstance(item, str) and len(item) <= 128:
            result[key] = item
    for stage in ("triage", "diagnosis"):
        item = value.get(stage)
        if not isinstance(item, dict):
            continue
        clean = {}
        for key in ("requestedRoute", "resolvedModel", "finishReason"):
            val = item.get(key)
            if isinstance(val, str) and len(val) <= 160:
                clean[key] = val
        for key in ("inputTokens", "outputTokens", "latencyMs", "calls"):
            val = item.get(key)
            if type(val) is int and 0 <= val <= 100_000_000:
                clean[key] = val
        result[stage] = clean
    gate = value.get("gate")
    if isinstance(gate, dict):
        result["gate"] = {key: gate[key] for key in ("uncertain", "policyFiltered", "needsReview") if type(gate.get(key)) is bool}
    return result
