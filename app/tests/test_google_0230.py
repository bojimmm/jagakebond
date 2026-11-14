"""Sign in with Google + admin registration inbox (0.2.3.0) — HTTP-level tests, synthetic fixtures only.

Run:  cd app && python tests/test_google_0230.py

Tokens are signed with an RSA key generated here and served through a patched JWKS fetch, so no
request ever leaves the machine. A throwaway SQLite file is used. Covers CONTRACT-0230-google.md:
disabled mode, linked login, e-mail linking, pending/rejected/approved registrations, every claim
check (signature, aud, iss, exp, iat, email_verified, nonce missing/reused/expired), inactive
accounts, the 200-request cap, the nonce cap, the per-IP throttle, the JWKS cache and refetch,
CSP/COOP headers, schema 11 (fresh and upgraded from 9) and reset_for_tests.
"""

from __future__ import annotations

import base64
import json
import os
import sys
import tempfile
import time
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))

TMP = Path(tempfile.mkdtemp(prefix="jk-google-0230-", dir=os.environ.get("TMPDIR") or None))
ADMIN_EMAIL = "admin@jagakebond.local"
ADMIN_PASSWORD = "AdminLokal123"
WEB_CLIENT = "123456-web.apps.googleusercontent.test"
OTHER_CLIENT = "123456-other.apps.googleusercontent.test"
os.environ.update({
    "COOKIE_SECURE": "0", "SECRET_KEY": "synthetic-google-0230-secret-key", "WORKER_TOKEN": "synthetic-worker-token",
    "ADMIN_EMAIL": ADMIN_EMAIL, "ADMIN_PASSWORD": ADMIN_PASSWORD, "ALLOW_REGISTRATION": "0",
    "SEED_DEMO_DATA": "0", "NINEROUTER_KEY": "", "NINEROUTER_URL": "http://127.0.0.1:9",
})
os.environ.pop("GOOGLE_CLIENT_ID", None)

from backend import db  # noqa: E402

db.close_all()
db.DB_PATH = TMP / "google.sqlite3"

from cryptography.hazmat.primitives import hashes  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import padding, rsa  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend import app as app_module  # noqa: E402
from backend import auth, google_auth, security  # noqa: E402
from backend.app import app  # noqa: E402

CASES: list[tuple[str, bool, str]] = []


def case(name: str, ok: bool, detail: object = "") -> None:
    CASES.append((name, bool(ok), str(detail)))
    print(("PASS " if ok else "FAIL ") + name + ("" if ok or not detail else " :: " + str(detail)[:300]), flush=True)


def section(title: str) -> None:
    print(f"--- {title} ---", flush=True)


# ---------------------------------------------------------------------------
# Synthetic Google: two signing keys and a patched JWKS fetch
# ---------------------------------------------------------------------------

def b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def jwk(kid: str, private_key) -> dict:
    numbers = private_key.public_key().public_numbers()
    size = (numbers.n.bit_length() + 7) // 8
    return {"kty": "RSA", "alg": "RS256", "use": "sig", "kid": kid,
            "n": b64u(numbers.n.to_bytes(size, "big")), "e": b64u(numbers.e.to_bytes(3, "big"))}


KEY_1 = rsa.generate_private_key(public_exponent=65537, key_size=2048)
KEY_2 = rsa.generate_private_key(public_exponent=65537, key_size=2048)
KEY_ROTATED = rsa.generate_private_key(public_exponent=65537, key_size=2048)
JWKS = {"doc": {"keys": [jwk("k1", KEY_1)]}, "calls": 0, "fail": False}


def fake_fetch():
    JWKS["calls"] += 1
    if JWKS["fail"]:
        raise google_auth.GoogleKeysUnavailable("synthetic outage")
    return json.loads(json.dumps(JWKS["doc"])), 3600


google_auth._fetch_jwks = fake_fetch


def mint(nonce: str | None, sub: str = "100000000000000000001", email: str = "petani.baru@example.test",
         key=KEY_1, kid: str = "k1", alg: str = "RS256", **overrides) -> str:
    now = int(time.time())
    claims = {"iss": "https://accounts.google.com", "aud": WEB_CLIENT, "azp": WEB_CLIENT, "sub": sub,
              "email": email, "email_verified": True, "name": "Petani Baru", "iat": now, "exp": now + 3600}
    if nonce is not None:
        claims["nonce"] = nonce
    for name, value in overrides.items():
        if value is None:
            claims.pop(name, None)
        else:
            claims[name] = value
    header = b64u(json.dumps({"alg": alg, "kid": kid, "typ": "JWT"}).encode())
    body = b64u(json.dumps(claims).encode())
    signature = key.sign(f"{header}.{body}".encode(), padding.PKCS1v15(), hashes.SHA256())
    return f"{header}.{body}.{b64u(signature)}"


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def new_client(ip: str = "203.0.113.20") -> TestClient:
    return TestClient(app, client=(ip, 50000), raise_server_exceptions=False)


def nonce_for(client: TestClient) -> str:
    response = client.post("/api/auth/google/nonce", json={})
    assert response.status_code == 200, response.text
    return response.json()["nonce"]


def google(client: TestClient, **kwargs):
    """One complete sign-in attempt with a fresh nonce; kwargs go to mint()."""
    nonce = nonce_for(client)
    return client.post("/api/auth/google", json={"credential": mint(nonce, **kwargs), "nonce": nonce})


def csrf(client: TestClient) -> dict[str, str]:
    return {"X-CSRF-Token": client.cookies.get("jk_csrf") or ""}


def clear_throttle() -> None:
    with db.transaction() as tx:
        tx.execute("DELETE FROM login_attempts")


def make_account(email: str, active: int = 1, role: str = "user") -> str:
    ident = db.new_id("acct")
    now = db.now_ms()
    with db.transaction() as tx:
        tx.execute("INSERT INTO accounts(id,email,name,role,password_hash,is_active,daily_quota,created_ms,updated_ms) "
                   "VALUES (?,?,?,?,?,?,0,?,?)",
                   (ident, email, email.split("@")[0], role, security.hash_password("SandiPetani123"), active, now, now))
    return ident


def requests_for(sub: str) -> list[dict]:
    return db.query("SELECT * FROM registration_requests WHERE sub = ?", (sub,))


def audit_actions() -> list[str]:
    return [row["action"] for row in db.query("SELECT action FROM audit_log ORDER BY id")]


auth.bootstrap()
app_module.MAINTENANCE_FIRST_RUN_SECONDS = 3600

try:
    # =======================================================================
    section("schema 11")
    tables = {row["name"] for row in db.query("SELECT name FROM sqlite_master WHERE type='table'")}
    case("migrate() reaches schema 11", db.migrate() == 11 == db.SCHEMA_VERSION)
    case("the three new tables exist", {"google_identities", "registration_requests", "auth_nonces"} <= tables,
         sorted(tables))
    columns = {row["name"] for row in db.query("PRAGMA table_info(registration_requests)")}
    case("registration_requests has the contract columns",
         columns == {"id", "sub", "email", "name", "status", "created_ms", "updated_ms", "decided_ms",
                     "decided_by", "account_id"}, sorted(columns))
    try:
        with db.transaction() as tx:
            tx.execute("INSERT INTO registration_requests (id, sub, email, status) VALUES ('x','x','x@y.test','maybe')")
        bad_status = False
    except Exception:  # noqa: BLE001 - sqlite3.IntegrityError
        bad_status = True
    case("status is limited to pending/approved/rejected", bad_status)

    # =======================================================================
    section("disabled until GOOGLE_CLIENT_ID is set")
    anon = new_client()
    config = anon.get("/api/auth/google/config")
    case("config says enabled=false with no client id",
         config.status_code == 200 and config.json() == {"enabled": False, "clientId": None}, config.text)
    nonce_off = anon.post("/api/auth/google/nonce", json={})
    case("nonce route answers 404 google_disabled", nonce_off.status_code == 404 and nonce_off.json().get("code") == "google_disabled",
         nonce_off.text)
    with mock.patch.object(auth.settings_store, "as_bool", return_value=False):
        closed_options = anon.get("/api/auth/options")
    with mock.patch.object(auth.settings_store, "as_bool", return_value=True):
        open_options = anon.get("/api/auth/options")
    case("public auth options reveal only the password registration capability",
         closed_options.json() == {"passwordRegistration": False}
         and open_options.json() == {"passwordRegistration": True})
    case("public auth options are not cached", "no-store" in closed_options.headers.get("cache-control", ""))
    for public_path in ("/privacy", "/privacy.html", "/terms", "/terms.html"):
        public_page = anon.get(public_path)
        case(f"{public_path} is public HTML with owner-approved contact information",
             public_page.status_code == 200 and "text/html" in public_page.headers.get("content-type", "")
             and "adzril.taibkhadzim@gmail.com" in public_page.text and "<html lang=\"id\"" in public_page.text)
        case(f"{public_path} needs no session and keeps security headers",
             not public_page.cookies.get("jk_session") and "content-security-policy" in public_page.headers)
    post_off = anon.post("/api/auth/google", json={"credential": "x.y.z", "nonce": "n" * 32})
    case("sign-in route answers 404 google_disabled", post_off.status_code == 404 and post_off.json().get("code") == "google_disabled",
         post_off.text)
    case("health reports googleSignIn: false", anon.get("/api/health").json()["capabilities"]["googleSignIn"] is False)
    page = anon.get("/")
    case("field app CSP is unchanged while disabled",
         page.headers.get("content-security-policy") == app_module.APP_CSP and "accounts.google.com" not in page.text,
         page.headers.get("content-security-policy"))
    case("no Google script is referenced by index.html", "accounts.google.com/gsi/client" not in page.text)

    os.environ["GOOGLE_CLIENT_ID"] = WEB_CLIENT + ", " + OTHER_CLIENT

    # =======================================================================
    section("enabled: config, headers, health")
    config = anon.get("/api/auth/google/config")
    case("config returns the web client id", config.json() == {"enabled": True, "clientId": WEB_CLIENT}, config.text)
    case("health reports googleSignIn: true", anon.get("/api/health").json()["capabilities"]["googleSignIn"] is True)
    page = anon.get("/")
    csp = page.headers.get("content-security-policy", "")
    directives = {part.strip().split(" ", 1)[0]: part.strip() for part in csp.split(";") if part.strip()}
    case("script-src allows only the GIS client script", "https://accounts.google.com/gsi/client" in directives.get("script-src", "")
         and directives["script-src"].count("https://") == 1, directives.get("script-src"))
    case("frame-src, connect-src and style-src allow the GIS paths",
         "https://accounts.google.com/gsi/" in directives.get("frame-src", "")
         and "https://accounts.google.com/gsi/" in directives.get("connect-src", "")
         and "https://accounts.google.com/gsi/style" in directives.get("style-src", ""), csp)
    case("everything else stays as strict as before",
         directives.get("default-src") == "default-src 'self'" and directives.get("object-src") == "object-src 'none'"
         and directives.get("frame-ancestors") == "frame-ancestors 'none'", csp)
    case("field app sends COOP same-origin-allow-popups (Google popup)",
         page.headers.get("cross-origin-opener-policy") == "same-origin-allow-popups", page.headers.get("cross-origin-opener-policy"))
    admin_page = anon.get("/admin")
    case("/admin keeps its strict CSP (no Google)", admin_page.headers.get("content-security-policy") == app_module.ADMIN_CSP,
         admin_page.headers.get("content-security-policy"))
    api_headers = anon.get("/api/health").headers
    case("API responses carry no CSP", "content-security-policy" not in api_headers)

    # =======================================================================
    section("nonces")
    first = anon.post("/api/auth/google/nonce", json={}).json()
    case("a nonce is random, url-safe and lives 10 minutes",
         len(first["nonce"]) >= 32 and first["expiresMs"] - db.now_ms() > 9 * 60_000
         and db.query_one("SELECT expires_ms FROM auth_nonces WHERE nonce = ?", (first["nonce"],)) is not None)
    case("two nonces differ", first["nonce"] != anon.post("/api/auth/google/nonce", json={}).json()["nonce"])
    case("consume_nonce is single use", google_auth.consume_nonce(first["nonce"]) and not google_auth.consume_nonce(first["nonce"]))
    with db.transaction() as tx:
        tx.execute("INSERT INTO auth_nonces (nonce, expires_ms) VALUES ('expired-nonce-aaaaaaaaaaaa', 1)")
    anon.post("/api/auth/google/nonce", json={})
    case("issuing a nonce purges expired rows",
         db.query_one("SELECT 1 AS x FROM auth_nonces WHERE nonce = 'expired-nonce-aaaaaaaaaaaa'") is None)
    with mock.patch.object(google_auth, "NONCE_MAX_LIVE", db.query_one("SELECT COUNT(*) AS n FROM auth_nonces")["n"]):
        full = anon.post("/api/auth/google/nonce", json={})
    case("at most NONCE_MAX_LIVE live nonces (429 nonce_limit)", full.status_code == 429 and full.json().get("code") == "nonce_limit",
         full.text)
    with db.transaction() as tx:
        tx.execute("INSERT INTO auth_nonces (nonce, expires_ms) VALUES ('expired-nonce-bbbbbbbbbbbb', 1)")
    purged = security.purge_retention()
    case("the hourly purge removes expired nonces", purged.get("authNonces", 0) >= 1, purged)

    # =======================================================================
    section("unknown Google account -> pending registration")
    farmer = new_client("203.0.113.21")
    reply = google(farmer, sub="200000000000000000001", email="baru@example.test", name="Pak Baru")
    case("unknown account answers 202 registration_pending",
         reply.status_code == 202 and reply.json().get("code") == "registration_pending"
         and reply.json().get("detail") == google_auth.PENDING_DETAIL, reply.text)
    case("no session cookie is set for a pending request", not farmer.cookies.get("jk_session"))
    rows = requests_for("200000000000000000001")
    case("one pending request with sub, email and name",
         len(rows) == 1 and rows[0]["status"] == "pending" and rows[0]["email"] == "baru@example.test"
         and rows[0]["name"] == "Pak Baru", rows)
    case("the request is audited", "registration.request" in audit_actions())
    time.sleep(0.01)
    again = google(farmer, sub="200000000000000000001", email="baru@example.test", name="Pak Baru Tani")
    rows2 = requests_for("200000000000000000001")
    case("repeating is still ONE request, refreshed",
         again.status_code == 202 and len(rows2) == 1 and rows2[0]["updated_ms"] > rows[0]["updated_ms"]
         and rows2[0]["name"] == "Pak Baru Tani" and rows2[0]["id"] == rows[0]["id"], rows2)
    case("refreshing writes no second audit row", audit_actions().count("registration.request") == 1)
    case("no account was created", auth.find_by_email("baru@example.test") is None)

    # =======================================================================
    section("admin inbox: approve")
    admin = new_client("203.0.113.5")
    case("admin logs in", admin.post("/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}).status_code == 200)
    inbox = admin.get("/api/admin/registrations")
    body = inbox.json()
    pending_id = rows[0]["id"]
    case("inbox lists the pending request with email, name and time",
         inbox.status_code == 200 and body["enabled"] is True and body["pending"] == 1
         and body["items"][0]["id"] == pending_id and body["items"][0]["email"] == "baru@example.test"
         and body["items"][0]["name"] == "Pak Baru Tani" and body["items"][0]["createdMs"], body)
    case("inbox never exposes the Google sub", "200000000000000000001" not in inbox.text)
    case("overview counts pending registrations", admin.get("/api/admin/overview").json().get("pendingRegistrations") == 1)
    no_pw = admin.post(f"/api/admin/registrations/{pending_id}/approve", json={}, headers=csrf(admin))
    case("approve without the admin password: 403 reauth_required",
         no_pw.status_code == 403 and no_pw.json().get("code") == "reauth_required", no_pw.text)
    wrong = admin.post(f"/api/admin/registrations/{pending_id}/approve", json={"currentPassword": "salah-sekali"}, headers=csrf(admin))
    case("approve with a wrong password: 403 reauth_failed", wrong.status_code == 403 and wrong.json().get("code") == "reauth_failed",
         wrong.text)
    clear_throttle()
    ok = admin.post(f"/api/admin/registrations/{pending_id}/approve", json={"currentPassword": ADMIN_PASSWORD}, headers=csrf(admin))
    case("approve with the password: 200", ok.status_code == 200 and ok.json()["account"]["email"] == "baru@example.test", ok.text)
    created = auth.find_by_email("baru@example.test") or {}
    case("a 'user' account named after the request was created",
         created.get("role") == "user" and created.get("is_active") == 1 and created.get("name") == "Pak Baru Tani", created)
    case("its password hash is the unusable marker", created.get("password_hash") == security.UNUSABLE_PASSWORD_HASH
         and not security.password_usable(created.get("password_hash")))
    case("verify_password always rejects the marker", not security.verify_password("", security.UNUSABLE_PASSWORD_HASH)
         and not security.verify_password("!google-only", security.UNUSABLE_PASSWORD_HASH))
    link = db.query_one("SELECT * FROM google_identities WHERE sub = ?", ("200000000000000000001",)) or {}
    case("the sub is linked to the new account", link.get("account_id") == created.get("id"), link)
    decided = requests_for("200000000000000000001")[0]
    case("the request is approved, with who and when", decided["status"] == "approved" and decided["decided_by"] == ADMIN_EMAIL
         and decided["decided_ms"] and decided["account_id"] == created.get("id"), decided)
    case("approval is audited", "registration.approve" in audit_actions() and "account.create" in audit_actions())
    twice = admin.post(f"/api/admin/registrations/{pending_id}/approve", json={"currentPassword": ADMIN_PASSWORD}, headers=csrf(admin))
    case("approving twice: 409 registration_decided", twice.status_code == 409 and twice.json().get("code") == "registration_decided",
         twice.text)
    case("inbox is empty again", admin.get("/api/admin/registrations").json()["items"] == [])
    accounts = admin.get("/api/admin/accounts?limit=50").json()["items"]
    case("the account list marks the Google-linked account",
         any(a["email"] == "baru@example.test" and a["googleLinked"] is True for a in accounts)
         and any(a["email"] == ADMIN_EMAIL and a["googleLinked"] is False for a in accounts))

    # =======================================================================
    section("approved -> Google sign-in works; password login does not")
    signed = google(farmer, sub="200000000000000000001", email="baru@example.test")
    payload = signed.json()
    case("the next Google sign-in creates a session", signed.status_code == 200 and payload.get("ok") is True
         and payload["account"]["id"] == created.get("id") and farmer.cookies.get("jk_session"), signed.text)
    case("CSRF token in the body equals the cookie", payload.get("csrf") and payload["csrf"] == farmer.cookies.get("jk_csrf"))
    cookie = signed.headers.get("set-cookie", "")
    case("session cookie: HttpOnly, SameSite=Lax, 30-day Max-Age (same as password login)",
         "jk_session=" in cookie and "HttpOnly" in cookie and "samesite=lax" in cookie.lower()
         and f"Max-Age={30 * 86400}" in cookie, cookie[:300])
    session_row = db.query_one("SELECT expires_ms - created_ms AS ttl FROM sessions WHERE account_id = ? ORDER BY created_ms DESC",
                               (created.get("id"),))
    case("session row lives exactly as long as the cookie", session_row and session_row["ttl"] == 30 * 86_400_000, session_row)
    me = farmer.get("/api/auth/me").json()
    case("/api/auth/me sees the signed-in account", me.get("ok") is True and me["account"]["email"] == "baru@example.test")
    case("a CSRF-protected call works with the new session",
         farmer.post("/api/auth/sessions/revoke", json={}, headers=csrf(farmer)).status_code == 200)
    case("last_login_ms is stamped on the account and the link",
         (auth.find_by_id(created["id"]) or {}).get("last_login_ms")
         and (db.query_one("SELECT last_login_ms FROM google_identities WHERE sub = ?", ("200000000000000000001",)) or {}).get("last_login_ms"))
    for guess in ("", "!google-only", security.UNUSABLE_PASSWORD_HASH, "SandiPetani123"):
        refused = new_client("203.0.113.22").post("/api/auth/login", json={"email": "baru@example.test", "password": guess})
        if refused.status_code != 401:
            break
    case("password login is impossible for a Google-only account", refused.status_code == 401, refused.text)
    clear_throttle()
    with mock.patch.object(security, "verify_password", wraps=security.verify_password) as spy:
        new_client("203.0.113.22").post("/api/auth/login", json={"email": "baru@example.test", "password": "apa-saja-123"})
    case("a Google-only account still costs one full scrypt (no enumeration oracle)",
         spy.call_count == 1 and spy.call_args[0][1] == security.DUMMY_PASSWORD_HASH, spy.call_args)
    clear_throttle()
    reset = admin.post(f"/api/admin/accounts/{created['id']}/password",
                       json={"password": "SandiBaru12345", "passwordConfirm": "SandiBaru12345"}, headers=csrf(admin))
    later = new_client("203.0.113.23").post("/api/auth/login", json={"email": "baru@example.test", "password": "SandiBaru12345"})
    case("once an admin sets a password, password login works too", reset.status_code == 200 and later.status_code == 200,
         (reset.text[:120], later.text[:120]))

    # =======================================================================
    section("same e-mail as an existing account -> linked")
    ani_id = make_account("ani@example.test")
    ani = new_client("203.0.113.24")
    linked = google(ani, sub="300000000000000000001", email="ANI@Example.test", name="Ani")
    case("an active account with the same e-mail (any case) signs in", linked.status_code == 200
         and linked.json()["account"]["id"] == ani_id, linked.text)
    case("the sub is now linked to it", (db.query_one("SELECT account_id FROM google_identities WHERE sub = ?",
                                                      ("300000000000000000001",)) or {}).get("account_id") == ani_id)
    case("no registration request was made for it", not requests_for("300000000000000000001"))
    again = google(new_client("203.0.113.24"), sub="300000000000000000001", email="ani@example.test")
    case("the linked sub keeps signing in", again.status_code == 200 and again.json()["account"]["id"] == ani_id)
    case("the account's own password still works",
         new_client("203.0.113.25").post("/api/auth/login", json={"email": "ani@example.test", "password": "SandiPetani123"}).status_code == 200)
    conflict = google(new_client("203.0.113.24"), sub="300000000000000000999", email="ani@example.test")
    case("another Google identity with that e-mail is not linked (403 google_link_conflict)",
         conflict.status_code == 403 and conflict.json().get("code") == "google_link_conflict", conflict.text)
    clear_throttle()

    # =======================================================================
    section("inactive accounts")
    with db.transaction() as tx:
        tx.execute("UPDATE accounts SET is_active = 0 WHERE id = ?", (ani_id,))
    off = google(new_client("203.0.113.26"), sub="300000000000000000001", email="ani@example.test")
    case("a linked but inactive account: 403 Akun dinonaktifkan",
         off.status_code == 403 and off.json().get("detail") == "Akun dinonaktifkan" and off.json().get("code") == "account_inactive",
         off.text)
    make_account("tidur@example.test", active=0)
    sleeping = google(new_client("203.0.113.26"), sub="300000000000000000002", email="tidur@example.test")
    case("an inactive account with the same e-mail: 403 and no request",
         sleeping.status_code == 403 and not requests_for("300000000000000000002"), sleeping.text)
    clear_throttle()

    # =======================================================================
    section("reject")
    reject_client = new_client("203.0.113.27")
    google(reject_client, sub="400000000000000000001", email="ditolak@example.test")
    reject_id = requests_for("400000000000000000001")[0]["id"]
    no_pw = admin.post(f"/api/admin/registrations/{reject_id}/reject", json={}, headers=csrf(admin))
    case("reject without the admin password: 403 reauth_required",
         no_pw.status_code == 403 and no_pw.json().get("code") == "reauth_required", no_pw.text)
    rejected = admin.post(f"/api/admin/registrations/{reject_id}/reject", json={"currentPassword": ADMIN_PASSWORD}, headers=csrf(admin))
    row = requests_for("400000000000000000001")[0]
    case("reject with the password: 200, status rejected, audited",
         rejected.status_code == 200 and row["status"] == "rejected" and row["decided_by"] == ADMIN_EMAIL
         and "registration.reject" in audit_actions(), rejected.text)
    after = google(reject_client, sub="400000000000000000001", email="ditolak@example.test")
    case("a rejected request answers 403 registration_rejected",
         after.status_code == 403 and after.json().get("code") == "registration_rejected", after.text)
    case("...and stays rejected (no new pending row)", [r["status"] for r in requests_for("400000000000000000001")] == ["rejected"])
    case("no account for a rejected request", auth.find_by_email("ditolak@example.test") is None)
    case("rejected requests are listed with ?status=rejected",
         [i["email"] for i in admin.get("/api/admin/registrations?status=rejected").json()["items"]] == ["ditolak@example.test"])
    case("rejecting twice: 409", admin.post(f"/api/admin/registrations/{reject_id}/reject", json={"currentPassword": ADMIN_PASSWORD},
                                            headers=csrf(admin)).status_code == 409)
    case("unknown request id: 404", admin.post("/api/admin/registrations/reg_nope/approve", json={"currentPassword": ADMIN_PASSWORD},
                                               headers=csrf(admin)).status_code == 404)
    farmer_inbox = farmer.get("/api/admin/registrations")
    case("a farmer cannot read the inbox (403)", farmer_inbox.status_code in (401, 403), farmer_inbox.status_code)

    # an approval whose e-mail meanwhile got an account is refused, not merged
    google(new_client("203.0.113.28"), sub="500000000000000000001", email="kembar@example.test")
    twin_id = requests_for("500000000000000000001")[0]["id"]
    make_account("kembar@example.test")
    twin = admin.post(f"/api/admin/registrations/{twin_id}/approve", json={"currentPassword": ADMIN_PASSWORD}, headers=csrf(admin))
    case("approve when the e-mail already has an account: 409 email_taken",
         twin.status_code == 409 and twin.json().get("code") == "email_taken"
         and requests_for("500000000000000000001")[0]["status"] == "pending", twin.text)
    clear_throttle()

    # =======================================================================
    section("every claim check -> 401")
    bad = new_client("203.0.113.30")

    def refused(label: str, response, code: str = "google_token_invalid") -> None:
        case(label, response.status_code == 401 and response.json().get("code") == code, response.text[:200])
        clear_throttle()
        # Deliberately invalid tokens leave their nonces live. These claim tests are
        # independent; the per-IP nonce budget is exercised separately below.
        with db.transaction() as tx:
            tx.execute("DELETE FROM auth_nonces")

    refused("bad signature (signed with another key)", google(bad, key=KEY_2))
    refused("unknown kid", google(bad, kid="k-unknown"))
    refused("alg is not RS256", google(bad, alg="HS256"))
    refused("wrong aud", google(bad, aud="someone-else.apps.googleusercontent.test"))
    refused("wrong iss", google(bad, iss="https://evil.example"))
    refused("expired (exp 2 minutes ago, past the 60 s skew)", google(bad, exp=int(time.time()) - 120))
    refused("iat in the future", google(bad, iat=int(time.time()) + 600))
    refused("non-finite expiry", google(bad, exp=float("nan")))
    refused("non-finite issued-at", google(bad, iat=float("inf")))
    refused("email_verified false", google(bad, email_verified=False))
    refused("email_verified \"false\"", google(bad, email_verified="false"))
    refused("email_verified missing", google(bad, email_verified=None))
    refused("no sub", google(bad, sub=None))
    refused("no nonce claim in the token", bad.post("/api/auth/google", json={"credential": mint(None), "nonce": nonce_for(bad)}))
    n = nonce_for(bad)
    refused("missing credential", bad.post("/api/auth/google", json={"nonce": n}))
    refused("garbage credential", bad.post("/api/auth/google", json={"credential": "not-a-token", "nonce": n}))
    refused("tampered payload", bad.post("/api/auth/google", json={
        "credential": (lambda t: t.split(".")[0] + "." + b64u(json.dumps({"sub": "1", "nonce": n}).encode()) + "." + t.split(".")[2])(mint(n)),
        "nonce": n}))
    n = nonce_for(bad)
    refused("body nonce missing", bad.post("/api/auth/google", json={"credential": mint(n)}), "google_nonce_invalid")
    n = nonce_for(bad)
    refused("body nonce differs from the token nonce", bad.post("/api/auth/google", json={"credential": mint(n), "nonce": nonce_for(bad)}),
            "google_nonce_invalid")
    refused("a nonce the server never issued", bad.post("/api/auth/google", json={"credential": mint("x" * 32), "nonce": "x" * 32}),
            "google_nonce_invalid")
    n = nonce_for(bad)
    token = mint(n, sub="600000000000000000001", email="sekali@example.test")
    first_use = bad.post("/api/auth/google", json={"credential": token, "nonce": n})
    case("a good token is accepted once", first_use.status_code == 202, first_use.text)
    refused("the same nonce again (replay)", bad.post("/api/auth/google", json={"credential": token, "nonce": n}), "google_nonce_invalid")
    n = nonce_for(bad)
    with db.transaction() as tx:
        tx.execute("UPDATE auth_nonces SET expires_ms = ? WHERE nonce = ?", (db.now_ms() - 1, n))
    refused("an expired nonce", bad.post("/api/auth/google", json={"credential": mint(n), "nonce": n}), "google_nonce_invalid")
    case("no request was created by any refused attempt",
         db.query_one("SELECT COUNT(*) AS n FROM registration_requests WHERE sub = '100000000000000000001'")["n"] == 0)
    ok_iss = google(bad, sub="600000000000000000002", email="iss@example.test", iss="accounts.google.com")
    case("iss without https:// is accepted too", ok_iss.status_code == 202, ok_iss.text)
    ok_aud = google(bad, sub="600000000000000000003", email="aud@example.test", aud=OTHER_CLIENT)
    case("the second configured client id is accepted as aud", ok_aud.status_code == 202, ok_aud.text)
    ok_skew = google(bad, sub="600000000000000000004", email="skew@example.test", exp=int(time.time()) - 30,
                     iat=int(time.time()) + 30)
    case("exp/iat within the 60 s skew are accepted", ok_skew.status_code == 202, ok_skew.text)

    # =======================================================================
    section("JWKS cache")
    google_auth.reset_key_cache()
    JWKS["calls"] = 0
    google(bad, sub="700000000000000000001", email="cache1@example.test")
    google(bad, sub="700000000000000000002", email="cache2@example.test")
    case("keys are fetched once and cached", JWKS["calls"] == 1, JWKS["calls"])
    JWKS["doc"] = {"keys": [jwk("k1", KEY_1), jwk("k-new", KEY_ROTATED)]}
    google_auth._jwks["fetched"] -= google_auth.JWKS_REFETCH_MIN_SECONDS + 1
    rotated = google(bad, sub="700000000000000000003", email="rotated@example.test", key=KEY_ROTATED, kid="k-new")
    case("an unknown kid refetches once (Google rotated its keys)", rotated.status_code == 202 and JWKS["calls"] == 2,
         (rotated.status_code, JWKS["calls"]))
    google(bad, kid="k-other")
    clear_throttle()
    case("another unknown kid right after does not refetch again", JWKS["calls"] == 2, JWKS["calls"])
    case("Cache-Control max-age is honoured and bounded",
         google_auth._max_age("public, max-age=19800, must-revalidate, no-transform") == 19800
         and google_auth._max_age(None) == google_auth.JWKS_DEFAULT_MAX_AGE
         and google_auth._max_age("max-age=5") == google_auth.JWKS_MIN_MAX_AGE
         and google_auth._max_age("max-age=999999") == google_auth.JWKS_MAX_MAX_AGE)
    google_auth.reset_key_cache()
    JWKS["fail"] = True
    outage = google(bad, sub="700000000000000000004", email="outage@example.test")
    case("Google keys unreachable and nothing cached: 503 google_unavailable",
         outage.status_code == 503 and outage.json().get("code") == "google_unavailable", outage.text)
    calls_after_failure = JWKS["calls"]
    again_outage = google(bad, sub="700000000000000000004", email="outage@example.test")
    case("a cold-cache outage is negatively cached without another network timeout",
         again_outage.status_code == 503 and JWKS["calls"] == calls_after_failure)
    JWKS["fail"] = False
    google_auth._jwks["retry_after"] = 0.0
    google(bad, sub="700000000000000000005", email="warm@example.test")
    google_auth._jwks["expires"] = 0.0
    JWKS["fail"] = True
    stale = google(bad, sub="700000000000000000006", email="stale@example.test")
    case("an outage after a good fetch keeps using the cached keys", stale.status_code == 202, stale.text)
    JWKS["fail"] = False
    clear_throttle()

    # =======================================================================
    section("limits: 200 pending requests")
    pending_now = google_auth.pending_count()
    now = db.now_ms()
    with db.transaction() as tx:
        for i in range(google_auth.PENDING_CAP - pending_now):
            tx.execute("INSERT INTO registration_requests (id, sub, email, name, status, created_ms, updated_ms) "
                       "VALUES (?,?,?,?, 'pending', ?, ?)", (f"reg_fill{i:04d}", f"9{i:020d}", f"isi{i}@example.test", "", now, now))
    case("the inbox holds exactly 200 pending requests", google_auth.pending_count() == 200)
    full = google(new_client("203.0.113.40"), sub="800000000000000000001", email="penuh@example.test")
    case("request number 201 is refused (429 registration_full)",
         full.status_code == 429 and full.json().get("code") == "registration_full" and not requests_for("800000000000000000001"),
         full.text)
    refresh = google(new_client("203.0.113.40"), sub=f"9{0:020d}", email="isi0@example.test")
    case("an existing pending request can still be refreshed at the cap", refresh.status_code == 202, refresh.text)
    case("the admin list is capped at 200 rows", len(admin.get("/api/admin/registrations").json()["items"]) == 200)
    with db.transaction() as tx:
        tx.execute("DELETE FROM registration_requests WHERE id LIKE 'reg_fill%'")
    clear_throttle()

    # =======================================================================
    section("throttle: google:<ip>")
    hammer = new_client("198.51.100.77")
    held = nonce_for(hammer)
    codes = [google(hammer, key=KEY_2).status_code for _ in range(5)]
    locked = hammer.post("/api/auth/google", json={
        "credential": mint(held, sub="810000000000000000001", email="kunci@example.test"), "nonce": held})
    case("5 bad tokens from one IP, then even a good one is refused (429 + Retry-After)",
         codes == [401] * 5 and locked.status_code == 429 and locked.headers.get("retry-after"), (codes, locked.status_code))
    case("the lock also covers new nonces from that IP",
         hammer.post("/api/auth/google/nonce", json={}).status_code == 429)
    elsewhere = google(new_client("198.51.100.78"), sub="810000000000000000002", email="lain@example.test")
    case("another IP is unaffected", elsewhere.status_code == 202, elsewhere.text)
    case("Google uses a separate failure counter", db.query_one(
        "SELECT fails FROM login_attempts WHERE key = ?", (google_auth._throttle_key("198.51.100.77"),))["fails"] == 5)
    password_ok = new_client("198.51.100.77").post("/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    case("the Google lock does not lock password login from that IP", password_ok.status_code == 200, password_ok.status_code)
    clear_throttle()

    # =======================================================================
    section("security review: per-IP nonce and registration budgets")
    flood = new_client("198.51.100.90")
    issued = [nonce_for(flood) for _ in range(google_auth.NONCE_MAX_PER_IP)]
    denied = flood.post("/api/auth/google/nonce", json={})
    case("one IP may hold only 20 live nonces, with Retry-After",
         denied.status_code == 429 and denied.json().get("code") == "nonce_ip_limit"
         and int(denied.headers.get("retry-after", 0)) > 0, denied.text)
    case("a nonce flood leaves other IPs able to sign in",
         new_client("198.51.100.91").post("/api/auth/google/nonce", json={}).status_code == 200)
    google_auth.consume_nonce(issued[0])
    case("consuming a nonce releases one slot for that IP", flood.post("/api/auth/google/nonce", json={}).status_code == 200)
    with db.transaction() as tx:
        tx.execute("UPDATE auth_nonces SET expires_ms = 1 WHERE ip_hash = ?", (google_auth._ip_hash("198.51.100.90"),))
    case("expired nonces stop counting against the IP", flood.post("/api/auth/google/nonce", json={}).status_code == 200)
    with mock.patch.object(google_auth, "NONCE_MAX_PER_IP", 1):
        nonce_for(new_client("2001:db8:90::1"))
        ipv6 = new_client("2001:db8:90::2").post("/api/auth/google/nonce", json={})
    case("IPv6 address rotation within one /64 shares the nonce budget", ipv6.status_code == 429)
    budget_client = new_client("198.51.100.92")
    codes = [google(budget_client, sub=f"guard-budget-{i}", email=f"budget{i}@example.test").status_code
             for i in range(google_auth.REGISTRATION_MAX_PER_IP_DAY)]
    capped = google(budget_client, sub="guard-over", email="over@example.test")
    case("one IP can create at most 20 registration requests per day",
         codes == [202] * 20 and capped.status_code == 429 and capped.json().get("code") == "registration_ip_limit"
         and capped.headers.get("retry-after") and not requests_for("guard-over"), capped.text)
    repeat_budget = google(budget_client, sub="guard-budget-0", email="budget0@example.test")
    case("refreshing an existing request still works at the daily cap", repeat_budget.status_code == 202)
    case("a different IP has an independent registration budget",
         google(new_client("198.51.100.93"), sub="guard-other", email="other-budget@example.test").status_code == 202)
    with db.transaction() as tx:
        tx.execute("UPDATE google_request_limits SET window_start_ms = ? WHERE ip_hash = ?",
                   (db.now_ms() - 86_400_001, google_auth._ip_hash("198.51.100.92")))
    case("the registration budget renews after 24 hours",
         google(budget_client, sub="guard-next-day", email="next-day@example.test").status_code == 202)
    with db.transaction() as tx:
        tx.execute("UPDATE registration_requests SET created_ms = ?, updated_ms = ? WHERE sub = 'guard-budget-0'",
                   (db.now_ms() - 31 * 86_400_000, db.now_ms()))
        tx.execute("UPDATE registration_requests SET status = 'rejected', created_ms = 1 WHERE sub = 'guard-budget-1'")
        tx.execute("INSERT INTO google_request_limits VALUES ('expired-test-budget', 1, 20)")
    retention = security.purge_retention()
    case("pending registrations expire after 30 days even if refreshed",
         retention["pendingRegistrations"] >= 1 and not requests_for("guard-budget-0"))
    case("retention preserves rejection decisions", requests_for("guard-budget-1")[0]["status"] == "rejected")
    case("expired registration budgets are purged", retention["googleRequestLimits"] >= 1)

    # =======================================================================
    section("security review: account provenance and admin policy")
    safe = auth.create_account("admin-created@example.test", "SandiPetani123", actor=ADMIN_EMAIL)
    safe_client = new_client("198.51.100.94")
    safe_client.post("/api/auth/login", json={"email": safe["email"], "password": "SandiPetani123"})
    safe_google = google(new_client("198.51.100.94"), sub="guard-trusted", email=safe["email"])
    case("admin-created accounts auto-link even after a password login", safe_google.status_code == 200, safe_google.text)
    self_client = new_client("198.51.100.95")
    with mock.patch.object(auth.settings_store, "as_bool", return_value=True):
        registered = self_client.post("/api/auth/register", json={"email": "planted@example.test", "password": "SandiPetani123"})
    planted = auth.find_by_email("planted@example.test")
    pending_link = google(new_client("198.51.100.95"), sub="guard-planted", email="planted@example.test")
    case("self-registration cannot pre-hijack a Google account before its first password login",
         registered.status_code == 200 and planted["last_password_login_ms"] is not None
         and pending_link.status_code == 202 and not db.query_one("SELECT 1 FROM google_identities WHERE sub = 'guard-planted'"),
         pending_link.text)
    case("the unsafe email match creates no authenticated Google session", "jk_session" not in pending_link.cookies)
    used_id = make_account("password-used@example.test")
    used_client = new_client("198.51.100.96")
    used_client.post("/api/auth/login", json={"email": "password-used@example.test", "password": "SandiPetani123"})
    needs_review = google(new_client("198.51.100.96"), sub="guard-password-used", email="password-used@example.test")
    case("password-used accounts without admin provenance go to the inbox", needs_review.status_code == 202
         and auth.find_by_id(used_id)["last_password_login_ms"] is not None, needs_review.text)
    admin_google_client = new_client("198.51.100.97")
    admin_google = google(admin_google_client, sub="guard-admin", email=ADMIN_EMAIL)
    case("owner policy: Google sign-in is allowed for existing admins", admin_google.status_code == 200
         and admin_google.json().get("account", {}).get("role") == "admin", admin_google.text)
    case("Google admin sessions keep the seven-day limit", "Max-Age=604800" in admin_google.headers.get("set-cookie", ""))
    case("Google sign-in does not bypass admin password re-authentication", admin_google_client.post(
        "/api/admin/registrations/reg_nope/approve", json={}, headers=csrf(admin_google_client)).status_code == 403)
    case("failed Google sign-ins are audited", "account.google_failed" in audit_actions())
    independent = new_client("198.51.100.98")
    for _ in range(security.THRESHOLDS["ip"][0]):
        security.login_record_failure("198.51.100.98", "wrong@example.test")
    case("password login throttling does not lock Google sign-in", google(
        independent, sub="guard-password-independent", email="independent@example.test").status_code == 202)
    clear_throttle()

    # =======================================================================
    section("security review: JWKS single-flight under concurrent outage")
    google_auth.reset_key_cache()
    started, release_fetch = threading.Event(), threading.Event()
    calls = []

    def slow_failure():
        calls.append(1)
        started.set()
        release_fetch.wait(2)
        raise google_auth.GoogleKeysUnavailable("synthetic slow outage")

    def lookup():
        try:
            google_auth._key_for("k1")
        except google_auth.GoogleKeysUnavailable:
            return "unavailable"
        return "unexpected"

    with mock.patch.object(google_auth, "_fetch_jwks", slow_failure):
        with ThreadPoolExecutor(max_workers=8) as pool:
            futures = [pool.submit(lookup) for _ in range(8)]
            started.wait(2)
            free_lock = google_auth._jwks_lock.acquire(timeout=0.2)
            if free_lock:
                google_auth._jwks_lock.release()
            release_fetch.set()
            outcomes = [future.result(timeout=3) for future in futures]
    case("a cold-cache outage fetches once for eight concurrent requests", len(calls) == 1 and outcomes == ["unavailable"] * 8,
         (len(calls), outcomes))
    case("the JWKS lock is not held during network I/O", free_lock)
    google_auth.reset_key_cache()
    with mock.patch.object(google_auth, "_fetch_jwks", return_value=({"keys": None}, 3600)):
        case("malformed JWKS is an unavailable service, not an uncaught exception", lookup() == "unavailable")
    google_auth.reset_key_cache()
    with mock.patch.object(google_auth, "NONCE_MAX_PER_IP", 1):
        with ThreadPoolExecutor(max_workers=6) as pool:
            concurrent_nonces = list(pool.map(lambda _: new_client("198.51.100.99").post(
                "/api/auth/google/nonce", json={}).status_code, range(6)))
    case("concurrent nonce requests cannot bypass the per-IP cap", sorted(concurrent_nonces) == [200] + [429] * 5,
         concurrent_nonces)
    race_account = make_account("link-race@example.test")

    def racing_sign_in(i):
        result = google(new_client(f"198.51.100.{110 + i}"), sub=f"guard-race-{i}", email="link-race@example.test")
        db.close_all()
        return result.status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        link_codes = list(pool.map(racing_sign_in, range(2)))
    case("concurrent identities cannot both link to the same account", sorted(link_codes) == [200, 403]
         and db.query_one("SELECT COUNT(*) AS n FROM google_identities WHERE account_id = ?", (race_account,))["n"] == 1,
         link_codes)

    # =======================================================================
    section("origin and CSRF")
    evil = new_client("203.0.113.50")
    n = nonce_for(evil)
    foreign = evil.post("/api/auth/google", json={"credential": mint(n), "nonce": n}, headers={"Origin": "https://evil.example"})
    case("a cross-site POST is refused before the token is read (403 origin_denied)",
         foreign.status_code == 403 and foreign.json().get("code") == "origin_denied", foreign.text)
    stale_cookie = new_client("203.0.113.51")
    stale_cookie.cookies.set("jk_session", "stale-session-token")
    stale_reply = google(stale_cookie, sub="820000000000000000001", email="stale.cookie@example.test")
    case("a stale session cookie without CSRF does not block Google sign-in (like /login)",
         stale_reply.status_code == 202, stale_reply.text)

    # =======================================================================
    section("schema 9 -> 10 upgrade and reset_for_tests")
    db.close_all()
    main_db = db.DB_PATH
    db.DB_PATH = TMP / "upgrade.sqlite3"
    with mock.patch.object(db, "MIGRATIONS", db.MIGRATIONS[:9]):
        case("an old database is at schema 9", db.migrate() == 9)
    with db.transaction() as tx:
        tx.execute("INSERT INTO accounts(id,email,name,role,password_hash,is_active,daily_quota,created_ms,updated_ms) "
                   "VALUES ('acct_old','old@example.test','old','user','x',1,0,1,1)")
    case("migrate() upgrades it to 11", db.migrate() == 11)
    upgraded = {row["name"] for row in db.query("SELECT name FROM sqlite_master WHERE type='table'")}
    case("the upgrade adds the new tables and keeps the data",
         {"google_identities", "registration_requests", "auth_nonces"} <= upgraded and auth.find_by_id("acct_old"))
    old_account = auth.find_by_id("acct_old")
    case("legacy accounts with unknown provenance cannot auto-link as never-used accounts",
         old_account["admin_created"] == 0 and old_account["last_password_login_ms"] is not None)
    with db.transaction() as tx:
        tx.execute("INSERT INTO google_identities (sub, account_id) VALUES ('s-old', 'acct_old')")
        tx.execute("DELETE FROM accounts WHERE id = 'acct_old'")
    case("deleting an account removes its Google link (ON DELETE CASCADE)",
         db.query_one("SELECT COUNT(*) AS n FROM google_identities")["n"] == 0)
    db.close_all()
    db.DB_PATH = main_db
    db.reset_for_tests()
    case("reset_for_tests empties the new tables",
         all(db.query_one(f"SELECT COUNT(*) AS n FROM {t}")["n"] == 0
             for t in ("google_identities", "registration_requests", "auth_nonces", "google_request_limits", "accounts")))
finally:
    os.environ.pop("GOOGLE_CLIENT_ID", None)
    db.close_all()

passed = sum(1 for _, ok, _ in CASES if ok)
print()
print(f"google-0230: {passed}/{len(CASES)} assertions passed")
for name, ok, detail in CASES:
    if not ok:
        print("  FAILED:", name, "::", str(detail)[:300])
sys.exit(0 if passed == len(CASES) else 1)
