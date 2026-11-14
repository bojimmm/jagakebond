"""Synthetic 0.2.4.15: phone error reports land in the audit log, masked, rate-limited, deduplicated,
shown on the admin overview and purged after 30 days."""
from __future__ import annotations

import tempfile
from pathlib import Path

from fastapi import HTTPException

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend import api_admin, api_app, db, security


checks = 0
def check(condition: bool, label: str) -> None:
    global checks
    if not condition:
        raise AssertionError(label)
    checks += 1


with tempfile.TemporaryDirectory(prefix="jk-quality-0255-", ignore_cleanup_errors=True) as folder:
    root = Path(folder)
    db.close_all()
    db.DB_PATH = root / "fixture.sqlite3"
    db.migrate()
    now = db.now_ms()
    farmer = {"id": "quality-farmer", "role": "user", "email": "petani@fixture.invalid"}
    admin = {"id": "quality-admin", "role": "admin", "email": "admin@fixture.invalid"}
    with db.transaction() as tx:
        for account in (farmer, admin):
            tx.execute("INSERT INTO accounts(id,email,password_hash,role,created_ms,updated_ms) VALUES(?,?,?,?,?,?)",
                       (account["id"], account["email"], "synthetic", account["role"], now, now))
    api_app._client_error_seen.clear()
    api_app._client_error_last.clear()

    def rows():
        return db.query("SELECT actor_email, target, detail FROM audit_log WHERE action = 'client.error' ORDER BY id")

    first = api_app.client_error({"message": "TypeError: x is undefined (kontak budi@desa.id, HP 081234567890, "
                                             "token abcdefghijklmnopqrstuvwxyz0123456789ABCD)",
                                  "source": "https://jagake.bond/app.js?v=41", "line": 812, "kind": "error",
                                  "release": "0.2.4.15", "view": "log", "native": True}, farmer)
    check(first == {"ok": True, "recorded": True}, "first report is recorded")
    row = rows()[0]
    check(row["actor_email"] == farmer["email"] and row["target"] == "log", "row names the reporter and the screen")
    check("budi@desa.id" not in row["detail"] and "[email]" in row["detail"], "e-mail addresses are masked")
    check("081234567890" not in row["detail"] and "[angka]" in row["detail"], "long numbers are masked")
    check("abcdefghijklmnopqrstuvwxyz0123456789ABCD" not in row["detail"] and "[token]" in row["detail"], "tokens are masked")
    check("app.js:812" in row["detail"] and "?v=" not in row["detail"] and "android" in row["detail"]
          and "versi 0.2.4.15" in row["detail"], "file, line, platform and version are kept without the query string")

    again = api_app.client_error({"message": "TypeError: x is undefined (kontak budi@desa.id, HP 081234567890, "
                                             "token abcdefghijklmnopqrstuvwxyz0123456789ABCD)",
                                  "source": "app.js", "line": 812, "native": True}, farmer)
    check(again == {"ok": True, "recorded": False} and len(rows()) == 1, "the same error within 10 minutes is recorded once")

    for n in range(40):
        api_app.client_error({"message": f"Error nomor {n}", "source": "shell.js", "line": n}, farmer)
    check(len(rows()) == api_app.CLIENT_ERROR_BUDGET, "one account records at most 20 errors per hour")

    try:
        api_app.client_error({"message": "   "}, farmer)
        check(False, "empty message is refused")
    except HTTPException as error:
        check(error.status_code == 400, "empty message is refused with 400")

    long = api_app.client_error({"message": "x" * 5000, "source": "y" * 500, "line": "12"}, admin)
    detail = db.query_one("SELECT detail FROM audit_log WHERE actor_email = ? AND action = 'client.error'", (admin["email"],))["detail"]
    check(long["recorded"] and len(detail) <= 1200 and "web" in detail, "oversized fields are clipped; a string line number is ignored")

    overview = api_admin.overview(admin)
    check(overview["clientErrors24h"] == api_app.CLIENT_ERROR_BUDGET + 1, "admin overview counts the last 24 hours")
    check(len(overview["clientErrorsRecent"]) == 5 and overview["clientErrorsRecent"][0]["actor"] == admin["email"],
          "admin overview lists the five newest, newest first")

    with db.transaction() as tx:
        tx.execute("UPDATE audit_log SET ts_ms = ? WHERE action = 'client.error' AND actor_email = ?",
                   (now - 31 * 86_400_000, farmer["email"]))
        tx.execute("INSERT INTO audit_log (ts_ms, account_id, actor_email, action, target, detail) VALUES (?,?,?,?,?,?)",
                   (now - 31 * 86_400_000, admin["id"], admin["email"], "account.create", "kept", "history"))
    purged = security.purge_retention()
    check(purged["clientErrors"] == api_app.CLIENT_ERROR_BUDGET, "error reports older than 30 days are purged")
    check(db.query_one("SELECT COUNT(*) AS n FROM audit_log WHERE target = 'kept'")["n"] == 1,
          "other audit history of the same age is kept")
    db.close_all()

# The page names its own release so a report from an old cached page is recognisable.
APP = Path(__file__).resolve().parents[1]
release = __import__("re").search(r'RELEASE_VERSION = "([^"]+)"', (APP / "backend/version.py").read_text()).group(1)
index = (APP / "frontend/index.html").read_text(encoding="utf-8")
check(f'<meta name="jk-release" content="{release}">' in index, "index.html jk-release meta matches backend/version.py")
check(index.index("error-report.js") < index.index("app.js?v="), "the error reporter loads before the app scripts")
check("client-errors" in (APP / "frontend/native-adapter.js").read_text(encoding="utf-8"), "the Android bridge allows the report route")
print(f"quality 0255: {checks} assertions passed")
