"""Admin console 0.2.2.0 — HTTP-level regression tests (TestClient, synthetic fixtures only).

Run:  cd app && python tests/test_admin_0220.py

Covers audit section 4: guards on requeue/cancel, router URL policy, test-router with draft
values, re-authentication, audit detail (old -> new, never a secret), account deletion with the
photo lifecycle (contract 5.5, with an in-process stand-in for backend.storage), pagination,
aggregate counts, the secret hint, router-level admin dependency and the CSP-clean page.
A throwaway SQLite file is used; nothing touches a real database or a real router.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import sys
import tempfile
import threading
import types
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))

TMP = Path(tempfile.mkdtemp(prefix="jk-admin-0220-", dir=os.environ.get("TMPDIR") or None))
ADMIN_EMAIL = "admin@jagakebond.local"
ADMIN_PASSWORD = "AdminLokal123"
os.environ.update({
    "COOKIE_SECURE": "0", "SECRET_KEY": "synthetic-admin-0220-secret-key", "WORKER_TOKEN": "synthetic-worker-token",
    "ADMIN_EMAIL": ADMIN_EMAIL, "ADMIN_PASSWORD": ADMIN_PASSWORD, "ALLOW_REGISTRATION": "0",
    "SEED_DEMO_DATA": "0", "NINEROUTER_KEY": "", "NINEROUTER_URL": "http://127.0.0.1:9",
})
os.environ.pop("JK_ROUTER_ALLOWED_HOSTS", None)

from backend import db  # noqa: E402

db.close_all()
db.DB_PATH = TMP / "admin.sqlite3"

from fastapi.testclient import TestClient  # noqa: E402
from backend import api_admin, auth, queue, security, settings_store  # noqa: E402
from backend.app import app  # noqa: E402

CASES: list[tuple[str, bool, str]] = []


def case(name: str, ok: bool, detail: object = "") -> None:
    CASES.append((name, bool(ok), str(detail)))
    print(("PASS " if ok else "FAIL ") + name + ("" if ok or not detail else " :: " + str(detail)[:300]))


class Session:
    """A cookie-aware caller with CSRF handling (one per signed-in account)."""

    def __init__(self) -> None:
        self.client = TestClient(app, raise_server_exceptions=False)

    def login(self, email: str, password: str) -> int:
        return self.client.post("/api/auth/login", json={"email": email, "password": password}).status_code

    @property
    def csrf(self) -> str | None:
        return self.client.cookies.get("jk_csrf")

    def call(self, method: str, path: str, body: object = None):
        headers = {"X-CSRF-Token": self.csrf} if method != "GET" and self.csrf else {}
        kwargs = {"json": body} if body is not None else {}
        return self.client.request(method, path, headers=headers, **kwargs)

    def get(self, path):
        return self.call("GET", path)

    def post(self, path, body=None):
        return self.call("POST", path, {} if body is None else body)

    def put(self, path, body):
        return self.call("PUT", path, body)

    def delete(self, path):
        return self.call("DELETE", path)


def audit_rows(action: str | None = None) -> list[dict]:
    sql = "SELECT id, ts_ms, actor_email, action, target, detail FROM audit_log"
    if action:
        return db.query(sql + " WHERE action = ? ORDER BY id", (action,))
    return db.query(sql + " ORDER BY id")


def last_audit(action: str) -> dict:
    rows = audit_rows(action)
    return rows[-1] if rows else {}


def insert_account(ident: str, email: str, role: str = "user", active: int = 1, created: int | None = None,
                   name: str = "") -> None:
    now = created or db.now_ms()
    with db.transaction() as tx:
        tx.execute("INSERT INTO accounts(id,email,name,role,password_hash,is_active,daily_quota,created_ms,updated_ms) "
                   "VALUES (?,?,?,?,?,?,0,?,?)", (ident, email, name, role, "synthetic", active, now, now))


def insert_job(ident: str, account: str, status: str, image: str | None = "IMG-SENTINEL-DO-NOT-LEAK",
               attempts: int = 1, claimed_ago_s: int | None = None, error: str | None = None,
               release_count: int = 0, not_before: int = 0) -> None:
    now = db.now_ms()
    claimed = now - claimed_ago_s * 1000 if claimed_ago_s is not None else None
    with db.transaction() as tx:
        tx.execute(
            "INSERT INTO jobs(id,account_id,status,attempts,created_ms,updated_ms,claimed_ms,worker,image_b64,"
            "context_json,error,release_count,not_before_ms,first_claimed_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (ident, account, status, attempts, now, now, claimed, "w1" if claimed else None, image,
             json.dumps({"analysisTier": "fast"}), error, release_count, not_before, claimed))


def job_row(ident: str) -> dict:
    return db.query_one("SELECT * FROM jobs WHERE id = ?", (ident,)) or {}


# ---------------------------------------------------------------------------
# A stand-in for backend.storage (BE2) that records the lock order of the contract (5.5)
# ---------------------------------------------------------------------------


class FakeStorage(types.ModuleType):
    def __init__(self) -> None:
        super().__init__("backend.storage")
        self.events: list[str] = []
        self.retire_result = {"queued": 3, "blocked": 1}
        self.drain_result = {"done": 2, "pending": 1, "blocked": 1}
        self.fail_retire = False
        self.status_result = {"pending": 0, "blocked": 0, "done": 5, "oldestPendingMs": None,
                              "lastDrainMs": db.now_ms(), "blockedReasons": {}}
        self.inventory_result = {"scannedMs": db.now_ms(), "files": 4, "referenced": 3,
                                 "unreferenced": [{"name": "orphan.jpg", "size": 10, "mtimeMs": 1}],
                                 "unreferencedCount": 1, "unreferencedBytes": 10}

    @contextlib.contextmanager
    def storage_lock(self):
        self.events.append(f"lock-enter(db_locked={db._write_lock.locked()})")  # noqa: SLF001
        try:
            yield
        finally:
            self.events.append("lock-exit")

    def retire_account_objects(self, tx, account_id):
        self.events.append(f"retire(db_locked={db._write_lock.locked()},id={account_id})")  # noqa: SLF001
        if self.fail_retire:
            raise RuntimeError("synthetic storage failure")
        return dict(self.retire_result)

    def drain(self, max_items=50):
        self.events.append(f"drain({max_items},db_locked={db._write_lock.locked()})")  # noqa: SLF001
        return dict(self.drain_result)

    def status(self):
        return dict(self.status_result)

    def inventory(self):
        self.events.append("inventory")
        return dict(self.inventory_result)


FAKE = FakeStorage()
import backend  # noqa: E402


@contextlib.contextmanager
def storage_missing():
    previous = sys.modules.get("backend.storage")
    sys.modules["backend.storage"] = None  # type: ignore[assignment]
    try:
        yield
    finally:
        sys.modules["backend.storage"] = previous  # type: ignore[assignment]


# ---------------------------------------------------------------------------
# A tiny router: records what it receives
# ---------------------------------------------------------------------------


class RouterState:
    hits: list[dict] = []
    models = ["triage-draft-model", "diagnose-draft-model"]
    status = 200


class RouterHandler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        RouterState.hits.append({"path": self.path, "auth": self.headers.get("Authorization")})
        body = json.dumps({"data": [{"id": name} for name in RouterState.models]}).encode()
        self.send_response(RouterState.status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # noqa: D401
        return


router_server = ThreadingHTTPServer(("127.0.0.1", 0), RouterHandler)
threading.Thread(target=router_server.serve_forever, daemon=True).start()
ROUTER_URL = f"http://127.0.0.1:{router_server.server_address[1]}"

# ---------------------------------------------------------------------------

with TestClient(app) as lifespan_client:  # runs auth.bootstrap(): creates the first admin
    # The migration may import the real backend.storage (BE2); swap in the recording stand-in only now.
    try:
        import backend.storage as REAL_STORAGE  # noqa: E402
    except ImportError:
        REAL_STORAGE = None
    sys.modules["backend.storage"] = FAKE
    backend.storage = FAKE  # type: ignore[attr-defined]
    admin = Session()
    case("admin signs in", admin.login(ADMIN_EMAIL, ADMIN_PASSWORD) == 200)
    ADMIN = auth.find_by_email(ADMIN_EMAIL)
    ADMIN_ID = ADMIN["id"]

    # =======================================================================
    print("--- router-level admin dependency ---")
    anon = Session()
    user_pw = "PetaniBiasa123"
    created = admin.post("/api/admin/accounts", {"email": "petani1@example.com", "name": "Petani Satu",
                                                  "password": user_pw, "role": "user"})
    case("admin creates a normal account without re-authentication", created.status_code == 200, created.text[:200])
    farmer = Session()
    case("farmer signs in", farmer.login("petani1@example.com", user_pw) == 200)
    bad = []
    for route in api_admin.router.routes:
        path = re.sub(r"\{[^}]+\}", "x", route.path)
        for method in sorted(route.methods):
            r_anon = anon.call(method, path, {} if method != "GET" else None)
            r_farmer = farmer.call(method, path, {} if method != "GET" else None)
            if r_anon.status_code != 401:
                bad.append((method, path, "anon", r_anon.status_code))
            if r_farmer.status_code != 403:
                bad.append((method, path, "farmer", r_farmer.status_code))
    case("every admin route refuses anonymous (401) and a farmer (403)", not bad, bad)

    # =======================================================================
    print("--- router URL policy (save + test use ONE validator) ---")
    ok_urls = ["http://localhost:20128", "http://127.0.0.1:9", "http://[::1]:20128", "https://localhost:8443",
               "https://api.open-meteo.com", "http://localhost:20128/", "http://localhost:20128/v1",
               "http://api.open-meteo.com"]  # path and probe-host scheme/port are free, like the worker
    bad_urls = ["localhost:20128", "ftp://localhost", "http://user:pw@localhost:20128", "http://:pw@localhost",
                "http://localhost:20128/?x=1", "http://localhost:20128/#top", "http://localhost:20128?",
                "http://evil.example.com", "http://localhost.evil.example.com", "http://127.0.0.1.evil.test",
                "http://localhost:99999", "http://local host", "", "http://"]
    case("policy accepts the allowed forms",
         all(settings_store.router_url_problem(u) is None for u in ok_urls),
         [u for u in ok_urls if settings_store.router_url_problem(u)])
    case("policy rejects userinfo, query, fragment, path, foreign host, bad port",
         all(settings_store.router_url_problem(u) for u in bad_urls),
         [u for u in bad_urls if not settings_store.router_url_problem(u)])
    case("canonical form has no trailing slash",
         settings_store.canonical_router_url("HTTP://LocalHost:20128/") == "http://localhost:20128")
    os.environ["JK_ROUTER_ALLOWED_HOSTS"] = "Router.Example.Test, other.example.test"
    case("JK_ROUTER_ALLOWED_HOSTS hosts are allowed (exact host names only)",
         settings_store.router_url_problem("https://router.example.test:8443") is None
         and settings_store.router_url_problem("https://sub.router.example.test") is not None)
    os.environ.pop("JK_ROUTER_ALLOWED_HOSTS", None)

    r = admin.put("/api/admin/settings", {"settings": {"NINEROUTER_URL": "http://attacker.example.com"}})
    case("saving a foreign router host is refused with 422 and a Bahasa message",
         r.status_code == 422 and "tidak diizinkan" in r.json()["detail"], r.text[:200])
    r = admin.put("/api/admin/settings", {"settings": {"NINEROUTER_URL": "http://user:pw@localhost:20128"}})
    case("saving a URL with userinfo is refused (422)", r.status_code == 422, r.text[:200])
    r = admin.put("/api/admin/settings", {"settings": {"NINEROUTER_URL": "http://localhost:20128/?k=1"}})
    case("saving a URL with a query is refused (422)", r.status_code == 422, r.text[:200])
    case("a refused URL was not stored", db.query_one("SELECT 1 FROM settings WHERE key='NINEROUTER_URL'") is None)
    r = admin.put("/api/admin/settings", {"settings": {"GEMINI_TRIAGE_MODEL": "openai/gpt-4o-mini"}})
    case("a non-Gemini model route saves (200)", r.status_code == 200, r.status_code)
    r = admin.put("/api/admin/settings", {"settings": {"GEMINI_TRIAGE_MODEL": "two words"}})
    case("other validation errors stay 400 (route with spaces)", r.status_code == 400, r.status_code)

    # =======================================================================
    print("--- test-router: draft values, never saved, never echoed ---")
    secret_draft = "draft-key-ABCDEF-1234567890"
    RouterState.hits.clear()
    before = db.query("SELECT key, value FROM settings WHERE key IN ('NINEROUTER_URL','NINEROUTER_KEY')")
    r = admin.post("/api/admin/settings/test-router", {
        "url": ROUTER_URL, "key": secret_draft, "triageModel": "triage-draft-model",
        "diagnoseModel": "diagnose-draft-model"})
    body = r.json()
    case("draft test reaches the DRAFT router with the DRAFT key",
         r.status_code == 200 and body.get("ok") is True and RouterState.hits
         and RouterState.hits[0]["auth"] == f"Bearer {secret_draft}" and RouterState.hits[0]["path"] == "/v1/models",
         (r.text[:200], RouterState.hits))
    case("draft test reports the models it found", body.get("triageFound") and body.get("diagnoseFound")
         and body.get("modelCount") == 2, body)
    case("test response never echoes the key", secret_draft not in r.text)
    after = db.query("SELECT key, value FROM settings WHERE key IN ('NINEROUTER_URL','NINEROUTER_KEY')")
    case("testing a draft saves nothing", before == after == [], (before, after))
    case("test is audited without the key",
         any("draf: url,key" in (row["detail"] or "") for row in audit_rows("setting.test_router"))
         and not any(secret_draft in json.dumps(row) for row in audit_rows()))
    r = admin.post("/api/admin/settings/test-router", {"url": "http://attacker.example.com", "key": "x" * 12})
    case("test uses the same policy: foreign host is refused, no request is sent",
         r.status_code == 200 and r.json()["ok"] is False and r.json().get("policy") is True
         and "tidak diizinkan" in r.json()["detail"], r.text[:200])
    r = admin.post("/api/admin/settings/test-router", {"url": ROUTER_URL})
    case("no key anywhere -> clear message, still no request",
         r.status_code == 200 and "Kunci router belum diisi" in r.json()["detail"], r.text[:200])
    RouterState.status = 401
    r = admin.post("/api/admin/settings/test-router", {"url": ROUTER_URL, "key": secret_draft})
    case("router 401 -> 'menolak kunci'", r.json().get("authorised") is False and "menolak kunci" in r.json()["detail"])
    RouterState.status = 200
    r = admin.post("/api/admin/settings/test-router", {"url": ROUTER_URL, "key": secret_draft,
                                                        "triageModel": "no-such-model"})
    case("a missing model is named and does not pass readiness", r.json()["ok"] is False and "triase" in r.json()["detail"], r.json())
    with contextlib.ExitStack() as stack:
        # The same call also works as a plain function call (older tests call it that way).
        result = api_admin.test_router(admin={"id": "x", "email": "x@example.com"})
        case("test_router() is still callable directly with only admin=", isinstance(result, dict) and "detail" in result)
    window = api_admin._TEST_MAX_PER_WINDOW  # noqa: SLF001
    api_admin._test_calls.clear()  # noqa: SLF001
    codes = [admin.post("/api/admin/settings/test-router", {"url": ROUTER_URL, "key": secret_draft}).status_code
             for _ in range(window + 2)]
    case("router tests are rate limited", codes[:window] == [200] * window and codes[-1] == 429, codes)
    api_admin._test_calls.clear()  # noqa: SLF001

    # =======================================================================
    print("--- re-authentication (finding 7) ---")
    r = admin.post("/api/admin/accounts", {"email": "boss2@example.com", "name": "Boss Dua",
                                           "password": "BossDuaPassword12", "role": "admin"})
    case("creating an admin without the password is refused", r.status_code == 403
         and r.json().get("code") == "reauth_required", r.text[:200])
    case("no account was created by the refused call", auth.find_by_email("boss2@example.com") is None)
    r = admin.post("/api/admin/accounts", {"email": "boss2@example.com", "name": "Boss Dua",
                                           "password": "BossDuaPassword12", "role": "admin",
                                           "currentPassword": "salah-salah-salah"})
    case("a wrong confirmation password is refused with its own code", r.status_code == 403
         and r.json().get("code") == "reauth_failed" and "salah" in r.json()["detail"], r.text[:200])
    case("a failed re-authentication is audited", len(audit_rows("reauth.failed")) >= 1)
    r = admin.post("/api/admin/accounts", {"email": "boss2@example.com", "name": "Boss Dua",
                                           "password": "short", "role": "admin", "currentPassword": ADMIN_PASSWORD})
    case("admin passwords follow the stronger policy (12+)", r.status_code == 400, r.text[:200])
    r = admin.post("/api/admin/accounts", {"email": "boss2@example.com", "name": "Boss Dua",
                                           "password": "BossDuaPassword12", "passwordConfirm": "BossDuaPassword13",
                                           "role": "admin", "currentPassword": ADMIN_PASSWORD})
    case("a confirmation that differs from the password is refused", r.status_code == 400
         and "tidak sama" in r.json()["detail"], r.text[:200])
    r = admin.post("/api/admin/accounts", {"email": "boss2@example.com", "name": "Boss Dua",
                                           "password": "BossDuaPassword12", "passwordConfirm": "BossDuaPassword12",
                                           "role": "admin", "currentPassword": ADMIN_PASSWORD})
    case("creating an admin with the right password works", r.status_code == 200 and r.json()["role"] == "admin",
         r.text[:200])
    BOSS2 = auth.find_by_email("boss2@example.com")

    insert_account("acct_grant", "grant@example.com", name="Calon Admin")
    r = admin.put("/api/admin/accounts/acct_grant", {"role": "admin"})
    case("granting the admin role needs the password", r.status_code == 403 and r.json()["code"] == "reauth_required")
    case("the role did not change", auth.find_by_id("acct_grant")["role"] == "user")
    r = admin.put("/api/admin/accounts/acct_grant", {"role": "admin", "currentPassword": ADMIN_PASSWORD})
    case("granting the admin role with the password works", r.status_code == 200 and r.json()["role"] == "admin")
    r = admin.put("/api/admin/accounts/acct_grant", {"role": "priority"})
    case("demoting an admin needs no password", r.status_code == 200 and r.json()["role"] == "priority", r.text[:200])

    r = admin.post(f"/api/admin/accounts/{BOSS2['id']}/password", {"password": "BossDuaBaru12345"})
    case("resetting another admin's password needs the password", r.status_code == 403
         and r.json()["code"] == "reauth_required")
    r = admin.post(f"/api/admin/accounts/{BOSS2['id']}/password",
                   {"password": "BossDuaBaru12345", "currentPassword": ADMIN_PASSWORD})
    case("resetting another admin's password with the password works", r.status_code == 200, r.text[:200])
    case("the other admin's sessions are all revoked", r.json()["revokedSessions"] >= 0
         and r.json()["keptCurrentSession"] is False)
    farmer_id = auth.find_by_email("petani1@example.com")["id"]
    r = admin.post(f"/api/admin/accounts/{farmer_id}/password", {"password": "PetaniBaru12345"})
    case("resetting a farmer's password needs no re-authentication", r.status_code == 200, r.text[:200])
    case("the farmer's session was revoked", farmer.get("/api/auth/me").json().get("ok") is False)

    # own password: needs the password, keeps THIS session, drops the others
    second = Session()
    case("the same admin signs in on a second device", second.login(ADMIN_EMAIL, ADMIN_PASSWORD) == 200)
    r = admin.post(f"/api/admin/accounts/{ADMIN_ID}/password", {"password": "AdminLokalBaru123"})
    case("resetting your own admin password needs the password too", r.status_code == 403)
    r = admin.post(f"/api/admin/accounts/{ADMIN_ID}/password",
                   {"password": "AdminLokalBaru123", "currentPassword": ADMIN_PASSWORD})
    case("own reset works and reports that this session was kept", r.status_code == 200
         and r.json()["keptCurrentSession"] is True and r.json()["revokedSessions"] >= 1, r.text[:200])
    case("this session is still signed in", admin.get("/api/auth/me").json().get("ok") is True)
    case("the other device was signed out", second.get("/api/auth/me").json().get("ok") is False)
    ADMIN_PASSWORD = "AdminLokalBaru123"

    # settings: URL and keys need the password; plain settings and blank secrets do not
    r = admin.put("/api/admin/settings", {"settings": {"NINEROUTER_URL": ROUTER_URL}})
    case("changing the router URL needs the password", r.status_code == 403 and r.json()["code"] == "reauth_required")
    r = admin.put("/api/admin/settings", {"settings": {"NINEROUTER_KEY": "key-new-1234567890abcdef"}})
    case("changing an API key needs the password", r.status_code == 403)
    r = admin.put("/api/admin/settings", {"settings": {"QUEUE_PACER_SECONDS": "33", "NINEROUTER_KEY": ""}})
    case("plain settings and a blank secret need no password", r.status_code == 200
         and r.json()["applied"] == ["QUEUE_PACER_SECONDS"], r.text[:200])
    r = admin.put("/api/admin/settings", {"settings": {"NINEROUTER_URL": ROUTER_URL,
                                                       "NINEROUTER_KEY": "key-new-1234567890abcdef"},
                                          "currentPassword": ADMIN_PASSWORD})
    case("URL + key with the password are saved", r.status_code == 200 and set(r.json()["applied"]) ==
         {"NINEROUTER_URL", "NINEROUTER_KEY"}, r.text[:200])
    r = admin.put("/api/admin/settings", {"settings": {"NINEROUTER_URL": ROUTER_URL}})
    case("re-sending the unchanged URL needs no password", r.status_code == 200, r.text[:200])

    # =======================================================================
    print("--- audit detail: old -> new, never a secret ---")
    pacer = [row for row in audit_rows("setting.update") if "Jeda antar foto" in (row["detail"] or "")]
    case("non-secret settings record old and new values",
         pacer and "Jeda antar foto (detik): 25 -> 33" in pacer[0]["detail"], pacer[:1])
    url_change = [row for row in audit_rows("setting.update") if "Alamat router" in (row["detail"] or "")]
    case("the router URL change records old and new", url_change
         and "http://127.0.0.1:9 -> " + ROUTER_URL in url_change[-1]["detail"], url_change[-1:])
    key_rows = [row for row in audit_rows("setting.update") if "NINEROUTER_KEY" in (row["detail"] or "")]
    case("a secret is recorded by key name only", key_rows and "diganti (nilai tidak dicatat)" in key_rows[-1]["detail"])
    dump = json.dumps(audit_rows())
    case("no secret value appears anywhere in the audit log",
         "key-new-1234567890abcdef" not in dump and secret_draft not in dump)

    insert_account("acct_audit", "audit@example.com", name="Nama Lama")
    r = admin.put("/api/admin/accounts/acct_audit", {"name": "Nama Baru", "role": "priority", "isActive": False,
                                                      "email": "audit-baru@example.com"})
    detail = last_audit("account.update").get("detail", "")
    case("account changes record old -> new for name, email, role and status", r.status_code == 200
         and 'nama: "Nama Lama" -> "Nama Baru"' in detail and "email: audit@example.com -> audit-baru@example.com" in detail
         and "peran: Normal -> Prioritas" in detail and "status: aktif -> nonaktif" in detail, detail)
    case("the audit row targets the account's old email", last_audit("account.update")["target"] == "audit@example.com")
    count = len(audit_rows("account.update"))
    r = admin.put("/api/admin/accounts/acct_audit", {"name": "Nama Baru"})
    case("an update that changes nothing writes no audit row", r.status_code == 200
         and len(audit_rows("account.update")) == count)
    r = admin.put("/api/admin/accounts/acct_audit", {"email": "audit-baru@example.com", "role": "wizard"})
    case("an unknown role is refused with 400", r.status_code == 400)
    r = admin.put("/api/admin/accounts/acct_audit", {"email": "petani1@example.com"})
    case("a taken email is refused with 409", r.status_code == 409, r.text[:200])
    r = admin.put("/api/admin/accounts/acct_audit", {"email": "bukan-email"})
    case("a malformed email is refused with 400", r.status_code == 400)

    insert_job("job_audit_view", "acct_audit", "done")
    r = admin.get("/api/admin/jobs/job_audit_view")
    case("reading a farmer's job detail is audited", r.status_code == 200
         and any(row["target"] == "job_audit_view" for row in audit_rows("job.view")), r.text[:100])
    case("job detail never contains the photo", "IMG-SENTINEL" not in r.text and "image_b64" not in r.text)
    case("an unknown job is 404", admin.get("/api/admin/jobs/nope").status_code == 404)

    # =======================================================================
    print("--- audit log: filter, pagination, routine rows ---")
    with db.transaction() as tx:
        for i in range(120):
            tx.execute("INSERT INTO audit_log(ts_ms,account_id,actor_email,action,target,detail) VALUES (?,?,?,?,?,?)",
                       (db.now_ms() + i, None, "seed@example.com", "queue.requeue" if i % 2 else "account.logout",
                        f"seed_{i}", f"detail {i}"))
    page1 = admin.get("/api/admin/audit/entries?limit=50").json()
    case("audit entries: a page of 50 with a cursor", len(page1["items"]) == 50 and page1["next"])
    case("routine sign-in/out rows are hidden by default",
         all(item["action"] not in ("account.login", "account.logout") for item in page1["items"]))
    seen = {item["id"] for item in page1["items"]}
    page2 = admin.get(f"/api/admin/audit/entries?limit=50&before={page1['next']}").json()
    ids2 = {item["id"] for item in page2["items"]}
    case("the next page continues without overlap", not (seen & ids2) and max(ids2) < min(seen))
    full = []
    cursor = None
    while True:
        url = "/api/admin/audit/entries?limit=40" + (f"&before={cursor}" if cursor else "")
        data = admin.get(url).json()
        full += data["items"]
        cursor = data["next"]
        if not cursor:
            break
    non_routine = db.query_one("SELECT COUNT(*) AS n FROM audit_log WHERE action NOT IN ('account.login','account.logout')")["n"]
    case("paging through everything returns each non-routine row once",
         len(full) == non_routine == len({item["id"] for item in full}), (len(full), non_routine))
    with_routine = admin.get("/api/admin/audit/entries?limit=200&routine=1").json()["items"]
    case("the routine toggle brings sign-in/out rows back",
         any(item["action"] in ("account.login", "account.logout") for item in with_routine))
    only_update = admin.get("/api/admin/audit/entries?limit=200&action=account.update").json()["items"]
    case("filter by one action type", only_update and all(item["action"] == "account.update" for item in only_update))
    group = admin.get("/api/admin/audit/entries?limit=200&action=account.*").json()["items"]
    case("filter by action group (prefix*) leaves routine rows out",
         group and all(item["action"].startswith("account.") and item["action"] not in
                       ("account.login", "account.logout") for item in group))
    login_only = admin.get("/api/admin/audit/entries?limit=200&action=account.login").json()["items"]
    case("asking for sign-ins explicitly shows them", login_only and all(i["action"] == "account.login" for i in login_only))
    found = admin.get("/api/admin/audit/entries?limit=50&q=seed_7").json()["items"]
    case("search matches the target text", found and all("seed_7" in (i["target"] or "") for i in found))
    case("legacy /audit still returns a bare list", isinstance(admin.get("/api/admin/audit?limit=5").json(), list))
    case("a limit above the cap is rejected", admin.get("/api/admin/audit/entries?limit=5000").status_code == 422)

    # =======================================================================
    print("--- requeue / cancel guards (finding 4) ---")
    insert_account("acct_q", "queue@example.com")
    for ident, status, kwargs in [
        ("job_done", "done", {}), ("job_rej", "rejected", {"error": "Foto buram", "attempts": 3, "release_count": 4,
                                                          "not_before": db.now_ms() + 600_000, "claimed_ago_s": 100}),
        ("job_failed", "failed", {"error": "boom"}), ("job_queued", "queued", {}),
        ("job_claim_fresh", "claimed", {"claimed_ago_s": 5}), ("job_claim_stale", "claimed", {"claimed_ago_s": 4000}),
        ("job_rej_noimg", "rejected", {"image": None, "error": "x"}), ("job_cancelled", "cancelled", {}),
    ]:
        insert_job(ident, "acct_q", status, **kwargs)
    r = admin.post("/api/admin/queue/job_done/requeue")
    case("requeue of a finished job is refused (409) and nothing changes", r.status_code == 409
         and r.json().get("code") == "invalid_state" and job_row("job_done")["status"] == "done", r.text[:200])
    case("the refusal explains itself in Bahasa", "selesai" in r.json()["detail"])
    for ident in ("job_queued", "job_claim_fresh", "job_cancelled"):
        r = admin.post(f"/api/admin/queue/{ident}/requeue")
        case(f"requeue refused for {ident}", r.status_code == 409, r.text[:160])
    r = admin.post("/api/admin/queue/job_rej_noimg/requeue")
    case("requeue refused when the photo is already gone", r.status_code == 409 and "Foto" in r.json()["detail"])
    r = admin.post("/api/admin/queue/job_rej/requeue")
    row = job_row("job_rej")
    case("requeue of a rejected job works and resets attempts and backoff",
         r.status_code == 200 and row["status"] == "queued" and row["attempts"] == 0 and row["release_count"] == 0
         and row["not_before_ms"] == 0 and row["first_claimed_ms"] is None and row["error"] is None
         and row["worker"] is None and row["claimed_ms"] is None, dict(row, image_b64="..."))
    case("requeue is audited with the old status", "dari rejected" in last_audit("queue.requeue")["detail"])
    for ident in ("job_failed", "job_claim_stale"):
        case(f"requeue works for {ident}", admin.post(f"/api/admin/queue/{ident}/requeue").status_code == 200
             and job_row(ident)["status"] == "queued")
    case("requeue of a missing job is 404", admin.post("/api/admin/queue/nope/requeue").status_code == 404)

    insert_job("job_c_done", "acct_q", "done")
    insert_job("job_c_rej", "acct_q", "rejected", error="x")
    insert_job("job_c_queued", "acct_q", "queued")
    insert_job("job_c_claimed", "acct_q", "claimed", claimed_ago_s=5)
    for ident in ("job_c_done", "job_c_rej"):
        before_row = job_row(ident)
        r = admin.post(f"/api/admin/queue/{ident}/cancel", {"reason": "Alasan baru"})
        after_row = job_row(ident)
        case(f"cancel refused for {ident} and the job is untouched", r.status_code == 409
             and (after_row["status"], after_row["error"], after_row["updated_ms"]) ==
             (before_row["status"], before_row["error"], before_row["updated_ms"]), r.text[:160])
    r = admin.post("/api/admin/queue/job_c_queued/cancel", {"reason": "Uji admin"})
    case("cancel of a waiting job works and keeps the reason", r.status_code == 200
         and r.json()["job"]["error"] == "Uji admin" and job_row("job_c_queued")["status"] == "rejected")
    r = admin.post("/api/admin/queue/job_c_claimed/cancel", {"reason": "A" * 900 + "\n\x00baris"})
    case("the cancel reason is capped at 300 characters and cleaned",
         r.status_code == 200 and len(job_row("job_c_claimed")["error"]) == 300
         and "\n" not in job_row("job_c_claimed")["error"], len(job_row("job_c_claimed")["error"] or ""))
    case("cancel is audited with the old status", "dari claimed" in last_audit("queue.cancel")["detail"])
    r = admin.post("/api/admin/queue/job_c_done/cancel", {})
    case("cancel without a reason on a finished job is still refused", r.status_code == 409)
    insert_job("job_c_default", "acct_q", "queued")
    admin.post("/api/admin/queue/job_c_default/cancel", {})
    case("default cancel reason", job_row("job_c_default")["error"] == "Dibatalkan oleh admin")

    # =======================================================================
    print("--- queue list: explicit columns, no photo, flags ---")
    insert_job("job_list_img", "acct_q", "rejected", error="Foto buram")
    r = admin.get("/api/admin/queue?limit=200")
    payload = r.json()
    case("queue list never carries the photo", r.status_code == 200 and "IMG-SENTINEL" not in r.text
         and "image_b64" not in r.text)
    by_id = {job["id"]: job for job in payload["jobs"]}
    case("queue list flags what each row may do",
         by_id["job_list_img"]["canRequeue"] and not by_id["job_list_img"]["canCancel"]
         and not by_id["job_done"]["canRequeue"] and not by_id["job_done"]["canCancel"]
         and by_id["job_claim_fresh"]["canCancel"] and not by_id["job_claim_fresh"]["canRequeue"], list(by_id)[:3])
    case("queue list carries the owner and the tier", by_id["job_done"]["ownerEmail"] == "queue@example.com"
         and by_id["job_done"]["tier"] == "fast")
    problems = admin.get("/api/admin/queue?status=problem&limit=200").json()["jobs"]
    case("status=problem lists rejected and failed only", problems
         and all(job["status"] in ("rejected", "failed") for job in problems))
    seen_sql: list[str] = []
    conn = db.conn()
    conn.set_trace_callback(seen_sql.append)
    api_admin.admin_queue(limit=50, status=None, admin=ADMIN)
    conn.set_trace_callback(None)
    case("the queue list uses explicit columns (no SELECT *, no j.*)",
         seen_sql and not any(re.search(r"select\s+\*|j\.\*", sql, re.I) for sql in seen_sql), seen_sql[:2])
    case("the queue list loads trace lines in one query, not one per job",
         sum(1 for sql in seen_sql if "FROM job_events" in sql) == 1)

    # =======================================================================
    print("--- accounts: pagination + aggregate counts (finding 14) ---")
    base_ms = db.now_ms() - 10_000_000
    for i in range(40):
        insert_account(f"acct_p{i:02d}", f"page{i:02d}@example.com", created=base_ms + i * 10, name=f"Orang {i}")
    with db.transaction() as tx:
        tx.execute("INSERT INTO records(id,account_id,created_ms,updated_ms) VALUES ('rec_p1','acct_p05',1,1),"
                   "('rec_p2','acct_p05',1,1),('rec_p3','acct_p06',1,1)")
        tx.execute("INSERT INTO farms(id,account_id,name,ring_json,created_ms,updated_ms) VALUES "
                   "('farm_p1','acct_p05','Kebun','[]',1,1)")
    insert_job("job_p1", "acct_p05", "done")
    security.session_create("acct_p05", "ua", "1.1.1.1")
    first = admin.get("/api/admin/accounts?limit=15").json()
    case("paged accounts return items, a cursor and the total", len(first["items"]) == 15 and first["next"]
         and first["total"] == db.query_one("SELECT COUNT(*) AS n FROM accounts")["n"], first.get("total"))
    collected = list(first["items"])
    cursor = first["next"]
    while cursor:
        page = admin.get(f"/api/admin/accounts?limit=15&cursor={cursor}").json()
        collected += page["items"]
        cursor = page["next"]
    ids = [item["id"] for item in collected]
    case("paging returns every account once, newest first", len(ids) == len(set(ids)) == first["total"]
         and [i["createdMs"] for i in collected] == sorted([i["createdMs"] for i in collected], reverse=True))
    p05 = next(item for item in collected if item["id"] == "acct_p05")
    case("aggregate counts are right", p05["recordCount"] == 2 and p05["farmCount"] == 1 and p05["jobCount"] == 1
         and p05["sessionCount"] == 1 and p05["jobsToday"] == 1, p05)
    legacy = admin.get("/api/admin/accounts").json()
    case("without limit the legacy bare list still comes back", isinstance(legacy, list) and len(legacy) == first["total"])
    found = admin.get("/api/admin/accounts?limit=50&q=page0").json()
    case("search matches name or email", found["total"] == 10 and all("page0" in i["email"] for i in found["items"]))
    wild = admin.get("/api/admin/accounts?limit=50&q=%25").json()
    case("a percent sign in the search is literal, not a wildcard", wild["total"] == 0)
    inactive = admin.get("/api/admin/accounts?limit=50&status=inactive").json()
    case("filter by status", inactive["total"] >= 1 and all(not i["isActive"] for i in inactive["items"]))
    admins = admin.get("/api/admin/accounts?limit=50&role=admin").json()
    case("filter by role", admins["total"] >= 2 and all(i["role"] == "admin" for i in admins["items"]))
    case("a bad cursor is a clean 400", admin.get("/api/admin/accounts?limit=5&cursor=@@@").status_code == 400)
    case("a bad role filter is a clean 400", admin.get("/api/admin/accounts?limit=5&role=wizard").status_code == 400)
    seen_sql.clear()
    conn.set_trace_callback(seen_sql.append)
    rows40 = api_admin.list_accounts(q=None, limit=40, cursor=None, role=None, status=None, admin=ADMIN)
    conn.set_trace_callback(None)
    case("40 accounts need ONE query per count table, not one per account",
         len(rows40["items"]) == 40 and sum(1 for s in seen_sql if "FROM records" in s) == 1
         and sum(1 for s in seen_sql if "FROM farms" in s) == 1 and sum(1 for s in seen_sql if "FROM sessions" in s) == 1,
         [s[:80] for s in seen_sql if "FROM records" in s])

    # =======================================================================
    print("--- last admin: the check runs INSIDE the transaction (finding 10) ---")
    with db.transaction() as tx:
        tx.execute("DELETE FROM accounts WHERE role = 'admin' AND id NOT IN (?, ?)", (ADMIN_ID, BOSS2["id"]))
    seen_sql.clear()
    conn.set_trace_callback(seen_sql.append)
    api_admin.admin_update_account(BOSS2["id"], {"role": "user"}, request=None, admin=ADMIN)
    conn.set_trace_callback(None)
    flat = [s.strip().upper() for s in seen_sql]
    begin = next(i for i, s in enumerate(flat) if s.startswith("BEGIN"))
    count_sql = next(i for i, s in enumerate(flat) if "COUNT(*)" in s and "ROLE = 'ADMIN'" in s)
    update_sql = next(i for i, s in enumerate(flat) if s.startswith("UPDATE ACCOUNTS"))
    commit = next(i for i, s in enumerate(flat) if i > update_sql and s.startswith("COMMIT"))
    case("the admin count is read after BEGIN and before the UPDATE and COMMIT", begin < count_sql < update_sql < commit,
         (begin, count_sql, update_sql, commit))
    from fastapi import HTTPException  # noqa: E402
    try:
        api_admin.admin_update_account(ADMIN_ID, {"role": "user"}, request=None, admin=ADMIN)
        last_admin_blocked = False
    except HTTPException as exc:
        last_admin_blocked = exc.status_code == 400
    case("the last active admin cannot be demoted", last_admin_blocked and auth.find_by_id(ADMIN_ID)["role"] == "admin")
    r = admin.put(f"/api/admin/accounts/{ADMIN_ID}", {"isActive": False})
    case("an admin cannot deactivate themselves (400)", r.status_code == 400, r.text[:160])
    with db.transaction() as tx:
        tx.execute("UPDATE accounts SET role='admin' WHERE id=?", (BOSS2["id"],))
    errors: list[int] = []

    def demote(actor, target):
        try:
            api_admin.admin_update_account(target, {"role": "user"}, request=None, admin=actor)
            errors.append(200)
        except HTTPException as exc:
            errors.append(exc.status_code)

    threads = [threading.Thread(target=demote, args=(ADMIN, BOSS2["id"])),
               threading.Thread(target=demote, args=(auth.find_by_id(BOSS2["id"]), ADMIN_ID))]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    remaining = db.query_one("SELECT COUNT(*) AS n FROM accounts WHERE role='admin' AND is_active=1")["n"]
    case("two admins demoting each other at once: exactly one wins, one admin remains",
         sorted(errors) == [200, 400] and remaining == 1, (errors, remaining))
    with db.transaction() as tx:
        tx.execute("UPDATE accounts SET role='admin', is_active=1 WHERE id IN (?,?)", (ADMIN_ID, BOSS2["id"]))

    # =======================================================================
    print("--- account deletion with the photo lifecycle (contract 5.5) ---")
    insert_account("acct_del", "hapus@example.com", name="Akan Dihapus")
    FAKE.events.clear()
    r = admin.delete("/api/admin/accounts/acct_del")
    body = r.json()
    case("delete answers with the contract shape", r.status_code == 200 and body["ok"] is True
         and body["accountRemoved"] is True and body["photoCleanup"] == {
             "queued": 3, "blocked": 1, "pendingAfterDrain": 1, "cleaned": 2}
         and body["photoCleanupFailures"] == 2, body)
    case("the account is gone", auth.find_by_id("acct_del") is None)
    case("lock order: storage lock BEFORE the db transaction, drain AFTER commit",
         FAKE.events == ["lock-enter(db_locked=False)", "retire(db_locked=True,id=acct_del)", "lock-exit",
                         "drain(50,db_locked=False)"], FAKE.events)
    case("the deletion is audited with the photo numbers",
         "3 dijadwalkan" in last_audit("account.delete")["detail"] and last_audit("account.delete")["target"]
         == "hapus@example.com")
    FAKE.events.clear()
    r = admin.delete(f"/api/admin/accounts/{ADMIN_ID}")
    case("deleting yourself is refused (400) and no photo ticket is created", r.status_code == 400
         and not any(e.startswith("retire") for e in FAKE.events), (r.status_code, FAKE.events))
    case("deleting a missing account is 404", admin.delete("/api/admin/accounts/nope").status_code == 404)
    insert_account("acct_del2", "hapus2@example.com")
    FAKE.fail_retire = True
    FAKE.events.clear()
    r = admin.delete("/api/admin/accounts/acct_del2")
    case("a storage failure rolls the deletion back with a clear error", r.status_code == 500
         and r.json().get("code") == "storage_failed" and auth.find_by_id("acct_del2") is not None
         and "drain" not in " ".join(FAKE.events), (r.status_code, r.text[:200]))
    FAKE.fail_retire = False
    with storage_missing():
        r = admin.delete("/api/admin/accounts/acct_del2")
        case("without the storage module the delete is refused (503) and the account stays",
             r.status_code == 503 and r.json().get("code") == "storage_unavailable"
             and auth.find_by_id("acct_del2") is not None, r.text[:200])
        r = admin.get("/api/admin/storage")
        case("the storage endpoint says so clearly", r.status_code == 503 and "Modul penyimpanan" in r.json()["detail"])
        r = admin.get("/api/admin/overview")
        case("the overview still renders without the storage module", r.status_code == 200
             and r.json()["pipeline"]["level"] in ("ok", "warn", "bad"))
    FAKE.drain_result = {"done": 3, "pending": 0, "blocked": 0}
    FAKE.retire_result = {"queued": 3, "blocked": 0}
    r = admin.delete("/api/admin/accounts/acct_del2")
    case("a clean deletion reports nothing left over", r.status_code == 200 and r.json()["photoCleanupFailures"] == 0
         and r.json()["photoCleanup"]["cleaned"] == 3, r.text[:200])

    r = admin.get("/api/admin/storage")
    case("GET /storage returns the lifecycle status", r.status_code == 200 and r.json()["done"] == 5
         and r.json()["available"] is True, r.text[:200])
    FAKE.events.clear()
    r = admin.post("/api/admin/storage/inventory")
    case("inventory is report-only and returns the scan", r.status_code == 200
         and r.json()["unreferencedCount"] == 1 and FAKE.events == ["inventory"], r.text[:200])
    case("inventory is audited", "tidak terpakai 1" in last_audit("storage.inventory")["detail"])

    # =======================================================================
    print("--- overview: one honest health answer ---")
    os.environ["NINEROUTER_KEY"] = "synthetic-router-key-123456"
    original_worker_status = getattr(queue, "worker_status", None)

    def overview_pipeline(status):
        queue.worker_status = lambda: status  # type: ignore[attr-defined]
        return admin.get("/api/admin/overview").json()

    now = db.now_ms()
    with db.transaction() as tx:
        tx.execute("DELETE FROM jobs")
    data = overview_pipeline({"lastSeenMs": now - 5000, "lastError": None, "lastErrorMs": None,
                              "authFailing": False, "stale": False})
    case("healthy worker + key + queue -> level ok", data["pipeline"]["level"] == "ok", data["pipeline"])
    data = overview_pipeline({"lastSeenMs": now - 5000, "lastError": "401", "lastErrorMs": now, "authFailing": True,
                              "stale": False})
    codes = [i["code"] for i in data["pipeline"]["issues"]]
    case("a worker whose router auth fails is a clear 'bad' banner", data["pipeline"]["level"] == "bad"
         and "worker_auth_failing" in codes and data["pipeline"]["issues"][0]["action"] == "settings", codes)
    insert_job("job_w1", "acct_q", "queued")
    data = overview_pipeline({"lastSeenMs": now - 900_000, "lastError": None, "lastErrorMs": None,
                              "authFailing": False, "stale": True})
    stale = [i for i in data["pipeline"]["issues"] if i["code"] == "worker_stale"]
    case("a stale worker with photos waiting is 'bad' and says how many", stale and stale[0]["level"] == "bad"
         and "1 foto" in stale[0]["text"], stale)
    data = overview_pipeline(None)
    case("when the worker status is unavailable the overview still works", data["worker"] is None
         and data["pipeline"]["level"] in ("ok", "warn"))
    if original_worker_status is not None:
        queue.worker_status = original_worker_status
    else:
        del queue.worker_status
    FAKE.status_result = {"pending": 2, "blocked": 4, "done": 9, "oldestPendingMs": now - 7_200_000,
                          "lastDrainMs": now, "blockedReasons": {"izin ditolak": 4}}
    data = admin.get("/api/admin/overview").json()
    codes = [i["code"] for i in data["pipeline"]["issues"]]
    case("blocked photo cleanup shows up as an issue", "storage_blocked" in codes and "storage_slow" in codes, codes)
    case("overview has no n8n field and lists the oldest waiting job",
         "oldestQueuedMs" in data and "n8nConfigured" not in admin.get("/api/admin/health").json())

    # =======================================================================
    print("--- secrets: hint, clear, hidden fields (finding 13) ---")
    r = admin.get("/api/admin/settings").json()
    items = {item["key"]: item for item in r["settings"]}
    hint = items["NINEROUTER_KEY"]["hint"]
    case("the hint shows at most the last 2 characters", hint == "••••ef" and items["NINEROUTER_KEY"]["value"] == "",
         hint)
    case("secrets and env fallbacks are marked", items["NINEROUTER_KEY"]["hasStored"] is True
         and items["NINEROUTER_URL"]["sensitive"] is True)
    case("unused settings are not offered", not ({"N8N_ANALYZE_WEBHOOK", "PLANT_ID_API_KEY", "DEFAULT_DAILY_QUOTA"}
                                                    & set(items)), sorted(items))
    r2 = admin.put("/api/admin/settings", {"settings": {"N8N_ANALYZE_WEBHOOK": "https://n8n.example/x"}})
    case("the removed n8n setting is no longer accepted", r2.status_code == 400)
    case("a short key reveals no characters at all", settings_store._secret_hint("abcdefgh") == "••••"  # noqa: SLF001
         and settings_store._secret_hint("") == "")  # noqa: SLF001
    case("a key with a space (a pasted 'Bearer x') is refused", admin.put(
        "/api/admin/settings", {"settings": {"GEOCODE_API_KEY": "Bearer abcdef"}, "currentPassword": ADMIN_PASSWORD}
    ).status_code == 400)
    r = admin.post("/api/admin/settings/NINEROUTER_KEY/clear", {})
    case("clearing a key needs the password", r.status_code == 403 and r.json()["code"] == "reauth_required")
    r = admin.post("/api/admin/settings/QUEUE_PACER_SECONDS/clear", {"currentPassword": ADMIN_PASSWORD})
    case("only secrets can be cleared", r.status_code == 404)
    os.environ["NINEROUTER_KEY"] = ""
    r = admin.post("/api/admin/settings/NINEROUTER_KEY/clear", {"currentPassword": ADMIN_PASSWORD})
    case("clearing a key with the password works", r.status_code == 200 and r.json()["cleared"] is True
         and r.json()["envFallback"] is False, r.text[:200])
    case("the key is gone", db.query_one("SELECT 1 FROM settings WHERE key='NINEROUTER_KEY'") is None)
    case("clearing is audited by key name", "NINEROUTER_KEY" in last_audit("setting.clear")["target"])
    data = admin.get("/api/admin/overview").json()
    case("a missing router key is called out with a next step", any(
        i["code"] == "router_key_missing" and i["action"] == "settings" for i in data["pipeline"]["issues"]))
    os.environ["NINEROUTER_KEY"] = "env-router-key-1234567890"
    items = {i["key"]: i for i in admin.get("/api/admin/settings").json()["settings"]}
    case("a key that exists only in .env is shown as such, with a 2-character hint",
         items["NINEROUTER_KEY"]["hasStored"] is False and items["NINEROUTER_KEY"]["hasEnvFallback"] is True
         and items["NINEROUTER_KEY"]["hint"] == "••••90")
    os.environ["NINEROUTER_KEY"] = ""

    # =======================================================================
    print("--- failed re-authentication is throttled ---")
    codes = []
    for _ in range(7):
        codes.append(admin.post("/api/admin/accounts", {"email": "boss3@example.com", "name": "x",
                                                         "password": "BossTigaPassword12", "role": "admin",
                                                         "currentPassword": "salah-salah-1"}).status_code)
    case("repeated wrong passwords are locked out (429)", codes[:5] == [403] * 5 and 429 in codes[5:], codes)
    r = admin.post("/api/admin/accounts", {"email": "boss3@example.com", "name": "x",
                                           "password": "BossTigaPassword12", "role": "admin",
                                           "currentPassword": ADMIN_PASSWORD})
    case("the lock holds even for the right password", r.status_code == 429 and "Retry-After" in r.headers)
    with db.transaction() as tx:
        tx.execute("DELETE FROM login_attempts")
    r = admin.post("/api/admin/accounts", {"email": "boss3@example.com", "name": "x",
                                           "password": "BossTigaPassword12", "role": "admin",
                                           "currentPassword": ADMIN_PASSWORD})
    case("after the lock clears the right password works", r.status_code == 200, r.text[:160])
    with db.transaction() as tx:
        tx.execute("DELETE FROM login_attempts")

    # =======================================================================
    print("--- the page: CSP-clean, no CDN, no inline code ---")
    html = (BASE / "frontend" / "admin.html").read_text(encoding="utf-8")
    js_path = BASE / "frontend" / "admin.js"
    case("admin.js exists", js_path.exists())
    js = js_path.read_text(encoding="utf-8") if js_path.exists() else ""
    inline_scripts = [m for m in re.findall(r"<script\b([^>]*)>(.*?)</script>", html, re.S | re.I)
                      if "src=" not in m[0] or m[1].strip()]
    case("admin.html has no inline <script>", not inline_scripts, inline_scripts[:1])
    handlers = re.findall(r"\son[a-z]+\s*=", html, re.I)
    case("admin.html has no inline event handlers", not handlers, handlers[:3])
    case("admin.js builds no inline event handlers", not re.search(r"\bon(click|change|input|submit|keydown|load)\s*=", js))
    external = [u for u in re.findall(r"""(?:src|href)\s*=\s*["'](https?://[^"']+)""", html)]
    case("admin.html references nothing external", not external, external)
    case("no CDN or Google Fonts anywhere", not re.search(r"cdn\.tailwindcss|unpkg\.com|googleapis|gstatic|jsdelivr", html + js))
    case("local assets are used", all(token in html for token in (
        "/vendor/tailwind.generated.css", "/vendor/lucide-0.468.0.umd.min.js", "/admin.js", "/ui-kit.css",
        "/vendor/fonts/google-sans/GoogleSans-latin.woff")))
    case("no eval / Function / document.write in admin.js", not re.search(r"\beval\s*\(|new\s+Function|document\.write", js))
    views = re.findall(r'<(?:div|main|section)[^>]*\bid="(login-view|denied-view|console-view)"[^>]*>', html)
    case("every view starts hidden by attribute, not by class alone",
         len(views) == 3 and all(re.search(r"\bhidden\b", tag) for tag in re.findall(
             r'<(?:div|main|section)[^>]*\bid="(?:login-view|denied-view|console-view)"[^>]*>', html)))
    case("a hidden rule survives a missing stylesheet", "[hidden]" in html)

# ---------------------------------------------------------------------------
router_server.shutdown()
db.close_all()
passed = sum(1 for _, ok, _ in CASES if ok)
print()
print(f"admin-0220: {passed}/{len(CASES)} assertions passed")
for name, ok, detail in CASES:
    if not ok:
        print("  FAILED:", name, "::", str(detail)[:300])
sys.exit(0 if passed == len(CASES) else 1)
