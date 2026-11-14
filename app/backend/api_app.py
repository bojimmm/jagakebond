"""Farmer-facing API. Every route here is account-scoped.

The queue-claiming and result-posting routes are the exception: they authenticate
with the worker token, because they hand out other users' photos and decide what
the confidence gate will see.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import ipaddress
import json
import math
import re
import threading
import time
import warnings
from contextlib import contextmanager
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import quote, urlsplit

import httpx
from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.routing import APIRoute
from PIL import Image, ImageOps, UnidentifiedImageError

from . import auth, db, google_auth, queue, security, settings_store, storage, textsafe, input_catalog
from .analysis_contract import AnalysisContractError


class CodedHTTPException(HTTPException):
    """HTTPException that also puts a machine-readable `code` in the JSON body.

    Errors stay `{"detail": "<Bahasa message>"}`; the limits added in 0.2.2.0 add
    `"code"` so a client can tell "queue full, wait" from "bad input".
    """

    def __init__(self, status_code: int, detail: str, code: str,
                 headers: dict[str, str] | None = None) -> None:
        super().__init__(status_code=status_code, detail=detail, headers=headers)
        self.code = code


class _CodedRoute(APIRoute):
    """Renders CodedHTTPException as {"detail": ..., "code": ...} for every route here."""

    def get_route_handler(self):  # type: ignore[no-untyped-def]
        original = super().get_route_handler()

        async def handler(request: Request) -> Response:
            try:
                return await original(request)
            except CodedHTTPException as exc:
                return JSONResponse({"detail": exc.detail, "code": exc.code},
                                    status_code=exc.status_code, headers=exc.headers)

        return handler


router = APIRouter(prefix="/api", tags=["app"], route_class=_CodedRoute)

DATA_DIR: Path = db.DATA_DIR
UPLOAD_DIR: Path = DATA_DIR / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

from .version import APP_VERSION, RELEASE_VERSION
TELEMETRY_TIMEOUT = 15.0
_PHONE_THUMB_PX = 1024

# Pillow's default limit only *warns* until roughly twice the pixel count, so a
# few-megabyte PNG could still expand into hundreds of megabytes of RGB and take
# the single worker process down with it. Fail the decode closed instead. A phone
# photo is at most ~12 MP; 16 MP leaves headroom and bounds one decode to ~50 MB.
MAX_IMAGE_PIXELS = 16_000_000
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
warnings.simplefilter("error", Image.DecompressionBombWarning)
_STORE_PHOTO_PX = 1280
_STORE_PHOTO_QUALITY = 78
_UA = {"User-Agent": "JagaKebond/2.0"}

# Formats the app actually produces; everything else is refused before decoding.
_IMAGE_FORMATS = ["JPEG", "PNG", "WEBP"]
# At most this many photos are decoded at the same time in the whole process, so a burst
# of uploads cannot multiply the memory of a decode (and starve the other requests).
_DECODE_SLOTS = threading.BoundedSemaphore(2)
_DECODE_WAIT_SECONDS = 25.0
_decode_state = threading.local()

# Input limits (contract 5.3). Text is sanitised and TRUNCATED, never rejected, so an
# old offline draft still goes through.
LOCATION_NAME_MAX = 200
WEATHER_MAX = 120
PHOTO_DATE_MAX = 40
DEVICE_ID_MAX = 64
CROP_HINT_MAX = 80
ID_MAX = 128
FARM_NAME_MAX = 120
FARM_CROP_MAX = 80
FARM_NOTE_MAX = 2000
RECORD_NAME_MAX = 200
RECORD_TEXT_MAX = 2000
DAILY_TEXT_MAX = 4000
DAILY_ITEM_MAX = 200
DAILY_LIST_MAX = 100
MAX_RING_POINTS = 2000
PHOTO_UPLOADS_PER_DAY = 200
RECORD_SOURCES = ("manual", "peta", "ai")
FARM_SOURCES = ("peta", "gps", "manual")
# Fields only the server-side AI pipeline may fill in.
AI_ONLY_RECORD_FIELDS = ("confidence", "needs_review", "suitability", "geocorrelation",
                         "immediate_action", "assessment", "previousCondition")


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def _fnum(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def _strict_number(value: Any, name: str) -> float | None:
    """Parse optional multipart numbers without silently treating bad input as absent."""
    if value is None or value == "":
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=f"{name} harus berupa angka")
    if not math.isfinite(result):
        raise HTTPException(status_code=400, detail=f"{name} harus berupa angka terbatas")
    return result


def _validate_coordinates(lat: Any, lng: Any) -> tuple[float | None, float | None]:
    latitude, longitude = _strict_number(lat, "lat"), _strict_number(lng, "lng")
    if latitude is not None and not -90 <= latitude <= 90:
        raise HTTPException(status_code=400, detail="lat di luar rentang")
    if longitude is not None and not -180 <= longitude <= 180:
        raise HTTPException(status_code=400, detail="lng di luar rentang")
    if (latitude is None) != (longitude is None):
        raise HTTPException(status_code=400, detail="Lintang dan bujur harus dikirim bersama.")
    return latitude, longitude


# ---------------------------------------------------------------------------
# Input hygiene (contract 5.3): bounded, sanitised, type-checked fields
# ---------------------------------------------------------------------------


def _plain_text(value: Any, limit: int, label: str, *, single_line: bool = True) -> str | None:
    """Optional text field: None/blank -> None; text is sanitised and TRUNCATED to `limit`.

    A dict, list or bool is a 400 (it used to reach SQLite and become a 500).
    """
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        raise HTTPException(status_code=400, detail=f"{label} harus berupa teks")
    text = textsafe.one_line(value, limit) if single_line else textsafe.block(value, limit)
    return text or None


def _clean_id(value: Any, label: str) -> str | None:
    """Optional identifier: None/blank -> None; non-text, overlong or multi-line -> 400."""
    if value is None:
        return None
    if not isinstance(value, str):
        raise HTTPException(status_code=400, detail=f"{label} tidak valid")
    text = value.strip()
    if not text:
        return None
    if len(text) > ID_MAX or textsafe.one_line(text, ID_MAX + 1) != text:
        raise HTTPException(status_code=400, detail=f"{label} tidak valid")
    return text


def _text_list(value: Any, item_limit: int, max_items: int = DAILY_LIST_MAX) -> list[str]:
    """A list of short texts (daily-log actions/zones). Anything else is dropped, items
    are sanitised and truncated, and the list is cut at `max_items`."""
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value:
        if isinstance(item, bool) or not isinstance(item, (str, int, float)):
            continue
        text = textsafe.one_line(item, item_limit)
        if text:
            out.append(text)
        if len(out) >= max_items:
            break
    return out


def _timestamp_ms(value: Any, now: int) -> int | None:
    """A client timestamp as epoch ms, or None. Never in the far future, never a bignum."""
    number = _fnum(value)
    if number is None or number <= 0:
        return None
    return int(min(number, now + 86_400_000))


# ---------------------------------------------------------------------------
# Worker-token routes: constant-time check plus a throttle on FAILED attempts
# ---------------------------------------------------------------------------

_WORKER_FAIL_LIMIT = 20
_WORKER_FAIL_WINDOW_SECONDS = 600.0
_WORKER_FAIL_MAX_KEYS = 5000
_worker_fail_lock = threading.Lock()
_worker_failures: dict[str, list[float]] = {}


def _throttle_key(request: Request) -> str:
    ip = (auth.client_ip(request) or "").strip() or "-"
    try:
        address = ipaddress.ip_address(ip)
    except ValueError:
        return ip
    if address.version == 6:  # one subscriber usually owns a whole /64
        return str(ipaddress.ip_network(f"{address}/64", strict=False))
    return str(address)


def _recent_failures(key: str, now: float) -> list[float]:
    stamps = [t for t in _worker_failures.get(key, ()) if now - t < _WORKER_FAIL_WINDOW_SECONDS]
    if stamps:
        _worker_failures[key] = stamps
    else:
        _worker_failures.pop(key, None)
    return stamps


def _worker_retry_after(key: str, now: float) -> int:
    """Seconds the client must wait (0 = allowed). Only failures count; a refused call
    records nothing, so the lock lifts as the oldest failure ages out of the window."""
    with _worker_fail_lock:
        stamps = _recent_failures(key, now)
        if len(stamps) >= _WORKER_FAIL_LIMIT:
            return max(1, int(_WORKER_FAIL_WINDOW_SECONDS - (now - stamps[0])) + 1)
    return 0


def _record_worker_failure(key: str, now: float) -> None:
    with _worker_fail_lock:
        _worker_failures[key] = _recent_failures(key, now) + [now]
        if len(_worker_failures) > _WORKER_FAIL_MAX_KEYS:
            for stale in list(_worker_failures):  # pruning drops expired keys as a side effect
                _recent_failures(stale, now)
            overflow = len(_worker_failures) - _WORKER_FAIL_MAX_KEYS
            if overflow > 0:  # still too many live keys: forget the quietest ones
                for oldest in sorted(_worker_failures, key=lambda k: _worker_failures[k][-1])[:overflow]:
                    _worker_failures.pop(oldest, None)


def require_worker(request: Request) -> None:
    """Dependency for every worker-token route.

    `security.worker_ok` does the constant-time comparison. Failed attempts are counted per
    client (IPv6 per /64): 20 within 10 minutes locks that client out with 429 until the
    oldest failure ages out. A non-ASCII header value is a failed attempt, not a 500.
    """
    key = _throttle_key(request)
    now = time.monotonic()
    wait = _worker_retry_after(key, now)
    if wait:
        raise HTTPException(status_code=429, detail="Terlalu banyak percobaan token worker. Coba lagi nanti.",
                            headers={"Retry-After": str(wait)})
    try:
        valid = security.worker_ok(request.headers.get("x-worker-token"))
    except (TypeError, ValueError, UnicodeError):
        valid = False
    if not valid:
        _record_worker_failure(key, now)
        raise HTTPException(status_code=401, detail="Token worker tidak valid")


def max_upload_bytes() -> int:
    return settings_store.as_int("MAX_UPLOAD_MB") * 1024 * 1024


async def _read_capped(upload: UploadFile) -> bytes:
    # The limit is a database setting: read it off the event loop.
    megabytes = await run_in_threadpool(settings_store.as_int, "MAX_UPLOAD_MB")
    limit = megabytes * 1024 * 1024
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await upload.read(1024 * 256)
        if not chunk:
            break
        total += len(chunk)
        if total > limit:
            # 413 is the status clients treat as a permanent "Foto terlalu besar".
            raise HTTPException(status_code=413, detail=f"Ukuran foto melebihi {megabytes} MB")
        chunks.append(chunk)
    data = b"".join(chunks)
    if not data:
        raise HTTPException(status_code=400, detail="Foto kosong atau tidak terbaca")
    return data


@contextmanager
def _decode_slot() -> Iterator[None]:
    """Hold one of the process-wide decode slots (two at a time).

    Re-entrant per thread: a pipeline that already holds a slot (open + resize +
    encode) may call _open_image without waiting on itself, which a plain semaphore
    would deadlock on as soon as two such pipelines each held one.
    """
    if getattr(_decode_state, "held", False):
        yield
        return
    if not _DECODE_SLOTS.acquire(timeout=_DECODE_WAIT_SECONDS):
        raise CodedHTTPException(429, "Server sedang memproses banyak foto. Coba lagi sebentar lagi.",
                                 "decode_busy", headers={"Retry-After": "5"})
    _decode_state.held = True
    try:
        yield
    finally:
        _decode_state.held = False
        _DECODE_SLOTS.release()


def _open_image(data: bytes, max_px: int | None = None) -> Image.Image:
    """Decode an upload into a fully loaded, upright image no larger than needed.

    Only JPEG/PNG/WebP are accepted, never more than MAX_IMAGE_PIXELS, and only two
    decodes run at once. A JPEG is decoded at a reduced scale (`draft`) when the target
    is much smaller than the original, which cuts the memory of a 12 MP photo to a few
    megabytes. Anything unreadable or truncated is a 400 in Bahasa, never a 500.
    """
    target = max_px or _STORE_PHOTO_PX
    too_big = HTTPException(status_code=400, detail="Foto terlalu besar (maksimal 16 megapiksel). "
                                                    "Perkecil resolusi foto lalu kirim lagi.")
    with _decode_slot():
        try:
            image = Image.open(io.BytesIO(data), formats=_IMAGE_FORMATS)
            if image.width * image.height > MAX_IMAGE_PIXELS:
                raise too_big
            image.verify()
            image = Image.open(io.BytesIO(data), formats=_IMAGE_FORMATS)
            if image.format == "JPEG":
                image.draft("RGB", (target, target))
            return ImageOps.exif_transpose(image)
        except HTTPException:
            raise
        except (Image.DecompressionBombError, Image.DecompressionBombWarning):
            raise too_big from None
        except UnidentifiedImageError:
            raise HTTPException(status_code=400,
                                detail="Format foto tidak didukung. Gunakan JPG, PNG, atau WebP.") from None
        except MemoryError:
            raise too_big from None
        except Exception as error:  # noqa: BLE001 - corrupt input must never become a 500
            if "truncated" in str(error).lower():
                raise HTTPException(status_code=400,
                                    detail="Foto tidak lengkap atau rusak. Ambil atau kirim ulang foto.") from None
            raise HTTPException(status_code=400, detail="Berkas gambar tidak valid") from None


def _to_rgb(image: Image.Image) -> Image.Image:
    if image.mode in ("RGBA", "LA", "P"):
        background = Image.new("RGB", image.size, (255, 255, 255))
        converted = image.convert("RGBA")
        background.paste(converted, mask=converted.split()[-1])
        return background
    return image.convert("RGB")


def _make_thumbnail_b64(image: Image.Image, max_px: int, quality: int) -> str:
    thumb = _to_rgb(image)
    thumb.thumbnail((max_px, max_px), Image.LANCZOS)
    buf = io.BytesIO()
    thumb.save(buf, format="JPEG", quality=quality, optimize=True)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _validated_area(value: Any) -> float | None:
    area = _strict_number(value, "areaM2")
    if area is not None and area < 0:
        raise HTTPException(status_code=400, detail="Luas petak tidak boleh negatif.")
    return area


def _validate_ring(ring: Any) -> list[list[float]]:
    if isinstance(ring, list) and len(ring) > MAX_RING_POINTS:
        raise HTTPException(status_code=422,
                            detail=f"Batas petak terlalu rumit (maksimal {MAX_RING_POINTS} titik). "
                                   "Sederhanakan garis batas petak lalu simpan lagi.")
    if not isinstance(ring, list) or len(ring) < 3:
        raise HTTPException(status_code=400, detail="Ring petak minimal 3 titik")
    points: list[list[float]] = []
    for point in ring:
        if not isinstance(point, (list, tuple)) or len(point) != 2:
            raise HTTPException(status_code=400, detail="Titik ring harus [lat, lng]")
        lat = _fnum(point[0])
        lng = _fnum(point[1])
        if lat is None or lng is None:
            raise HTTPException(status_code=400, detail="Koordinat ring harus berupa angka")
        if not (-90.0 <= lat <= 90.0) or not (-180.0 <= lng <= 180.0):
            raise HTTPException(status_code=400, detail="Koordinat ring di luar rentang")
        points.append([lat, lng])
    if points[0] != points[-1]:
        points.append([points[0][0], points[0][1]])
    if len(points) < 4:
        raise HTTPException(status_code=400, detail="Ring petak minimal 4 titik tertutup")
    if len({(p[0], p[1]) for p in points[:-1]}) < 3:
        raise HTTPException(status_code=400, detail="Ring petak butuh minimal 3 titik berbeda")
    return points


def _owner_or_admin(account: dict[str, Any], owner_id: str) -> bool:
    return account["role"] == "admin" or account["id"] == owner_id


def _reject_foreign_id(table: str, row_id: str, account_id: str) -> None:
    """Refuse to upsert a row id that already belongs to another account.

    `INSERT OR REPLACE` deletes the conflicting primary-key row whatever its
    account_id, so a client-supplied id previously let any authenticated account
    destroy or take over another account's record outright — proven, not theory:
    a second account posting a first account's record id deleted that row and
    kept its own copy. Seed and legacy ids are fixed and guessable.

    `table` is always a literal at the call sites below, never request data.
    """
    existing = db.query_one(f"SELECT account_id FROM {table} WHERE id = ?", (row_id,))
    if existing and existing["account_id"] != account_id:
        raise HTTPException(status_code=409, detail="ID sudah dipakai")


def _delete_photo_for_url(image_url: str | None, account_id: str, tx: Any = None) -> str:
    """Retire the stored photo that belonged to a deleted record, unless something still needs it.

    `image_url` is read by the ONE authoritative resolver (storage.parse_image_reference):
    only `/api/photos/<id>` and its same-origin absolute form identify a photo. Foreign,
    legacy or ambiguous values are kept, never deleted. The photo row is removed and a
    durable cleanup ticket is created in ONE transaction (storage.retire_photo_if_unreferenced,
    which also keeps the photo while ANY remaining record of any account may use it); the file
    itself is unlinked by the storage drainer, so a crash can never leave a deleted photo row
    with an uncovered file.

    Pass `tx` when already inside the record-deletion transaction (the caller then holds
    `storage.storage_lock()` and deleted the record row first); otherwise this opens its
    own locked transaction. Returns "queued" | "kept" | "blocked" ("kept" for anything it
    cannot resolve or safely handle: nothing is half-done).
    """
    ref = storage.parse_image_reference(image_url)
    if ref.kind != "photo" or not ref.photo_id:
        return "kept"
    if tx is not None:
        return storage.retire_photo_if_unreferenced(tx, ref.photo_id, owner_id=account_id)
    try:
        with storage.storage_lock():
            with db.transaction() as inner:
                outcome = storage.retire_photo_if_unreferenced(inner, ref.photo_id, owner_id=account_id)
    except (storage.StorageError, OSError):
        # The record is already deleted; the photo stays exactly as it was.
        return "kept"
    if outcome != "kept":
        try:
            storage.drain(10, lock_timeout=1.0)  # opportunistic: the durable ticket is the source of truth
        except Exception:  # noqa: BLE001
            pass
    return outcome


# ---------------------------------------------------------------------------
# Health (public, deliberately minimal)
# ---------------------------------------------------------------------------


@router.get("/health")
def health() -> dict[str, Any]:
    # `version` is the wire protocol clients gate on (major 2, minor >= 1); `release` is the
    # shipped app release, for support. Capabilities are only ever ADDED.
    return {"ok": True, "version": APP_VERSION, "release": RELEASE_VERSION,
            "capabilities": {"treeContinuity": True, "recordsPaging": True,
                             "accountBinding": True, "photoLifecycle": True,
                             "googleSignIn": google_auth.enabled()}}


# ---------------------------------------------------------------------------
# Telemetry (PRD section 8) — server-side fan-out keeps the phone off third parties
# ----------  -----------------------------------------------------------------


_TELEMETRY_HOSTS = {"api.open-meteo.com", "geocoding-api.open-meteo.com", "geocode.maps.co"}


def _validate_outbound_url(url: str) -> None:
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError:
        raise HTTPException(status_code=400, detail="Alamat layanan tidak valid")
    host = (parsed.hostname or "").lower().rstrip(".")
    local_gateway = host in {"localhost", "127.0.0.1", "::1"} and parsed.scheme == "http"
    allowed_provider = parsed.scheme == "https" and host in _TELEMETRY_HOSTS and port in (None, 443)
    if (not (local_gateway or allowed_provider) or parsed.username is not None or
            parsed.password is not None or parsed.fragment or not parsed.path.startswith("/")):
        raise HTTPException(status_code=400, detail="Alamat layanan tidak diizinkan")


def _http_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(follow_redirects=False, headers=_UA, event_hooks={"request": [_validate_request_url]})


async def _validate_request_url(request: httpx.Request) -> None:
    _validate_outbound_url(str(request.url))


async def _get_json(client: httpx.AsyncClient, url: str) -> Any:
    _validate_outbound_url(url)
    response = await client.get(url, timeout=TELEMETRY_TIMEOUT, headers=_UA)
    response.raise_for_status()
    return response.json()


async def _get_json_safe(client: httpx.AsyncClient, url: str) -> Any:
    """_get_json, but None instead of raising.

    The geocoding fallback is sequential, so an exception there would take down the whole
    telemetry response — including the elevation and weather calls that already succeeded.
    A missing place name must never cost the farmer their temperature.
    """
    try:
        return await _get_json(client, url)
    except Exception:  # noqa: BLE001 - degrade to "no place name", never to "no telemetry"
        return None


def _parse_place(geo: Any) -> str | None:
    """Compose an Indonesian place stamp: kelurahan/kecamatan, kota, provinsi."""
    if not isinstance(geo, dict):
        return None
    parts: list[str] = []

    def add(name: Any) -> None:
        text = str(name or "").strip()
        if text and text not in parts and len(parts) < 3:
            parts.append(text)

    add(geo.get("locality"))
    add(geo.get("city"))
    admins = (geo.get("localityInfo") or {}).get("administrative") or []
    ordered = sorted(
        (a for a in admins if isinstance(a, dict) and a.get("name")),
        key=lambda a: a.get("order") if isinstance(a.get("order"), int) else -1,
        reverse=True,
    )
    for admin in ordered:
        if admin.get("adminLevel") == 4:
            add(admin.get("name"))
            break
    for admin in ordered:
        if admin.get("adminLevel") not in (2, 3, 4):
            add(admin.get("name"))
    if not parts:
        add(geo.get("principalSubdivision"))
    return ", ".join(parts) if parts else None


def _reverse_address(data: Any) -> str | None:
    if not isinstance(data, dict) or data.get("error"):
        return None
    address = data.get("address")
    parts: list[str] = []
    if isinstance(address, dict):
        for keys in (("village", "hamlet", "suburb", "town", "city", "municipality"),
                     ("county", "city_district", "state_district"), ("state", "region")):
            for key in keys:
                value = address.get(key)
                if isinstance(value, str) and value.strip():
                    text = value.strip()[:160]
                    if text not in parts:
                        parts.append(text)
                    break
    if parts:
        return ", ".join(parts)
    display = data.get("display_name")
    return display.strip()[:512] if isinstance(display, str) and display.strip() else None


async def _reverse_place(client: httpx.AsyncClient, lat: float, lng: float) -> str | None:
    try:
        # A database read (and possibly a decrypt): keep it off the event loop.
        key = (await run_in_threadpool(settings_store.secret_value, "GEOCODE_API_KEY")).strip()
        if not key:
            return None
        url = f"https://geocode.maps.co/reverse?lat={lat}&lon={lng}&format=json&accept-language=id"
        _validate_outbound_url(url)
        response = await client.get(url, headers={**_UA, "Authorization": "Bearer " + key},
                                    timeout=8.0, follow_redirects=False)
        response.raise_for_status()
        return _reverse_address(response.json())
    except Exception:
        # Do not expose upstream errors/credentials or discard independent weather results.
        return None


def _openmeteo_place(data: Any, lat: float, lng: float) -> str | None:
    if not isinstance(data, dict) or not isinstance(data.get("results"), list):
        return None
    nearest: tuple[float, dict[str, Any]] | None = None
    for candidate in data["results"]:
        if not isinstance(candidate, dict) or not isinstance(candidate.get("name"), str):
            continue
        a, b = _fnum(candidate.get("latitude")), _fnum(candidate.get("longitude"))
        if a is None or b is None or not (-90 <= a <= 90 and -180 <= b <= 180):
            continue
        dy = math.radians(a - lat)
        dx = math.radians((b - lng + 180) % 360 - 180)
        h = math.sin(dy / 2) ** 2 + math.cos(math.radians(lat)) * math.cos(math.radians(a)) * math.sin(dx / 2) ** 2
        distance = 6371.0088 * 2 * math.asin(math.sqrt(min(1, max(0, h))))
        # A name search is approximate locality context, never a GPS address.
        if distance <= 50 and (nearest is None or distance < nearest[0]):
            nearest = distance, candidate
    if nearest is None:
        return None
    parts = []
    for key in ("name", "admin2", "admin1", "country"):
        value = nearest[1].get(key)
        if isinstance(value, str) and value.strip() and value.strip() not in parts:
            parts.append(value.strip())
    return ", ".join(parts[:3]) or None


@router.get("/telemetry")
async def telemetry(lat: float, lng: float,
                    account: dict[str, Any] = Depends(auth.current_account),
                    placeHint: str = "") -> dict[str, Any]:
    if not (math.isfinite(lat) and math.isfinite(lng) and -90 <= lat <= 90 and -180 <= lng <= 180):
        raise HTTPException(status_code=400, detail="Koordinat WGS84 tidak valid")
    hint = placeHint.strip() if isinstance(placeHint, str) else ""
    if len(hint) > 120:
        raise HTTPException(status_code=400, detail="Nama tempat maksimal 120 karakter")
    out: dict[str, Any] = {"lat": lat, "lng": lng, "elevation": None,
                           "tempC": None, "rh": None, "weather": None, "locationName": None,
                           "locationProvider": None, "locationApproximate": False,
                           "weatherProvider": "open-meteo", "elevationProvider": "open-meteo"}
    urls = (
        f"https://api.open-meteo.com/v1/elevation?latitude={lat}&longitude={lng}",
        f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lng}"
        f"&current=temperature_2m,relative_humidity_2m",
    )
    async with _http_client() as client:
        async def resolve_place() -> tuple[str | None, str | None]:
            place = await _reverse_place(client, lat, lng)
            if place:
                return place, "geocode.maps.co"
            if len(hint) >= 2:
                search_url = ("https://geocoding-api.open-meteo.com/v1/search?name="
                              + quote(hint, safe="") + "&count=10&language=id&format=json")
                place = _openmeteo_place(await _get_json_safe(client, search_url), lat, lng)
                if place:
                    return place, "open-meteo"
            return None, None

        elev, forecast, place_result = await asyncio.gather(
            _get_json_safe(client, urls[0]), _get_json_safe(client, urls[1]), resolve_place()
        )

    if isinstance(elev, dict):
        arr = elev.get("elevation")
        if isinstance(arr, list) and arr:
            out["elevation"] = _fnum(arr[0])
    if isinstance(forecast, dict):
        current = forecast.get("current") if isinstance(forecast.get("current"), dict) else {}
        out["tempC"] = _fnum(current.get("temperature_2m"))
        out["rh"] = _fnum(current.get("relative_humidity_2m"))
    out["locationName"], out["locationProvider"] = place_result
    out["locationApproximate"] = out["locationProvider"] in {"open-meteo", "geocode.maps.co"}
    out["locationStatus"] = "resolved" if out["locationName"] else "coordinates-only"

    if out["tempC"] is not None and out["rh"] is not None:
        out["weather"] = f"{round(out['tempC'])}°C • {round(out['rh'])}% RH"
    elif out["tempC"] is not None:
        out["weather"] = f"{round(out['tempC'])}°C"
    elif out["rh"] is not None:
        out["weather"] = f"{round(out['rh'])}% RH"
    return out


# ---------------------------------------------------------------------------
# Records
# ---------------------------------------------------------------------------

# PRD allowlist plus farmId and cropId: the farmer app moves a record between farms
# and files it under a crop timeline *after* the diagnosis arrives, so both are
# genuinely client-owned. needs_review and confidence stay server-owned (the
# confidence gate sets them) so a client cannot clear a review flag. Severity is editable for manual records;
# AI records use observedSeverity to keep the original model assessment intact.
RECORD_PUT_ALLOWLIST = ("observedSeverity", "severity", "condition", "crop", "cropName", "immediate_action",
                        "farmId", "cropId", "lat", "lng", "locationName")


RECORDS_DEFAULT_PAGE = 200
RECORDS_MAX_PAGE = 500
_SEVERITIES = ("Severe", "Moderate", "Healthy")


def _encode_cursor(sort_key: float | int, record_id: str) -> str:
    raw = json.dumps([sort_key, record_id], separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _decode_cursor(cursor: str) -> tuple[float | int, str]:
    """Opaque page marker -> (sort key, id). A forged cursor can only move within the
    caller's own rows (the query is always scoped to the account), so it is not signed."""
    try:
        if len(cursor) > 512:
            raise ValueError("too long")
        key, record_id = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
        if (isinstance(key, bool) or not isinstance(key, (int, float)) or not math.isfinite(key)
                or not isinstance(record_id, str)):
            raise ValueError("bad shape")
        return key, record_id
    except Exception:  # noqa: BLE001 - any malformed cursor is the client's mistake
        raise HTTPException(status_code=400, detail="Penanda halaman tidak valid") from None


@router.get("/records", response_model=None)
def list_records(limit: str | None = Query(None), cursor: str | None = Query(None),
                 account: dict[str, Any] = Depends(auth.current_account)) -> Any:
    """Without `limit`/`cursor`: the legacy full array (old clients). With `limit` (1..500)
    and an optional `cursor`: `{"items": [...], "next": <opaque> | null}` in the SAME order."""
    if limit is None and cursor is None:
        rows = db.query(
            "SELECT * FROM records WHERE account_id = ? ORDER BY COALESCE(timestamp_ms, created_ms) DESC, id DESC",
            (account["id"],),
        )
        return [db.row_record(row) for row in rows]
    page = RECORDS_DEFAULT_PAGE
    if limit is not None:
        try:
            page = int(limit.strip())
        except ValueError:
            page = 0
        if not 1 <= page <= RECORDS_MAX_PAGE:
            raise HTTPException(status_code=400, detail=f"limit harus antara 1 dan {RECORDS_MAX_PAGE}")
    sql = "SELECT * FROM records WHERE account_id = ?"
    params: list[Any] = [account["id"]]
    if cursor:
        key, last_id = _decode_cursor(cursor)
        sql += (" AND (COALESCE(timestamp_ms, created_ms) < ?"
                " OR (COALESCE(timestamp_ms, created_ms) = ? AND id < ?))")
        params += [key, key, last_id]
    sql += " ORDER BY COALESCE(timestamp_ms, created_ms) DESC, id DESC LIMIT ?"
    params.append(page + 1)
    rows = db.query(sql, params)
    more = len(rows) > page
    rows = rows[:page]
    next_cursor = None
    if more and rows:
        last = rows[-1]
        next_cursor = _encode_cursor(
            last["timestamp_ms"] if last["timestamp_ms"] is not None else last["created_ms"], last["id"])
    return {"items": [db.row_record(row) for row in rows], "next": next_cursor}


def _clean_record_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Validate and sanitise a client record; returns a copy that is safe to bind.

    `source` is allowlisted. Only an AI record may carry advice, confidence or review flags,
    and for those the server rebuilds everything from the completed job anyway. For every
    other record those fields are dropped, so a manual note can never pose as a diagnosis.
    Types and lengths are checked here so a dict or a 1 MB string is a 400, not a 500.
    """
    now = db.now_ms()
    out = dict(payload)
    source = out.get("source")
    out["source"] = source if isinstance(source, str) and source in RECORD_SOURCES else "manual"
    record_id = out.get("id")
    out["id"] = _clean_id(record_id, "ID catatan") if isinstance(record_id, str) else None
    out["cropId"] = _clean_id(out.get("cropId"), "cropId")
    out["farmId"] = _clean_id(out.get("farmId"), "farmId")
    out["cropName"] = _plain_text(out.get("cropName"), RECORD_NAME_MAX, "cropName")
    image_url = out.get("imageUrl")
    if image_url is not None and (not isinstance(image_url, str) or len(image_url) > 512):
        raise HTTPException(status_code=400, detail="Alamat foto tidak valid.")
    if out["source"] == "ai":
        return out
    for key in AI_ONLY_RECORD_FIELDS:
        out.pop(key, None)
    for key, limit in (("crop", RECORD_NAME_MAX), ("condition", RECORD_NAME_MAX),
                       ("locationName", RECORD_NAME_MAX), ("date", PHOTO_DATE_MAX),
                       ("deviceId", DEVICE_ID_MAX), ("cropHint", CROP_HINT_MAX)):
        out[key] = _plain_text(out.get(key), limit, key)
    out["symptoms"] = _plain_text(out.get("symptoms"), RECORD_TEXT_MAX, "symptoms", single_line=False)
    severity = out.get("severity")
    if severity is not None and (not isinstance(severity, str) or severity not in _SEVERITIES):
        raise HTTPException(status_code=400, detail="Status tanaman tidak valid.")
    out["lat"], out["lng"] = _validate_coordinates(out.get("lat"), out.get("lng"))
    out["elevation"] = _fnum(out.get("elevation"))
    accuracy = _fnum(out.get("accuracy"))
    out["accuracy"] = accuracy if accuracy is not None and accuracy >= 0 else None
    out["timestampMs"] = _timestamp_ms(out.get("timestampMs"), now)
    return out


def _coerce_stored_diagnosis(raw: Any) -> dict[str, Any] | None:
    """A completed job's diagnosis as safe values for a record column.

    complete_job already stores an allowlisted, gated diagnosis; this repeats the
    allowlist on the way out so a row written before that existed (or edited by hand)
    cannot put a list into SQLite or a pesticide recommendation in front of a farmer.
    """
    if not isinstance(raw, dict):
        return None
    clean = queue.sanitize_diagnosis(raw)
    if clean.get("assessment") is not None:
        clean = queue.apply_confidence_gate(clean)
    severity = clean.get("severity")
    severity = severity.strip() if isinstance(severity, str) else ""
    clean["severity"] = severity if severity in _SEVERITIES else "Moderate"
    confidence = clean.get("confidence")
    clean["confidence"] = None if isinstance(confidence, bool) else confidence
    return clean


@router.post("/records")
def create_record(payload: dict[str, Any] = Body(...),
                  account: dict[str, Any] = Depends(auth.current_account)) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Isi catatan tidak valid.")
    payload = _clean_record_payload(payload)
    record_id = payload.get("id")
    if not isinstance(record_id, str) or not record_id.strip():
        record_id = db.new_id("rec")
    _reject_foreign_id("records", record_id, account["id"])
    crop_id = payload.get("cropId")
    if crop_id and db.query_one("SELECT 1 FROM records WHERE crop_id=? AND account_id!=? LIMIT 1",
                                (crop_id, account["id"])):
        raise HTTPException(status_code=404, detail="Tanaman tidak ditemukan")
    if record_id.startswith("record_") and payload.get("source") != "ai":
        raise HTTPException(status_code=409, detail="ID record_ dicadangkan untuk hasil AI")
    farm_id = payload.get("farmId")
    if payload.get("source") != "ai" and farm_id and not db.query_one("SELECT id FROM farms WHERE id=? AND account_id=?", (farm_id, account["id"])):
        raise HTTPException(status_code=404, detail="Petak tidak ditemukan")
    image_url = payload.get("imageUrl")
    if isinstance(image_url, str) and "/api/photos/" in image_url:
        photo_id = image_url.rstrip("/").rsplit("/", 1)[-1]
        photo = db.query_one("SELECT id FROM photos WHERE id=? AND account_id=?", (photo_id, account["id"]))
        if not photo:
            raise HTTPException(status_code=404, detail="Foto tidak ditemukan")
    authoritative = None
    job = None
    is_reserved_ai_id = record_id.startswith("record_")
    if is_reserved_ai_id and payload.get("source") != "ai":
        existing = db.query_one("SELECT source FROM records WHERE id=? AND account_id=?", (record_id, account["id"]))
        if existing and existing["source"] == "ai":
            raise HTTPException(status_code=409, detail="Bidang hasil AI tidak dapat diganti")
        raise HTTPException(status_code=409, detail="ID hasil AI memerlukan source ai")
    if payload.get("source") == "ai":
        if not is_reserved_ai_id:
            raise HTTPException(status_code=400, detail="ID hasil AI tidak valid")
        job = db.query_one("SELECT * FROM jobs WHERE id=? AND account_id=?", (record_id[len("record_"):], account["id"]))
        if not job or job["status"] != "done":
            raise HTTPException(status_code=409, detail="Hasil AI harus berasal dari pekerjaan selesai milik akun")
        authoritative = _coerce_stored_diagnosis(db.from_json(job["diagnosis_json"], {}))
        if authoritative is None:
            raise HTTPException(status_code=409, detail="Hasil AI tidak tersedia")
    stamp = int(_fnum(payload.get("timestampMs")) or db.now_ms())
    now = db.now_ms()
    source_context = db.from_json(job["context_json"], {}) if job else {}
    linked_crop = payload.get("cropId") or source_context.get("cropId")
    crop_name = payload.get("cropName")
    if linked_crop:
        if db.query_one("SELECT id FROM records WHERE crop_id=? AND account_id!=? LIMIT 1", (linked_crop, account["id"])):
            raise HTTPException(status_code=404, detail="Tanaman tidak ditemukan")
        prior_crop = db.query_one("SELECT crop_name FROM records WHERE crop_id=? AND account_id=? ORDER BY updated_ms DESC LIMIT 1", (linked_crop, account["id"]))
        if not crop_name and prior_crop:
            crop_name = prior_crop["crop_name"]
    if authoritative is not None:
        captured = source_context.get("photoTimestampMs")
        stamp = (int(captured) if isinstance(captured, (int, float)) and math.isfinite(captured) and captured >= 0
                 else int(job["created_ms"]))
    # The browser/native client may have closed before it could upload the photo
    # separately. Preserve the queued source image before ack can clear it; never
    # accept a client-supplied URL as the source of an AI record's photo.
    if authoritative is not None:
        image_url = None
        photo_id = f"photo_{job['id']}"
        existing_photo = db.query_one("SELECT account_id FROM photos WHERE id=?", (photo_id,))
        if existing_photo and existing_photo["account_id"] == account["id"]:
            image_url = f"/api/photos/{photo_id}"
        elif job["image_b64"]:
            try:
                source_image = base64.b64decode(job["image_b64"], validate=True)
                photo_id = _store_photo_sync(source_image, account["id"], photo_id)
                image_url = f"/api/photos/{photo_id}"
            except storage.PhotoUnavailable:
                # The farmer already deleted this photo. A retired storage object is never
                # recreated, not even from the retained job bytes: the diagnosis is returned
                # without its image (a fresh photo needs a new, explicit upload).
                image_url = None
            except HTTPException as error:
                # 5xx / 401 / 429 are transient (storage or decoder busy, account state):
                # fail this call so the client retries and no source image is lost. Anything
                # else (unreadable source bytes) leaves the image explicitly unavailable.
                if error.status_code >= 500 or error.status_code in (401, 429):
                    raise
                image_url = None
            except ValueError:
                # A completed diagnosis remains recoverable even if its source
                # bytes are absent/corrupt; the image is explicitly unavailable.
                image_url = None
    values = {
        "id": record_id, "account_id": account["id"],
        "crop_id": linked_crop, "crop_name": crop_name,
        "timestamp_ms": stamp, "crop": authoritative.get("crop") if authoritative is not None else payload.get("crop"),
        "condition": authoritative.get("condition") if authoritative is not None else payload.get("condition"),
        "severity": authoritative.get("severity") if authoritative is not None else payload.get("severity"),
        "lat": source_context.get("lat") if job else _fnum(payload.get("lat")),
        "lng": source_context.get("lng") if job else _fnum(payload.get("lng")),
        "elevation": source_context.get("elevation") if job else _fnum(payload.get("elevation")),
        "location_name": source_context.get("locationName") if job else payload.get("locationName"),
        "accuracy": source_context.get("accuracy") if job else _fnum(payload.get("accuracy")),
        "date": (time.strftime("%Y-%m-%d", time.localtime(stamp / 1000)) if authoritative is not None else
                 payload.get("date") or time.strftime("%Y-%m-%d", time.localtime(stamp / 1000))),
        "symptoms": authoritative.get("symptoms_id", authoritative.get("symptoms")) if authoritative is not None else payload.get("symptoms"),
        "geocorrelation": authoritative.get("geocorrelation") if authoritative is not None else payload.get("geocorrelation"),
        "immediate_action": authoritative.get("immediate_action", authoritative.get("immediate_action_id")) if authoritative is not None else payload.get("immediate_action"),
        "suitability": authoritative.get("suitability") if authoritative is not None else payload.get("suitability"),
        "needs_review": 1 if (authoritative.get("needs_review") if authoritative is not None else payload.get("needs_review")) else 0,
        "confidence": _fnum(authoritative.get("confidence") if authoritative is not None else payload.get("confidence")),
        "farm_id": source_context.get("farmId") if job else payload.get("farmId"),
        "extra_json": db.to_json({**({"assessment": authoritative.get("assessment"), "uploadedMs": job["created_ms"], "captureTimeSource": "exif" if "EXIF" in str(source_context.get("photoDate") or "") else "manual" if "manual" in str(source_context.get("photoDate") or "") else "device", "captureTimeKnown": isinstance(source_context.get("photoTimestampMs"), (int,float)) and not isinstance(source_context.get("photoTimestampMs"), bool) and math.isfinite(source_context["photoTimestampMs"]) and source_context["photoTimestampMs"] >= 0} if job else {}),
            **({"locationSource": source_context.get("locationSource")}
               if job and source_context.get("locationSource") in ("manual", "plot", "gps", "camera-capture", "gallery-exif", "gallery-unknown", "unknown") else {})}),
        "device_id": job["device_id"] if job else payload.get("deviceId"),
        "image_url": image_url, "source": payload.get("source") or "manual",
        "crop_hint": source_context.get("cropHint") if job else payload.get("cropHint"),
        "created_ms": now, "updated_ms": now,
    }
    if job and authoritative:
        from .analysis_contract import clean_provenance
        metadata = db.from_json(values["extra_json"], {})
        metadata["analysisProvenance"] = clean_provenance(authoritative.get("provenance"))
        values["extra_json"] = db.to_json(metadata)
    if linked_crop and values["crop"]:
        # 0.2.4.17: a later photo of a plant whose species the farmer corrected keeps that species.
        corrected = db.query_one("SELECT crop, extra_json FROM records WHERE crop_id=? AND account_id=? ORDER BY updated_ms DESC LIMIT 1",
                                 (linked_crop, account["id"]))
        prior_extra = db.from_json(corrected["extra_json"], {}) if corrected else {}
        if (isinstance(prior_extra, dict) and isinstance(prior_extra.get("corrected"), list) and "crop" in prior_extra["corrected"]
                and corrected["crop"] and corrected["crop"] != values["crop"]):
            extra = db.from_json(values["extra_json"], {})
            extra.update({"aiCrop": values["crop"], "corrected": ["crop"]})
            values.update({"crop": corrected["crop"], "crop_name": corrected["crop"], "extra_json": db.to_json(extra)})
    with db.transaction() as tx:
        # Revalidate mutable foreign references under the serialized write transaction.
        if values["farm_id"] and not tx.execute("SELECT 1 FROM farms WHERE id=? AND account_id=?", (values["farm_id"], account["id"])).fetchone():
            if job:
                # A deleted plot must not prevent collecting an already completed result.
                values["farm_id"] = None
            else:
                raise HTTPException(status_code=404, detail="Petak tidak ditemukan")
        if crop_id and tx.execute("SELECT 1 FROM records WHERE crop_id=? AND account_id!=? LIMIT 1",
                                  (crop_id, account["id"])).fetchone():
            raise HTTPException(status_code=404, detail="Tanaman tidak ditemukan")
        if isinstance(image_url, str) and "/api/photos/" in image_url:
            photo_id = image_url.rstrip("/").rsplit("/", 1)[-1]
            if not tx.execute("SELECT 1 FROM photos WHERE id=? AND account_id=?", (photo_id, account["id"])).fetchone():
                raise HTTPException(status_code=404, detail="Foto tidak ditemukan")
        existing = tx.execute("SELECT account_id, source, created_ms FROM records WHERE id=?", (record_id,)).fetchone()
        if existing and existing["account_id"] != account["id"]:
            raise HTTPException(status_code=409, detail="ID sudah dipakai")
        if existing and existing["source"] == "ai":
            if authoritative is None:
                raise HTTPException(status_code=409, detail="Bidang hasil AI tidak dapat diganti")
            return db.row_record(db.query_one("SELECT * FROM records WHERE id=?", (record_id,)))
        if existing:
            values["created_ms"] = existing["created_ms"]
        tx.execute(
            """INSERT OR REPLACE INTO records
               (id, account_id, crop_id, crop_name, timestamp_ms, crop, condition, severity, lat, lng,
                elevation, location_name, accuracy, date, symptoms, geocorrelation, immediate_action,
                suitability, needs_review, confidence, farm_id, device_id, image_url, source,
                crop_hint, extra_json, created_ms, updated_ms)
               VALUES (:id,:account_id,:crop_id,:crop_name,:timestamp_ms,:crop,:condition,:severity,
                       :lat,:lng,:elevation,:location_name,:accuracy,:date,:symptoms,:geocorrelation,
                       :immediate_action,:suitability,:needs_review,:confidence,:farm_id,:device_id,
                       :image_url,:source,:crop_hint,:extra_json,:created_ms,:updated_ms)""",
            values,
        )
    row = db.query_one("SELECT * FROM records WHERE id = ? AND account_id = ?",
                       (record_id, account["id"]))
    return db.row_record(row)


def _clean_record_update(payload: dict[str, Any], row: dict[str, Any]) -> dict[str, Any]:
    """Same hygiene as _clean_record_payload, for the fields a client may edit later."""
    out = dict(payload)
    for key in ("condition", "crop", "cropName", "locationName"):
        if key in out:
            out[key] = _plain_text(out[key], RECORD_NAME_MAX, key)
    for key in ("cropId", "farmId"):
        if key in out:
            out[key] = _clean_id(out[key], key)
    if "observedProblems" in out:
        value = out["observedProblems"]
        if not isinstance(value, dict) or set(value) != {"disease", "pest"}:
            raise HTTPException(status_code=400, detail="Dugaan hama dan penyakit tidak valid.")
        problems: dict[str, str] = {}
        for key in ("disease", "pest"):
            raw = value[key]
            if not isinstance(raw, str):
                raise HTTPException(status_code=400, detail="Dugaan hama dan penyakit harus berupa teks.")
            problems[key] = _plain_text(raw, 80, key) or ""
        out["observedProblems"] = problems
    # Advice text belongs to the gated AI pipeline only (see AI_ONLY_RECORD_FIELDS); on an AI
    # record the caller already got a 409 for it.
    out.pop("immediate_action", None)
    return out


@router.put("/records/{record_id}")
def update_record(record_id: str, payload: dict[str, Any] = Body(...),
                  account: dict[str, Any] = Depends(auth.current_account)) -> dict[str, Any]:
    row = db.query_one("SELECT * FROM records WHERE id = ?", (record_id,))
    if not row or not _owner_or_admin(account, row["account_id"]):
        raise HTTPException(status_code=404, detail="Catatan tidak ditemukan")
    if row["source"] == "ai" and any(key in payload for key in ("severity", "condition", "crop", "immediate_action", "assessment", "previousCondition")):
        raise HTTPException(status_code=409, detail="Bidang hasil AI tidak dapat diubah")
    payload = _clean_record_update(payload, row)
    if "observedSeverity" in payload and payload["observedSeverity"] not in (None, "Severe", "Moderate", "Healthy"):
        raise HTTPException(status_code=400, detail="Status pengamatan tidak valid.")
    if "severity" in payload and payload["severity"] not in (None, "Severe", "Moderate", "Healthy"):
        raise HTTPException(status_code=400, detail="Status tanaman tidak valid.")
    if "farmId" in payload and payload["farmId"] and not db.query_one(
            "SELECT id FROM farms WHERE id=? AND account_id=?", (payload["farmId"], account["id"])):
        raise HTTPException(status_code=404, detail="Petak tidak ditemukan")
    if "cropId" in payload and payload["cropId"] and db.query_one(
            "SELECT id FROM records WHERE crop_id=? AND account_id!=? LIMIT 1", (payload["cropId"], account["id"])):
        raise HTTPException(status_code=404, detail="Tanaman tidak ditemukan")
    if "locationSource" in payload and payload["locationSource"] not in (None, "gps", "manual", "plot"):
        raise HTTPException(status_code=400, detail="Sumber lokasi tidak valid.")
    location_keys = {"lat", "lng"}
    if location_keys & payload.keys():
        if not location_keys <= payload.keys():
            raise HTTPException(status_code=400, detail="Lintang dan bujur harus dikirim bersama.")
        latitude, longitude = _validate_coordinates(payload.get("lat"), payload.get("lng"))
        payload = {**payload, "lat": latitude, "lng": longitude}
    correction = _record_correction(payload)
    fields = {key: payload[key] for key in RECORD_PUT_ALLOWLIST if key in payload}
    extra = db.from_json(row.get("extra_json"), {})
    extra = dict(extra) if isinstance(extra, dict) else {}
    if "observedProblems" in payload:
        extra["observedProblems"] = payload["observedProblems"]
    if location_keys & payload.keys() or "locationSource" in payload:
        extra["locationSource"] = payload.get("locationSource") or ("manual" if location_keys & payload.keys() else None)
    if location_keys & payload.keys() or "locationSource" in payload or "observedProblems" in payload:
        fields["extra_json"] = db.to_json(extra)
    if correction:
        fields.update(correction)
        if "crop" in correction:
            fields["cropName"] = correction["crop"]
        fields["extra_json"] = db.to_json(_corrected_extra(extra, row, correction))
    if fields:
        column_for = {"farmId": "farm_id", "cropId": "crop_id", "cropName": "crop_name", "observedSeverity": "observed_severity", "locationName": "location_name"}.get
        assignments = ", ".join(f"{column_for(key, key)} = ?" for key in fields)
        now = db.now_ms()
        params = list(fields.values()) + [now, record_id, row["account_id"]]
        if location_keys & fields.keys():
            assignments += ", accuracy = NULL"
        with db.transaction() as tx:
            if payload.get("farmId") and not tx.execute("SELECT 1 FROM farms WHERE id=? AND account_id=?", (payload["farmId"], row["account_id"])).fetchone():
                raise HTTPException(status_code=404, detail="Petak tidak ditemukan")
            tx.execute(f"UPDATE records SET {assignments}, updated_ms = ? WHERE id = ? AND account_id = ?", params)
            if correction:
                siblings = 0
                # A plant has one species: by default the other photos of the same plant follow.
                if "crop" in correction and row["crop_id"] and payload.get("applyToPlant", True) is not False:
                    for other in tx.execute("SELECT * FROM records WHERE crop_id = ? AND account_id = ? AND id != ?",
                                            (row["crop_id"], row["account_id"], record_id)).fetchall():
                        other = dict(other)
                        other_extra = db.from_json(other.get("extra_json"), {})
                        other_extra = _corrected_extra(dict(other_extra) if isinstance(other_extra, dict) else {}, other, {"crop": correction["crop"]})
                        tx.execute("UPDATE records SET crop = ?, crop_name = ?, extra_json = ?, updated_ms = ? WHERE id = ? AND account_id = ?",
                                   (correction["crop"], correction["crop"], db.to_json(other_extra), now, other["id"], row["account_id"]))
                        siblings += 1
                changes = []
                if "crop" in correction:
                    changes.append(f"jenis: {row['crop'] or '-'} → {correction['crop']}" + (f" (+{siblings} foto lain)" if siblings else ""))
                if "date" in correction:
                    changes.append(f"tanggal: {row['date'] or '-'} → {correction['date']}")
                settings_store.audit_tx(tx, "record.correct", record_id, "; ".join(changes),
                                        actor_email=account.get("email"), actor_id=account["id"])
            if "observedSeverity" in payload or "severity" in payload or "observedProblems" in payload:
                changes = []
                if "observedSeverity" in payload or "severity" in payload:
                    before = row.get("observed_severity") or row.get("severity") or "Belum dinilai"
                    if "observedSeverity" in payload:
                        after = payload["observedSeverity"] or row.get("severity") or "Belum dinilai"
                    else:
                        after = payload["severity"] or "Belum dinilai"
                    changes.append(f"status pengamatan: {before} → {after}")
                if "observedProblems" in payload:
                    changes.append("dugaan hama/penyakit diperbarui")
                settings_store.audit_tx(tx, "record.observe", record_id, "; ".join(changes),
                                        actor_email=account.get("email"), actor_id=account["id"])
    return db.row_record(db.query_one("SELECT * FROM records WHERE id = ?", (record_id,)))


# The earliest photo date a farmer can enter by hand (older dates are typing mistakes).
RECORD_EARLIEST_MS = 946684800000   # 2000-01-01


def _record_correction(payload: dict[str, Any]) -> dict[str, Any]:
    """0.2.4.17: the farmer's own correction of what a photo cannot prove - the species and the photo date.

    Allowed on AI records too, unlike `crop`: the diagnosis fields stay the AI's, and
    _corrected_extra keeps the AI's first species and the original time beside the correction.
    """
    out: dict[str, Any] = {}
    if "correctedCrop" in payload:
        name = _plain_text(payload.get("correctedCrop"), RECORD_NAME_MAX, "correctedCrop")
        if not name:
            raise HTTPException(status_code=400, detail="Jenis tanaman wajib diisi.")
        out["crop"] = name
    if "correctedTimestampMs" in payload:
        value = payload.get("correctedTimestampMs")
        if (isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)
                or not RECORD_EARLIEST_MS <= value <= db.now_ms() + 36 * 3600 * 1000):
            raise HTTPException(status_code=400, detail="Tanggal foto tidak valid.")
        out["timestamp_ms"] = int(value)
        out["date"] = time.strftime("%Y-%m-%d", time.localtime(int(value) / 1000))
    return out


def _corrected_extra(extra: dict[str, Any], row: dict[str, Any], correction: dict[str, Any]) -> dict[str, Any]:
    marked = [f for f in extra.get("corrected", []) if f in ("crop", "date")] if isinstance(extra.get("corrected"), list) else []
    if "crop" in correction:
        if row.get("source") == "ai" and "aiCrop" not in extra:
            extra["aiCrop"] = row.get("crop")
        back_to_ai = "aiCrop" in extra and correction["crop"] == extra["aiCrop"]
        marked = [f for f in marked if f != "crop"] + ([] if back_to_ai else ["crop"])
    if "timestamp_ms" in correction:
        if "originalTimestampMs" not in extra:
            extra["originalTimestampMs"] = row.get("timestamp_ms")
        extra["captureTimeKnown"] = True
        extra["captureTimeSource"] = "manual"
        marked = [f for f in marked if f != "date"] + ["date"]
    extra["corrected"] = marked
    return extra


@router.delete("/records/{record_id}")
def delete_record(record_id: str,
                  account: dict[str, Any] = Depends(auth.current_account)) -> dict[str, bool]:
    row = db.query_one("SELECT account_id, image_url FROM records WHERE id = ?", (record_id,))
    if not row or not _owner_or_admin(account, row["account_id"]):
        raise HTTPException(status_code=404, detail="Catatan tidak ditemukan")
    # The record and its photo's retirement (photo row removed + durable cleanup ticket)
    # commit together, so a crash can never leave one without the other.
    try:
        with storage.storage_lock():
            with db.transaction() as tx:
                tx.execute("DELETE FROM records WHERE id = ?", (record_id,))
                _delete_photo_for_url(row["image_url"], row["account_id"], tx=tx)
    except storage.StorageError:
        # Nothing was committed (the transaction rolled back): ask the farmer to retry.
        raise HTTPException(status_code=503, detail="Server sedang sibuk. Coba hapus lagi sebentar lagi.",
                            headers={"Retry-After": "5"})
    try:
        storage.drain(10, lock_timeout=1.0)   # opportunistic; the background drainer finishes the rest
    except Exception:  # noqa: BLE001 - the deletion is already committed and durable
        pass
    return {"ok": True}


# ---------------------------------------------------------------------------
# Daily
# ---------------------------------------------------------------------------


@router.get("/daily")
def list_daily(account: dict[str, Any] = Depends(auth.current_account)) -> list[dict[str, Any]]:
    rows = db.query(
        "SELECT * FROM daily WHERE account_id = ? ORDER BY COALESCE(timestamp_ms, created_ms) DESC",
        (account["id"],),
    )
    return [db.row_daily(row) for row in rows]


# ---------------------------------------------------------------------------
# Client error reports (0.2.4.15): what breaks on farmers' phones, kept on this server
# ---------------------------------------------------------------------------
# One audit row per distinct error (action "client.error"), shown on the admin overview. Signed-in
# accounts only; at most CLIENT_ERROR_BUDGET rows per account per hour; the same error is recorded once
# per 10 minutes; e-mail addresses, long numbers and token-like strings are masked; rows expire after 30 days.
CLIENT_ERROR_BUDGET = 20
_client_error_lock = threading.Lock()
_client_error_seen: dict[str, list[float]] = {}
_client_error_last: dict[str, float] = {}
_MASKS = (
    (re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+"), "[email]"),
    (re.compile(r"\b[A-Za-z0-9_-]{32,}\b"), "[token]"),
    (re.compile(r"\d{6,}"), "[angka]"),
)


def _client_error_text(value: Any, limit: int) -> str:
    text = " ".join(str(value or "").split())[:limit * 2]
    for pattern, mask in _MASKS:
        text = pattern.sub(mask, text)
    return text[:limit]


@router.post("/client-errors")
def client_error(payload: dict[str, Any] = Body(...),
                 account: dict[str, Any] = Depends(auth.current_account)) -> dict[str, Any]:
    message = _client_error_text(payload.get("message"), 300)
    if not message:
        raise HTTPException(status_code=400, detail="Pesan kesalahan kosong.")
    source = _client_error_text(str(payload.get("source") or "").split("?", 1)[0].rsplit("/", 1)[-1], 80)
    line = payload.get("line") if isinstance(payload.get("line"), int) and 0 <= payload.get("line") < 10**7 else None
    kind = "rejection" if payload.get("kind") == "rejection" else "error"
    release = _client_error_text(payload.get("release"), 20)
    view = _client_error_text(payload.get("view"), 20)
    platform = "android" if payload.get("native") is True else "web"
    key = f"{account['id']}|{message}|{source}|{line}"
    now = time.monotonic()
    with _client_error_lock:
        recent = [t for t in _client_error_seen.get(account["id"], []) if now - t < 3600]
        duplicate = now - _client_error_last.get(key, -1e9) < 600
        if duplicate or len(recent) >= CLIENT_ERROR_BUDGET:
            _client_error_seen[account["id"]] = recent
            return {"ok": True, "recorded": False}
        recent.append(now)
        _client_error_seen[account["id"]] = recent
        _client_error_last[key] = now
        if len(_client_error_last) > 5000:      # bounded memory on a long-running process
            for stale in [k for k, t in _client_error_last.items() if now - t >= 600]:
                _client_error_last.pop(stale, None)
    where = f"{source}:{line}" if source and line is not None else (source or "-")
    detail = f"{kind} · {platform} · versi {release or '?'} · layar {view or '?'} · {where} · {message}"
    settings_store.audit("client.error", view or platform, detail,
                         actor_email=account.get("email"), actor_id=account["id"])
    return {"ok": True, "recorded": True}


@router.post("/daily")
def upsert_daily(payload: dict[str, Any] = Body(...),
                  account: dict[str, Any] = Depends(auth.current_account)) -> dict[str, Any]:
    refs = payload.get("sourceRecordIds", [])
    if not isinstance(refs, list) or len(refs) > 1000 or any(not isinstance(ref, str) or not ref.strip() or len(ref) > 200 for ref in refs):
        raise HTTPException(status_code=400, detail="Referensi catatan harian tidak valid")
    refs = list(dict.fromkeys(refs))
    entry_id = payload.get("id")
    entry_id = _clean_id(entry_id, "ID rekomendasi") if isinstance(entry_id, str) else None
    if not entry_id:
        entry_id = db.new_id("daily")
    _reject_foreign_id("daily", entry_id, account["id"])
    now = db.now_ms()
    stamp = _timestamp_ms(payload.get("timestampMs"), now) or now
    values = {
        "id": entry_id, "account_id": account["id"],
        "date": (_plain_text(payload.get("date"), 100, "date")
                 or time.strftime("%Y-%m-%d", time.localtime(stamp / 1000))),
        "timestamp_ms": stamp,
        "title": _plain_text(payload.get("title"), DAILY_TEXT_MAX, "title"),
        "summary": _plain_text(payload.get("summary"), DAILY_TEXT_MAX, "summary", single_line=False),
        "actions_json": db.to_json(_text_list(payload.get("actions"), DAILY_TEXT_MAX)),
        "source_record_ids_json": db.to_json(refs),
        "zones_json": db.to_json(_text_list(payload.get("zones"), DAILY_ITEM_MAX)),
        "created_ms": now, "updated_ms": now,
    }
    with db.transaction() as tx:
        existing = tx.execute("SELECT account_id FROM daily WHERE id=?", (entry_id,)).fetchone()
        if existing and existing["account_id"] != account["id"]:
            raise HTTPException(status_code=409, detail="ID sudah dipakai")
        for ref in refs:
            if not tx.execute("SELECT 1 FROM records WHERE id=? AND account_id=?", (ref, account["id"])).fetchone():
                raise HTTPException(status_code=404, detail="Sumber catatan tidak tersedia untuk akun ini")
        tx.execute(
            """INSERT OR REPLACE INTO daily
               (id, account_id, date, timestamp_ms, title, summary, actions_json,
                source_record_ids_json, zones_json, created_ms, updated_ms)
               VALUES (:id,:account_id,:date,:timestamp_ms,:title,:summary,:actions_json,
                       :source_record_ids_json,:zones_json,:created_ms,:updated_ms)""",
            values,
        )
    return db.row_daily(db.query_one("SELECT * FROM daily WHERE id = ? AND account_id = ?",
                                     (entry_id, account["id"])))


@router.delete("/daily/{entry_id}")
def delete_daily(entry_id: str,
                 account: dict[str, Any] = Depends(auth.current_account)) -> dict[str, bool]:
    row = db.query_one("SELECT account_id FROM daily WHERE id = ?", (entry_id,))
    if not row or not _owner_or_admin(account, row["account_id"]):
        raise HTTPException(status_code=404, detail="Rekomendasi tidak ditemukan")
    with db.transaction() as tx:
        cursor = tx.execute("DELETE FROM daily WHERE id = ? AND account_id = ?",
                            (entry_id, row["account_id"]))
        if cursor.rowcount != 1:
            raise HTTPException(status_code=404, detail="Rekomendasi tidak ditemukan")
    return {"ok": True}


# ---------------------------------------------------------------------------
# Farms
# ---------------------------------------------------------------------------

FARM_PUT_ALLOWLIST = ("name", "crop", "note", "ring", "areaM2", "updatedMs")


@router.get("/farms")
def list_farms(account: dict[str, Any] = Depends(auth.current_account)) -> list[dict[str, Any]]:
    rows = db.query("SELECT * FROM farms WHERE account_id = ? ORDER BY COALESCE(created_ms,0) DESC",
                    (account["id"],))
    return [db.row_farm(row) for row in rows]


@router.post("/farms")
def create_farm(payload: dict[str, Any] = Body(...),
                account: dict[str, Any] = Depends(auth.current_account)) -> dict[str, Any]:
    if not isinstance(payload, dict) or "ring" not in payload:
        raise HTTPException(status_code=400, detail="Petak harus memiliki ring")
    ring = _validate_ring(payload.get("ring"))
    farm_id = payload.get("id")
    farm_id = _clean_id(farm_id, "ID petak") if isinstance(farm_id, str) else None
    if not farm_id:
        farm_id = db.new_id("farm")
    name = _plain_text(payload.get("name"), FARM_NAME_MAX, "name") or "Petak Tanpa Nama"
    crop = _plain_text(payload.get("crop"), FARM_CROP_MAX, "crop") or ""
    note = _plain_text(payload.get("note"), FARM_NOTE_MAX, "note", single_line=False) or ""
    source = payload.get("source")
    source = source if isinstance(source, str) and source in FARM_SOURCES else "peta"
    _reject_foreign_id("farms", farm_id, account["id"])
    now = db.now_ms()
    with db.transaction() as tx:
        existing = tx.execute("SELECT account_id FROM farms WHERE id=?", (farm_id,)).fetchone()
        if existing and existing["account_id"] != account["id"]:
            raise HTTPException(status_code=409, detail="ID sudah dipakai")
        area_m2 = _validated_area(payload.get("areaM2"))
        tx.execute(
            """INSERT OR REPLACE INTO farms
               (id, account_id, name, crop, note, ring_json, area_m2, source, created_ms, updated_ms)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (farm_id, account["id"], name, crop, note, db.to_json(ring),
             area_m2, source, _timestamp_ms(payload.get("createdMs"), now) or now, now),
        )
    return db.row_farm(db.query_one("SELECT * FROM farms WHERE id = ? AND account_id = ?",
                                    (farm_id, account["id"])))


@router.put("/farms/{farm_id}")
def update_farm(farm_id: str, payload: dict[str, Any] = Body(...),
                account: dict[str, Any] = Depends(auth.current_account)) -> dict[str, Any]:
    row = db.query_one("SELECT * FROM farms WHERE id = ?", (farm_id,))
    if not row or not _owner_or_admin(account, row["account_id"]):
        raise HTTPException(status_code=404, detail="Petak tidak ditemukan")
    fields: dict[str, Any] = {}
    if "name" in payload:
        fields["name"] = _plain_text(payload["name"], FARM_NAME_MAX, "name") or "Petak Tanpa Nama"
    if "crop" in payload:
        fields["crop"] = _plain_text(payload["crop"], FARM_CROP_MAX, "crop") or ""
    if "note" in payload:
        fields["note"] = _plain_text(payload["note"], FARM_NOTE_MAX, "note", single_line=False) or ""
    if "ring" in payload:
        fields["ring_json"] = db.to_json(_validate_ring(payload.get("ring")))
    if "areaM2" in payload:
        fields["area_m2"] = _validated_area(payload.get("areaM2"))
    if fields:
        assignments = ", ".join(f"{key} = ?" for key in fields)
        with db.transaction() as tx:
            cursor = tx.execute(f"UPDATE farms SET {assignments}, updated_ms = ? WHERE id = ? AND account_id = ?",
                                list(fields.values()) + [db.now_ms(), farm_id, row["account_id"]])
            if cursor.rowcount != 1:
                raise HTTPException(status_code=404, detail="Petak tidak ditemukan")
    return db.row_farm(db.query_one("SELECT * FROM farms WHERE id = ?", (farm_id,)))


@router.delete("/farms/{farm_id}")
def delete_farm(farm_id: str,
                account: dict[str, Any] = Depends(auth.current_account)) -> dict[str, bool]:
    row = db.query_one("SELECT account_id FROM farms WHERE id = ?", (farm_id,))
    if not row or not _owner_or_admin(account, row["account_id"]):
        raise HTTPException(status_code=404, detail="Petak tidak ditemukan")
    with db.transaction() as tx:
        cursor = tx.execute("DELETE FROM farms WHERE id = ? AND account_id = ?",
                            (farm_id, row["account_id"]))
        if cursor.rowcount != 1:
            raise HTTPException(status_code=404, detail="Petak tidak ditemukan")
    return {"ok": True}


# ---------------------------------------------------------------------------
# Photos — ownership-checked, NOT a public static mount
# ---------------------------------------------------------------------------


def _thumbnail_b64_from_bytes(data: bytes, max_px: int, quality: int) -> str:
    """Decode and thumbnail in one blocking step, for use via run_in_threadpool.

    The whole pipeline (decode, resize, JPEG encode) holds one of the two decode slots.
    """
    with _decode_slot():
        try:
            return _make_thumbnail_b64(_open_image(data, max_px), max_px, quality)
        except HTTPException:
            raise
        except Exception:  # noqa: BLE001 - an image Pillow cannot finish is the client's problem
            raise HTTPException(status_code=400, detail="Berkas gambar tidak valid") from None


def _store_photo_sync(data: bytes, account_id: str, photo_id: str | None = None) -> str:
    """Decode, downscale and durably publish a photo. Blocking, so it runs in a threadpool.

    Decode/resize/encode happen FIRST, holding only the decoder slot (no storage or DB
    lock). storage.publish_photo then reserves a fresh, never-reused internal file name,
    stages and publishes the file crash-safely and inserts the photo row (see storage.py).
    The PUBLIC photo id (the `/api/photos/<id>` URL) is unchanged; the file name is a
    random token. A photo id that was published and later deleted raises
    storage.PhotoUnavailable: it is never recreated, not even from retained job bytes.
    """
    generated = photo_id is None
    candidate = photo_id or db.new_id("photo")
    existing = db.query_one("SELECT account_id FROM photos WHERE id=?", (candidate,))
    if existing:
        if existing["account_id"] != account_id:
            raise HTTPException(status_code=404, detail="Foto tidak ditemukan")
        return candidate
    with _decode_slot():
        image = _open_image(data, _STORE_PHOTO_PX)
        photo = _to_rgb(image)
        photo.thumbnail((_STORE_PHOTO_PX, _STORE_PHOTO_PX), Image.LANCZOS)
        buf = io.BytesIO()
        photo.save(buf, format="JPEG", quality=_STORE_PHOTO_QUALITY, optimize=True)
    blob = buf.getvalue()
    for _ in range(3):
        try:
            return storage.publish_photo(blob, account_id, candidate)
        except (storage.PhotoIdConflict, storage.PhotoUnavailable) as error:
            if generated:  # an id collision on a server-made id: simply take another one
                candidate = db.new_id("photo")
                continue
            if isinstance(error, storage.PhotoIdConflict):
                raise HTTPException(status_code=404, detail="Foto tidak ditemukan") from None
            raise
        except storage.AccountUnavailable:
            raise HTTPException(status_code=401, detail="Akun tidak aktif") from None
        except storage.StorageBusy:
            raise CodedHTTPException(503, "Penyimpanan foto sedang sibuk. Coba lagi sebentar lagi.",
                                     "storage_busy", headers={"Retry-After": "5"}) from None
        except (OSError, storage.StorageError):
            raise HTTPException(status_code=503,
                                detail="Foto belum dapat disimpan di server. Coba lagi nanti.") from None
    raise HTTPException(status_code=503, detail="Foto belum dapat disimpan di server. Coba lagi nanti.")


def _check_photo_upload_quota(account_id: str) -> None:
    """At most PHOTO_UPLOADS_PER_DAY direct uploads per account per 24 h (429 beyond).

    The app itself no longer calls this route (photos travel inside /api/analyze), but old
    APKs may, and it was unlimited. Photos recovered from an AI job (`photo_job_...`) are
    server-made and do not count.
    """
    since = db.now_ms() - 86_400_000
    row = db.query_one(
        "SELECT COUNT(*) AS n, MIN(created_ms) AS oldest FROM photos "
        "WHERE account_id = ? AND created_ms >= ? AND id NOT LIKE 'photo\\_job\\_%' ESCAPE '\\'",
        (account_id, since))
    if row and int(row["n"]) >= PHOTO_UPLOADS_PER_DAY:
        oldest = int(row["oldest"] if row["oldest"] is not None else db.now_ms())
        wait = int((oldest + 86_400_000 - db.now_ms()) // 1000) + 1
        raise CodedHTTPException(429, f"Batas unggah foto harian tercapai ({PHOTO_UPLOADS_PER_DAY} foto per 24 jam). "
                                      "Coba lagi nanti.", "photo_quota",
                                 headers={"Retry-After": str(min(max(wait, 60), 86_400))})


@router.post("/photos")
async def upload_photo(file: UploadFile = File(...),
                       account: dict[str, Any] = Depends(auth.current_account)) -> dict[str, str]:
    # Refuse before spending anything on the body (a database read, so off the event loop).
    await run_in_threadpool(_check_photo_upload_quota, account["id"])
    data = await _read_capped(file)
    # Decoding, downscaling and re-encoding a phone photo is hundreds of
    # milliseconds of CPU. Doing that inside the event loop on a single-worker
    # deployment froze every other request, the worker's claim poll included, so it
    # goes to a threadpool.
    photo_id = await run_in_threadpool(_store_photo_sync, data, account["id"])
    return {"url": f"/api/photos/{photo_id}"}


def _readable_photo_path(photo_id: str, request: Request) -> Path:
    # Images are fetched by <img src>, which cannot send a CSRF header, so accept a
    # session cookie here and check ownership explicitly.
    account = security.session_account(request.cookies.get(security.SESSION_COOKIE))
    if not account:
        raise HTTPException(status_code=401, detail="Belum masuk")
    row = db.query_one("SELECT * FROM photos WHERE id = ?", (photo_id,))
    if not row or not _owner_or_admin(account, row["account_id"]):
        raise HTTPException(status_code=404, detail="Foto tidak ditemukan")
    if storage.is_retired(row["file_name"]):
        # Retiring/retired objects are pending deletion: never served, whatever else says.
        raise HTTPException(status_code=404, detail="Foto tidak ditemukan")
    path = UPLOAD_DIR / row["file_name"]
    if not path.exists():
        raise HTTPException(status_code=404, detail="Berkas foto hilang")
    return path


@router.get("/photos/{photo_id}")
def get_photo(photo_id: str, request: Request) -> FileResponse:
    return FileResponse(_readable_photo_path(photo_id, request), media_type="image/jpeg")


@lru_cache(maxsize=512)
def _map_thumbnail(path: Path, _file_revision: tuple[int, int, int]) -> bytes:
    # A bounded memory cache avoids a second on-disk photo lifecycle. The revision
    # changes if the stored file is replaced, and access is checked before each hit.
    with _decode_slot():
        with _open_image(path.read_bytes(), 192) as image:
            thumbnail = ImageOps.fit(_to_rgb(image), (96, 96), Image.Resampling.LANCZOS)
            with io.BytesIO() as encoded:
                thumbnail.save(encoded, format="JPEG", quality=76, optimize=True)
                return encoded.getvalue()


@router.get("/photos/{photo_id}/thumbnail")
def get_photo_thumbnail(photo_id: str, request: Request) -> Response:
    path = _readable_photo_path(photo_id, request)
    try:
        file = path.stat()
        content = _map_thumbnail(path, (file.st_ino, file.st_mtime_ns, file.st_size))
    except OSError:
        raise HTTPException(status_code=404, detail="Berkas foto hilang") from None
    return Response(content, media_type="image/jpeg", headers={"Cache-Control": "private, no-store"})


# ---------------------------------------------------------------------------
# Analysis queue
# ---------------------------------------------------------------------------


@router.post("/analyze")
async def analyze(
    image: UploadFile = File(...),
    lat: str | None = Form(None),
    lng: str | None = Form(None),
    elevation: str | None = Form(None),
    locationName: str | None = Form(None),
    accuracy: str | None = Form(None),
    weather: str | None = Form(None),
    photoDate: str | None = Form(None),
    photoTimestampMs: str | None = Form(None),
    farmId: str | None = Form(None),
    deviceId: str | None = Form(None),
    cropHint: str | None = Form(None),
    cropId: str | None = Form(None),
    tier: str | None = Form(None),   # legacy: clients older than 0.2.4.7 picked their own mode
    clientRequestId: str | None = Form(None),
    locationSource: str | None = Form(None),
    account: dict[str, Any] = Depends(auth.current_account),
) -> dict[str, Any]:
    request_id = (clientRequestId or "").strip()
    if clientRequestId is not None and (not request_id or len(request_id) > 128):
        raise HTTPException(status_code=400, detail="Nomor kiriman foto tidak valid.")
    data = await _read_capped(image)
    latitude, longitude = _validate_coordinates(lat, lng)
    elevation_value = _strict_number(elevation, "elevation")
    accuracy_value = _strict_number(accuracy, "accuracy")
    location_source = locationSource if isinstance(locationSource, str) else None
    if location_source not in (None, "gps", "manual", "plot", "unknown", "camera-capture", "gallery-exif", "gallery-unknown"):
        raise HTTPException(status_code=400, detail="Sumber lokasi tidak valid.")
    if location_source in ("manual", "plot"):
        accuracy_value = None
    if accuracy_value is not None and accuracy_value < 0:
        raise HTTPException(status_code=400, detail="Akurasi GPS tidak boleh negatif.")
    stamp = _strict_number(photoTimestampMs, "photoTimestampMs")
    if stamp is not None and (not stamp.is_integer() or stamp < 0 or stamp > db.now_ms() + 86_400_000):
        raise HTTPException(status_code=400, detail="Waktu foto tidak valid.")
    farm_id = (farmId or "").strip() or None
    crop_id = cropId.strip() if isinstance(cropId, str) else None
    # Free text is sanitised and TRUNCATED (never rejected, so an old offline draft still
    # sends). These strings are pasted into the model prompt, hence single-line.
    device_id = textsafe.one_line(deviceId, DEVICE_ID_MAX) or None
    context = {
        "lat": latitude, "lng": longitude, "elevation": elevation_value,
        "locationName": textsafe.one_line(locationName, LOCATION_NAME_MAX) or None,
        "accuracy": accuracy_value, "weather": textsafe.one_line(weather, WEATHER_MAX) or None,
        "photoDate": textsafe.one_line(photoDate, PHOTO_DATE_MAX) or None,
        "photoTimestampMs": int(stamp) if stamp is not None and stamp.is_integer() else stamp,
        "farmId": farm_id, "deviceId": device_id,
        "cropHint": textsafe.one_line(cropHint, CROP_HINT_MAX) or None,
        # analysisTier is no longer part of the request digest or the client's choice:
        # _admission_tier picks it from the account's remaining daily fast allowance, so
        # the same photo always hashes the same however the farmer got there.
    }
    if location_source is not None:
        context["locationSource"] = location_source
    if crop_id:
        context["cropId"] = crop_id
    digest = hashlib.sha256(data + b"\0" + json.dumps(context, ensure_ascii=False, sort_keys=True,
                                                           separators=(",", ":"), allow_nan=False).encode()).hexdigest()
    # Every database touch below runs in the threadpool: SQLite (and its single write lock)
    # blocks, and on the event loop it froze every other request, the worker's poll included.
    receipt = await run_in_threadpool(_analyze_precheck, account["id"], request_id, digest, farm_id, crop_id)
    if receipt is not None:
        return receipt
    # Decode + thumbnail is CPU work measured in hundreds of milliseconds, and at most two
    # decodes run at once in the whole process (see _decode_slot).
    image_b64 = await run_in_threadpool(_thumbnail_b64_from_bytes, data, _PHONE_THUMB_PX, 82)
    return await run_in_threadpool(_analyze_admit, account["id"], request_id, digest, image_b64,
                                   context, device_id)


def _replay_receipt(previous: dict[str, Any]) -> dict[str, Any]:
    return {"job_id": previous["id"], "status": previous["status"],
            "position": queue.queue_position(previous["id"]) or 0}


def _admission_refusal(account_id: str, tx: Any = None) -> CodedHTTPException | None:
    """429 when this account (or the whole server) already has too many photos waiting."""
    mine, total = queue.pending_counts(account_id, tx)
    if mine >= queue.MAX_PENDING_PER_ACCOUNT:
        return CodedHTTPException(
            429, f"Antrean analisis Anda penuh ({queue.MAX_PENDING_PER_ACCOUNT} foto sedang menunggu). "
                 "Tunggu hasilnya keluar, lalu kirim foto berikutnya.",
            "queue_full", headers={"Retry-After": "60"})
    if total >= queue.MAX_PENDING_GLOBAL:
        return CodedHTTPException(
            429, "Server analisis sedang sangat ramai. Foto Anda aman — coba kirim lagi sebentar lagi.",
            "queue_busy", headers={"Retry-After": "120"})
    return None


def _analyze_precheck(account_id: str, request_id: str, digest: str, farm_id: str | None,
                      crop_id: str | None) -> dict[str, Any] | None:
    """Cheap refusals before any CPU goes into the photo.

    Returns the original receipt for an idempotent replay (a replay is answered before
    anything else is asked, so it is never blocked by a cap or a deleted plot), None to
    carry on, or raises.
    """
    if request_id:
        previous = db.query_one("SELECT id, status, request_hash FROM jobs WHERE account_id=? AND client_request_id=?",
                                (account_id, request_id))
        if previous:
            if previous["request_hash"] != digest:
                raise HTTPException(status_code=409, detail="Nomor kiriman ini sudah dipakai untuk foto lain.")
            return _replay_receipt(previous)
    if farm_id and not db.query_one("SELECT id FROM farms WHERE id=? AND account_id=?", (farm_id, account_id)):
        raise HTTPException(status_code=404, detail="Petak tidak ditemukan")
    if crop_id and (len(crop_id) > ID_MAX or not db.query_one(
            "SELECT id FROM records WHERE crop_id=? AND account_id=? LIMIT 1", (crop_id, account_id))):
        raise HTTPException(status_code=404, detail="Tanaman tidak ditemukan")
    refusal = _admission_refusal(account_id)
    if refusal is not None:
        raise refusal
    return None


def _admission_tier(account: dict[str, Any], now: int, tx: Any) -> str:
    """`fast` while the account's daily fast allowance lasts, then `normal`.

    The farmer no longer chooses a mode: the fast lane answers in seconds, and the normal
    lane keeps the operator's queue pacer so a long day is still analysed without
    hammering the router budget. Must be called inside the admission transaction.
    """
    quota = queue.fast_quota_snapshot(account, now_ms=now, tx=tx)
    cap = quota.get("fastQuota")
    if cap is None:
        return "fast"                      # admin: no allowance to run out of
    return "normal" if quota["fastUsed"] >= cap else "fast"


def _analyze_admit(account_id: str, request_id: str, digest: str, image_b64: str,
                   context: dict[str, Any], device_id: str | None) -> dict[str, Any]:
    now = db.now_ms()
    job_id = db.new_id("job")
    with db.transaction() as tx:
        # Role and active state are read from the persisted row within the
        # admission transaction, never from the potentially stale dependency.
        persisted = tx.execute("SELECT id, role, is_active FROM accounts WHERE id = ?", (account_id,)).fetchone()
        if not persisted or not persisted["is_active"]:
            raise HTTPException(status_code=401, detail="Akun tidak aktif")
        if request_id:
            previous = tx.execute("SELECT id, status, request_hash FROM jobs WHERE account_id=? AND client_request_id=?",
                                  (account_id, request_id)).fetchone()
            if previous:
                if previous["request_hash"] != digest:
                    raise HTTPException(status_code=409, detail="Nomor kiriman ini sudah dipakai untuk foto lain.")
                return _replay_receipt(previous)
        # One button. While today's fast allowance lasts the photo runs on the fast pair;
        # afterwards it is still analysed, on the paced normal pair, instead of being
        # refused. The counter and the decision share this transaction, so two
        # simultaneous uploads cannot both slip past the allowance.
        tier = _admission_tier(dict(persisted), now, tx)
        context = {**context, "analysisTier": tier}
        # The authoritative cap check shares the transaction with the insert, so two
        # simultaneous photos cannot both slip under the limit.
        refusal = _admission_refusal(account_id, tx)
        if refusal is not None:
            raise refusal
        tx.execute(
            """INSERT INTO jobs (id, account_id, status, attempts, created_ms, updated_ms,
                                 device_id, image_b64, context_json, acked, client_request_id, request_hash)
               VALUES (?,?,'queued',0,?,?,?,?,?,0,?,?)""",
            (job_id, account_id, now, now, device_id, image_b64, db.to_json(context),
             request_id or None, digest if request_id else None),
        )
    position = queue.queue_position(job_id)
    return {"job_id": job_id, "status": "queued", "tier": tier,
            "position": position if position is not None else 0}


def _active_reanalysis(account_id: str, record_id: str, tx: Any = None) -> dict[str, Any] | None:
    """Return an already queued/claimed job for this exact record.

    ``context_json`` is server-owned and at most a few hundred bytes. Scanning the
    small active backlog avoids adding a schema migration just for this idempotency
    guard and keeps concurrent taps from spending two model calls.
    """
    run = tx.execute if tx is not None else db.conn().execute
    rows = run(
        "SELECT id, status, context_json FROM jobs "
        "WHERE account_id = ? AND status IN ('queued','claimed') ORDER BY created_ms",
        (account_id,),
    ).fetchall()
    for row in rows:
        context = db.from_json(row["context_json"], {})
        if isinstance(context, dict) and context.get("reanalysisRecordId") == record_id:
            # Carry the stored lane back out so a repeated tap reports the same tier.
            return {"id": row["id"], "status": row["status"], "context_json": row["context_json"]}
    return None


def _reanalysis_receipt(row: dict[str, Any]) -> dict[str, Any]:
    context = db.from_json(row.get("context_json"), {}) if row.get("context_json") else {}
    tier = context.get("analysisTier") if isinstance(context, dict) else None
    return {"jobId": row["id"], "job_id": row["id"], "status": row["status"],
            "position": queue.queue_position(row["id"]) or 0,
            "tier": tier if tier in ("fast", "normal") else None,
            "source": "original-photo-no-stamp"}


def _reanalysis_precheck(account_id: str, record_id: str) -> dict[str, Any] | None:
    active = _active_reanalysis(account_id, record_id)
    if active is not None:
        return _reanalysis_receipt(active)
    refusal = _admission_refusal(account_id)
    if refusal is not None:
        raise refusal
    return None


def _reanalysis_source(record_id: str, account: dict[str, Any]) -> tuple[bytes, dict[str, Any], int, str]:
    """Read the owned, clean server original used by the first diagnosis.

    The stamped image shown/exported by the phone is a local rendering. It is never
    stored here or sent to the model. Keeping this resolver server-side also means
    the browser cannot substitute a different photo for a re-analysis.
    """
    row = db.query_one("SELECT * FROM records WHERE id = ?", (record_id,))
    if not row or row.get("account_id") != account.get("id"):
        raise HTTPException(status_code=404, detail="Catatan tidak ditemukan")
    if row.get("source") != "ai":
        raise HTTPException(status_code=409, detail="Analisis ulang hanya tersedia untuk hasil foto AI.")
    ref = storage.parse_image_reference(row.get("image_url"))
    if ref.kind != "photo" or not ref.photo_id:
        raise HTTPException(status_code=409, detail="Foto asli catatan ini tidak tersedia untuk analisis ulang.")
    photo = db.query_one("SELECT account_id, file_name FROM photos WHERE id = ?", (ref.photo_id,))
    if not photo or photo["account_id"] != account["id"]:
        raise HTTPException(status_code=404, detail="Foto tidak ditemukan")
    if storage.is_retired(photo["file_name"]):
        raise HTTPException(status_code=404, detail="Foto tidak ditemukan")
    path = UPLOAD_DIR / photo["file_name"]
    try:
        if not path.exists() or not path.is_file():
            raise HTTPException(status_code=404, detail="Berkas foto asli tidak ditemukan")
        size = path.stat().st_size
        limit = settings_store.as_int("MAX_UPLOAD_MB") * 1024 * 1024
        if size <= 0:
            raise HTTPException(status_code=400, detail="Foto asli kosong atau tidak terbaca")
        if size > limit:
            raise HTTPException(status_code=413, detail="Foto asli terlalu besar untuk dianalisis ulang")
        data = path.read_bytes()
    except HTTPException:
        raise
    except OSError:
        raise HTTPException(status_code=404, detail="Berkas foto asli tidak ditemukan") from None

    extra = db.from_json(row.get("extra_json"), {})
    extra = extra if isinstance(extra, dict) else {}
    capture_known = extra.get("captureTimeKnown") is not False
    photo_ts = row.get("timestamp_ms") if capture_known else None
    location_source = extra.get("locationSource")
    if location_source not in ("manual", "plot", "gps", "camera-capture", "gallery-exif", "gallery-unknown", "unknown"):
        location_source = "unknown"
    context = {
        "lat": row.get("lat"), "lng": row.get("lng"), "elevation": row.get("elevation"),
        "locationName": textsafe.one_line(row.get("location_name"), LOCATION_NAME_MAX) or None,
        "accuracy": None if location_source in ("manual", "plot", "unknown", "gallery-unknown") else row.get("accuracy"),
        "photoDate": textsafe.one_line(row.get("date"), PHOTO_DATE_MAX) if capture_known else None,
        "photoTimestampMs": int(photo_ts) if isinstance(photo_ts, (int, float)) and not isinstance(photo_ts, bool) else None,
        "farmId": row.get("farm_id"), "deviceId": textsafe.one_line(row.get("device_id"), DEVICE_ID_MAX) or None,
        "cropHint": textsafe.one_line(row.get("crop_name") or row.get("crop"), CROP_HINT_MAX) or None,
        "locationSource": location_source,
        "reanalysisRecordId": record_id, "reanalysisSource": "original-photo-no-stamp",
        "reanalysisPhotoId": ref.photo_id,
        "reanalysisPhotoSha256": hashlib.sha256(data).hexdigest(),
    }
    if row.get("crop_id"):
        context["cropId"] = row["crop_id"]
    return data, context, int(row["updated_ms"]), ref.photo_id


def _reanalysis_admit(account_id: str, record_id: str, record_updated_ms: int,
                      image_b64: str, context: dict[str, Any], device_id: str | None,
                      actor_email: str | None) -> dict[str, Any]:
    now = db.now_ms()
    job_id = db.new_id("job")
    with db.transaction() as tx:
        persisted = tx.execute("SELECT id, role, is_active FROM accounts WHERE id = ?", (account_id,)).fetchone()
        if not persisted or not persisted["is_active"]:
            raise HTTPException(status_code=401, detail="Akun tidak aktif")
        current = tx.execute(
            "SELECT source, updated_ms FROM records WHERE id = ? AND account_id = ?",
            (record_id, account_id),
        ).fetchone()
        if current is None:
            raise HTTPException(status_code=404, detail="Catatan tidak ditemukan")
        if current["source"] != "ai":
            raise HTTPException(status_code=409, detail="Analisis ulang hanya tersedia untuk hasil foto AI.")
        if int(current["updated_ms"]) != record_updated_ms:
            raise HTTPException(status_code=409, detail="Catatan berubah saat disiapkan. Coba analisis ulang lagi.")
        active = _active_reanalysis(account_id, record_id, tx=tx)
        if active is not None:
            return _reanalysis_receipt(active)
        refusal = _admission_refusal(account_id, tx)
        if refusal is not None:
            raise refusal
        context = {**context, "analysisTier": _admission_tier(dict(persisted), now, tx)}
        if context.get("farmId") and not tx.execute(
                "SELECT 1 FROM farms WHERE id=? AND account_id=?", (context["farmId"], account_id)).fetchone():
            context = {**context, "farmId": None}
        if context.get("cropId") and not tx.execute(
                "SELECT 1 FROM records WHERE crop_id=? AND account_id=? LIMIT 1",
                (context["cropId"], account_id)).fetchone():
            context = {**context, "cropId": None}
        tx.execute(
            """INSERT INTO jobs (id, account_id, status, attempts, created_ms, updated_ms,
                                 device_id, image_b64, context_json, acked)
               VALUES (?,?,'queued',0,?,?,?,?,?,0)""",
            (job_id, account_id, now, now, device_id, image_b64, db.to_json(context)),
        )
        settings_store.audit_tx(
            tx, "record.reanalyze.queued", record_id,
            f"job={job_id}; photo={context.get('reanalysisPhotoId')}; source=original-photo-no-stamp",
            actor_email=actor_email, actor_id=account_id,
        )
    receipt = _reanalysis_receipt({"id": job_id, "status": "queued",
                                   "context_json": db.to_json(context)})
    receipt["photoId"] = context.get("reanalysisPhotoId")
    return receipt


@router.post("/records/{record_id}/reanalyze")
async def reanalyze_record(record_id: str,
                           account: dict[str, Any] = Depends(auth.current_account)) -> dict[str, Any]:
    """Queue a fresh AI diagnosis from the owned, unstamped source photo.

    The existing record is updated atomically when the worker posts its result.
    This route never accepts diagnosis or image data from the client.
    """
    record_id = _clean_id(record_id, "ID catatan")
    receipt = await run_in_threadpool(_reanalysis_precheck, account["id"], record_id)
    if receipt is not None:
        return receipt
    data, context, record_updated_ms, _photo_id = await run_in_threadpool(
        _reanalysis_source, record_id, account)
    image_b64 = await run_in_threadpool(_thumbnail_b64_from_bytes, data, _PHONE_THUMB_PX, 82)
    return await run_in_threadpool(
        _reanalysis_admit, account["id"], record_id, record_updated_ms, image_b64,
        context, context.get("deviceId"), account.get("email"),
    )


@router.get("/analyze/{job_id}")
def analyze_status(job_id: str, request: Request,
                   account: dict[str, Any] = Depends(auth.current_account)) -> dict[str, Any]:
    # Explicit columns: SELECT * dragged the 100-200 KB image through memory on every poll.
    row = db.query_one(f"SELECT {queue.JOB_PUBLIC_COLUMNS} FROM jobs WHERE id = ?", (job_id,))
    if not row or not _owner_or_admin(account, row["account_id"]):
        raise HTTPException(status_code=404, detail="Pekerjaan tidak ditemukan")
    job = db.row_job(row)
    if row["status"] in ("queued", "claimed"):
        job["position"] = queue.queue_position(job_id)
    # What the worker is doing right now, so the phone can say something specific
    # ("model triase sedang memeriksa") instead of a generic spinner.
    latest = queue.latest_event(job_id)
    if latest:
        if account.get("role") == "admin":
            job["stage"] = latest["stage"]
            job["stageDetail"] = latest["detail"]
            job["stageMs"] = latest["tsMs"]
        else:
            # A farmer gets fixed Bahasa labels only. The raw trace detail (router host and
            # port, provider JSON) stays on the admin routes.
            label = queue.stage_label(latest["stage"])
            if label:
                job["stage"] = latest["stage"]
                job["stageLabel"] = label
                job["stageMs"] = latest["tsMs"]
    return job


@router.post("/analyze/{job_id}/trace")
def analyze_trace(job_id: str, payload: dict[str, Any] = Body(...),
                  _worker: None = Depends(require_worker)) -> dict[str, Any]:
    """Worker-reported step, including each router call with status and latency."""
    row = db.query_one("SELECT id FROM jobs WHERE id = ?", (job_id,))
    if not row:
        raise HTTPException(status_code=404, detail="Pekerjaan tidak ditemukan")
    stage = textsafe.one_line(payload.get("stage"), 64) if isinstance(payload.get("stage"), str) else ""
    if not stage:
        raise HTTPException(status_code=400, detail="stage wajib diisi")
    model = payload.get("model")
    token = payload.get("claimToken")
    if not isinstance(token, str) or not token:
        raise HTTPException(status_code=409, detail="Klaim pekerjaan tidak berlaku")
    recorded = queue.add_event(job_id, stage, model=textsafe.one_line(model, 120) if isinstance(model, str) else None,
                    http_status=payload.get("httpStatus"),
                    latency_ms=payload.get("latencyMs"), detail=payload.get("detail")
                    if isinstance(payload.get("detail"), str) else None, claim_token=token)
    if not recorded:
        raise HTTPException(status_code=409, detail="Klaim pekerjaan tidak berlaku")
    return {"ok": True}


@router.post("/analyze/{job_id}/renew")
def analyze_renew(job_id: str, payload: dict[str, Any] = Body(...),
                  _worker: None = Depends(require_worker)) -> dict[str, Any]:
    if not queue.renew_claim(job_id, payload.get("claimToken"), settings_store.as_int("QUEUE_STALE_CLAIM_SEC")):
        raise HTTPException(status_code=409, detail="Klaim pekerjaan tidak berlaku")
    return {"ok": True}


@router.post("/analyze/{job_id}/release")
def analyze_release(job_id: str, payload: dict[str, Any] = Body(default={}),
                    _worker: None = Depends(require_worker)) -> dict[str, Any]:
    """Hand a job back to the queue without spending one of its attempts.

    A timeout, a 429 or a 5xx is a provider problem: it is not evidence that the
    photo was bad, so the attempt is refunded. The job does NOT go back to the head of
    the queue though: it waits out a persistent backoff and is given up after repeated
    releases (see queue.release_job). `kind` is "provider" (default), or "auth"/"config"
    for a router key / URL the operator must fix (fixed 5 minute wait, not counted).
    """
    reason = payload.get("reason")
    outcome = queue.release_job(job_id, textsafe.one_line(reason, 200) if isinstance(reason, str) else "",
                                payload.get("kind") if isinstance(payload.get("kind"), str) else "provider",
                                claim_token=payload.get("claimToken"))
    if outcome["status"] == "missing":
        raise HTTPException(status_code=404, detail="Pekerjaan tidak ditemukan")
    if outcome["status"] == "stale_claim":
        raise HTTPException(status_code=409, detail="Klaim pekerjaan tidak berlaku")
    return {"ok": True, "released": outcome["released"], "status": outcome["status"],
            "givenUp": outcome["givenUp"], "notBeforeMs": outcome["notBeforeMs"]}


@router.post("/analyze/{job_id}/ack")
def analyze_ack(job_id: str,
                account: dict[str, Any] = Depends(auth.current_account)) -> dict[str, bool]:
    row = db.query_one("SELECT id, account_id, status FROM jobs WHERE id = ?", (job_id,))
    if not row or not _owner_or_admin(account, row["account_id"]):
        raise HTTPException(status_code=404, detail="Pekerjaan tidak ditemukan")
    if row["status"] not in ("done", "rejected", "failed", "cancelled"):
        raise HTTPException(status_code=409, detail="Pekerjaan belum selesai")
    with db.transaction() as tx:
        # Dropping the photo here — once the farmer actually has the result — is what
        # keeps the database from growing by a thumbnail per analysis forever. It stays
        # until then so a cancelled or abandoned analysis can still be collected with
        # its image attached.
        updated = tx.execute(
            """UPDATE jobs SET acked = 1, image_b64 = NULL, updated_ms = ?
                 WHERE id = ? AND account_id = ? AND status IN ('done','rejected','failed','cancelled')""",
            (db.now_ms(), job_id, account["id"]),
        )
        if updated.rowcount != 1:
            raise HTTPException(status_code=409, detail="Pekerjaan belum selesai")
    return {"ok": True}


@router.post("/analyze/{job_id}/cancel")
def analyze_cancel(job_id: str,
                   account: dict[str, Any] = Depends(auth.current_account)) -> dict[str, Any]:
    """Cancel an owned queued/claimed job; terminal outcomes are idempotent."""
    row = db.query_one("SELECT id, account_id, status FROM jobs WHERE id = ?", (job_id,))
    if not row or not _owner_or_admin(account, row["account_id"]):
        raise HTTPException(status_code=404, detail="Pekerjaan tidak ditemukan")
    if row["status"] not in ("queued", "claimed"):
        return {"ok": True, "status": row["status"]}
    with db.transaction() as tx:
        updated = tx.execute(
            """UPDATE jobs SET status='cancelled', worker=NULL, claimed_ms=NULL, claim_token=NULL, lease_expires_ms=NULL, acked=0,
                      error='Dibatalkan', updated_ms=?
                 WHERE id=? AND account_id=? AND status IN ('queued','claimed')""",
            (db.now_ms(), job_id, row["account_id"]),
        )
        current = tx.execute("SELECT status FROM jobs WHERE id=? AND account_id=?",
                             (job_id, row["account_id"])).fetchone()
    if not current:
        raise HTTPException(status_code=404, detail="Pekerjaan tidak ditemukan")
    return {"ok": True, "status": current["status"]}


@router.get("/queue/pending")
def queue_pending(deviceId: str | None = None,
                  account: dict[str, Any] = Depends(auth.current_account)) -> list[dict[str, Any]]:
    """All unacknowledged jobs for this account — restart/history recovery."""
    sql = f"SELECT {queue.JOB_PUBLIC_COLUMNS} FROM jobs WHERE account_id = ? AND acked = 0"
    params: list[Any] = [account["id"]]
    if deviceId:
        sql += " AND (device_id = ? OR device_id IS NULL)"
        params.append(deviceId)
    sql += " ORDER BY updated_ms DESC"
    return [db.row_job(row) for row in db.query(sql, params)]


@router.post("/analyze/{job_id}/result")
def analyze_result(job_id: str, payload: dict[str, Any] = Body(...),
                   _worker: None = Depends(require_worker)) -> dict[str, Any]:
    triage = payload.get("triage")
    diagnosis = payload.get("diagnosis")
    if not isinstance(triage, dict) or not isinstance(diagnosis, dict):
        raise HTTPException(status_code=400, detail="triage dan diagnosis wajib berupa objek")
    row = db.query_one("SELECT id, status FROM jobs WHERE id = ?", (job_id,))
    if not row:
        raise HTTPException(status_code=404, detail="Pekerjaan tidak ditemukan")
    if row["status"] not in ("queued", "claimed"):
        raise HTTPException(status_code=409,
                            detail=f"Pekerjaan sudah selesai dengan status '{row['status']}'")
    try:
        updated = queue.complete_job(job_id, triage, diagnosis, claim_token=payload.get("claimToken"))
    except AnalysisContractError as exc:
        raise CodedHTTPException(422, "Hasil model belum memenuhi format penilaian; hasil lama tetap disimpan.",
                                 "invalid_model_result") from exc
    if updated is None:
        raise HTTPException(status_code=409, detail="Pekerjaan tidak dapat diselesaikan")
    return db.row_job(updated)


def _haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    radius = 6371000.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = phi2 - phi1
    d_lambda = math.radians(lng2 - lng1)
    a = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(a))


def claim_extras(job_row: dict[str, Any]) -> dict[str, Any]:
    """Farm + recent history for a claimed job, resolved server-side.

    The worker has no session and must not be able to read arbitrary accounts'
    records or farms, so everything its prompt needs is attached to the claim.
    """
    context = db.from_json(job_row.get("context_json"), {})
    lat, lng, farm_id = context.get("lat"), context.get("lng"), context.get("farmId")

    farm_info = None
    if farm_id:
        farm = db.query_one("SELECT * FROM farms WHERE id = ? AND account_id = ?",
                            (farm_id, job_row["account_id"]))
        if farm:
            farm_info = {"id": farm["id"], "name": textsafe.one_line(farm["name"], FARM_NAME_MAX),
                         "crop": textsafe.one_line(farm["crop"], FARM_CROP_MAX),
                         "areaM2": farm["area_m2"]}

    crop_id = context.get("cropId")
    target_id = context.get("reanalysisRecordId") or ""
    rows = db.query(
        "SELECT id, date, crop, condition, severity, observed_severity, source, extra_json FROM records "
        "WHERE account_id=? AND crop_id=? AND id<>? "
        "ORDER BY COALESCE(timestamp_ms,created_ms) DESC LIMIT 2",
        (job_row["account_id"],crop_id,target_id),
    ) if crop_id else []
    history = []
    for row in rows:
        extra = db.from_json(row.get("extra_json"), {})
        observed = extra.get("observedProblems") if isinstance(extra,dict) else None
        condition = row["condition"]
        source = "unconfirmed AI assessment" if row["source"] == "ai" else "farmer observation"
        if isinstance(observed,dict):
            condition = " + ".join(str(observed.get(k) or "") for k in ("disease","pest") if observed.get(k))
            source = "farmer observation, not laboratory confirmation"
        history.append({"date":textsafe.one_line(row["date"],PHOTO_DATE_MAX),
            "crop":textsafe.one_line(row["crop"],RECORD_NAME_MAX),
            "condition":textsafe.one_line(condition,RECORD_NAME_MAX),
            "severity":textsafe.one_line(row.get("observed_severity") or row["severity"],40),"source":source})

    return {"farm": farm_info, "history": history}


@router.get("/queue/next")
def queue_next(worker: str = Query("worker"), lane: str = Query("all"),
               _worker: None = Depends(require_worker)) -> dict[str, Any]:
    worker = textsafe.one_line(worker, DEVICE_ID_MAX) or "worker"
    # lane=fast keeps "Cepat" off the normal FIFO; an unknown lane falls back to "all".
    lane = lane if lane in queue.CLAIM_LANES else "all"
    row, requeued = queue.claim_next(worker, settings_store.as_int("QUEUE_STALE_CLAIM_SEC"), lane)
    if row is None:
        return {"job": None, "requeuedStale": requeued, "farm": None, "history": []}
    return {"job": db.row_job(row, include_image=True), "requeuedStale": requeued,
            **claim_extras(row)}


@router.get("/worker/config")
def worker_config(_worker: None = Depends(require_worker)) -> dict[str, Any]:
    """Everything the worker needs, including the decrypted router key.

    Worker-token protected: the key must never reach a browser.
    """
    key = settings_store.secret_value("NINEROUTER_KEY")
    return {
        "routerUrl": settings_store.as_str("NINEROUTER_URL"),
        "routerKey": key,
        "triageModel": settings_store.as_str("GEMINI_TRIAGE_MODEL"),
        "diagnoseModel": settings_store.as_str("GEMINI_DIAGNOSE_MODEL"),
        "triageModelFast": settings_store.as_str("GEMINI_TRIAGE_MODEL_FAST"),
        "diagnoseModelFast": settings_store.as_str("GEMINI_DIAGNOSE_MODEL_FAST"),
        "pacerSeconds": settings_store.as_int("QUEUE_PACER_SECONDS"),
        "staleClaimSeconds": settings_store.as_int("QUEUE_STALE_CLAIM_SEC"),
        "maxAttempts": settings_store.as_int("QUEUE_MAX_ATTEMPTS"),
        "keyConfigured": bool(key),
    }


@router.post("/worker/status")
def worker_status_report(payload: dict[str, Any] = Body(default={}),
                         _worker: None = Depends(require_worker)) -> dict[str, Any]:
    """Heartbeat from the worker: `{lastError, lastErrorMs, authFailing}`.

    The server stamps `lastSeenMs` itself; the admin overview reads queue.worker_status().
    """
    queue.record_worker_status(payload)
    return {"ok": True}


# ---------------------------------------------------------------------------
@router.post("/diagnose")
async def diagnose() -> None:
    """Removed legacy diagnosis API; callers must submit through the owned job queue."""
    raise HTTPException(status_code=410, detail="Diagnosis tunggal dinonaktifkan; gunakan antrean analisis")


@router.post("/recommendations")
def input_references(payload: dict[str, Any] = Body(...),
                     account: dict[str, Any] = Depends(auth.current_account)) -> dict[str, Any]:
    """Explicit opt-in; source catalog only, no model-generated product or dose."""
    record_id = _clean_id(payload.get("recordId"), "ID catatan")
    row = db.query_one("SELECT * FROM records WHERE id=? AND account_id=?", (record_id, account["id"]))
    if not row:
        raise HTTPException(status_code=404, detail="Catatan tidak ditemukan")
    if payload.get("accepted") is not True or payload.get("disclaimerVersion") != input_catalog.DISCLAIMER_VERSION:
        raise HTTPException(status_code=422, detail="Baca dan setujui batasan referensi produk terlebih dahulu.")
    context = {}
    for key in ("growthStage", "symptomDuration", "affectedExtent", "recentInputs", "location", "harvestWindow", "soilInformation"):
        value = payload.get(key, "")
        if not isinstance(value, str) or len(value) > 240:
            raise HTTPException(status_code=422, detail="Informasi lahan tidak valid atau terlalu panjang.")
        context[key] = textsafe.one_line(value, 240)
    # Targets come exclusively from the owned record. Client hints and differential
    # diagnoses cannot substitute another crop/problem pairing.
    context["fieldConfirmed"] = payload.get("fieldConfirmed") is True
    return input_catalog.options(db.row_record(row), context)
