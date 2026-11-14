"""0.2.4.16 contracts: the Cepat lane leaves the normal queue, plus the small UI fixes.

Isolated SQLite, synthetic rows only. Run from app/:  python tests/test_fastlane_0245.py

Covers:
  * claim lanes: fast/jump priority, normal-only and fast-only consumers, malformed
    legacy context JSON treated as normal;
  * one short name for downy mildew ("Bulai", never "Buli Downy");
  * the "Analisis ulang" entry in the Riwayat "Lainnya" menu;
  * one Analyse button whose lane the server chooses, and the same progress meter
    during a re-analysis as during a new photo;
  * the single current-location tool on the manual-location map, and the removed
    duplicate "Tanaman / petunjuk AI" field.
"""
from __future__ import annotations

import os
import sys
import tempfile
import re
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))
from backend import db, queue  # noqa: E402

CHECKS = 0


def check(label: str, condition: bool) -> None:
    global CHECKS
    CHECKS += 1
    if not condition:
        raise AssertionError(label)


def add_job(job_id: str, created: int, context: str, status: str = "queued") -> None:
    with db.transaction() as tx:
        tx.execute(
            "INSERT INTO jobs (id, account_id, status, created_ms, updated_ms, image_b64, context_json) "
            "VALUES (?,?,?,?,?,?,?)",
            (job_id, "a", status, created, created, "img", context),
        )


with tempfile.TemporaryDirectory(prefix="jk-fastlane-") as folder:
    db.close_all()
    db.DB_PATH = Path(folder) / "lane.sqlite3"
    db.migrate()

    with db.transaction() as tx:
        tx.execute("INSERT INTO accounts(id,email,password_hash,role,created_ms,updated_ms)"
                   " VALUES('a','a@example.invalid','hash','user',1,1)")

    add_job("n1", 1_000, db.to_json({"analysisTier": "normal"}))
    add_job("n2", 2_000, db.to_json({}))
    add_job("f1", 3_000, db.to_json({"analysisTier": "fast"}))
    add_job("bad", 4_000, "{malformed")

    row, _ = queue.claim_next("w", 300, "normal")
    check("normal lane takes the oldest normal job", row and row["id"] == "n1")

    row, _ = queue.claim_next("w", 300, "fast")
    check("fast lane takes only the fast job", row and row["id"] == "f1")
    check("fast claim marks the job claimed", row["status"] == "claimed")
    check("fast lane is empty once its job is claimed",
          queue.claim_next("w", 300, "fast")[0] is None)

    row, _ = queue.claim_next("w", 300, "all")
    check("all lane falls through to the normal queue", row and row["id"] == "n2")
    row, _ = queue.claim_next("w", 300)
    check("default lane is 'all' and treats malformed legacy JSON as normal",
          row and row["id"] == "bad")

    add_job("n3", 10, db.to_json({"analysisTier": "normal"}))
    add_job("f2", 20, db.to_json({"analysisTier": "fast"}))
    row, _ = queue.claim_next("w", 300)
    check("fast jumps ahead of an older normal job on the single consumer",
          row and row["id"] == "f2")

    row, _ = queue.claim_next("w", 300, "not-a-lane")
    check("an unknown lane falls back to 'all'", row and row["id"] == "n3")
    check("claim lanes are declared", queue.CLAIM_LANES == ("all", "fast", "normal"))
    db.close_all()  # Windows cannot delete an open SQLite file

FRONT = BASE / "frontend"


def read(name: str) -> str:
    return (FRONT / name).read_text(encoding="utf-8")


assessment = read("assessment-ui.js")
compact_assessment = re.sub(r"\s+", "", assessment).replace(chr(34), chr(39))
app_js = read("app.js")
workflow = read("workflow-ui.js")
styles = read("styles.css")
index = read("index.html")
scan = read("scan-flow.js")

check("downy mildew has one short Indonesian label",
      "['Bulai',/\\bbulai\\b|\\bbuli\\b|\\bbule\\b|downy\\s*mildew|embun\\s*bulu/i]" in compact_assessment)
check("downy mildew is a chemical-reference target",
      '"id":"downy_mildew","label":"Bulai"' in read("problem-registry.js"))
check("re-analysis starts directly from the record action",
      "reanalyze:startReanalysis" in compact_assessment
      and "functionstartReanalysis(id,trigger)" in compact_assessment
      and "canReanalyze:reanalyzable" in compact_assessment)
check("the analysis dialog no longer owns a re-analysis control",
      "assessment-reanalyze" not in assessment and "assessment-reanalyze" not in styles)
check("Riwayat 'Lainnya' offers Analisis ulang", "reanalyze + onMap" in app_js
      and "act('JagaAssessment.reanalyze'" in app_js)
check("the manual-location map keeps only the current-location control",
      "addLocationLocateControl" in workflow and "centerLocationMapOnMe" in workflow
      and ".location-locate-btn" in styles and "Ke lokasi saya" in workflow
      and "addLocationRecenterControl" not in workflow and "recenterLocationMap" not in workflow
      and ".location-recenter-btn" not in styles)
check("one Analyse button; the server picks the lane",
      index.count('id="btn-run-analysis"') == 1 and 'id="btn-run-fast"' not in index
      and 'data-act="executeCropPathologyAnalysis"' in index
      and "executeCropPathologyAnalysis(tier" not in scan)
check("the scan action no longer sends a tier field",
      "analysisTier" not in scan and "tier" not in scan.split("function buildCaptureFields")[1][:900])
check("re-analysis shows the same progress meter as a new photo",
      'id="reanalysis-dialog"' in index and 'class="reanalysis-meter"' in index
      and index.count('data-reanalysis-step=') == 4 and "function prepareReanalysisDialog" in assessment
      and "function setReanalysisProgress" in assessment and "updateReanalysisProgress(job)" in assessment)
check("a finished re-analysis updates the original record in place",
      "acknowledgeJob(jobId)" in assessment and "Analisis ulang selesai. Hasil sudah masuk ke catatan asli." in assessment)
check("launch recovery never saves a second crop for a re-analysis job",
      "job.context.reanalysisRecordId" in workflow and "/ack" in workflow
      and "sudah diterapkan ke catatan aslinya" in workflow)
check("the duplicate crop field is gone from the location dialog",
      "location-crop" not in workflow)
sw = read("sw.js")
check("asset cache keys advanced", "jk-v68" in sw
      and "assessment-ui.js?v=16" in index and "assessment.css?v=13" in index and "styles.css?v=45" in index)
check("service-worker install list matches the page versions",
      "/app.js?v=51" in sw and "/styles.css?v=45" in sw
      and "/workflow-ui.js?v=16" in sw and "/assessment-ui.js?v=16" in sw and "/assessment.css?v=13" in sw)

worker_src = (BASE / "worker/gemini_worker.py").read_text(encoding="utf-8")
check("normal mode uses the admin-console normal aliases",
      'return "normal", CONFIG["triageModel"], CONFIG["diagnoseModel"]' in worker_src)
check("Cepat uses the admin-console fast aliases",
      'return "fast", CONFIG["triageModelFast"], CONFIG["diagnoseModelFast"]' in worker_src)
worker_normal = (BASE / "deploy/jagakebond-worker.service").read_text(encoding="utf-8")
worker_fast = (BASE / "deploy/jagakebond-worker-fast.service").read_text(encoding="utf-8")
check("main worker unit selects the normal lane", "Environment=WORKER_LANE=normal" in worker_normal)
check("fast worker unit selects the fast lane", "Environment=WORKER_LANE=fast" in worker_fast)
check("fast worker unit has a distinct worker name", "Environment=WORKER_NAME=jagakebond-worker-fast" in worker_fast)
check("fast worker unit keeps service hardening", "NoNewPrivileges=true" in worker_fast
      and "ProtectSystem=strict" in worker_fast and "MemoryMax=300M" in worker_fast)

print(f"fast lane 0245: {CHECKS} assertions passed")
