"""0.2.2.0 platform-security regression tests (BE3).

Run (cwd = app/):  python tests/test_security_0220.py

Drives the real ASGI application with Starlette's TestClient, so the security middleware, the
exception handlers, the routers and the static mount are all exercised over HTTP semantics.
A few cases call the ASGI app directly with a hand-written `receive` to PROVE that a request
was answered before its body was read. Uses a throwaway SQLite file and upload directory under
$TMPDIR; synthetic accounts only.

Covered: account binding (409 account_mismatch), one header set + both CSPs + caching + docs
off, Origin/Referer CSRF check (same site, foreign, Android WebView, native bridge), early
upload guard (401/409/413 before the body, streaming cap), login throttling (identical
responses, per-IP counter kept on success, IPv6 /64, soft per-address lock), scrypt p=5 with
transparent rehash (and cost padding), password policy, role-based session TTL, session
rotation on password change, retention purge, access-log redaction, worker-token warning,
maintenance thread + storage drainer hook, and the systemd unit hardening directives.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import io
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))

TMP = tempfile.TemporaryDirectory(prefix="jk-sec0220-", dir=os.environ.get("TMPDIR") or None)
ROOT = Path(TMP.name)

ADMIN_EMAIL = "admin@sec0220.test"
ADMIN_PASSWORD = "AdminSecurity-0220"
PW = "SandiUji-0220"
WORKER_TOKEN = "w" * 40

os.environ.update({
    "COOKIE_SECURE": "0", "WORKER_TOKEN": WORKER_TOKEN, "ADMIN_EMAIL": ADMIN_EMAIL,
    "ADMIN_PASSWORD": ADMIN_PASSWORD, "SECRET_KEY": "sec0220-secret-key-material",
    "ALLOW_REGISTRATION": "1", "SEED_DEMO_DATA": "0", "SESSION_TTL_DAYS": "30",
})
for _name in ("JK_ENABLE_API_DOCS", "JK_ALLOWED_ORIGINS"):
    os.environ.pop(_name, None)

from backend import db  # noqa: E402

db.close_all()
db.DB_PATH = ROOT / "db.sqlite3"

from backend import api_app, auth, security, settings_store  # noqa: E402
from backend import app as app_module  # noqa: E402

api_app.UPLOAD_DIR = ROOT / "uploads"
api_app.UPLOAD_DIR.mkdir()

from fastapi.routing import APIRoute  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image  # noqa: E402

ASGI_APP = app_module.app
CASES: list[tuple[str, bool, str]] = []


def case(name: str, ok: bool, detail: object = "") -> None:
    CASES.append((name, bool(ok), str(detail)))
    print(("PASS " if ok else "FAIL ") + name + ("" if ok or detail == "" else f" :: {detail}"),
          flush=True)


def section(title: str) -> None:
    print(f"--- {title} ---", flush=True)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

SHARED_HASH = security.hash_password(PW)


def make_account(email: str, role: str = "user", password_hash: str | None = None,
                 active: bool = True) -> str:
    account_id = db.new_id("acct")
    now = db.now_ms()
    with db.transaction() as tx:
        tx.execute(
            "INSERT INTO accounts (id,email,name,role,password_hash,is_active,daily_quota,"
            "created_ms,updated_ms) VALUES (?,?,?,?,?,?,0,?,?)",
            (account_id, email, email.split("@")[0], role, password_hash or SHARED_HASH,
             1 if active else 0, now, now))
    return account_id


def new_client(ip: str = "203.0.113.10", **kwargs) -> TestClient:
    return TestClient(ASGI_APP, client=(ip, 50000), **kwargs)


def login(client: TestClient, email: str, password: str = PW):
    return client.post("/api/auth/login", json={"email": email, "password": password})


def csrf(client: TestClient) -> dict[str, str]:
    return {"X-CSRF-Token": client.cookies.get("jk_csrf") or ""}


def legacy_hash(password: str, salt: bytes = b"legacy-salt-0123") -> str:
    """The hash format used before 0.2.2.0: scrypt N=2^14 r=8 p=1."""
    derived = hashlib.scrypt(password.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
    return "scrypt$16384$8$1${}${}".format(security.b64e(salt), security.b64e(derived))


def set_cookie_values(response, name: str) -> list[str]:
    return [line for line in response.headers.get_list("set-cookie") if line.startswith(name + "=")]


def cookie_attribute(line: str, attribute: str) -> str | None:
    for part in line.split(";")[1:]:
        key, _, value = part.strip().partition("=")
        if key.lower() == attribute.lower():
            return value
    return None


def asgi_request(method: str, path: str, headers: dict[str, str | bytes], chunks: list[bytes],
                 client_ip: str = "203.0.113.50") -> dict:
    """Call the ASGI app directly; report what was sent and how much body was consumed."""
    pending = list(chunks)
    consumed = {"calls": 0, "bytes": 0}

    async def receive():
        consumed["calls"] += 1
        if pending:
            chunk = pending.pop(0)
            consumed["bytes"] += len(chunk)
            return {"type": "http.request", "body": chunk, "more_body": bool(pending)}
        return {"type": "http.disconnect"}

    sent: list[dict] = []

    async def send(message):
        sent.append(message)

    raw_headers = [(b"host", b"testserver")]
    for key, value in headers.items():
        raw_headers.append((key.lower().encode(), value if isinstance(value, bytes) else value.encode()))
    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method,
             "path": path, "raw_path": path.encode(), "root_path": "", "scheme": "http",
             "query_string": b"", "headers": raw_headers, "client": (client_ip, 40000),
             "server": ("testserver", 80)}
    asyncio.run(ASGI_APP(scope, receive, send))
    start = next(m for m in sent if m["type"] == "http.response.start")
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    response_headers = {k.decode().lower(): v.decode("latin-1") for k, v in start["headers"]}
    try:
        payload = json.loads(body.decode() or "null")
    except ValueError:
        payload = None
    return {"status": start["status"], "headers": response_headers, "json": payload,
            "consumed": consumed}


def multipart_prefix(boundary: str = "xyz") -> bytes:
    return (f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; "
            f"filename=\"a.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n").encode()


def small_jpeg() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (64, 48), (50, 130, 60)).save(buffer, format="JPEG")
    return buffer.getvalue()


# Contract 5.7, verbatim.
CONTRACT_ADMIN_CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; "
    "base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
CONTRACT_APP_CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob: https://tile.openstreetmap.org https://*.tile.openstreetmap.org "
    "https://server.arcgisonline.com; font-src 'self' data:; connect-src 'self' data: blob:; "
    "media-src 'self' blob:; worker-src 'self'; manifest-src 'self'; object-src 'none'; "
    "base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
BASELINE = {"x-content-type-options": "nosniff", "x-frame-options": "DENY",
            "referrer-policy": "strict-origin-when-cross-origin",
            "permissions-policy": "geolocation=(self), camera=(self), microphone=()"}


async def _boom():  # a route that crashes, to see the headers on a 500
    raise RuntimeError("synthetic failure for the 500 header test")


ASGI_APP.router.routes.insert(0, APIRoute("/api/__boom__", _boom, methods=["GET"]))

# One long-lived client runs the application lifespan (bootstrap + maintenance thread). Its
# first maintenance pass is pushed far away so it cannot touch the database mid-suite.
app_module.MAINTENANCE_FIRST_RUN_SECONDS = 3600
LIFESPAN = TestClient(ASGI_APP)
LIFESPAN.__enter__()
try:
    # =======================================================================
    section("accounts for the suite")
    id_a = make_account("a@sec0220.test")
    id_b = make_account("b@sec0220.test")
    client_a, client_b = new_client("203.0.113.11"), new_client("203.0.113.12")
    reply_a, reply_b = login(client_a, "a@sec0220.test"), login(client_b, "b@sec0220.test")
    case("farmer A logs in", reply_a.status_code == 200 and reply_a.json()["account"]["id"] == id_a,
         reply_a.status_code)
    case("farmer B logs in", reply_b.status_code == 200 and reply_b.json()["account"]["id"] == id_b)

    # =======================================================================
    section("account binding (X-JK-Account)")
    plain = client_a.get("/api/records")
    case("no X-JK-Account header is allowed (old clients, native bridge)", plain.status_code == 200,
         plain.status_code)
    same = client_a.get("/api/records", headers={"X-JK-Account": id_a})
    case("the session's own account id is allowed", same.status_code == 200, same.status_code)
    blank = client_a.get("/api/records", headers={"X-JK-Account": "  "})
    case("a blank header counts as absent", blank.status_code == 200, blank.status_code)
    wrong = client_a.get("/api/records", headers={"X-JK-Account": id_b})
    case("another account's id answers 409 with the exact contract JSON",
         wrong.status_code == 409 and wrong.json() == {
             "detail": "Akun di perangkat ini sudah berganti. Muat ulang aplikasi.",
             "code": "account_mismatch"}, f"{wrong.status_code} {wrong.text}")
    before = db.query_one("SELECT COUNT(*) AS n FROM records WHERE account_id=?", (id_a,))["n"]
    blocked = client_a.post("/api/records", json={"crop": "Tidak boleh tersimpan"},
                            headers={**csrf(client_a), "X-JK-Account": id_b})
    after = db.query_one("SELECT COUNT(*) AS n FROM records WHERE account_id=?", (id_a,))["n"]
    case("a mismatching mutation is refused and does nothing",
         blocked.status_code == 409 and blocked.json().get("code") == "account_mismatch"
         and before == after, f"{blocked.status_code} rows {before}->{after}")
    stale_me = client_a.get("/api/auth/me", headers={"X-JK-Account": id_b})
    case("/api/auth/me also reports the mismatch", stale_me.status_code == 409
         and stale_me.json().get("code") == "account_mismatch", stale_me.status_code)
    stale_logout = client_a.post("/api/auth/logout", headers={**csrf(client_a), "X-JK-Account": id_b})
    still = client_a.get("/api/auth/me")
    case("a stale tab cannot sign the browser's current account out",
         stale_logout.status_code == 409 and still.json().get("ok") is True,
         f"{stale_logout.status_code} {still.text[:80]}")
    for_admin = client_a.get("/api/admin/accounts", headers={"X-JK-Account": id_b})
    case("account binding is checked before the admin role check on admin routes",
         for_admin.status_code == 409, for_admin.status_code)
    try:
        error = auth.CodedHTTPException(409, "x", "some_code", headers={"Retry-After": "5"})
        case("CodedHTTPException carries status, detail, code and headers",
             (error.status_code, error.detail, error.code, error.headers)
             == (409, "x", "some_code", {"Retry-After": "5"}))
    except Exception as exc:  # noqa: BLE001
        case("CodedHTTPException carries status, detail, code and headers", False, exc)

    # =======================================================================
    section("security headers, CSP and caching")
    probes = {
        "/": client_a.get("/"), "/index.html": client_a.get("/index.html"),
        "/admin": client_a.get("/admin"), "/admin.html": client_a.get("/admin.html"),
        "/app.js": client_a.get("/app.js"), "/styles.css": client_a.get("/styles.css"),
        "/manifest.webmanifest": client_a.get("/manifest.webmanifest"),
        "/sw.js": client_a.get("/sw.js"), "/api/health": client_a.get("/api/health"),
        "/missing-file.png": client_a.get("/missing-file.png"),
        "401": new_client().get("/api/records"),
        "csrf-403": client_a.post("/api/records", json={"crop": "x"}),
    }
    crash = new_client(raise_server_exceptions=False).get("/api/__boom__")
    probes["500"] = crash
    case("the unhandled-error response is a JSON 500", crash.status_code == 500
         and "detail" in crash.json(), crash.status_code)
    for label, response in probes.items():
        problems = []
        for header, expected in BASELINE.items():
            values = response.headers.get_list(header)
            if values != [expected]:
                problems.append(f"{header}={values}")
        case(f"one consistent header set on {label}", not problems, "; ".join(problems))
    case("the CSRF 403 (an early-return response) is a 403", probes["csrf-403"].status_code == 403,
         probes["csrf-403"].status_code)
    for page in ("/", "/index.html"):
        case(f"field-app CSP on {page} is exactly the contract policy",
             probes[page].headers.get_list("content-security-policy") == [CONTRACT_APP_CSP],
             probes[page].headers.get_list("content-security-policy"))
    for page in ("/admin", "/admin.html"):
        case(f"strict admin CSP on {page} is exactly the contract policy",
             probes[page].headers.get_list("content-security-policy") == [CONTRACT_ADMIN_CSP],
             probes[page].headers.get_list("content-security-policy"))
        case(f"X-Robots-Tag noindex on {page}",
             probes[page].headers.get("x-robots-tag") == "noindex, nofollow")
    case("no X-Robots-Tag on the field app", "x-robots-tag" not in probes["/"].headers)
    case("no CSP on JSON API responses", "content-security-policy" not in probes["/api/health"].headers)
    case("the app CSP allows the satellite tile host",
         "https://server.arcgisonline.com" in CONTRACT_APP_CSP
         and "https://server.arcgisonline.com" in probes["/"].headers["content-security-policy"])
    for page in ("/", "/index.html", "/app.js", "/styles.css", "/manifest.webmanifest",
                 "/admin", "/admin.html"):
        case(f"Cache-Control: no-cache on {page}",
             probes[page].headers.get("cache-control") == "no-cache",
             probes[page].headers.get("cache-control"))
    vendor = client_a.get("/vendor/lucide-0.468.0.umd.min.js")
    case("Cache-Control: no-cache on vendored JS", vendor.status_code == 200
         and vendor.headers.get("cache-control") == "no-cache", vendor.headers.get("cache-control"))
    case("sw.js stays no-store", probes["/sw.js"].headers.get("cache-control") == "no-store",
         probes["/sw.js"].headers.get("cache-control"))
    health = probes["/api/health"]
    case("API responses are no-store, no-cache, must-revalidate with Pragma and Expires",
         health.headers.get("cache-control") == "no-store, no-cache, must-revalidate"
         and health.headers.get("pragma") == "no-cache" and health.headers.get("expires") == "0")
    case("a 401 API response is no-store as well",
         probes["401"].headers.get("cache-control") == "no-store, no-cache, must-revalidate")
    icon = client_a.get("/icons/icon-192.png")
    case("icons keep the static default (no Cache-Control forced)",
         icon.status_code == 200 and "cache-control" not in icon.headers, icon.headers.get("cache-control"))
    js = probes["/app.js"]
    case("StaticFiles ETag and Last-Modified are kept on app.js",
         bool(js.headers.get("etag")) and bool(js.headers.get("last-modified")))
    revalidated = client_a.get("/app.js", headers={"If-None-Match": js.headers.get("etag", "")})
    case("revalidation answers 304 and keeps no-cache", revalidated.status_code == 304
         and revalidated.headers.get("cache-control") == "no-cache", revalidated.status_code)
    case("no HSTS over the plain-http test configuration (COOKIE_SECURE=0)",
         "strict-transport-security" not in health.headers)
    os.environ["COOKIE_SECURE"] = "1"
    try:
        secure_health = new_client().get("/api/health")
        case("HSTS is sent when the deployment is HTTPS-only (COOKIE_SECURE=1)",
             secure_health.headers.get_list("strict-transport-security") == ["max-age=31536000"],
             secure_health.headers.get_list("strict-transport-security"))
    finally:
        os.environ["COOKIE_SECURE"] = "0"
    docs_status = {path: client_a.get(path).status_code for path in ("/docs", "/redoc", "/openapi.json")}
    case("API docs and openapi.json are off by default", set(docs_status.values()) == {404}, docs_status)
    probe_code = (
        "import json, os\n"
        "from fastapi.testclient import TestClient\n"
        "from backend.app import app\n"
        "c = TestClient(app)\n"
        "print(json.dumps({p: c.get(p).status_code for p in ('/docs', '/redoc', '/openapi.json')}))\n")
    env = {**os.environ, "JK_ENABLE_API_DOCS": "1", "PYTHONDONTWRITEBYTECODE": "1"}
    ran = subprocess.run([sys.executable, "-c", probe_code], cwd=BASE, env=env, capture_output=True,
                         text=True, timeout=120)
    try:
        enabled = json.loads(ran.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        enabled = {"error": (ran.stdout + ran.stderr)[-300:]}
    case("JK_ENABLE_API_DOCS=1 turns them back on", set(enabled.values()) == {200}, enabled)

    # =======================================================================
    section("CSRF: Origin / Referer check on top of the double-submit token")

    def mutate(_unused: TestClient, extra: dict[str, str] | None = None):
        return client_a.post("/api/records", json={"crop": "Uji Origin"},
                             headers={**csrf(client_a), **(extra or {})})

    case("same-origin Origin is accepted", mutate(client_a, {"Origin": "http://testserver"}).status_code == 200)
    foreign = mutate(client_a, {"Origin": "https://evil.example"})
    case("a foreign Origin is refused with 403 origin_denied",
         foreign.status_code == 403 and foreign.json().get("code") == "origin_denied",
         f"{foreign.status_code} {foreign.text[:100]}")
    case("Origin: null is refused", mutate(client_a, {"Origin": "null"}).status_code == 403)
    case("a different port is a different origin",
         mutate(client_a, {"Origin": "http://testserver:8080"}).status_code == 403)
    case("the Android WebView origin https://localhost is accepted",
         mutate(client_a, {"Origin": "https://localhost"}).status_code == 200)
    case("the native bridge (no Origin, no Referer) is accepted", mutate(client_a).status_code == 200)
    case("a foreign Referer without Origin is refused",
         mutate(client_a, {"Referer": "https://evil.example/page"}).status_code == 403)
    case("a same-site Referer without Origin is accepted",
         mutate(client_a, {"Referer": "http://testserver/app"}).status_code == 200)
    case("a non-http Referer (android-app://) is ignored",
         mutate(client_a, {"Referer": "android-app://com.example.launcher/"}).status_code == 200)
    case("the scheme is not compared (TLS-terminating tunnel: app sees http, browser used https)",
         mutate(client_a, {"Origin": "https://testserver"}).status_code == 200)
    case("X-Forwarded-Host covers a proxy that rewrites Host",
         mutate(client_a, {"Origin": "https://jagake.bond", "X-Forwarded-Host": "jagake.bond"}).status_code == 200)
    case("...but only for the host it names",
         mutate(client_a, {"Origin": "https://evil.example", "X-Forwarded-Host": "jagake.bond"}).status_code == 403)
    os.environ["JK_ALLOWED_ORIGINS"] = "https://extra.example, other.example:8443"
    try:
        case("JK_ALLOWED_ORIGINS: an extra origin with scheme is accepted",
             mutate(client_a, {"Origin": "https://extra.example"}).status_code == 200)
        case("JK_ALLOWED_ORIGINS: scheme must match for an origin entry",
             mutate(client_a, {"Origin": "http://extra.example"}).status_code == 403)
        case("JK_ALLOWED_ORIGINS: a bare host entry matches either scheme and its port",
             mutate(client_a, {"Origin": "http://other.example:8443"}).status_code == 200)
        case("JK_ALLOWED_ORIGINS does not open anything else",
             mutate(client_a, {"Origin": "https://evil.example"}).status_code == 403)
    finally:
        os.environ.pop("JK_ALLOWED_ORIGINS", None)
    case("after removing JK_ALLOWED_ORIGINS the extra origin is refused again",
         mutate(client_a, {"Origin": "https://extra.example"}).status_code == 403)
    case("GET requests are not subject to the Origin check",
         client_a.get("/api/records", headers={"Origin": "https://evil.example"}).status_code == 200)
    login_csrf = new_client("203.0.113.13").post(
        "/api/auth/login", json={"email": "b@sec0220.test", "password": PW},
        headers={"Origin": "https://evil.example"})
    case("login CSRF: a foreign Origin cannot log a victim in", login_csrf.status_code == 403
         and not login_csrf.headers.get_list("set-cookie"), login_csrf.status_code)
    login_same = new_client("203.0.113.13").post(
        "/api/auth/login", json={"email": "b@sec0220.test", "password": PW},
        headers={"Origin": "http://testserver"})
    case("login from the site's own origin still works", login_same.status_code == 200, login_same.status_code)
    missing_token = client_a.post("/api/records", json={"crop": "x"})
    case("the double-submit token is still required",
         missing_token.status_code == 403 and missing_token.json().get("code") == "csrf_invalid",
         f"{missing_token.status_code} {missing_token.text[:100]}")
    case("a wrong CSRF token is refused",
         client_a.post("/api/records", json={"crop": "x"}, headers={"X-CSRF-Token": "nope"}).status_code == 403)
    worker_call = new_client().post("/api/analyze/job_missing/trace", json={"stage": "x"},
                                    headers={"X-Worker-Token": WORKER_TOKEN})
    case("worker-token calls (no cookie, no Origin) are unaffected", worker_call.status_code == 404,
         worker_call.status_code)

    # =======================================================================
    section("early upload guard")
    settings_store.update_settings({"MAX_UPLOAD_MB": "1"}, "test@sec0220")
    limit = 1 * 1024 * 1024 + 1024 * 1024  # MAX_UPLOAD_MB + 1 MB multipart overhead
    big = str(limit + 1)
    token_a = client_a.cookies.get("jk_session")
    csrf_a = client_a.cookies.get("jk_csrf")
    good_cookie = f"jk_session={token_a}; jk_csrf={csrf_a}"
    upload_headers = {"content-type": "multipart/form-data; boundary=xyz", "x-csrf-token": csrf_a}

    for path in ("/api/analyze", "/api/photos"):
        anonymous = asgi_request("POST", path, {"content-type": "multipart/form-data; boundary=xyz",
                                                "content-length": big}, [b"x" * 1000])
        case(f"{path}: no session cookie answers 401 before the body is read",
             anonymous["status"] == 401 and anonymous["consumed"]["calls"] == 0
             and anonymous["json"] == {"detail": "Belum masuk. Silakan masuk."},
             f"{anonymous['status']} calls={anonymous['consumed']['calls']}")
        case(f"{path}: the early 401 asks the server to close the connection",
             anonymous["headers"].get("connection") == "close")
        bogus = asgi_request("POST", path, {**upload_headers, "cookie": "jk_session=bogus; jk_csrf=abc",
                                            "x-csrf-token": "abc", "content-length": "500"}, [b"y" * 500])
        case(f"{path}: an unknown session token is a 401 before the body is read",
             bogus["status"] == 401 and bogus["consumed"]["calls"] == 0,
             f"{bogus['status']} calls={bogus['consumed']['calls']}")
        mismatch = asgi_request("POST", path, {**upload_headers, "cookie": good_cookie,
                                               "x-jk-account": id_b, "content-length": "500"}, [b"y" * 500])
        case(f"{path}: another account's X-JK-Account is a 409 before the body is read",
             mismatch["status"] == 409 and mismatch["json"].get("code") == "account_mismatch"
             and mismatch["consumed"]["calls"] == 0,
             f"{mismatch['status']} calls={mismatch['consumed']['calls']}")
        oversize = asgi_request("POST", path, {**upload_headers, "cookie": good_cookie,
                                               "content-length": big}, [b"z" * 4096])
        case(f"{path}: Content-Length above MAX_UPLOAD_MB + 1 MB is a 413 before the body is read",
             oversize["status"] == 413 and oversize["consumed"]["calls"] == 0
             and oversize["json"].get("code") == "payload_too_large"
             and "1 MB" in oversize["json"].get("detail", ""),
             f"{oversize['status']} calls={oversize['consumed']['calls']} {oversize['json']}")
        case(f"{path}: the 413 closes the connection", oversize["headers"].get("connection") == "close")
        exact = asgi_request("POST", path, {**upload_headers, "cookie": good_cookie,
                                            "content-length": str(limit)},
                             [multipart_prefix() + b"A" * (limit - len(multipart_prefix()))])
        case(f"{path}: Content-Length exactly at the limit passes the guard (the route decides)",
             exact["status"] not in (401, 409)
             and (exact["json"] or {}).get("code") != "payload_too_large",
             f"{exact['status']} {exact['json']}")
        chunked = [multipart_prefix()] + [b"B" * 262144 for _ in range(12)]
        streamed = asgi_request("POST", path, {**upload_headers, "cookie": good_cookie}, chunked)
        case(f"{path}: a body WITHOUT Content-Length is cut off at the limit while streaming",
             streamed["status"] == 413 and streamed["json"].get("code") == "payload_too_large"
             and streamed["consumed"]["bytes"] <= limit + 262144 + len(multipart_prefix()),
             f"{streamed['status']} consumed={streamed['consumed']['bytes']} limit={limit}")
        case(f"{path}: the streaming 413 carries the one consistent header set too",
             all(streamed["headers"].get(h) == v for h, v in BASELINE.items()))
    garbage = client_a.post("/api/photos", files={"file": ("a.jpg", b"not an image", "image/jpeg")},
                            headers=csrf(client_a))
    case("a normal (small) upload still reaches the route", garbage.status_code == 400
         and ("gambar" in garbage.text.lower() or "foto" in garbage.text.lower()),
         f"{garbage.status_code} {garbage.text[:100]}")
    real = client_a.post("/api/photos", files={"file": ("a.jpg", small_jpeg(), "image/jpeg")},
                         headers=csrf(client_a))
    case("a valid photo upload still succeeds", real.status_code == 200 and "url" in real.json(),
         f"{real.status_code} {real.text[:100]}")
    analyze_garbage = client_a.post("/api/analyze", files={"image": ("a.jpg", b"nope", "image/jpeg")},
                                    headers=csrf(client_a))
    case("a normal analyze request still reaches the route", analyze_garbage.status_code in (400, 422),
         f"{analyze_garbage.status_code} {analyze_garbage.text[:100]}")
    case("a non-ASCII X-Worker-Token / CSRF header is a clean 403, never a 500",
         asgi_request("POST", "/api/records", {"cookie": b"jk_session=abc; jk_csrf=\xe9", "x-csrf-token": b"\xe9\xff",
                                               "x-worker-token": b"\xe9\xff"}, [])["status"] == 403)
    case("a hostile non-ASCII session cookie is a 401, never a 500",
         asgi_request("GET", "/api/records", {"cookie": b"jk_session=\xe9\xff"}, [])["status"] == 401)
    settings_store.update_settings({"MAX_UPLOAD_MB": "12"}, "test@sec0220")

    # =======================================================================
    section("login throttling")
    make_account("thr@sec0220.test")
    ip_t = "198.51.100.20"
    thr_client = new_client(ip_t)
    unknown = thr_client.post("/api/auth/login", json={"email": "nobody-here@sec0220.test", "password": "x" * 10})
    wrong_pw = thr_client.post("/api/auth/login", json={"email": "thr@sec0220.test", "password": "x" * 10})

    def comparable(response):
        skip = {"date", "set-cookie"}
        return sorted((k, v) for k, v in response.headers.items() if k not in skip)

    case("wrong e-mail and wrong password answer identically (status, body, headers)",
         unknown.status_code == wrong_pw.status_code == 401 and unknown.json() == wrong_pw.json()
         and comparable(unknown) == comparable(wrong_pw),
         f"{unknown.status_code}/{wrong_pw.status_code} {unknown.text} {wrong_pw.text}")
    for _ in range(2):  # two more failures on the same IP, for yet another address
        thr_client.post("/api/auth/login", json={"email": "other-thr@sec0220.test", "password": "x" * 10})
    ip_row_before = db.query_one("SELECT fails FROM login_attempts WHERE key=?", (f"ip:{ip_t}",))["fails"]
    pair_key = security._pair_key(ip_t, "thr@sec0220.test")
    case("failures are counted on the IP and on the IP+e-mail pair",
         ip_row_before == 4 and db.query_one("SELECT fails FROM login_attempts WHERE key=?", (pair_key,))["fails"] == 1,
         ip_row_before)
    good = thr_client.post("/api/auth/login", json={"email": "thr@sec0220.test", "password": PW})
    ip_row_after = db.query_one("SELECT fails FROM login_attempts WHERE key=?", (f"ip:{ip_t}",))
    case("a successful login does NOT reset the per-IP counter",
         good.status_code == 200 and ip_row_after is not None and ip_row_after["fails"] == ip_row_before,
         f"{good.status_code} {ip_row_after}")
    case("...but it clears the IP+e-mail pair",
         db.query_one("SELECT 1 FROM login_attempts WHERE key=?", (pair_key,)) is None)

    section("login throttling: IPv6 /64 keys")
    a64 = security.normalize_ip("2001:db8:abcd:12:aaaa:bbbb:cccc:dddd")
    case("addresses in one /64 share one key", a64 == security.normalize_ip("2001:db8:abcd:12::1"), a64)
    case("another /64 gets another key", a64 != security.normalize_ip("2001:db8:abcd:13::1"))
    case("IPv4 keys are unchanged", security.normalize_ip("203.0.113.7") == "203.0.113.7")
    case("an IPv4-mapped IPv6 address is the IPv4 address", security.normalize_ip("::ffff:203.0.113.7") == "203.0.113.7")
    case("a zone id is dropped", security.normalize_ip("fe80::1%eth0") == security.normalize_ip("fe80::2"))
    case("a non-IP client string survives as is", security.normalize_ip("testclient") == "testclient")
    case("the IPv6 key is the /64 network", a64 == "2001:db8:abcd:12::/64", a64)
    for index in range(security.THRESHOLDS["ip"][0]):
        security.login_record_failure(f"2001:db8:aaaa:1:{index:x}::{index:x}", None)
    case("50 failures spread over one /64 lock the whole /64",
         security.login_locked_for_ms("2001:db8:aaaa:1:ffff::1", None) > 0)
    case("a neighbouring /64 is not affected", security.login_locked_for_ms("2001:db8:aaaa:2::1", None) == 0)

    section("login throttling: soft per-address lock")
    soft_email = "soft@sec0220.test"
    make_account(soft_email)
    for index in range(security.EMAIL_SOFT_LIMIT):
        security.login_record_failure(f"198.51.100.{100 + index}", soft_email)
    case("10 failures for one address (10 different IPs) do not lock it yet",
         security.login_locked_for_ms("198.51.100.150", soft_email) == 0)
    ok_before = new_client("198.51.100.150").post("/api/auth/login", json={"email": soft_email, "password": PW})
    case("the owner can still sign in at exactly 10 failures", ok_before.status_code == 200, ok_before.status_code)
    eleventh = new_client("198.51.100.151").post("/api/auth/login", json={"email": soft_email, "password": "wrong-pass-1"})
    case("the 11th failure is still a plain 401", eleventh.status_code == 401, eleventh.status_code)
    locked_ms = security.login_locked_for_ms("198.51.100.152", soft_email)
    case("...and starts a short soft lock (30-120 s) for every IP",
         30_000 - 2_000 <= locked_ms <= 120_000, locked_ms)
    blocked_login = new_client("198.51.100.152").post("/api/auth/login", json={"email": soft_email, "password": PW})
    retry_after = blocked_login.headers.get("retry-after", "")
    case("a locked login answers 429 with Retry-After and a Bahasa message even with the right password",
         blocked_login.status_code == 429 and retry_after.isdigit() and 1 <= int(retry_after) <= 120
         and "Terlalu banyak percobaan" in blocked_login.json().get("detail", ""),
         f"{blocked_login.status_code} {retry_after} {blocked_login.text[:100]}")
    case("another e-mail is unaffected", security.login_locked_for_ms("198.51.100.152", "free@sec0220.test") == 0)
    case("the lock is by address, whether or not the account exists",
         security.login_lock_state("198.51.100.153", "SOFT@sec0220.test")[1] == "email")
    real_now = db.now_ms
    try:
        db.now_ms = lambda: real_now() + 20_000
        still_locked = security.login_locked_for_ms("198.51.100.152", soft_email)
        db.now_ms = lambda: real_now() + 125_000
        expired = security.login_locked_for_ms("198.51.100.152", soft_email)
        db.now_ms = lambda: real_now() + (security.EMAIL_WINDOW_SECONDS + 60) * 1000
        security.login_record_failure("198.51.100.154", soft_email)
        window_row = db.query_one("SELECT fails FROM login_attempts WHERE key=?",
                                  (security._keys("198.51.100.154", soft_email)[-1],))
    finally:
        db.now_ms = real_now
    case("the soft lock lasts seconds, not hours (still locked at +20 s, free by +125 s)",
         still_locked > 0 and expired == 0, f"{still_locked} {expired}")
    case("failures older than the 15-minute window stop counting", window_row["fails"] == 1, window_row)
    steps = [security._soft_email_failure({"fails": n - 1, "updated_ms": 1_000}, 1_000 + 1)[2] - 1_001
             for n in (11, 12, 13, 14, 60)]
    case("the lock doubles from 30 s and is capped at 120 s (never a long lockout)",
         steps == [30_000, 60_000, 120_000, 120_000, 120_000], steps)
    case("below the limit nothing locks", security._soft_email_failure({"fails": 4, "updated_ms": 1_000}, 1_001)[2] == 0)
    ip_pair = "198.51.100.200"
    for _ in range(security.THRESHOLDS["pair"][0]):
        security.login_record_failure(ip_pair, "pairlock@sec0220.test")
    case("the IP+e-mail pair still locks after 5 failures",
         security.login_lock_state(ip_pair, "pairlock@sec0220.test")[1] in ("pair",))

    # =======================================================================
    section("scrypt p=5 and transparent rehash")
    calls: list[int] = []
    real_scrypt = security._scrypt

    def spy(password, salt, n, r, p, dklen):
        calls.append(p)
        return real_scrypt(password, salt, n, r, p, dklen)

    case("new hashes use N=2^14, r=8, p=5", SHARED_HASH.startswith("scrypt$16384$8$5$"), SHARED_HASH[:20])
    case("the hash is rated as current", not security.needs_rehash(SHARED_HASH))
    legacy_email = "legacy@sec0220.test"
    old_hash = legacy_hash(PW)
    legacy_id = make_account(legacy_email, password_hash=old_hash)
    case("an old p=1 hash still verifies", security.verify_password(PW, old_hash))
    case("...and is flagged for an upgrade", security.needs_rehash(old_hash))
    case("a hash with absurd parameters is refused, not computed",
         not security.verify_password(PW, "scrypt$1073741824$8$1$AAAA$AAAA"))
    security._scrypt = spy
    try:
        calls.clear()
        new_client("198.51.100.31").post("/api/auth/login", json={"email": "nobody2@sec0220.test", "password": "x" * 10})
        unknown_cost = sum(calls)
        calls.clear()
        new_client("198.51.100.32").post("/api/auth/login", json={"email": "a@sec0220.test", "password": "x" * 10})
        current_cost = sum(calls)
        calls.clear()
        new_client("198.51.100.33").post("/api/auth/login", json={"email": legacy_email, "password": "x" * 10})
        legacy_wrong_cost = sum(calls)
        case("a wrong password costs the same for unknown e-mail, current hash and old hash (p units)",
             unknown_cost == current_cost == legacy_wrong_cost == 5,
             f"unknown={unknown_cost} current={current_cost} legacy={legacy_wrong_cost}")
        case("a failed login does not upgrade the hash",
             db.query_one("SELECT password_hash FROM accounts WHERE id=?", (legacy_id,))["password_hash"] == old_hash)
        calls.clear()
        upgraded = new_client("198.51.100.34").post("/api/auth/login", json={"email": legacy_email, "password": PW})
        case("a successful login verifies the old hash and stores a fresh one", upgraded.status_code == 200
             and calls == [1, 5], f"{upgraded.status_code} {calls}")
        calls.clear()
        again = new_client("198.51.100.35").post("/api/auth/login", json={"email": legacy_email, "password": PW})
        case("an up-to-date hash is not rewritten", again.status_code == 200 and calls == [5], calls)
    finally:
        security._scrypt = real_scrypt
    stored = db.query_one("SELECT password_hash FROM accounts WHERE id=?", (legacy_id,))["password_hash"]
    case("the stored hash is now p=5 and still verifies the same password",
         stored.startswith("scrypt$16384$8$5$") and security.verify_password(PW, stored), stored[:20])
    make_account("inactive@sec0220.test", password_hash=old_hash, active=False)
    inactive = new_client("198.51.100.36").post(
        "/api/auth/login", json={"email": "inactive@sec0220.test", "password": PW})
    case("an inactive account is refused (403) and not upgraded",
         inactive.status_code == 403 and db.query_one(
             "SELECT password_hash FROM accounts WHERE email=?", ("inactive@sec0220.test",))["password_hash"] == old_hash,
         inactive.status_code)

    # =======================================================================
    section("password policy")
    case("farmer: 7 characters rejected", security.password_policy_error("1234567", "user") == "Kata sandi minimal 8 karakter")
    case("farmer: 8 characters accepted", security.password_policy_error("12345678", "user") is None)
    case("priority farmer follows the farmer rule", security.password_policy_error("12345678", "priority") is None)
    case("admin: 11 characters rejected with a Bahasa message",
         security.password_policy_error("a" * 11, "admin") == "Kata sandi admin minimal 12 karakter")
    case("admin: 12 characters accepted", security.password_policy_error("a" * 12, "admin") is None)
    case("201 characters rejected", "terlalu panjang" in (security.password_policy_error("a" * 201, "user") or ""))
    case("200 characters accepted", security.password_policy_error("a" * 200, "user") is None)
    case("a non-string is rejected", security.password_policy_error(None, "user") is not None)
    case("the legacy 8-character helper is untouched", security.password_problem("abc") == "Kata sandi minimal 8 karakter")

    # =======================================================================
    section("session lifetime by role")
    admin_client = new_client("203.0.113.60")
    admin_login = login(admin_client, ADMIN_EMAIL, ADMIN_PASSWORD)
    case("the bootstrap admin can log in", admin_login.status_code == 200, admin_login.status_code)
    admin_row = db.query_one(
        "SELECT s.created_ms, s.expires_ms FROM sessions s JOIN accounts a ON a.id = s.account_id "
        "WHERE a.email = ? ORDER BY s.created_ms DESC LIMIT 1", (ADMIN_EMAIL,))
    admin_days = (admin_row["expires_ms"] - admin_row["created_ms"]) / 86_400_000
    admin_cookie = set_cookie_values(admin_login, "jk_session")[0]
    case("an admin session row lasts 7 days", abs(admin_days - 7) < 0.01, admin_days)
    case("...and so does its cookie", cookie_attribute(admin_cookie, "Max-Age") == str(7 * 86_400), admin_cookie)
    farmer_login = login(new_client("203.0.113.61"), "a@sec0220.test")
    farmer_row = db.query_one(
        "SELECT created_ms, expires_ms FROM sessions WHERE account_id=? ORDER BY created_ms DESC LIMIT 1", (id_a,))
    case("a farmer session lasts 30 days (row and cookie)",
         abs((farmer_row["expires_ms"] - farmer_row["created_ms"]) / 86_400_000 - 30) < 0.01
         and cookie_attribute(set_cookie_values(farmer_login, "jk_session")[0], "Max-Age") == str(30 * 86_400))
    os.environ["SESSION_TTL_DAYS"] = "5"
    try:
        registered = new_client("203.0.113.62").post(
            "/api/auth/register", json={"email": "reg@sec0220.test", "password": PW, "name": "Reg"})
        reg_account = db.query_one("SELECT id FROM accounts WHERE email=?", ("reg@sec0220.test",))
        reg_row = db.query_one("SELECT created_ms, expires_ms FROM sessions WHERE account_id=?", (reg_account["id"],))
        case("register: the session row and the cookie have the same lifetime (5 days)",
             registered.status_code == 200
             and abs((reg_row["expires_ms"] - reg_row["created_ms"]) / 86_400_000 - 5) < 0.01
             and cookie_attribute(set_cookie_values(registered, "jk_session")[0], "Max-Age") == str(5 * 86_400),
             f"{registered.status_code} {reg_row}")
        os.environ["SESSION_TTL_DAYS"] = "3"
        short_admin = login(new_client("203.0.113.63"), ADMIN_EMAIL, ADMIN_PASSWORD)
        case("an admin never gets MORE than SESSION_TTL_DAYS (3 < 7)",
             cookie_attribute(set_cookie_values(short_admin, "jk_session")[0], "Max-Age") == str(3 * 86_400))
    finally:
        os.environ["SESSION_TTL_DAYS"] = "30"

    # =======================================================================
    section("own password change: policy and session rotation")
    make_account("rot@sec0220.test")
    first, second = new_client("203.0.113.70"), new_client("203.0.113.71")
    login(first, "rot@sec0220.test"), login(second, "rot@sec0220.test")
    old_token = first.cookies.get("jk_session")
    bad_current = first.post("/api/auth/password", json={"current": "wrong-password", "new": "BaruSandi-12345"},
                             headers=csrf(first))
    case("a wrong current password is refused and nothing rotates",
         bad_current.status_code == 400 and not bad_current.headers.get_list("set-cookie")
         and first.cookies.get("jk_session") == old_token, bad_current.status_code)
    short_new = first.post("/api/auth/password", json={"current": PW, "new": "short1"}, headers=csrf(first))
    case("a too-short new farmer password is refused (400, Bahasa)",
         short_new.status_code == 400 and "minimal 8" in short_new.json()["detail"], short_new.text[:100])
    old_csrf = first.cookies.get("jk_csrf")
    changed = first.post("/api/auth/password", json={"current": PW, "new": "BaruSandi-12345"}, headers=csrf(first))
    case("the password change succeeds and reports the other session it revoked",
         changed.status_code == 200 and changed.json().get("revokedSessions") == 1
         and changed.json().get("csrf"), f"{changed.status_code} {changed.text[:120]}")
    new_token = first.cookies.get("jk_session")
    case("the caller gets a FRESH session token and CSRF token",
         bool(new_token) and new_token != old_token and first.cookies.get("jk_csrf") != old_csrf)
    case("the new cookie has the full farmer lifetime",
         cookie_attribute(set_cookie_values(changed, "jk_session")[0], "Max-Age") == str(30 * 86_400))
    case("the new session works (read and write with the new CSRF token)",
         first.get("/api/auth/me").json().get("ok") is True
         and first.post("/api/records", json={"crop": "Setelah ganti"}, headers=csrf(first)).status_code == 200)
    stale = new_client("203.0.113.72", cookies={"jk_session": old_token}).get("/api/auth/me")
    case("the previous token no longer works", stale.json().get("ok") is False, stale.text)
    case("the other device is signed out", second.get("/api/auth/me").json().get("ok") is False)
    case("exactly one session remains for the account",
         db.query_one("SELECT COUNT(*) AS n FROM sessions s JOIN accounts a ON a.id=s.account_id WHERE a.email=?",
                      ("rot@sec0220.test",))["n"] == 1)
    case("the old password no longer logs in",
         new_client("203.0.113.73").post("/api/auth/login", json={"email": "rot@sec0220.test", "password": PW}).status_code == 401)
    case("the new password logs in",
         new_client("203.0.113.74").post("/api/auth/login", json={"email": "rot@sec0220.test", "password": "BaruSandi-12345"}).status_code == 200)
    admin_short = admin_client.post("/api/auth/password", json={"current": ADMIN_PASSWORD, "new": "Short-1234!"},
                                    headers=csrf(admin_client))
    case("an admin's new password must have 12 characters (11 refused)",
         admin_short.status_code == 400 and "12" in admin_short.json()["detail"], admin_short.text[:100])
    admin_ok = admin_client.post("/api/auth/password", json={"current": ADMIN_PASSWORD, "new": "Longer-12345"},
                                 headers=csrf(admin_client))
    case("12 characters are accepted for an admin, and the admin session rotates with a 7-day cookie",
         admin_ok.status_code == 200 and cookie_attribute(set_cookie_values(admin_ok, "jk_session")[0], "Max-Age") == str(7 * 86_400),
         f"{admin_ok.status_code} {admin_ok.text[:100]}")
    ADMIN_PASSWORD = "Longer-12345"

    # =======================================================================
    section("retention purge")
    now = db.now_ms()
    day = 86_400_000
    with db.transaction() as tx:
        tx.execute("INSERT OR REPLACE INTO login_attempts (key,fails,locked_until_ms,updated_ms) VALUES (?,?,?,?)",
                   ("ret:old", 1, 0, now - 31 * day))
        tx.execute("INSERT OR REPLACE INTO login_attempts (key,fails,locked_until_ms,updated_ms) VALUES (?,?,?,?)",
                   ("ret:fresh", 1, 0, now - 29 * day))
        tx.executemany("INSERT OR REPLACE INTO login_attempts (key,fails,locked_until_ms,updated_ms) VALUES (?,?,?,?)",
                       [(f"ret:bulk{i}", 1, 0, now - 40 * day) for i in range(4500)])
        tx.execute("INSERT INTO audit_log (ts_ms,account_id,actor_email,action,target,detail) VALUES (?,?,?,?,?,?)",
                   (now - 401 * day, None, "ret@test", "ret.test", "too-old", None))
        tx.execute("INSERT INTO audit_log (ts_ms,account_id,actor_email,action,target,detail) VALUES (?,?,?,?,?,?)",
                   (now - 399 * day, None, "ret@test", "ret.test", "keep", None))
        tx.execute("INSERT INTO sessions (token_hash,account_id,created_ms,expires_ms,user_agent,ip) VALUES (?,?,?,?,?,?)",
                   ("ret-expired", id_a, now - 40 * day, now - 10 * day, "t", "t"))
    outcome = security.purge_retention()
    case("login_attempts older than 30 days are deleted (including batches > 2000)",
         db.query_one("SELECT COUNT(*) AS n FROM login_attempts WHERE key = 'ret:old' OR key LIKE 'ret:bulk%'")["n"] == 0
         and outcome["loginAttempts"] >= 4501, outcome)
    case("login_attempts younger than 30 days stay",
         db.query_one("SELECT COUNT(*) AS n FROM login_attempts WHERE key='ret:fresh'")["n"] == 1)
    case("audit_log older than 400 days is deleted, younger stays",
         db.query_one("SELECT COUNT(*) AS n FROM audit_log WHERE target='too-old'")["n"] == 0
         and db.query_one("SELECT COUNT(*) AS n FROM audit_log WHERE target='keep'")["n"] == 1, outcome)
    case("expired sessions are purged and live ones are kept",
         db.query_one("SELECT COUNT(*) AS n FROM sessions WHERE token_hash='ret-expired'")["n"] == 0
         and security.session_count(id_a) >= 1)

    # =======================================================================
    section("access-log privacy")
    access = logging.getLogger("uvicorn.access")
    security.install_access_log_redaction()
    case("exactly one redaction filter is installed on uvicorn.access (idempotent)",
         sum(isinstance(f, security.CoordinateRedactionFilter) for f in access.filters) == 1)
    captured = io.StringIO()
    handler = logging.StreamHandler(captured)
    handler.setFormatter(logging.Formatter("%(message)s"))
    previous_level = access.level
    access.addHandler(handler)
    access.setLevel(logging.INFO)
    try:
        access.info('%s - "%s %s HTTP/%s" %d', "127.0.0.1:5000", "GET",
                    "/api/telemetry?lat=-6.595&lng=106.816&placeHint=Bogor", "1.1", 200)
        access.info('%s - "%s %s HTTP/%s" %d', "127.0.0.1:5000", "GET",
                    "/api/x?LON=107.5&Lat=-6.1&q=1", "1.1", 200)
        access.info('%s - "%s %s HTTP/%s" %d', "127.0.0.1:5000", "GET", "/api/records", "1.1", 200)
    finally:
        access.removeHandler(handler)
        access.setLevel(previous_level)
    lines = captured.getvalue().splitlines()
    case("lat/lng values are redacted in access-log lines",
         "lat=***" in lines[0] and "lng=***" in lines[0] and "-6.595" not in lines[0] and "106.816" not in lines[0], lines[0])
    case("other query values and the rest of the line are kept",
         "placeHint=Bogor" in lines[0] and lines[0].startswith("127.0.0.1:5000 - \"GET /api/telemetry") and lines[0].endswith("200"))
    case("lon and mixed-case keys are redacted too", "LON=***" in lines[1] and "Lat=***" in lines[1] and "q=1" in lines[1]
         and "107.5" not in lines[1], lines[1])
    case("a request without coordinates is logged unchanged", lines[2] == '127.0.0.1:5000 - "GET /api/records HTTP/1.1" 200', lines[2])
    case("redact_coordinates works on plain text", security.redact_coordinates("GET /a?x=1&lng=5.5") == "GET /a?x=1&lng=***")

    # =======================================================================
    section("worker token warning")
    original_token = os.environ["WORKER_TOKEN"]
    os.environ["WORKER_TOKEN"] = "Zq9-short-token"
    try:
        warning = security.worker_token_warning()
        case("a short WORKER_TOKEN produces a warning that never contains the token",
             bool(warning) and "WORKER_TOKEN" in warning and "32" in warning and "Zq9-short-token" not in warning, warning)
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            with TestClient(ASGI_APP):
                pass
        printed = buffer.getvalue()
        case("the lifespan prints the warning at startup (and not the token)",
             "WORKER_TOKEN is only 15 characters" in printed and "Zq9-short-token" not in printed, printed[-200:])
    finally:
        os.environ["WORKER_TOKEN"] = original_token
    case("a 32+ character token produces no warning", security.worker_token_warning() is None)
    os.environ["WORKER_TOKEN"] = ""
    try:
        case("an unset token is the other (existing) warning, not this one", security.worker_token_warning() is None)
    finally:
        os.environ["WORKER_TOKEN"] = original_token
    os.environ["WORKER_TOKEN"] = "k" * 31
    warns_at_31 = security.worker_token_warning() is not None
    os.environ["WORKER_TOKEN"] = "k" * 32
    quiet_at_32 = security.worker_token_warning() is None
    os.environ["WORKER_TOKEN"] = original_token
    case("exactly 31 characters still warn, 32 do not", warns_at_31 and quiet_at_32, (warns_at_31, quiet_at_32))

    # =======================================================================
    section("maintenance thread and storage drainer hook")
    threads = [t for t in threading.enumerate() if t.name == "jk-maintenance"]
    case("the lifespan runs exactly ONE maintenance thread", len(threads) == 1, [t.name for t in threading.enumerate()])
    case("it is a daemon thread", all(t.daemon for t in threads))
    queue_module = app_module.job_queue
    had_queue_fn = hasattr(queue_module, "run_maintenance")
    original_queue_fn = getattr(queue_module, "run_maintenance", None)
    original_purge = security.purge_retention
    original_storage = app_module.storage_module
    ran = {"queue": 0, "purge": 0, "drainer": []}

    class FakeStorage:
        @staticmethod
        def start_background_drainer(application):
            ran["drainer"].append(application)

    def fake_queue():
        ran["queue"] += 1
        return {"purged": 0}

    def fake_purge():
        ran["purge"] += 1
        return {"loginAttempts": 0}

    queue_module.run_maintenance = fake_queue
    security.purge_retention = fake_purge
    app_module.storage_module = FakeStorage
    app_module.MAINTENANCE_FIRST_RUN_SECONDS = 0.05
    app_module.MAINTENANCE_INTERVAL_SECONDS = 0.05
    try:
        with TestClient(ASGI_APP):
            deadline = time.time() + 5
            while (ran["queue"] < 2 or ran["purge"] < 2) and time.time() < deadline:
                time.sleep(0.05)
            alive_inside = [t for t in threading.enumerate() if t.name == "jk-maintenance"]
        time.sleep(0.2)
        after = ran["queue"]
        time.sleep(0.3)
        case("the thread calls queue.run_maintenance and security.purge_retention repeatedly",
             ran["queue"] >= 2 and ran["purge"] >= 2, ran)
        case("the storage drainer is started once with the FastAPI app", ran["drainer"] == [ASGI_APP], ran["drainer"])
        case("the maintenance thread stops with the application",
             not [t for t in threading.enumerate() if t.name == "jk-maintenance" and t not in threads]
             and ran["queue"] == after, (ran, after))
        case("each lifespan starts exactly one maintenance thread of its own",
             len(alive_inside) == 2, [t.name for t in alive_inside])

        def failing_queue():
            raise RuntimeError("synthetic maintenance failure")

        queue_module.run_maintenance = failing_queue
        logging.disable(logging.CRITICAL)  # the step logs its traceback; keep the test output clean
        try:
            outcome_failing = app_module.run_maintenance_once()
        finally:
            logging.disable(logging.NOTSET)
        case("a failing step is isolated: the other step still runs",
             outcome_failing.get("jobs") == {"error": True} and "retention" in outcome_failing, outcome_failing)
        del queue_module.run_maintenance
        outcome_missing = app_module.run_maintenance_once()
        case("a missing queue.run_maintenance is skipped (guarded getattr)",
             "jobs" not in outcome_missing and "retention" in outcome_missing, outcome_missing)
        app_module.storage_module = None
        with TestClient(ASGI_APP):
            pass
        case("a missing storage module does not stop the application from starting", True)
    finally:
        security.purge_retention = original_purge
        app_module.storage_module = original_storage
        if had_queue_fn:
            queue_module.run_maintenance = original_queue_fn
        elif hasattr(queue_module, "run_maintenance"):
            del queue_module.run_maintenance
        app_module.MAINTENANCE_FIRST_RUN_SECONDS = 60
        app_module.MAINTENANCE_INTERVAL_SECONDS = 3600

    # =======================================================================
    section("deployment files")
    app_unit = (BASE / "deploy" / "jagakebond.service").read_text(encoding="utf-8")
    worker_unit = (BASE / "deploy" / "jagakebond-worker.service").read_text(encoding="utf-8")
    fast_unit = (BASE / "deploy" / "jagakebond-worker-fast.service").read_text(encoding="utf-8")

    def directives(text: str) -> dict[str, str]:
        found: dict[str, str] = {}
        for line in text.splitlines():
            if "=" in line and not line.strip().startswith(("#", "[", "--")):
                key, _, value = line.partition("=")
                found[key.strip()] = value.strip()
        return found

    shared = {
        "PrivateDevices": "yes", "ProtectKernelTunables": "true", "ProtectKernelModules": "yes",
        "ProtectKernelLogs": "yes", "ProtectControlGroups": "true",
        "RestrictAddressFamilies": "AF_UNIX AF_INET AF_INET6", "RestrictNamespaces": "true",
        "LockPersonality": "true", "RestrictRealtime": "yes", "RestrictSUIDSGID": "true",
        "CapabilityBoundingSet": "", "SystemCallArchitectures": "native", "UMask": "0077",
        "TasksMax": "256", "NoNewPrivileges": "true", "PrivateTmp": "true", "ProtectSystem": "strict",
        "ProtectHome": "true", "User": "jagakebond", "Group": "jagakebond",
        "EnvironmentFile": "/srv/sites/jagake.bond/app/.env",
    }
    app_found, worker_found, fast_found = directives(app_unit), directives(worker_unit), directives(fast_unit)
    case("app unit: hardening directives present with the agreed values",
         all(app_found.get(k) == v for k, v in shared.items()),
         {k: app_found.get(k) for k, v in shared.items() if app_found.get(k) != v})
    case("app unit: MemoryHigh=700M and MemoryMax=900M", (app_found.get("MemoryHigh"), app_found.get("MemoryMax")) == ("700M", "900M"))
    case("app unit: everything that was there is kept (paths, loopback bind, restart)",
         app_found.get("WorkingDirectory") == "/srv/sites/jagake.bond/app"
         and app_found.get("ExecStart", "").startswith("/srv/sites/jagake.bond/runtime/venvs/sha256-51acce0dd5bf8868/bin/uvicorn")
         and app_found.get("ReadWritePaths") == "/srv/sites/jagake.bond/app/data"
         and "--host 127.0.0.1 --port 8010" in app_unit and "--workers 1" in app_unit
         and app_found.get("Restart") == "always" and app_found.get("LimitNOFILE") == "4096")
    case("worker unit: hardening directives present with the agreed values",
         all(worker_found.get(k) == v for k, v in shared.items()),
         {k: worker_found.get(k) for k, v in shared.items() if worker_found.get(k) != v})
    case("worker unit: MemoryMax=300M and RestartSec=30",
         (worker_found.get("MemoryMax"), worker_found.get("RestartSec")) == ("300M", "30"))
    case("worker unit: writes nothing, same exec line", worker_found.get("ReadWritePaths") == ""
         and worker_found.get("WorkingDirectory") == "/srv/sites/jagake.bond/app"
         and worker_found.get("ExecStart", "").startswith("/srv/sites/jagake.bond/runtime/venvs/sha256-51acce0dd5bf8868/bin/python")
         and "worker/gemini_worker.py" in worker_unit)
    case("fast worker: same hardened root/runtime and no direct writes",
         all(fast_found.get(k) == v for k, v in shared.items())
         and fast_found.get("WorkingDirectory") == "/srv/sites/jagake.bond/app"
         and fast_found.get("ExecStart", "").startswith("/srv/sites/jagake.bond/runtime/venvs/sha256-51acce0dd5bf8868/bin/python")
         and fast_found.get("ReadWritePaths") == "" and "WORKER_LANE=fast" in fast_unit
         and "worker/gemini_worker.py" in fast_unit)
    analyze = shutil.which("systemd-analyze")
    if analyze:
        verdicts = []
        for unit in ("jagakebond.service", "jagakebond-worker.service", "jagakebond-worker-fast.service"):
            result = subprocess.run([analyze, "verify", "--man=no", str(BASE / "deploy" / unit)],
                                    capture_output=True, text=True, timeout=60)
            verdicts.append((unit, [line for line in (result.stdout + result.stderr).splitlines()
                                    if re.search(r"Unknown key|Unknown section|Failed to parse|Invalid", line, re.I)]))
        case("systemd-analyze verify knows every directive (no unknown/invalid keys)",
             all(not bad for _unit, bad in verdicts), verdicts)
    env_example = (BASE / ".env.example").read_text(encoding="utf-8")
    case(".env.example documents the new variables",
         all(f"{name}=" in env_example for name in ("JK_ENABLE_API_DOCS", "JK_ALLOWED_ORIGINS", "JK_ROUTER_ALLOWED_HOSTS")))
    case(".env.example keeps the first-run variables verify_mvp.py reads", "SEED_DEMO_DATA" in env_example)
finally:
    LIFESPAN.__exit__(None, None, None)
    db.close_all()
    TMP.cleanup()

passed = sum(1 for _, ok, _ in CASES if ok)
total = len(CASES)
print()
print(f"security-0220: {passed}/{total} assertions passed")
for name, ok, detail in CASES:
    if not ok:
        print("  FAILED:", name, "::", detail)
sys.exit(0 if passed == total else 1)
