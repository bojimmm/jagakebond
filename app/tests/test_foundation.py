"""Offline tests for the data/security foundation (no server, no AI models).

Run:  python tests/test_foundation.py

Uses a throwaway SQLite file so it never touches the live database.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))

from backend import db, security, settings_store  # noqa: E402
from backend import auth  # noqa: E402

TEST_DB = BASE / "data" / "test_foundation.sqlite3"
for suffix in ("", "-wal", "-shm"):
    Path(str(TEST_DB) + suffix).unlink(missing_ok=True)
db.DB_PATH = TEST_DB
db.close_all()

CASES: list[tuple[str, bool, str]] = []


def case(name: str, ok: bool, detail: object = "") -> None:
    CASES.append((name, bool(ok), str(detail)))


# --------------------------------------------------------------------------
print("--- migrations ---")
version = db.migrate()
case("migrate() returns the current schema version", version == db.SCHEMA_VERSION, version)
case("migrate() is idempotent", db.migrate() == db.SCHEMA_VERSION)
tables = {row["name"] for row in db.query("SELECT name FROM sqlite_master WHERE type='table'")}
expected = {"accounts", "sessions", "login_attempts", "settings", "audit_log", "records",
            "daily", "farms", "jobs", "job_events", "photos", "schema_version"}
case("all tables created", expected.issubset(tables), sorted(expected - tables) or "ok")
case("WAL journal mode active", db.query_one("PRAGMA journal_mode")["journal_mode"].lower() == "wal")
case("foreign keys enforced", db.query_one("PRAGMA foreign_keys")["foreign_keys"] == 1)

print("--- password hashing ---")
h = security.hash_password("SandiRahasia123")
# 0.2.2.0: N=2^14, r=8, p=5 (same ~16 MiB of memory as the old p=1, five times the CPU).
case("hash is scrypt with params", h.startswith("scrypt$16384$8$5$"), h[:22])
case("correct password verifies", security.verify_password("SandiRahasia123", h))
# Hashes written before 0.2.2.0 (p=1) must keep verifying, and be flagged for an upgrade.
_legacy_salt = b"legacy-salt-0123"
_legacy = "scrypt$16384$8$1${}${}".format(
    security.b64e(_legacy_salt),
    security.b64e(__import__("hashlib").scrypt(b"SandiRahasia123", salt=_legacy_salt,
                                                n=2 ** 14, r=8, p=1, dklen=32)))
case("an old p=1 hash still verifies", security.verify_password("SandiRahasia123", _legacy))
case("an old p=1 hash rejects a wrong password", not security.verify_password("salah", _legacy))
case("an old hash is flagged for rehash and a current one is not",
     security.needs_rehash(_legacy) and not security.needs_rehash(h))
case("wrong password rejected", not security.verify_password("salah", h))
case("same password gives different hashes (salted)",
     security.hash_password("x" * 12) != security.hash_password("x" * 12))
case("garbage hash rejected safely", not security.verify_password("x", "not-a-hash"))
# The dummy hash is verified against on every login with an unknown email, to keep
# the response time independent of whether the account exists. If it were malformed
# the unknown-email path would raise instead of returning a clean 401.
case("the login-timing dummy hash is well formed",
     security.DUMMY_PASSWORD_HASH.startswith("scrypt$16384$8$5$"),
     security.DUMMY_PASSWORD_HASH[:22])
case("the dummy hash costs the same as a real one (no rehash flag)",
     not security.needs_rehash(security.DUMMY_PASSWORD_HASH))
case("no password verifies against the dummy hash",
     not security.verify_password("", security.DUMMY_PASSWORD_HASH)
     and not security.verify_password("SandiRahasia123", security.DUMMY_PASSWORD_HASH))
case("short password rejected", security.password_problem("abc") is not None)
case("good password accepted", security.password_problem("Delapan123") is None)

print("--- accounts ---")
account = auth.create_account("petani@example.com", "SandiRahasia123", "Pak Tani")
case("account created with acct_ id", account["id"].startswith("acct_"), account["id"])
case("role defaults to user", account["role"] == "user")
case("email lookup is case-insensitive",
     auth.find_by_email("PETANI@example.com")["id"] == account["id"])
duplicate_blocked = False
try:
    auth.create_account("petani@example.com", "SandiRahasia123")
except Exception as exc:  # noqa: BLE001
    duplicate_blocked = getattr(exc, "status_code", None) == 409
case("duplicate email rejected (409)", duplicate_blocked)
bad_email_blocked = False
try:
    auth.create_account("bukan-email", "SandiRahasia123")
except Exception as exc:  # noqa: BLE001
    bad_email_blocked = getattr(exc, "status_code", None) == 400
case("invalid email rejected (400)", bad_email_blocked)

print("--- sessions ---")
token = security.session_create(account["id"], "pytest-agent", "127.0.0.1")
case("session resolves to its account", (security.session_account(token) or {}).get("id") == account["id"])
case("unknown token resolves to nothing", security.session_account("nope") is None)
case("token stored only as a hash",
     db.query_one("SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?", (token,))["n"] == 0)
second = security.session_create(account["id"], "other", "10.0.0.2")
case("two sessions coexist", security.session_count(account["id"]) == 2, security.session_count(account["id"]))
security.session_delete_for_account(account["id"], keep_token=token)
case("revoke-others keeps the current session", security.session_account(token) is not None)
case("revoke-others drops the other session", security.session_account(second) is None)
security.session_delete(token)
case("logout invalidates the session", security.session_account(token) is None)

print("--- csrf ---")
c = security.csrf_token()
case("csrf matches itself", security.csrf_ok(c, c))
case("csrf mismatch rejected", not security.csrf_ok(c, "other"))
case("csrf missing rejected", not security.csrf_ok(None, c) and not security.csrf_ok(c, None))

print("--- login throttling ---")
security.login_reset("9.9.9.9", "throttle@example.com")
case("starts unlocked", security.login_locked_for_ms("9.9.9.9", "throttle@example.com") == 0)
for _ in range(security.THRESHOLDS["acct"][0]):
    security.login_record_failure("9.9.9.9", "throttle@example.com")
case("account/email pair locks after 5 failures",
     security.login_locked_for_ms("9.9.9.9", "throttle@example.com") > 0)
case("known email is not locked from another IP",
     security.login_locked_for_ms("9.9.9.8", "throttle@example.com") == 0)
case("a shared IP is NOT locked by 5 failures (village NAT / carrier CGNAT)",
     security.login_locked_for_ms("9.9.9.9", None) == 0)
for _ in range(security.THRESHOLDS["ip"][0]):
    security.login_record_failure("9.9.9.9", None)
case("the IP locks only at its much higher threshold",
     security.login_locked_for_ms("9.9.9.9", None) > 0)
case("other IPs are unaffected", security.login_locked_for_ms("8.8.8.8", None) == 0)
case("other accounts are unaffected", security.login_locked_for_ms(None, "someone@example.com") == 0)
# A successful login clears ONLY the IP+email pair (0.2.2.0). It used to clear the per-IP
# counter as well, which let an attacker holding one valid account refund their own IP's
# budget with a good login between batches of guesses. The IP stays locked here.
security.login_reset("9.9.9.9", "throttle@example.com")
_pair_rows = db.query_one("SELECT COUNT(*) AS n FROM login_attempts WHERE key = ?",
                          (security._pair_key("9.9.9.9", "throttle@example.com"),))["n"]
case("reset clears the IP+email pair key", _pair_rows == 0, _pair_rows)
case("reset does NOT clear the per-IP counter", security.login_locked_for_ms("9.9.9.9", None) > 0)

print("--- secret box ---")
os.environ["SECRET_KEY"] = "unit-test-secret-key-material"
security._secret_key_cache = None
case("encryption reports available", security.encryption_available(), security.encryption_status())
sealed = security.encrypt_secret("super-secret-router-key")
case("secret is stored with enc:v1 prefix", sealed.startswith("enc:v1:"), sealed[:18])
case("plaintext is not present in the stored form", "super-secret-router-key" not in sealed)
case("secret round-trips", security.decrypt_secret(sealed) == "super-secret-router-key")
case("masked hint shows only the tail", security.secret_hint("super-secret-router-key") == "••••-key")
os.environ["SECRET_KEY"] = "a-different-key-entirely"
security._secret_key_cache = None
case("wrong SECRET_KEY fails safe to empty string", security.decrypt_secret(sealed) == "")
case("wrong key is detectable as broken", security.decrypt_failed(sealed))
os.environ["SECRET_KEY"] = "unit-test-secret-key-material"
security._secret_key_cache = None
case("original key still decrypts", security.decrypt_secret(sealed) == "super-secret-router-key")
case("unencrypted legacy value passes through", security.decrypt_secret("plain-old-value") == "plain-old-value")

print("--- worker token ---")
os.environ["WORKER_TOKEN"] = "worker-token-abc"
case("matching worker token accepted", security.worker_ok("worker-token-abc"))
case("wrong worker token rejected", not security.worker_ok("nope"))
case("empty worker token rejected", not security.worker_ok(""))

print("--- settings store ---")
items = settings_store.public_settings()
case("settings registry is exposed", len(items) >= 10, len(items))
case("secret settings expose no value",
     all(item["value"] == "" for item in items if item["isSecret"]))
defaults = {item["key"]: item for item in items}
case("triage model default is the direct gemini route",
     defaults["GEMINI_TRIAGE_MODEL"]["value"] == "gemini/gemma-4-26b-a4b-it",
     defaults["GEMINI_TRIAGE_MODEL"]["value"])

# Regression: secret_value() read only the settings table while effective() fell
# back to the environment, so a minimal install that set NINEROUTER_KEY in .env
# handed the worker an empty key. The worker then refused to claim anything and
# every job sat at "Menunggu giliran" forever, with nothing in the console
# explaining why. A secret that is only in .env must reach both readers.
env_probe = "PLANT_ID_API_KEY"
probe_spec = settings_store.spec(env_probe)
case("the env-fallback probe setting exists, is secret and has an env name",
     bool(probe_spec and probe_spec.get("secret") and probe_spec.get("env")),
     probe_spec.get("env") if probe_spec else None)
if probe_spec and not settings_store._stored(env_probe):
    env_name = probe_spec["env"]
    previous = os.environ.get(env_name)
    os.environ[env_name] = "env-only-value"
    case("secret_value() falls back to .env",
         settings_store.secret_value(env_probe) == "env-only-value",
         repr(settings_store.secret_value(env_probe)))
    case("is_set() reports an env-only secret as set",
         settings_store.is_set(env_probe) is True)
    case("effective() and secret_value() agree on the same key",
         settings_store.effective(env_probe) == settings_store.secret_value(env_probe))
    if previous is None:
        del os.environ[env_name]
    else:
        os.environ[env_name] = previous
    case("restoring the environment restores the reported value",
         settings_store.secret_value(env_probe) == (previous or ""),
         repr(settings_store.secret_value(env_probe)))
case("unknown key is rejected", settings_store.validate({"NOPE": "1"})[1] != [])
clean, errors = settings_store.validate({"QUEUE_PACER_SECONDS": "abc"})
case("non-numeric int rejected", errors != [], errors)
clean, errors = settings_store.validate({"QUEUE_PACER_SECONDS": "9999"})
case("out-of-range int rejected", errors != [], errors)
clean, errors = settings_store.validate({"QUEUE_PACER_SECONDS": "30"})
case("valid int accepted", clean.get("QUEUE_PACER_SECONDS") == "30" and not errors)
clean, errors = settings_store.validate({"NINEROUTER_URL": "localhost:20128"})
case("URL without scheme rejected", errors != [], errors)
clean, errors = settings_store.validate({"GEMINI_TRIAGE_MODEL": "gemma-4-26b-a4b-local"})
case("a non-Gemma route name is accepted", not errors and clean.get("GEMINI_TRIAGE_MODEL") == "gemma-4-26b-a4b-local", errors)
clean, errors = settings_store.validate({"GEMINI_TRIAGE_MODEL": "openai/gpt-4o-mini"})
case("a provider/model route is accepted", not errors and clean.get("GEMINI_TRIAGE_MODEL") == "openai/gpt-4o-mini", errors)
clean, errors = settings_store.validate({"GEMINI_TRIAGE_MODEL": "two words"})
case("a route containing spaces is rejected", errors != [], errors)
clean, errors = settings_store.validate({"GEMINI_TRIAGE_MODEL": "gemini/gemma-4-26b-a4b-it"})
case("direct gemini route accepted", not errors and clean.get("GEMINI_TRIAGE_MODEL"))

result = settings_store.update_settings({"NINEROUTER_KEY": "router-key-xyz",
                                         "QUEUE_PACER_SECONDS": "40"}, "admin@test", account["id"])
case("update_settings reports success", result["ok"] and "NINEROUTER_KEY" in result["applied"], result)
raw = db.query_one("SELECT value, is_secret FROM settings WHERE key = 'NINEROUTER_KEY'")
case("router key stored encrypted (no plaintext in DB)", "router-key-xyz" not in (raw["value"] or ""))
case("router key flagged secret", raw["is_secret"] == 1)
case("secret_value() decrypts for server use", settings_store.secret_value("NINEROUTER_KEY") == "router-key-xyz")
public = {item["key"]: item for item in settings_store.public_settings()}
case("console sees only a hint, never the key",
     public["NINEROUTER_KEY"]["value"] == "" and public["NINEROUTER_KEY"]["hint"].endswith("yz")
     and not public["NINEROUTER_KEY"]["hint"].endswith("-xyz"),   # 0.2.2.0: at most the last 2 characters
     public["NINEROUTER_KEY"]["hint"])
case("non-secret setting read back", settings_store.as_int("QUEUE_PACER_SECONDS") == 40)
case("bool setting parses", settings_store.as_bool("ALLOW_REGISTRATION") in (True, False))
case("audit rows were written", len(settings_store.recent_audit(10)) >= 2)
failed = settings_store.update_settings({"NINEROUTER_KEY": "x", "BOGUS": "1"}, "admin@test")
case("one bad key rejects the whole update", not failed["ok"], failed["errors"])

print("--- seeds + legacy import ---")
counts = db.seed_for_account(account["id"])
case("seeds insert 4/1/2", counts == {"records": 4, "daily": 1, "farms": 2}, counts)
rows = db.query("SELECT * FROM records WHERE account_id = ? ORDER BY timestamp_ms DESC", (account["id"],))
case("seed records are account-scoped", len(rows) == 4, len(rows))
case("row_record marshals to the API shape",
     set(db.row_record(rows[0])) >= {"id", "crop", "severity", "immediate_action", "needs_review"})
daily = db.query("SELECT * FROM daily WHERE account_id = ?", (account["id"],))
case("daily json fields decode to lists", isinstance(db.row_daily(daily[0])["actions"], list))
farms = db.query("SELECT * FROM farms WHERE account_id = ?", (account["id"],))
case("farm ring decodes and is closed",
     db.row_farm(farms[0])["ring"][0] == db.row_farm(farms[0])["ring"][-1])

first = db.import_legacy_json(account["id"])
case("legacy import runs once", first is None or isinstance(first, dict), first)
second = db.import_legacy_json(account["id"])
case("second legacy import is a no-op", second is None, second)

print("--- cascade delete ---")
with db.transaction() as tx:
    tx.execute("DELETE FROM accounts WHERE id = ?", (account["id"],))
case("deleting an account removes its records",
     db.query_one("SELECT COUNT(*) AS n FROM records WHERE account_id = ?", (account["id"],))["n"] == 0)
case("deleting an account removes its sessions",
     db.query_one("SELECT COUNT(*) AS n FROM sessions WHERE account_id = ?", (account["id"],))["n"] == 0)

db.close_all()
for suffix in ("", "-wal", "-shm"):
    Path(str(TEST_DB) + suffix).unlink(missing_ok=True)

passed = sum(1 for _, ok, _ in CASES if ok)
total = len(CASES)
print()
print(f"foundation: {passed}/{total} assertions passed")
for name, ok, detail in CASES:
    if not ok:
        print("  FAILED:", name, "::", detail)
sys.exit(0 if passed == total else 1)
