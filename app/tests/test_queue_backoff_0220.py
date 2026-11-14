"""0.2.2.0 queue fairness: release backoff, give-up, auth releases, worker status, maintenance,
farmer-facing stage labels. Isolated SQLite, synthetic rows only.

Audit findings: H1 (a photo the provider always fails on blocked the queue forever),
H2 (router auth failure burned the queue), M12 (raw trace detail reached farmers).
Run from app/:  python tests/test_queue_backoff_0220.py
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))
from backend import api_app, db, queue  # noqa: E402

CHECKS = 0


def check(label: str, condition: bool) -> None:
    global CHECKS
    CHECKS += 1
    if not condition:
        raise AssertionError(label)


def add_job(job_id: str, created: int, status: str = "queued", account: str = "a", **cols) -> None:
    values = {"id": job_id, "account_id": account, "status": status, "created_ms": created,
              "updated_ms": created, "image_b64": "img", "context_json": "{}", **cols}
    with db.transaction() as tx:
        tx.execute(f"INSERT INTO jobs ({','.join(values)}) VALUES ({','.join('?' * len(values))})",
                   tuple(values.values()))


def job(job_id: str) -> dict:
    return db.query_one("SELECT * FROM jobs WHERE id = ?", (job_id,))


def make_due(job_id: str) -> None:
    with db.transaction() as tx:
        tx.execute("UPDATE jobs SET not_before_ms = 0 WHERE id = ?", (job_id,))


with tempfile.TemporaryDirectory(prefix="jk-backoff-", dir=os.environ.get("TMPDIR")) as folder:
    db.close_all()
    db.DB_PATH = Path(folder) / "queue.sqlite3"
    db.migrate()
    now = db.now_ms()
    with db.transaction() as tx:
        for ident, role in (("a", "user"), ("b", "user"), ("adm", "admin")):
            tx.execute("INSERT INTO accounts(id,email,password_hash,role,created_ms,updated_ms) VALUES(?,?,?,?,?,?)",
                       (ident, f"{ident}@t.invalid", "x", role, now, now))

    # --- schema 9 columns exist with the right defaults --------------------------------
    cols = {r["name"] for r in db.query("PRAGMA table_info(jobs)")}
    check("schema 9 job columns", {"release_count", "not_before_ms", "first_claimed_ms"} <= cols)

    # --- claim sets first_claimed_ms once; a released job goes BEHIND the queue ---------
    add_job("poison", now - 2000)
    add_job("good", now - 1000)
    claimed, _ = queue.claim_next("w", 300)
    check("oldest job is claimed first", claimed["id"] == "poison" and claimed["attempts"] == 1)
    first_claim = job("poison")["first_claimed_ms"]
    check("first_claimed_ms set on first claim", first_claim is not None and abs(first_claim - db.now_ms()) < 5000)
    out = queue.release_job("poison", "router returned HTTP 503", claim_token=(job("poison") or {}).get("claim_token"))
    row = job("poison")
    check("release returns it to the queue", out["released"] and row["status"] == "queued" and out["status"] == "queued")
    check("release refunds the attempt", row["attempts"] == 0)
    check("release counts and delays 1 minute",
          row["release_count"] == 1 and 55_000 <= row["not_before_ms"] - db.now_ms() <= 61_000)
    check("release recorded in the trace", queue.latest_event("poison")["stage"] == "worker:release")
    nxt, _ = queue.claim_next("w", 300)
    check("a delayed job no longer blocks the head of the queue", nxt["id"] == "good")
    check("nothing else is due: the delayed job is skipped", queue.claim_next("w", 300)[0] is None)
    queue.release_job("good", "x", claim_token=(job("good") or {}).get("claim_token"))  # keep the queue tidy
    with db.transaction() as tx:
        tx.execute("UPDATE jobs SET status='cancelled' WHERE id='good'")
    make_due("poison")
    again, _ = queue.claim_next("w", 300)
    check("once due it is claimed again, first_claimed_ms unchanged",
          again["id"] == "poison" and job("poison")["first_claimed_ms"] == first_claim)

    # --- backoff sequence 1,2,4,8,16,30,30,30,30 minutes, give up at the 10th release ---
    add_job("seq", now - 500)
    expected_minutes = [1, 2, 4, 8, 16, 30, 30, 30, 30]
    with db.transaction() as tx:
        tx.execute("UPDATE jobs SET status='cancelled' WHERE id='poison'")
    for number, minutes in enumerate(expected_minutes, start=1):
        make_due("seq")
        got, _ = queue.claim_next("w", 300)
        check(f"release {number}: job claimable", got is not None and got["id"] == "seq")
        out = queue.release_job("seq", "HTTP 429", claim_token=(job("seq") or {}).get("claim_token"))
        wait_min = (out["notBeforeMs"] - db.now_ms()) / 60_000
        check(f"release {number}: waits {minutes} min", abs(wait_min - minutes) < 0.2 and not out["givenUp"])
    make_due("seq")
    queue.claim_next("w", 300)
    out = queue.release_job("seq", "HTTP 500", claim_token=(job("seq") or {}).get("claim_token"))
    row = job("seq")
    check("10th release gives the job up", out["givenUp"] and row["status"] == "rejected")
    check("farmer message blames the server, not the photo",
          row["error"] == queue.PROVIDER_GIVE_UP_REASON == "Server analisis sedang bermasalah. Foto Anda aman — kirim ulang nanti dari Riwayat."
          and "ambil foto ulang" not in row["error"])
    triage = db.from_json(row["triage_json"], {})
    check("give-up triage carries a machine code", triage.get("code") == "provider_unavailable" and triage["usable"] is False)
    check("give-up stays collectable (not acked)", row["acked"] == 0)
    check("give-up traced", queue.latest_event("seq")["stage"] == "worker:giveup")
    polled = api_app.analyze_status("seq", None, account={"id": "a", "role": "user"})
    check("phone sees a rejected job with the message", polled["status"] == "rejected" and polled["error"] == queue.PROVIDER_GIVE_UP_REASON)

    # --- 3 hours since the first claim also gives up ------------------------------------
    add_job("slow", now - 400)
    queue.claim_next("w", 300)
    with db.transaction() as tx:
        tx.execute("UPDATE jobs SET first_claimed_ms = ? WHERE id='slow'", (db.now_ms() - queue.GIVE_UP_AFTER_MS - 1000,))
    out = queue.release_job("slow", "HTTP 502", claim_token=(job("slow") or {}).get("claim_token"))
    check("3 h since first claim gives up", out["givenUp"] and job("slow")["status"] == "rejected")

    # --- router auth/config release: fixed 5 minutes, refunded, NOT counted -------------
    add_job("auth", now - 300)
    got, _ = queue.claim_next("w", 300)
    out = queue.release_job("auth", "router rejected the key (HTTP 401)", "auth", claim_token=job("auth")["claim_token"])
    row = job("auth")
    check("auth release: queued again, attempt refunded", row["status"] == "queued" and row["attempts"] == 0)
    check("auth release waits 5 minutes", 295_000 <= row["not_before_ms"] - db.now_ms() <= 301_000)
    check("auth release is not counted against the job", row["release_count"] == 0)
    for _ in range(12):  # an outage of any length never exhausts the 10-release budget
        make_due("auth")
        queue.claim_next("w", 300)
        queue.release_job("auth", "401", "config", claim_token=(job("auth") or {}).get("claim_token"))
    check("repeated operator releases never give the job up", job("auth")["status"] == "queued" and job("auth")["release_count"] == 0)

    # --- releasing a job that is not claimed is a no-op --------------------------------
    before = dict(job("auth"))
    out = queue.release_job("auth", "again", claim_token=(job("auth") or {}).get("claim_token"))
    check("releasing a queued job changes nothing",
          not out["released"] and job("auth")["attempts"] == before["attempts"] and job("auth")["not_before_ms"] == before["not_before_ms"])
    check("a terminal job has no valid claim and cannot be released", queue.release_job("seq", "x", claim_token=(job("seq") or {}).get("claim_token"))["status"] == "stale_claim")
    check("releasing an unknown job reports missing", queue.release_job("nope", "x", claim_token=(job("nope") or {}).get("claim_token"))["status"] == "missing")
    try:
        api_app.analyze_release("nope", {}, _worker=None)
    except api_app.HTTPException as exc:
        check("route: unknown job is 404", exc.status_code == 404)
    else:
        raise AssertionError("unknown job released")
    add_job("viaroute", now - 200)
    make_due("auth")
    with db.transaction() as tx:
        tx.execute("UPDATE jobs SET status='cancelled' WHERE id='auth'")
    queue.claim_next("w", 300)
    resp = api_app.analyze_release("viaroute", {"reason": "x" * 1000, "kind": "weird", "claimToken":job("viaroute")["claim_token"]}, _worker=None)
    check("route: unknown kind behaves as provider", resp["released"] is True and job("viaroute")["release_count"] == 1)
    check("route: reason is capped in the trace", len(queue.latest_event("viaroute")["detail"]) <= 500)

    # --- admin requeue helper clears the backoff ---------------------------------------
    with db.transaction() as tx:
        queue.reset_release_state(tx, "viaroute")
    row = job("viaroute")
    check("reset_release_state", row["not_before_ms"] == 0 and row["release_count"] == 0 and row["first_claimed_ms"] is None)

    # --- worker status ------------------------------------------------------------------
    status = queue.worker_status()
    check("status before any report", status["lastSeenMs"] is None and status["stale"] is True and status["authFailing"] is False
          and set(status) == {"lastSeenMs", "lastError", "lastErrorMs", "authFailing", "hasError", "stale", "workers", "missingLanes"})
    api_app.worker_status_report({"lastError": None, "authFailing": False}, _worker=None)
    status = queue.worker_status()
    check("fresh report: seen, not stale", abs(status["lastSeenMs"] - db.now_ms()) < 5000 and status["stale"] is False and status["lastError"] is None)
    api_app.worker_status_report({"lastError": "Router menolak kunci\n(401) " + "x" * 600, "authFailing": True}, _worker=None)
    status = queue.worker_status()
    check("error + authFailing recorded, one line, capped",
          status["authFailing"] is True and status["lastError"].startswith("Router menolak kunci (401)") and len(status["lastError"]) <= 300
          and abs(status["lastErrorMs"] - db.now_ms()) < 5000)
    api_app.worker_status_report({"authFailing": False}, _worker=None)
    status = queue.worker_status()
    check("recovery clears authFailing but keeps the error history", status["authFailing"] is False and status["lastError"] is not None)
    api_app.worker_status_report({"authFailing": "yes", "lastErrorMs": "junk"}, _worker=None)
    check("junk values are not trusted", queue.worker_status()["authFailing"] is False)
    api_app.worker_status_report({}, _worker=None)
    with db.transaction() as tx:
        stored = db.from_json(tx.execute("SELECT value FROM settings WHERE key='worker_status'").fetchone()["value"], {})
        for row in stored["workers"].values(): row["lastSeenMs"] = db.now_ms() - 4 * 60_000
        tx.execute("UPDATE settings SET value=? WHERE key='worker_status'", (db.to_json(stored),))
    check("unseen for > 3 minutes is stale", queue.worker_status()["stale"] is True)

    # --- maintenance: unacked terminal jobs older than 90 days are deleted --------------
    day = 86_400_000
    add_job("old-unacked", now - 100 * day, "done", updated_ms=now - 100 * day, acked=0)
    add_job("recent-unacked", now - 10 * day, "done", updated_ms=now - 10 * day, acked=0)
    add_job("old-acked", now - 40 * day, "done", updated_ms=now - 40 * day, acked=1)
    add_job("old-running", now - 100 * day, "claimed", updated_ms=now - 100 * day)
    queue.add_event("old-unacked", "triage:start")
    result = queue.run_maintenance()
    exists = lambda ident: db.query_one("SELECT 1 FROM jobs WHERE id=?", (ident,)) is not None  # noqa: E731
    check("maintenance removes abandoned unacked jobs", not exists("old-unacked") and result["abandoned"] >= 1)
    check("maintenance removes old acked jobs", not exists("old-acked") and result["purged"] >= 1)
    check("maintenance keeps recent unacked and in-flight jobs", exists("recent-unacked") and exists("old-running"))
    check("their events cascade", db.query_one("SELECT COUNT(*) n FROM job_events WHERE job_id='old-unacked'")["n"] == 0)
    check("maintenance reports no errors", "errors" not in result)
    check("analyze no longer purges inline", "queue.purge_old_jobs_occasionally()" not in Path(api_app.__file__).read_text(encoding="utf-8"))

    # --- farmer-facing progress shows fixed labels only (M12) ---------------------------
    add_job("watch", now, "claimed", account="a")
    leak = "router http://127.0.0.1:20128 key sk-secret provider said {\"error\":\"quota\"}"
    queue.add_event("watch", "triage:http", model="gemini/x", http_status=429, latency_ms=12, detail=leak)
    farmer = api_app.analyze_status("watch", None, account={"id": "a", "role": "user"})
    check("farmer gets the stage code and a fixed Bahasa label", farmer["stage"] == "triage:http"
          and farmer["stageLabel"] == "Model triase sedang bekerja…")
    check("farmer never sees the raw trace detail", "stageDetail" not in farmer and "sk-secret" not in str(farmer) and "127.0.0.1" not in str(farmer))
    check("farmer poll carries no image", "image_b64" not in farmer)
    admin_view = api_app.analyze_status("watch", None, account={"id": "adm", "role": "admin"})
    check("admin keeps the raw detail", admin_view["stageDetail"] == leak and admin_view["stage"] == "triage:http")
    queue.add_event("watch", "internal:weird-stage", detail=leak)
    farmer = api_app.analyze_status("watch", None, account={"id": "a", "role": "user"})
    check("an unknown stage is not exposed at all", "stage" not in farmer and "stageLabel" not in farmer and "stageDetail" not in farmer)
    queue.add_event("watch", "worker:release", detail="auth: router rejected the key")
    farmer = api_app.analyze_status("watch", None, account={"id": "a", "role": "user"})
    check("release stage has a calm farmer label", farmer["stageLabel"].startswith("Server sedang sibuk") and "router" not in str(farmer).lower().replace("worker", ""))
    try:
        api_app.analyze_status("watch", None, account={"id": "b", "role": "user"})
    except api_app.HTTPException as exc:
        check("other account still gets 404", exc.status_code == 404)
    else:
        raise AssertionError("foreign job visible")
    db.close_all()

print(f"queue backoff 0220: {CHECKS} assertions passed")
