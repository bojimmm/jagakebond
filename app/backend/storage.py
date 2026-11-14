"""Crash-safe photo storage lifecycle (release 0.2.2.0).

Implements the reviewed photo-cleanup design (planning card t_392a4694, owner
approved implementation card t_5bdaea7a).

Model
-----
* Every photo file under ``data/uploads`` is a *storage object*: one row in
  ``storage_objects`` with an immutable basename that is never reused
  (``reserved`` -> ``published`` -> ``retiring`` -> ``retired``). The registry has
  no foreign key to accounts, so an account cascade can never remove it.
* Deleting a photo (record deletion, account deletion) commits the logical
  deletion TOGETHER WITH a durable cleanup ticket (``photo_cleanup``). A bounded
  drainer unlinks the file later and acknowledges the ticket only after the
  file is confirmed absent and the directory entry is synced. Replays after a
  crash at any point are safe; conflicts block the ticket instead of deleting.
* Uploads (and the recovered ``record_<job>`` photo) reserve a fresh random
  name in a transaction, write a private staging file (exclusive, no-follow,
  fsync), publish it without overwriting (hard link + unlink), fsync both
  directories and only then insert the ``photos`` row and mark the object
  published, in one transaction. A failure leaves a durable ticket (or a
  ``reserved`` row that the startup reconciliation turns into one); it never
  leaves an unexplained orphan.

Locking
-------
``storage_lock()`` (process-wide re-entrant thread lock + ``flock`` on
``data/storage.lock``) is ALWAYS taken before ``db.transaction()``. Helpers that
receive a ``tx`` (``retire_account_objects``, ``retire_photo_if_unreferenced``)
require the caller to hold the lock and refuse to run otherwise. Read-only
operations (``status``, ``inventory``, photo serving) never take it.

Threat boundary: trusted single-host service code and an administrator who
coordinates through the same lock. Descriptors, no-follow opens and identity
checks stop ordinary mistakes (stray symlinks, replaced files, shared hard
links); they do not defeat a hostile process running as the service user.
"""

from __future__ import annotations

import contextlib
import errno
import logging
import os
import random
import re
import secrets
import sqlite3
import stat
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterator
from urllib.parse import urlsplit

try:  # POSIX only. Production is Linux; elsewhere only the in-process lock applies.
    import fcntl
except ImportError:  # pragma: no cover - Windows developer machines
    fcntl = None  # type: ignore[assignment]

from . import db

log = logging.getLogger("jagakebond.storage")

__all__ = [
    "StorageError", "StorageBusy", "StorageLockError", "StorageUnavailable",
    "PhotoIdConflict", "PhotoUnavailable", "AccountUnavailable", "ImageRef",
    "storage_lock", "retire_account_objects", "retire_photo_if_unreferenced",
    "drain", "start_background_drainer", "status", "inventory", "publish_photo",
    "parse_image_reference", "is_retired", "requeue_blocked", "backfill_registry",
    "valid_object_name", "upload_dir", "staging_dir", "lock_path",
]

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Stem: ASCII letters, digits, '_' and '-'. Legacy names ("photo_<12 hex>.jpg",
# "photo_job_<12 hex>.jpg") and fixture names all fit; anything else is reported
# as an anomaly and can only ever produce a BLOCKED ticket.
NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.jpg\Z")
PHOTO_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
OBJECT_PREFIX = "ph_"

BACKOFF_FIRST_MS = 60_000                 # 1 minute, doubling per failed attempt
BACKOFF_CAP_MS = 6 * 60 * 60 * 1000       # 6 hours
DEFAULT_BATCH = 50
DRAIN_INTERVAL_S = 60.0
DRAIN_TIME_BUDGET_S = 5.0                 # a batch stops early rather than starve API writers
RECONCILE_BATCH = 200
LOCK_TIMEOUT_S = 30.0

OPEN_FLAGS = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_CLOEXEC", 0)
DIR_FLAGS = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
CREATE_FLAGS = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)

# Test seam: process-death/fault injection. Production never sets it.
_FAULT_HOOK: Callable[[str], None] | None = None
# Test/CLI seam: explicit uploads directory (otherwise api_app.UPLOAD_DIR is followed).
_UPLOAD_DIR_OVERRIDE: Path | None = None

_last_drain_ms: int | None = None


def _fault(point: str) -> None:
    hook = _FAULT_HOOK
    if hook is not None:
        hook(point)


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class StorageError(Exception):
    """Base class of every storage lifecycle error."""


class StorageBusy(StorageError):
    """The storage lock could not be taken in time (another writer/drainer is active)."""


class StorageLockError(StorageError, RuntimeError):
    """A helper that requires ``storage_lock()`` was called without holding it."""


class StorageUnavailable(StorageError, OSError):
    """The uploads directory is missing or unreadable: nothing was changed."""


class PhotoIdConflict(StorageError):
    """The public photo id already belongs to another account."""


class PhotoUnavailable(StorageError, ValueError):
    """The public photo id was published and then retired (the user deleted it).

    It is never recreated, not even from retained job bytes."""


class AccountUnavailable(StorageError):
    """The account vanished or was deactivated while its photo was being stored."""


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------


def upload_dir() -> Path:
    """The uploads directory. Follows ``api_app.UPLOAD_DIR`` (tests re-point it)."""
    if _UPLOAD_DIR_OVERRIDE is not None:
        return Path(_UPLOAD_DIR_OVERRIDE)
    module = sys.modules.get((__package__ or "backend") + ".api_app")
    value = getattr(module, "UPLOAD_DIR", None) if module is not None else None
    return Path(value) if value else db.DATA_DIR / "uploads"


def staging_dir() -> Path:
    """Private same-filesystem staging directory (never served, never a cleanup candidate)."""
    root = upload_dir()
    return root.with_name(root.name + "-staging")


def lock_path() -> Path:
    """Lock file in the data directory (not in a replaceable source tree)."""
    return Path(db.DB_PATH).parent / "storage.lock"


def valid_object_name(name: Any) -> bool:
    return isinstance(name, str) and NAME_RE.fullmatch(name) is not None


def _open_dir(path: Path, *, create: bool = False) -> int | None:
    """Open a directory without following a final symlink. None if it does not exist."""
    if create:
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        return os.open(path, DIR_FLAGS)
    except FileNotFoundError:
        return None


@contextlib.contextmanager
def _directory(path: Path, *, create: bool = False, required: bool = True) -> Iterator[int | None]:
    fd = _open_dir(path, create=create)
    if fd is None and required:
        raise StorageUnavailable(errno.ENOENT, "uploads directory is missing")
    try:
        yield fd
    finally:
        if fd is not None:
            os.close(fd)


# ---------------------------------------------------------------------------
# The storage lock
# ---------------------------------------------------------------------------

_thread_lock = threading.RLock()
_held = threading.local()


def _holds_lock() -> bool:
    return getattr(_held, "depth", 0) > 0


def _require_lock() -> None:
    if not _holds_lock():
        raise StorageLockError("storage_lock() must be held before opening the DB transaction")


def _flock(fd: int, deadline: float | None) -> None:
    if fcntl is None:  # pragma: no cover
        return
    if deadline is None:
        fcntl.flock(fd, fcntl.LOCK_EX)
        return
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            if time.monotonic() >= deadline:
                raise StorageBusy("storage lock is held by another process") from None
            time.sleep(0.02)


@contextlib.contextmanager
def storage_lock(timeout: float | None = LOCK_TIMEOUT_S) -> Iterator[None]:
    """Process-wide thread lock + ``flock`` on ``data/storage.lock``. Re-entrant per thread.

    Lock order everywhere: ``storage_lock()`` -> ``db.transaction()`` -> SQL.
    ``timeout=None`` waits forever, ``0`` never waits; on timeout ``StorageBusy`` is raised.
    """
    deadline = None if timeout is None else time.monotonic() + max(0.0, timeout)
    if timeout is None:
        _thread_lock.acquire()
    elif not _thread_lock.acquire(timeout=max(0.0, timeout)):
        raise StorageBusy("storage lock is held by another thread")
    try:
        depth = getattr(_held, "depth", 0)
        if depth == 0:
            lock_file = lock_path()
            lock_file.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(lock_file, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0), 0o600)
            try:
                _flock(fd, deadline)
            except BaseException:
                os.close(fd)
                raise
            _held.fd = fd
        _held.depth = depth + 1
        try:
            yield
        finally:
            _held.depth -= 1
            if _held.depth == 0:
                fd = _held.fd
                _held.fd = None
                try:
                    if fcntl is not None:
                        fcntl.flock(fd, fcntl.LOCK_UN)
                finally:
                    os.close(fd)
    finally:
        _thread_lock.release()


# ---------------------------------------------------------------------------
# Image reference resolver (records.image_url)
# ---------------------------------------------------------------------------

_API_PHOTO_PATH = re.compile(r"/api/photos/([A-Za-z0-9_-]{1,128})\Z")
_LEGACY_UPLOAD_PATH = re.compile(r"/uploads/([A-Za-z0-9][A-Za-z0-9_-]{0,127}\.jpg)\Z")


@dataclass(frozen=True)
class ImageRef:
    """kind: none | photo | legacy_upload | foreign | ambiguous."""
    kind: str
    photo_id: str | None = None
    file_name: str | None = None


def _public_hosts() -> set[str]:
    hosts = {"jagake.bond", "www.jagake.bond"}
    hosts.update(h.strip().lower() for h in os.environ.get("JK_PUBLIC_HOSTS", "").split(",") if h.strip())
    return hosts


def parse_image_reference(value: Any) -> ImageRef:
    """The ONE authoritative reading of ``records.image_url``.

    Accepted (exact, no query/fragment/extra segments):
      * ``/api/photos/<id>``                       -> photo
      * ``http(s)://<our host>/api/photos/<id>``   -> photo (our host = jagake.bond,
        www.jagake.bond or ``JK_PUBLIC_HOSTS``)
      * ``/uploads/<file>.jpg`` (+ absolute form)  -> legacy_upload (by file name)
    Nothing else is ever treated as identifying a photo. A value that mentions
    ``/api/photos/`` or ``/uploads/`` but is not exactly one of the forms above is
    ``ambiguous`` (callers keep/block, never delete); everything else (external
    URLs, data:/blob: URLs, junk) is ``foreign``; NULL/blank is ``none``.
    """
    if value is None:
        return ImageRef("none")
    if not isinstance(value, str):
        return ImageRef("ambiguous")
    text = value.strip()
    if not text:
        return ImageRef("none")
    lowered = text[:12].lower()
    if lowered.startswith(("data:", "blob:")):
        return ImageRef("foreign")
    mentions = "/api/photos/" in text or "/uploads/" in text
    mixed = ImageRef("ambiguous" if mentions else "foreign")
    path: str | None = None
    if text.startswith("/") and not text.startswith("//"):
        path = text
    else:
        try:
            parts = urlsplit(text)
            port = parts.port
        except ValueError:
            return mixed
        if parts.scheme.lower() not in ("http", "https") or not parts.netloc:
            return mixed
        host = (parts.hostname or "").lower()
        if host not in _public_hosts():
            return mixed
        if parts.query or parts.fragment or parts.username is not None or parts.password is not None \
                or port not in (None, 80, 443):
            return mixed
        path = parts.path
    match = _API_PHOTO_PATH.fullmatch(path)
    if match:
        return ImageRef("photo", photo_id=match.group(1))
    match = _LEGACY_UPLOAD_PATH.fullmatch(path)
    if match:
        return ImageRef("legacy_upload", file_name=match.group(1))
    return mixed


def _find_record_reference(tx: sqlite3.Connection, photo_id: str | None, file_name: str | None, *,
                           exclude_account: str | None = None) -> str | None:
    """Conservative: does ANY record (any account) possibly need this photo?

    Returns None, ``record_reference`` (an exact supported form) or
    ``ambiguous_reference`` (a value we cannot parse that still mentions the id or file
    name). With ``exclude_account`` records of that account are ignored (they are
    deleted in the same transaction) and any other hit is ``foreign_reference``.
    """
    needles = [n for n in (photo_id, file_name) if n]
    if not needles:
        return None
    clauses = " OR ".join("instr(image_url, ?) > 0" for _ in needles)
    sql = ("SELECT id, account_id, image_url FROM records "
           f"WHERE image_url IS NOT NULL AND image_url != '' AND ({clauses})")
    found: str | None = None
    for row in tx.execute(sql, needles):
        if exclude_account is not None and row["account_id"] == exclude_account:
            continue
        ref = parse_image_reference(row["image_url"])
        if ref.kind == "photo":
            hit = "record_reference" if (photo_id and ref.photo_id == photo_id) else None
        elif ref.kind == "legacy_upload":
            hit = "record_reference" if (file_name and ref.file_name == file_name) else None
        elif ref.kind in ("foreign", "ambiguous"):
            hit = "ambiguous_reference"
        else:
            hit = None
        if hit is None:
            continue
        if exclude_account is not None:
            return "foreign_reference"
        if hit == "record_reference":
            return hit
        found = hit
    return found


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def _epoch(tx: sqlite3.Connection) -> int:
    row = tx.execute("SELECT value FROM storage_meta WHERE key='epoch'").fetchone()
    if row is None:
        tx.execute("INSERT OR IGNORE INTO storage_meta (key, value) VALUES ('epoch', '1')")
        return 1
    try:
        return int(row["value"])
    except (TypeError, ValueError):
        return 1


def _backoff_ms(attempts: int, rand: Callable[[], float] = random.random) -> int:
    base = min(BACKOFF_FIRST_MS * (2 ** min(max(attempts, 1) - 1, 24)), BACKOFF_CAP_MS)
    return min(base + int(base * 0.1 * rand()), BACKOFF_CAP_MS)


def _error_code(exc: OSError) -> str:
    if isinstance(exc, PermissionError) or exc.errno in (errno.EACCES, errno.EPERM, errno.EROFS):
        return "permission_denied"
    return "io_error"


def _i64(value: int) -> int:
    """SQLite INTEGER is signed 64-bit while st_dev/st_ino may be unsigned 64-bit."""
    value &= 0xFFFFFFFFFFFFFFFF
    return value - (1 << 64) if value >= (1 << 63) else value


def _new_token() -> str:
    return secrets.token_hex(16)


def new_object_name() -> str:
    return f"{OBJECT_PREFIX}{_new_token()}.jpg"


def _flush_wal() -> None:
    """Make earlier commits durable before an irreversible filesystem step.

    The DB runs ``synchronous=NORMAL`` (WAL is only synced at checkpoints); a ticket
    must be durable before its file is unlinked, and a reservation before its file
    is written. A passive checkpoint syncs the WAL. Never call inside a transaction.
    """
    try:
        db.conn().execute("PRAGMA wal_checkpoint(PASSIVE)").fetchall()
    except sqlite3.Error:  # pragma: no cover - best effort only
        log.debug("wal checkpoint skipped", exc_info=True)


def _capture_identity(dir_fd: int, name: str) -> tuple[str, tuple[int, int, int] | None]:
    """('ok', (dev, ino, size)) | ('missing', None) | ('unsafe_file_type'|'multiple_links'|'storage_unavailable', None)."""
    try:
        fd = os.open(name, OPEN_FLAGS, dir_fd=dir_fd)
    except FileNotFoundError:
        return "missing", None
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            return "unsafe_file_type", None
        return "storage_unavailable", None
    try:
        info = os.fstat(fd)
    except OSError:
        return "storage_unavailable", None
    finally:
        os.close(fd)
    if not stat.S_ISREG(info.st_mode):
        return "unsafe_file_type", None
    if info.st_nlink != 1:
        return "multiple_links", None
    return "ok", (_i64(info.st_dev), _i64(info.st_ino), info.st_size)


def _unlink_staging(name: str) -> None:
    """Best effort removal of OUR staging entry for an object name."""
    if not valid_object_name(name):
        return
    try:
        fd = _open_dir(staging_dir())
        if fd is None:
            return
        try:
            try:
                os.unlink(name, dir_fd=fd)
            except FileNotFoundError:
                return
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError:
        log.warning("could not remove a staging entry", exc_info=True)


# ---------------------------------------------------------------------------
# Tickets
# ---------------------------------------------------------------------------


def _create_ticket(tx: sqlite3.Connection, dir_fd: int, *, name: str, photo_id: str | None,
                   owner_id: str | None, reason: str, epoch: int, now: int,
                   block: str | None = None, keep_published: bool = False,
                   created_ms: int | None = None, bytes_: int | None = None) -> str:
    """Create (or idempotently find) the open ticket for ``name``. Returns queued|blocked.

    Runs inside the caller's transaction. The object is flipped to ``retiring`` in the
    same transaction unless ``keep_published`` (another live photo row still uses the
    name). Any anomaly or ambiguity produces a BLOCKED ticket; bytes are untouched.
    """
    registry = tx.execute("SELECT * FROM storage_objects WHERE name = ?", (name,)).fetchone()
    block_reason = block
    identity: tuple[int, int, int] | None = None
    if not valid_object_name(name):
        block_reason = block_reason or "invalid_file_name"
    else:
        if registry is not None and registry["anomaly"] and not block_reason:
            block_reason = registry["anomaly"]
        outcome, identity = _capture_identity(dir_fd, name)
        if outcome in ("unsafe_file_type", "multiple_links", "storage_unavailable") and not block_reason:
            block_reason = outcome
    state = "blocked" if block_reason else "pending"
    dev, ino, size = identity if identity else (None, None, None)

    open_ticket = tx.execute("SELECT * FROM photo_cleanup WHERE name = ? AND state != 'done'", (name,)).fetchone()
    if open_ticket is not None:
        same = (open_ticket["owner_id"] == owner_id and open_ticket["photo_id"] == photo_id
                and (open_ticket["dev"], open_ticket["ino"], open_ticket["size"]) == (dev, ino, size)
                and open_ticket["epoch"] == epoch)
        if same:
            return "queued" if open_ticket["state"] == "pending" else "blocked"
        tx.execute("UPDATE photo_cleanup SET state='blocked', block_reason='ticket_conflict', updated_ms=? WHERE id=?",
                   (now, open_ticket["id"]))
        return "blocked"

    target_state = "published" if keep_published else "retiring"
    if registry is None:
        tx.execute(
            """INSERT INTO storage_objects (name, photo_id, owner_id, state, anomaly, bytes, origin,
                                            created_ms, published_ms, updated_ms)
               VALUES (?,?,?,?,NULL,?,'adopted',?,?,?)""",
            (name, photo_id, owner_id, target_state, bytes_, created_ms or now, created_ms or now, now))
    elif registry["state"] in ("retiring", "retired"):
        # A name we already retired is referenced again: whatever did that bypassed the protocol.
        if not block_reason:
            block_reason, state = "retired_name_in_use", "blocked"
    else:
        tx.execute("UPDATE storage_objects SET state = ?, updated_ms = ? WHERE name = ? AND state IN ('reserved','published')",
                   (target_state, now, name))
    tx.execute(
        """INSERT INTO photo_cleanup (id, name, photo_id, owner_id, reason, state, block_reason,
                                      dev, ino, size, attempts, next_attempt_ms, last_error, epoch,
                                      created_ms, updated_ms)
           VALUES (?,?,?,?,?,?,?,?,?,?,0,0,NULL,?,?,?)""",
        (db.new_id("pcl"), name, photo_id, owner_id, reason, state, block_reason,
         dev, ino, size, epoch, now, now))
    return "queued" if state == "pending" else "blocked"


def retire_account_objects(tx: sqlite3.Connection, account_id: str) -> dict[str, int]:
    """Create durable cleanup tickets for every photo/reserved object of ``account_id``.

    Call INSIDE the transaction that deletes the account, with ``storage_lock()`` held
    by the caller, BEFORE the ``DELETE FROM accounts`` (the cascade removes the photo
    rows). Ticket creation, object retirement, the account deletion and its audit row
    commit or roll back together. Never touches a file. Returns
    ``{"queued": n, "blocked": n}``; blocked tickets keep the bytes for operator review.
    """
    _require_lock()
    now = db.now_ms()
    epoch = _epoch(tx)
    photos = tx.execute("SELECT id, file_name, bytes, created_ms FROM photos WHERE account_id = ? ORDER BY created_ms, id",
                        (account_id,)).fetchall()
    by_name: dict[str, list[sqlite3.Row]] = {}
    for row in photos:
        by_name.setdefault(row["file_name"], []).append(row)
    owned_names = set(by_name)
    extras = [row for row in tx.execute(
        "SELECT name, photo_id, state FROM storage_objects WHERE owner_id = ? AND state IN ('reserved','published') ORDER BY created_ms, name",
        (account_id,)).fetchall() if row["name"] not in owned_names]
    counts = {"queued": 0, "blocked": 0}
    if not by_name and not extras:
        return counts
    with _directory(upload_dir()) as dir_fd:
        for name, rows in by_name.items():
            block = "duplicate_file_name" if len(rows) > 1 else None
            keep = False
            if tx.execute("SELECT 1 FROM photos WHERE file_name = ? COLLATE NOCASE AND account_id != ? LIMIT 1", (name, account_id)).fetchone():
                block, keep = block or "shared_file_name", True
            if _find_record_reference(tx, rows[0]["id"], name, exclude_account=account_id):
                block = block or "foreign_reference"
            outcome = _create_ticket(tx, dir_fd, name=name, photo_id=rows[0]["id"], owner_id=account_id,
                                     reason="account_delete", epoch=epoch, now=now, block=block,
                                     keep_published=keep, created_ms=rows[0]["created_ms"], bytes_=rows[0]["bytes"])
            counts[outcome] += 1
        for row in extras:
            reserved = row["state"] == "reserved"
            if reserved:
                _unlink_staging(row["name"])
            outcome = _create_ticket(tx, dir_fd, name=row["name"], photo_id=row["photo_id"], owner_id=account_id,
                                     reason="aborted_upload" if reserved else "account_delete", epoch=epoch, now=now)
            counts[outcome] += 1
    return counts


def retire_photo_if_unreferenced(tx: sqlite3.Connection, photo_id: str, *, owner_id: str | None = None) -> str:
    """Retire one photo whose last record reference was just removed.

    Call inside the record-deletion transaction AFTER deleting the record row, with
    ``storage_lock()`` held. ``kept``: still needed (any record of any account may use
    it, ambiguity included) or not ours: nothing changes. ``queued``: the photo row is
    deleted, the object retired and a pending ticket created. ``blocked``: same, but
    the ticket is blocked (shared/duplicate/invalid/unsafe) and the bytes are kept for
    review. ``owner_id`` (optional) must match the photo's account, else ``kept``.
    """
    _require_lock()
    row = tx.execute("SELECT id, account_id, file_name, bytes, created_ms FROM photos WHERE id = ?", (photo_id,)).fetchone()
    if row is None:
        return "kept"
    if owner_id is not None and row["account_id"] != owner_id:
        return "kept"
    name = row["file_name"]
    if _find_record_reference(tx, photo_id, name) is not None:
        return "kept"
    block, keep = None, False
    if tx.execute("SELECT 1 FROM photos WHERE file_name = ? COLLATE NOCASE AND id != ? LIMIT 1", (name, photo_id)).fetchone():
        block, keep = "shared_file_name", True
    now = db.now_ms()
    with _directory(upload_dir()) as dir_fd:
        outcome = _create_ticket(tx, dir_fd, name=name, photo_id=photo_id, owner_id=row["account_id"],
                                 reason="last_record_unlink", epoch=_epoch(tx), now=now, block=block,
                                 keep_published=keep, created_ms=row["created_ms"], bytes_=row["bytes"])
    tx.execute("DELETE FROM photos WHERE id = ?", (photo_id,))
    return outcome


# ---------------------------------------------------------------------------
# Upload / publication
# ---------------------------------------------------------------------------


def _tombstoned(tx: sqlite3.Connection, photo_id: str) -> bool:
    if tx.execute("SELECT 1 FROM storage_objects WHERE photo_id = ? AND state IN ('retiring','retired') "
                  "AND published_ms IS NOT NULL LIMIT 1", (photo_id,)).fetchone():
        return True
    return tx.execute("SELECT 1 FROM photo_cleanup WHERE photo_id = ? AND reason != 'aborted_upload' LIMIT 1",
                      (photo_id,)).fetchone() is not None


def _reserve(account_id: str, public_id: str) -> str | None:
    """Reserve a fresh, never-used storage name. None: the photo already exists for this account."""
    now = db.now_ms()
    with db.transaction() as tx:
        account = tx.execute("SELECT is_active FROM accounts WHERE id = ?", (account_id,)).fetchone()
        if account is None or not account["is_active"]:
            raise AccountUnavailable()
        owner = tx.execute("SELECT account_id FROM photos WHERE id = ?", (public_id,)).fetchone()
        if owner is not None:
            if owner["account_id"] == account_id:
                return None
            raise PhotoIdConflict()
        if _tombstoned(tx, public_id):
            raise PhotoUnavailable("photo was deleted")
        for _ in range(8):
            name = new_object_name()
            try:
                tx.execute(
                    """INSERT INTO storage_objects (name, photo_id, owner_id, state, anomaly, bytes, origin,
                                                    created_ms, published_ms, updated_ms)
                       VALUES (?,?,?,'reserved',NULL,NULL,'upload',?,NULL,?)""",
                    (name, public_id, account_id, now, now))
                return name
            except sqlite3.IntegrityError:
                continue
    raise StorageError("could not allocate a storage name")


def _write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        view = view[written:]


def _stage_and_publish(name: str, blob: bytes) -> tuple[int, int, int]:
    """Write to the private staging directory, then publish WITHOUT overwriting.

    Raises FileExistsError if the final name is somehow taken (a foreign file is never
    replaced or removed).
    """
    with _directory(upload_dir(), create=True) as uploads_fd, _directory(staging_dir(), create=True) as staging_fd:
        fd = os.open(name, CREATE_FLAGS, 0o600, dir_fd=staging_fd)
        try:
            _write_all(fd, blob)
            os.fsync(fd)
            info = os.fstat(fd)
        finally:
            os.close(fd)
        os.fsync(staging_fd)
        _fault("publish.after_stage_write")
        os.link(name, name, src_dir_fd=staging_fd, dst_dir_fd=uploads_fd, follow_symlinks=False)
        os.fsync(uploads_fd)
        os.unlink(name, dir_fd=staging_fd)
        os.fsync(staging_fd)
        _fault("publish.after_publish")
        return info.st_dev, info.st_ino, info.st_size


def _abandon(name: str) -> None:
    """Turn a failed reservation into a durable cleanup ticket (best effort).

    If even this fails the object stays ``reserved``; the next drain reconciles it.
    """
    try:
        _unlink_staging(name)
        with db.transaction() as tx:
            row = tx.execute("SELECT photo_id, owner_id FROM storage_objects WHERE name = ? AND state = 'reserved'",
                             (name,)).fetchone()
            if row is None:
                return
            with _directory(upload_dir(), create=True) as dir_fd:
                _create_ticket(tx, dir_fd, name=name, photo_id=row["photo_id"], owner_id=row["owner_id"],
                               reason="aborted_upload", epoch=_epoch(tx), now=db.now_ms())
    except Exception:  # noqa: BLE001 - never mask the original failure
        log.warning("could not record an abandoned upload; reconciliation will", exc_info=True)


def publish_photo(blob: bytes, account_id: str, public_id: str) -> str:
    """Durably publish an already-encoded photo and insert its ``photos`` row.

    Decoding/re-encoding happens BEFORE this call, outside every lock. Returns the
    public photo id (an existing photo of the same account is returned unchanged).
    Raises ``PhotoIdConflict`` (id owned by another account), ``PhotoUnavailable``
    (the id was published and deleted: never resurrected), ``AccountUnavailable``,
    ``StorageBusy`` or ``OSError`` (nothing is left behind but a ticket/reservation).
    """
    if not isinstance(blob, (bytes, bytearray)) or not blob:
        raise ValueError("empty photo")
    if not PHOTO_ID_RE.fullmatch(public_id or ""):
        raise ValueError("invalid photo id")
    with storage_lock():
        name = None
        for _ in range(3):
            name = _reserve(account_id, public_id)
            if name is None:
                return public_id
            _flush_wal()
            _fault("publish.after_reserve")
            try:
                _stage_and_publish(name, bytes(blob))
                break
            except FileExistsError:
                # The fresh name is occupied by a file we did not create: never touch it.
                _unlink_staging(name)
                with db.transaction() as tx:
                    tx.execute("UPDATE storage_objects SET state='retired', anomaly='name_collision', updated_ms=? "
                               "WHERE name=? AND state='reserved'", (db.now_ms(), name))
                name = None
            except BaseException:
                _abandon(name)
                raise
        if name is None:
            raise StorageError("could not publish under a fresh name")
        try:
            with db.transaction() as tx:
                _fault("publish.before_row_commit")
                account = tx.execute("SELECT is_active FROM accounts WHERE id = ?", (account_id,)).fetchone()
                if account is None or not account["is_active"]:
                    raise AccountUnavailable()
                if tx.execute("SELECT 1 FROM photos WHERE id = ?", (public_id,)).fetchone():
                    raise PhotoIdConflict()
                now = db.now_ms()
                tx.execute("INSERT INTO photos (id, account_id, file_name, bytes, created_ms) VALUES (?,?,?,?,?)",
                           (public_id, account_id, name, len(blob), now))
                updated = tx.execute(
                    "UPDATE storage_objects SET state='published', published_ms=?, bytes=?, updated_ms=? "
                    "WHERE name=? AND state='reserved'", (now, len(blob), now, name))
                if updated.rowcount != 1:
                    raise StorageError("reservation was lost")
        except BaseException:
            _abandon(name)
            raise
        _fault("publish.after_row_commit")
        return public_id


# ---------------------------------------------------------------------------
# Drainer
# ---------------------------------------------------------------------------


def _set_blocked(tx: sqlite3.Connection, ticket: sqlite3.Row, reason: str, now: int) -> str:
    tx.execute("UPDATE photo_cleanup SET state='blocked', block_reason=?, attempts=attempts+1, last_error=NULL, "
               "updated_ms=? WHERE id=?", (reason, now, ticket["id"]))
    return "blocked"


def _set_retry(tx: sqlite3.Connection, ticket: sqlite3.Row, code: str, now: int) -> str:
    attempts = int(ticket["attempts"]) + 1
    tx.execute("UPDATE photo_cleanup SET attempts=?, next_attempt_ms=?, last_error=?, updated_ms=? WHERE id=?",
               (attempts, now + _backoff_ms(attempts), code, now, ticket["id"]))
    return "retry"


def _evaluate_ticket(tx: sqlite3.Connection, dir_fd: int | None, ticket: sqlite3.Row, now: int) -> str:
    """One ticket under the storage lock and a write transaction. done|blocked|retry."""
    if ticket["epoch"] != _epoch(tx):
        return _set_blocked(tx, ticket, "epoch_mismatch", now)
    name = ticket["name"]
    if not valid_object_name(name):
        return _set_blocked(tx, ticket, "invalid_file_name", now)
    registry = tx.execute("SELECT state, anomaly FROM storage_objects WHERE name = ?", (name,)).fetchone()
    if registry is None:
        return _set_blocked(tx, ticket, "unregistered_object", now)
    if registry["anomaly"]:
        return _set_blocked(tx, ticket, registry["anomaly"], now)
    if tx.execute("SELECT 1 FROM photos WHERE file_name = ? COLLATE NOCASE LIMIT 1", (name,)).fetchone():
        return _set_blocked(tx, ticket, "live_reference", now)
    if _find_record_reference(tx, ticket["photo_id"], name):
        return _set_blocked(tx, ticket, "record_reference", now)
    if dir_fd is None:
        # A missing uploads directory is NOT proof that the file is gone (e.g. an unmounted disk).
        return _set_retry(tx, ticket, "storage_unavailable", now)

    present = False
    try:
        fd = os.open(name, OPEN_FLAGS, dir_fd=dir_fd)
    except FileNotFoundError:
        pass  # a genuine ENOENT is idempotent progress (replay after unlink)
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            return _set_blocked(tx, ticket, "unsafe_file_type", now)
        return _set_retry(tx, ticket, _error_code(exc), now)
    else:
        try:
            info = os.fstat(fd)
        except OSError as exc:
            return _set_retry(tx, ticket, _error_code(exc), now)
        finally:
            os.close(fd)
        if not stat.S_ISREG(info.st_mode):
            return _set_blocked(tx, ticket, "unsafe_file_type", now)
        if info.st_nlink != 1:
            return _set_blocked(tx, ticket, "multiple_links", now)
        if ticket["dev"] is None or (_i64(info.st_dev), _i64(info.st_ino), info.st_size) != (ticket["dev"], ticket["ino"], ticket["size"]):
            return _set_blocked(tx, ticket, "identity_mismatch", now)
        present = True

    _fault("drain.before_unlink")
    if present:
        try:
            os.unlink(name, dir_fd=dir_fd)
        except FileNotFoundError:
            pass
        except OSError as exc:
            return _set_retry(tx, ticket, _error_code(exc), now)
    _fault("drain.after_unlink")
    try:
        os.fsync(dir_fd)
    except OSError:
        return _set_retry(tx, ticket, "fsync_failed", now)
    _fault("drain.after_dirsync")
    tx.execute("UPDATE photo_cleanup SET state='done', block_reason=NULL, last_error=NULL, attempts=attempts+1, "
               "done_ms=?, updated_ms=? WHERE id=?", (now, now, ticket["id"]))
    tx.execute("UPDATE storage_objects SET state='retired', updated_ms=? WHERE name=?", (now, name))
    _fault("drain.before_ack_commit")
    return "done"


def _drain_one(dir_fd: int | None, ticket_id: str) -> str:
    now = db.now_ms()
    with db.transaction() as tx:
        ticket = tx.execute("SELECT * FROM photo_cleanup WHERE id = ? AND state = 'pending'", (ticket_id,)).fetchone()
        if ticket is None:
            return "skipped"
        return _evaluate_ticket(tx, dir_fd, ticket, now)


def _note_internal_error(ticket_id: str) -> None:
    try:
        now = db.now_ms()
        with db.transaction() as tx:
            ticket = tx.execute("SELECT * FROM photo_cleanup WHERE id = ? AND state = 'pending'", (ticket_id,)).fetchone()
            if ticket is not None:
                _set_retry(tx, ticket, "internal_error", now)
    except Exception:  # noqa: BLE001
        log.warning("could not record a drain error", exc_info=True)


def _reconcile(limit: int = RECONCILE_BATCH) -> int:
    """Under the storage lock no writer can be mid-flight, so every ``reserved`` object
    is an abandoned upload intent: give it a ticket (identity captured if its file was
    published) and clear private staging leftovers."""
    reserved = db.query("SELECT name FROM storage_objects WHERE state = 'reserved' ORDER BY created_ms, name LIMIT ?", (limit,))
    created = 0
    if reserved:
        with _directory(upload_dir(), required=False) as dir_fd:
            if dir_fd is not None:
                for item in reserved:
                    _unlink_staging(item["name"])
                    with db.transaction() as tx:
                        row = tx.execute("SELECT photo_id, owner_id FROM storage_objects WHERE name = ? AND state = 'reserved'",
                                         (item["name"],)).fetchone()
                        if row is None:
                            continue
                        _create_ticket(tx, dir_fd, name=item["name"], photo_id=row["photo_id"], owner_id=row["owner_id"],
                                       reason="aborted_upload", epoch=_epoch(tx), now=db.now_ms())
                        created += 1
    _sweep_staging()
    return created


def _sweep_staging(limit: int = 500) -> int:
    """Remove lone staged files (nobody can be publishing: we hold the storage lock)."""
    fd = _open_dir(staging_dir())
    if fd is None:
        return 0
    removed = 0
    try:
        with os.scandir(fd) as entries:
            names = [entry.name for entry in entries][:limit]
        for name in names:
            try:
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    continue  # unusual entries are left alone for an operator
                os.unlink(name, dir_fd=fd)
                removed += 1
            except OSError:
                continue
        if removed:
            os.fsync(fd)
    except OSError:
        log.warning("staging sweep failed", exc_info=True)
    finally:
        os.close(fd)
    return removed


def _counts() -> dict[str, int]:
    rows = db.query("SELECT state, COUNT(*) AS n FROM photo_cleanup GROUP BY state")
    counts = {row["state"]: int(row["n"]) for row in rows}
    return {"pending": counts.get("pending", 0), "blocked": counts.get("blocked", 0), "done": counts.get("done", 0)}


def drain(max_items: int = DEFAULT_BATCH, *, lock_timeout: float | None = 2.0) -> dict[str, int]:
    """Process due cleanup tickets: a bounded batch under the storage lock.

    Returns ``{"done": n, "pending": n, "blocked": n}``: tickets completed by THIS call,
    and the totals still open afterwards. If the lock cannot be taken within
    ``lock_timeout`` seconds nothing is processed (another drainer/writer is active;
    tickets are durable and the next cycle retries). Safe to call from any thread/process.
    """
    global _last_drain_ms
    done = 0
    try:
        with storage_lock(lock_timeout):
            _flush_wal()
            _reconcile()
            started = time.monotonic()
            now = db.now_ms()
            due = db.query("SELECT id FROM photo_cleanup WHERE state = 'pending' AND next_attempt_ms <= ? "
                           "ORDER BY next_attempt_ms, created_ms, id LIMIT ?", (now, max(0, int(max_items))))
            if due:
                with _directory(upload_dir(), required=False) as dir_fd:
                    for item in due:
                        if time.monotonic() - started > DRAIN_TIME_BUDGET_S:
                            break
                        try:
                            if _drain_one(dir_fd, item["id"]) == "done":
                                done += 1
                        except Exception:  # noqa: BLE001 - one bad ticket must not starve the rest
                            log.warning("photo cleanup ticket failed unexpectedly", exc_info=True)
                            _note_internal_error(item["id"])
                _last_drain_ms = db.now_ms()
                _persist_last_drain(_last_drain_ms)
    except StorageBusy:
        pass
    return {"done": done, **{k: v for k, v in _counts().items() if k != "done"}}


def _persist_last_drain(value: int) -> None:
    try:
        with db.transaction() as tx:
            tx.execute("INSERT OR REPLACE INTO storage_meta (key, value) VALUES ('last_drain_ms', ?)", (str(value),))
    except Exception:  # noqa: BLE001
        log.debug("could not persist last drain time", exc_info=True)


class _Drainer:
    def __init__(self, interval_s: float, first_delay_s: float, batch: int) -> None:
        self.interval_s, self.first_delay_s, self.batch = interval_s, first_delay_s, batch
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self._run, name="jk-photo-drainer", daemon=True)

    def _run(self) -> None:
        try:
            if self.stop_event.wait(self.first_delay_s):
                return
            while not self.stop_event.is_set():
                try:
                    drain(self.batch, lock_timeout=0.0)
                except sqlite3.OperationalError:
                    log.debug("photo drainer waiting for the schema", exc_info=True)
                except Exception:  # noqa: BLE001
                    log.warning("photo drainer cycle failed", exc_info=True)
                if self.stop_event.wait(self.interval_s):
                    break
        finally:
            db.close_all()

    def stop(self, timeout: float = 5.0) -> None:
        self.stop_event.set()
        if self.thread.is_alive() and self.thread is not threading.current_thread():
            self.thread.join(timeout)


_drainer: _Drainer | None = None
_drainer_guard = threading.Lock()


def start_background_drainer(app: Any = None, *, interval_s: float = DRAIN_INTERVAL_S,
                             first_delay_s: float = 0.0, batch: int = DEFAULT_BATCH) -> _Drainer:
    """Start the daemon drainer thread: once at startup, then every ``interval_s`` seconds.

    Idempotent per process; the handle (``.stop()``) is also stored on
    ``app.state.photo_drainer``. Safe next to another process: it only ever takes the
    storage lock without waiting.
    """
    global _drainer
    with _drainer_guard:
        if _drainer is None or not _drainer.thread.is_alive():
            _drainer = _Drainer(interval_s, first_delay_s, batch)
            _drainer.thread.start()
        handle = _drainer
    state = getattr(app, "state", None)
    if state is not None:
        state.photo_drainer = handle
    return handle


def stop_background_drainer() -> None:
    global _drainer
    with _drainer_guard:
        handle, _drainer = _drainer, None
    if handle is not None:
        handle.stop()


# ---------------------------------------------------------------------------
# Reporting (read only)
# ---------------------------------------------------------------------------


def status() -> dict[str, Any]:
    """Cleanup backlog for the admin console. Read only; never takes the storage lock."""
    counts = _counts()
    oldest = db.query_one("SELECT MIN(created_ms) AS m FROM photo_cleanup WHERE state = 'pending'")
    reasons = db.query("SELECT COALESCE(block_reason, 'unknown') AS r, COUNT(*) AS n FROM photo_cleanup "
                       "WHERE state = 'blocked' GROUP BY r ORDER BY r")
    anomalies = db.query("SELECT anomaly AS a, COUNT(*) AS n FROM storage_objects WHERE anomaly IS NOT NULL GROUP BY a ORDER BY a")
    last = _last_drain_ms
    if last is None:
        stored = db.query_one("SELECT value FROM storage_meta WHERE key = 'last_drain_ms'")
        try:
            last = int(stored["value"]) if stored else None
        except (TypeError, ValueError):
            last = None
    return {
        "pending": counts["pending"], "blocked": counts["blocked"], "done": counts["done"],
        "oldestPendingMs": oldest["m"] if oldest else None,
        "lastDrainMs": last,
        "blockedReasons": {row["r"]: int(row["n"]) for row in reasons},
        "registryAnomalies": {row["a"]: int(row["n"]) for row in anomalies},
    }


def inventory() -> dict[str, Any]:
    """REPORT-ONLY scan of the uploads directory. Never deletes, moves, writes or reads image bytes.

    ``referenced``: files a live photo row uses. Files covered by a reservation, a
    retiring object or an open ticket are not orphans (the drainer owns them) and are
    counted in ``pendingCleanup``. ``unreferenced`` lists everything else (name, size,
    mtime only; at most 500 names, the counts are complete).
    """
    scanned = db.now_ms()
    files: list[tuple[str, int, int]] = []
    skipped = 0
    try:
        with os.scandir(upload_dir()) as entries:
            for entry in entries:
                try:
                    info = entry.stat(follow_symlinks=False)
                except OSError:
                    skipped += 1
                    continue
                if stat.S_ISREG(info.st_mode):
                    files.append((entry.name, int(info.st_size), int(info.st_mtime * 1000)))
                else:
                    skipped += 1
    except FileNotFoundError:
        pass
    # The database is read AFTER the listing so an upload that commits meanwhile is never a false orphan.
    live = {row["file_name"] for row in db.query("SELECT DISTINCT file_name FROM photos")}
    covered = {row["name"] for row in db.query("SELECT name FROM storage_objects WHERE state IN ('reserved','retiring')")}
    covered |= {row["name"] for row in db.query("SELECT name FROM photo_cleanup WHERE state != 'done'")}
    referenced = 0
    pending_cleanup = 0
    orphans: list[tuple[str, int, int]] = []
    for item in files:
        if item[0] in live:
            referenced += 1
        elif item[0] in covered:
            pending_cleanup += 1
        else:
            orphans.append(item)
    orphans.sort()
    return {
        "scannedMs": scanned,
        "files": len(files),
        "referenced": referenced,
        "unreferenced": [{"name": n, "size": s, "mtimeMs": m} for n, s, m in orphans[:500]],
        "unreferencedCount": len(orphans),
        "unreferencedBytes": sum(size for _, size, _ in orphans),
        "pendingCleanup": pending_cleanup,
        "skipped": skipped,
    }


def is_retired(file_name: str) -> bool:
    """True when the object is retiring/retired: it must never be served or reused."""
    row = db.query_one("SELECT state FROM storage_objects WHERE name = ?", (file_name,))
    return bool(row) and row["state"] in ("retiring", "retired")


# ---------------------------------------------------------------------------
# Operator review of a blocked ticket
# ---------------------------------------------------------------------------


def requeue_blocked(ticket_id: str, *, acknowledge_anomaly: bool = False) -> str:
    """Operator action AFTER reviewing a blocked ticket: re-arm it against the file as it is NOW.

    Re-captures the identity of the file currently stored under the ticket's name (must
    be a regular single-link file) and stamps the current epoch. Refused while any photo
    row or record reference still uses the name. ``acknowledge_anomaly`` additionally
    clears a duplicate/invalid-name flag on the registry object (invalid names can never
    be requeued). Returns ``"queued"``.
    """
    with storage_lock():
        with _directory(upload_dir()) as dir_fd:
            with db.transaction() as tx:
                ticket = tx.execute("SELECT * FROM photo_cleanup WHERE id = ? AND state = 'blocked'", (ticket_id,)).fetchone()
                if ticket is None:
                    raise StorageError("no such blocked ticket")
                name = ticket["name"]
                if not valid_object_name(name):
                    raise StorageError("invalid file names can only be handled by an operator by hand")
                if tx.execute("SELECT 1 FROM photos WHERE file_name = ? COLLATE NOCASE LIMIT 1", (name,)).fetchone():
                    raise StorageError("a live photo still uses this file")
                if _find_record_reference(tx, ticket["photo_id"], name):
                    raise StorageError("a record still references this file")
                registry = tx.execute("SELECT anomaly FROM storage_objects WHERE name = ?", (name,)).fetchone()
                if registry is not None and registry["anomaly"]:
                    if not acknowledge_anomaly:
                        raise StorageError("registry anomaly requires acknowledge_anomaly=True")
                    tx.execute("UPDATE storage_objects SET anomaly = NULL WHERE name = ?", (name,))
                outcome, identity = _capture_identity(dir_fd, name)
                if outcome not in ("ok", "missing"):
                    raise StorageError(outcome)
                dev, ino, size = identity if identity else (None, None, None)
                now = db.now_ms()
                tx.execute(
                    "UPDATE photo_cleanup SET state='pending', block_reason=NULL, dev=?, ino=?, size=?, epoch=?, "
                    "attempts=0, next_attempt_ms=0, last_error=NULL, updated_ms=? WHERE id=? AND state='blocked'",
                    (dev, ino, size, _epoch(tx), now, ticket_id))
                tx.execute("UPDATE storage_objects SET state='retiring', updated_ms=? WHERE name=? AND state IN ('published','reserved')",
                           (now, name))
    return "queued"


# ---------------------------------------------------------------------------
# Migration backfill (called from db.migrate() inside the schema-9 transaction)
# ---------------------------------------------------------------------------


def backfill_registry(tx: sqlite3.Connection) -> dict[str, int]:
    """Register every existing photo file as ``published``. Anomalies are REPORTED, not fixed.

    Duplicate (also case-insensitive) and invalid file names get ``anomaly`` set; any
    ticket touching them will block. No file is read, moved or renamed.
    """
    now = db.now_ms()
    groups: dict[str, list[sqlite3.Row]] = {}
    for row in tx.execute("SELECT id, account_id, file_name, bytes, created_ms FROM photos ORDER BY created_ms, id"):
        groups.setdefault(str(row["file_name"]).lower(), []).append(row)
    report = {"registered": 0, "duplicate": 0, "invalid": 0}
    for rows in groups.values():
        first = rows[0]
        name = first["file_name"]
        anomaly = None
        if len(rows) > 1:
            anomaly = "duplicate_file_name"
            report["duplicate"] += 1
        elif not valid_object_name(name):
            anomaly = "invalid_file_name"
            report["invalid"] += 1
        if anomaly == "duplicate_file_name" and not valid_object_name(name):
            report["invalid"] += 1
        inserted = tx.execute(
            """INSERT OR IGNORE INTO storage_objects (name, photo_id, owner_id, state, anomaly, bytes, origin,
                                                      created_ms, published_ms, updated_ms)
               VALUES (?,?,?,'published',?,?,'backfill',?,?,?)""",
            (name, first["id"], first["account_id"], anomaly, first["bytes"], first["created_ms"], first["created_ms"], now))
        report["registered"] += inserted.rowcount
    tx.execute("INSERT OR REPLACE INTO storage_meta (key, value) VALUES ('backfill_report', ?)", (db.to_json(report),))
    return report
