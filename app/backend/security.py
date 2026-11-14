"""Password hashing, sessions, CSRF, login throttling and secret encryption.

Password hashing uses stdlib hashlib.scrypt — no third-party dependency and no
compiled wheel on the VPS. Only secret-at-rest encryption needs `cryptography`;
if it is absent the app still runs (secrets stored in the clear, and the admin
console says so) rather than refusing to start.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import logging
import os
import re
import secrets
import threading
import time
from pathlib import Path
from typing import Any

from . import db

BASE_DIR = Path(__file__).resolve().parent.parent

# scrypt parameters. N=2^14, r=8, p=5 is one of the equal-strength profiles in the OWASP
# Password Storage Cheat Sheet (the others trade memory for CPU: 2^15/p=3, 2^16/p=2,
# 2^17/p=1). It keeps the memory footprint of the previous N=2^14, r=8, p=1 setting
# (about 16 MiB per hash — OpenSSL reuses one V array for all p lanes) and spends five
# times the CPU, so a stolen hash is five times more expensive to attack.
# Hashes stored with older parameters keep verifying and are upgraded on the next
# successful login (see needs_rehash / auth.login).
_SCRYPT_N = 2 ** 14
_SCRYPT_R = 8
_SCRYPT_P = 5
_SCRYPT_DKLEN = 32
# hashlib.scrypt falls back to OpenSSL's 32 MiB default when maxmem is 0. State the budget
# explicitly (about 16 MiB is used) so a later parameter bump fails loudly instead of
# depending on a library default.
_SCRYPT_MAXMEM = 64 * 1024 * 1024
# A stored hash is verified with the parameters written inside it. Refuse absurd ones so a
# corrupted row can never make a login request allocate hundreds of megabytes.
_SCRYPT_MAX_N = 2 ** 16
_SCRYPT_MAX_R = 16
_SCRYPT_MAX_P = 16

SESSION_TTL_DAYS = 30
# Administrators can change settings, create accounts and read every farmer's photos, so
# their logins are shorter than a farmer's (who must stay signed in for a month of
# field work with patchy signal).
ADMIN_SESSION_TTL_DAYS = 7

# Throttling thresholds, per key type: (max failures, base backoff seconds, cap seconds).
#
# The per-account limit is strict because it protects one credential. The per-IP limit
# is deliberately loose: in rural Indonesia a whole village, or a carrier's NAT pool,
# can share one public IP, so a low IP threshold would lock out everyone behind it
# while an attacker simply rotates IPs.
THRESHOLDS = {
    "pair": (5, 60, 3600),
    "acct": (5, 60, 3600),  # compatibility for callers; account-only keys are not created
    "ip": (50, 30, 900),
}

# Soft per-e-mail limit across ALL IPs. The pair and IP keys above do nothing against an
# attacker who spreads guesses for one address over many IPs (a botnet, or a rotating
# proxy). More than EMAIL_SOFT_LIMIT failures for the same address inside
# EMAIL_WINDOW_SECONDS therefore starts a SHORT lock (30 s, doubling per further failure,
# never above 120 s). It is deliberately not an account lockout: anyone who knows an
# address could otherwise keep its owner out for hours. At 10 failures per 15 minutes the
# attacker is slowed to a handful of guesses a minute while the owner only ever waits a
# couple of minutes. The failure is counted for any e-mail text, existing or not, so the
# lock reveals nothing about which addresses are registered.
EMAIL_SOFT_LIMIT = 10
EMAIL_WINDOW_SECONDS = 900
EMAIL_LOCK_FIRST_SECONDS = 30
EMAIL_LOCK_CAP_SECONDS = 120

SESSION_COOKIE = "jk_session"
CSRF_COOKIE = "jk_csrf"
CSRF_HEADER = "x-csrf-token"

# A syntactically valid hash of a value nobody knows, verified against when the
# email is unknown. Without it, login returns in microseconds for an unknown
# email but spends a full scrypt (~50 ms) for a known one, which is a reliable
# "does this account exist" oracle for an attacker with a list of addresses.
DUMMY_PASSWORD_HASH = "scrypt${}${}${}${}${}".format(
    _SCRYPT_N, _SCRYPT_R, _SCRYPT_P,
    base64.b64encode(b"\x00" * 16).decode(),
    base64.b64encode(b"\x00" * _SCRYPT_DKLEN).decode(),
)

# Stored for accounts created from an approved Google registration (0.2.3.0): not a scrypt value,
# so verify_password always rejects it and password login stays impossible until an admin sets one.
UNUSABLE_PASSWORD_HASH = "!google-only"

_throttle_lock = threading.Lock()


# ---------------------------------------------------------------------------
# base64 helpers
# ---------------------------------------------------------------------------


def b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii")


def b64d(text: str) -> bytes:
    padding = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + padding)


# ---------------------------------------------------------------------------
# Passwords
# ---------------------------------------------------------------------------


def _scrypt(password: bytes, salt: bytes, n: int, r: int, p: int, dklen: int) -> bytes:
    # maxmem is sized from the parameters (V array + B lanes + 1 MiB slack) and never below
    # the explicit budget; the caps on n/r/p keep it bounded for parameters read from a row.
    needed = 128 * r * (n + 2) + 128 * r * p + 1024 * 1024
    return hashlib.scrypt(password, salt=salt, n=n, r=r, p=p, dklen=dklen,
                          maxmem=max(_SCRYPT_MAXMEM, needed))


def _parse_hash(stored: Any) -> tuple[int, int, int, bytes, bytes] | None:
    """Split a stored `scrypt$N$r$p$salt$hash` value, or None when it is not one we accept."""
    if not stored or not isinstance(stored, str):
        return None
    parts = stored.split("$")
    if len(parts) != 6 or parts[0] != "scrypt":
        return None
    try:
        n, r, p = int(parts[1]), int(parts[2]), int(parts[3])
        salt = b64d(parts[4])
        expected = b64d(parts[5])
    except (ValueError, TypeError):
        return None
    if not (2 <= n <= _SCRYPT_MAX_N and 1 <= r <= _SCRYPT_MAX_R and 1 <= p <= _SCRYPT_MAX_P):
        return None
    if not expected:
        return None
    return n, r, p, salt, expected


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    derived = _scrypt(password.encode("utf-8"), salt, _SCRYPT_N, _SCRYPT_R, _SCRYPT_P,
                      _SCRYPT_DKLEN)
    return f"scrypt${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}${b64e(salt)}${b64e(derived)}"


def verify_password(password: str, stored: str) -> bool:
    parsed = _parse_hash(stored)
    if parsed is None:
        return False
    n, r, p, salt, expected = parsed
    try:
        derived = _scrypt(password.encode("utf-8"), salt, n, r, p, len(expected))
    except (ValueError, MemoryError):
        return False
    return hmac.compare_digest(derived, expected)


def password_usable(stored: Any) -> bool:
    """False for a hash nobody can sign in with (UNUSABLE_PASSWORD_HASH, empty, corrupt)."""
    return _parse_hash(stored) is not None


def needs_rehash(stored: str) -> bool:
    """True when a valid stored hash was written with parameters other than today's.

    auth.login calls this after a SUCCESSFUL verification (the only moment the plaintext is
    available) and silently stores a fresh hash, so old accounts migrate as they sign in.
    """
    parsed = _parse_hash(stored)
    if parsed is None:
        return False
    n, r, p, _salt, expected = parsed
    return (n, r, p, len(expected)) != (_SCRYPT_N, _SCRYPT_R, _SCRYPT_P, _SCRYPT_DKLEN)


def pad_verify_cost(stored: str) -> None:
    """Burn the CPU an old-parameter hash lacks compared with the current parameters.

    login verifies an unknown e-mail against DUMMY_PASSWORD_HASH (current parameters) so
    that unknown and known accounts take equally long. A known account that has not
    migrated yet (cheaper N*r*p) would answer a wrong password measurably faster and thereby
    reveal that the address exists. Called after a FAILED verification of such a hash, this
    spends the missing difference; it does nothing for hashes that are already current.
    """
    parsed = _parse_hash(stored)
    if parsed is None:
        return
    n, r, p, _salt, _expected = parsed
    have = n * r * p
    want = _SCRYPT_N * _SCRYPT_R * _SCRYPT_P
    if have >= want:
        return
    lanes = max(1, -(-(want - have) // (_SCRYPT_N * _SCRYPT_R)))
    try:
        _scrypt(b"\x00", b"\x00" * 16, _SCRYPT_N, _SCRYPT_R, lanes, _SCRYPT_DKLEN)
    except (ValueError, MemoryError):
        pass


def password_problem(password: str) -> str | None:
    """Returns a human-readable reason, or None when acceptable."""
    if not password or len(password) < 8:
        return "Kata sandi minimal 8 karakter"
    if len(password) > 200:
        return "Kata sandi terlalu panjang"
    return None


# Minimum password length per role. Farmers type on a phone in the field, so 8 stays; an
# administrator account can read every farmer's photos and change the AI router key, so it
# needs 12.
PASSWORD_MIN_LENGTH = {"user": 8, "priority": 8, "admin": 12}
PASSWORD_MAX_LENGTH = 200


def password_policy_error(password: str, role: str) -> str | None:
    """Role-aware password policy. Returns a Bahasa message, or None when acceptable.

    `password_problem` (8 characters for everyone) is kept for callers that do not know a
    role; the account-management paths use this one.
    """
    if not isinstance(password, str):
        return "Kata sandi tidak valid"
    minimum = PASSWORD_MIN_LENGTH.get(role, PASSWORD_MIN_LENGTH["user"])
    if len(password) < minimum:
        if role == "admin":
            return f"Kata sandi admin minimal {minimum} karakter"
        return f"Kata sandi minimal {minimum} karakter"
    if len(password) > PASSWORD_MAX_LENGTH:
        return f"Kata sandi terlalu panjang (maksimal {PASSWORD_MAX_LENGTH} karakter)"
    return None


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------


def _hash_token(token: str) -> str:
    # Real tokens are ASCII (token_urlsafe). A hostile cookie can carry other characters, and
    # encode("ascii") would turn them into a 500 on every route that resolves a session;
    # "replace" gives them a hash that simply matches no session.
    return hashlib.sha256(token.encode("utf-8", "replace")).hexdigest()


def session_create(account_id: str, user_agent: str | None, ip: str | None,
                   ttl_days: int = SESSION_TTL_DAYS) -> str:
    token = secrets.token_urlsafe(32)
    now = db.now_ms()
    with db.transaction() as tx:
        tx.execute(
            "INSERT INTO sessions (token_hash, account_id, created_ms, expires_ms, user_agent, ip) "
            "VALUES (?,?,?,?,?,?)",
            (_hash_token(token), account_id, now, now + ttl_days * 86_400_000,
             (user_agent or "")[:250], ip),
        )
    return token


def session_rotate(account_id: str, user_agent: str | None, ip: str | None, ttl_days: int,
                   new_password_hash: str | None = None) -> tuple[str, int]:
    """Issue a fresh session token and revoke every other session of the account, atomically.

    Used when the owner changes their own password: the caller stays signed in with a new
    token (a token that may have been seen or copied before the change is worthless), and all
    other devices are signed out. When `new_password_hash` is given it is stored in the same
    transaction, so a crash can never leave the new password active with the old sessions
    still alive. Returns (new token, number of sessions deleted INCLUDING the caller's old one).
    """
    token = secrets.token_urlsafe(32)
    now = db.now_ms()
    with db.transaction() as tx:
        if new_password_hash is not None:
            tx.execute("UPDATE accounts SET password_hash = ?, updated_ms = ? WHERE id = ?",
                       (new_password_hash, now, account_id))
        tx.execute(
            "INSERT INTO sessions (token_hash, account_id, created_ms, expires_ms, user_agent, ip) "
            "VALUES (?,?,?,?,?,?)",
            (_hash_token(token), account_id, now, now + ttl_days * 86_400_000,
             (user_agent or "")[:250], ip),
        )
        cursor = tx.execute("DELETE FROM sessions WHERE account_id = ? AND token_hash != ?",
                            (account_id, _hash_token(token)))
    return token, cursor.rowcount or 0


def session_account(token: str | None) -> dict[str, Any] | None:
    """Resolve a session cookie to its account row, or None."""
    if not token:
        return None
    row = db.query_one(
        """SELECT a.* FROM sessions s
           JOIN accounts a ON a.id = s.account_id
           WHERE s.token_hash = ? AND s.expires_ms > ?""",
        (_hash_token(token), db.now_ms()),
    )
    if not row or not row["is_active"]:
        return None
    return row


def session_delete(token: str | None) -> None:
    if not token:
        return
    with db.transaction() as tx:
        tx.execute("DELETE FROM sessions WHERE token_hash = ?", (_hash_token(token),))


def session_delete_for_account(account_id: str, keep_token: str | None = None) -> int:
    with db.transaction() as tx:
        if keep_token:
            cursor = tx.execute(
                "DELETE FROM sessions WHERE account_id = ? AND token_hash != ?",
                (account_id, _hash_token(keep_token)),
            )
        else:
            cursor = tx.execute("DELETE FROM sessions WHERE account_id = ?", (account_id,))
    return cursor.rowcount or 0


def session_purge_expired() -> int:
    with db.transaction() as tx:
        cursor = tx.execute("DELETE FROM sessions WHERE expires_ms <= ?", (db.now_ms(),))
    return cursor.rowcount or 0


def session_count(account_id: str | None = None) -> int:
    if account_id:
        row = db.query_one("SELECT COUNT(*) AS n FROM sessions WHERE account_id = ? AND expires_ms > ?",
                           (account_id, db.now_ms()))
    else:
        row = db.query_one("SELECT COUNT(*) AS n FROM sessions WHERE expires_ms > ?", (db.now_ms(),))
    return int(row["n"]) if row else 0


# ---------------------------------------------------------------------------
# CSRF (double submit: cookie value must equal the request header)
# ---------------------------------------------------------------------------


def csrf_token() -> str:
    return secrets.token_urlsafe(24)


def csrf_ok(cookie_value: str | None, header_value: str | None) -> bool:
    if not cookie_value or not header_value:
        return False
    # bytes, not str: compare_digest raises TypeError on non-ASCII str (a hostile header/cookie).
    return hmac.compare_digest(cookie_value.encode("utf-8", "replace"),
                               header_value.encode("utf-8", "replace"))


# ---------------------------------------------------------------------------
# Worker token
# ---------------------------------------------------------------------------


def worker_token() -> str:
    return os.environ.get("WORKER_TOKEN", "") or ""


def worker_ok(provided: str | None) -> bool:
    expected = worker_token()
    if not expected or not provided:
        return False
    # Compare bytes: hmac.compare_digest raises TypeError for a str with non-ASCII
    # characters, which a hostile X-Worker-Token header could use to force a 500.
    return hmac.compare_digest(provided.encode("utf-8", "replace"), expected.encode("utf-8", "replace"))


# The worker token is the only thing protecting the routes that hand out farmers' photos
# and the AI router key, and those routes have no throttle: a short token can be guessed.
WORKER_TOKEN_MIN_LENGTH = 32


def worker_token_warning() -> str | None:
    """Startup warning text when WORKER_TOKEN is set but short; None otherwise.

    Never contains the token itself — only its length.
    """
    token = worker_token()
    if token and len(token) < WORKER_TOKEN_MIN_LENGTH:
        return (f"WARNING: WORKER_TOKEN is only {len(token)} characters long; use at least "
                f"{WORKER_TOKEN_MIN_LENGTH} random characters (python3 -c \"import secrets; "
                "print(secrets.token_urlsafe(32))\"), set it in .env and restart both services.")
    return None


# ---------------------------------------------------------------------------
# Login throttling
# ---------------------------------------------------------------------------


def _load_attempt(key: str) -> dict[str, Any]:
    row = db.query_one("SELECT * FROM login_attempts WHERE key = ?", (key,))
    return row or {"key": key, "fails": 0, "locked_until_ms": 0}


def normalize_ip(ip: str | None) -> str:
    """Canonical text for the throttle keys.

    IPv4 stays as is. An IPv6 client is keyed by its /64: one subscriber normally owns a
    whole /64 (or more) and can rotate through billions of addresses inside it, so keying by
    the full address would give an attacker a fresh counter per request. IPv4-mapped IPv6
    addresses (::ffff:a.b.c.d) are treated as the IPv4 address they carry.
    """
    text = (ip or "").strip()
    if not text:
        return ""
    text = text.split("%", 1)[0]  # drop a zone id such as fe80::1%eth0
    try:
        address = ipaddress.ip_address(text)
    except ValueError:
        return text[:64]
    if isinstance(address, ipaddress.IPv6Address):
        if address.ipv4_mapped is not None:
            return str(address.ipv4_mapped)
        return str(ipaddress.ip_network(f"{address}/64", strict=False))
    return str(address)


def login_lock_state(ip: str | None, email: str | None) -> tuple[int, str | None]:
    """(milliseconds until the caller may try again, kind of the longest lock) — (0, None) when free.

    The kind is "ip", "pair" or "email" (the soft per-address lock).
    """
    keys = _keys(ip, email)
    if not keys:
        return 0, None
    now = db.now_ms()
    marks = ",".join("?" for _ in keys)
    rows = db.query(f"SELECT key, locked_until_ms FROM login_attempts WHERE key IN ({marks})", keys)
    longest, kind = 0, None
    for row in rows:
        remaining = int(row.get("locked_until_ms") or 0) - now
        if remaining > longest:
            longest, kind = remaining, str(row["key"]).split(":", 1)[0]
    return max(0, longest), kind


def login_locked_for_ms(ip: str | None, email: str | None) -> int:
    """Milliseconds until the caller may try again (0 when not locked)."""
    return login_lock_state(ip, email)[0]


# Failures older than this stop counting. Without a decay, anyone who knows a
# farmer's email address could keep that account locked out indefinitely by
# sending one deliberately-wrong login per hour, because the failure counter
# never expired — a targeted denial of service against a named user.
FAIL_DECAY_SECONDS = 3600


def _soft_email_failure(record: dict[str, Any], now: int) -> tuple[int, int, int]:
    """Next (fails, window start, locked-until) of the soft per-address counter.

    Unlike the ip/pair keys (decay measured from the LAST failure), this key is a fixed
    window: `updated_ms` holds the moment the window opened, so the counter cannot be kept
    alive forever by one failure every few minutes.
    """
    fails = int(record.get("fails") or 0)
    window_start = int(record.get("updated_ms") or 0)
    if not fails or not window_start or now - window_start > EMAIL_WINDOW_SECONDS * 1000:
        fails, window_start = 0, now
    fails += 1
    locked = 0
    if fails > EMAIL_SOFT_LIMIT:
        seconds = min(EMAIL_LOCK_FIRST_SECONDS * (2 ** (fails - EMAIL_SOFT_LIMIT - 1)),
                      EMAIL_LOCK_CAP_SECONDS)
        locked = now + seconds * 1000
    return fails, window_start, locked


def login_record_failure(ip: str | None, email: str | None) -> None:
    now = db.now_ms()
    with _throttle_lock, db.transaction() as tx:
        for key in _keys(ip, email):
            record = _load_attempt(key)
            if key.startswith("email:"):
                fails, stamp, locked = _soft_email_failure(record, now)
            else:
                fails = int(record.get("fails") or 0)
                last_ms = int(record.get("updated_ms") or 0)
                if fails and last_ms and now - last_ms > FAIL_DECAY_SECONDS * 1000:
                    fails = 0
                fails += 1
                limit, base, cap = _threshold_for(key)
                locked = 0
                if fails >= limit:
                    backoff = min(base * (2 ** (fails - limit)), cap)
                    locked = now + backoff * 1000
                stamp = now
            tx.execute(
                "INSERT OR REPLACE INTO login_attempts (key, fails, locked_until_ms, updated_ms) "
                "VALUES (?,?,?,?)",
                (key, fails, locked, stamp),
            )


def _threshold_for(key: str) -> tuple[int, int, int]:
    kind = key.split(":", 1)[0]
    return THRESHOLDS.get(kind, THRESHOLDS["pair"])


def login_reset(ip: str | None, email: str | None) -> None:
    """A successful login forgets the failures of this IP+e-mail pair — and nothing else.

    The per-IP counter used to be cleared here too, which let an attacker who owns ONE valid
    account reset their own IP's budget with a good login between every batch of guesses
    against other people's addresses. The soft per-address counter is likewise left to
    expire on its own, so the owner signing in cannot refund an attacker's guesses.
    """
    pair = _pair_key(ip, email)
    if pair is None:
        return
    with db.transaction() as tx:
        tx.execute("DELETE FROM login_attempts WHERE key = ?", (pair,))


def _pair_key(ip: str | None, email: str | None) -> str | None:
    address = normalize_ip(ip)
    clean = (email or "").strip().lower()
    if not address or not clean:
        return None
    return "pair:" + hashlib.sha256(f"{address}\0{clean}".encode("utf-8", "replace")).hexdigest()


def _keys(ip: str | None, email: str | None) -> list[str]:
    keys = []
    address = normalize_ip(ip)
    if address:
        keys.append(f"ip:{address}")
    # Credential backoff is scoped to the IP+e-mail pair, and the per-IP cap is deliberately
    # loose (shared village / carrier NAT addresses). The only e-mail-wide key is the SOFT
    # one: a lock of at most two minutes (see EMAIL_SOFT_LIMIT), never an account lockout.
    pair = _pair_key(ip, email)
    if pair:
        keys.append(pair)
    clean = (email or "").strip().lower()
    if clean:
        keys.append("email:" + hashlib.sha256(clean.encode("utf-8", "replace")).hexdigest())
    return keys


# ---------------------------------------------------------------------------
# Secret box (AES-GCM at rest for API keys)
# ---------------------------------------------------------------------------

SECRET_PREFIX = "enc:v1:"
_secret_key_cache: bytes | None = None


def _secret_key() -> bytes | None:
    global _secret_key_cache
    if _secret_key_cache is not None:
        return _secret_key_cache
    material = os.environ.get("SECRET_KEY", "") or ""
    if not material:
        return None
    _secret_key_cache = hashlib.scrypt(material.encode("utf-8"), salt=b"jagakebond-secretbox",
                                       n=2 ** 14, r=8, p=1, dklen=32)
    return _secret_key_cache


def encryption_available() -> bool:
    if _secret_key() is None:
        return False
    try:
        import cryptography  # noqa: F401
    except ImportError:
        return False
    return True


def encryption_status() -> dict[str, Any]:
    has_key = _secret_key() is not None
    try:
        import cryptography  # noqa: F401
        has_lib = True
    except ImportError:
        has_lib = False
    return {
        "available": has_key and has_lib,
        "hasLibrary": has_lib,
        "hasSecretKey": has_key,
        "detail": ("Kunci API disimpan terenkripsi AES-GCM."
                   if has_key and has_lib else
                   "PERINGATAN: kunci API disimpan tanpa enkripsi. Set SECRET_KEY dan pasang "
                   "paket 'cryptography' agar aman."),
    }


def encrypt_secret(plain: str) -> str:
    if not plain:
        return ""
    key = _secret_key()
    if key is None:
        return plain
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError:
        return plain
    nonce = os.urandom(12)
    blob = AESGCM(key).encrypt(nonce, plain.encode("utf-8"), None)
    return SECRET_PREFIX + b64e(nonce) + ":" + b64e(blob)


def decrypt_secret(stored: str | None) -> str:
    """Returns plaintext, or '' when the value cannot be decrypted (wrong SECRET_KEY)."""
    if not stored:
        return ""
    if not stored.startswith(SECRET_PREFIX):
        return stored  # stored before encryption was enabled
    key = _secret_key()
    if key is None:
        return ""
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        body = stored[len(SECRET_PREFIX):]
        nonce_b64, blob_b64 = body.split(":", 1)
        return AESGCM(key).decrypt(b64d(nonce_b64), b64d(blob_b64), None).decode("utf-8")
    except Exception:  # noqa: BLE001 - wrong key, corrupt value, missing library
        return ""


def decrypt_failed(stored: str | None) -> bool:
    """True when a stored secret exists but cannot be read (e.g. SECRET_KEY rotated)."""
    if not stored or not stored.startswith(SECRET_PREFIX):
        return False
    return decrypt_secret(stored) == ""


def secret_hint(plain: str) -> str:
    if not plain:
        return ""
    tail = plain[-4:] if len(plain) >= 4 else plain
    return "••••" + tail


def constant_time_equals(a: str, b: str) -> bool:
    return hmac.compare_digest((a or "").encode("utf-8", "replace"), (b or "").encode("utf-8", "replace"))


def sleep_ms(ms: int) -> None:
    if ms > 0:
        time.sleep(min(ms, 30_000) / 1000)


# ---------------------------------------------------------------------------
# Retention
# ---------------------------------------------------------------------------

LOGIN_ATTEMPT_RETENTION_DAYS = 30
AUDIT_RETENTION_DAYS = 400
_PURGE_BATCH = 2000


def _delete_older_than(table: str, column: str, cutoff_ms: int, predicate: str = "1=1") -> int:
    """Delete rows whose `column` is older than the cutoff, a bounded batch per transaction.

    Batching keeps the SQLite write lock short, so the hourly purge never stalls a farmer's
    upload. `table`/`column` are literals at the call sites, never request data.
    """
    total = 0
    while True:
        with db.transaction() as tx:
            cursor = tx.execute(
                f"DELETE FROM {table} WHERE rowid IN "
                f"(SELECT rowid FROM {table} WHERE {column} < ? AND {predicate} LIMIT ?)",
                (cutoff_ms, _PURGE_BATCH),
            )
        removed = cursor.rowcount or 0
        total += removed
        if removed < _PURGE_BATCH:
            return total


def purge_retention(now_ms: int | None = None) -> dict[str, int]:
    """Drop data that has outlived its purpose. Called hourly by the maintenance thread.

    login_attempts: 30 days (a lock lasts at most an hour; older rows are noise and hold a
    hashed e-mail / IP per attacker). audit_log: 400 days (13 months of history for the
    admin console, then gone). Expired sessions go too, so the table does not depend on
    someone logging in to be cleaned, and so do expired Google sign-in nonces.
    Returns how many rows each purge removed.
    """
    now = db.now_ms() if now_ms is None else int(now_ms)
    day = 86_400_000
    return {
        "loginAttempts": _delete_older_than("login_attempts", "updated_ms",
                                            now - LOGIN_ATTEMPT_RETENTION_DAYS * day),
        "auditLog": _delete_older_than("audit_log", "ts_ms", now - AUDIT_RETENTION_DAYS * day),
        # Phone error reports are diagnostics, not history: 30 days (0.2.4.15).
        "clientErrors": _delete_older_than("audit_log", "ts_ms", now - 30 * day, "action = 'client.error'"),
        "sessions": _delete_older_than("sessions", "expires_ms", now),
        "authNonces": _delete_older_than("auth_nonces", "expires_ms", now),
        "pendingRegistrations": _delete_older_than("registration_requests", "created_ms",
                                                   now - 30 * day, "status = 'pending'"),
        "googleRequestLimits": _delete_older_than("google_request_limits", "window_start_ms", now - day),
    }


# ---------------------------------------------------------------------------
# Access-log privacy
# ---------------------------------------------------------------------------

# GPS coordinates are personal data (they locate a farmer's field and home). The telemetry
# and similar routes carry them in the query string, and uvicorn's access log prints the
# full request target, so they would sit in the journal. The key stays, the value goes.
_COORDINATE_QUERY = re.compile(r"(?i)([?&](?:lat|lng|lon)=)[^&#\s\"']*")


def redact_coordinates(text: str) -> str:
    return _COORDINATE_QUERY.sub(r"\1***", text)


class CoordinateRedactionFilter(logging.Filter):
    """Rewrite lat/lng/lon query values in log records (uvicorn.access passes the request
    target as the third %-format argument)."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            if isinstance(record.args, tuple) and record.args:
                record.args = tuple(redact_coordinates(arg) if isinstance(arg, str) else arg
                                    for arg in record.args)
            if isinstance(record.msg, str):
                record.msg = redact_coordinates(record.msg)
        except Exception:  # noqa: BLE001 - a logging filter must never break logging
            pass
        return True


def install_access_log_redaction() -> None:
    """Attach the filter to uvicorn's access logger once (safe to call repeatedly)."""
    logger = logging.getLogger("uvicorn.access")
    if not any(isinstance(existing, CoordinateRedactionFilter) for existing in logger.filters):
        logger.addFilter(CoordinateRedactionFilter())
