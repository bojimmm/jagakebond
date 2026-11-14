"""0.2.4.16 contracts: direct re-analysis from Lainnya and the Android bridge route.

Synthetic source/static checks only; no farmer data.
"""
from __future__ import annotations

from pathlib import Path
import re

APP = Path(__file__).resolve().parent.parent
CHECKS = 0


def check(label: str, condition: bool) -> None:
    global CHECKS
    CHECKS += 1
    if not condition:
        raise AssertionError(label)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


adapter = read(APP / "frontend/native-adapter.js")
mirror_adapter_path = APP.parent / "android-client/www/native-adapter.js"
mirror_adapter = read(mirror_adapter_path) if mirror_adapter_path.is_file() else None
java = read(APP.parent / "android-client/android/app/src/main/java/jagake/bond/app/JagaSyncPlugin.java")
ui = read(APP / "frontend/assessment-ui.js")
compact_ui = re.sub(r"\s+", "", ui)
mirror_ui_path = APP.parent / "android-client/www/assessment-ui.js"
mirror_ui = read(mirror_ui_path) if mirror_ui_path.is_file() else None
app_js = read(APP / "frontend/app.js")
css = read(APP / "frontend/assessment.css")

route_pattern = r"records(?:\/[^/?#]+(?:\/reanalyze)?)?"
check("native adapter allowlist accepts /records/{id}/reanalyze", route_pattern in adapter)
if mirror_adapter is not None:
    check("Android mirror carries the same allowlist fix", route_pattern in mirror_adapter)
check("Java bridge policy still permits only POST /records/{id}/reanalyze",
      'p.matches("/api/records/[A-Za-z0-9_-]{1,128}/reanalyze")) return method.equals("POST") && query == null;' in java)
check("Lainnya starts re-analysis directly", "act('JagaAssessment.reanalyze', rid, '$this')" in app_js)
check("direct re-analysis does not open the assessment dialog",
      "functionstartReanalysis(id,trigger)" in compact_ui and "reanalyze:startReanalysis" in compact_ui
      and "openAssessment(id,{start:true})" not in compact_ui)
check("analysis dialog has no re-analysis control",
      "assessment-reanalyze" not in ui and "assessment-reanalyze" not in css)
if mirror_ui is not None:
    check("Android mirror matches the direct re-analysis UI", mirror_ui == ui)
check("release is 0.2.4.28", '"0.2.4.28"' in read(APP / "backend/version.py"))
print(f"reanalyze-0246: {CHECKS} direct-flow/bridge assertions passed")
