"""Photo lifecycle 0.2.2.0: durable cleanup tickets, drainer, crash-safe publication.

Run from app/:  python tests/test_photo_lifecycle_0220.py        (needs $TMPDIR, Linux)

Synthetic fixtures only: every scenario gets its own temporary data directory and
database; nothing outside it is touched (a sentinel file next to the uploads
directory proves that). Real process death is exercised with subprocesses that
call os._exit(73) at named fault points inside backend/storage.py.
"""
from __future__ import annotations

import errno
import json
import os
import stat
import subprocess
import sys
import tempfile
import time
from io import BytesIO
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))
THIS = Path(__file__).resolve()

from PIL import Image  # noqa: E402

from backend import db, storage  # noqa: E402


def jpeg(color=(30, 140, 60), size=(40, 30)) -> bytes:
    buffer = BytesIO()
    Image.new("RGB", size, color).save(buffer, "JPEG", quality=70)
    return buffer.getvalue()


# ---------------------------------------------------------------------------
# Child processes (real process death). Runs before the heavy imports below.
# ---------------------------------------------------------------------------


def child_main(argv: list[str]) -> None:
    mode, root, rest = argv[0], Path(argv[1]), argv[2:]
    db.close_all()
    db.DB_PATH = root / "fixture.sqlite3"
    storage._UPLOAD_DIR_OVERRIDE = root / "uploads"

    def die_at(point: str) -> None:
        def hook(name: str) -> None:
            if name == point:
                os._exit(73)
        storage._FAULT_HOOK = hook

    if mode == "drain":
        point, wait = rest[0], float(rest[1])
        if point != "none":
            die_at(point)
        print(json.dumps(storage.drain(100, lock_timeout=wait)))
    elif mode == "drain-loop":
        done = 0
        while True:
            result = storage.drain(7, lock_timeout=60)
            done += result["done"]
            if result["pending"] == 0:
                break
        print(json.dumps({"done": done}))
    elif mode == "publish":
        point, account, photo_id = rest[:3]
        if point != "none":
            die_at(point)
        print(storage.publish_photo(jpeg(), account, photo_id))
    elif mode == "delete-account":
        account, crash = rest[:2]
        with storage.storage_lock():
            with db.transaction() as tx:
                storage.retire_account_objects(tx, account)
                tx.execute("DELETE FROM accounts WHERE id = ?", (account,))
                if crash == "before_commit":
                    os._exit(73)
        if crash == "after_commit":
            os._exit(73)
    elif mode == "hold-lock":
        seconds, ready = float(rest[0]), Path(rest[1])
        with storage.storage_lock():
            ready.write_text("ready")
            time.sleep(seconds)
    else:
        raise SystemExit("unknown child mode " + mode)


if len(sys.argv) > 1 and sys.argv[1] == "--child":
    child_main(sys.argv[2:])
    raise SystemExit(0)

import importlib.util  # noqa: E402
import threading  # noqa: E402
import traceback  # noqa: E402
from types import SimpleNamespace  # noqa: E402
from unittest import mock  # noqa: E402

from fastapi import HTTPException  # noqa: E402

from backend import api_app  # noqa: E402

RESULTS: list[tuple[str, bool]] = []


def check(label: str, condition, detail="") -> None:
    ok = bool(condition)
    RESULTS.append((label, ok))
    print(("PASS " if ok else "FAIL ") + label + ("" if ok or detail == "" else f"   <- {detail}"), flush=True)


class Sandbox:
    """One temporary data directory + database. Re-points db/api_app/storage at it."""

    def __init__(self, name: str, migrate: bool = True) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix=f"jk-photo-{name}-", dir=os.environ.get("TMPDIR"))
        self.root = Path(self.tmp.name)
        self.uploads = self.root / "uploads"
        self.uploads.mkdir()
        db.close_all()
        db.DB_PATH = self.root / "fixture.sqlite3"
        api_app.UPLOAD_DIR = self.uploads
        storage._UPLOAD_DIR_OVERRIDE = None
        storage._FAULT_HOOK = None
        storage._last_drain_ms = None
        if migrate:
            db.migrate()

    def close(self) -> None:
        storage._FAULT_HOOK = None
        db.close_all()
        self.tmp.cleanup()

    # -- fixtures ---------------------------------------------------------
    def account(self, ident: str, role: str = "user", active: int = 1) -> None:
        now = db.now_ms()
        with db.transaction() as tx:
            tx.execute("INSERT INTO accounts(id,email,password_hash,role,is_active,created_ms,updated_ms) VALUES(?,?,?,?,?,?,?)",
                       (ident, ident + "@fixture.invalid", "synthetic", role, active, now, now))

    def publish(self, account: str, photo_id: str, color=(30, 140, 60)) -> str:
        storage.publish_photo(jpeg(color), account, photo_id)
        return db.query_one("SELECT file_name FROM photos WHERE id=?", (photo_id,))["file_name"]

    def legacy_photo(self, account: str, photo_id: str, name: str, data: bytes | None = b"legacy bytes", file: bool = True) -> None:
        """A pre-0.2.2.0 photo: row + file, no registry entry."""
        with db.transaction() as tx:
            tx.execute("INSERT INTO photos(id,account_id,file_name,bytes,created_ms) VALUES(?,?,?,?,?)",
                       (photo_id, account, name, len(data or b""), db.now_ms()))
        if file and "/" not in name:
            (self.uploads / name).write_bytes(data or b"")

    def record(self, rec_id: str, account: str, image_url) -> None:
        now = db.now_ms()
        with db.transaction() as tx:
            tx.execute("INSERT INTO records(id,account_id,image_url,created_ms,updated_ms) VALUES(?,?,?,?,?)",
                       (rec_id, account, image_url, now, now))

    def delete_account(self, ident: str) -> dict:
        """Exactly the sequence api_admin follows (contract 5.5)."""
        with storage.storage_lock():
            with db.transaction() as tx:
                summary = storage.retire_account_objects(tx, ident)
                tx.execute("DELETE FROM accounts WHERE id = ?", (ident,))
        return summary

    # -- observation ------------------------------------------------------
    def files(self) -> list[str]:
        return sorted(p.name for p in self.uploads.iterdir())

    def tickets(self, where: str = "1=1", *params) -> list[dict]:
        return db.query(f"SELECT * FROM photo_cleanup WHERE {where} ORDER BY created_ms, id", params)

    def registry(self, name: str):
        return db.query_one("SELECT * FROM storage_objects WHERE name=?", (name,))

    def photo(self, photo_id: str):
        return db.query_one("SELECT * FROM photos WHERE id=?", (photo_id,))

    def staging(self) -> list[str]:
        staging = storage.staging_dir()
        return sorted(p.name for p in staging.iterdir()) if staging.exists() else []

    def child(self, mode: str, *args, timeout: int = 120) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, str(THIS), "--child", mode, str(self.root), *args],
                              capture_output=True, text=True, timeout=timeout,
                              env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})


def account_ctx(ident: str, role: str = "user") -> dict:
    return {"id": ident, "role": role}


# ---------------------------------------------------------------------------
# 1. Migration from a schema-8 database with existing photos
# ---------------------------------------------------------------------------


def scenario_migration() -> None:
    sb = Sandbox("migration", migrate=False)
    try:
        original = list(db.MIGRATIONS)
        db.MIGRATIONS = [m for m in original if m[0] <= 8]
        try:
            version = db.migrate()
        finally:
            db.MIGRATIONS = original

        def tables() -> set[str]:
            return {r["name"] for r in db.query("SELECT name FROM sqlite_master WHERE type='table'")}

        check("fixture database starts at schema 8 without storage tables",
              version == 8 and not ({"photo_cleanup", "storage_objects", "storage_meta"} & tables()))
        now = db.now_ms()
        with db.transaction() as tx:
            for ident in ("a", "b"):
                tx.execute("INSERT INTO accounts(id,email,password_hash,created_ms,updated_ms) VALUES(?,?,?,?,?)",
                           (ident, ident + "@fixture.invalid", "synthetic", now, now))
            for offset, (photo_id, owner, name) in enumerate((
                    ("p_a1", "a", "photo_aaaaaaaaaaaa.jpg"), ("p_b1", "b", "photo_bbbbbbbbbbbb.jpg"),
                    ("p_job", "a", "photo_job_cccccccccccc.jpg"), ("p_d1", "a", "dup.jpg"), ("p_d2", "b", "dup.jpg"),
                    ("p_bad", "a", "../escape.jpg"), ("p_c1", "a", "Case.jpg"), ("p_c2", "b", "case.jpg"))):
                tx.execute("INSERT INTO photos(id,account_id,file_name,bytes,created_ms) VALUES(?,?,?,?,?)",
                           (photo_id, owner, name, 7, now + offset))
        for name in ("photo_aaaaaaaaaaaa.jpg", "photo_bbbbbbbbbbbb.jpg", "photo_job_cccccccccccc.jpg", "dup.jpg", "Case.jpg"):
            (sb.uploads / name).write_bytes(name.encode())
        before = {n: (p.read_bytes(), p.stat().st_ino, p.stat().st_mtime_ns) for n in sb.files() for p in [sb.uploads / n]}

        def boom(tx):
            raise RuntimeError("backfill failed")
        with mock.patch.dict(db.MIGRATION_HOOKS, {9: boom}):
            try:
                db.migrate()
                failed = False
            except RuntimeError:
                failed = True
        columns = {r["name"] for r in db.query("PRAGMA table_info(jobs)")}
        check("a failing backfill aborts the whole v9 migration atomically",
              failed and db.query_one("SELECT version FROM schema_version")["version"] == 8
              and not ({"photo_cleanup", "storage_objects", "storage_meta"} & tables()) and "release_count" not in columns)

        check("migrate() reaches the current schema (12)", db.migrate() == 12 == db.SCHEMA_VERSION)
        registry = {r["name"]: r for r in db.query("SELECT * FROM storage_objects")}
        valid = ("photo_aaaaaaaaaaaa.jpg", "photo_bbbbbbbbbbbb.jpg", "photo_job_cccccccccccc.jpg")
        check("every existing photo file is registered as published (6 distinct names)",
              len(registry) == 6 and all(registry[n]["state"] == "published" and registry[n]["anomaly"] is None
                                         and registry[n]["origin"] == "backfill" for n in valid))
        check("registry keeps the public photo id and the owner as provenance",
              registry["photo_aaaaaaaaaaaa.jpg"]["photo_id"] == "p_a1" and registry["photo_aaaaaaaaaaaa.jpg"]["owner_id"] == "a")
        check("duplicate file names are REPORTED, not fixed", registry["dup.jpg"]["anomaly"] == "duplicate_file_name")
        check("case-insensitive duplicates are reported too",
              sum(1 for n in registry if n.lower() == "case.jpg") == 1
              and [registry[n]["anomaly"] for n in registry if n.lower() == "case.jpg"] == ["duplicate_file_name"])
        check("invalid file names are reported", registry["../escape.jpg"]["anomaly"] == "invalid_file_name")
        check("anomalies are visible through status()",
              storage.status()["registryAnomalies"] == {"duplicate_file_name": 2, "invalid_file_name": 1})
        check("storage epoch starts at 1 and the backfill report is stored",
              db.query_one("SELECT value FROM storage_meta WHERE key='epoch'")["value"] == "1"
              and json.loads(db.query_one("SELECT value FROM storage_meta WHERE key='backfill_report'")["value"])["registered"] == 6)
        after = {n: (p.read_bytes(), p.stat().st_ino, p.stat().st_mtime_ns) for n in sb.files() for p in [sb.uploads / n]}
        check("migration never touches an existing file (bytes, inode, mtime)", before == after)
        check("photo rows and tickets: nothing deleted or queued",
              db.query_one("SELECT COUNT(*) n FROM photos")["n"] == 8 and not sb.tickets())
        check("migrate() is idempotent", db.migrate() == 12 and db.query_one("SELECT COUNT(*) n FROM storage_objects")["n"] == 6)
        with db.transaction() as tx:
            again = storage.backfill_registry(tx)
        check("re-running the backfill registers nothing twice", again["registered"] == 0)
    finally:
        sb.close()


# ---------------------------------------------------------------------------
# 2. Account deletion: tickets, drain, atomicity
# ---------------------------------------------------------------------------


def scenario_account_delete() -> None:
    sb = Sandbox("account")
    try:
        sb.account("a")
        sb.account("b")
        name_a1 = sb.publish("a", "pa1")
        name_a2 = sb.publish("a", "pa2")
        name_b = sb.publish("b", "pb1")
        sb.legacy_photo("a", "pa_legacy", "legacy_a.jpg")
        identities = {n: (os.stat(sb.uploads / n).st_dev, os.stat(sb.uploads / n).st_ino, os.stat(sb.uploads / n).st_size)
                      for n in (name_a1, name_a2, "legacy_a.jpg")}

        try:
            with db.transaction() as tx:
                storage.retire_account_objects(tx, "a")
            unlocked = "no error"
        except storage.StorageLockError:
            unlocked = "refused"
        check("retire_account_objects refuses to run without storage_lock() (lock order is enforced)", unlocked == "refused")

        summary = sb.delete_account("a")
        check("account deletion queues one ticket per photo (incl. a legacy, unregistered one)",
              summary == {"queued": 3, "blocked": 0}, summary)
        check("account and its photo rows are gone (cascade)", not db.query_one("SELECT 1 FROM accounts WHERE id='a'")
              and db.query_one("SELECT COUNT(*) n FROM photos WHERE account_id='a'")["n"] == 0)
        tickets = sb.tickets()
        check("the tickets SURVIVE the account cascade and are pending with captured file identity",
              len(tickets) == 3 and all(t["state"] == "pending" for t in tickets)
              and {t["name"]: (t["dev"], t["ino"], t["size"]) for t in tickets} == identities)
        check("tickets keep only opaque provenance (former owner id, reason, epoch)",
              all(t["owner_id"] == "a" and t["reason"] == "account_delete" and t["epoch"] == 1 for t in tickets))
        check("objects are retiring in the registry, names stay reserved forever",
              all(sb.registry(n)["state"] == "retiring" for n in (name_a1, name_a2, "legacy_a.jpg")))
        check("no file was touched by the logical deletion", set(sb.files()) == {name_a1, name_a2, name_b, "legacy_a.jpg"})
        before = storage.status()
        check("status() reports the backlog before draining",
              before["pending"] == 3 and before["blocked"] == 0 and before["done"] == 0
              and before["oldestPendingMs"] is not None and before["lastDrainMs"] is None and before["blockedReasons"] == {})

        result = storage.drain(50)
        check("drain completes every ticket", result == {"done": 3, "pending": 0, "blocked": 0}, result)
        check("the deleted account's files are gone, the other account's file is intact",
              sb.files() == [name_b])
        check("tickets are done (acknowledged) and objects retired",
              all(t["state"] == "done" and t["done_ms"] for t in sb.tickets())
              and all(sb.registry(n)["state"] == "retired" for n in (name_a1, name_a2, "legacy_a.jpg")))
        check("a second drain is a no-op", storage.drain(50) == {"done": 0, "pending": 0, "blocked": 0})
        after = storage.status()
        check("status() after draining", after["done"] == 3 and after["pending"] == 0 and after["lastDrainMs"]
              and after["oldestPendingMs"] is None)

        sb.account("c")
        name_c = sb.publish("c", "pc1")
        try:
            with storage.storage_lock():
                with db.transaction() as tx:
                    storage.retire_account_objects(tx, "c")
                    tx.execute("DELETE FROM accounts WHERE id = 'c'")
                    raise RuntimeError("audit write failed")
        except RuntimeError:
            pass
        check("a failure inside the deletion transaction rolls back account, tickets and registry together",
              db.query_one("SELECT 1 FROM accounts WHERE id='c'") and sb.photo("pc1")
              and not sb.tickets("owner_id='c'") and sb.registry(name_c)["state"] == "published" and name_c in sb.files())
    finally:
        sb.close()


# ---------------------------------------------------------------------------
# 3. Record deletion: one authoritative resolver; shared/foreign references are kept
# ---------------------------------------------------------------------------


def scenario_reference_resolver() -> None:
    parse = storage.parse_image_reference
    cases = [
        (None, "none", None), ("", "none", None), ("   ", "none", None),
        ("/api/photos/photo_abc123", "photo", "photo_abc123"),
        ("/api/photos/photo_abc123/", "ambiguous", None),
        ("https://jagake.bond/api/photos/photo_abc123", "photo", "photo_abc123"),
        ("http://www.jagake.bond/api/photos/x1", "photo", "x1"),
        ("https://JAGAKE.BOND/api/photos/x2", "photo", "x2"),
        ("https://jagake.bond:443/api/photos/x3", "photo", "x3"),
        ("https://jagake.bond:8443/api/photos/x4", "ambiguous", None),
        ("https://jagake.bond/api/photos/x5?v=2", "ambiguous", None),
        ("https://jagake.bond/api/photos/x6#frag", "ambiguous", None),
        ("https://user:pw@jagake.bond/api/photos/x7", "ambiguous", None),
        ("/api/photos/x8?size=1", "ambiguous", None),
        ("/api/photos/../x9", "ambiguous", None),
        ("/api/photos/a%2Fb", "ambiguous", None),
        ("//jagake.bond/api/photos/x10", "ambiguous", None),
        ("https://evil.example/api/photos/x11", "ambiguous", None),
        ("/uploads/photo_old1.jpg", "legacy_upload", None),
        ("https://jagake.bond/uploads/photo_old2.jpg", "legacy_upload", None),
        ("/uploads/sub/photo_old3.jpg", "ambiguous", None),
        ("/uploads/../etc/passwd", "ambiguous", None),
        ("data:image/jpeg;base64,AAAA", "foreign", None), ("blob:https://jagake.bond/1234", "foreign", None),
        ("https://cdn.example.org/pic.jpg", "foreign", None), ("javascript:alert(1)", "foreign", None),
        (12345, "ambiguous", None),
    ]
    bad = [(value, parse(value)) for value, kind, photo_id in cases
           if (parse(value).kind, parse(value).photo_id) != (kind, photo_id)]
    check("parse_image_reference: every accepted/unsupported form is classified exactly", not bad, bad[:3])
    check("legacy /uploads/<file> resolves by file name only",
          parse("/uploads/photo_old1.jpg").file_name == "photo_old1.jpg" and parse("/uploads/photo_old1.jpg").photo_id is None)
    os.environ["JK_PUBLIC_HOSTS"] = "farm.example.test, other.example.test"
    try:
        check("JK_PUBLIC_HOSTS adds same-origin hosts (no hard-coded domain)",
              parse("https://farm.example.test/api/photos/e1").kind == "photo"
              and parse("https://OTHER.example.test/api/photos/e2").photo_id == "e2"
              and parse("https://nope.example.test/api/photos/e3").kind == "ambiguous")
    finally:
        del os.environ["JK_PUBLIC_HOSTS"]


def scenario_record_delete() -> None:
    sb = Sandbox("records")
    try:
        sb.account("a")
        sb.account("b")
        sb.account("adm", role="admin")

        # two references of the same account
        name = sb.publish("a", "p_one")
        sb.record("r1", "a", "/api/photos/p_one")
        sb.record("r2", "a", "/api/photos/p_one")
        api_app.delete_record("r1", account=account_ctx("a"))
        check("shared photo: first unlink keeps row, file and registry state",
              sb.photo("p_one") and name in sb.files() and not sb.tickets() and sb.registry(name)["state"] == "published")
        api_app.delete_record("r2", account=account_ctx("a"))
        check("last reference: row deleted, ticket created and drained, file unlinked",
              not sb.photo("p_one") and name not in sb.files() and sb.tickets()[0]["reason"] == "last_record_unlink"
              and sb.tickets()[0]["state"] == "done" and sb.registry(name)["state"] == "retired")

        # absolute same-origin URL counts as a reference
        name = sb.publish("a", "p_abs")
        sb.record("r3", "a", "https://jagake.bond/api/photos/p_abs")
        sb.record("r4", "a", "/api/photos/p_abs")
        api_app.delete_record("r4", account=account_ctx("a"))
        check("absolute same-origin reference keeps the photo", sb.photo("p_abs") and name in sb.files())
        api_app.delete_record("r3", account=account_ctx("a"))
        check("absolute same-origin form identifies and retires the photo", not sb.photo("p_abs") and name not in sb.files())

        os.environ["JK_PUBLIC_HOSTS"] = "farm.example.test"
        try:
            name = sb.publish("a", "p_env")
            sb.record("r5", "a", "https://farm.example.test/api/photos/p_env")
            api_app.delete_record("r5", account=account_ctx("a"))
            check("configured public host is resolved (no hard-coded https://jagake.bond)",
                  not sb.photo("p_env") and name not in sb.files())
        finally:
            del os.environ["JK_PUBLIC_HOSTS"]

        # a record of ANOTHER account referencing the photo
        name = sb.publish("a", "p_x")
        sb.record("rx_a", "a", "/api/photos/p_x")
        sb.record("rx_b", "b", "/api/photos/p_x")
        api_app.delete_record("rx_a", account=account_ctx("a"))
        check("foreign (other account) record reference keeps the photo",
              sb.photo("p_x") and name in sb.files() and not sb.tickets("photo_id='p_x'"))

        # ambiguous: query string / foreign host / legacy file-name references
        name = sb.publish("a", "p_amb")
        sb.record("ra1", "a", "/api/photos/p_amb")
        sb.record("ra2", "a", "/api/photos/p_amb?size=big")
        sb.record("ra3", "a", "https://evil.example/api/photos/p_amb")
        sb.record("ra4", "a", f"/uploads/{name}")
        api_app.delete_record("ra1", account=account_ctx("a"))
        check("ambiguous / foreign-host / legacy references keep the photo", sb.photo("p_amb") and name in sb.files())
        for rid in ("ra2", "ra3", "ra4"):
            api_app.delete_record(rid, account=account_ctx("a"))
        check("deleting a record whose reference is ambiguous/legacy never deletes the photo",
              sb.photo("p_amb") and name in sb.files() and not sb.tickets("photo_id='p_amb'"))

        # not ours / not a photo reference
        name_b = sb.publish("b", "p_of_b")
        sb.record("rg1", "a", "/api/photos/p_of_b")
        api_app.delete_record("rg1", account=account_ctx("a"))
        check("a record pointing at another account's photo never retires it",
              sb.photo("p_of_b") and name_b in sb.files() and not sb.tickets("photo_id='p_of_b'"))
        for index, value in enumerate((None, "", "data:image/jpeg;base64,AAAA", "https://cdn.example.org/x.jpg")):
            sb.record(f"rn{index}", "a", value)
            api_app.delete_record(f"rn{index}", account=account_ctx("a"))
        check("none/data:/external image values create no tickets", not sb.tickets("photo_id='p_of_b' OR photo_id IS NULL"))

        # admin deleting a user's record acts for the record's owner
        name = sb.publish("a", "p_adm")
        sb.record("rd1", "a", "/api/photos/p_adm")
        api_app.delete_record("rd1", account=account_ctx("adm", "admin"))
        check("admin deleting a user's record retires the owner's photo", not sb.photo("p_adm") and name not in sb.files())

        # direct helper: ownership assertion and unknown photo
        name = sb.publish("a", "p_own")
        with storage.storage_lock():
            with db.transaction() as tx:
                wrong_owner = storage.retire_photo_if_unreferenced(tx, "p_own", owner_id="b")
                unknown = storage.retire_photo_if_unreferenced(tx, "does_not_exist")
        check("retire_photo_if_unreferenced: wrong owner / unknown photo are 'kept'",
              wrong_owner == "kept" and unknown == "kept" and sb.photo("p_own") and not sb.tickets("photo_id='p_own'"))
        with storage.storage_lock():
            with db.transaction() as tx:
                outcome = storage.retire_photo_if_unreferenced(tx, "p_own", owner_id="a")
        check("retire_photo_if_unreferenced returns 'queued' and deletes the row in the caller's transaction",
              outcome == "queued" and not sb.photo("p_own") and sb.tickets("photo_id='p_own'")[0]["state"] == "pending")
        storage.drain(10)
        check("... and the drainer removes the file", name not in sb.files())

        # atomic mode: the caller passes its own transaction
        name = sb.publish("a", "p_tx")
        sb.record("rt1", "a", "/api/photos/p_tx")
        with storage.storage_lock():
            with db.transaction() as tx:
                tx.execute("DELETE FROM records WHERE id='rt1'")
                outcome = api_app._delete_photo_for_url("/api/photos/p_tx", "a", tx=tx)
        check("_delete_photo_for_url(tx=...) runs inside the record-deletion transaction",
              outcome == "queued" and not sb.photo("p_tx") and sb.tickets("photo_id='p_tx'") and name in sb.files())
        storage.drain(10)
    finally:
        sb.close()


# ---------------------------------------------------------------------------
# 4. Duplicate / invalid file names block
# ---------------------------------------------------------------------------


def scenario_duplicates_block() -> None:
    sb = Sandbox("duplicates")
    try:
        for ident in ("a", "b", "c", "d", "e", "f"):
            sb.account(ident)
        # (1) migrated duplicates shared by two accounts
        sb.legacy_photo("a", "pd_a", "dup.jpg", b"shared bytes")
        sb.legacy_photo("b", "pd_b", "dup.jpg", file=False)
        with db.transaction() as tx:
            storage.backfill_registry(tx)
        summary = sb.delete_account("a")
        check("duplicate name shared with another live photo: ticket is BLOCKED", summary == {"queued": 0, "blocked": 1}, summary)
        ticket = sb.tickets("name='dup.jpg'")[0]
        check("blocked reason is explicit and the object stays published (another row is live)",
              ticket["state"] == "blocked" and ticket["block_reason"] == "shared_file_name"
              and sb.registry("dup.jpg")["state"] == "published")
        result = storage.drain(10)
        check("drain leaves the shared file alone", (sb.uploads / "dup.jpg").read_bytes() == b"shared bytes"
              and result["done"] == 0 and result["blocked"] == 1)
        check("the other account's photo row survives", sb.photo("pd_b") is not None)
        sb.delete_account("b")
        check("later deleting the other holder cannot unblock it (ticket conflict, still not deleted)",
              (sb.uploads / "dup.jpg").exists() and storage.drain(10)["done"] == 0
              and len(sb.tickets("name='dup.jpg'")) == 1 and sb.tickets("name='dup.jpg'")[0]["state"] == "blocked")
        check("blockedReasons are visible", storage.status()["blockedReasons"] == {"ticket_conflict": 1})

        # (2) shared without registry (lazy adoption)
        sb.legacy_photo("c", "pc", "shared2.jpg", b"c bytes")
        sb.legacy_photo("d", "pd", "shared2.jpg", file=False)
        summary = sb.delete_account("c")
        check("unregistered shared name is adopted and blocked", summary == {"queued": 0, "blocked": 1}
              and sb.registry("shared2.jpg")["origin"] == "adopted" and (sb.uploads / "shared2.jpg").exists())
        storage.drain(10)
        check("shared2.jpg untouched after drain", (sb.uploads / "shared2.jpg").read_bytes() == b"c bytes")

        # (3) duplicate rows inside the deleted account itself
        sb.legacy_photo("e", "pe1", "e_dup.jpg", b"e bytes")
        sb.legacy_photo("e", "pe2", "e_dup.jpg", file=False)
        summary = sb.delete_account("e")
        check("duplicate file name inside one account is blocked too", summary == {"queued": 0, "blocked": 1}
              and sb.tickets("name='e_dup.jpg'")[0]["block_reason"] == "duplicate_file_name")
        storage.drain(10)
        check("e_dup.jpg untouched", (sb.uploads / "e_dup.jpg").read_bytes() == b"e bytes")

        # (4) invalid file name never reaches the filesystem
        sentinel = sb.root / "outside.jpg"
        sentinel.write_bytes(b"outside the uploads directory")
        sb.legacy_photo("f", "pf", "../outside.jpg", file=False)
        summary = sb.delete_account("f")
        check("path-like file name: blocked with invalid_file_name", summary == {"queued": 0, "blocked": 1}
              and sb.tickets("name='../outside.jpg'")[0]["block_reason"] == "invalid_file_name")
        storage.drain(10)
        check("the file outside the uploads directory is never touched", sentinel.read_bytes() == b"outside the uploads directory")
        check("nothing was ever marked done", db.query_one("SELECT COUNT(*) n FROM photo_cleanup WHERE state='done'")["n"] == 0)
    finally:
        sb.close()


# ---------------------------------------------------------------------------
# 5. Symlink / hardlink / replaced / special files block, bytes untouched
# ---------------------------------------------------------------------------


def scenario_unsafe_files() -> None:
    sb = Sandbox("unsafe")
    try:
        sb.account("keep")
        keep_name = sb.publish("keep", "keep_photo", color=(200, 10, 10))
        keep_path = sb.uploads / keep_name
        keep_bytes = keep_path.read_bytes()

        def retired(ident: str) -> tuple[Path, dict]:
            sb.account(ident)
            name = sb.publish(ident, "photo_" + ident)
            summary = sb.delete_account(ident)
            assert summary["queued"] == 1, summary
            return sb.uploads / name, sb.tickets("owner_id=?", ident)[0]

        def drained(ticket_id: str) -> dict:
            storage.drain(10)
            return db.query_one("SELECT * FROM photo_cleanup WHERE id=?", (ticket_id,))

        path, ticket = retired("u1")
        os.unlink(path)
        os.symlink(keep_path, path)
        row = drained(ticket["id"])
        check("symlink replacement: blocked unsafe_file_type, link and target untouched",
              row["state"] == "blocked" and row["block_reason"] == "unsafe_file_type"
              and path.is_symlink() and keep_path.read_bytes() == keep_bytes)

        path, ticket = retired("u2")
        os.unlink(path)
        os.link(keep_path, path)
        row = drained(ticket["id"])
        check("hardlink replacement: blocked multiple_links, both names intact",
              row["state"] == "blocked" and row["block_reason"] == "multiple_links"
              and path.read_bytes() == keep_bytes and keep_path.read_bytes() == keep_bytes)
        os.unlink(path)

        path, ticket = retired("u3")
        os.unlink(path)
        path.write_bytes(b"a different file under the same name")
        row = drained(ticket["id"])
        check("replaced regular file (other inode): blocked identity_mismatch, new bytes untouched",
              row["state"] == "blocked" and row["block_reason"] == "identity_mismatch"
              and path.read_bytes() == b"a different file under the same name")
        u3_ticket = ticket["id"]

        path, ticket = retired("u4")
        with open(path, "ab") as handle:
            handle.write(b"appended")
        grown = path.read_bytes()
        row = drained(ticket["id"])
        check("same inode but changed size: blocked identity_mismatch", row["state"] == "blocked"
              and row["block_reason"] == "identity_mismatch" and path.read_bytes() == grown)

        path, ticket = retired("u5")
        os.unlink(path)
        os.mkfifo(path)
        row = drained(ticket["id"])
        check("special file (FIFO): blocked unsafe_file_type, not opened for reading",
              row["state"] == "blocked" and row["block_reason"] == "unsafe_file_type" and stat.S_ISFIFO(os.lstat(path).st_mode))
        os.unlink(path)

        path, ticket = retired("u6")
        os.unlink(path)
        os.mkdir(path)
        (path / "inner").write_bytes(b"x")
        row = drained(ticket["id"])
        check("directory in place of the file: blocked, nothing removed recursively",
              row["state"] == "blocked" and row["block_reason"] == "unsafe_file_type" and (path / "inner").exists())

        # symlink already present when the ticket is created
        sb.account("u7")
        name = sb.publish("u7", "photo_u7")
        os.unlink(sb.uploads / name)
        os.symlink(keep_path, sb.uploads / name)
        summary = sb.delete_account("u7")
        ticket = sb.tickets("owner_id='u7'")[0]
        check("symlink at ticket creation: blocked immediately, identity not captured",
              summary == {"queued": 0, "blocked": 1} and ticket["block_reason"] == "unsafe_file_type" and ticket["dev"] is None)
        storage.drain(10)
        check("... and never followed", (sb.uploads / name).is_symlink() and keep_path.read_bytes() == keep_bytes)

        # missing at capture, file appears later
        sb.account("u8")
        name = sb.publish("u8", "photo_u8")
        os.unlink(sb.uploads / name)
        sb.delete_account("u8")
        ticket = sb.tickets("owner_id='u8'")[0]
        (sb.uploads / name).write_bytes(b"appeared after the ticket was created")
        row = drained(ticket["id"])
        check("a file that appears under a ticket captured as missing is blocked, not deleted",
              ticket["dev"] is None and row["state"] == "blocked" and row["block_reason"] == "identity_mismatch"
              and (sb.uploads / name).exists())

        # operator review: requeue only against the file as it is now
        db.close_all()
        result = storage.requeue_blocked(u3_ticket)
        row = db.query_one("SELECT * FROM photo_cleanup WHERE id=?", (u3_ticket,))
        check("requeue_blocked re-arms the ticket against the current file (identity re-captured)",
              result == "queued" and row["state"] == "pending" and row["dev"] is not None and row["attempts"] == 0)
        storage.drain(10)
        row = db.query_one("SELECT * FROM photo_cleanup WHERE id=?", (u3_ticket,))
        check("... and the reviewed file is then removed", row["state"] == "done" and not (sb.uploads / (row["name"])).exists())
        check("the unrelated live photo was never touched", keep_path.read_bytes() == keep_bytes and sb.photo("keep_photo"))
        with db.transaction() as tx:
            tx.execute("INSERT INTO photos(id,account_id,file_name,bytes,created_ms) VALUES('p_live','keep',?,1,?)",
                       (db.query_one("SELECT name FROM photo_cleanup WHERE id=?", (ticket["id"],))["name"], db.now_ms()))
        try:
            storage.requeue_blocked(ticket["id"])
            refused = False
        except storage.StorageError:
            refused = True
        check("requeue_blocked refuses while a live photo row uses the name", refused)
    finally:
        sb.close()


# ---------------------------------------------------------------------------
# 6. ENOENT replay, fsync failure, permission error, backoff
# ---------------------------------------------------------------------------


def scenario_replay_and_errors() -> None:
    sb = Sandbox("errors")
    try:
        sb.account("a")
        name = sb.publish("a", "pa")
        os.unlink(sb.uploads / name)  # already gone: e.g. an earlier unlink before the ack was lost
        sb.delete_account("a")
        result = storage.drain(10)
        ticket = sb.tickets()[0]
        check("ENOENT is idempotent progress: ticket completes", result["done"] == 1 and ticket["state"] == "done"
              and ticket["dev"] is None)

        # fsync failure after the unlink must NOT acknowledge
        sb.account("b")
        name = sb.publish("b", "pb")
        sb.delete_account("b")
        real_fsync = os.fsync
        failures = {"left": 1}

        def flaky_fsync(fd):
            if failures["left"] and stat.S_ISDIR(os.fstat(fd).st_mode):
                failures["left"] -= 1
                raise OSError(errno.EIO, "injected directory fsync failure")
            return real_fsync(fd)
        with mock.patch.object(os, "fsync", flaky_fsync):
            result = storage.drain(10)
        row = sb.tickets("owner_id='b'")[0]
        check("directory fsync failure: file gone but ticket stays PENDING (no completed claim)",
              result["done"] == 0 and row["state"] == "pending" and row["last_error"] == "fsync_failed"
              and name not in sb.files() and row["attempts"] == 1)
        check("backoff persisted: first retry in 1 minute (+<=10% jitter)",
              60_000 <= row["next_attempt_ms"] - row["updated_ms"] <= 66_000)
        check("a not-yet-due ticket is not retried", storage.drain(10)["done"] == 0
              and sb.tickets("owner_id='b'")[0]["attempts"] == 1)
        db.close_all()  # a "restart": the schedule lives in the database
        check("... also after a restart", storage.drain(10)["done"] == 0)
        with db.transaction() as tx:
            tx.execute("UPDATE photo_cleanup SET next_attempt_ms = 0 WHERE owner_id='b'")
        result = storage.drain(10)
        row = sb.tickets("owner_id='b'")[0]
        check("replay after the failed fsync: ENOENT then fsync then done", result["done"] == 1 and row["state"] == "done"
              and row["last_error"] is None)

        # permission error on unlink: stays pending, doubles, file untouched
        sb.account("c")
        name = sb.publish("c", "pc")
        sb.delete_account("c")
        real_unlink = os.unlink

        def denied_unlink(path, *args, **kwargs):
            if kwargs.get("dir_fd") is not None and str(path) == name:
                raise PermissionError(errno.EACCES, "injected permission error")
            return real_unlink(path, *args, **kwargs)
        with mock.patch.object(os, "unlink", denied_unlink):
            storage.drain(10)
            row1 = sb.tickets("owner_id='c'")[0]
            with db.transaction() as tx:
                tx.execute("UPDATE photo_cleanup SET next_attempt_ms = 0 WHERE owner_id='c'")
            storage.drain(10)
            row2 = sb.tickets("owner_id='c'")[0]
        check("permission error: ticket stays pending, file untouched, safe error code",
              row1["state"] == "pending" and row1["last_error"] == "permission_denied" and name in sb.files()
              and row1["attempts"] == 1)
        check("second failure doubles the delay (2 minutes) and counts the attempt",
              row2["attempts"] == 2 and 120_000 <= row2["next_attempt_ms"] - row2["updated_ms"] <= 132_000)
        check("status shows an overdue-free backlog while retrying", storage.status()["pending"] == 1)
        with db.transaction() as tx:
            tx.execute("UPDATE photo_cleanup SET next_attempt_ms = 0 WHERE owner_id='c'")
        storage.drain(10)
        check("once the fault is gone the ticket completes", sb.tickets("owner_id='c'")[0]["state"] == "done"
              and name not in sb.files())

        check("backoff schedule: 1 min doubling, capped at 6 h",
              [storage._backoff_ms(n, lambda: 0.0) for n in (1, 2, 3, 8, 9, 10, 50)]
              == [60_000, 120_000, 240_000, 7_680_000, 15_360_000, 21_600_000, 21_600_000])
        check("jitter never exceeds the cap", storage._backoff_ms(50, lambda: 1.0) == storage.BACKOFF_CAP_MS)

        # missing uploads directory is not proof of absence
        sb.account("d")
        name = sb.publish("d", "pd")
        sb.delete_account("d")
        moved = sb.root / "uploads.moved"
        os.rename(sb.uploads, moved)
        result = storage.drain(10)
        row = sb.tickets("owner_id='d'")[0]
        os.rename(moved, sb.uploads)
        check("a missing uploads directory never completes a ticket (unmounted disk != deleted file)",
              result["done"] == 0 and row["state"] == "pending" and row["last_error"] == "storage_unavailable"
              and name in sb.files())
    finally:
        sb.close()


# ---------------------------------------------------------------------------
# 7. Retired names are never reused or recreated
# ---------------------------------------------------------------------------


def scenario_retired_names() -> None:
    sb = Sandbox("retired")
    try:
        sb.account("a")
        name = sb.publish("a", "photo_keep_me")
        sb.record("r1", "a", "/api/photos/photo_keep_me")
        api_app.delete_record("r1", account=account_ctx("a"))
        check("setup: photo retired and its file removed", sb.registry(name)["state"] == "retired" and name not in sb.files())

        before = (sb.files(), db.query_one("SELECT COUNT(*) n FROM storage_objects")["n"])
        try:
            storage.publish_photo(jpeg(), "a", "photo_keep_me")
            result = "published"
        except storage.PhotoUnavailable:
            result = "unavailable"
        check("a deleted public photo id is never published again", result == "unavailable"
              and before == (sb.files(), db.query_one("SELECT COUNT(*) n FROM storage_objects")["n"]) and not sb.photo("photo_keep_me"))

        try:
            with db.transaction() as tx:
                tx.execute("INSERT INTO storage_objects(name,state,created_ms,updated_ms) VALUES(?, 'reserved', 1, 1)", (name,))
            clash = False
        except Exception:
            clash = True
        try:
            with db.transaction() as tx:
                tx.execute("INSERT INTO storage_objects(name,state,created_ms,updated_ms) VALUES(?, 'reserved', 1, 1)", (name.upper(),))
            clash_upper = False
        except Exception:
            clash_upper = True
        check("the registry refuses to register a retired name again (also case-insensitively)", clash and clash_upper)

        retired_hex = name[len(storage.OBJECT_PREFIX):-len(".jpg")]
        fresh_hex = "f" * 32
        with mock.patch.object(storage, "_new_token", side_effect=[retired_hex, fresh_hex]):
            sb.publish("a", "photo_next")
        new_name = db.query_one("SELECT file_name FROM photos WHERE id='photo_next'")["file_name"]
        check("a token that collides with a retired name is skipped; the new object gets a fresh name",
              new_name == f"{storage.OBJECT_PREFIX}{fresh_hex}.jpg" and sb.registry(name)["state"] == "retired")

        # account deleted and recreated under the same id: still no resurrection
        sb.delete_account("a")
        storage.drain(10)
        sb.account("a")
        try:
            storage.publish_photo(jpeg(), "a", "photo_next")
            again = "published"
        except storage.PhotoUnavailable:
            again = "unavailable"
        check("recreated account cannot resurrect a retired photo id", again == "unavailable" and sb.files() == [])

        # a never-published (aborted) reservation does NOT burn the public id
        with mock.patch.object(storage.os, "link", side_effect=OSError(errno.EIO, "injected")):
            try:
                storage.publish_photo(jpeg(), "a", "photo_retry")
            except OSError:
                pass
        storage.drain(10)
        check("an aborted upload leaves the public id available for a later successful attempt",
              storage.publish_photo(jpeg(), "a", "photo_retry") == "photo_retry" and sb.photo("photo_retry"))
    finally:
        sb.close()


# ---------------------------------------------------------------------------
# 8. Recovered AI record after the farmer deleted the photo
# ---------------------------------------------------------------------------


def scenario_recovered_after_delete() -> None:
    import base64
    sb = Sandbox("recovered")
    try:
        sb.account("a")
        job_id = "job_recovered001"
        now = db.now_ms()
        with db.transaction() as tx:
            tx.execute("INSERT INTO jobs(id,account_id,status,created_ms,updated_ms,image_b64,context_json,diagnosis_json) "
                       "VALUES(?,?,?,?,?,?,?,?)",
                       (job_id, "a", "done", now, now, base64.b64encode(jpeg((211, 37, 89), (18, 12))).decode("ascii"), "{}",
                        json.dumps({"crop": "x", "condition": "y", "severity": "Moderate", "symptoms_id": "z",
                                    "immediate_action_id": "safe", "confidence": 0.6})))
        record = {"id": f"record_{job_id}", "source": "ai"}
        first = api_app.create_record(dict(record), account=account_ctx("a"))
        photo_id = f"photo_{job_id}"
        check("first recovery stores the retained photo under the stable public id",
              first["imageUrl"] == f"/api/photos/{photo_id}" and sb.photo(photo_id) and len(sb.files()) == 1)
        name = sb.photo(photo_id)["file_name"]
        check("the internal file name is a random token, not the public id",
              name.startswith(storage.OBJECT_PREFIX) and photo_id not in name)
        again = api_app.create_record(dict(record), account=account_ctx("a"))
        check("a second recovery is idempotent (no second object)", again["imageUrl"] == first["imageUrl"] and sb.files() == [name])

        api_app.delete_record(f"record_{job_id}", account=account_ctx("a"))
        check("record deleted: photo retired and removed", sb.files() == [] and sb.registry(name)["state"] == "retired")
        objects_before = db.query_one("SELECT COUNT(*) n FROM storage_objects")["n"]
        recovered = api_app.create_record(dict(record), account=account_ctx("a"))
        check("recovering the result AFTER the farmer deleted the photo returns the record WITHOUT an image",
              recovered["id"] == f"record_{job_id}" and recovered["imageUrl"] is None)
        check("... the deleted file is not recreated (no file, no photo row, no new object)",
              sb.files() == [] and not sb.photo(photo_id)
              and db.query_one("SELECT COUNT(*) n FROM storage_objects")["n"] == objects_before and sb.staging() == [])
        check("... and the retired name stays retired", sb.registry(name)["state"] == "retired")
    finally:
        sb.close()


# ---------------------------------------------------------------------------
# 9. Upload failure leaves a ticket, never an orphan; HTTP mapping
# ---------------------------------------------------------------------------


def scenario_upload_failures() -> None:
    sb = Sandbox("upload")
    try:
        sb.account("a")
        sb.account("gone", active=0)

        with mock.patch.object(storage.os, "link", side_effect=OSError(errno.EIO, "injected link failure")):
            try:
                storage.publish_photo(jpeg(), "a", "p1")
                raised = False
            except OSError:
                raised = True
        objects = db.query("SELECT * FROM storage_objects")
        check("failure while publishing: error surfaces, no photo row, no staged leftover",
              raised and not sb.photo("p1") and sb.staging() == [] and sb.files() == [])
        check("... and a durable aborted_upload ticket explains the reservation",
              len(objects) == 1 and objects[0]["state"] == "retiring" and sb.tickets()[0]["reason"] == "aborted_upload"
              and sb.tickets()[0]["state"] == "pending")
        check("... the drainer converges it", storage.drain(10)["done"] == 1 and sb.registry(objects[0]["name"])["state"] == "retired")

        def boom_hook(point: str) -> None:
            if point == "publish.before_row_commit":
                raise RuntimeError("injected failure before the row commit")
        storage._FAULT_HOOK = boom_hook
        try:
            storage.publish_photo(jpeg(), "a", "p2")
        except RuntimeError:
            pass
        storage._FAULT_HOOK = None
        published = [f for f in sb.files()]
        ticket = sb.tickets("reason='aborted_upload' AND state='pending'")
        check("failure after the file was published but before the row commit: file is ticketed with its identity",
              not sb.photo("p2") and len(published) == 1 and len(ticket) == 1 and ticket[0]["name"] == published[0]
              and ticket[0]["dev"] is not None)
        check("... a live photo is never lost: only the unreferenced file is removed", storage.drain(10)["done"] == 1
              and sb.files() == [])

        # even bookkeeping failure leaves a durable reservation that reconciliation turns into a ticket
        storage._FAULT_HOOK = boom_hook
        with mock.patch.object(storage, "_create_ticket", side_effect=RuntimeError("ticket write failed")):
            try:
                storage.publish_photo(jpeg(), "a", "p3")
            except RuntimeError:
                pass
        storage._FAULT_HOOK = None
        reserved = db.query("SELECT * FROM storage_objects WHERE state='reserved'")
        check("if the abandon bookkeeping fails too, the object stays 'reserved' (durable intent)",
              len(reserved) == 1 and len(sb.files()) == 1 and not sb.tickets("name=?", reserved[0]["name"]))
        result = storage.drain(10)
        check("the next drain reconciles the reservation into a ticket and removes the file",
              result["done"] == 1 and sb.files() == [] and sb.registry(reserved[0]["name"])["state"] == "retired"
              and sb.tickets("name=?", reserved[0]["name"])[0]["reason"] == "aborted_upload")

        # staged leftovers are swept
        staging = storage.staging_dir()
        (staging / "leftover.tmp").write_bytes(b"x")
        storage.drain(10)
        check("lone staging leftovers are removed by the drainer", sb.staging() == [])

        # idempotent / conflicting publication
        sb.publish("a", "same")
        count = len(sb.files())
        check("publishing an existing own photo id returns it without a second object",
              storage.publish_photo(jpeg(), "a", "same") == "same" and len(sb.files()) == count)
        sb.account("b")
        try:
            storage.publish_photo(jpeg(), "b", "same")
            conflict = "published"
        except storage.PhotoIdConflict:
            conflict = "conflict"
        check("a photo id owned by another account is refused", conflict == "conflict" and len(sb.files()) == count)
        try:
            storage.publish_photo(jpeg(), "gone", "p_gone")
            inactive = "published"
        except storage.AccountUnavailable:
            inactive = "refused"
        try:
            storage.publish_photo(jpeg(), "nobody", "p_nobody")
            missing = "published"
        except storage.AccountUnavailable:
            missing = "refused"
        check("inactive/missing accounts cannot publish", inactive == "refused" and missing == "refused" and len(sb.files()) == count)

        # a foreign file squatting on a fresh name is never touched or replaced
        victim = sb.uploads / f"{storage.OBJECT_PREFIX}{'a' * 32}.jpg"
        victim.write_bytes(b"not ours")
        with mock.patch.object(storage, "_new_token", side_effect=["a" * 32, "b" * 32]):
            sb.publish("a", "after_squat")
        check("name collision with a foreign file: file untouched, collision recorded, upload uses another name",
              victim.read_bytes() == b"not ours" and sb.registry(victim.name)["anomaly"] == "name_collision"
              and sb.registry(victim.name)["state"] == "retired" and sb.photo("after_squat")["file_name"].endswith("b" * 32 + ".jpg"))

        # HTTP mapping of _store_photo_sync
        def code(callable_):
            try:
                callable_()
            except HTTPException as exc:
                return exc.status_code
            return 200
        check("_store_photo_sync: invalid image is a 400 (no reservation made)",
              code(lambda: api_app._store_photo_sync(b"not an image", "a")) == 400)
        with mock.patch.object(storage, "publish_photo", side_effect=OSError(errno.ENOSPC, "disk full")):
            check("_store_photo_sync: disk error is a retryable 503", code(lambda: api_app._store_photo_sync(jpeg(), "a")) == 503)
        with mock.patch.object(storage, "publish_photo", side_effect=storage.StorageBusy("busy")):
            check("_store_photo_sync: busy storage is a retryable 503", code(lambda: api_app._store_photo_sync(jpeg(), "a")) == 503)
        with mock.patch.object(storage, "publish_photo", side_effect=storage.AccountUnavailable()):
            check("_store_photo_sync: vanished account is a 401", code(lambda: api_app._store_photo_sync(jpeg(), "a")) == 401)
        with mock.patch.object(storage, "publish_photo", side_effect=[storage.PhotoIdConflict(), "photo_second"]):
            check("_store_photo_sync: a server-made id that collides is replaced",
                  api_app._store_photo_sync(jpeg(), "a") == "photo_second")
        with mock.patch.object(storage, "publish_photo", side_effect=storage.PhotoIdConflict()):
            check("_store_photo_sync: an explicit id owned by someone else is a 404",
                  code(lambda: api_app._store_photo_sync(jpeg(), "a", "explicit")) == 404)
        new_id = api_app._store_photo_sync(jpeg(), "a")
        check("_store_photo_sync end to end: public id returned, internal random file name",
              sb.photo(new_id) and sb.photo(new_id)["file_name"].startswith(storage.OBJECT_PREFIX)
              and sb.photo(new_id)["bytes"] == os.stat(sb.uploads / sb.photo(new_id)["file_name"]).st_size)
        mode = oct(os.stat(sb.uploads / sb.photo(new_id)["file_name"]).st_mode & 0o777)
        check("published files are private (0600)", mode == "0o600", mode)
    finally:
        sb.close()


# ---------------------------------------------------------------------------
# 10. Real process death
# ---------------------------------------------------------------------------


def scenario_process_death_account_delete() -> None:
    sb = Sandbox("death-account")
    try:
        sb.account("a")
        sb.account("b")
        name_a = sb.publish("a", "pa")
        name_b = sb.publish("b", "pb")
        run = sb.child("delete-account", "a", "before_commit")
        check("child died before the deletion commit (exit 73)", run.returncode == 73, run.stderr[-300:])
        check("death before commit rolls back account, rows and tickets together",
              db.query_one("SELECT 1 FROM accounts WHERE id='a'") and sb.photo("pa") and not sb.tickets()
              and sb.registry(name_a)["state"] == "published" and name_a in sb.files())

        run = sb.child("delete-account", "a", "after_commit")
        check("child died right after the deletion commit, before any unlink (exit 73)", run.returncode == 73, run.stderr[-300:])
        db.close_all()
        check("committed deletion left durable pending tickets and an untouched file",
              not db.query_one("SELECT 1 FROM accounts WHERE id='a'") and len(sb.tickets("state='pending'")) == 1
              and name_a in sb.files())
        result = storage.drain(10)
        check("after restart the drainer converges: file removed, other account's photo intact",
              result["done"] == 1 and sb.files() == [name_b] and sb.photo("pb")
              and sb.tickets()[0]["state"] == "done")
        lock_ok = storage.drain(10)
        check("storage lock was released by the process death (drain not blocked)", lock_ok["done"] == 0)
    finally:
        sb.close()


def scenario_process_death_drain() -> None:
    for point in ("drain.before_unlink", "drain.after_unlink", "drain.after_dirsync", "drain.before_ack_commit"):
        sb = Sandbox("death-" + point.split(".")[1])
        try:
            sb.account("a")
            sb.account("keep")
            name = sb.publish("a", "pa")
            keep = sb.publish("keep", "pk")
            sb.delete_account("a")
            run = sb.child("drain", point, "5")
            check(f"[{point}] child died at the fault point (exit 73)", run.returncode == 73, run.stderr[-300:])
            db.close_all()
            ticket = sb.tickets()[0]
            gone = name not in sb.files()
            expected_gone = point != "drain.before_unlink"
            check(f"[{point}] ticket is still pending (never acknowledged) and the file state matches the cut",
                  ticket["state"] == "pending" and gone == expected_gone, (ticket["state"], gone))
            result = storage.drain(10)
            check(f"[{point}] restart drain converges (ENOENT replay + fsync + ack)",
                  result["done"] == 1 and sb.tickets()[0]["state"] == "done" and sb.registry(name)["state"] == "retired"
                  and name not in sb.files())
            check(f"[{point}] no live photo lost", sb.files() == [keep] and sb.photo("pk"))
        finally:
            sb.close()


def scenario_process_death_publish() -> None:
    for point in ("publish.after_reserve", "publish.after_stage_write", "publish.after_publish", "publish.before_row_commit"):
        sb = Sandbox("death-" + point.split(".")[1])
        try:
            sb.account("a")
            sb.account("keep")
            keep = sb.publish("keep", "pk")
            run = sb.child("publish", point, "a", "pa")
            check(f"[{point}] child died mid-publication (exit 73)", run.returncode == 73, run.stderr[-300:])
            db.close_all()
            reserved = db.query("SELECT * FROM storage_objects WHERE state='reserved'")
            check(f"[{point}] no photo row, but a durable reservation explains whatever reached the disk",
                  not sb.photo("pa") and len(reserved) == 1 and reserved[0]["photo_id"] == "pa" and reserved[0]["owner_id"] == "a")
            published_on_disk = [f for f in sb.files() if f != keep]
            staged = sb.staging()
            expected = {"publish.after_reserve": (0, 0), "publish.after_stage_write": (0, 1),
                        "publish.after_publish": (1, 0), "publish.before_row_commit": (1, 0)}[point]
            check(f"[{point}] on-disk state matches the cut (published={expected[0]}, staged={expected[1]})",
                  (len(published_on_disk), len(staged)) == expected, (published_on_disk, staged))
            inventory = storage.inventory()
            check(f"[{point}] inventory does not call the reserved file an unexplained orphan",
                  inventory["unreferencedCount"] == 0)
            result = storage.drain(10)
            check(f"[{point}] restart reconciles: ticket, unlink, clean staging", result["done"] == 1
                  and sb.files() == [keep] and sb.staging() == [] and sb.registry(reserved[0]["name"])["state"] == "retired"
                  and sb.tickets()[0]["reason"] == "aborted_upload" and sb.tickets()[0]["state"] == "done")
            check(f"[{point}] the other account's live photo is untouched and served from the same file",
                  sb.photo("pk") and (sb.uploads / keep).exists())
            check(f"[{point}] the public id can be uploaded again afterwards",
                  storage.publish_photo(jpeg(), "a", "pa") == "pa" and sb.photo("pa"))
        finally:
            sb.close()
    sb = Sandbox("death-after-row")
    try:
        sb.account("a")
        run = sb.child("publish", "publish.after_row_commit", "a", "pa")
        check("[publish.after_row_commit] death after the commit keeps a fully published photo",
              run.returncode == 73)
        db.close_all()
        row = sb.photo("pa")
        check("[publish.after_row_commit] row, file and registry agree; nothing to clean",
              row and (sb.uploads / row["file_name"]).exists() and sb.registry(row["file_name"])["state"] == "published"
              and storage.drain(10) == {"done": 0, "pending": 0, "blocked": 0} and sb.staging() == [])
    finally:
        sb.close()


# ---------------------------------------------------------------------------
# 11. Concurrency
# ---------------------------------------------------------------------------


def scenario_concurrent_drainers() -> None:
    sb = Sandbox("drainers")
    try:
        sb.account("a")
        sb.account("keep")
        keep = sb.publish("keep", "pk")
        names = [sb.publish("a", f"pa{index}") for index in range(40)]
        sb.delete_account("a")
        with storage.storage_lock():
            first = subprocess.Popen([sys.executable, str(THIS), "--child", "drain-loop", str(sb.root)], stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, text=True)
            second = subprocess.Popen([sys.executable, str(THIS), "--child", "drain-loop", str(sb.root)], stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE, text=True)
            time.sleep(2.5)  # both children are now blocked on the flock held here
            check("two drainer processes are waiting on the storage lock", first.poll() is None and second.poll() is None)
        outputs = [p.communicate(timeout=120) for p in (first, second)]
        counts = [json.loads(out[0])["done"] for out in outputs if out[0].strip()]
        check("both drainers finished cleanly", first.returncode == 0 and second.returncode == 0, [o[1][-200:] for o in outputs])
        check("every ticket was completed exactly once across the two processes", sum(counts) == 40, counts)
        db.close_all()
        tickets = sb.tickets()
        check("all 40 tickets done, one attempt each, no error", len(tickets) == 40
              and all(t["state"] == "done" and t["attempts"] == 1 and t["last_error"] is None for t in tickets))
        check("all files gone, the live photo remains", sb.files() == [keep] and not any(n in sb.files() for n in names))

        # non-blocking drain while another process holds the lock
        sb.account("b")
        sb.publish("b", "pb")
        sb.delete_account("b")
        ready = sb.root / "ready"
        holder = subprocess.Popen([sys.executable, str(THIS), "--child", "hold-lock", str(sb.root), "4", str(ready)],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        deadline = time.monotonic() + 30
        while not ready.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        started = time.monotonic()
        result = storage.drain(10, lock_timeout=0.0)
        elapsed = time.monotonic() - started
        try:
            with storage.storage_lock(timeout=0.2):
                took_lock = True
        except storage.StorageBusy:
            took_lock = False
        check("a drain that cannot take the lock returns at once and processes nothing",
              ready.exists() and result["done"] == 0 and result["pending"] == 1 and elapsed < 1.5 and not took_lock, (result, elapsed))
        holder.communicate(timeout=60)
        check("after the holder exits the ticket is drained", storage.drain(10)["done"] == 1)
    finally:
        sb.close()


def scenario_thread_races() -> None:
    sb = Sandbox("threads")
    try:
        sb.account("a")
        sb.account("z")
        errors: list[BaseException] = []

        def uploader(offset: int) -> None:
            try:
                for index in range(5):
                    storage.publish_photo(jpeg((offset * 20, 100, index * 40)), "a", f"t{offset}_{index}")
            except BaseException as exc:  # noqa: BLE001
                errors.append(exc)
            finally:
                db.close_all()

        def drainer() -> None:
            try:
                for _ in range(15):
                    storage.drain(10)
                    time.sleep(0.01)
            except BaseException as exc:  # noqa: BLE001
                errors.append(exc)
            finally:
                db.close_all()
        threads = [threading.Thread(target=uploader, args=(n,)) for n in range(6)] + [threading.Thread(target=drainer)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(120)
        names = [r["file_name"] for r in db.query("SELECT file_name FROM photos")]
        check("30 concurrent publications succeed with 30 distinct names", not errors and len(names) == 30 == len(set(names)), errors[:1])
        check("rows, files and registry agree (no orphan, no missing file, no leftover staging)",
              sorted(names) == sb.files() and sb.staging() == [] and storage.inventory()["unreferencedCount"] == 0
              and db.query_one("SELECT COUNT(*) n FROM storage_objects WHERE state='published'")["n"] == 30)

        # uploads racing the deletion of their own account
        outcomes: list[str] = []

        def racing_uploader() -> None:
            try:
                for index in range(25):
                    try:
                        storage.publish_photo(jpeg((5, index * 9, 5)), "z", f"z_{index}")
                        outcomes.append("ok")
                    except storage.AccountUnavailable:
                        outcomes.append("refused")
                        break
            except BaseException as exc:  # noqa: BLE001
                errors.append(exc)
            finally:
                db.close_all()

        def deleter() -> None:
            try:
                time.sleep(0.15)
                sb.delete_account("z")
            except BaseException as exc:  # noqa: BLE001
                errors.append(exc)
            finally:
                db.close_all()
        threads = [threading.Thread(target=racing_uploader), threading.Thread(target=deleter)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(120)
        while storage.drain(50)["pending"]:
            pass
        inventory = storage.inventory()
        check("upload racing account deletion: no error, nothing of the account remains",
              not errors and not db.query_one("SELECT 1 FROM photos WHERE account_id='z'")
              and not db.query_one("SELECT 1 FROM storage_objects WHERE owner_id='z' AND state IN ('published','reserved')"),
              (errors[:1], outcomes))
        check("... every file left on disk is a live, referenced photo of account a",
              inventory["unreferencedCount"] == 0 and inventory["files"] == inventory["referenced"] == 30
              and sb.staging() == [], inventory)
    finally:
        sb.close()


# ---------------------------------------------------------------------------
# 12. Inventory is report-only
# ---------------------------------------------------------------------------


def world(sb: Sandbox):
    listing = {p.name: (p.lstat().st_size, p.lstat().st_mtime_ns, p.lstat().st_ino, p.lstat().st_mode) for p in sb.uploads.iterdir()}
    state = {t: db.query(f"SELECT * FROM {t} ORDER BY 1") for t in ("photos", "storage_objects", "photo_cleanup", "storage_meta", "records")}
    return listing, state, sorted(sb.root.iterdir())


def scenario_inventory() -> None:
    sb = Sandbox("inventory")
    try:
        sb.account("a")
        sb.account("b")
        live = sb.publish("a", "live1")
        for index in range(3):
            (sb.uploads / f"orphan_{index}.jpg").write_bytes(b"x" * (10 + index))
        (sb.uploads / "notes.txt").write_bytes(b"operator file")
        os.symlink(sb.uploads / live, sb.uploads / "link.jpg")
        os.mkdir(sb.uploads / "subdir")
        sb.publish("b", "gone1")
        sb.delete_account("b")  # pending cleanup: covered, not an orphan
        before = world(sb)
        boom = mock.Mock(side_effect=AssertionError("inventory must be report-only"))
        with mock.patch.multiple(os, unlink=boom, remove=boom, rename=boom, replace=boom, rmdir=boom, link=boom,
                                 symlink=boom, truncate=boom, write=boom), \
                mock.patch("builtins.open", boom), mock.patch.object(os, "read", boom):
            report = storage.inventory()
        after = world(sb)
        check("inventory changes nothing (files, mtimes, inodes, every table)", before == after)
        names = [item["name"] for item in report["unreferenced"]]
        check("inventory lists exactly the unexplained files (name, size, mtime only)",
              names == ["notes.txt", "orphan_0.jpg", "orphan_1.jpg", "orphan_2.jpg"]
              and all(set(item) == {"name", "size", "mtimeMs"} for item in report["unreferenced"]))
        check("inventory counts: live referenced, pending cleanup separate, links/dirs skipped",
              report["files"] == 6 and report["referenced"] == 1 and report["pendingCleanup"] == 1
              and report["unreferencedCount"] == 4 and report["unreferencedBytes"] == 10 + 11 + 12 + len(b"operator file")
              and report["skipped"] == 2 and report["scannedMs"] > 0, report)
        check("the covered (pending) file is not reported as orphan", not any("ph_" in n for n in names))
        storage.drain(10)
        check("drain still removes only the ticketed file, orphans stay for operator review",
              set(sb.files()) == {live, "orphan_0.jpg", "orphan_1.jpg", "orphan_2.jpg", "notes.txt", "link.jpg", "subdir"})

        for index in range(520):
            (sb.uploads / f"bulk_{index:04d}.jpg").write_bytes(b"y")
        big = storage.inventory()
        check("inventory caps the listing at 500 names but counts everything",
              len(big["unreferenced"]) == 500 and big["unreferencedCount"] == 524 and big["unreferencedBytes"] == 520 + 33 + 13)
        shutil_target = sb.root / "gone_uploads"
        os.rename(sb.uploads, shutil_target)
        empty = storage.inventory()
        os.rename(shutil_target, sb.uploads)
        check("a missing uploads directory reports zero files", empty["files"] == 0 and empty["unreferencedCount"] == 0)
    finally:
        sb.close()


# ---------------------------------------------------------------------------
# 13. Photo serving
# ---------------------------------------------------------------------------


def scenario_serving() -> None:
    sb = Sandbox("serving")
    try:
        sb.account("a")
        sb.account("b")
        name = sb.publish("a", "p_live")
        request = SimpleNamespace(cookies={"session": "fixture"})
        with mock.patch.object(api_app.security, "session_account", return_value=account_ctx("a")):
            response = api_app.get_photo("p_live", request)
            thumbnail = api_app.get_photo_thumbnail("p_live", request)
            hits = api_app._map_thumbnail.cache_info().hits
            repeated = api_app.get_photo_thumbnail("p_live", request)
        check("live photo is served from its internal file", Path(response.path) == sb.uploads / name)
        with Image.open(BytesIO(thumbnail.body)) as image:
            check("map thumbnail is a private, compact 96 px JPEG",
                  image.size == (96, 96) and image.format == "JPEG"
                  and len(thumbnail.body) <= 16 * 1024 and thumbnail.headers["cache-control"] == "private, no-store")
        check("a repeated request reuses the derived image", repeated.body == thumbnail.body
              and api_app._map_thumbnail.cache_info().hits == hits + 1)
        for account, code in ((None, 401), (account_ctx("b"), 404)):
            with mock.patch.object(api_app.security, "session_account", return_value=account):
                try:
                    api_app.get_photo_thumbnail("p_live", request)
                    thumbnail_status = 200
                except HTTPException as exc:
                    thumbnail_status = exc.status_code
            check(f"cached thumbnails still enforce access ({code})", thumbnail_status == code)
        with mock.patch.object(api_app.security, "session_account", return_value=account_ctx("b")):
            try:
                api_app.get_photo("p_live", request)
                other = 200
            except HTTPException as exc:
                other = exc.status_code
        check("another account still gets 404", other == 404)

        with db.transaction() as tx:  # inconsistent state: row alive but object retiring
            tx.execute("UPDATE storage_objects SET state='retiring' WHERE name=?", (name,))
        with mock.patch.object(api_app.security, "session_account", return_value=account_ctx("a")):
            try:
                api_app.get_photo("p_live", request)
                pending = 200
            except HTTPException as exc:
                pending = exc.status_code
        check("a pending-deletion (retiring) object is never served, even with a stray photo row", pending == 404)
        with mock.patch.object(api_app.security, "session_account", return_value=account_ctx("a")):
            try:
                api_app.get_photo_thumbnail("p_live", request)
                pending_thumbnail = 200
            except HTTPException as exc:
                pending_thumbnail = exc.status_code
        check("a cached thumbnail of a retiring photo is never served", pending_thumbnail == 404)
        with db.transaction() as tx:
            tx.execute("UPDATE storage_objects SET state='retired' WHERE name=?", (name,))
        with mock.patch.object(api_app.security, "session_account", return_value=account_ctx("a")):
            try:
                api_app.get_photo("p_live", request)
                retired = 200
            except HTTPException as exc:
                retired = exc.status_code
        check("a retired object is never served", retired == 404)

        sb.publish("b", "p_b")
        sb.delete_account("b")
        with mock.patch.object(api_app.security, "session_account", return_value=account_ctx("a")):
            try:
                api_app.get_photo("p_b", request)
                deleted = 200
            except HTTPException as exc:
                deleted = exc.status_code
        check("a photo of a deleted account is gone (404)", deleted == 404)
    finally:
        sb.close()


# ---------------------------------------------------------------------------
# 14. Background drainer
# ---------------------------------------------------------------------------


def scenario_background_drainer() -> None:
    sb = Sandbox("background")
    handle = None
    try:
        sb.account("a")
        names = [sb.publish("a", f"pa{index}") for index in range(3)]
        sb.delete_account("a")
        app = SimpleNamespace(state=SimpleNamespace())
        handle = storage.start_background_drainer(app, interval_s=0.2, first_delay_s=0.0)
        check("the drainer handle is exposed on app.state and start is idempotent",
              app.state.photo_drainer is handle and storage.start_background_drainer(app, interval_s=0.2) is handle
              and handle.thread.daemon)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline and any(n in sb.files() for n in names):
            time.sleep(0.1)
        check("the background thread drains the backlog at startup without any request", sb.files() == [])
        sb.account("b")
        name = sb.publish("b", "pb")
        sb.delete_account("b")
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline and name in sb.files():
            time.sleep(0.1)
        check("... and keeps running on its interval", name not in sb.files())
        storage.stop_background_drainer()
        check("the drainer stops cleanly", not handle.thread.is_alive())
    finally:
        storage.stop_background_drainer()
        sb.close()


# ---------------------------------------------------------------------------
# 15. release_ops: snapshot / restore / deploy integration
# ---------------------------------------------------------------------------


def load_ops():
    spec = importlib.util.spec_from_file_location("release_ops_storage", BASE / "deploy" / "release_ops.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build_app_tree(root: Path) -> Path:
    app = root / "source"
    for name in ("backend", "frontend"):
        (app / name).mkdir(parents=True)
    (app / "backend/app.py").write_text("version=1\n")
    (app / "frontend/index.html").write_text("<p>fixture</p>")
    (app / "data/uploads").mkdir(parents=True)
    return app


def scenario_release_ops() -> None:
    ops = load_ops()
    sb = Sandbox("release", migrate=False)
    try:
        app = build_app_tree(sb.root)
        db.close_all()
        db.DB_PATH = app / "data/db.sqlite3"
        uploads = app / "data/uploads"
        api_app.UPLOAD_DIR = uploads
        db.migrate()
        sb.uploads = uploads
        sb.account("a")
        sb.account("b")
        live = sb.publish("a", "live_photo")
        retired_name = sb.publish("b", "gone_photo")
        sb.delete_account("b")
        storage.drain(10)  # retired object + done ticket, file legitimately gone
        pending_name = sb.publish("a", "pending_photo")
        with storage.storage_lock():
            with db.transaction() as tx:
                tx.execute("DELETE FROM records WHERE 1=0")
                assert storage.retire_photo_if_unreferenced(tx, "pending_photo") == "queued"
        sb.account("c")
        sb.publish("c", "blocked_photo")
        blocked_name = sb.photo("blocked_photo")["file_name"]
        os.unlink(uploads / blocked_name)
        os.symlink(uploads / live, uploads / blocked_name)
        sb.delete_account("c")
        with db.transaction() as tx:
            tx.execute("INSERT INTO storage_objects(name,photo_id,owner_id,state,created_ms,updated_ms) VALUES('ph_reserved.jpg','x','a','reserved',1,1)")
        (app / "data/storage.lock").write_text("")
        (app / "data/uploads-staging").mkdir(exist_ok=True)
        (app / "data/uploads-staging/stale.tmp").write_text("stale")
        os.unlink(uploads / blocked_name)  # keep the tree free of symlinks (snapshots refuse them)
        (uploads / blocked_name).write_bytes(b"blocked ticket's file")
        db.close_all()

        backups = sb.root / "backups"
        snapshot = ops.create_snapshot(app, backups, quiesced=True)
        ops.verify_snapshot(snapshot)
        check("snapshot validates with retired objects, done/pending/blocked tickets and gone files",
              not (snapshot / "data/uploads" / retired_name).exists() and (snapshot / "data/uploads" / pending_name).exists())
        check("the lock file and the private staging directory are never snapshotted",
              not (snapshot / "data/storage.lock").exists() and not (snapshot / "data/uploads-staging").exists())
        summary = ops.storage_summary(snapshot / "data/db.sqlite3")
        check("storage_summary reports the cleanup state", summary["pending"] == 1 and summary["blocked"] == 1
              and summary["done"] == 1 and summary["reserved"] == 1 and summary["epoch"] == 1, summary)

        restored = sb.root / "restored"
        ops.restore_snapshot(snapshot, restored)
        with ops.sqlite3.connect(restored / "data/db.sqlite3") as c:
            epoch = c.execute("SELECT value FROM storage_meta WHERE key='epoch'").fetchone()[0]
            ticket_epochs = {row[0] for row in c.execute("SELECT epoch FROM photo_cleanup")}
        check("a restore fences the storage epoch (tickets keep the old one)", epoch == "2" and ticket_epochs == {1})

        # the application drainer must BLOCK, not delete, after the restore
        db.close_all()
        db.DB_PATH = restored / "data/db.sqlite3"
        api_app.UPLOAD_DIR = restored / "data/uploads"
        result = storage.drain(20)
        names_left = sorted(p.name for p in (restored / "data/uploads").iterdir())
        reasons = storage.status()["blockedReasons"]
        check("after a restore the pending ticket is blocked (epoch_mismatch), never executed",
              reasons == {"unsafe_file_type": 1, "epoch_mismatch": 1} and pending_name in names_left, (result, reasons))
        check("... only the file-less abandoned reservation was reconciled; no existing file was deleted",
              result["done"] == 1 and set(names_left) == {live, pending_name, blocked_name}, (result, names_left))
        db.close_all()

        # validation still refuses an inconsistent pair: live photo -> retired object
        import shutil
        bad = sb.root / "bad.sqlite3"
        shutil.copyfile(snapshot / "data/db.sqlite3", bad)
        with ops.sqlite3.connect(bad) as c:
            c.execute("UPDATE storage_objects SET state='retired' WHERE name=?", (live,))
        try:
            ops.validate_database(bad, snapshot / "data/uploads")
            refused = False
        except ValueError as exc:
            refused = "retired storage object" in str(exc)
        check("validate_database refuses a live photo pointing at a retired object", refused)
        with ops.sqlite3.connect(bad) as c:
            c.execute("UPDATE storage_objects SET state='published' WHERE name=?", (live,))
            c.execute("DELETE FROM storage_meta WHERE key='epoch'")
        try:
            ops.validate_database(bad, snapshot / "data/uploads")
            refused = False
        except ValueError as exc:
            refused = "epoch" in str(exc)
        check("validate_database refuses a missing storage epoch", refused)

        # deploy: pending tickets stay valid across the data copy (new inodes)
        candidate = sb.root / "candidate_data"
        ops.copy_tree(app / "data", candidate)
        rebound = ops.rebind_storage_tickets(app / "data", candidate)
        with ops.sqlite3.connect(candidate / "db.sqlite3") as c:
            row = c.execute("SELECT dev, ino, size FROM photo_cleanup WHERE name=?", (pending_name,)).fetchone()
        copy_stat = os.stat(candidate / "uploads" / pending_name)
        live_stat = os.stat(app / "data/uploads" / pending_name)
        check("the candidate copy has other inodes than the live files", copy_stat.st_ino != live_stat.st_ino)
        check("deploy rebinds the pending ticket to the byte-identical copy (identity re-captured)",
              rebound["rebound"] == 1 and row == (ops._i64(copy_stat.st_dev), ops._i64(copy_stat.st_ino), copy_stat.st_size), rebound)
        os.unlink(app / "data/uploads" / pending_name)
        (app / "data/uploads" / pending_name).write_bytes(b"replaced live file")
        again = ops.rebind_storage_tickets(app / "data", candidate)
        check("a live source that no longer matches the ticket is NOT rebound", again["rebound"] == 0 and again["skipped"] == 1, again)
        plain = sb.root / "plain"
        plain.mkdir()
        with ops.sqlite3.connect(plain / "db.sqlite3") as c:
            c.execute("CREATE TABLE photos(id TEXT, file_name TEXT)")
        check("databases without storage tables are untouched by the rebind/fence helpers",
              ops.rebind_storage_tickets(app / "data", plain) == {"rebound": 0, "skipped": 0}
              and ops.fence_storage_epoch(plain / "db.sqlite3") is None and ops.storage_summary(plain / "db.sqlite3") is None)
    finally:
        db.close_all()
        sb.close()


SCENARIOS = [
    scenario_migration, scenario_account_delete, scenario_reference_resolver, scenario_record_delete,
    scenario_duplicates_block, scenario_unsafe_files, scenario_replay_and_errors, scenario_retired_names,
    scenario_recovered_after_delete, scenario_upload_failures, scenario_process_death_account_delete,
    scenario_process_death_drain, scenario_process_death_publish, scenario_concurrent_drainers,
    scenario_thread_races, scenario_inventory, scenario_serving, scenario_background_drainer, scenario_release_ops,
]


def main() -> int:
    only = set(sys.argv[1:])
    for scenario in SCENARIOS:
        if only and scenario.__name__.replace("scenario_", "") not in only:
            continue
        print(f"--- {scenario.__name__} ---", flush=True)
        try:
            scenario()
        except Exception:  # noqa: BLE001
            traceback.print_exc()
            check(f"{scenario.__name__} ran to completion", False, traceback.format_exc().strip().splitlines()[-1])
    failed = [label for label, ok in RESULTS if not ok]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed")
    if failed:
        print("FAILED:\n  " + "\n  ".join(failed))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
