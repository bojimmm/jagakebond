"""Operator-editable configuration, stored in the database.

.env still provides the initial value for each key; anything saved from the admin
console takes precedence, so an operator can change the router key without shell
access. Secret values are encrypted at rest (see security.encrypt_secret) and are
never returned to a client — only a masked hint (at most the last 2 characters).

Router URL policy (contract 5.8) lives here so that saving a URL and testing it use
ONE validator: scheme http/https; no user:password@, no ?query, no #fragment;
host is loopback (127.0.0.1 / localhost / ::1, any port), or one of the hosts of the
existing probe allowlist, or a host listed in the environment
variable JK_ROUTER_ALLOWED_HOSTS (comma separated, exact host names). The worker
applies the same rule before it sends the key and a photo anywhere.
"""

from __future__ import annotations

import os
from typing import Any
from urllib.parse import urlsplit

from . import db, security

# key -> metadata. `env` is the environment fallback, `default` the last resort.
# `hidden` keeps a key valid for the API but out of the console (nothing reads it, so a
# field for it would be a dead control).
SETTINGS: list[dict[str, Any]] = [
    # --- Router / models -------------------------------------------------
    {"key": "NINEROUTER_URL", "group": "router", "type": "str", "secret": False, "sensitive": True,
     "label": "Alamat router", "env": "NINEROUTER_URL", "default": "http://localhost:20128",
     "help": "Alamat server router AI, tanpa /v1. Contoh: http://localhost:20128. "
             "Hanya localhost atau host yang diizinkan admin server."},
    {"key": "NINEROUTER_KEY", "group": "router", "type": "str", "secret": True,
     "label": "Kunci router", "env": "NINEROUTER_KEY", "default": "",
     "help": "Kunci untuk masuk ke router. Disimpan terenkripsi dan tidak pernah ditampilkan lagi."},
    {"key": "GEMINI_TRIAGE_MODEL", "group": "router", "type": "str", "secret": False,
     "label": "Model triase", "env": "GEMINI_TRIAGE_MODEL", "default": "gemini/gemma-4-26b-a4b-it",
     "help": "Memeriksa apakah foto bisa dianalisis (batas awal 600 token). Rute harus mendukung "
             "gambar dan keluaran JSON. Uji kemampuan sebelum mengganti model."},
    {"key": "GEMINI_DIAGNOSE_MODEL", "group": "router", "type": "str", "secret": False,
     "label": "Model diagnosis", "env": "GEMINI_DIAGNOSE_MODEL", "default": "gemini/gemma-4-31b-it",
     "help": "Menilai bukti foto dan menghasilkan laporan terstruktur (batas awal 4000 token). "
             "Nama rute tidak membuktikan kemampuan gambar, kelengkapan laporan, atau ketepatan diagnosis."},

    # --- Fast tier ---------------------------------------------------------
    # The server selects the fast lane within the account's daily quota, then the paced
    # normal lane. Route names say nothing about measured quality or provider capacity.
    {"key": "GEMINI_TRIAGE_MODEL_FAST", "group": "router", "type": "str", "secret": False,
     "label": "Model triase (analisis cepat)", "env": "GEMINI_TRIAGE_MODEL_FAST",
     "default": "jagakebond-fast",
     "help": "Rute triase untuk jatah harian cepat. Harus mendukung gambar dan JSON; kapasitas bergantung penyedia."},
    {"key": "GEMINI_DIAGNOSE_MODEL_FAST", "group": "router", "type": "str", "secret": False,
     "label": "Model diagnosis (analisis cepat)", "env": "GEMINI_DIAGNOSE_MODEL_FAST",
     "default": "jagakebond-fast",
     "help": "Rute diagnosis untuk jatah harian cepat. Kecepatan dan ketepatan perlu diukur, bukan diasumsikan dari nama rute."},

    # --- Integrations ----------------------------------------------------
    {"key": "GEOCODE_API_KEY", "group": "integrations", "type": "str", "secret": True,
     "label": "Kunci nama tempat (geocoding)", "env": "GEOCODE_API_KEY", "default": "",
     "help": "Kunci geocode.maps.co untuk mengubah GPS jadi nama tempat. Hanya ada di server, tidak masuk APK."},
    # Nothing reads this key any more (the /api/diagnose endpoint is gone). It stays valid for
    # the API and tests but the console no longer offers a field for it.
    {"key": "PLANT_ID_API_KEY", "group": "integrations", "type": "str", "secret": True, "hidden": True,
     "label": "Plant.id API Key", "env": "PLANT_ID_API_KEY", "default": "",
     "help": "Tidak dipakai lagi."},

    # --- Queue / capacity ------------------------------------------------
    {"key": "QUEUE_PACER_SECONDS", "group": "queue", "type": "int", "secret": False,
     "label": "Jeda antar foto (detik)", "env": "QUEUE_PACER_SECONDS", "default": 25, "min": 1, "max": 600,
     "help": "Waktu tunggu worker antar foto supaya tidak melewati batas router."},
    {"key": "QUEUE_STALE_CLAIM_SEC", "group": "queue", "type": "int", "secret": False,
     "label": "Batas macet (detik)", "env": "QUEUE_STALE_CLAIM_SEC", "default": 300, "min": 30, "max": 7200,
     "help": "Foto yang dikerjakan lebih lama dari ini dianggap macet dan masuk antrean lagi."},
    {"key": "QUEUE_MAX_ATTEMPTS", "group": "queue", "type": "int", "secret": False,
     "label": "Percobaan maksimum", "env": "QUEUE_MAX_ATTEMPTS", "default": 3, "min": 1, "max": 10,
     "help": "Berapa kali worker mencoba satu foto sebelum ditolak."},
    {"key": "MAX_UPLOAD_MB", "group": "queue", "type": "int", "secret": False,
     "label": "Batas ukuran foto (MB)", "env": "MAX_UPLOAD_MB", "default": 12, "min": 1, "max": 50},

    # --- Accounts --------------------------------------------------------
    {"key": "ALLOW_REGISTRATION", "group": "accounts", "type": "bool", "secret": False,
     "label": "Pendaftaran terbuka", "env": "ALLOW_REGISTRATION", "default": False,
     "help": "Biarkan mati. Buat akun petani dari tab Akun supaya tidak ada pendaftar liar "
             "yang menghabiskan kuota AI."},
    # Deprecated and unused: the daily limit is fixed by the account role. Hidden from the console.
    {"key": "DEFAULT_DAILY_QUOTA", "group": "accounts", "type": "int", "secret": False, "hidden": True,
     "label": "Kuota lama (tidak dipakai)", "env": "DEFAULT_DAILY_QUOTA", "default": 0, "min": 0, "max": 1000,
     "help": "Tidak memengaruhi batas mode cepat. Batas ditetapkan oleh peran akun."},
]

_SPECS = {item["key"]: item for item in SETTINGS}
_INTERNAL = {"legacy_imported", "admin_bootstrap_done"}

ROUTER_URL_KEY = "NINEROUTER_URL"
_MAX_TEXT = {"NINEROUTER_URL": 200}
_MAX_MODEL = 120
# Routes the worker sends to the router. Any provider or combo name is allowed, so
# these four keys accept non-Gemma/non-Gemini models as well; only the shape is checked.
MODEL_KEYS = ("GEMINI_TRIAGE_MODEL", "GEMINI_DIAGNOSE_MODEL",
              "GEMINI_TRIAGE_MODEL_FAST", "GEMINI_DIAGNOSE_MODEL_FAST")
_MAX_SECRET = 500
_MAX_OTHER = 200


def spec(key: str) -> dict[str, Any] | None:
    return _SPECS.get(key)


def _stored(key: str) -> str | None:
    row = db.query_one("SELECT value FROM settings WHERE key = ?", (key,))
    return row["value"] if row else None


def effective(key: str) -> str:
    """Stored value, else the .env value, else the registry default."""
    stored = _stored(key)
    if stored is not None and stored != "":
        return stored
    meta = spec(key)
    if not meta:
        return ""
    env_name = meta.get("env")
    if env_name and os.environ.get(env_name):
        return os.environ[env_name]
    default = meta.get("default", "")
    return str(default)


def as_str(key: str) -> str:
    return str(effective(key) or "").strip()


def as_int(key: str) -> int:
    meta = spec(key) or {}
    try:
        value = int(str(effective(key)).strip())
    except (TypeError, ValueError):
        value = int(meta.get("default", 0) or 0)
    if "min" in meta:
        value = max(int(meta["min"]), value)
    if "max" in meta:
        value = min(int(meta["max"]), value)
    return value


def as_bool(key: str) -> bool:
    raw = effective(key)
    if isinstance(raw, bool):
        return raw
    return str(raw).strip().lower() in ("1", "true", "yes", "on", "ya")


def secret_value(key: str) -> str:
    """Decrypted plaintext for server-side use only. Never send this to a client.

    Falls back to the environment exactly as `effective()` does. Without this, a
    minimal install that only sets NINEROUTER_KEY in .env left the worker with no
    key at all: it refused to claim, and every job sat at "Menunggu giliran"
    forever with nothing in the console to explain why.
    """
    stored = _stored(key)
    if stored:
        return security.decrypt_secret(stored)
    meta = spec(key)
    env_name = meta.get("env") if meta else None
    if env_name and os.environ.get(env_name):
        return os.environ[env_name]
    return ""


def is_set(key: str) -> bool:
    meta = spec(key)
    if meta and meta.get("secret"):
        if _stored(key):
            return True
        env_name = meta.get("env")
        return bool(env_name and os.environ.get(env_name))
    return bool(str(effective(key)).strip())


# ---------------------------------------------------------------------------
# Router URL policy (contract 5.8) — ONE validator for "save" and "test"
# ---------------------------------------------------------------------------

ROUTER_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})
# The hosts of the existing outbound probe allowlist (api_app._TELEMETRY_HOSTS), exactly as
# gemini_worker.ROUTER_PROBE_HOSTS lists them.
_PROBE_HOSTS_FALLBACK = frozenset({"api.open-meteo.com", "geocoding-api.open-meteo.com", "geocode.maps.co"})


def router_extra_hosts() -> frozenset[str]:
    """Exact host names the operator allowed through JK_ROUTER_ALLOWED_HOSTS."""
    raw = os.environ.get("JK_ROUTER_ALLOWED_HOSTS", "") or ""
    return frozenset(part.strip().lower().rstrip(".") for part in raw.split(",") if part.strip())


def _probe_hosts() -> frozenset[str]:
    # A literal copy on purpose: it must stay identical to gemini_worker.ROUTER_PROBE_HOSTS, so a URL that
    # saves here is never refused by the worker (and vice versa) if api_app's list grows later.
    return _PROBE_HOSTS_FALLBACK


def router_url_check(url: Any) -> tuple[str | None, str | None]:
    """Returns (canonical base URL, None) when allowed, else (None, Bahasa reason)."""
    text = "" if url is None else str(url).strip()
    if not text:
        return None, "Alamat router tidak boleh kosong."
    if len(text) > _MAX_TEXT[ROUTER_URL_KEY] or any(ch.isspace() or ord(ch) < 32 or ord(ch) == 127 for ch in text):
        return None, "Alamat router tidak valid (jangan pakai spasi atau karakter aneh)."
    try:
        parsed = urlsplit(text)
        port = parsed.port
    except ValueError:
        return None, "Alamat router tidak valid. Contoh: http://localhost:20128"
    scheme = (parsed.scheme or "").lower()
    if scheme not in ("http", "https"):
        return None, "Alamat router harus diawali http:// atau https://"
    if parsed.username is not None or parsed.password is not None or "@" in (parsed.netloc or ""):
        return None, "Alamat router tidak boleh memuat nama pengguna atau sandi (user:sandi@)."
    if "?" in text or "#" in text:
        return None, "Alamat router tidak boleh memuat tanda ? atau #."
    host = (parsed.hostname or "").lower().rstrip(".")
    if not host:
        return None, "Alamat router tidak valid: nama host kosong."
    # Same rule as the worker (gemini_worker.router_url_problem): any path is allowed, and the probe hosts
    # are accepted on any scheme/port. Loopback and JK_ROUTER_ALLOWED_HOSTS hosts likewise.
    allowed = host in ROUTER_LOOPBACK_HOSTS or host in _probe_hosts() or host in router_extra_hosts()
    if not allowed:
        return None, (f"Host router '{host}' tidak diizinkan. Pakai localhost, atau minta admin server "
                      "menambahkan host itu ke JK_ROUTER_ALLOWED_HOSTS.")
    shown = f"[{host}]" if ":" in host else host
    path = (parsed.path or "").rstrip("/")
    return f"{scheme}://{shown}" + (f":{port}" if port else "") + path, None


def router_url_problem(url: Any) -> str | None:
    return router_url_check(url)[1]


def canonical_router_url(url: Any) -> str:
    clean, problem = router_url_check(url)
    if problem or clean is None:
        raise ValueError(problem or "Alamat router tidak valid.")
    return clean


# ---------------------------------------------------------------------------
# What the console may see
# ---------------------------------------------------------------------------


def _secret_hint(plain: str) -> str:
    """Masked hint: never more than the last 2 characters, and nothing for short keys."""
    if not plain:
        return ""
    if len(plain) < 12:
        return "••••"
    return "••••" + plain[-2:]


def public_settings() -> list[dict[str, Any]]:
    """Everything the console may see: never a secret value, only a hint."""
    out: list[dict[str, Any]] = []
    for meta in SETTINGS:
        if meta.get("hidden"):
            continue
        key = meta["key"]
        stored = _stored(key)
        entry = {
            "key": key,
            "group": meta["group"],
            "label": meta.get("label", key),
            "help": meta.get("help", ""),
            "type": meta.get("type", "str"),
            "isSecret": bool(meta.get("secret")),
            "isSet": is_set(key),
            "hasStored": bool(stored),
            "hasEnvFallback": bool(meta.get("env") and os.environ.get(meta["env"])),
            "sensitive": bool(meta.get("sensitive") or meta.get("secret")),
        }
        if "min" in meta:
            entry["min"] = meta["min"]
        if "max" in meta:
            entry["max"] = meta["max"]
        if meta.get("secret"):
            plain = secret_value(key)
            entry["value"] = ""
            entry["hint"] = _secret_hint(plain) if plain else ""
            entry["broken"] = security.decrypt_failed(stored)
        else:
            entry["value"] = effective(key)
        out.append(entry)
    return out


def _control_chars(text: str) -> bool:
    return any(ord(ch) < 32 or ord(ch) == 127 for ch in text)


def _validate(updates: dict[str, Any]) -> tuple[dict[str, str], list[str], bool]:
    """Returns (clean values, errors, url_policy_violation)."""
    clean: dict[str, str] = {}
    errors: list[str] = []
    policy = False
    for key, raw in updates.items():
        meta = spec(key)
        if not meta:
            errors.append(f"Pengaturan tidak dikenal: {key}")
            continue
        kind = meta.get("type", "str")
        if kind == "int":
            try:
                value = int(str(raw).strip())
            except (TypeError, ValueError):
                errors.append(f"{meta['label']}: harus berupa angka")
                continue
            if "min" in meta and value < meta["min"]:
                errors.append(f"{meta['label']}: minimal {meta['min']}")
                continue
            if "max" in meta and value > meta["max"]:
                errors.append(f"{meta['label']}: maksimal {meta['max']}")
                continue
            clean[key] = str(value)
        elif kind == "bool":
            clean[key] = "1" if str(raw).strip().lower() in ("1", "true", "yes", "on", "ya") else "0"
        else:
            text = "" if raw is None else str(raw).strip()
            if key == ROUTER_URL_KEY and text:
                canonical, problem = router_url_check(text)
                if problem:
                    errors.append(problem)
                    policy = True
                    continue
                text = canonical or text
            elif _control_chars(text):
                errors.append(f"{meta['label']}: tidak boleh memuat baris baru atau karakter kontrol")
                continue
            limit = _MAX_SECRET if meta.get("secret") else (
                _MAX_MODEL if "MODEL" in key else _MAX_TEXT.get(key, _MAX_OTHER))
            if len(text) > limit:
                errors.append(f"{meta['label']}: terlalu panjang (maksimal {limit} karakter)")
                continue
            if meta.get("secret") and any(ch.isspace() for ch in text):
                errors.append(f"{meta['label']}: tidak boleh ada spasi. Tempel kuncinya saja, "
                              "tanpa kata 'Bearer'.")
                continue
            # Any router route is allowed, including non-Gemma/non-Gemini models such as
            # gemma-*-local combos, openai/gpt-4o-mini or a plain combo name. Only the shape is
            # checked so a pasted sentence or two concatenated names cannot be saved silently.
            if key in MODEL_KEYS and text and any(ch.isspace() for ch in text):
                errors.append(f"{meta['label']}: tulis satu nama rute tanpa spasi, misalnya "
                              "gemini/gemma-4-31b-it atau openai/gpt-4o-mini.")
                continue
            clean[key] = text
    return clean, errors, policy


def validate(updates: dict[str, Any]) -> tuple[dict[str, str], list[str]]:
    """Returns (clean values, errors)."""
    clean, errors, _policy = _validate(updates)
    return clean, errors


def validate_full(updates: dict[str, Any]) -> tuple[dict[str, str], list[str], bool]:
    """Like validate(), plus True when an error is a router URL policy violation (HTTP 422)."""
    return _validate(updates)


def sensitive_changes(clean: dict[str, str]) -> list[str]:
    """Keys in an already validated update that need the admin's password again.

    A new router address (different from the one in force) or any non-empty secret.
    A blank secret never reaches this point: the console cannot echo a key, so blank
    means "leave it alone".
    """
    keys: list[str] = []
    for key, value in clean.items():
        meta = spec(key) or {}
        if meta.get("secret"):
            if value != "":
                keys.append(key)
        elif key == ROUTER_URL_KEY:
            try:
                same = canonical_router_url(effective(key)) == value
            except ValueError:
                same = False
            if not same:
                keys.append(key)
    return keys


def _describe(meta: dict[str, Any], value: Any) -> str:
    if meta.get("type") == "bool":
        return "ya" if str(value).strip().lower() in ("1", "true", "yes", "on", "ya") else "tidak"
    text = "" if value is None else str(value)
    return text if len(text) <= 120 else text[:117] + "..."


def update_settings(updates: dict[str, Any], actor: str, actor_id: str | None = None) -> dict[str, Any]:
    clean, errors, policy = _validate(updates)
    if errors:
        return {"ok": False, "errors": errors, "applied": [], "policy": policy}

    applied: list[str] = []
    changes: list[str] = []
    with db.transaction() as tx:
        for key, value in clean.items():
            meta = spec(key) or {}
            old = effective(key)
            stored = security.encrypt_secret(value) if meta.get("secret") else value
            tx.execute(
                "INSERT OR REPLACE INTO settings (key, value, is_secret, updated_ms, updated_by) "
                "VALUES (?,?,?,?,?)",
                (key, stored, 1 if meta.get("secret") else 0, db.now_ms(), actor),
            )
            applied.append(key)
            if meta.get("secret"):
                # Key names only: the audit log must never hold a secret, old or new.
                changes.append(f"{key}: diganti (nilai tidak dicatat)")
            elif str(old) != str(value):
                label = meta.get("label", key)
                changes.append(f"{label}: {_describe(meta, old)} -> {_describe(meta, value)}")
        if changes:
            audit_tx(tx, "setting.update", ",".join(applied), "; ".join(changes), actor, actor_id)
    return {"ok": True, "errors": [], "applied": applied, "changes": changes, "policy": False}


def clear_secret(key: str, actor: str, actor_id: str | None = None) -> dict[str, Any]:
    """Remove the key stored in the console. A value in .env, if any, stays in force."""
    meta = spec(key)
    if not meta or not meta.get("secret"):
        return {"ok": False, "error": "Bukan pengaturan rahasia"}
    env_name = meta.get("env")
    env_in_force = bool(env_name and os.environ.get(env_name))
    with db.transaction() as tx:
        row = tx.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        had = bool(row and row["value"])
        tx.execute("DELETE FROM settings WHERE key = ?", (key,))
        audit_tx(tx, "setting.clear", key,
                 "kunci dihapus dari konsol" + ("; nilai di .env tetap dipakai" if env_in_force else ""),
                 actor, actor_id)
    return {"ok": True, "cleared": had, "envFallback": env_in_force}


# ---------------------------------------------------------------------------
# Audit log
# ---------------------------------------------------------------------------

# Written on every sign-in/out. Hidden in the console unless the operator asks.
AUDIT_ROUTINE_ACTIONS = ("account.login", "account.logout")


def _clip(value: Any, limit: int) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text if len(text) <= limit else text[: limit - 3] + "..."


def audit_tx(tx: Any, action: str, target: str | None, detail: str | None,
             actor_email: str | None = None, actor_id: str | None = None) -> None:
    """Write an audit row inside a transaction the caller already holds."""
    tx.execute(
        "INSERT INTO audit_log (ts_ms, account_id, actor_email, action, target, detail) "
        "VALUES (?,?,?,?,?,?)",
        (db.now_ms(), actor_id, actor_email, _clip(action, 80), _clip(target, 300), _clip(detail, 1200)),
    )


def audit(action: str, target: str | None, detail: str | None,
          actor_email: str | None = None, actor_id: str | None = None) -> None:
    with db.transaction() as tx:
        audit_tx(tx, action, target, detail, actor_email, actor_id)


def recent_audit(limit: int = 200) -> list[dict[str, Any]]:
    rows = db.query(
        "SELECT ts_ms, actor_email, action, target, detail FROM audit_log "
        "ORDER BY ts_ms DESC LIMIT ?",
        (limit,),
    )
    return [
        {"tsMs": row["ts_ms"], "actor": row["actor_email"], "action": row["action"],
         "target": row["target"], "detail": row["detail"]}
        for row in rows
    ]


def _escape_like(text: str) -> str:
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _like(text: str) -> str:
    return "%" + _escape_like(text) + "%"


def audit_page(limit: int = 50, before: int | None = None, action: str | None = None,
               include_routine: bool = False, query: str | None = None) -> dict[str, Any]:
    """One page of the audit log, newest first. `next` is the cursor for the following page.

    `action` is an exact action name, or a prefix ending in `*` (for example `account.*`).
    Routine sign-in/out rows are left out unless asked for, or unless they are the filter.
    """
    limit = max(1, min(int(limit or 50), 200))
    where: list[str] = []
    params: list[Any] = []
    if before:
        where.append("id < ?")
        params.append(int(before))
    action = (action or "").strip()
    if action.endswith("*") and len(action) > 1:
        where.append("action LIKE ? ESCAPE '\\'")
        params.append(_escape_like(action[:-1]) + "%")
    elif action:
        where.append("action = ?")
        params.append(action)
    if not include_routine and action not in AUDIT_ROUTINE_ACTIONS:
        where.append("action NOT IN (%s)" % ",".join("?" * len(AUDIT_ROUTINE_ACTIONS)))
        params.extend(AUDIT_ROUTINE_ACTIONS)
    query = (query or "").strip()
    if query:
        pattern = _like(query[:80])
        where.append("(COALESCE(actor_email,'') LIKE ? ESCAPE '\\' OR COALESCE(target,'') LIKE ? ESCAPE '\\' "
                     "OR COALESCE(detail,'') LIKE ? ESCAPE '\\' OR action LIKE ? ESCAPE '\\')")
        params.extend([pattern, pattern, pattern, pattern])
    sql = "SELECT id, ts_ms, actor_email, action, target, detail FROM audit_log"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY id DESC LIMIT ?"
    params.append(limit + 1)
    rows = db.query(sql, params)
    more = len(rows) > limit
    rows = rows[:limit]
    items = [
        {"id": row["id"], "tsMs": row["ts_ms"], "actor": row["actor_email"], "action": row["action"],
         "target": row["target"], "detail": row["detail"]}
        for row in rows
    ]
    return {"items": items, "next": rows[-1]["id"] if more and rows else None}


def internal_set(key: str, value: str) -> None:
    with db.transaction() as tx:
        tx.execute("INSERT OR REPLACE INTO settings (key, value, is_secret, updated_ms) "
                   "VALUES (?,?,0,?)", (key, value, db.now_ms()))


def internal_get(key: str) -> str | None:
    row = db.query_one("SELECT value FROM settings WHERE key = ?", (key,))
    return row["value"] if row else None
