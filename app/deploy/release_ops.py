"""Coordinated SQLite/photo snapshots and administrator-only staged deployment.

No application imports, credential printing, or network authentication. Mutating
production operations require root and explicit --execute. Snapshots include .env
and must remain private; use an encrypted off-host backup separately.
"""
from __future__ import annotations

import argparse
import ast
from datetime import datetime, timezone
import hashlib
import json
import os
import fcntl
import stat
from pathlib import Path
import pwd
import re
import shutil
import sqlite3
import subprocess
import time
import urllib.request
from urllib.parse import unquote, urlsplit, quote
from html.parser import HTMLParser
import uuid

EXCLUDE = {'.git', 'venv', 'node_modules', '__pycache__', 'data', '.pytest_cache'}
APP_SERVICE = 'jagakebond.service'
NORMAL_WORKER_SERVICE = 'jagakebond-worker.service'
FAST_WORKER_SERVICE = 'jagakebond-worker-fast.service'
SERVICES = (APP_SERVICE, NORMAL_WORKER_SERVICE, FAST_WORKER_SERVICE)
STOP_ORDER = (FAST_WORKER_SERVICE, NORMAL_WORKER_SERVICE, APP_SERVICE)
START_ORDER = (APP_SERVICE, NORMAL_WORKER_SERVICE, FAST_WORKER_SERVICE)
# SQLite sidecars, the photo-storage lock file and the private upload staging directory are
# regenerable: a quiesced snapshot never needs them (stale staging files are garbage).
REGENERABLE_DATA = {'db.sqlite3-wal', 'db.sqlite3-shm', 'storage.lock', 'uploads-staging'}
STORAGE_TABLES = ('storage_meta', 'storage_objects', 'photo_cleanup')
STORAGE_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.jpg')
SERVICE_PORT = 8010
APP_VERSION = '2.1.0'
REQUIRED_ASSETS = ('app.js', 'styles.css', 'index.html', 'native-adapter.js',
                   'offline-store.js', 'offline-sync.js', 'sw.js',
                   'manifest.webmanifest')
APP_ROOT = Path('/srv/sites/jagake.bond/app')
RUNTIME_ROOT = Path('/srv/sites/jagake.bond/runtime')
RUNTIME_VENVS = RUNTIME_ROOT / 'venvs'
RELEASES_ROOT = Path('/srv/sites/jagake.bond/releases')
BACKUPS_ROOT = Path('/var/backups/jagakebond')
JOURNAL_PATH = Path('/var/lib/jagakebond/release-transaction.json')
LOCK_PATH = Path('/run/lock/jagakebond-release.lock')
RUNTIME_MANIFESTS = ('requirements.txt', 'requirements-tested.txt')


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def runtime_path_for(app_root: Path = APP_ROOT) -> Path:
    """Return the immutable runtime directory keyed by both dependency manifests."""
    app_root = Path(app_root).absolute()
    reject_symlink_ancestors(app_root)
    if app_root.is_symlink() or not app_root.is_dir():
        raise ValueError('Application root must be a real directory')
    identity = hashlib.sha256()
    for name in RUNTIME_MANIFESTS:
        manifest = app_root / name
        if manifest.is_symlink() or not manifest.is_file():
            raise ValueError(f'Required runtime manifest is missing or unsafe: {name}')
        identity.update(name.encode('ascii') + b'\0')
        identity.update(manifest.read_bytes())
    return RUNTIME_VENVS / ('sha256-' + identity.hexdigest()[:16])


def sync_dir(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def protect_artifact(path: Path) -> None:
    if os.geteuid() == 0:
        os.chown(path, 0, 0)
    path.chmod(0o700)
    sync_dir(path)


def reject_symlink_ancestors(path: Path) -> None:
    absolute = Path(os.path.abspath(path))
    current = Path(absolute.anchor)
    for part in absolute.parts[1:]:
        current /= part
        try:
            if stat.S_ISLNK(current.lstat().st_mode):
                raise ValueError(f'Symlink path component is not accepted: {current}')
        except FileNotFoundError:
            break


def validate_tree(root: Path) -> None:
    reject_symlink_ancestors(root)
    if root.is_symlink() or not root.is_dir():
        raise ValueError('Expected a real directory')
    if (root / 'venv').exists() or (root / 'venv').is_symlink():
        raise ValueError('Application trees must not contain a virtualenv; use the separately managed runtime')
    for base, dirs, files in os.walk(root, topdown=True, followlinks=False):
        for name in dirs + files:
            item = Path(base) / name
            mode = item.lstat().st_mode
            if stat.S_ISLNK(mode) or not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
                raise ValueError(f'Unsupported symlink or special file: {item}')


def sync_tree_dirs(root: Path) -> None:
    for item in sorted((p for p in root.rglob('*') if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
        sync_dir(item)
    sync_dir(root)


def copy_tree(source: Path, destination: Path, exclude: set[str] | None = None) -> None:
    if source.is_symlink():
        raise ValueError('Symlinks are not accepted in snapshots/releases')
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    for item in source.iterdir():
        if exclude and item.name in exclude:
            continue
        if item.is_symlink():
            raise ValueError('Symlinks are not accepted in snapshots/releases')
        target = destination / item.name
        if item.is_dir():
            copy_tree(item, target)
        elif item.is_file():
            shutil.copyfile(item, target)
            target.chmod(0o600 if item.name == '.env' else 0o644)
            with target.open('rb') as handle:
                os.fsync(handle.fileno())
        else:
            raise ValueError('Special files are not accepted')
    sync_dir(destination)


def _i64(value: int) -> int:
    """SQLite INTEGER is signed 64-bit while st_dev/st_ino may be unsigned 64-bit (matches backend/storage.py)."""
    value &= 0xFFFFFFFFFFFFFFFF
    return value - (1 << 64) if value >= (1 << 63) else value


def validate_storage_state(c: sqlite3.Connection) -> dict | None:
    """Photo-lifecycle consistency of a schema-9+ database; None for older schemas.

    Retiring/retired objects and pending/blocked/done tickets whose files are legitimately
    gone are NORMAL and never fail validation. What does fail: a missing/invalid storage
    epoch, or a LIVE photo row that points at a retired storage object (the pair can only
    come from a partial or foreign restore and would serve bytes that are queued for deletion).
    """
    tables = {row[0] for row in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if not set(STORAGE_TABLES) <= tables:
        return None
    row = c.execute("SELECT value FROM storage_meta WHERE key='epoch'").fetchone()
    if row is None or not str(row[0]).isdigit() or int(row[0]) < 1:
        raise ValueError('Storage epoch is missing or invalid')
    if 'photos' in tables and c.execute(
            "SELECT 1 FROM photos p JOIN storage_objects o ON o.name = p.file_name COLLATE NOCASE "
            "WHERE o.state IN ('retiring','retired') LIMIT 1").fetchone():
        raise ValueError('A live photo references a retired storage object')
    counts = {state: count for state, count in c.execute('SELECT state, COUNT(*) FROM photo_cleanup GROUP BY state')}
    summary = {name: counts.get(name, 0) for name in ('pending', 'blocked', 'done')}
    summary['reserved'] = c.execute("SELECT COUNT(*) FROM storage_objects WHERE state='reserved'").fetchone()[0]
    summary['epoch'] = int(row[0])
    return summary


def storage_summary(db_path: Path) -> dict | None:
    """Read-only photo cleanup counters of a database file (None before schema 9)."""
    with sqlite3.connect(db_path.as_uri() + '?mode=ro', uri=True) as c:
        return validate_storage_state(c)


def fence_storage_epoch(db_path: Path) -> int | None:
    """Restore tooling: bump the storage epoch of a RESTORED database.

    Cleanup tickets inside a restored snapshot were captured against another copy of the
    files (other inodes, possibly another generation). With a newer epoch the application
    drainer blocks every one of them instead of deleting anything, until an operator has
    reviewed it (see RELEASE-RUNBOOK.md). Returns the new epoch, None before schema 9.
    """
    connection = sqlite3.connect(db_path)
    try:
        with connection:
            tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if not set(STORAGE_TABLES) <= tables:
                return None
            connection.execute("UPDATE storage_meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key='epoch'")
            return int(connection.execute("SELECT value FROM storage_meta WHERE key='epoch'").fetchone()[0])
    finally:
        connection.close()


def rebind_storage_tickets(source_data: Path, candidate_data: Path) -> dict:
    """Deploy only: keep PENDING cleanup tickets valid across the copy of the upload files.

    The candidate tree holds byte-identical COPIES (new inodes) of the quiesced live files.
    For every pending ticket whose LIVE source file still matches the identity captured in
    the ticket (regular, one link, same device/inode/size), re-capture the identity of the
    candidate copy (regular, one link, same size). Everything else (no identity, mismatch,
    blocked tickets) is left untouched: the drainer then blocks or finishes it on its own.
    Never raises for a database without the storage tables or on an I/O problem.
    """
    result = {'rebound': 0, 'skipped': 0}
    try:
        connection = sqlite3.connect(candidate_data / 'db.sqlite3')
    except sqlite3.Error:
        return result
    try:
        with connection:
            tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if not set(STORAGE_TABLES) <= tables:
                return result
            pending = connection.execute(
                "SELECT id, name, dev, ino, size FROM photo_cleanup WHERE state='pending' AND dev IS NOT NULL").fetchall()
            for ticket_id, name, dev, ino, size in pending:
                try:
                    if not STORAGE_NAME.fullmatch(name):
                        raise ValueError('invalid name')
                    live = os.lstat(source_data / 'uploads' / name)
                    copy = os.lstat(candidate_data / 'uploads' / name)
                    if (not stat.S_ISREG(live.st_mode) or live.st_nlink != 1
                            or (_i64(live.st_dev), _i64(live.st_ino), live.st_size) != (dev, ino, size)
                            or not stat.S_ISREG(copy.st_mode) or copy.st_nlink != 1 or copy.st_size != size):
                        raise ValueError('identity differs')
                except (OSError, ValueError):
                    result['skipped'] += 1
                    continue
                connection.execute("UPDATE photo_cleanup SET dev=?, ino=?, size=? WHERE id=? AND state='pending'",
                                   (_i64(copy.st_dev), _i64(copy.st_ino), copy.st_size, ticket_id))
                result['rebound'] += 1
    except sqlite3.Error:
        pass
    finally:
        connection.close()
    return result


def validate_database(db_path: Path, uploads: Path) -> None:
    with sqlite3.connect(db_path.as_uri() + '?mode=ro', uri=True) as c:
        if c.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise ValueError('SQLite integrity check failed')
        if c.execute('PRAGMA foreign_key_check').fetchone():
            raise ValueError('SQLite foreign key check failed')
        if c.execute("SELECT 1 FROM sqlite_master WHERE name='photos'").fetchone():
            for (name,) in c.execute('SELECT file_name FROM photos'):
                if not isinstance(name, str) or Path(name).name != name or name in {'.', '..'}:
                    raise ValueError('Unsafe photo filename in database')
                if not (uploads / name).is_file() or (uploads / name).is_symlink():
                    raise ValueError('Snapshot is missing a referenced photo')
        validate_storage_state(c)


def create_snapshot(source: Path, backups: Path, *, quiesced: bool) -> Path:
    if not quiesced:
        raise ValueError('Stop application and worker before coordinated DB/photo snapshot')
    reject_symlink_ancestors(source)
    reject_symlink_ancestors(backups)
    source, backups = source.absolute(), backups.absolute()
    validate_tree(source)
    if not (source / 'data/db.sqlite3').is_file():
        raise ValueError('Existing database required; refusing first-install guess')
    if backups.is_relative_to(source):
        raise ValueError('Backups must be outside application tree')
    backups.mkdir(parents=True, exist_ok=True, mode=0o700)
    backups.chmod(0o700)
    name = 'jk-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8]
    partial, final = backups / (name + '.partial'), backups / name
    partial.mkdir(mode=0o700)
    try:
        copy_tree(source, partial / 'code', EXCLUDE)
        (partial / 'data').mkdir(mode=0o700)
        # Preserve every data entry except SQLite's documented regenerable sidecars.
        for entry in (source / 'data').iterdir():
            if entry.name in REGENERABLE_DATA:
                continue
            destination = partial / 'data' / entry.name
            if entry.name == 'db.sqlite3':
                continue
            if entry.is_dir():
                copy_tree(entry, destination)
            elif entry.is_file():
                shutil.copyfile(entry, destination)
                destination.chmod(0o600)
                with destination.open('rb') as handle:
                    os.fsync(handle.fileno())
        with sqlite3.connect((source / 'data/db.sqlite3').as_uri() + '?mode=ro', uri=True) as incoming:
            with sqlite3.connect(partial / 'data/db.sqlite3') as outgoing:
                incoming.backup(outgoing)
        validate_database(partial / 'data/db.sqlite3', partial / 'data/uploads')
        files = {str(p.relative_to(partial)): digest(p) for p in sorted(partial.rglob('*')) if p.is_file()}
        manifest = partial / 'snapshot.json'
        manifest.write_text(json.dumps({'format': 1, 'files': files}, indent=2))
        manifest.chmod(0o600)
        for p in partial.rglob('*'):
            if p.is_file():
                with p.open('rb') as handle:
                    os.fsync(handle.fileno())
        sync_tree_dirs(partial)
        partial.rename(final)
        sync_dir(backups)
        return final
    except BaseException:
        shutil.rmtree(partial, ignore_errors=True)
        raise


def verify_snapshot(snapshot: Path) -> None:
    reject_symlink_ancestors(snapshot)
    snapshot = snapshot.absolute()
    validate_tree(snapshot)
    manifest_path = snapshot / 'snapshot.json'
    if not manifest_path.is_file() or manifest_path.is_symlink():
        raise ValueError('Snapshot manifest missing or unsafe')
    data = json.loads(manifest_path.read_text())
    if data.get('format') != 1 or not isinstance(data.get('files'), dict):
        raise ValueError('Unsupported snapshot format')
    actual = {str(p.relative_to(snapshot)) for p in snapshot.rglob('*') if p.is_file() and p != manifest_path}
    if actual != set(data['files']):
        raise ValueError('Snapshot contains missing or unexpected files')
    for rel, expected in data['files'].items():
        rel_path = Path(rel)
        path = snapshot / rel_path
        if not isinstance(rel, str) or rel_path.is_absolute() or not rel_path.parts or '..' in rel_path.parts or str(rel_path) != rel:
            raise ValueError('Unsafe snapshot path')
        if digest(path) != expected:
            raise ValueError('Snapshot checksum mismatch')
    validate_database(snapshot / 'data/db.sqlite3', snapshot / 'data/uploads')


def restore_snapshot(snapshot: Path, target: Path) -> None:
    verify_snapshot(snapshot)
    reject_symlink_ancestors(target)
    if target.exists() and (target.is_symlink() or any(target.iterdir())):
        raise ValueError('Restore target must be empty')
    target.mkdir(parents=True, exist_ok=True, mode=0o700)
    copy_tree(snapshot / 'code', target)
    copy_tree(snapshot / 'data', target / 'data')
    fence_storage_epoch(target / 'data/db.sqlite3')
    validate_database(target / 'data/db.sqlite3', target / 'data/uploads')


def prepare_tree_copy(source: Path, destination: Path) -> None:
    """Fully stage a copy beside its eventual destination before publication."""
    validate_tree(source)
    if destination.exists():
        raise ValueError('Staging destination already exists')
    copy_tree(source, destination)
    sync_tree_dirs(destination)


def overlay_release(incoming: Path, candidate: Path) -> None:
    """Replace only staged code in a private candidate; preserve its data and environment."""
    validate_tree(incoming)
    if not all((incoming / name).is_dir() for name in ('backend', 'frontend', 'worker')):
        raise ValueError('Incomplete application release')
    preserve = {'data', '.env'}
    for item in candidate.iterdir():
        if item.name not in preserve:
            if item.is_dir(): shutil.rmtree(item)
            else: item.unlink()
    for item in incoming.iterdir():
        if item.name in preserve: continue
        destination = candidate / item.name
        if item.is_dir(): copy_tree(item, destination)
        elif item.is_file():
            shutil.copyfile(item, destination)
            with destination.open('rb') as handle: os.fsync(handle.fileno())
    sync_tree_dirs(candidate)


def source_version(release: Path) -> str:
    version_file = release / 'backend/version.py'
    if version_file.is_file():
        module = ast.parse(version_file.read_text(encoding='utf-8'))
        values = [node.value.value for node in module.body if isinstance(node, ast.Assign)
                  and any(isinstance(t, ast.Name) and t.id == 'APP_VERSION' for t in node.targets)
                  and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str)]
    else:
        # First rollback may restore the pre-version-module application.
        module = ast.parse((release / 'backend/app.py').read_text(encoding='utf-8'))
        values = [kw.value.value for node in ast.walk(module) if isinstance(node, ast.Call)
                  and isinstance(node.func, ast.Name) and node.func.id == 'FastAPI'
                  for kw in node.keywords if kw.arg == 'version' and isinstance(kw.value, ast.Constant)
                  and isinstance(kw.value.value, str)]
    if len(values) != 1 or not re.fullmatch(r'\d+\.\d+(?:\.\d+)?', values[0]):
        raise ValueError('Release version must be one explicit numeric version')
    return values[0]


def release_version(release: Path) -> str:
    """Return the human-facing app release, distinct from the API protocol version."""
    version_file = release / 'backend/version.py'
    if version_file.is_file():
        module = ast.parse(version_file.read_text(encoding='utf-8'))
        values = [node.value.value for node in module.body if isinstance(node, ast.Assign)
                  and any(isinstance(t, ast.Name) and t.id == 'RELEASE_VERSION' for t in node.targets)
                  and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str)]
        if len(values) == 1 and re.fullmatch(r'\d+(?:\.\d+){2,3}', values[0]):
            return values[0]
    return source_version(release)


def frontend_inventory(frontend: Path) -> tuple[str, ...]:
    """Verify local HTML/CSS/manifest/worker references, return every public file."""
    inventory = tuple(sorted(p.relative_to(frontend).as_posix() for p in frontend.rglob('*') if p.is_file()))
    def require(raw: str, base: Path) -> None:
        parsed = urlsplit(raw.strip())
        if parsed.scheme or parsed.netloc or not parsed.path:
            return
        path = unquote(parsed.path)
        if '..' in Path(path).parts or '\\' in path:
            raise ValueError('Unsafe local asset reference')
        item = frontend / path.lstrip('/') if path.startswith('/') else base / path
        if path == '/': item = frontend / 'index.html'
        if not item.is_relative_to(frontend) or not item.is_file() or item.is_symlink():
            raise ValueError('Missing or unsafe referenced local frontend asset: ' + raw)
    class References(HTMLParser):
        def handle_starttag(self, tag, attrs):
            for name, value in attrs:
                if name in {'src','href','poster'} and value: require(value, frontend)
    References().feed((frontend / 'index.html').read_text(encoding='utf-8'))
    for css in frontend.rglob('*.css'):
        pattern = r'url\(\s*(?:"([^"]*)"|\x27([^\x27]*)\x27|([^)]*))\s*\)'
        for parts in re.findall(pattern, css.read_text(encoding='utf-8')):
            require(next((part for part in parts if part), ''), css.parent)
    manifest = json.loads((frontend / 'manifest.webmanifest').read_text(encoding='utf-8'))
    for icon in manifest.get('icons', []): require(icon['src'], frontend)
    worker = (frontend / 'sw.js').read_text(encoding='utf-8')
    cache_list = re.search(r'const\s+SHELL_ASSETS\s*=\s*(\[[\s\S]*?\]);', worker)
    if cache_list:
        for ref in ast.literal_eval(cache_list.group(1)): require(ref, frontend)
    return inventory


def validate_release_source(release: Path, reference: Path | None = None) -> None:
    """Validate source syntax, release identity and static offline assets."""
    for source in release.rglob('*.py'):
        if '__pycache__' in source.parts:
            continue
        try:
            ast.parse(source.read_text(encoding='utf-8'), filename=str(source))
        except (OSError, UnicodeError, SyntaxError) as exc:
            raise ValueError(f'Invalid Python source: {source.relative_to(release)}') from exc
    try:
        version = source_version(release)
    except (OSError, UnicodeError, SyntaxError) as exc:
        raise ValueError('Release version source is missing or invalid') from exc
    if version != APP_VERSION:
        raise ValueError(f'Release must declare APP_VERSION {APP_VERSION}')
    frontend = release / 'frontend'
    for name in REQUIRED_ASSETS:
        asset = frontend / name
        if not asset.is_file() or asset.is_symlink():
            raise ValueError(f'Release is missing required frontend asset: {name}')
    frontend_inventory(frontend)
    vendor = frontend / 'vendor'
    if vendor.exists() and (vendor.is_symlink() or not vendor.is_dir()):
        raise ValueError('Release vendor path is unsafe')
    if vendor.is_dir() and not any(p.is_file() and not p.is_symlink() for p in vendor.rglob('*')):
        raise ValueError('Release vendor assets are missing')


def validate_installed_dependencies(candidate: Path, run_command, *, runtime_path: Path | None = None) -> None:
    """Check declared package constraints under the service-account interpreter."""
    runtime = approved_runtime(runtime_path)
    req = candidate / 'requirements.txt'
    if not req.is_file() or req.is_symlink():
        raise ValueError('Release requirements.txt is missing or unsafe')
    code = '''from importlib.metadata import version
from pip._vendor.packaging.requirements import Requirement
from pathlib import Path
for line in Path("requirements.txt").read_text().splitlines():
    line = line.split("#", 1)[0].strip()
    if not line:
        continue
    requirement = Requirement(line)
    if requirement.marker is not None and not requirement.marker.evaluate():
        continue
    if requirement.url or version(requirement.name) not in requirement.specifier:
        raise RuntimeError("Installed dependency mismatch: " + requirement.name)
import fastapi, uvicorn, multipart, httpx, PIL, cryptography, sqlite3
'''
    run_command('runuser', '-u', 'jagakebond', '--', str(runtime / 'bin/python'), '-m', 'pip', 'check', cwd=candidate)
    run_command('runuser', '-u', 'jagakebond', '--', str(runtime / 'bin/python'), '-c', code, cwd=candidate)


def validate_restore_compatibility(snapshot: Path, current: Path) -> None:
    for name in RUNTIME_MANIFESTS:
        old, now = snapshot / 'code' / name, current / name
        if not old.is_file() or not now.is_file() or old.read_bytes() != now.read_bytes():
            raise ValueError(f'Snapshot requirements differ from the installed runtime ({name}); restore needs a separately prepared compatible runtime')


def validate_release_location(incoming: Path) -> Path:
    """Accept only a named immutable release folder in the canonical release store."""
    incoming = Path(incoming).absolute()
    reject_symlink_ancestors(incoming)
    if incoming.parent != RELEASES_ROOT:
        raise ValueError(f'Release must be a direct child of {RELEASES_ROOT}')
    validate_tree(incoming)
    if incoming.name != release_version(incoming):
        raise ValueError('Release directory name must exactly match the application version')
    for item in (incoming, *incoming.rglob('*')):
        info = item.lstat()
        if info.st_mode & 0o022:
            raise ValueError('Release files must not be writable by group or other users')
        if os.geteuid() == 0 and info.st_uid != 0:
            raise ValueError('Release files must be owned by root')
    return incoming


def stage_restore(snapshot: Path, current: Path, candidate: Path, *, runtime_path: Path | None = None) -> None:
    """Build a complete restore candidate before stopping either service."""
    verify_snapshot(snapshot)
    validate_tree(current)
    validate_restore_compatibility(snapshot, current)
    validate_release_source(snapshot / 'code', current)
    approved_runtime(runtime_path, app_root=current)
    candidate.mkdir(mode=0o700)
    copy_tree(snapshot / 'code', candidate)
    copy_tree(snapshot / 'data', candidate / 'data')
    for name in ('.env',):
        source = current / name
        if source.exists():
            shutil.copyfile(source, candidate / name)
    fence_storage_epoch(candidate / 'data/db.sqlite3')
    validate_database(candidate / 'data/db.sqlite3', candidate / 'data/uploads')
    sync_tree_dirs(candidate)


def publish_tree(candidate: Path, target: Path, journal: Path) -> None:
    """Two-rename publication with durable recovery evidence and no deletion."""
    reject_symlink_ancestors(target)
    validate_tree(candidate)
    if candidate.parent != target.parent:
        raise ValueError('Candidate and target must share a parent/filesystem')
    old = target.with_name(target.name + '.previous-' + uuid.uuid4().hex)
    if journal.exists() or journal.is_symlink():
        raise RuntimeError('Publication journal already exists; recover it before starting')
    record = {'target': str(target), 'candidate': str(candidate), 'old': str(old), 'phase': 'prepared'}
    journal.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    journal.parent.chmod(0o700)
    write_journal(journal, record)
    target.rename(old)
    protect_artifact(old)
    sync_dir(target.parent)
    record['phase'] = 'old-renamed'
    write_journal(journal, record)
    try:
        candidate.rename(target)
        sync_dir(target.parent)
        record['phase'] = 'published'
        write_journal(journal, record)
    except BaseException:
        if not target.exists() and old.exists():
            old.rename(target)
            sync_dir(target.parent)
        raise


def write_journal(journal: Path, record: dict) -> None:
    """Atomically replace a private, durable transaction record."""
    temporary = journal.with_name(journal.name + '.tmp-' + uuid.uuid4().hex)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        payload = (json.dumps(record, sort_keys=True) + '\n').encode()
        with os.fdopen(fd, 'wb') as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, journal)
        sync_dir(journal.parent)
    except BaseException:
        try: temporary.unlink()
        except FileNotFoundError: pass
        raise


def recover_publication(journal: Path, expected_target: Path | None = None) -> str:
    """Idempotently restore old tree if publication was interrupted mid-swap."""
    if not journal.exists():
        return 'No interrupted publication journal'
    info = journal.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
        raise RuntimeError('Unsafe transaction journal permissions or type')
    record = json.loads(journal.read_text())
    if set(record) != {'target', 'candidate', 'old', 'phase'} or record['phase'] not in {'prepared', 'old-renamed', 'published'}:
        raise RuntimeError('Malformed transaction journal')
    target, candidate, old = (Path(record[key]) for key in ('target', 'candidate', 'old'))
    if expected_target is not None and target != expected_target:
        raise RuntimeError('Journal target does not match fixed deployment target')
    if candidate.parent != target.parent or old.parent != target.parent or not candidate.name.startswith(target.name + '.candidate-') or not old.name.startswith(target.name + '.previous-'):
        raise RuntimeError('Journal paths are not exact sibling transaction paths')
    for path in (target, candidate, old):
        reject_symlink_ancestors(path)
        if path.exists(): validate_tree(path)
    if old.exists():
        if target.exists():
            failed = target.with_name(target.name + '.failed-' + uuid.uuid4().hex)
            target.rename(failed)
            protect_artifact(failed)
            sync_dir(target.parent)
        old.rename(target)
        sync_dir(target.parent)
    elif not target.exists():
        raise RuntimeError('No old or target tree available; manual recovery required')
    if candidate.exists():
        shutil.rmtree(candidate)
        sync_dir(candidate.parent)
    return 'Previous tree restored from publication journal'


def acknowledge_recovery(journal: Path) -> None:
    """Remove recovery evidence only after restored service health is verified."""
    if journal.exists():
        journal.unlink()
        sync_dir(journal.parent)


def approved_runtime(runtime_path: Path | None = None, *, app_root: Path = APP_ROOT) -> Path:
    """Validate the single administrator-managed runtime used by services and releases."""
    expected = runtime_path_for(app_root) if runtime_path is None else Path(runtime_path).absolute()
    if not expected.is_absolute():
        raise ValueError('Unapproved runtime path')
    reject_symlink_ancestors(expected)
    if expected.is_symlink() or not expected.is_dir():
        raise ValueError('Approved runtime is missing or unsafe; prepare it as administrator before deployment')
    python = expected / 'bin/python'
    if python.is_symlink() or not python.is_file() or not os.access(python, os.X_OK):
        raise ValueError('Approved external venv interpreter is not executable')
    return expected


def acquire_lock(lock_path: Path):
    reject_symlink_ancestors(lock_path)
    lock_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        raise RuntimeError('Another deployment/restore transaction is active')
    return fd


def capacity_preflight(path: Path, required_bytes: int, *, required_inodes: int = 128) -> None:
    stats = os.statvfs(path)
    if stats.f_bavail * stats.f_frsize < required_bytes or stats.f_favail < required_inodes:
        raise RuntimeError('Insufficient free space/inodes for staging and recovery')


def tree_bytes(root: Path) -> int:
    total = 0
    for base, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = [name for name in dirs if name not in {'venv','node_modules','__pycache__','.git'} and not (Path(base)/name).is_symlink()]
        total += sum((Path(base)/name).lstat().st_size for name in files if not (Path(base)/name).is_symlink())
    return total


def tree_entries(root: Path) -> int:
    total = 1
    for base, dirs, files in os.walk(root,followlinks=False):
        dirs[:] = [name for name in dirs if name not in {'venv','node_modules','__pycache__','.git'} and not (Path(base)/name).is_symlink()]
        total += len(dirs) + len(files)
    return total


def transaction_capacity(target: Path, incoming: Path, backups: Path) -> None:
    reject_symlink_ancestors(backups)
    backup_mount = backups
    while not backup_mount.exists(): backup_mount = backup_mount.parent
    current, new = tree_bytes(target), tree_bytes(incoming)
    reserve = 64 * 1024 * 1024
    staging_need = current * 2 + new + reserve
    backup_need = current * 2 + reserve
    current_entries, new_entries = tree_entries(target), tree_entries(incoming)
    staging_inodes = current_entries * 2 + new_entries + 256
    backup_inodes = current_entries * 2 + 256
    shared = target.parent.stat().st_dev == backup_mount.stat().st_dev
    capacity_preflight(target.parent, staging_need + (backup_need if shared else 0),
                       required_inodes=staging_inodes + (backup_inodes if shared else 0))
    capacity_preflight(backup_mount, backup_need + (staging_need if shared else 0),
                       required_inodes=backup_inodes + (staging_inodes if shared else 0))


def deploy_transaction(target: Path, incoming: Path, backups: Path, journal: Path, *,
                       service_stop=None, service_start=None, run_command=None,
                       apply_permissions=None, readback=None, forensic_copy=True,
                       dependency_check=None, runtime_path: Path | None = None) -> Path:
    """Deploy a release with real filesystem/SQLite semantics and injectable host effects."""
    service_stop = service_stop or stop_services
    service_start = service_start or start_services
    run_command = run_command or run
    apply_permissions = apply_permissions or permissions
    readback = readback or check_served_assets
    target, incoming, backups, journal = (Path(p).absolute() for p in (target, incoming, backups, journal))
    if journal.exists():
        raise RuntimeError('Publication journal already exists; recover it before starting')
    validate_tree(target)
    validate_tree(incoming)
    if not all((incoming / n).is_dir() for n in ('backend', 'frontend', 'worker')):
        raise ValueError('Incomplete application release')
    for name in RUNTIME_MANIFESTS:
        if (not (incoming / name).is_file() or not (target / name).is_file()
                or (incoming / name).is_symlink() or (target / name).is_symlink()
                or (incoming / name).read_bytes() != (target / name).read_bytes()):
            raise ValueError(f'Release runtime manifests changed ({name}); prepare and review a compatible immutable runtime first')
    validate_release_source(incoming, target)
    runtime = approved_runtime(runtime_path, app_root=target)
    if dependency_check is None:
        dependency_check = lambda tree, runner: validate_installed_dependencies(
            tree, runner, runtime_path=runtime)
    transaction_capacity(target,incoming,backups)
    candidate = target.with_name(target.name + '.candidate-' + uuid.uuid4().hex)
    copy_tree(target, candidate, {'data'})
    overlay_release(incoming, candidate)
    apply_permissions(candidate)
    dependency_check(candidate, run_command)
    try:
        service_stop()
    except BaseException as stop_error:
        try:
            service_start()
        except BaseException as recovery_error:
            raise RuntimeError(f'Deployment stop failed ({stop_error}); CRITICAL restart incomplete: {recovery_error}') from stop_error
        raise
    try:
        snapshot = create_snapshot(target, backups, quiesced=True)
    except BaseException as snapshot_error:
        try:
            service_start()
        except BaseException as recovery_error:
            raise RuntimeError(f'Snapshot failed ({snapshot_error}); CRITICAL restart incomplete: {recovery_error}') from snapshot_error
        raise
    try:
        # Replace the staged database with the quiesced, transactionally backed-up copy.
        shutil.rmtree(candidate / 'data', ignore_errors=True)
        copy_tree(snapshot / 'data', candidate / 'data')
        rebind_storage_tickets(target / 'data', candidate / 'data')
        apply_permissions(candidate)
        run_command('runuser', '-u', 'jagakebond', '--', str(runtime / 'bin/python'),
                    '-c', 'from backend import db; db.migrate()', cwd=candidate)
        sync_tree_dirs(candidate)
        publish_tree(candidate, target, journal)
        service_start()
        readback(target)
        journal.unlink()
        sync_dir(journal.parent)
        return snapshot
    except BaseException as failure:
        try:
            service_stop()
            if journal.exists():
                recover_publication(journal, expected_target=target)
            apply_permissions(target)
            service_start()
            readback(target)
            acknowledge_recovery(journal)
        except BaseException as recovery_error:
            raise RuntimeError(f'Deployment failed ({failure}); CRITICAL recovery incomplete; preserve journal and trees: {recovery_error}') from failure
        if forensic_copy:
            try:
                forensic = backups / ('failed-state-' + uuid.uuid4().hex)
                forensic.mkdir(parents=True, mode=0o700)
                copy_tree(target, forensic / 'tree')
            except BaseException:
                pass  # Forensics are optional and never gate recovery.
        raise


def restore_transaction(target: Path, snapshot: Path, backups: Path, journal: Path, *,
                        service_stop=None, service_start=None, apply_permissions=None,
                        readback=None, forensic_copy=True, runtime_path: Path | None = None,
                        dependency_check=None, run_command=None) -> Path:
    """Restore a verified snapshot while retaining current state and rollback evidence."""
    service_stop = service_stop or stop_services
    service_start = service_start or start_services
    run_command = run_command or run
    apply_permissions = apply_permissions or permissions
    readback = readback or check_served_assets
    target, snapshot, backups, journal = (Path(p).absolute() for p in (target, snapshot, backups, journal))
    if journal.exists():
        raise RuntimeError('Publication journal already exists; recover it before starting')
    runtime = approved_runtime(runtime_path, app_root=target)
    if dependency_check is None:
        dependency_check = lambda tree, runner: validate_installed_dependencies(
            tree, runner, runtime_path=runtime)
    verify_snapshot(snapshot)
    transaction_capacity(target,snapshot,backups)
    candidate = target.with_name(target.name + '.candidate-' + uuid.uuid4().hex)
    stage_restore(snapshot, target, candidate, runtime_path=runtime_path)
    apply_permissions(candidate)
    dependency_check(candidate,run_command)
    try:
        service_stop()
    except BaseException as stop_error:
        try:
            service_start()
        except BaseException as recovery_error:
            raise RuntimeError(f'Restore stop failed ({stop_error}); CRITICAL restart incomplete: {recovery_error}') from stop_error
        raise
    try:
        retained = create_snapshot(target, backups, quiesced=True)
    except BaseException as snapshot_error:
        try:
            service_start()
        except BaseException as recovery_error:
            raise RuntimeError(f'Restore snapshot failed ({snapshot_error}); CRITICAL restart incomplete: {recovery_error}') from snapshot_error
        raise
    try:
        publish_tree(candidate, target, journal)
        service_start()
        readback(target)
        journal.unlink()
        sync_dir(journal.parent)
        return retained
    except BaseException as failure:
        try:
            service_stop()
            if journal.exists():
                recover_publication(journal, expected_target=target)
            apply_permissions(target)
            service_start()
            readback(target)
            acknowledge_recovery(journal)
        except BaseException as recovery_error:
            raise RuntimeError(f'Restore failed ({failure}); CRITICAL recovery incomplete; preserve journal and trees: {recovery_error}') from failure
        if forensic_copy:
            try:
                forensic = backups / ('failed-state-' + uuid.uuid4().hex)
                forensic.mkdir(parents=True, mode=0o700)
                copy_tree(target, forensic / 'tree')
            except BaseException:
                pass
        raise


def validate_service_configuration(app_root: Path = APP_ROOT,
                                   runtime_venv: Path | None = None) -> None:
    """Refuse operations unless all writers share the reviewed app and runtime roots."""
    app_root = Path(app_root).absolute()
    runtime_venv = approved_runtime(runtime_venv, app_root=app_root)
    expected_env = str(app_root / '.env')
    expected_data = str(app_root / 'data')
    runtime_bin = str(runtime_venv / 'bin')
    for service in SERVICES:
        result = subprocess.run(
            ['systemctl', 'show', service,
             '--property=User,Group,WorkingDirectory,ExecStart,EnvironmentFiles,ReadWritePaths,Environment'],
            capture_output=True, text=True, check=True)
        properties = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
        command = properties.get('ExecStart', '')
        if (properties.get('User') != 'jagakebond'
                or properties.get('Group') != 'jagakebond'
                or properties.get('WorkingDirectory') != str(app_root)
                or expected_env not in properties.get('EnvironmentFiles', '')
                or runtime_bin not in command):
            raise RuntimeError(f'{service} does not use the reviewed app, environment, and runtime paths')
        if service == APP_SERVICE:
            tokens = command.split()
            port_index = tokens.index('--port') if '--port' in tokens else -1
            host_index = tokens.index('--host') if '--host' in tokens else -1
            workers_index = tokens.index('--workers') if '--workers' in tokens else -1
            expected_argv = (f'{runtime_bin}/uvicorn backend.app:app --host 127.0.0.1 '
                             f'--port {SERVICE_PORT} --workers 1 --proxy-headers '
                             '--forwarded-allow-ips=127.0.0.1')
            if (port_index < 0 or tokens[port_index + 1:port_index + 2] != [str(SERVICE_PORT)]
                    or host_index < 0 or tokens[host_index + 1:host_index + 2] != ['127.0.0.1']
                    or workers_index < 0 or tokens[workers_index + 1:workers_index + 2] != ['1']
                    or properties.get('ReadWritePaths') != expected_data
                    or expected_argv not in command):
                raise RuntimeError('API service bind, worker count, or writable data path is not the reviewed configuration')
        else:
            expected_worker_argv = f'{runtime_bin}/python -u worker/gemini_worker.py'
            if (expected_worker_argv not in command
                    or properties.get('ReadWritePaths', '')
                    or (service == FAST_WORKER_SERVICE
                        and 'WORKER_LANE=fast' not in properties.get('Environment', ''))
                    or (service == NORMAL_WORKER_SERVICE
                        and 'WORKER_LANE=fast' in properties.get('Environment', ''))):
                raise RuntimeError(f'{service} does not use the reviewed worker command, lane, or write permissions')


def run(*command: str, cwd: Path | None = None) -> None:
    subprocess.run(command, cwd=cwd, check=True)


def stop_services() -> None:
    # Stop writers serially so the fast and normal queues are quiesced before the API.
    for service in STOP_ORDER:
        run('systemctl', 'stop', service)
        result = subprocess.run(['systemctl', 'is-active', service], capture_output=True, text=True)
        state = result.stdout.strip()
        if state not in {'inactive', 'failed'}:
            raise RuntimeError(f'Could not quiesce service {service}')


def start_services() -> None:
    # Bring the API up before either worker can submit results to it.
    for service in START_ORDER:
        run('systemctl', 'start', service)
        result = subprocess.run(['systemctl', 'is-active', service], capture_output=True, text=True)
        if result.returncode != 0 or result.stdout.strip() != 'active':
            raise RuntimeError(f'Could not confirm service {service} is active')
        if service == APP_SERVICE:
            wait_for_api()


def wait_for_api(timeout_seconds: int = 45) -> None:
    """Do not start either queue consumer until the new API answers for its source tree."""
    expected = source_version(APP_ROOT)
    deadline = time.monotonic() + timeout_seconds
    last_error: BaseException | None = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{SERVICE_PORT}/api/health', timeout=3) as response:
                health = json.load(response)
            if health.get('ok') and health.get('version') == expected:
                return
            last_error = ValueError('API health version does not match the published source tree')
        except (OSError, ValueError) as exc:
            last_error = exc
        time.sleep(1)
    raise RuntimeError('API did not become healthy; workers were kept stopped') from last_error


def recover_transaction(target: Path, journal: Path) -> str:
    """Restore a journaled publication and retain evidence until health readback passes."""
    try:
        stop_services()
    except BaseException as stop_error:
        try:
            start_services()
        except BaseException as recovery_error:
            raise RuntimeError(f'Recovery stop failed ({stop_error}); CRITICAL restart incomplete: {recovery_error}') from stop_error
        raise
    started = False
    try:
        message = recover_publication(journal, expected_target=target)
        permissions(target)
        start_services()
        started = True
        check_served_assets(target)
        acknowledge_recovery(journal)
        return message
    except BaseException as failure:
        if not started:
            try:
                start_services()
            except BaseException as recovery_error:
                raise RuntimeError(f'Recovery failed ({failure}); CRITICAL restart incomplete; preserve journal and trees: {recovery_error}') from failure
        raise


def permissions(target: Path) -> None:
    account = pwd.getpwnam('jagakebond')
    os.chown(target, 0, account.pw_gid)
    target.chmod(0o755)
    for item in target.iterdir():
        if item.name == 'data':
            for p in [item, *item.rglob('*')]:
                if p.is_symlink():
                    raise ValueError('Unexpected data symlink')
                os.chown(p, account.pw_uid, account.pw_gid)
                p.chmod(0o700 if p.is_dir() else 0o600)
        elif item.name == '.env':
            os.chown(item, 0, account.pw_gid)
            item.chmod(0o640)
        else:
            for p in [item, *item.rglob('*')] if item.is_dir() else [item]:
                if p.is_symlink():
                    raise ValueError('Unexpected source symlink')
                os.chown(p, 0, account.pw_gid)
                p.chmod(0o755 if p.is_dir() else 0o644)


def check_served_assets(target: Path) -> None:
    base = f'http://127.0.0.1:{SERVICE_PORT}'
    version = source_version(target)
    assets = frontend_inventory(target / 'frontend')
    last_error = None
    for _ in range(30):
        try:
            with urllib.request.urlopen(base + '/api/health', timeout=3) as r:
                health = json.load(r)
                if not health.get('ok') or health.get('version') != version:
                    raise ValueError('Health not OK')
            for name in assets:
                if not (target / 'frontend' / name).is_file():
                    raise ValueError('Release is missing required frontend asset')
                with urllib.request.urlopen(base + '/' + quote(name), timeout=3) as r:
                    actual = hashlib.sha256(r.read()).hexdigest()
                if actual != digest(target / 'frontend' / name):
                    raise ValueError('Served frontend asset does not match release')
            return
        except (OSError, ValueError) as exc:
            last_error = exc
            time.sleep(1)
    raise RuntimeError('Local deployment readback failed') from last_error


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', choices=['deploy', 'restore', 'verify-snapshot', 'recover', 'runtime-path'])
    p.add_argument('--release', type=Path)
    p.add_argument('--snapshot', type=Path)
    p.add_argument('--target', type=Path, default=APP_ROOT)
    p.add_argument('--backups', type=Path, default=BACKUPS_ROOT)
    p.add_argument('--execute', action='store_true')
    p.add_argument('--confirm-data-restore', action='store_true')
    a = p.parse_args()
    if a.action == 'runtime-path':
        print(runtime_path_for(a.target))
        return
    if a.action == 'verify-snapshot':
        if not a.snapshot: p.error('--snapshot required')
        verify_snapshot(a.snapshot)
        print('Snapshot checksums, SQLite integrity and photo references passed')
        summary = storage_summary(a.snapshot / 'data/db.sqlite3')
        if summary is not None:
            print('Photo cleanup state in snapshot: pending={pending} blocked={blocked} done={done} '
                  'reserved={reserved} epoch={epoch} (a restore blocks pending tickets for operator review)'.format(**summary))
        return
    if not a.execute:
        print('PLAN ONLY: lock and preflight, coordinated snapshot, journaled same-filesystem publication and readback. No production files accessed or changed.')
        if a.action == 'restore': print('Restore rewinds data; post-snapshot submissions need explicit reconciliation.')
        return
    if os.geteuid() != 0: p.error('Administrator/root required; do not bypass host restrictions')
    target = a.target.absolute()
    reject_symlink_ancestors(target)
    if target != APP_ROOT: p.error(f'Scoped to {APP_ROOT}')
    journal = JOURNAL_PATH
    lock_fd = acquire_lock(LOCK_PATH)
    try:
        if a.action == 'recover':
            if not journal.exists():
                raise RuntimeError('No publication journal; refusing recovery action')
            print(recover_transaction(target, journal))
            return
        if a.action == 'deploy':
            if not a.release: p.error('--release required')
            incoming = a.release.absolute()
            validate_tree(incoming)
            if incoming.is_relative_to(target) or not all((incoming / n).is_dir() for n in ('backend','frontend','worker')):
                p.error('Release must be complete, external and symlink-free')
            if (incoming/'.env').exists() or (incoming/'data/db.sqlite3').exists(): p.error('Release must exclude .env and data')
            try:
                validate_release_location(incoming)
            except ValueError as exc:
                p.error(str(exc))
            if any((incoming / name).read_bytes() != (target / name).read_bytes()
                   for name in RUNTIME_MANIFESTS):
                p.error('Runtime manifests changed; prepare a new immutable runtime and reviewed service units first')
            validate_service_configuration()
            capacity_preflight(target.parent, sum(x.stat().st_size for x in target.rglob('*') if x.is_file()) * 3)
            snapshot = deploy_transaction(target, incoming, a.backups, journal)
            print('Private rollback snapshot:', snapshot)
            print('Local readback passed; verify public HTTPS and account workflows.')
        else:
            if not a.snapshot or not a.confirm_data_restore: p.error('--snapshot and --confirm-data-restore required')
            verify_snapshot(a.snapshot)
            validate_service_configuration()
            capacity_preflight(target.parent,sum(x.stat().st_size for x in target.rglob('*') if x.is_file())*2)
            retained=restore_transaction(target, a.snapshot, a.backups, journal)
            print('Current state retained for data reconciliation:',retained)
            print('Restore readback passed; reconcile submissions after snapshot time.')
    finally:
        os.close(lock_fd)


if __name__ == '__main__':
    main()
