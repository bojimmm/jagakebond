"""JagaKebond — application shell.

Wires the routers together, applies the cross-cutting middleware, serves the PWA
and runs first-boot bootstrap. Business logic lives in the sibling modules:

  db.py              SQLite connection, migrations, seeds, legacy import
  security.py        password hashing, sessions, CSRF, secret encryption
  settings_store.py  operator-editable settings (the admin console writes here)
  auth.py            accounts, sessions, auth dependencies
  google_auth.py     Sign in with Google: ID-token checks, nonces, registration requests
  queue.py           job helpers + the PRD section 6 confidence gate
  api_app.py         farmer-facing, account-scoped API
  api_admin.py       admin console API

One process only: SQLite allows a single writer, so run exactly one uvicorn worker.
"""

from __future__ import annotations

import importlib
import logging
import os
import threading
from contextlib import asynccontextmanager
from functools import lru_cache
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "db.sqlite3"

for _d in (DATA_DIR, DATA_DIR / "uploads"):
    _d.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------------------
# .env (stdlib parser; the real environment always wins)
# ---------------------------------------------------------------------------


def _load_dotenv() -> None:
    path = BASE_DIR / ".env"
    if not path.exists():
        return
    try:
        raw = path.read_text(encoding="utf-8-sig")
    except OSError:
        return
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        # An env var that exists but is EMPTY must not shadow .env, otherwise
        # `export SECRET_KEY=` would silently disable API-key encryption.
        if key and not os.environ.get(key):
            os.environ[key] = value


_load_dotenv()

from . import auth, db, google_auth, security, settings_store  # noqa: E402
from . import queue as job_queue  # noqa: E402
from .api_admin import router as admin_router  # noqa: E402
from .api_app import router as app_router  # noqa: E402
from .auth import router as auth_router  # noqa: E402
from .google_auth import router as google_router  # noqa: E402

# Re-exported so existing importers keep working:
#   tests/test_confidence_gate.py imports these from backend.app
from .queue import (  # noqa: E402,F401
    GATE_ISOLATE_TEXT,
    GATE_REPHOTO_TEXT,
    apply_confidence_gate,
    _apply_confidence_gate,
)

# The photo-lifecycle module is optional at import time so the shell still starts while it
# is absent (older trees, partial checkouts). Any OTHER import failure inside it is real
# and is not swallowed.
try:
    # import_module (not `from . import storage`): a missing submodule then raises
    # ModuleNotFoundError naming it, which is how a real inner import error is told apart.
    storage_module: Any = importlib.import_module(f"{__package__}.storage")
except ModuleNotFoundError as _missing:  # pragma: no cover - depends on the tree
    if _missing.name != f"{__package__}.storage":
        raise
    storage_module = None

from .version import APP_VERSION  # noqa: E402

logger = logging.getLogger("jagakebond")

MUTATING_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
# No session exists yet on these, so a CSRF token cannot exist either.
CSRF_EXEMPT_PATHS = {"/api/auth/login", "/api/auth/register", "/api/auth/google", "/api/auth/google/nonce"}

# GPS coordinates must not sit in the journal (uvicorn prints the whole request target).
security.install_access_log_redaction()


def _env_flag(name: str) -> bool:
    return str(os.environ.get(name, "")).strip().lower() in ("1", "true", "yes", "on", "ya")


# ---------------------------------------------------------------------------
# Headers, CSP and caching (one place, every response)
# ---------------------------------------------------------------------------

# /admin and /admin.html: no inline script, no external anything. admin.js and the
# vendored assets are same-origin files.
ADMIN_CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; "
    "base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
)
# Every other HTML document (the field app). Since 0.2.4.16 the page has no inline handlers (actions.js
# delegates data-act), so scripts are 'self' only; map tiles are the only third-party content.
APP_CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob: https://tile.openstreetmap.org https://*.tile.openstreetmap.org "
    "https://server.arcgisonline.com https://*.googleusercontent.com https://*.ggpht.com; "
    "font-src 'self' data:; connect-src 'self' data: blob:; "
    "media-src 'self' blob:; worker-src 'self'; manifest-src 'self'; object-src 'none'; "
    "base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
)
# The field app once GOOGLE_CLIENT_ID is set (0.2.3.0): APP_CSP plus Google Identity Services, and
# only its sign-in paths (the button script, its iframe, its stylesheet and its FedCM/status calls).
APP_CSP_GOOGLE = (
    "default-src 'self'; script-src 'self' https://accounts.google.com/gsi/client; "
    "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style; "
    "img-src 'self' data: blob: https://tile.openstreetmap.org https://*.tile.openstreetmap.org "
    "https://server.arcgisonline.com https://*.googleusercontent.com https://*.ggpht.com; font-src 'self' data:; "
    "connect-src 'self' data: blob: https://accounts.google.com/gsi/; "
    "frame-src 'self' https://accounts.google.com/gsi/; "
    "media-src 'self' blob:; worker-src 'self'; manifest-src 'self'; object-src 'none'; "
    "base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
)
# Google's sign-in popup talks back to the page through window.opener; `same-origin` would cut it off.
APP_COOP = "same-origin-allow-popups"

BASE_SECURITY_HEADERS = (
    ("X-Content-Type-Options", "nosniff"),
    ("X-Frame-Options", "DENY"),
    ("Referrer-Policy", "strict-origin-when-cross-origin"),
    ("Permissions-Policy", "geolocation=(self), camera=(self), microphone=()"),
)
HSTS_VALUE = "max-age=31536000"

API_CACHE_CONTROL = "no-store, no-cache, must-revalidate"
# The app ships with no build step, so app.js and styles.css keep their URL while their
# contents change on every deploy. Served with no Cache-Control from here, Cloudflare applied
# its 4-hour default to static extensions and kept serving the previous build long after a
# deploy — a shipped fix simply looked like it had never happened. `no-cache` means "store
# it, but revalidate before every use": StaticFiles' ETag/Last-Modified turn that into a
# cheap 304, and a stale ?v= query can no longer pin an old build.
STATIC_CACHE_CONTROL = "no-cache"
_REVALIDATED_SUFFIXES = (".html", ".js", ".mjs", ".css", ".webmanifest")
_REVALIDATED_TYPES = {
    "text/html", "text/css", "text/javascript", "application/javascript",
    "application/manifest+json",
}


def _is_admin_html(path: str) -> bool:
    return path.rstrip("/") in ("/admin", "/admin.html")


def cache_control_for(path: str, content_type: str) -> str | None:
    """Cache-Control for a response, or None to leave whatever the route/StaticFiles set."""
    if path.startswith("/api/"):
        return API_CACHE_CONTROL
    if path == "/sw.js":
        # The service worker script must always be re-fetched or an update can never land.
        return "no-store"
    lowered = path.lower()
    if path == "/" or lowered.endswith("/") or lowered.endswith(_REVALIDATED_SUFFIXES):
        return STATIC_CACHE_CONTROL
    if content_type in _REVALIDATED_TYPES:
        return STATIC_CACHE_CONTROL
    return None


def apply_response_headers(path: str, headers: MutableHeaders) -> None:
    """Stamp the one consistent header set on a response (replacing any duplicate)."""
    for name, value in BASE_SECURITY_HEADERS:
        headers[name] = value
    if auth.cookie_secure():
        # Only a deployment that serves cookies as Secure is HTTPS-only; browsers ignore
        # HSTS received over plain http, so local http testing is unaffected.
        headers["Strict-Transport-Security"] = HSTS_VALUE
    content_type = (headers.get("content-type") or "").split(";", 1)[0].strip().lower()
    if content_type == "text/html":
        if _is_admin_html(path):
            headers["Content-Security-Policy"] = ADMIN_CSP
        else:
            headers["Content-Security-Policy"] = APP_CSP_GOOGLE if google_auth.enabled() else APP_CSP
            headers["Cross-Origin-Opener-Policy"] = APP_COOP
    if path == "/admin" or path.startswith("/admin"):
        headers["X-Robots-Tag"] = "noindex, nofollow"
    policy = cache_control_for(path, content_type)
    if policy is not None:
        headers["Cache-Control"] = policy
        if path.startswith("/api/"):
            headers["Pragma"] = "no-cache"
            headers["Expires"] = "0"


# ---------------------------------------------------------------------------
# CSRF: Origin / Referer check (in addition to the double-submit token)
# ---------------------------------------------------------------------------

# The Android app's WebView page origin (capacitor.config.json: androidScheme "https",
# hostname "localhost"). Its API calls go through the native bridge (HttpURLConnection),
# which sends NO Origin header, so this entry is a safety net rather than the normal path.
BUILTIN_ALLOWED_ORIGINS = ("https://localhost",)


def _origin_parts(value: str) -> tuple[str, str, int | None] | None:
    """(scheme, host, port) of an Origin/Referer value; None when it is not an http(s) origin.

    "null", garbage, chrome-extension:// and friends all return None. Default ports are
    dropped so https://example.com and https://example.com:443 compare equal.
    """
    try:
        parts = urlsplit(value.strip())
        host = parts.hostname
        port = parts.port
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or not host:
        return None
    if (parts.scheme == "http" and port == 80) or (parts.scheme == "https" and port == 443):
        port = None
    return parts.scheme, host.lower().rstrip("."), port


def _host_parts(value: str) -> tuple[str, int | None] | None:
    """(host, port) of a Host / X-Forwarded-Host header value."""
    try:
        parts = urlsplit("//" + value.strip())
        host = parts.hostname
        port = parts.port
    except ValueError:
        return None
    if not host:
        return None
    if port in (80, 443):
        port = None
    return host.lower().rstrip("."), port


@lru_cache(maxsize=16)
def _allowed_origin_sets(raw: str) -> tuple[frozenset, frozenset]:
    """Parse JK_ALLOWED_ORIGINS (+ the built-ins) into (exact origins, bare hosts).

    An entry with a scheme (https://app.example) must match scheme, host and port; a bare
    host (app.example or app.example:8443) matches that host over either scheme.
    """
    exact: set[tuple[str, str, int | None]] = set()
    hosts: set[tuple[str, int | None]] = set()
    for item in [*BUILTIN_ALLOWED_ORIGINS, *raw.split(",")]:
        item = item.strip()
        if not item:
            continue
        if "://" in item:
            parsed = _origin_parts(item)
            if parsed:
                exact.add(parsed)
        else:
            host = _host_parts(item)
            if host:
                hosts.add(host)
    return frozenset(exact), frozenset(hosts)


def origin_is_allowed(headers: Headers) -> bool:
    """False when a state-changing request comes from a page that is not this site.

    A browser always sends Origin on cross-site POSTs and on same-site fetch() POSTs; the
    native Android bridge, the worker and curl send neither header and are allowed (the
    session cookie + CSRF token still apply to them). Rules:
      * Origin present -> it must be this site, an allowed origin, or the WebView origin.
        "null" (sandboxed/redirected contexts) is refused.
      * no Origin but an http(s) Referer -> same test on the Referer's origin.
      * neither -> allowed.
    "This site" means the host the request was addressed to (Host header, or the first
    X-Forwarded-Host when a proxy rewrites Host). The scheme is deliberately not compared:
    behind a TLS-terminating tunnel the app may see http while the browser used https.
    """
    origins = headers.getlist("origin")
    if len(origins) > 1:
        return False
    if origins:
        subject = origins[0]
    else:
        referer = headers.get("referer")
        if not referer or _origin_parts(referer) is None:
            return True
        subject = referer
    parsed = _origin_parts(subject)
    if parsed is None:
        return False
    _scheme, host, port = parsed
    exact, bare_hosts = _allowed_origin_sets(os.environ.get("JK_ALLOWED_ORIGINS", ""))
    if parsed in exact or (host, port) in bare_hosts:
        return True
    own = []
    host_header = headers.get("host")
    if host_header:
        own.append(_host_parts(host_header))
    forwarded = headers.get("x-forwarded-host")
    if forwarded:
        own.append(_host_parts(forwarded.split(",", 1)[0]))
    return (host, port) in [candidate for candidate in own if candidate]


# ---------------------------------------------------------------------------
# Early upload guard
# ---------------------------------------------------------------------------

UPLOAD_PATHS = {"/api/photos", "/api/analyze"}
# Multipart framing and the form fields around the photo.
UPLOAD_OVERHEAD_BYTES = 1024 * 1024


def _upload_limits(token: str) -> tuple[dict[str, Any] | None, int]:
    """(account for the session token or None, configured MAX_UPLOAD_MB). Blocking SQLite."""
    account = security.session_account(token)
    try:
        max_mb = settings_store.as_int("MAX_UPLOAD_MB")
    except Exception:  # noqa: BLE001 - never let the guard's own lookup take the route down
        max_mb = 12
    return account, max_mb


def _json_error(status: int, detail: str, code: str | None = None,
                headers: dict[str, str] | None = None) -> JSONResponse:
    content: dict[str, Any] = {"detail": detail}
    if code:
        content["code"] = code
    return JSONResponse(status_code=status, content=content, headers=headers)


class SecurityMiddleware:
    """Pure ASGI middleware: request guards in front, one header set on every response.

    Written as plain ASGI rather than @app.middleware("http") so that (a) it can answer
    before the request body is read — and ask the server to close the connection instead
    of draining a large upload — and (b) the headers are applied to EVERY response start,
    including the ones this middleware itself produces and error responses from inner
    layers, with no per-route code.

    Order for a state-changing /api/ request:
      1. Origin/Referer must be this site (403)            — also on login/register
      2. double-submit CSRF token, when a session cookie is present (403)
      3. POST /api/photos and /api/analyze only (before the body is read):
         no/invalid session -> 401, wrong X-JK-Account -> 409, Content-Length above
         MAX_UPLOAD_MB + 1 MB -> 413; a body without Content-Length is counted while it
         streams and cut off at the same limit.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path: str = scope.get("path", "")
        method: str = scope.get("method", "GET")
        headers = Headers(scope=scope)
        stamped_send = self._stamping_send(send, path)

        early, limit = await self._early_response(scope, headers, path, method)
        if early is not None:
            await early(scope, receive, stamped_send)
            return

        if limit is not None and "content-length" not in headers:
            receive = self._counting_receive(receive, limit)
        await self.app(scope, receive, stamped_send)

    @staticmethod
    def _stamping_send(send: Send, path: str) -> Send:
        async def stamped(message: Message) -> None:
            if message["type"] == "http.response.start":
                message.setdefault("headers", [])
                apply_response_headers(path, MutableHeaders(scope=message))
            await send(message)

        return stamped

    @staticmethod
    def _counting_receive(receive: Receive, limit: int) -> Receive:
        seen = 0

        async def counted() -> Message:
            nonlocal seen
            message = await receive()
            if message["type"] == "http.request":
                seen += len(message.get("body", b""))
                if seen > limit:
                    raise auth.CodedHTTPException(
                        413, "Foto terlalu besar. Kecilkan ukuran foto lalu coba lagi.",
                        "payload_too_large", headers={"Connection": "close"})
            return message

        return counted

    async def _early_response(self, scope: Scope, headers: Headers, path: str,
                              method: str) -> tuple[JSONResponse | None, int | None]:
        """(response to send instead of calling the app, streaming body limit or None)."""
        if method not in MUTATING_METHODS or not path.startswith("/api/"):
            return None, None

        is_upload = method == "POST" and path.rstrip("/") in UPLOAD_PATHS
        # Answering an upload before its (possibly 12 MB) body is read: ask the server to
        # close the connection instead of draining the rest of it.
        close = {"Connection": "close"} if is_upload else None

        if not origin_is_allowed(headers):
            return _json_error(403, "Permintaan ditolak: asal halaman tidak dikenali. "
                                    "Muat ulang halaman.", "origin_denied", close), None

        request = Request(scope)
        if path not in CSRF_EXEMPT_PATHS:
            # Worker-token calls carry no cookie, so they are unaffected by design.
            if (request.cookies.get(security.SESSION_COOKIE)
                    and not security.worker_ok(headers.get("x-worker-token"))
                    and not security.csrf_ok(request.cookies.get(security.CSRF_COOKIE),
                                             headers.get(security.CSRF_HEADER))):
                return _json_error(403, "Token CSRF tidak valid. Muat ulang halaman.",
                                   "csrf_invalid", close), None

        if is_upload:
            return await self._upload_guard(request, headers)
        return None, None

    async def _upload_guard(self, request: Request,
                            headers: Headers) -> tuple[JSONResponse | None, int | None]:
        close = {"Connection": "close"}
        token = request.cookies.get(security.SESSION_COOKIE)
        if not token:
            return _json_error(401, "Belum masuk. Silakan masuk.", headers=close), None
        try:
            account, max_mb = await run_in_threadpool(_upload_limits, token)
        except Exception:  # noqa: BLE001 - the route's own dependency still enforces auth
            logger.exception("upload guard lookup failed; deferring to the route")
            return None, None
        if account is None:
            return _json_error(401, "Belum masuk. Silakan masuk.", headers=close), None
        if auth.account_binding_mismatch(headers, account["id"]):
            return _json_error(409, auth.ACCOUNT_MISMATCH_DETAIL, "account_mismatch",
                               headers=close), None
        limit = max_mb * 1024 * 1024 + UPLOAD_OVERHEAD_BYTES
        declared = headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > limit:
            return _json_error(413, f"Foto terlalu besar. Maksimal {max_mb} MB.",
                               "payload_too_large", headers=close), None
        return None, limit


# ---------------------------------------------------------------------------
# Background maintenance
# ---------------------------------------------------------------------------

MAINTENANCE_INTERVAL_SECONDS = 3600
MAINTENANCE_FIRST_RUN_SECONDS = 60


def run_maintenance_once() -> dict[str, Any]:
    """One hourly pass. Each step is optional (other modules may not provide it yet) and
    isolated: a failure in one is logged and never stops the other."""
    steps = (
        ("jobs", job_queue, "run_maintenance"),          # BE1: job purge
        ("retention", security, "purge_retention"),      # login_attempts / audit_log / sessions
    )
    results: dict[str, Any] = {}
    for label, module, name in steps:
        function = getattr(module, name, None)
        if not callable(function):
            continue
        try:
            results[label] = function()
        except Exception:  # noqa: BLE001
            logger.exception("maintenance step %s failed", label)
            results[label] = {"error": True}
    return results


def _maintenance_loop(stop: threading.Event) -> None:
    delay = MAINTENANCE_FIRST_RUN_SECONDS
    try:
        while not stop.wait(delay):
            run_maintenance_once()
            delay = MAINTENANCE_INTERVAL_SECONDS
    finally:
        db.close_all()  # this thread's own SQLite connection


def _start_maintenance_thread(stop: threading.Event) -> threading.Thread:
    thread = threading.Thread(target=_maintenance_loop, args=(stop,), name="jk-maintenance",
                              daemon=True)
    thread.start()
    return thread


def _start_storage_drainer(application: FastAPI) -> None:
    starter = getattr(storage_module, "start_background_drainer", None)
    if not callable(starter):
        return
    try:
        starter(application)
    except Exception:  # noqa: BLE001 - photo cleanup must not stop the app from serving
        logger.exception("could not start the storage drainer")


@asynccontextmanager
async def lifespan(application: FastAPI):
    result = auth.bootstrap()
    auth.print_bootstrap(result)
    if not security.worker_token():
        print("WARNING: WORKER_TOKEN is not set — the worker cannot claim jobs. "
              "Set it in .env (see .env.example).")
    else:
        short_token = security.worker_token_warning()
        if short_token:
            print(short_token)
    if not security.encryption_available():
        print("WARNING: API keys will be stored UNENCRYPTED. Set SECRET_KEY and install "
              "'cryptography' to encrypt them at rest.")
    security.install_access_log_redaction()
    stop_maintenance = threading.Event()
    maintenance = _start_maintenance_thread(stop_maintenance)
    _start_storage_drainer(application)
    try:
        yield
    finally:
        stop_maintenance.set()
        maintenance.join(timeout=5)
        db.close_all()


# ---------------------------------------------------------------------------
# Application
# ---------------------------------------------------------------------------

# /docs, /redoc and /openapi.json list every route (admin and worker ones included) to
# anybody on the internet. Off unless an operator explicitly asks for them.
_docs_on = _env_flag("JK_ENABLE_API_DOCS")
app = FastAPI(
    title="JagaKebond", version=APP_VERSION, lifespan=lifespan,
    docs_url="/docs" if _docs_on else None,
    redoc_url="/redoc" if _docs_on else None,
    openapi_url="/openapi.json" if _docs_on else None,
)
app.add_middleware(SecurityMiddleware)


@app.exception_handler(auth.CodedHTTPException)
async def _coded_http_exception(request: Request, exc: auth.CodedHTTPException) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code,
                        content={"detail": exc.detail, "code": exc.code},
                        headers=exc.headers)


@app.exception_handler(Exception)
async def _unhandled_exception(request: Request, exc: Exception) -> JSONResponse:
    # Starlette's outermost layer builds this response, so SecurityMiddleware never sees
    # it: stamp the headers here. The exception is still re-raised after the response is
    # sent, so the traceback reaches the log as before.
    response = JSONResponse(status_code=500,
                            content={"detail": "Terjadi kesalahan di server. Coba lagi sebentar lagi."})
    apply_response_headers(request.url.path, response.headers)
    return response


app.include_router(auth_router)
app.include_router(google_router)
app.include_router(app_router)
app.include_router(admin_router)


# ---------------------------------------------------------------------------
# Static PWA hosting (registered last so /api/* wins)
# ---------------------------------------------------------------------------


def _frontend_file(name: str, media_type: str) -> FileResponse:
    path = FRONTEND_DIR / name
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"{name} tidak ditemukan")
    return FileResponse(path, media_type=media_type, headers={"Cache-Control": "no-store"})


@app.get("/sw.js")
def service_worker() -> FileResponse:
    return _frontend_file("sw.js", "application/javascript")


@app.get("/manifest.webmanifest")
def web_manifest() -> FileResponse:
    return _frontend_file("manifest.webmanifest", "application/manifest+json")


@app.get("/privacy")
def privacy_policy() -> FileResponse:
    return _frontend_file("privacy.html", "text/html")


@app.get("/terms")
def terms_of_service() -> FileResponse:
    return _frontend_file("terms.html", "text/html")


@app.get("/admin")
def admin_console() -> FileResponse:
    return _frontend_file("admin.html", "text/html")


app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")


def get_settings_snapshot() -> dict[str, Any]:
    """Convenience for scripts/tests."""
    return {item["key"]: item.get("value") for item in settings_store.public_settings()}
