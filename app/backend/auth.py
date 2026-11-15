"""Accounts, sessions and the auth dependencies used by every other route."""

from __future__ import annotations

import math
import os
import re
import secrets
import sys
from typing import Any

from fastapi import APIRouter, Body, HTTPException, Request, Response

from . import db, security, settings_store
from . import queue

router = APIRouter(prefix="/api/auth", tags=["auth"])

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$")
VALID_ROLES = ("user", "priority", "admin")


class CodedHTTPException(HTTPException):
    """HTTPException whose JSON body also carries a machine-readable `code`.

    The response is `{"detail": "<Bahasa message>", "code": "<code>"}` (see the handler
    registered in app.py). Clients keep reading `detail` as before; the ones that care
    (account_mismatch, queue_full, ...) branch on `code`.
    """

    def __init__(self, status_code: int, detail: str, code: str,
                 headers: dict[str, str] | None = None) -> None:
        super().__init__(status_code=status_code, detail=detail, headers=headers)
        self.code = code


def cookie_secure() -> bool:
    return str(os.environ.get("COOKIE_SECURE", "1")).strip().lower() not in ("0", "false", "no")


def session_ttl_days(role: str | None = None) -> int:
    """Session lifetime in days: SESSION_TTL_DAYS (default 30), but at most 7 for admins."""
    try:
        days = max(1, int(os.environ.get("SESSION_TTL_DAYS", str(security.SESSION_TTL_DAYS))))
    except (TypeError, ValueError):
        days = security.SESSION_TTL_DAYS
    if role == "admin":
        days = min(days, security.ADMIN_SESSION_TTL_DAYS)
    return days


# ---------------------------------------------------------------------------
# Account helpers
# ---------------------------------------------------------------------------


def find_by_email(email: str) -> dict[str, Any] | None:
    return db.query_one("SELECT * FROM accounts WHERE email = ? COLLATE NOCASE", (email.strip(),))


def find_by_id(account_id: str) -> dict[str, Any] | None:
    return db.query_one("SELECT * FROM accounts WHERE id = ?", (account_id,))


def create_account(email: str, password: str, name: str = "", role: str = "user",
                   daily_quota: int | None = None, actor: str | None = None) -> dict[str, Any]:
    email = (email or "").strip()
    if not EMAIL_RE.match(email):
        raise HTTPException(status_code=400, detail="Format email tidak valid")
    problem = security.password_problem(password)
    if problem:
        raise HTTPException(status_code=400, detail=problem)
    if role not in VALID_ROLES:
        raise HTTPException(status_code=400, detail="Peran tidak dikenal")
    if find_by_email(email):
        raise HTTPException(status_code=409, detail="Email sudah terdaftar")

    # Legacy per-account quota arguments are accepted for compatibility only;
    # tier caps are authoritative and are never stored as an override.
    daily_quota = 0
    now = db.now_ms()
    account_id = db.new_id("acct")
    with db.transaction() as tx:
        tx.execute(
            """INSERT INTO accounts (id, email, name, role, password_hash, is_active,
                                     daily_quota, created_ms, updated_ms, admin_created, last_password_login_ms)
               VALUES (?,?,?,?,?,1,?,?,?,?,?)""",
            (account_id, email, (name or email.split("@")[0])[:120], role,
             security.hash_password(password), int(daily_quota), now, now, int(actor is not None),
             now if actor is None else None),
        )
    settings_store.audit("account.create", email, f"peran={role}", actor, None)
    row = find_by_id(account_id)
    assert row is not None
    return row


def create_google_account(tx: Any, email: str, name: str, sub: str, actor: str | None) -> str:
    """A farmer account for an approved Google registration, inside the caller's transaction.

    It has no password (security.UNUSABLE_PASSWORD_HASH): only Google can sign it in until an
    admin sets one. Returns the new account id.
    """
    now = db.now_ms()
    account_id = db.new_id("acct")
    tx.execute(
        """INSERT INTO accounts (id, email, name, role, password_hash, is_active,
                                 daily_quota, created_ms, updated_ms)
           VALUES (?,?,?,'user',?,1,0,?,?)""",
        (account_id, email, (name or email.split("@")[0])[:120], security.UNUSABLE_PASSWORD_HASH, now, now),
    )
    tx.execute("INSERT INTO google_identities (sub, account_id, email, created_ms) VALUES (?,?,?,?)",
               (sub, account_id, email, now))
    settings_store.audit_tx(tx, "account.create", email, "peran=user; masuk dengan Google", actor, None)
    return account_id


def set_password(account_id: str, password: str) -> None:
    problem = security.password_problem(password)
    if problem:
        raise HTTPException(status_code=400, detail=problem)
    with db.transaction() as tx:
        tx.execute("UPDATE accounts SET password_hash = ?, updated_ms = ? WHERE id = ?",
                   (security.hash_password(password), db.now_ms(), account_id))


def client_ip(request: Request) -> str:
    # uvicorn runs with --proxy-headers behind nginx, so client.host is the real hop.
    return (request.client.host if request.client else "") or ""


# ---------------------------------------------------------------------------
# Cookies
# ---------------------------------------------------------------------------


def set_session_cookies(response: Response, token: str, csrf: str,
                        ttl_days: int | None = None) -> None:
    # The cookie must live exactly as long as the session row it points to: callers pass the
    # same ttl_days they gave session_create (a mismatch left a cookie that outlived, or
    # died before, its server-side session).
    max_age = (ttl_days if ttl_days is not None else session_ttl_days()) * 86_400
    secure = cookie_secure()
    response.set_cookie(security.SESSION_COOKIE, token, max_age=max_age, httponly=True,
                        samesite="lax", secure=secure, path="/")
    # Readable by JS on purpose: the double-submit check compares it to the header.
    response.set_cookie(security.CSRF_COOKIE, csrf, max_age=max_age, httponly=False,
                        samesite="lax", secure=secure, path="/")


def clear_session_cookies(response: Response) -> None:
    response.delete_cookie(security.SESSION_COOKIE, path="/")
    response.delete_cookie(security.CSRF_COOKIE, path="/")


# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------


ACCOUNT_HEADER = "x-jk-account"
ACCOUNT_MISMATCH_DETAIL = "Akun di perangkat ini sudah berganti. Muat ulang aplikasi."


def account_binding_mismatch(headers: Any, account_id: str) -> bool:
    """True when the request names an account (X-JK-Account) other than its session's.

    A tab that was opened for farmer A keeps working on its in-memory/IndexedDB state after
    somebody signs in as farmer B in another tab of the same browser: the shared cookie now
    belongs to B, so A's tab would upload A's drafts into B's account. The web app therefore
    sends the account it believes it is working for; the server refuses on disagreement.
    No header (old clients, the native bridge, curl) means no claim and is allowed.
    """
    if headers is None:
        return False
    claimed = (headers.get(ACCOUNT_HEADER) or "").strip()
    return bool(claimed) and claimed != str(account_id)


def enforce_account_binding(request: Request, account: dict[str, Any]) -> None:
    if account_binding_mismatch(getattr(request, "headers", None), account["id"]):
        raise CodedHTTPException(409, ACCOUNT_MISMATCH_DETAIL, "account_mismatch")


def current_account(request: Request) -> dict[str, Any]:
    token = request.cookies.get(security.SESSION_COOKIE)
    account = security.session_account(token)
    if not account:
        raise HTTPException(status_code=401, detail="Belum masuk. Silakan masuk.")
    enforce_account_binding(request, account)
    request.state.account = account
    return account


def require_admin(request: Request) -> dict[str, Any]:
    account = current_account(request)
    if account["role"] != "admin":
        raise HTTPException(status_code=403, detail="Hanya admin yang boleh mengakses ini")
    return account


def require_worker(request: Request) -> None:
    provided = request.headers.get("x-worker-token")
    if not security.worker_ok(provided):
        raise HTTPException(status_code=401, detail="Token worker tidak valid")


def public_account(account: dict[str, Any]) -> dict[str, Any]:
    tier = queue.fast_quota_snapshot(account)
    stored_avatar = str(account.get("avatar_url") or "")
    return {
        "id": account["id"],
        "email": account["email"],
        "name": account["name"],
        "role": account["role"],
        "avatarUrl": db.public_avatar_url(stored_avatar),
        "canRestoreGoogleAvatar": stored_avatar.startswith("hidden:https://"),
        "dailyQuota": tier["fastQuota"] or 0,
        **tier,
        "isActive": bool(account["is_active"]),
    }


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/options")
def sign_in_options() -> dict[str, bool]:
    """Public UI capability only; never expose settings, identities or credentials."""
    return {"passwordRegistration": settings_store.as_bool("ALLOW_REGISTRATION")}


@router.post("/register")
def register(response: Response, request: Request, payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    if not settings_store.as_bool("ALLOW_REGISTRATION"):
        raise HTTPException(status_code=403, detail="Pendaftaran ditutup oleh admin")
    account = create_account(
        str(payload.get("email") or ""),
        str(payload.get("password") or ""),
        str(payload.get("name") or ""),
        role="user",
    )
    # Registration always creates a farmer; the cookie and the session row get the SAME
    # lifetime (the row used to default to 30 days whatever SESSION_TTL_DAYS said).
    ttl_days = session_ttl_days(account["role"])
    token = security.session_create(account["id"], request.headers.get("user-agent"), client_ip(request),
                                   ttl_days=ttl_days)
    csrf = security.csrf_token()
    set_session_cookies(response, token, csrf, ttl_days)
    settings_store.audit("account.register", account["email"], None, account["email"], account["id"])
    return {"ok": True, "account": public_account(account), "csrf": csrf}


@router.post("/login")
def login(response: Response, request: Request, payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    email = str(payload.get("email") or "").strip()
    password = str(payload.get("password") or "")
    ip = client_ip(request)

    locked_ms, _lock_kind = security.login_lock_state(ip, email)
    if locked_ms > 0:
        # One message and one shape for every kind of lock (IP, IP+e-mail pair, the soft
        # per-address lock), with Retry-After so a client can wait instead of hammering.
        seconds = max(1, math.ceil(locked_ms / 1000))
        raise HTTPException(status_code=429,
                            detail=f"Terlalu banyak percobaan. Coba lagi dalam {seconds} detik.",
                            headers={"Retry-After": str(seconds)})

    account = find_by_email(email)
    # Always spend exactly one password verification. Short-circuiting on a missing
    # account made an unknown email answer in microseconds while a known one cost a
    # full scrypt, which is a usable account-enumeration oracle. A Google-only account (no
    # password yet) is verified against the dummy hash for the same reason, and never matches.
    usable = bool(account) and security.password_usable(account["password_hash"])
    stored_hash = account["password_hash"] if usable else security.DUMMY_PASSWORD_HASH
    verified = security.verify_password(password, stored_hash) and usable
    if not account or not verified:
        if account:
            # An account whose hash still has the old (cheaper) scrypt parameters would
            # fail faster than an unknown e-mail; pay the difference so both take as long.
            security.pad_verify_cost(stored_hash)
        security.login_record_failure(ip, email)
        # Same message either way: don't reveal which emails exist.
        raise HTTPException(status_code=401, detail="Email atau kata sandi salah")
    if not account["is_active"]:
        raise HTTPException(status_code=403, detail="Akun dinonaktifkan")

    # Only now is the plaintext known to be right, so this is the one moment an old-parameter
    # hash can be upgraded. The expensive hash is computed outside the write lock, and the
    # UPDATE only applies if the stored value is still the one we verified (a concurrent
    # password change must win).
    upgraded_hash = security.hash_password(password) if security.needs_rehash(stored_hash) else None
    security.login_reset(ip, email)
    with db.transaction() as tx:
        stamp = db.now_ms()
        tx.execute("UPDATE accounts SET last_login_ms = ?, last_password_login_ms = ? WHERE id = ?",
                   (stamp, stamp, account["id"]))
        if upgraded_hash:
            tx.execute("UPDATE accounts SET password_hash = ? WHERE id = ? AND password_hash = ?",
                       (upgraded_hash, account["id"], stored_hash))
    security.session_purge_expired()

    ttl_days = session_ttl_days(account["role"])
    token = security.session_create(account["id"], request.headers.get("user-agent"), ip,
                                   ttl_days=ttl_days)
    csrf = security.csrf_token()
    set_session_cookies(response, token, csrf, ttl_days)
    settings_store.audit("account.login", account["email"], None, account["email"], account["id"])
    fresh = find_by_id(account["id"]) or account
    return {"ok": True, "account": public_account(fresh), "csrf": csrf}


@router.post("/logout")
def logout(response: Response, request: Request) -> dict[str, bool]:
    token = request.cookies.get(security.SESSION_COOKIE)
    account = security.session_account(token)
    if account:
        # A stale tab of another account must not sign this browser's CURRENT account out:
        # on a mismatch nothing is deleted and the tab is told to reload (409).
        enforce_account_binding(request, account)
    security.session_delete(token)
    clear_session_cookies(response)
    if account:
        settings_store.audit("account.logout", account["email"], None, account["email"], account["id"])
    return {"ok": True}


@router.get("/me")
def me(request: Request) -> dict[str, Any]:
    token = request.cookies.get(security.SESSION_COOKIE)
    account = security.session_account(token)
    if not account:
        return {"ok": False, "account": None}
    enforce_account_binding(request, account)
    csrf = request.cookies.get(security.CSRF_COOKIE) or ""
    return {"ok": True, "account": public_account(account), "csrf": csrf}


@router.post("/password")
def change_password(response: Response, request: Request,
                    payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    account = current_account(request)
    current = str(payload.get("current") or "")
    new = str(payload.get("new") or "")
    if not security.verify_password(current, account["password_hash"]):
        raise HTTPException(status_code=400, detail="Kata sandi saat ini salah")
    problem = security.password_policy_error(new, account["role"])
    if problem:
        raise HTTPException(status_code=400, detail=problem)
    # The caller stays signed in, but on a FRESH session token (and a fresh CSRF token): the
    # token used for this request may have been observed or copied before the change.
    # New hash + new session + revocation of every other session commit together.
    ttl_days = session_ttl_days(account["role"])
    new_token, deleted = security.session_rotate(
        account["id"], request.headers.get("user-agent"), client_ip(request), ttl_days,
        new_password_hash=security.hash_password(new))
    csrf = security.csrf_token()
    set_session_cookies(response, new_token, csrf, ttl_days)
    # `deleted` counts the caller's own previous session too; report only the OTHER devices.
    revoked = max(0, deleted - 1)
    settings_store.audit("account.password", account["email"], f"{revoked} sesi lain dicabut",
                        account["email"], account["id"])
    return {"ok": True, "revokedSessions": revoked, "csrf": csrf}


@router.delete("/avatar")
def hide_avatar(request: Request) -> dict[str, Any]:
    """Hide the signed-in account's Google profile picture while preserving the URL for restore."""
    account = current_account(request)
    stored = str(account.get("avatar_url") or "").strip()
    if stored.startswith("https://"):
        new_val = "hidden:" + stored
        with db.transaction() as tx:
            tx.execute("UPDATE accounts SET avatar_url = ?, updated_ms = ? WHERE id = ?",
                       (new_val, db.now_ms(), account["id"]))
        account = find_by_id(account["id"]) or account
    return {"ok": True, "account": public_account(account)}


@router.put("/avatar")
def restore_avatar(request: Request) -> dict[str, Any]:
    """Restore a previously hidden Google profile picture for the signed-in account."""
    account = current_account(request)
    stored = str(account.get("avatar_url") or "").strip()
    if stored.startswith("hidden:https://"):
        new_val = stored[len("hidden:"):]
        with db.transaction() as tx:
            tx.execute("UPDATE accounts SET avatar_url = ?, updated_ms = ? WHERE id = ?",
                       (new_val, db.now_ms(), account["id"]))
        account = find_by_id(account["id"]) or account
    return {"ok": True, "account": public_account(account)}


@router.get("/sessions")
def list_sessions(request: Request) -> dict[str, Any]:
    account = current_account(request)
    rows = db.query(
        "SELECT created_ms, expires_ms, user_agent, ip FROM sessions "
        "WHERE account_id = ? AND expires_ms > ? ORDER BY created_ms DESC LIMIT 25",
        (account["id"], db.now_ms()),
    )
    return {"count": len(rows), "sessions": rows}


@router.post("/sessions/revoke")
def revoke_other_sessions(request: Request) -> dict[str, Any]:
    account = current_account(request)
    token = request.cookies.get(security.SESSION_COOKIE)
    revoked = security.session_delete_for_account(account["id"], keep_token=token)
    settings_store.audit("account.revoke_sessions", account["email"], f"{revoked} dicabut",
                        account["email"], account["id"])
    return {"ok": True, "revoked": revoked}


# ---------------------------------------------------------------------------
# Bootstrap
# ---------------------------------------------------------------------------


def _env_flag(name: str) -> bool:
    return str(os.environ.get(name, "")).strip().lower() in ("1", "true", "yes", "on", "ya")


def bootstrap() -> dict[str, Any]:
    """Create the first admin and run the one-time data migration.

    Demo records are NOT seeded unless SEED_DEMO_DATA is set: a real deployment
    must start empty, not populated with invented Bogor crop records.
    """
    db.migrate()
    result: dict[str, Any] = {"created": False, "generatedPassword": None, "seeded": None,
                              "imported": None}

    admin = db.query_one("SELECT * FROM accounts WHERE role = 'admin' ORDER BY created_ms LIMIT 1")
    if not admin:
        email = (os.environ.get("ADMIN_EMAIL") or "admin@jagakebond.local").strip()
        password = os.environ.get("ADMIN_PASSWORD") or ""
        generated = False
        if not password:
            password = secrets.token_urlsafe(12)
            generated = True
        admin = create_account(email, password, "Administrator", role="admin", daily_quota=0,
                              actor="system")
        result["created"] = True
        if generated:
            result["generatedPassword"] = password

    if _env_flag("SEED_DEMO_DATA"):
        existing = db.query_one("SELECT COUNT(*) AS n FROM records WHERE account_id = ?", (admin["id"],))
        if not existing or int(existing["n"]) == 0:
            result["seeded"] = db.seed_for_account(admin["id"])
    result["imported"] = db.import_legacy_json(admin["id"])
    result["adminEmail"] = admin["email"]
    return result


def print_bootstrap(result: dict[str, Any]) -> None:
    if result.get("created"):
        print("\n" + "=" * 68, file=sys.stderr)
        print(f"  First admin account created: {result.get('adminEmail')}", file=sys.stderr)
        if result.get("generatedPassword"):
            print(f"  GENERATED PASSWORD: {result['generatedPassword']}", file=sys.stderr)
            print("  This is shown once. Change it after signing in.", file=sys.stderr)
        print("=" * 68 + "\n", file=sys.stderr)
    if result.get("seeded"):
        print(f"  seeded demo data: {result['seeded']}", file=sys.stderr)
    if result.get("imported"):
        print(f"  imported legacy db.json: {result['imported']}", file=sys.stderr)
