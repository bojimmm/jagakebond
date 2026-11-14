#!/bin/bash
# Canonical JagaKebond staging. Run only on the production host as root.
# stage VERSION SOURCE_SHA256 ZIP | plan VERSION | execute VERSION
set -euo pipefail
ACTION=${1:-}
VERSION=${2:-}
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Expected four-part release version'; exit 2; }
test "$(id -u)" -eq 0
APP=/srv/sites/jagake.bond/app
OPS=/srv/sites/jagake.bond/ops/release_ops.py
RELEASES=/srv/sites/jagake.bond/releases
DEST="$RELEASES/$VERSION"
RUNTIME=$(/usr/bin/python3 "$OPS" runtime-path --target "$APP")
PY="$RUNTIME/bin/python"
test -f "$PY"
test -x "$PY"
case "$ACTION" in
stage)
  EXPECTED=${3:-}
  BUNDLE=${4:-}
  [[ "$EXPECTED" =~ ^[a-f0-9]{64}$ ]] || { echo 'Expected SHA-256 from the delivery record'; exit 2; }
  test -f "$BUNDLE"
  test ! -e "$DEST"
  test ! -e /var/lib/jagakebond/release-transaction.json
  printf '%s  %s\n' "$EXPECTED" "$BUNDLE" | sha256sum --check -
  "$PY" -m pip check
  "$PY" - "$BUNDLE" "$VERSION" "$RELEASES" "$APP" "$OPS" <<'PY'
import ast
import hashlib
import json
from pathlib import Path, PurePosixPath
import os
import stat
import sys
import tempfile
import zipfile

bundle, version, releases, app, ops = sys.argv[1:]
releases, app, ops = Path(releases), Path(app), Path(ops)
if releases.resolve() != releases or app.resolve() != app:
    raise RuntimeError('Canonical paths must not contain symlinks')
destination = releases / version
if destination.exists():
    raise RuntimeError('Immutable release already exists')
prefix = 'JagaKebond-' + version + '/'
with zipfile.ZipFile(bundle) as archive:
    names = archive.namelist()
    if len(names) != len(set(names)):
        raise RuntimeError('Duplicate archive entries')
    if sum(item.file_size for item in archive.infolist()) > 256 * 1024 * 1024:
        raise RuntimeError('Unexpected source archive size')
    for item in archive.infolist():
        name = item.filename
        if (not name.startswith(prefix) or '\\' in name or '..' in PurePosixPath(name).parts
                or PurePosixPath(name).is_absolute() or stat.S_ISLNK(item.external_attr >> 16)):
            raise RuntimeError('Unsafe archive entry')
    manifest_name = prefix + 'SOURCE-SHA256.json'
    files = json.loads(archive.read(manifest_name))['files']
    if set(names) != {prefix + name for name in files} | {manifest_name}:
        raise RuntimeError('Archive manifest coverage differs')
    for name, expected in files.items():
        if hashlib.sha256(archive.read(prefix + name)).hexdigest() != expected:
            raise RuntimeError('Source checksum mismatch')
    with tempfile.TemporaryDirectory(prefix='.stage-', dir=releases) as folder:
        archive.extractall(folder)
        source = Path(folder) / prefix / 'app'
        if (source / '.env').exists() or (source / 'data').exists():
            raise RuntimeError('Release contains private runtime state')
        for name in ('requirements.txt', 'requirements-tested.txt'):
            if (source / name).read_bytes() != (app / name).read_bytes():
                raise RuntimeError('Runtime changed; prepare a reviewed immutable runtime first')
        if (source / 'deploy/release_ops.py').read_bytes() != ops.read_bytes():
            raise RuntimeError('Deploy tool differs; review and install the canonical tool first')
        module = ast.parse((source / 'backend/version.py').read_text())
        identities = {node.targets[0].id:ast.literal_eval(node.value) for node in module.body
                      if isinstance(node,ast.Assign) and isinstance(node.targets[0],ast.Name)}
        if identities.get('RELEASE_VERSION') != version:
            raise RuntimeError('Release name differs from source identity')
        for path in [source, *source.rglob('*')]:
            if path.is_symlink():
                raise RuntimeError('Unexpected source symlink')
            path.chmod(0o755 if path.is_dir() else 0o644)
        os.rename(source, destination)
print('Immutable release staged:', version)
PY
  ;;
plan)
  "$PY" "$OPS" deploy --release "$DEST"
  ;;
execute)
  # The configured backup unit encrypts and copies off-host, verifying its checksum.
  # RemainAfterExit=no: starting it runs a fresh backup and waits for completion.
  systemctl start jagakebond-backup.service
  test "$(systemctl show jagakebond-backup.service -p Result --value)" = success
  "$PY" "$OPS" deploy --release "$DEST" --execute
  ;;
*) echo 'Usage: stage_release.sh stage VERSION SHA256 ZIP | plan VERSION | execute VERSION'; exit 2 ;;
esac
