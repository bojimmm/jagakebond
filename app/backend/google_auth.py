"""Sign in with Google (0.2.3.0): ID-token verification, sign-in nonces and registration requests.

Flow (CONTRACT-0230-google.md):
  1. the client reads GET /api/auth/google/config and asks POST /api/auth/google/nonce for a
     single-use nonce (10 minutes, stored server-side);
  2. Google Identity Services (web) or Credential Manager (Android) returns an ID token that
     carries that nonce;
  3. POST /api/auth/google {credential, nonce}: the token is verified here (RS256 against
     Google's JWKS, iss, aud, exp/iat, nonce, email_verified), then
       * a linked Google `sub` signs its account in (same cookies/CSRF/TTL as password login);
       * an active account with the same e-mail is linked and signed in;
       * anybody else gets a pending registration request (202) that an admin approves or
         rejects from the console (api_admin.py).

Nothing here is active until GOOGLE_CLIENT_ID is set: config says enabled=false and the POST
routes answer 404. No new dependency: httpx fetches the keys, `cryptography` checks RS256.
"""

from __future__ import annotations

import json
import hashlib
import logging
import math
import os
import re
import secrets
import threading
import time
from typing import Any

import httpx
from fastapi import APIRouter, Body, Request, Response
from fastapi.responses import JSONResponse

from . import auth, db, security, settings_store

router = APIRouter(prefix="/api/auth/google", tags=["auth"])
log = logging.getLogger("jagakebond.google")

JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs"
GOOGLE_ISSUERS = ("accounts.google.com", "https://accounts.google.com")
CLOCK_SKEW_SECONDS = 60
# A Google ID token is about 1-1.5 KB; anything far larger is not one.
MAX_CREDENTIAL_CHARS = 8192

NONCE_TTL_MS = 10 * 60_000
NONCE_MAX_LIVE = 5000
NONCE_MAX_PER_IP = 20
PENDING_CAP = 200
REGISTRATION_MAX_PER_IP_DAY = 20
REGISTRATION_RETENTION_MS = 30 * 86_400_000

# JWKS cache bounds: Google answers with max-age of a few hours. A cache that never expires
# would miss a key rotation; one that refetches on every unknown `kid` lets anybody make this
# server hammer Google, so a forced refetch happens at most once per JWKS_REFETCH_MIN_SECONDS.
JWKS_DEFAULT_MAX_AGE = 3600
JWKS_MIN_MAX_AGE = 60
JWKS_MAX_MAX_AGE = 24 * 3600
JWKS_REFETCH_MIN_SECONDS = 30
JWKS_TIMEOUT_SECONDS = 5.0
JWKS_FAILURE_SECONDS = 10

FAILED_DETAIL = "Masuk dengan Google gagal. Coba lagi."
NONCE_DETAIL = "Waktu masuk habis. Tekan tombol Google sekali lagi."
PENDING_DETAIL = "Permintaan masuk sudah dikirim. Tunggu persetujuan admin."
REJECTED_DETAIL = "Permintaan masuk Anda ditolak admin."
DISABLED_DETAIL = "Masuk dengan Google belum diaktifkan."

_SUB_RE = re.compile(r"^[0-9A-Za-z_-]{1,255}$")
_NONCE_RE = re.compile(r"^[A-Za-z0-9_-]{16,128}$")


class GoogleTokenError(Exception):
    """The credential is not a valid Google ID token for this app. `reason` is for the log only."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class GoogleKeysUnavailable(Exception):
    """Google's signing keys could not be fetched (network, outage)."""


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


def client_ids() -> list[str]:
    """GOOGLE_CLIENT_ID, comma-separated. The first one is the web client the browser uses."""
    raw = os.environ.get("GOOGLE_CLIENT_ID", "") or ""
    return [item.strip() for item in raw.split(",") if item.strip()]


def enabled() -> bool:
    return bool(client_ids())


def _require_enabled() -> None:
    if not enabled():
        raise auth.CodedHTTPException(404, DISABLED_DETAIL, "google_disabled")


# ---------------------------------------------------------------------------
# JWKS (Google's public keys)
# ---------------------------------------------------------------------------

_jwks_lock = threading.Lock()
_jwks: dict[str, Any] = {"keys": {}, "expires": 0.0, "fetched": 0.0,
                         "retry_after": 0.0, "flight": None}


def _max_age(cache_control: str | None) -> int:
    match = re.search(r"max-age\s*=\s*(\d+)", cache_control or "", re.I)
    seconds = int(match.group(1)) if match else JWKS_DEFAULT_MAX_AGE
    return max(JWKS_MIN_MAX_AGE, min(seconds, JWKS_MAX_MAX_AGE))


def _fetch_jwks() -> tuple[dict[str, Any], int]:
    """(JWKS document, seconds it may be cached). Tests replace this function."""
    try:
        response = httpx.get(JWKS_URL, timeout=httpx.Timeout(JWKS_TIMEOUT_SECONDS, connect=2.0), follow_redirects=False,
                             headers={"Accept": "application/json"})
    except httpx.HTTPError as exc:
        raise GoogleKeysUnavailable(type(exc).__name__) from None
    if response.status_code != 200:
        raise GoogleKeysUnavailable(f"HTTP {response.status_code}")
    try:
        document = response.json()
    except ValueError:
        raise GoogleKeysUnavailable("not JSON") from None
    return document, _max_age(response.headers.get("cache-control"))


def _public_keys(document: Any) -> dict[str, Any]:
    """kid -> RSA public key for every usable RS256 signing key in a JWKS document."""
    from cryptography.hazmat.primitives.asymmetric import rsa

    keys: dict[str, Any] = {}
    items = document.get("keys", []) if isinstance(document, dict) else []
    if not isinstance(items, list):
        return keys
    for item in items:
        if not isinstance(item, dict) or item.get("kty") != "RSA":
            continue
        if item.get("use", "sig") != "sig" or item.get("alg", "RS256") != "RS256":
            continue
        kid, n, e = item.get("kid"), item.get("n"), item.get("e")
        if not (isinstance(kid, str) and isinstance(n, str) and isinstance(e, str)):
            continue
        try:
            numbers = rsa.RSAPublicNumbers(int.from_bytes(security.b64d(e), "big"),
                                           int.from_bytes(security.b64d(n), "big"))
            keys[kid] = numbers.public_key()
        except (ValueError, TypeError):
            continue
    return keys


def _key_for(kid: str) -> Any:
    while True:
        now = time.monotonic()
        with _jwks_lock:
            key = _jwks["keys"].get(kid)
            if key is not None and now < _jwks["expires"]:
                return key
            if now < _jwks["retry_after"]:
                raise GoogleKeysUnavailable("cached fetch failure")
            if now < _jwks["expires"] and now - _jwks["fetched"] < JWKS_REFETCH_MIN_SECONDS:
                raise GoogleTokenError("unknown kid")
            flight = _jwks["flight"]
            fetcher = flight is None
            if fetcher:
                flight = threading.Event()
                _jwks["flight"] = flight
        if not fetcher:
            # Every concurrent caller shares one fetch and its outcome. No network I/O
            # holds the cache lock, and waiters never start a chain of serial timeouts.
            if not flight.wait(JWKS_TIMEOUT_SECONDS + 1):
                raise GoogleKeysUnavailable("key fetch in progress")
            continue
        try:
            document, max_age = _fetch_jwks()
            keys = _public_keys(document)
            if not keys:
                raise GoogleKeysUnavailable("no usable signing keys")
        except GoogleKeysUnavailable:
            with _jwks_lock:
                stamp = time.monotonic()
                _jwks["retry_after"] = stamp + JWKS_FAILURE_SECONDS
                _jwks["fetched"] = stamp
                if _jwks["keys"]:
                    _jwks["expires"] = stamp + JWKS_MIN_MAX_AGE
            # A previously cached key remains available during a short outage.
            if key is None:
                raise
            return key
        else:
            with _jwks_lock:
                stamp = time.monotonic()
                _jwks.update(keys=keys, expires=stamp + max_age, fetched=stamp, retry_after=0.0)
            if kid not in keys:
                raise GoogleTokenError("unknown kid")
            return keys[kid]
        finally:
            with _jwks_lock:
                _jwks["flight"] = None
                flight.set()


def reset_key_cache() -> None:
    with _jwks_lock:
        _jwks.update({"keys": {}, "expires": 0.0, "fetched": 0.0, "retry_after": 0.0, "flight": None})


# ---------------------------------------------------------------------------
# ID token verification
# ---------------------------------------------------------------------------


def _segment_json(segment: str) -> dict[str, Any]:
    try:
        value = json.loads(security.b64d(segment).decode("utf-8"))
    except (ValueError, UnicodeDecodeError, TypeError):
        raise GoogleTokenError("malformed segment") from None
    if not isinstance(value, dict):
        raise GoogleTokenError("segment is not an object")
    return value


def verify_id_token(credential: Any, now: float | None = None) -> dict[str, Any]:
    """Claims of a valid Google ID token for one of our client IDs, or GoogleTokenError.

    The nonce claim is only checked for presence here; the route compares it with the nonce the
    client sent and consumes the server-side row.
    """
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding

    if not isinstance(credential, str) or not credential or len(credential) > MAX_CREDENTIAL_CHARS:
        raise GoogleTokenError("missing or oversized credential")
    parts = credential.split(".")
    if len(parts) != 3 or not all(parts):
        raise GoogleTokenError("not a JWS compact token")
    header = _segment_json(parts[0])
    if header.get("alg") != "RS256" or not isinstance(header.get("kid"), str):
        raise GoogleTokenError("unexpected header")
    try:
        signature = security.b64d(parts[2])
    except (ValueError, TypeError):
        raise GoogleTokenError("malformed signature") from None
    key = _key_for(header["kid"])
    try:
        key.verify(signature, (parts[0] + "." + parts[1]).encode("ascii"), padding.PKCS1v15(), hashes.SHA256())
    except (InvalidSignature, ValueError, UnicodeEncodeError):
        raise GoogleTokenError("bad signature") from None

    claims = _segment_json(parts[1])
    now = time.time() if now is None else now
    if claims.get("iss") not in GOOGLE_ISSUERS:
        raise GoogleTokenError("wrong issuer")
    audience = claims.get("aud")
    audiences = audience if isinstance(audience, list) else [audience]
    allowed = client_ids()
    if not any(isinstance(item, str) and item in allowed for item in audiences):
        raise GoogleTokenError("wrong audience")
    exp, iat = claims.get("exp"), claims.get("iat")
    if not isinstance(exp, (int, float)) or isinstance(exp, bool) or not math.isfinite(exp) or exp + CLOCK_SKEW_SECONDS <= now:
        raise GoogleTokenError("expired")
    if not isinstance(iat, (int, float)) or isinstance(iat, bool) or not math.isfinite(iat) or iat > now + CLOCK_SKEW_SECONDS:
        raise GoogleTokenError("issued in the future")
    if claims.get("email_verified") not in (True, "true"):
        raise GoogleTokenError("email not verified")
    if not isinstance(claims.get("sub"), str) or not _SUB_RE.match(claims["sub"]):
        raise GoogleTokenError("bad subject")
    email = claims.get("email")
    if not isinstance(email, str) or not auth.EMAIL_RE.match(email.strip()) or len(email) > 254:
        raise GoogleTokenError("bad email")
    if not isinstance(claims.get("nonce"), str) or not claims["nonce"]:
        raise GoogleTokenError("no nonce")
    return claims


# ---------------------------------------------------------------------------
# Nonces
# ---------------------------------------------------------------------------


def _ip_hash(ip: str) -> str:
    return hashlib.sha256(security.normalize_ip(ip).encode()).hexdigest()


def issue_nonce(ip: str) -> dict[str, Any]:
    """A fresh single-use nonce. Expired rows are purged first; at most NONCE_MAX_LIVE stay live."""
    nonce = secrets.token_urlsafe(24)
    now = db.now_ms()
    with db.transaction() as tx:
        tx.execute("DELETE FROM auth_nonces WHERE expires_ms <= ?", (now,))
        ip_hash = _ip_hash(ip)
        local = tx.execute("SELECT COUNT(*) AS n FROM auth_nonces WHERE ip_hash = ?", (ip_hash,)).fetchone()
        if local and int(local["n"]) >= NONCE_MAX_PER_IP:
            raise auth.CodedHTTPException(429, "Terlalu banyak permintaan masuk. Coba lagi sebentar lagi.",
                                          "nonce_ip_limit", headers={"Retry-After": "600"})
        live = tx.execute("SELECT COUNT(*) AS n FROM auth_nonces").fetchone()
        if live and int(live["n"]) >= NONCE_MAX_LIVE:
            raise auth.CodedHTTPException(429, "Terlalu banyak permintaan masuk. Coba lagi sebentar lagi.",
                                          "nonce_limit", headers={"Retry-After": "60"})
        tx.execute("INSERT INTO auth_nonces (nonce, ip_hash, expires_ms) VALUES (?, ?, ?)",
                   (nonce, ip_hash, now + NONCE_TTL_MS))
    return {"nonce": nonce, "expiresMs": now + NONCE_TTL_MS}


def consume_nonce(nonce: str) -> bool:
    """True exactly once for a live nonce (the row is deleted whatever the outcome)."""
    if not isinstance(nonce, str) or not _NONCE_RE.match(nonce):
        return False
    with db.transaction() as tx:
        row = tx.execute("SELECT expires_ms FROM auth_nonces WHERE nonce = ?", (nonce,)).fetchone()
        if row is None:
            return False
        tx.execute("DELETE FROM auth_nonces WHERE nonce = ?", (nonce,))
    return int(row["expires_ms"]) > db.now_ms()


# ---------------------------------------------------------------------------
# Accounts and registration requests
# ---------------------------------------------------------------------------


def _throttle_key(ip: str) -> str:
    return "google:" + _ip_hash(ip)


def _check_throttle(ip: str) -> None:
    row = db.query_one("SELECT locked_until_ms FROM login_attempts WHERE key = ?", (_throttle_key(ip),))
    locked_ms = max(0, int(row["locked_until_ms"] or 0) - db.now_ms()) if row else 0
    if locked_ms > 0:
        seconds = max(1, math.ceil(locked_ms / 1000))
        raise auth.CodedHTTPException(429, f"Terlalu banyak percobaan. Coba lagi dalam {seconds} detik.",
                                      "login_locked", headers={"Retry-After": str(seconds)})


def _record_failure(ip: str, reason: str) -> None:
    now = db.now_ms()
    with db.transaction() as tx:
        row = tx.execute("SELECT * FROM login_attempts WHERE key = ?", (_throttle_key(ip),)).fetchone()
        fails = int(row["fails"]) if row and now - int(row["updated_ms"]) < security.FAIL_DECAY_SECONDS * 1000 else 0
        fails += 1
        seconds = min(30 * (2 ** min(max(0, fails - 5), 7)), 3600) if fails >= 5 else 0
        tx.execute("INSERT OR REPLACE INTO login_attempts (key, fails, locked_until_ms, updated_ms) VALUES (?,?,?,?)",
                   (_throttle_key(ip), fails, now + seconds * 1000, now))
        settings_store.audit_tx(tx, "account.google_failed", None, reason)


def _clean_name(value: Any) -> str:
    return " ".join(str(value or "").split())[:120]


def linked_account_ids(account_ids: list[str]) -> set[str]:
    if not account_ids:
        return set()
    marks = ",".join("?" * len(account_ids))
    rows = db.query(f"SELECT DISTINCT account_id FROM google_identities WHERE account_id IN ({marks})", account_ids)
    return {row["account_id"] for row in rows}


def _sign_in(response: Response, request: Request, account: dict[str, Any], sub: str, ip: str,
             linked_now: bool) -> dict[str, Any]:
    now = db.now_ms()
    with db.transaction() as tx:
        tx.execute("UPDATE accounts SET last_login_ms = ? WHERE id = ?", (now, account["id"]))
        tx.execute("UPDATE google_identities SET last_login_ms = ? WHERE sub = ?", (now, sub))
    security.session_purge_expired()
    ttl_days = auth.session_ttl_days(account["role"])
    token = security.session_create(account["id"], request.headers.get("user-agent"), ip, ttl_days=ttl_days)
    csrf = security.csrf_token()
    auth.set_session_cookies(response, token, csrf, ttl_days)
    settings_store.audit("account.login", account["email"],
                         "Google (akun baru disambungkan)" if linked_now else "Google",
                         account["email"], account["id"])
    fresh = auth.find_by_id(account["id"]) or account
    return {"ok": True, "account": auth.public_account(fresh), "csrf": csrf}


def _request_registration(sub: str, email: str, name: str, ip: str) -> None:
    """Create or refresh the pending request of `sub`. Raises the coded 403/429 answers."""
    now = db.now_ms()
    created = False
    with db.transaction() as tx:
        tx.execute("DELETE FROM registration_requests WHERE status = 'pending' AND created_ms < ?",
                   (now - REGISTRATION_RETENTION_MS,))
        row = tx.execute("SELECT * FROM registration_requests WHERE sub = ?", (sub,)).fetchone()
        if row is not None and row["status"] == "rejected":
            raise auth.CodedHTTPException(403, REJECTED_DETAIL, "registration_rejected")
        if row is None or row["status"] != "pending":
            ip_hash = _ip_hash(ip)
            budget = tx.execute("SELECT * FROM google_request_limits WHERE ip_hash = ?", (ip_hash,)).fetchone()
            start = int(budget["window_start_ms"]) if budget else now
            used = int(budget["requests"]) if budget and now - start < 86_400_000 else 0
            if used >= REGISTRATION_MAX_PER_IP_DAY:
                retry = max(1, math.ceil((start + 86_400_000 - now) / 1000))
                raise auth.CodedHTTPException(429, "Terlalu banyak pendaftaran. Coba lagi besok.",
                                              "registration_ip_limit", headers={"Retry-After": str(retry)})
            pending = tx.execute("SELECT COUNT(*) AS n FROM registration_requests WHERE status = 'pending'").fetchone()
            if pending and int(pending["n"]) >= PENDING_CAP:
                raise auth.CodedHTTPException(429, "Banyak permintaan masuk sedang menunggu. Coba lagi besok.",
                                              "registration_full")
            tx.execute("INSERT OR REPLACE INTO google_request_limits (ip_hash, window_start_ms, requests) VALUES (?,?,?)",
                       (ip_hash, start if used else now, used + 1))
        if row is None:
            tx.execute(
                "INSERT INTO registration_requests (id, sub, email, name, status, created_ms, updated_ms) "
                "VALUES (?,?,?,?, 'pending', ?, ?)", (db.new_id("reg"), sub, email, name, now, now))
            created = True
        else:
            # Pending: refresh. Approved earlier but the account is gone (deleted by an admin): ask again.
            tx.execute(
                "UPDATE registration_requests SET email = ?, name = ?, status = 'pending', updated_ms = ?, "
                "decided_ms = CASE WHEN status = 'pending' THEN decided_ms ELSE NULL END, "
                "decided_by = CASE WHEN status = 'pending' THEN decided_by ELSE NULL END, "
                "account_id = CASE WHEN status = 'pending' THEN account_id ELSE NULL END "
                "WHERE sub = ?", (email, name, now, sub))
            created = row["status"] != "pending"
        if created:
            settings_store.audit_tx(tx, "registration.request", email, "Masuk dengan Google", email, None)


def list_requests(status: str = "pending", limit: int = 200) -> list[dict[str, Any]]:
    rows = db.query(
        "SELECT id, email, name, status, created_ms, updated_ms, decided_ms, decided_by FROM registration_requests "
        "WHERE status = ? ORDER BY created_ms ASC, id ASC LIMIT ?", (status, limit))
    return [{"id": row["id"], "email": row["email"], "name": row["name"] or "", "status": row["status"],
             "createdMs": row["created_ms"], "updatedMs": row["updated_ms"], "decidedMs": row["decided_ms"],
             "decidedBy": row["decided_by"]} for row in rows]


def pending_count() -> int:
    row = db.query_one("SELECT COUNT(*) AS n FROM registration_requests WHERE status = 'pending'")
    return int(row["n"]) if row else 0


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/config")
def google_config() -> dict[str, Any]:
    ids = client_ids()
    return {"enabled": bool(ids), "clientId": ids[0] if ids else None}


@router.post("/nonce")
def google_nonce(request: Request) -> dict[str, Any]:
    _require_enabled()
    _check_throttle(auth.client_ip(request))
    return issue_nonce(auth.client_ip(request))


@router.post("")
def google_sign_in(response: Response, request: Request, payload: dict[str, Any] = Body(...)) -> Any:
    _require_enabled()
    ip = auth.client_ip(request)
    _check_throttle(ip)
    try:
        claims = verify_id_token(payload.get("credential"))
    except GoogleKeysUnavailable as exc:
        log.warning("Google signing keys unavailable: %s", exc)
        raise auth.CodedHTTPException(503, "Layanan Google tidak bisa dihubungi. Coba lagi sebentar lagi.",
                                      "google_unavailable") from None
    except GoogleTokenError as exc:
        log.info("Google sign-in refused: %s", exc.reason)
        _record_failure(ip, exc.reason)
        raise auth.CodedHTTPException(401, FAILED_DETAIL, "google_token_invalid") from None
    sent = payload.get("nonce")
    if not isinstance(sent, str) or sent != claims["nonce"] or not consume_nonce(sent):
        _record_failure(ip, "nonce invalid")
        raise auth.CodedHTTPException(401, NONCE_DETAIL, "google_nonce_invalid")

    sub, email = claims["sub"], claims["email"].strip()
    name = _clean_name(claims.get("name"))
    account = None
    linked_now = False
    with db.transaction() as tx:
        link = tx.execute("SELECT account_id FROM google_identities WHERE sub = ?", (sub,)).fetchone()
        if link:
            found = tx.execute("SELECT * FROM accounts WHERE id = ?", (link["account_id"],)).fetchone()
        else:
            found = tx.execute("SELECT * FROM accounts WHERE email = ? COLLATE NOCASE", (email,)).fetchone()
        if found:
            candidate = dict(found)
            if not candidate["is_active"]:
                raise auth.CodedHTTPException(403, "Akun dinonaktifkan", "account_inactive")
            if not link and tx.execute("SELECT 1 FROM google_identities WHERE account_id = ?",
                                       (candidate["id"],)).fetchone():
                raise auth.CodedHTTPException(403, "Akun ini sudah tersambung ke akun Google lain. Hubungi admin.",
                                              "google_link_conflict")
            # Owner permits Google for admins. The same provenance guard applies to
            # every role; password-used self-registrations go to admin review.
            eligible = candidate["admin_created"] or candidate["last_password_login_ms"] is None
            if link or eligible:
                account = candidate
            if not link and eligible:
                inserted = tx.execute(
                    "INSERT OR IGNORE INTO google_identities (sub, account_id, email, created_ms) VALUES (?,?,?,?)",
                    (sub, candidate["id"], email, db.now_ms()))
                if inserted.rowcount != 1:
                    raise auth.CodedHTTPException(409, "Akun Google sudah tersambung. Muat ulang dan coba lagi.",
                                                  "google_link_conflict")
                linked_now = True
    if account:
        return _sign_in(response, request, account, sub, ip, linked_now)

    _request_registration(sub, email, name, ip)
    return JSONResponse(status_code=202, content={"ok": False, "code": "registration_pending",
                                                  "detail": PENDING_DETAIL})
