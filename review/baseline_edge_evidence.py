"""Independent, disposable reproductions against the unchanged staged baseline."""
import asyncio
from io import BytesIO
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
from unittest.mock import patch

APP = Path(__file__).resolve().parents[1] / 'app'
sys.path.insert(0, str(APP))
from backend import db, queue, api_app
from fastapi import UploadFile

assert Path(db.__file__).resolve().is_relative_to(APP)
results = {}
with tempfile.TemporaryDirectory(prefix='jagakebond-parent-review-', dir=os.environ['TMPDIR']) as folder:
    fixture = Path(folder)
    db.close_all()
    db.DB_PATH = fixture / 'fixture.sqlite3'
    api_app.UPLOAD_DIR = fixture / 'uploads'
    api_app.UPLOAD_DIR.mkdir()
    db.migrate()
    now = db.now_ms()
    with db.transaction() as tx:
        for ident in ['owner_a', 'owner_b']:
            tx.execute('INSERT INTO accounts(id,email,password_hash,created_ms,updated_ms,daily_quota) VALUES(?,?,?,?,?,?)',
                       (ident, ident + '@fixture.invalid', 'synthetic-noncredential', now, now, 1))
        tx.execute('INSERT INTO photos(id,account_id,file_name,bytes,created_ms) VALUES(?,?,?,?,?)',
                   ('photo_b', 'owner_b', 'photo_b.jpg', 3, now))
    (api_app.UPLOAD_DIR / 'photo_b.jpg').write_bytes(b'not-a-real-user-photo')
    api_app.create_record({'id': 'record_fixture', 'imageUrl': '/api/photos/photo_b'}, account={'id': 'owner_a', 'role': 'user'})
    api_app.delete_record('record_fixture', account={'id': 'owner_a', 'role': 'user'})
    results['foreign_photo_deleted_via_owned_record'] = db.query_one("SELECT id FROM photos WHERE id='photo_b'") is None
    results['foreign_photo_file_deleted'] = not (api_app.UPLOAD_DIR / 'photo_b.jpg').exists()
    assert results['foreign_photo_deleted_via_owned_record'] and results['foreign_photo_file_deleted']
    low = queue.apply_confidence_gate({'severity': 'Moderate', 'confidence': .6, 'needs_review': False,
                                     'immediate_action': 'Semprot mankozeb 2 g/L.'})
    results['low_confidence_chemical_survives'] = low['immediate_action'] == 'Semprot mankozeb 2 g/L.'
    assert results['low_confidence_chemical_survives']
    barrier = threading.Barrier(2, timeout=10)
    def thumbnail(data, size, quality):
        barrier.wait()
        return 'synthetic-thumbnail'
    async def cap(file):
        return await file.read()
    async def concurrent_uploads():
        fields = {key: None for key in ['lat', 'lng', 'elevation', 'locationName', 'accuracy', 'weather', 'photoDate',
                                       'photoTimestampMs', 'farmId', 'deviceId', 'cropHint', 'tier']}
        return await asyncio.gather(*(api_app.analyze(image=UploadFile(file=BytesIO(b'synthetic-image'), filename='fixture.jpg'),
                                      account={'id': 'owner_a', 'daily_quota': 1, 'role': 'user'}, **fields)
                                      for _ in range(2)))
    with patch.object(api_app, '_read_capped', cap), patch.object(api_app, '_thumbnail_b64_from_bytes', thumbnail):
        submitted = asyncio.run(concurrent_uploads())
    count = db.query_one("SELECT count(*) n FROM jobs WHERE account_id='owner_a'")['n']
    results['actual_analyze_handler_admitted_with_quota_one'] = count
    assert len(submitted) == 2 and count == 2
    old = now - 8 * 86_400_000
    with db.transaction() as tx:
        tx.execute("INSERT INTO jobs(id,account_id,status,created_ms,updated_ms,image_b64,context_json) VALUES(?,?,'queued',?,?,?,?)",
                   ('old_queued', 'owner_b', old, old, 'synthetic', '{}'))
    queue.purge_old_jobs()
    results['queued_image_erased_by_retention'] = db.query_one("SELECT image_b64 FROM jobs WHERE id='old_queued'")['image_b64'] is None
    assert results['queued_image_erased_by_retention']
    db.close_all()
print(json.dumps({'source': str(APP), 'production_access': False, 'reproduced': results}, indent=2))
