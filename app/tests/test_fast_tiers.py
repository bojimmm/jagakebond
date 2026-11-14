"""Fast-path allowance contracts in an isolated SQLite database.

Since 0.2.4.7 the farmer no longer picks a mode per photo. Every upload is admitted on
the fast pair while the account's daily fast allowance lasts (20 for a normal account,
50 for priority, unlimited for admin) and on the paced normal pair once it is used up.
These checks pin that behaviour, the atomic counter, and the fact that client-sent role
and tier fields can never authorize anything.
"""
from __future__ import annotations

import asyncio
import os
import sys
import tempfile
from datetime import datetime, timedelta
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException, UploadFile

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))
from backend import api_app, api_admin, auth, db, queue  # noqa: E402


with tempfile.TemporaryDirectory(prefix="jk-fast-tier-", dir=os.environ["TMPDIR"]) as folder:
    root = Path(folder)
    db.close_all()
    db.DB_PATH = root / "tier.sqlite3"
    api_app.UPLOAD_DIR = root / "uploads"
    api_app.UPLOAD_DIR.mkdir()
    db.migrate()
    now = db.now_ms()
    with db.transaction() as tx:
        for ident, role in (("u", "user"), ("p", "priority"), ("ad", "admin"),
                            ("stale", "user"), ("corrupt", "user")):
            tx.execute("INSERT INTO accounts(id,email,password_hash,role,created_ms,updated_ms,daily_quota) VALUES(?,?,?,?,?,?,?)",
                       (ident, f"{ident}@example.invalid", "hash", role, now, now, 0))

    checks = 0

    def ok(condition, message):
        global checks
        checks += 1
        assert condition, message

    async def read_upload(upload):
        return await upload.read()

    def thumb(data, size, quality):
        return "thumb"

    def submit(ident, key=None, passed_role="user", tier="normal"):
        """POST /api/analyze once; `tier` stands in for an older client asking for a mode."""
        return asyncio.run(api_app.analyze(
            image=UploadFile(file=BytesIO(b"photo-" + str(key).encode()), filename="plant.jpg"),
            lat=None, lng=None, elevation=None, locationName=None, accuracy=None, weather=None,
            photoDate=None, photoTimestampMs=None, farmId=None, deviceId=None, cropHint=None,
            tier=tier, clientRequestId=key,
            # These stale/forged fields must never authorize quota or role.
            account={"id": ident, "role": passed_role, "daily_quota": 0},
        ))

    def admit(ident, key=None, passed_role="user", tier="normal"):
        """Admit one photo, then retire the job so the pending cap stays out of the way."""
        receipt = submit(ident, key=key, passed_role=passed_role, tier=tier)
        assert receipt["status"] == "queued", receipt
        with db.transaction() as tx:
            tx.execute("UPDATE jobs SET status = 'failed' WHERE id = ?", (receipt["job_id"],))
        return receipt

    def add_job(ident, tier, stamp=now, status="failed"):
        jid = db.new_id("fixturejob")
        with db.transaction() as tx:
            tx.execute("INSERT INTO jobs(id,account_id,status,created_ms,updated_ms,context_json) VALUES(?,?,?,?,?,?)",
                       (jid, ident, status, stamp, stamp, db.to_json({"analysisTier": tier})))
        return jid

    def stored_tier(job_id):
        row = db.query_one("SELECT context_json FROM jobs WHERE id=?", (job_id,))
        context = db.from_json(row["context_json"], {}) if row else None
        return context.get("analysisTier") if isinstance(context, dict) else None

    def account(ident):
        return db.query_one("SELECT * FROM accounts WHERE id=?", (ident,))

    # Damaged legacy JSON must not poison quota snapshots, /me, or admissions.
    with db.transaction() as tx:
        for i, context in enumerate(("{malformed", "null", "42", '"legacy"', "[]", "{}")):
            tx.execute("INSERT INTO jobs(id,account_id,status,created_ms,updated_ms,context_json) VALUES(?,?,?,?,?,?)",
                       (f"corrupt-{i}", "corrupt", "failed", now, now, context))
        for i in range(2):
            tx.execute("INSERT INTO jobs(id,account_id,status,created_ms,updated_ms,context_json) VALUES(?,?,?,?,?,?)",
                       (f"corrupt-fast-{i}", "corrupt", "failed", now, now, db.to_json({"analysisTier": "fast"})))
    ok(queue.fast_quota_snapshot(account("corrupt"))["fastUsed"] == 2,
       "malformed context JSON was miscounted as fast usage")
    ok(auth.public_account(account("corrupt"))["fastUsed"] == 2,
       "/me lost the real fast usage count")
    with patch.object(api_app, "_read_capped", read_upload), patch.object(api_app, "_thumbnail_b64_from_bytes", thumb):
        corrupt_receipt = admit("corrupt", key="corrupt-third")
    ok(corrupt_receipt["tier"] == "fast", corrupt_receipt)
    ok(stored_tier(corrupt_receipt["job_id"]) == "fast",
       "a fast admission did not persist its lane in the job context")
    ok(queue.fast_quota_snapshot(account("corrupt"))["fastUsed"] == 3,
       "the server-chosen fast admission was not counted")

    with patch.object(api_app, "_read_capped", read_upload), patch.object(api_app, "_thumbnail_b64_from_bytes", thumb):
        # The all-day window is Asia/Jakarta; normal work is never charged to the allowance.
        day_start = queue.start_of_today_ms()
        add_job("u", "normal", day_start)
        add_job("u", "fast", day_start - 1)
        ok(queue.fast_quota_snapshot(account("u"), now_ms=day_start)["fastUsed"] == 0,
           "yesterday's fast job or today's normal job was charged to today's allowance")

        # A normal account gets twenty fast analyses, then falls back to the paced lane.
        early = [admit("u", key=f"u{i}") for i in range(20)]
        ok(all(receipt["tier"] == "fast" for receipt in early),
           "a normal account did not receive its full twenty fast analyses")
        ok(queue.fast_quota_snapshot(account("u"))["fastUsed"] == 20,
           "the twentieth fast admission was not counted")
        over = admit("u", key="u-over")
        ok(over["tier"] == "normal", "the twenty-first photo was not moved to the normal lane")
        ok(stored_tier(over["job_id"]) == "normal", over)
        ok(queue.fast_quota_snapshot(account("u"))["fastUsed"] == 20,
           "a normal-lane admission was charged to the fast allowance")
        legacy = admit("u", key="u-over-legacy", tier="fast")
        ok(legacy["tier"] == "normal",
           "an old client asking for tier=fast bypassed the exhausted allowance")

        # An idempotent replay keeps answering with the original job and costs nothing.
        first = submit("p", key="retry")
        replay = submit("p", key="retry")
        ok(first["job_id"] == replay["job_id"], "an idempotent replay created a second job")
        with db.transaction() as tx:
            tx.execute("UPDATE jobs SET status = 'failed' WHERE id = ?", (first["job_id"],))

        # Priority accounts get fifty fast analyses.
        priority = [admit("p", key=f"p{i}") for i in range(49)]
        ok(all(receipt["tier"] == "fast" for receipt in priority),
           "a priority account did not receive its full fifty fast analyses")
        ok(admit("p", key="p-over")["tier"] == "normal",
           "priority's fifty-first photo was not moved to the normal lane")

        # Admin runs on the fast pair without an allowance to exhaust.
        admin = [admit("ad", key=f"ad{i}") for i in range(55)]
        ok(all(receipt["tier"] == "fast" for receipt in admin), "admin hit a fast allowance")
        snap = queue.fast_quota_snapshot(account("ad"))
        ok(snap["fastQuota"] is None and snap["fastRemaining"] is None, snap)

        # A role passed in the request cannot raise privileges.
        forged = [admit("stale", key=f"s{i}", passed_role="admin") for i in range(20)]
        ok(all(receipt["tier"] == "fast" for receipt in forged), forged[0])
        ok(admit("stale", key="s-over", passed_role="admin")["tier"] == "normal",
           "a forged admin role in the request bypassed the persisted user allowance")

        # Persisted promotion and demotion apply from the very next admission.
        with db.transaction() as tx:
            tx.execute("UPDATE accounts SET role = 'priority' WHERE id = 'stale'")
        ok(admit("stale", key="promoted", passed_role="user")["tier"] == "fast",
           "promotion to priority did not raise the allowance")
        with db.transaction() as tx:
            tx.execute("UPDATE accounts SET role = 'user' WHERE id = 'stale'")
        ok(admit("stale", key="demoted", passed_role="admin")["tier"] == "normal",
           "demotion did not apply to the next admission")

    ok(auth.VALID_ROLES == ("user", "priority", "admin"), auth.VALID_ROLES)
    ok(queue.fast_quota_snapshot(account("u"))["fastQuota"] == 20, "normal cap is not 20")
    ok(queue.fast_quota_snapshot(account("p"))["fastQuota"] == 50, "priority cap is not 50")
    ok(auth.public_account(account("u"))["dailyQuota"] == 20,
       "legacy dailyQuota still reports the retired three-photo cap")
    # A legacy daily_quota column can no longer override the role cap.
    with db.transaction() as tx:
        tx.execute("UPDATE accounts SET daily_quota = 1000 WHERE id = 'u'")
    ok(auth.public_account(account("u"))["fastQuota"] == 20,
       "legacy daily_quota overrode the role cap")
    ok(auth.public_account(account("u"))["fastRemaining"] == 0,
       "an exhausted allowance reported spare fast analyses")
    ok(api_admin._account_row_with_counts(account("u"))["fastQuota"] == 20,
       "the admin account list disagrees with the role cap")

    # The explicit reset instant carries Jakarta's UTC+07 offset at next midnight.
    reset = queue.fast_quota_snapshot(account("u"))
    parsed = datetime.fromisoformat(reset["resetAt"])
    ok(reset["timezone"] == "Asia/Jakarta" and parsed.utcoffset() == timedelta(hours=7), reset)

    # The public registration endpoint accepts no role field and always creates normal.
    from fastapi import Request, Response
    with patch.object(auth.settings_store, "as_bool", return_value=True):
        req = Request({"type": "http", "method": "POST", "path": "/api/auth/register",
                       "headers": [], "query_string": b"", "server": ("test", 80),
                       "client": ("127.0.0.1", 1), "scheme": "http"})
        registered = auth.register(Response(), req, {"email": "escalate@example.invalid",
                                                     "password": "GoodPassword123",
                                                     "role": "priority"})
    ok(registered["account"]["role"] == "user", "public registration accepted a role")
    try:
        api_admin.admin_create_account({"email": "invalid-role@example.invalid",
                                        "password": "GoodPassword123", "role": "root"},
                                       admin={"email": "admin", "id": "ad"})
    except HTTPException as exc:
        ok(exc.status_code == 400, exc.status_code)
    else:
        ok(False, "unknown admin-assigned role was accepted")

    db.close_all()
print(f"fast-tiers: {checks} fast-path admission assertions passed")
