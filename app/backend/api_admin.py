"""Admin console API. Every route here requires role='admin'.

0.2.2.0 hardening (audit section 4):
  * router-level require_admin, per-route admin object kept for the actor's identity;
  * guarded requeue/cancel, last-admin checks inside ONE transaction;
  * re-authentication (the admin's current password) for the few actions that can hand
    the whole system to someone else: creating/granting admin, resetting an admin's
    password, changing the router address or any API key;
  * old -> new values in the audit log (never a secret value);
  * account deletion follows the photo lifecycle contract (storage lock -> db transaction);
  * paged account/audit lists, aggregate counts, explicit columns (never image_b64).
"""

from __future__ import annotations

import base64
import importlib
import logging
import threading
import time
from typing import Any

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute

from . import auth, db, google_auth, queue, security, settings_store


class AdminProblem(HTTPException):
    """HTTPException that also carries a machine-readable `code` for the console."""

    def __init__(self, status_code: int, detail: str, code: str | None = None,
                 headers: dict[str, str] | None = None) -> None:
        super().__init__(status_code=status_code, detail=detail, headers=headers)
        self.code = code


class _AdminRoute(APIRoute):
    """Renders AdminProblem as {"detail": ..., "code": ...} (contract 5.3 error shape)."""

    def get_route_handler(self):  # type: ignore[override]
        original = super().get_route_handler()

        async def handler(request: Request):
            try:
                return await original(request)
            except AdminProblem as exc:
                content: dict[str, Any] = {"detail": exc.detail}
                if exc.code:
                    content["code"] = exc.code
                return JSONResponse(content, status_code=exc.status_code, headers=exc.headers)

        return handler


router = APIRouter(prefix="/api/admin", tags=["admin"], route_class=_AdminRoute,
                   dependencies=[Depends(auth.require_admin)])

log = logging.getLogger("jagakebond.admin")

ROLE_LABEL = {"user": "Normal", "priority": "Prioritas", "admin": "Admin"}
REASON_MAX = 300


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _truthy(value: Any) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on", "ya")
    return bool(value)


def _client_ip(request: Request | None) -> str:
    if request is None:
        return ""
    try:
        return auth.client_ip(request)
    except Exception:  # noqa: BLE001
        return ""


def _session_token(request: Request | None) -> str | None:
    if request is None:
        return None
    try:
        return request.cookies.get(security.SESSION_COOKIE)
    except Exception:  # noqa: BLE001
        return None


def _actor(admin: dict[str, Any]) -> tuple[str | None, str | None]:
    return admin.get("email"), admin.get("id")


def _password_problem(password: str, role: str) -> str | None:
    """Role-aware password policy. security.password_policy_error (BE3) when it exists."""
    policy = getattr(security, "password_policy_error", None)
    if callable(policy):
        try:
            result = policy(password, role)
        except TypeError:
            result = policy(password)
        return str(result) if result else None
    minimum = 12 if role == "admin" else 8
    if not password or len(password) < minimum:
        return f"Kata sandi minimal {minimum} karakter" + (" untuk admin" if role == "admin" else "")
    if len(password) > 200:
        return "Kata sandi terlalu panjang"
    return None


def _require_reauth(admin: dict[str, Any], payload: dict[str, Any], request: Request | None,
                    why: str) -> None:
    """Ask for the acting admin's current password again (finding 7)."""
    supplied = payload.get("currentPassword") if isinstance(payload, dict) else None
    if not isinstance(supplied, str) or not supplied:
        raise AdminProblem(403, "Masukkan kata sandi Anda untuk melanjutkan.", code="reauth_required")
    ip = _client_ip(request)
    # Separate counter from the sign-in form, so hammering this check cannot lock the real login.
    key = "reauth:" + str(admin.get("email") or admin.get("id") or "")
    locked = security.login_locked_for_ms(ip, key)
    if locked > 0:
        wait = max(1, locked // 1000)
        raise AdminProblem(429, f"Terlalu banyak percobaan. Coba lagi dalam {wait} detik.",
                           code="reauth_locked", headers={"Retry-After": str(wait)})
    if not security.verify_password(supplied, admin.get("password_hash") or security.DUMMY_PASSWORD_HASH):
        security.login_record_failure(ip, key)
        settings_store.audit("reauth.failed", admin.get("email"), why, *_actor(admin))
        raise AdminProblem(403, "Kata sandi Anda salah.", code="reauth_failed")
    security.login_reset(ip, key)


def _storage_module() -> Any:
    """backend.storage (photo lifecycle, contract 5.5) or a clear 503 when it is not installed."""
    try:
        return importlib.import_module(f"{__package__ or 'backend'}.storage")
    except ModuleNotFoundError as exc:
        if (exc.name or "").rsplit(".", 1)[-1] == "storage":
            raise AdminProblem(
                503, "Modul penyimpanan foto belum terpasang di server ini, jadi tindakan dibatalkan.",
                code="storage_unavailable") from None
        raise


def _storage_status_or_none() -> dict[str, Any] | None:
    try:
        status = _storage_module().status()
    except Exception:  # noqa: BLE001 - the overview must still render
        return None
    return status if isinstance(status, dict) else None


def _router_probe_url(configured_url: str) -> str:
    """Validate the router base with the SAME rule used when saving, then build the probe URL."""
    return settings_store.canonical_router_url(configured_url) + "/v1/models"


# ---------------------------------------------------------------------------
# Accounts: aggregate counts instead of ~6 queries per row
# ---------------------------------------------------------------------------


def _account_rows_with_counts(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ids = [row["id"] for row in rows]
    counts: dict[str, dict[str, int]] = {
        i: {"recordCount": 0, "jobCount": 0, "farmCount": 0, "sessionCount": 0, "jobsToday": 0}
        for i in ids}
    if ids:
        marks = ",".join("?" * len(ids))
        for table, key in (("records", "recordCount"), ("jobs", "jobCount"), ("farms", "farmCount")):
            for item in db.query(
                    f"SELECT account_id, COUNT(*) AS n FROM {table} "
                    f"WHERE account_id IN ({marks}) GROUP BY account_id", ids):
                counts[item["account_id"]][key] = int(item["n"])
        for item in db.query(
                f"SELECT account_id, COUNT(*) AS n FROM sessions WHERE expires_ms > ? "
                f"AND account_id IN ({marks}) GROUP BY account_id", [db.now_ms(), *ids]):
            counts[item["account_id"]]["sessionCount"] = int(item["n"])
        for item in db.query(
                f"SELECT account_id, COUNT(*) AS n FROM jobs WHERE created_ms >= ? "
                f"AND account_id IN ({marks}) GROUP BY account_id", [queue.start_of_today_ms(), *ids]):
            counts[item["account_id"]]["jobsToday"] = int(item["n"])
    google = google_auth.linked_account_ids(ids)
    out = []
    for row in rows:
        entry = db.row_account(row)
        entry.update(counts[row["id"]])
        entry["googleLinked"] = row["id"] in google
        out.append(entry)
    return out


def _account_row_with_counts(row: dict[str, Any]) -> dict[str, Any]:
    return _account_rows_with_counts([row])[0]


_ACCOUNT_COLUMNS = ("id, email, name, role, is_active, daily_quota, created_ms, updated_ms, last_login_ms")


def _encode_cursor(created_ms: int, account_id: str) -> str:
    return base64.urlsafe_b64encode(f"{created_ms}|{account_id}".encode()).decode().rstrip("=")


def _decode_cursor(cursor: str) -> tuple[int, str]:
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode()
        created, ident = raw.split("|", 1)
        return int(created), ident
    except Exception:  # noqa: BLE001
        raise AdminProblem(400, "Penanda halaman tidak valid.", code="bad_cursor") from None


def _like(text: str) -> str:
    return "%" + text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


# ---------------------------------------------------------------------------
# Overview
# ---------------------------------------------------------------------------


def _worker_status() -> dict[str, Any] | None:
    """queue.worker_status() (BE1) normalised, or None when this build has no such function."""
    fn = getattr(queue, "worker_status", None)
    if not callable(fn):
        return None
    try:
        data = fn()
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(data, dict):
        return None
    last_seen = data.get("lastSeenMs")
    stale = data.get("stale")
    if stale is None:
        stale = not last_seen or (db.now_ms() - int(last_seen)) > 180_000
    return {"lastSeenMs": last_seen, "lastError": data.get("lastError"),
            "lastErrorMs": data.get("lastErrorMs"), "authFailing": bool(data.get("authFailing")),
            "stale": bool(stale), "hasError":data.get("hasError") is True,
            "workers": data.get("workers", []), "missingLanes": data.get("missingLanes", [])}


def _pipeline(worker: dict[str, Any] | None, depth: int, oldest_age_ms: int | None,
              router_url: str, router_key_set: bool, storage_status: dict[str, Any] | None,
              encryption: dict[str, Any]) -> dict[str, Any]:
    """One honest answer to "is the AI pipeline healthy?", with the next step for each problem."""
    issues: list[dict[str, Any]] = []

    def add(level: str, code: str, text: str, action: str | None = None) -> None:
        issues.append({"level": level, "code": code, "text": text, "action": action})

    if not security.worker_token():
        add("bad", "worker_token_missing",
            "Worker belum bisa bekerja: WORKER_TOKEN belum diatur di server.")
    if not router_key_set:
        add("bad", "router_key_missing", "Kunci router belum diisi, jadi foto belum bisa dianalisis.",
            "settings")
    problem = settings_store.router_url_problem(router_url)
    if problem:
        add("bad", "router_url_blocked", "Alamat router tidak diizinkan: " + problem, "settings")
    if worker is not None:
        if worker["authFailing"]:
            add("bad", "worker_auth_failing",
                "Router menolak kunci worker. Analisis berhenti sampai kunci diperbaiki.", "settings")
        elif worker["stale"]:
            if not worker["lastSeenMs"]:
                text = "Worker belum pernah terlihat."
            else:
                minutes = max(1, (db.now_ms() - int(worker["lastSeenMs"])) // 60_000)
                text = f"Worker tidak terlihat sejak {minutes} menit lalu."
            if depth:
                text += f" {depth} foto sedang menunggu."
            add("bad" if depth else "warn", "worker_stale", text, "queue")
        elif worker.get("hasError"):
            add("warn", "worker_error", "Worker melaporkan masalah. Periksa jalur analisis dan antrean.", "queue")
        elif worker["lastError"] and worker["lastErrorMs"] and \
                db.now_ms() - int(worker["lastErrorMs"]) < 900_000:
            add("warn", "worker_error", "Kesalahan terakhir worker: " + str(worker["lastError"])[:140],
                "queue")
    if oldest_age_ms is not None and oldest_age_ms > 900_000 and not any(
            i["code"] in ("worker_stale", "worker_auth_failing") for i in issues):
        add("warn", "queue_slow", f"Antrean lambat: foto tertua sudah menunggu "
            f"{max(1, oldest_age_ms // 60_000)} menit.", "queue")
    if storage_status:
        blocked = int(storage_status.get("blocked") or 0)
        if blocked:
            add("warn", "storage_blocked",
                f"{blocked} berkas foto tidak bisa dibersihkan dan perlu ditinjau.", "storage")
        oldest = storage_status.get("oldestPendingMs")
        if oldest and db.now_ms() - int(oldest) > 3_600_000:
            add("warn", "storage_slow", "Pembersihan foto tertunda lebih dari 1 jam.", "storage")
    if not encryption.get("available"):
        add("warn", "encryption_off",
            "Kunci API belum disimpan terenkripsi (SECRET_KEY atau paket cryptography belum ada).")
    level = "bad" if any(i["level"] == "bad" for i in issues) else "warn" if issues else "ok"
    title = {"ok": "Semua berjalan baik", "warn": "Perlu perhatian",
             "bad": "Ada masalah pada analisis AI"}[level]
    return {"level": level, "title": title, "issues": issues}


@router.get("/overview")
def overview(admin: dict[str, Any] = Depends(auth.require_admin)) -> dict[str, Any]:
    accounts = db.query_one("SELECT COUNT(*) AS n FROM accounts")
    active = db.query_one("SELECT COUNT(*) AS n FROM accounts WHERE is_active = 1")
    now = db.now_ms()
    day_ago = now - 86_400_000
    jobs_24h = db.query("SELECT status, COUNT(*) AS n FROM jobs WHERE created_ms >= ? GROUP BY status",
                        (day_ago,))
    counts = {row["status"]: int(row["n"]) for row in jobs_24h}
    total_24h = sum(counts.values())
    done = counts.get("done", 0)
    rejected = counts.get("rejected", 0)

    heartbeat = db.query_one("SELECT MAX(claimed_ms) AS last_claim FROM jobs WHERE claimed_ms IS NOT NULL")
    last_claim = heartbeat["last_claim"] if heartbeat else None
    waiting = db.query_one(
        "SELECT MIN(created_ms) AS oldest, "
        "SUM(CASE WHEN not_before_ms > ? THEN 1 ELSE 0 END) AS delayed "
        "FROM jobs WHERE status = 'queued'", (now,)) or {}
    oldest_queued = waiting.get("oldest")
    try:
        db_bytes = db.DB_PATH.stat().st_size
    except OSError:
        db_bytes = 0

    legacy = db.query_one("SELECT COUNT(*) AS n FROM settings WHERE key = 'legacy_imported'")
    depth = queue.queue_depth()
    encryption = security.encryption_status()
    worker = _worker_status()
    router_url = settings_store.as_str("NINEROUTER_URL")
    pipeline = _pipeline(
        worker, depth, (now - int(oldest_queued)) if oldest_queued else None, router_url,
        bool(settings_store.secret_value("NINEROUTER_KEY")), _storage_status_or_none(), encryption)
    return {
        "accounts": int(accounts["n"]) if accounts else 0,
        "activeAccounts": int(active["n"]) if active else 0,
        "activeSessions": security.session_count(),
        "queueDepth": depth,
        "byStatus": queue.queue_by_status(),
        "jobs24h": total_24h,
        "jobs24hDone": done,
        "jobs24hRejected": rejected,
        "jobs24hByStatus": counts,
        "rejectRate": round(rejected / total_24h, 3) if total_24h else 0.0,
        "lastClaimMs": last_claim,
        "oldestQueuedMs": oldest_queued,
        "delayedJobs": int(waiting.get("delayed") or 0),
        "worker": worker,
        "pipeline": pipeline,
        "workerTokenConfigured": bool(security.worker_token()),
        "dbBytes": db_bytes,
        # Read the stored version rather than calling db.migrate(), which opens a
        # write transaction on the single writer (DELETE + INSERT) every time an
        # operator refreshes the console overview.
        "schemaVersion": (db.query_one("SELECT version FROM schema_version") or {}).get("version"),
        "encryption": encryption,
        "legacyImported": bool(legacy and int(legacy["n"]) > 0),
        "registrationOpen": settings_store.as_bool("ALLOW_REGISTRATION"),
        "googleSignIn": google_auth.enabled(),
        "pendingRegistrations": google_auth.pending_count(),
        # 0.2.4.15: errors reported by farmers' phones (POST /api/client-errors), newest first.
        "clientErrors24h": int((db.query_one("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'client.error' "
                                             "AND ts_ms >= ?", (day_ago,)) or {}).get("n") or 0),
        "clientErrorsRecent": [{"tsMs": row["ts_ms"], "actor": row["actor_email"], "detail": row["detail"]}
                               for row in db.query("SELECT ts_ms, actor_email, detail FROM audit_log "
                                                   "WHERE action = 'client.error' ORDER BY ts_ms DESC LIMIT 5")],
    }


@router.get("/health")
def admin_health(admin: dict[str, Any] = Depends(auth.require_admin)) -> dict[str, Any]:
    """Full health. The public /api/health intentionally stays minimal."""
    url = settings_store.as_str("NINEROUTER_URL")
    return {
        "ok": True,
        "triageModel": settings_store.as_str("GEMINI_TRIAGE_MODEL"),
        "diagnoseModel": settings_store.as_str("GEMINI_DIAGNOSE_MODEL"),
        "routerUrl": url,
        "routerUrlProblem": settings_store.router_url_problem(url),
        "routerKeyConfigured": bool(settings_store.secret_value("NINEROUTER_KEY")),
        "plantAiConfigured": bool(settings_store.secret_value("PLANT_ID_API_KEY")),
        "queueDepth": queue.queue_depth(),
    }


# ---------------------------------------------------------------------------
# Accounts
# ---------------------------------------------------------------------------


@router.get("/accounts")
def list_accounts(q: str | None = Query(None), limit: int | None = Query(None, ge=1, le=200),
                  cursor: str | None = Query(None), role: str | None = Query(None),
                  status: str | None = Query(None),
                  admin: dict[str, Any] = Depends(auth.require_admin)) -> Any:
    """Without `limit`/`cursor`: the legacy bare list (newest 500). With them: {items, next, total}."""
    where: list[str] = []
    params: list[Any] = []
    if q and q.strip():
        pattern = _like(q.strip()[:80])
        where.append("(email LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')")
        params += [pattern, pattern]
    if role:
        if role not in auth.VALID_ROLES:
            raise HTTPException(status_code=400, detail="Peran tidak dikenal")
        where.append("role = ?")
        params.append(role)
    if status in ("active", "inactive"):
        where.append("is_active = ?")
        params.append(1 if status == "active" else 0)
    base = (" WHERE " + " AND ".join(where)) if where else ""

    paged = limit is not None or cursor is not None
    page = limit or 500
    page_where, page_params = base, list(params)
    if cursor:
        created_ms, ident = _decode_cursor(cursor)
        keyset = "(created_ms < ? OR (created_ms = ? AND id < ?))"
        page_where = (base + " AND " if base else " WHERE ") + keyset
        page_params += [created_ms, created_ms, ident]
    rows = db.query(
        f"SELECT {_ACCOUNT_COLUMNS} FROM accounts{page_where} ORDER BY created_ms DESC, id DESC LIMIT ?",
        page_params + [page + 1 if paged else page])
    if not paged:
        return _account_rows_with_counts(rows)
    more = len(rows) > page
    rows = rows[:page]
    total = db.query_one(f"SELECT COUNT(*) AS n FROM accounts{base}", params)
    return {"items": _account_rows_with_counts(rows),
            "next": _encode_cursor(rows[-1]["created_ms"], rows[-1]["id"]) if more and rows else None,
            "total": int(total["n"]) if total else 0}


@router.post("/accounts")
def admin_create_account(payload: dict[str, Any] = Body(...), request: Request = None,  # type: ignore[assignment]
                         admin: dict[str, Any] = Depends(auth.require_admin)) -> dict[str, Any]:
    role = str(payload.get("role") or "user")
    if role not in auth.VALID_ROLES:
        raise HTTPException(status_code=400, detail="Peran tidak dikenal")
    password = str(payload.get("password") or "")
    confirm = payload.get("passwordConfirm")
    if confirm is not None and str(confirm) != password:
        raise HTTPException(status_code=400, detail="Kata sandi dan ulangannya tidak sama.")
    problem = _password_problem(password, role)
    if problem:
        raise HTTPException(status_code=400, detail=problem)
    if role == "admin":
        _require_reauth(admin, payload, request, "membuat akun admin")
    # Accepted only as a deprecated compatibility input; tier caps are fixed.
    account = auth.create_account(
        str(payload.get("email") or ""),
        password,
        str(payload.get("name") or ""),
        role=role,
        daily_quota=None,
        actor=admin.get("email"),
    )
    return _account_row_with_counts(account)


def _last_admin_left(tx: Any, account_id: str) -> bool:
    """True when nobody but `account_id` is an active admin. Runs inside the caller's transaction."""
    row = tx.execute(
        "SELECT COUNT(*) AS n FROM accounts WHERE role = 'admin' AND is_active = 1 AND id != ?",
        (account_id,)).fetchone()
    return not row or int(row["n"]) == 0


@router.put("/accounts/{account_id}")
def admin_update_account(account_id: str, payload: dict[str, Any] = Body(...),
                         request: Request = None,  # type: ignore[assignment]
                         admin: dict[str, Any] = Depends(auth.require_admin)) -> dict[str, Any]:
    pre = auth.find_by_id(account_id)
    if not pre:
        raise HTTPException(status_code=404, detail="Akun tidak ditemukan")

    wanted: dict[str, Any] = {}
    if "name" in payload:
        wanted["name"] = " ".join(str(payload["name"]).split())[:120]
    if "email" in payload:
        email = str(payload["email"] or "").strip()
        if not auth.EMAIL_RE.match(email):
            raise HTTPException(status_code=400, detail="Format email tidak valid")
        wanted["email"] = email
    if "role" in payload:
        role = str(payload["role"])
        if role not in auth.VALID_ROLES:
            raise HTTPException(status_code=400, detail="Peran tidak dikenal")
        wanted["role"] = role
    if "isActive" in payload:
        wanted["is_active"] = 1 if _truthy(payload["isActive"]) else 0
    # Legacy dailyQuota edits are ignored rather than allowed to modify role caps.

    granting_admin = wanted.get("role") == "admin" and pre["role"] != "admin"
    retargeting_admin = (pre["role"] == "admin" and "email" in wanted
                         and wanted["email"].lower() != str(pre["email"]).lower())
    reauthenticated = False
    if granting_admin or retargeting_admin:
        _require_reauth(admin, payload, request,
                        "memberi peran admin" if granting_admin else "mengubah email admin")
        reauthenticated = True

    after_commit_revoke = False
    with db.transaction() as tx:
        fetched = tx.execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone()
        if fetched is None:
            raise HTTPException(status_code=404, detail="Akun tidak ditemukan")
        row = dict(fetched)
        if wanted.get("role") == "admin" and row["role"] != "admin" and not reauthenticated:
            # The role changed between the first read and now: ask again rather than grant silently.
            raise AdminProblem(403, "Masukkan kata sandi Anda untuk melanjutkan.", code="reauth_required")
        new_role = wanted.get("role", row["role"])
        new_active = wanted.get("is_active", row["is_active"])
        if "is_active" in wanted and not wanted["is_active"] and row["id"] == admin.get("id"):
            raise HTTPException(status_code=400, detail="Tidak bisa menonaktifkan akun sendiri")
        loses_admin = (row["role"] == "admin" and row["is_active"]
                       and (new_role != "admin" or not new_active))
        if loses_admin and _last_admin_left(tx, account_id):
            raise HTTPException(status_code=400, detail="Harus ada minimal satu admin aktif")
        if "email" in wanted and wanted["email"].lower() != str(row["email"]).lower():
            clash = tx.execute("SELECT id FROM accounts WHERE email = ? COLLATE NOCASE AND id != ?",
                               (wanted["email"], account_id)).fetchone()
            if clash:
                raise HTTPException(status_code=409, detail="Email sudah terdaftar")

        changes: list[str] = []
        updates: dict[str, Any] = {}
        if "name" in wanted and wanted["name"] != row["name"]:
            updates["name"] = wanted["name"]
            changes.append(f"nama: \"{row['name']}\" -> \"{wanted['name']}\"")
        if "email" in wanted and wanted["email"] != row["email"]:
            updates["email"] = wanted["email"]
            changes.append(f"email: {row['email']} -> {wanted['email']}")
        if "role" in wanted and wanted["role"] != row["role"]:
            updates["role"] = wanted["role"]
            changes.append(f"peran: {ROLE_LABEL.get(row['role'], row['role'])} -> "
                           f"{ROLE_LABEL.get(wanted['role'], wanted['role'])}")
        if "is_active" in wanted and wanted["is_active"] != row["is_active"]:
            updates["is_active"] = wanted["is_active"]
            changes.append("status: " + ("aktif -> nonaktif" if not wanted["is_active"] else "nonaktif -> aktif"))
        if updates:
            assignments = ", ".join(f"{column} = ?" for column in updates)
            tx.execute(f"UPDATE accounts SET {assignments}, updated_ms = ? WHERE id = ?",
                       list(updates.values()) + [db.now_ms(), account_id])
            settings_store.audit_tx(tx, "account.update", row["email"], "; ".join(changes), *_actor(admin))
            after_commit_revoke = updates.get("is_active") == 0
    if after_commit_revoke:
        security.session_delete_for_account(account_id)
    return _account_row_with_counts(auth.find_by_id(account_id))


@router.post("/accounts/{account_id}/password")
def admin_reset_password(account_id: str, payload: dict[str, Any] = Body(...),
                         request: Request = None,  # type: ignore[assignment]
                         admin: dict[str, Any] = Depends(auth.require_admin)) -> dict[str, Any]:
    row = auth.find_by_id(account_id)
    if not row:
        raise HTTPException(status_code=404, detail="Akun tidak ditemukan")
    password = str(payload.get("password") or "")
    confirm = payload.get("passwordConfirm")
    if confirm is not None and str(confirm) != password:
        raise HTTPException(status_code=400, detail="Kata sandi dan ulangannya tidak sama.")
    problem = _password_problem(password, row["role"])
    if problem:
        raise HTTPException(status_code=400, detail=problem)
    if row["role"] == "admin":
        # Includes the acting admin's own account: a stolen session must not be able to lock the owner out.
        _require_reauth(admin, payload, request, "mengatur ulang kata sandi admin")
    auth.set_password(account_id, password)
    own = row["id"] == admin.get("id")
    keep = _session_token(request) if own else None
    revoked = security.session_delete_for_account(account_id, keep_token=keep)
    detail = (f"{revoked} sesi lain dicabut; sesi ini tetap masuk" if own and keep
              else f"{revoked} sesi dicabut")
    settings_store.audit("account.reset_password", row["email"], detail, *_actor(admin))
    return {"ok": True, "revokedSessions": revoked, "keptCurrentSession": bool(own and keep)}


@router.delete("/accounts/{account_id}")
def admin_delete_account(account_id: str, request: Request = None,  # type: ignore[assignment]
                         admin: dict[str, Any] = Depends(auth.require_admin)) -> dict[str, Any]:
    if not auth.find_by_id(account_id):
        raise HTTPException(status_code=404, detail="Akun tidak ditemukan")
    storage = _storage_module()
    # Lock order (contract 5.5): storage lock -> db transaction -> SQL.
    with storage.storage_lock():
        with db.transaction() as tx:
            fetched = tx.execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone()
            if fetched is None:
                raise HTTPException(status_code=404, detail="Akun tidak ditemukan")
            row = dict(fetched)
            if row["id"] == admin.get("id"):
                raise HTTPException(status_code=400, detail="Tidak bisa menghapus akun sendiri")
            if row["role"] == "admin":
                remaining = tx.execute(
                    "SELECT COUNT(*) AS n FROM accounts WHERE role = 'admin' AND id != ?",
                    (account_id,)).fetchone()
                if not remaining or int(remaining["n"]) == 0:
                    raise HTTPException(status_code=400, detail="Harus ada minimal satu admin")
            try:
                retired = storage.retire_account_objects(tx, account_id) or {}
            except HTTPException:
                raise
            except Exception:  # noqa: BLE001 - roll everything back; the account must stay intact
                log.exception("retire_account_objects failed for %s", account_id)
                raise AdminProblem(
                    500, "Akun belum dihapus: foto akun ini belum bisa dijadwalkan untuk dibersihkan. "
                         "Coba lagi sebentar lagi.", code="storage_failed") from None
            queued = int(retired.get("queued", 0))
            blocked = int(retired.get("blocked", 0))
            tx.execute("DELETE FROM accounts WHERE id = ?", (account_id,))
            settings_store.audit_tx(
                tx, "account.delete", row["email"],
                f"akun dan data basis data dihapus; foto: {queued} dijadwalkan dibersihkan, "
                f"{blocked} perlu ditinjau", *_actor(admin))
    drained: dict[str, Any] = {}
    try:
        drained = storage.drain(50) or {}
    except Exception:  # noqa: BLE001 - the tickets are durable; the background drainer will finish
        drained = {}
    pending = int(drained.get("pending", queued)) if drained else queued
    cleaned = min(queued, int(drained.get("done", 0))) if drained else 0
    return {"ok": True, "accountRemoved": True,
            "photoCleanup": {"queued": queued, "blocked": blocked, "pendingAfterDrain": pending,
                             "cleaned": cleaned},
            "photoCleanupFailures": blocked + pending}


# ---------------------------------------------------------------------------
# Registration inbox (Sign in with Google, 0.2.3.0)
# ---------------------------------------------------------------------------


@router.get("/registrations")
def admin_registrations(status: str = Query("pending"),
                        admin: dict[str, Any] = Depends(auth.require_admin)) -> dict[str, Any]:
    if status not in ("pending", "approved", "rejected"):
        raise HTTPException(status_code=400, detail="Status tidak dikenal")
    return {"enabled": google_auth.enabled(), "pending": google_auth.pending_count(),
            "items": google_auth.list_requests(status)}


def _pending_request(tx: Any, request_id: str) -> dict[str, Any]:
    fetched = tx.execute("SELECT * FROM registration_requests WHERE id = ?", (request_id,)).fetchone()
    if fetched is None:
        raise AdminProblem(404, "Permintaan tidak ditemukan.", code="registration_missing")
    row = dict(fetched)
    if row["status"] != "pending":
        raise AdminProblem(409, "Permintaan ini sudah diputuskan. Muat ulang daftar.", code="registration_decided")
    return row


@router.post("/registrations/{request_id}/approve")
def admin_approve_registration(request_id: str, payload: dict[str, Any] = Body(default={}),
                               request: Request = None,  # type: ignore[assignment]
                               admin: dict[str, Any] = Depends(auth.require_admin)) -> dict[str, Any]:
    _require_reauth(admin, payload, request, "menyetujui pendaftaran")
    with db.transaction() as tx:
        row = _pending_request(tx, request_id)
        if tx.execute("SELECT 1 FROM accounts WHERE email = ? COLLATE NOCASE", (row["email"],)).fetchone():
            raise AdminProblem(409, "Email ini sudah punya akun. Periksa akun dan kepemilikan email "
                                    "sebelum menyetujui.", code="email_taken")
        if tx.execute("SELECT 1 FROM google_identities WHERE sub = ?", (row["sub"],)).fetchone():
            raise AdminProblem(409, "Akun Google ini sudah tersambung ke akun lain.", code="google_link_conflict")
        account_id = auth.create_google_account(tx, row["email"], row["name"] or "", row["sub"], admin.get("email"))
        tx.execute("UPDATE registration_requests SET status = 'approved', decided_ms = ?, decided_by = ?, "
                   "account_id = ?, updated_ms = ? WHERE id = ?",
                   (db.now_ms(), admin.get("email"), account_id, db.now_ms(), request_id))
        settings_store.audit_tx(tx, "registration.approve", row["email"], "akun petani dibuat (masuk dengan Google)",
                                *_actor(admin))
    return {"ok": True, "account": _account_row_with_counts(auth.find_by_id(account_id))}


@router.post("/registrations/{request_id}/reject")
def admin_reject_registration(request_id: str, payload: dict[str, Any] = Body(default={}),
                              request: Request = None,  # type: ignore[assignment]
                              admin: dict[str, Any] = Depends(auth.require_admin)) -> dict[str, Any]:
    _require_reauth(admin, payload, request, "menolak pendaftaran")
    with db.transaction() as tx:
        row = _pending_request(tx, request_id)
        tx.execute("UPDATE registration_requests SET status = 'rejected', decided_ms = ?, decided_by = ?, "
                   "updated_ms = ? WHERE id = ?", (db.now_ms(), admin.get("email"), db.now_ms(), request_id))
        settings_store.audit_tx(tx, "registration.reject", row["email"], None, *_actor(admin))
    return {"ok": True}


# ---------------------------------------------------------------------------
# Settings / API keys
# ---------------------------------------------------------------------------


@router.get("/settings")
def get_settings(admin: dict[str, Any] = Depends(auth.require_admin)) -> dict[str, Any]:
    hosts = sorted(settings_store.ROUTER_LOOPBACK_HOSTS | settings_store.router_extra_hosts())
    return {"settings": settings_store.public_settings(),
            "encryption": security.encryption_status(),
            "routerHosts": hosts}


@router.put("/settings")
def put_settings(payload: dict[str, Any] = Body(...), request: Request = None,  # type: ignore[assignment]
                 admin: dict[str, Any] = Depends(auth.require_admin)) -> dict[str, Any]:
    nested = isinstance(payload.get("settings"), dict)
    updates = payload.get("settings") if nested else {
        key: value for key, value in payload.items() if key != "currentPassword"}
    # An empty string for a secret means "leave it alone", not "erase it" — the
    # console cannot echo the current value back, so it must not clear it either.
    updates = {
        key: value for key, value in updates.items()
        if not ((settings_store.spec(key) or {}).get("secret") and str(value or "") == "")
    }
    clean, errors, policy = settings_store.validate_full(updates)
    if errors:
        raise HTTPException(status_code=422 if policy else 400, detail="; ".join(errors))
    sensitive = settings_store.sensitive_changes(clean)
    if sensitive:
        _require_reauth(admin, payload, request, "mengubah " + ", ".join(sensitive))
    result = settings_store.update_settings(updates, admin.get("email") or "", admin.get("id"))
    if not result["ok"]:
        raise HTTPException(status_code=422 if result.get("policy") else 400,
                            detail="; ".join(result["errors"]))
    return {"ok": True, "applied": result["applied"], "encryption": security.encryption_status()}


@router.post("/settings/{key}/clear")
def clear_setting_secret(key: str, payload: dict[str, Any] = Body(default={}),
                         request: Request = None,  # type: ignore[assignment]
                         admin: dict[str, Any] = Depends(auth.require_admin)) -> dict[str, Any]:
    meta = settings_store.spec(key)
    if not meta or not meta.get("secret") or meta.get("hidden"):
        raise HTTPException(status_code=404, detail="Kunci tidak ditemukan")
    _require_reauth(admin, payload if isinstance(payload, dict) else {}, request, "menghapus " + key)
    return settings_store.clear_secret(key, admin.get("email") or "", admin.get("id"))


_TEST_WINDOW_SEC = 60
_TEST_MAX_PER_WINDOW = 12
_test_calls: dict[str, list[float]] = {}
_test_lock = threading.Lock()


def _throttle_router_test(admin: dict[str, Any]) -> None:
    now = time.monotonic()
    who = str(admin.get("id") or admin.get("email") or "")
    with _test_lock:
        recent = [stamp for stamp in _test_calls.get(who, []) if now - stamp < _TEST_WINDOW_SEC]
        if len(recent) >= _TEST_MAX_PER_WINDOW:
            _test_calls[who] = recent
            raise AdminProblem(429, "Terlalu sering menguji router. Tunggu sebentar lalu coba lagi.",
                               code="rate_limited", headers={"Retry-After": str(_TEST_WINDOW_SEC)})
        recent.append(now)
        _test_calls[who] = recent


def _draft_text(body: dict[str, Any], name: str) -> str:
    value = body.get(name)
    return value.strip() if isinstance(value, str) else ""


@router.post("/settings/test-router")
def test_router(payload: dict[str, Any] | None = Body(default=None),
                request: Request = None,  # type: ignore[assignment]
                admin: dict[str, Any] = Depends(auth.require_admin)) -> dict[str, Any]:
    """Probe the router so the operator learns the truth before a farmer does.

    The body may carry DRAFT values from the form (url, key, triageModel, diagnoseModel). They are
    tested exactly as typed and never saved. A key is never echoed back or written to the audit log.
    """
    body = payload if isinstance(payload, dict) else {}
    _throttle_router_test(admin)
    url = settings_store.as_str("NINEROUTER_URL")
    key = settings_store.secret_value("NINEROUTER_KEY")
    triage = settings_store.as_str("GEMINI_TRIAGE_MODEL")
    diagnose = settings_store.as_str("GEMINI_DIAGNOSE_MODEL")
    draft_url, draft_key = _draft_text(body, "url"), _draft_text(body, "key")
    url = draft_url or url
    key = draft_key or key
    triage = _draft_text(body, "triageModel") or triage
    diagnose = _draft_text(body, "diagnoseModel") or diagnose
    drafted = ",".join(name for name, value in (("url", draft_url), ("key", draft_key)) if value)

    def finish(result: dict[str, Any], target: str) -> dict[str, Any]:
        summary = ("draf: " + drafted + "; " if drafted else "tersimpan; ") + \
            ("berhasil" if result.get("ok") else str(result.get("detail", ""))[:120])
        settings_store.audit("setting.test_router", target, summary, *_actor(admin))
        return result

    canonical, problem = settings_store.router_url_check(url)
    if problem or not canonical:
        return finish({"ok": False, "reachable": False, "authorised": False, "policy": True,
                       "detail": problem}, "(alamat ditolak)")
    if not key:
        return finish({"ok": False, "reachable": False, "authorised": False, "testedUrl": canonical,
                       "detail": "Kunci router belum diisi."}, canonical)
    if any(ch.isspace() or ord(ch) < 32 for ch in key):
        return finish({"ok": False, "reachable": False, "authorised": False, "testedUrl": canonical,
                       "detail": "Kunci router tidak boleh berisi spasi."}, canonical)
    try:
        with httpx.Client(timeout=20.0, follow_redirects=False) as client:
            response = client.get(canonical + "/v1/models", headers={"Authorization": f"Bearer {key}"})
    except Exception:  # noqa: BLE001 - never leak transport details or the key
        return finish({"ok": False, "reachable": False, "authorised": False, "testedUrl": canonical,
                       "detail": "Router tidak dapat dihubungi. Periksa alamatnya dan pastikan router menyala."},
                      canonical)

    if response.status_code in (401, 403):
        return finish({"ok": False, "reachable": True, "authorised": False, "testedUrl": canonical,
                       "detail": f"Router menolak kunci ({response.status_code}). Periksa kunci router."},
                      canonical)
    if response.status_code != 200:
        return finish({"ok": False, "reachable": True, "authorised": True, "testedUrl": canonical,
                       "detail": f"Router membalas HTTP {response.status_code}."}, canonical)

    try:
        ids = [item.get("id") for item in (response.json().get("data") or [])]
    except Exception:  # noqa: BLE001
        ids = []
    missing = [name for name, found in (("triase", triage in ids), ("diagnosis", diagnose in ids)) if not found]
    result = {
        "ok": not missing, "reachable": True, "authorised": True, "modelCount": len(ids), "testedUrl": canonical,
        "triageModel": triage, "triageFound": triage in ids,
        "diagnoseModel": diagnose, "diagnoseFound": diagnose in ids,
        "detail": ("Router terhubung dan kedua rute ditemukan. Kemampuan gambar dan JSON belum diuji." if not missing else
                   "Router terhubung, tetapi model " + " dan ".join(missing) + " tidak ada di daftar router."),
    }
    if body.get("probe") is True:
        from .model_probe import probe
        fast_triage = _draft_text(body, "fastTriageModel") or settings_store.as_str("GEMINI_TRIAGE_MODEL_FAST")
        fast_diagnose = _draft_text(body, "fastDiagnoseModel") or settings_store.as_str("GEMINI_DIAGNOSE_MODEL_FAST")
        routes = list(dict.fromkeys([triage, diagnose, fast_triage, fast_diagnose]))
        if any(not name or len(name) > 160 or any(ord(c) < 32 for c in name) for name in routes):
            result.update(ok=False, detail="Nama rute model tidak valid.")
        else:
            result["probes"] = [probe(canonical, key, route) for route in routes]
            result["ok"] = all(item["ok"] for item in result["probes"])
            result["detail"] = ("Uji kemampuan selesai. " +
                ("Semua rute mengenali gambar sintetis dan memberi JSON yang sesuai." if result["ok"] else
                 "Ada rute yang belum lulus uji gambar dan JSON."))
        result["limitation"] = "Uji sintetis tidak mengukur ketepatan diagnosis tanaman. Evaluasi foto berlabel tetap diperlukan."
    return finish(result, canonical)


# ---------------------------------------------------------------------------
# Queue inspector
# ---------------------------------------------------------------------------

# Never `SELECT *`: every row of `jobs` carries a 100-200 KB base64 photo.
_JOB_LIST_SQL = (
    "SELECT j.id, j.account_id, j.status, j.attempts, j.created_ms, j.updated_ms, j.claimed_ms, "
    "j.worker, j.error, j.acked, j.release_count, j.not_before_ms, j.first_claimed_ms, j.lease_expires_ms, "
    "(j.image_b64 IS NOT NULL) AS has_image, "
    "CASE WHEN json_valid(j.context_json) THEN json_extract(j.context_json, '$.analysisTier') END AS tier, "
    "a.email AS owner_email FROM jobs j LEFT JOIN accounts a ON a.id = j.account_id")
_REQUEUEABLE = ("rejected", "failed")
_CANCELLABLE = ("queued", "claimed")


def _is_stale_claim(row: dict[str, Any], now: int | None = None) -> bool:
    if row.get("status") != "claimed":
        return False
    if row.get("lease_expires_ms") is not None:
        return (now if now is not None else db.now_ms()) >= int(row["lease_expires_ms"])
    anchor = row.get("claimed_ms") or row.get("updated_ms") or row.get("created_ms") or 0
    return (now or db.now_ms()) - int(anchor) > settings_store.as_int("QUEUE_STALE_CLAIM_SEC") * 1000


def _can_requeue(row: dict[str, Any], now: int | None = None) -> bool:
    return bool(row.get("has_image")) and (row.get("status") in _REQUEUEABLE or _is_stale_claim(row, now))


def _job_summary(row: dict[str, Any], last_event: dict[str, Any] | None, now: int) -> dict[str, Any]:
    return {
        "id": row["id"], "accountId": row["account_id"], "ownerEmail": row["owner_email"],
        "status": row["status"], "attempts": row["attempts"], "createdMs": row["created_ms"],
        "updatedMs": row["updated_ms"], "claimedMs": row["claimed_ms"], "worker": row["worker"],
        "error": row["error"], "acked": bool(row["acked"]), "tier": row["tier"],
        "releaseCount": row["release_count"], "notBeforeMs": row["not_before_ms"],
        "delayed": row["status"] == "queued" and int(row["not_before_ms"] or 0) > now,
        "hasImage": bool(row["has_image"]), "stale": _is_stale_claim(row, now),
        "canRequeue": _can_requeue(row, now), "canCancel": row["status"] in _CANCELLABLE,
        "lastEvent": last_event, "events": [last_event] if last_event else [],
    }


@router.get("/queue")
def admin_queue(limit: int = Query(50, ge=1, le=200), status: str | None = Query(None),
                admin: dict[str, Any] = Depends(auth.require_admin)) -> dict[str, Any]:
    sql = _JOB_LIST_SQL
    params: list[Any] = []
    if status == "problem":
        sql += " WHERE j.status IN ('rejected','failed')"
    elif status:
        sql += " WHERE j.status = ?"
        params.append(status)
    sql += " ORDER BY j.created_ms DESC LIMIT ?"
    params.append(limit)
    rows = db.query(sql, params)
    # One query for the newest trace line of every listed job (the list shows no more than that).
    last: dict[str, dict[str, Any]] = {}
    ids = [row["id"] for row in rows]
    if ids:
        marks = ",".join("?" * len(ids))
        for event in db.query(
                "SELECT e.job_id, e.ts_ms, e.stage, e.model, e.http_status, e.latency_ms, e.detail "
                "FROM job_events e JOIN (SELECT job_id, MAX(id) AS last_id FROM job_events "
                f"WHERE job_id IN ({marks}) GROUP BY job_id) m ON e.id = m.last_id", ids):
            last[event["job_id"]] = {
                "tsMs": event["ts_ms"], "stage": event["stage"], "model": event["model"],
                "httpStatus": event["http_status"], "latencyMs": event["latency_ms"],
                "detail": (event["detail"] or "")[:200] or None}
    now = db.now_ms()
    return {"depth": queue.queue_depth(), "byStatus": queue.queue_by_status(),
            "workerTokenConfigured": bool(security.worker_token()),
            "jobs": [_job_summary(row, last.get(row["id"]), now) for row in rows]}


@router.get("/jobs/{job_id}")
def admin_job_detail(job_id: str,
                     admin: dict[str, Any] = Depends(auth.require_admin)) -> dict[str, Any]:
    row = db.query_one(
        "SELECT j.id, j.account_id, j.status, j.attempts, j.created_ms, j.updated_ms, j.claimed_ms, "
        "j.worker, j.device_id, j.context_json, j.triage_json, j.diagnosis_json, j.error, j.acked, "
        "j.release_count, j.not_before_ms, j.first_claimed_ms, (j.image_b64 IS NOT NULL) AS has_image, "
        "a.email AS owner_email FROM jobs j LEFT JOIN accounts a ON a.id = j.account_id WHERE j.id = ?",
        (job_id,))
    if not row:
        raise HTTPException(status_code=404, detail="Pekerjaan tidak ditemukan")
    job = db.row_job(row)
    job["ownerEmail"] = row["owner_email"]
    job["releaseCount"] = row["release_count"]
    job["notBeforeMs"] = row["not_before_ms"]
    job["hasImage"] = bool(row["has_image"])
    job["events"] = queue.job_events(job_id, limit=200)
    # An admin reading a farmer's job is itself an event worth recording.
    settings_store.audit("job.view", job_id, f"pemilik {row['owner_email'] or row['account_id']}",
                         *_actor(admin))
    return job


def _job_state_problem(row: dict[str, Any], action: str) -> AdminProblem:
    names = {"queued": "menunggu", "claimed": "sedang dikerjakan", "done": "selesai",
             "rejected": "ditolak", "failed": "gagal", "cancelled": "dibatalkan"}
    state = names.get(row["status"], row["status"])
    if action == "requeue":
        if row["status"] in _REQUEUEABLE or row["status"] == "claimed":
            reason = ("Foto pekerjaan ini sudah dibersihkan dari server, jadi tidak bisa diulang. "
                      "Minta petani mengirim foto lagi." if not row.get("has_image") else
                      "Pekerjaan ini masih dikerjakan worker. Tunggu sampai macet, lalu ulangi.")
        else:
            reason = (f"Pekerjaan ini {state}. Hanya pekerjaan yang ditolak, gagal, atau macet "
                      "yang bisa diulang.")
    else:
        reason = f"Pekerjaan ini {state}. Hanya pekerjaan yang menunggu atau sedang dikerjakan yang bisa dibatalkan."
    return AdminProblem(409, reason, code="invalid_state")


@router.post("/queue/{job_id}/requeue")
def admin_requeue(job_id: str, admin: dict[str, Any] = Depends(auth.require_admin)) -> dict[str, Any]:
    now = db.now_ms()
    with db.transaction() as tx:
        fetched = tx.execute(_JOB_LIST_SQL + " WHERE j.id = ?", (job_id,)).fetchone()
        if fetched is None:
            raise HTTPException(status_code=404, detail="Pekerjaan tidak ditemukan")
        row = dict(fetched)
        if not _can_requeue(row, now):
            raise _job_state_problem(row, "requeue")
        # Fresh budget: attempts and the release/backoff counters start over.
        tx.execute(
            "UPDATE jobs SET status = 'queued', worker = NULL, claimed_ms = NULL, error = NULL, claim_token = NULL, lease_expires_ms = NULL, "
            "attempts = 0, release_count = 0, not_before_ms = 0, first_claimed_ms = NULL, "
            "updated_ms = ? WHERE id = ?", (now, job_id))
        reset = getattr(queue, "reset_release_state", None)  # BE1's helper; the UPDATE above already covers it
        if callable(reset):
            reset(tx, job_id)
        settings_store.audit_tx(
            tx, "queue.requeue", job_id,
            f"dari {row['status']}; percobaan {row['attempts']} -> 0; pemilik {row['owner_email'] or row['account_id']}",
            *_actor(admin))
    fresh = db.query_one(_JOB_LIST_SQL + " WHERE j.id = ?", (job_id,)) or row
    return {"ok": True, "job": _job_summary(fresh, None, db.now_ms())}


def _clean_reason(raw: Any) -> str:
    text = " ".join("".join(ch if ch >= " " and ch != "\x7f" else " " for ch in str(raw or "")).split())
    return (text or "Dibatalkan oleh admin")[:REASON_MAX]


@router.post("/queue/{job_id}/cancel")
def admin_cancel(job_id: str, payload: dict[str, Any] = Body(default={}),
                 admin: dict[str, Any] = Depends(auth.require_admin)) -> dict[str, Any]:
    reason = _clean_reason((payload or {}).get("reason") if isinstance(payload, dict) else None)
    now = db.now_ms()
    with db.transaction() as tx:
        fetched = tx.execute(_JOB_LIST_SQL + " WHERE j.id = ?", (job_id,)).fetchone()
        if fetched is None:
            raise HTTPException(status_code=404, detail="Pekerjaan tidak ditemukan")
        row = dict(fetched)
        if row["status"] not in _CANCELLABLE:
            raise _job_state_problem(row, "cancel")
        tx.execute("UPDATE jobs SET status = 'rejected', claim_token = NULL, lease_expires_ms = NULL, error = ?, updated_ms = ? WHERE id = ?",
                   (reason, now, job_id))
        settings_store.audit_tx(tx, "queue.cancel", job_id, f"dari {row['status']}: {reason}", *_actor(admin))
    fresh = db.query_one(_JOB_LIST_SQL + " WHERE j.id = ?", (job_id,)) or row
    return {"ok": True, "job": _job_summary(fresh, None, db.now_ms())}


# ---------------------------------------------------------------------------
# Photo storage (BE2's lifecycle module, contract 5.5)
# ---------------------------------------------------------------------------

_inventory_lock = threading.Lock()


@router.get("/storage")
def admin_storage(admin: dict[str, Any] = Depends(auth.require_admin)) -> dict[str, Any]:
    status = _storage_module().status()
    return {"available": True, **(status if isinstance(status, dict) else {})}


@router.post("/storage/inventory")
def admin_storage_inventory(admin: dict[str, Any] = Depends(auth.require_admin)) -> dict[str, Any]:
    """REPORT-ONLY scan for files nobody references. Nothing is deleted or moved."""
    storage = _storage_module()
    if not _inventory_lock.acquire(blocking=False):
        raise AdminProblem(409, "Pemeriksaan lain sedang berjalan. Tunggu sebentar.", code="busy")
    try:
        result = storage.inventory()
    finally:
        _inventory_lock.release()
    settings_store.audit(
        "storage.inventory", "data/uploads",
        f"berkas {result.get('files', 0)}; terpakai {result.get('referenced', 0)}; "
        f"tidak terpakai {result.get('unreferencedCount', 0)} ({result.get('unreferencedBytes', 0)} B)",
        *_actor(admin))
    return result


# ---------------------------------------------------------------------------
# Audit log
# ---------------------------------------------------------------------------


@router.get("/audit")
def admin_audit(limit: int = Query(200, ge=1, le=1000),
                admin: dict[str, Any] = Depends(auth.require_admin)) -> list[dict[str, Any]]:
    """Legacy bare list (everything, newest first). The console uses /audit/entries."""
    return settings_store.recent_audit(limit)


@router.get("/audit/entries")
def admin_audit_entries(limit: int = Query(50, ge=1, le=200), before: int | None = Query(None, ge=1),
                        action: str | None = Query(None, max_length=80),
                        routine: bool = Query(False), q: str | None = Query(None, max_length=80),
                        admin: dict[str, Any] = Depends(auth.require_admin)) -> dict[str, Any]:
    return settings_store.audit_page(limit=limit, before=before, action=action,
                                     include_routine=routine, query=q)
