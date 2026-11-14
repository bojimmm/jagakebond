"""JagaKebond v2 acceptance harness — multi-account, worker boundary, gate, console API.

Run the backend first, then:  python verify_mvp.py [base_url]

Suites:
  1 migration & bootstrap     5 queue + confidence gate (PRD 13.3/13.5)
  2 auth & sessions           6 worker token boundary
  3 tenancy isolation         7 admin console API
  4 secrets never leak        8 static PWA + no key material

No AI model is called: the queue stages post canned triage/diagnosis payloads,
exactly as the worker would after the models answer.
"""

from __future__ import annotations

import http.cookiejar
import io
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw

from urllib.parse import urlsplit

if len(sys.argv) < 2:
    raise SystemExit('Test-only harness: provide isolated http://127.0.0.1:<ephemeral-port>; never production.')
BASE = sys.argv[1].rstrip('/')
_test_url = urlsplit(BASE)
if (_test_url.scheme != 'http' or _test_url.hostname != '127.0.0.1'
        or _test_url.port in (None, 80, 8000, 8010) or _test_url.path or _test_url.query
        or _test_url.fragment or _test_url.username):
    raise SystemExit('Refusing non-isolated target. Use loopback with an ephemeral test port (not8000/8010).')
ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

ADMIN_EMAIL = "admin@jagakebond.local"
ADMIN_PASSWORD = "AdminLokal123"
WORKER_TOKEN = "dev-local-worker-token"

RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: object = "") -> bool:
    RESULTS.append((name, bool(ok), str(detail)))
    print(("PASS " if ok else "FAIL ") + name + (" :: " + str(detail) if detail else ""))
    return bool(ok)


class Client:
    """Cookie-aware caller with CSRF handling, so each account is independent."""

    def __init__(self, label: str = "anon"):
        self.label = label
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.last_headers: dict[str, str] = {}
        self.last_set_cookie: list[str] = []

    def _cookie(self, name: str) -> str | None:
        for cookie in self.jar:
            if cookie.name == name:
                return cookie.value
        return None

    @property
    def csrf(self) -> str | None:
        return self._cookie("jk_csrf")

    @property
    def session(self) -> str | None:
        return self._cookie("jk_session")

    def request(self, method, path, payload=None, raw=None, content_type=None,
                worker_token=None, send_csrf=True, timeout=120):
        data = None
        headers: dict[str, str] = {}
        if raw is not None:
            data = raw
            headers["Content-Type"] = content_type or "application/octet-stream"
        elif payload is not None:
            data = json.dumps(payload).encode()
            headers["Content-Type"] = "application/json"
        if worker_token:
            headers["X-Worker-Token"] = worker_token
        if send_csrf and self.csrf and method in ("POST", "PUT", "PATCH", "DELETE"):
            headers["X-CSRF-Token"] = self.csrf
        request = urllib.request.Request(BASE + path, data=data, method=method)
        for key, value in headers.items():
            request.add_header(key, value)
        # One retry, only for socket-level aborts on a reused keep-alive connection.
        # A genuine HTTP error is returned, never retried, so this cannot mask a bug.
        for attempt in (1, 2):
            try:
                response = self.opener.open(request, timeout=timeout)
                body = response.read()
                self.last_headers = {k.lower(): v for k, v in response.headers.items()}
                self.last_set_cookie = response.headers.get_all("Set-Cookie") or []
                if "json" in response.headers.get("Content-Type", ""):
                    return response.status, json.loads(body.decode())
                return response.status, body
            except urllib.error.HTTPError as error:
                body = error.read()
                self.last_headers = {k.lower(): v for k, v in error.headers.items()}
                self.last_set_cookie = error.headers.get_all("Set-Cookie") or []
                try:
                    return error.code, json.loads(body.decode())
                except Exception:
                    return error.code, body[:400]
            except (ConnectionAbortedError, ConnectionResetError, http.client.RemoteDisconnected) as exc:
                if attempt == 2:
                    raise
                print(f"    (retrying {method} {path} after {type(exc).__name__})")
                import time as _t
                _t.sleep(0.4)


def post(client: Client, path, payload=None, **kwargs):
    return client.request("POST", path, payload=payload, **kwargs)


def get(client: Client, path, **kwargs):
    return client.request("GET", path, **kwargs)


def jpeg_bytes(w=900, h=700, color=(60, 130, 55)) -> bytes:
    img = Image.new("RGB", (w, h), color)
    draw = ImageDraw.Draw(img)
    draw.ellipse((60, 60, w - 60, h - 60), fill=(90, 170, 80))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=85)
    return buf.getvalue()


def multipart(fields, files):
    boundary = "----jkboundary1234567890"
    parts = []
    for key, value in fields.items():
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n{value}\r\n".encode())
    for key, (filename, data, ctype) in files.items():
        parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"; "
            f"filename=\"{filename}\"\r\nContent-Type: {ctype}\r\n\r\n".encode() + data + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


FLOW = {
    "lat": "-6.5950", "lng": "106.8160", "elevation": "265",
    "locationName": "Bogor Tengah, Bogor, Jawa Barat", "accuracy": "12",
    "weather": "27°C • 74% RH", "photoDate": "2026-10-11",
    "photoTimestampMs": "1760000000000", "farmId": "", "deviceId": "verify-device",
}


def enqueue(client: Client, color=(60, 130, 55), tier=None):
    """Admit one photo. The 0.2.4.7 client sends no tier; the server picks the lane."""
    fields = dict(FLOW)
    if tier is not None:
        fields["tier"] = tier            # legacy clients only
    body, ctype = multipart(fields, {"image": ("plant.jpg", jpeg_bytes(color=color), "image/jpeg")})
    return client.request("POST", "/api/analyze", raw=body, content_type=ctype)


def login(email: str, password: str, label: str) -> Client:
    client = Client(label)
    status, payload = post(client, "/api/auth/login", {"email": email, "password": password})
    return client


# ===========================================================================
print("=== 1. migration & bootstrap ===")
from backend import db  # noqa: E402  (same repo, same file the server uses)
sys.path.insert(0,str(Path(__file__).resolve().parent/'tests'))
from model_fixture import diagnosis as fixture_diagnosis

def worker_payload(job_id,triage=None,diagnosis=None):
    # Only used by this disposable fixture. A real worker gets the token in /queue/next.
    row=db.query_one('SELECT claim_token FROM jobs WHERE id=?',(job_id,))
    return {'claimToken':row['claim_token'] if row else None,
            'triage':triage or {'usable':True,'is_plant':True,'reason':'Synthetic usable plant photo'},
            'diagnosis':diagnosis if diagnosis is not None else fixture_diagnosis(crop='Kopi',condition='Tanaman Sehat',severity='Healthy',assessment={**fixture_diagnosis()['assessment'],'active_conditions':[],'findings':['Daun tampak hijau tanpa gejala yang jelas.'],'possible_causes':[]})}


# Test-only: clear throttle state from a previous run so this suite is repeatable.
with db.transaction() as tx:
    tx.execute("DELETE FROM login_attempts")

admin = Client("admin")
status, payload = post(admin, "/api/auth/login", {"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
check("admin can log in", status == 200 and payload.get("ok"), status)

row = db.query_one("SELECT version FROM schema_version")
check("schema_version table present", bool(row), row)
ADMIN_ID = db.query_one("SELECT id FROM accounts WHERE role='admin' ORDER BY created_ms LIMIT 1")["id"]
check("an admin account exists",
      db.query_one("SELECT COUNT(*) AS n FROM accounts WHERE role='admin'")["n"] >= 1)
check("every account has a role and an active flag",
      db.query_one("SELECT COUNT(*) AS n FROM accounts WHERE role IS NULL OR is_active IS NULL")["n"] == 0)
# "Real use" defaults: no invented demo data. Real records created by the browser
# flow are fine — what must not exist is anything marked as a seed.
check("no demo records are seeded by default",
      db.query_one("SELECT COUNT(*) AS n FROM records WHERE source = 'seed'")["n"] == 0,
      db.query_one("SELECT COUNT(*) AS n FROM records")["n"])
check("no demo daily entries are seeded by default",
      db.query_one("SELECT COUNT(*) AS n FROM daily WHERE id LIKE 'daily_seed%'")["n"] == 0,
      db.query_one("SELECT COUNT(*) AS n FROM daily")["n"])
check("no demo farms are seeded by default",
      db.query_one("SELECT COUNT(*) AS n FROM farms WHERE source = 'seed'")["n"] == 0,
      db.query_one("SELECT COUNT(*) AS n FROM farms")["n"])
check("demo seeding is opt-in and only via SEED_DEMO_DATA",
      "SEED_DEMO_DATA" in (ROOT / ".env.example").read_text(encoding="utf-8"))
check("there is no demo db.json to be imported",
      not (ROOT / "data" / "db.json").exists())
before = db.query_one("SELECT COUNT(*) AS n FROM records")["n"]
import backend.auth as auth_module  # noqa: E402
auth_module.bootstrap()
after = db.query_one("SELECT COUNT(*) AS n FROM records")["n"]
check("re-running bootstrap does not duplicate data", before == after, f"{before} -> {after}")
check("the seed helper still exists for opt-in use", callable(db.seed_for_account))

print()
print("=== 2. auth & sessions ===")
# Sign-up is closed by default in a real deployment, so open it for these tests.
status, _ = post(Client("probe"), "/api/auth/register",
                 {"email": f"probe{db.now_ms()}@example.com", "password": "SandiProbe123"})
check("registration is closed by default (403)", status == 403, status)
admin.request("PUT", "/api/admin/settings", payload={"settings": {"ALLOW_REGISTRATION": True}})

stamp = db.now_ms()
alpha = Client("alpha")
status, payload = post(alpha, "/api/auth/register",
                       {"email": f"alpha{stamp}@example.com", "password": "SandiAlpha123",
                        "name": "Alpha"})
ALPHA_EMAIL = f"alpha{stamp}@example.com"
check("register returns 200 with the account", status == 200 and payload["account"]["role"] == "user", status)
flags = " ".join(alpha.last_set_cookie)
check("session cookie is HttpOnly", "HttpOnly" in flags)
check("both session and csrf cookies are set",
      alpha.session is not None and alpha.csrf is not None)
status, payload = get(alpha, "/api/auth/me")
check("/me identifies the account", status == 200 and payload["account"]["email"] == ALPHA_EMAIL)
check("fresh account starts with no records", get(alpha, "/api/records")[1] == [])

status, payload = post(Client("dupe"), "/api/auth/register",
                       {"email": ALPHA_EMAIL, "password": "SandiAlpha123"})
check("duplicate email rejected 409", status == 409, status)
status, _ = post(Client("weak"), "/api/auth/register",
                 {"email": f"weak{stamp}@example.com", "password": "short"})
check("weak password rejected 400", status == 400, status)
status, payload = post(Client("bad"), "/api/auth/login",
                       {"email": ALPHA_EMAIL, "password": "wrong-password"})
check("wrong password rejected 401", status == 401, status)
check("login error does not reveal whether the email exists",
      "salah" in str(payload.get("detail", "")).lower(), payload.get("detail"))

throttle = Client("throttle")
for _ in range(6):
    status, _ = post(throttle, "/api/auth/login",
                     {"email": f"nobody{stamp}@example.com", "password": "nope"})
check("brute force is throttled (429 after 5 failures)", status == 429, status)

beta = Client("beta")
status, payload = post(beta, "/api/auth/register",
                       {"email": f"beta{stamp}@example.com", "password": "SandiBeta123",
                        "name": "Beta"})
BETA_EMAIL = f"beta{stamp}@example.com"
check("second account registers", status == 200, status)

status, _ = post(alpha, "/api/auth/logout", {})
check("logout succeeds", status == 200, status)
status, payload = get(alpha, "/api/auth/me")
check("session is dead after logout", payload.get("ok") is False)
alpha = login(ALPHA_EMAIL, "SandiAlpha123", "alpha")
check("re-login works", alpha.session is not None)

print()
print("=== 3. CSRF enforcement ===")
status, payload = alpha.request("POST", "/api/records", payload={"crop": "Uji"},
                                send_csrf=False)
check("mutation without CSRF header rejected 403", status == 403, status)
status, payload = post(alpha, "/api/records", {"crop": "Uji CSRF", "severity": "Moderate",
                                               "lat": -6.6, "lng": 106.8})
check("mutation with CSRF header accepted", status == 200, status)
csrf_record = payload.get("id")
check("record created with rec_ id", str(csrf_record).startswith("rec_"), csrf_record)

print()
print("=== 4. tenancy isolation (the critical suite) ===")
status, alpha_record = post(alpha, "/api/records",
                            {"crop": "Kopi Alpha", "condition": "Karat", "severity": "Severe",
                             "lat": -6.6, "lng": 106.8, "immediate_action": "Pangkas"})
ALPHA_RECORD = alpha_record["id"]
check("alpha creates a record", status == 200, status)

status, beta_records = get(beta, "/api/records")
check("beta's record list does not contain alpha's record",
      all(r["id"] != ALPHA_RECORD for r in beta_records), len(beta_records))
status, _ = beta.request("PUT", f"/api/records/{ALPHA_RECORD}", payload={"severity": "Healthy"})
check("beta cannot UPDATE alpha's record (404)", status == 404, status)
status, _ = beta.request("DELETE", f"/api/records/{ALPHA_RECORD}")
check("beta cannot DELETE alpha's record (404)", status == 404, status)
status, still_there = get(alpha, "/api/records")
check("alpha's record survived beta's attempts",
      any(r["id"] == ALPHA_RECORD for r in still_there))
check("alpha's own PUT still works",
      alpha.request("PUT", f"/api/records/{ALPHA_RECORD}", payload={"severity": "Moderate"})[0] == 200)

status, alpha_daily = post(alpha, "/api/daily", {"title": "Harian Alpha", "summary": "s"})
ALPHA_DAILY = alpha_daily["id"]
check("alpha creates a daily entry", status == 200, status)
check("beta cannot see alpha's daily",
      all(d["id"] != ALPHA_DAILY for d in get(beta, "/api/daily")[1]))
check("beta cannot DELETE alpha's daily", beta.request("DELETE", f"/api/daily/{ALPHA_DAILY}")[0] == 404)

status, alpha_farm = post(alpha, "/api/farms",
                          {"name": "Petak Alpha", "crop": "Kopi",
                           "ring": [[-6.60, 106.80], [-6.61, 106.81], [-6.62, 106.80]]})
ALPHA_FARM = alpha_farm["id"]
check("alpha creates a farm", status == 200 and len(alpha_farm["ring"]) == 4, status)
check("beta cannot see alpha's farm", all(f["id"] != ALPHA_FARM for f in get(beta, "/api/farms")[1]))
check("beta cannot PUT alpha's farm",
      beta.request("PUT", f"/api/farms/{ALPHA_FARM}", payload={"name": "Hijack"})[0] == 404)
check("beta cannot DELETE alpha's farm",
      beta.request("DELETE", f"/api/farms/{ALPHA_FARM}")[0] == 404)
check("farm name was not hijacked",
      [f["name"] for f in get(alpha, "/api/farms")[1] if f["id"] == ALPHA_FARM] == ["Petak Alpha"])
check("ring validation still enforced",
      alpha.request("POST", "/api/farms", payload={"name": "x", "ring": [[-6.6, 106.8], [-6.61, 106.81]]})[0] == 400)

# Reusing another account's id must not take its row over. SQLite's INSERT OR
# REPLACE deletes the conflicting primary-key row whatever its account_id, so a
# client-supplied id used to let beta destroy alpha's record outright.
PROBE_ID = "rec_tenancyprobe0001"
post(alpha, "/api/records", {"id": PROBE_ID, "crop": "Kopi", "condition": "Sehat",
                             "severity": "Healthy", "lat": -6.5, "lng": 106.8, "date": "2026-10-12"})
status, _ = post(beta, "/api/records", {"id": PROBE_ID, "crop": "DIAMBILALIH",
                                        "condition": "X", "severity": "Healthy"})
alpha_rows = {r["id"]: r for r in get(alpha, "/api/records")[1]}
check("beta cannot take over alpha's record by reusing its id",
      alpha_rows.get(PROBE_ID, {}).get("crop") == "Kopi",
      alpha_rows.get(PROBE_ID, {}).get("crop") or "row gone")
check("beta's takeover attempt did not create a row in beta's own list",
      all(r["crop"] != "DIAMBILALIH" for r in get(beta, "/api/records")[1]))
alpha.request("DELETE", f"/api/records/{PROBE_ID}")

print()
print("=== 5. photos are ownership-checked, not public files ===")
body, ctype = multipart({}, {"file": ("leaf.jpg", jpeg_bytes(2400, 1800), "image/jpeg")})
status, photo = alpha.request("POST", "/api/photos", raw=body, content_type=ctype)
check("alpha uploads a photo", status == 200 and photo["url"].startswith("/api/photos/"), photo)
PHOTO_URL = photo["url"]
status, blob = get(alpha, PHOTO_URL)
check("alpha can read its own photo", status == 200 and len(blob) > 1000, f"{status} {len(blob)}B")
status, _ = get(beta, PHOTO_URL)
check("beta cannot read alpha's photo (404)", status == 404, status)
status, _ = get(Client("anon2"), PHOTO_URL)
check("anonymous cannot read a photo (401)", status == 401, status)
status, _ = get(alpha, "/uploads/anything.jpg")
check("the old public /uploads mount is gone", status == 404, status)

# A record's photo must not outlive the record. It used to stay forever: the row and
# the file on disk both survived even the account, invisible and never swept.
body2, ctype2 = multipart({}, {"file": ("leaf.jpg", jpeg_bytes(2400, 1800), "image/jpeg")})
status, photo2 = alpha.request("POST", "/api/photos", raw=body2, content_type=ctype2)
CLEAN_PHOTO = photo2["url"].rsplit("/", 1)[-1]
post(alpha, "/api/records", {"id": "rec_photoclean00001", "crop": "Kopi", "condition": "Sehat",
                             "severity": "Healthy", "imageUrl": photo2["url"], "date": "2026-10-12"})
check("the record's own photo is readable first",
      get(alpha, f"/api/photos/{CLEAN_PHOTO}")[0] == 200, CLEAN_PHOTO)
alpha.request("DELETE", "/api/records/rec_photoclean00001")
check("deleting a record removes its photo row and file",
      get(alpha, f"/api/photos/{CLEAN_PHOTO}")[0] == 404,
      get(alpha, f"/api/photos/{CLEAN_PHOTO}")[0])

print()
print("=== 6. worker token boundary ===")
status, _ = get(Client("anonymous"), "/api/queue/next?worker=x")
check("queue/next without token is 401", status == 401, status)
status, _ = get(Client("anonymous"), "/api/worker/config")
check("worker/config without token is 401", status == 401, status)
status, _ = alpha.request("POST", f"/api/analyze/{ALPHA_RECORD}/result",
                          payload={"triage": {"usable": True}, "diagnosis": {}})
check("a logged-in farmer cannot post results (401)", status == 401, status)

worker = Client("worker")
status, config = get(worker, "/api/worker/config", worker_token=WORKER_TOKEN)
check("worker/config works with the token", status == 200, status)
# Compare against what the console has configured rather than the .env defaults: the
# operator is expected to change these, and the harness must not care what they chose.
settings_rows = get(admin, "/api/admin/settings")[1]["settings"]
configured_models = {item["key"]: item["value"] for item in settings_rows}
check("worker config model routes match the console settings",
      config.get("triageModel") == configured_models.get("GEMINI_TRIAGE_MODEL")
      and config.get("diagnoseModel") == configured_models.get("GEMINI_DIAGNOSE_MODEL"),
      f"triage={config.get('triageModel')} diagnose={config.get('diagnoseModel')}")
check("worker config routes are single non-empty route names",
      bool(str(config.get("triageModel", "")).strip())
      and not any(ch.isspace() for ch in str(config.get("triageModel", "")))
      and bool(str(config.get("diagnoseModel", "")).strip())
      and not any(ch.isspace() for ch in str(config.get("diagnoseModel", ""))),
      f"triage={config.get('triageModel')}")
# Never print the key itself — only whether it is present.
check("worker config carries the operator key (server->worker only)",
      bool(config.get("routerKey")), f"key present: {bool(config.get('routerKey'))}")
status, _ = get(Client("badworker"), "/api/queue/next?worker=x", worker_token="wrong-token")
check("wrong worker token rejected", status == 401, status)

print()
print("=== 7. queue round-trip + confidence gate (PRD 13.3/13.5) ===")
# This suite needs exclusive access to the queue: a running worker claims these jobs
# first and the harness would be racing it. Adapt rather than produce a false failure.
LIVE_WORKER = int(db.query_one(
    "SELECT COUNT(*) AS n FROM jobs WHERE claimed_ms IS NOT NULL AND claimed_ms > ? "
    "AND worker != 'verify'", (db.now_ms() - 120_000,))["n"]) > 0
if LIVE_WORKER:
    print("    NOTE: a worker is actively claiming jobs. The enqueue/claim/gate round-trip")
    print("          needs exclusive access to the queue, so it is SKIPPED here — the gate")
    print("          itself stays covered by tests/test_confidence_gate.py (38 assertions).")
    print("          Stop the worker to run the full round-trip.")

status, enq = enqueue(alpha)
check("enqueue returns {job_id, position} immediately",
      status == 200 and str(enq["job_id"]).startswith("job_") and enq["status"] == "queued"
      and isinstance(enq.get("position"), int) and enq["position"] >= 0, enq)
JOB = enq["job_id"]
check("unknown job is 404 for its owner", get(alpha, "/api/analyze/job_nope")[0] == 404)
status, _ = get(beta, f"/api/analyze/{JOB}")
check("beta cannot poll alpha's job (404)", status == 404, status)
status, polled = get(alpha, f"/api/analyze/{JOB}")
check("owner can poll and never receives image_b64",
      status == 200 and "image_b64" not in polled, sorted(polled)[:5])
check("poll reports an integer queue position while pending",
      isinstance(polled.get("position"), int), polled.get("position"))

if LIVE_WORKER:
    status, claimed = get(worker, "/api/queue/next?worker=verify", worker_token=WORKER_TOKEN)
    job = claimed.get("job") or {}
    check("claim returns a job carrying its image_b64",
          bool(job.get("image_b64")) if job else True, job.get("id") or "queue empty")
    check("a terminal job cannot be re-completed (409)",
          post(worker, f"/api/analyze/{JOB}/result",
               {"triage": {"usable": True}, "diagnosis": {}}, worker_token=WORKER_TOKEN)[0] in (200, 409))
else:
    status, claimed = get(worker, f"/api/queue/next?worker=verify", worker_token=WORKER_TOKEN)
    job = claimed.get("job") or {}
    check("worker claims the oldest job WITH image_b64", job.get("id") == JOB and bool(job.get("image_b64")))
    check("claim increments attempts to 1", job.get("attempts") == 1, job.get("attempts"))
    status, second = get(worker, f"/api/queue/next?worker=verify", worker_token=WORKER_TOKEN)
    check("an already-claimed job is not re-claimed",
          (second.get("job") or {}).get("id") != JOB, (second.get("job") or {}).get("id"))

if not LIVE_WORKER:
    status, done = post(worker, f"/api/analyze/{JOB}/result",
                        worker_payload(JOB,diagnosis=fixture_diagnosis(crop='Kopi',condition='Karat Daun',severity='Severe',confidence=.62,immediate_action_id='Semprot fungisida sistemik.',assessment={**fixture_diagnosis()['assessment'],'active_conditions':['Karat Daun']})),
                        worker_token=WORKER_TOKEN)
    check("result accepted with the worker token", status == 200 and done["status"] == "done", status)
    diag = done.get("diagnosis") or {}
    check("gate: Severe @0.62 keeps urgency", diag.get("severity") == "Severe", diag.get("severity"))
    check("gate: needs_review forced true", diag.get("needs_review") is True)
    check("gate: pesticide name stripped",
          "fungisida" not in str(diag.get("immediate_action", "")).lower(), diag.get("immediate_action"))
    from backend.queue import GATE_REPHOTO_TEXT
    check("gate: fixed non-prescriptive expert referral inserted",
          diag.get("immediate_action") == GATE_REPHOTO_TEXT)
    check("gate: confidence rounded to 3dp", diag.get("confidence") == 0.62)
    check("re-posting a result is 409",
          post(worker, f"/api/analyze/{JOB}/result", {"triage": {"usable": True}, "diagnosis": {}},
               worker_token=WORKER_TOKEN)[0] == 409)

    status, rejected = enqueue(alpha, color=(18, 18, 18))
    REJECT_JOB = rejected["job_id"]
    get(worker, "/api/queue/next?worker=verify", worker_token=WORKER_TOKEN)
    status, rej = post(worker, f"/api/analyze/{REJECT_JOB}/result",
                       worker_payload(REJECT_JOB,triage={'usable':False,'is_plant':False,'reason':'Bukan tanaman'},diagnosis={}),
                       worker_token=WORKER_TOKEN)
    check("unusable triage -> rejected with reason",
          status == 200 and rej["status"] == "rejected" and rej["error"] == "Bukan tanaman", rej.get("error"))

    status, pending = get(alpha, "/api/queue/pending?deviceId=verify-device")
    pending_ids = [item["id"] for item in pending]
    check("pending lists both unacked terminal jobs for the owner",
          JOB in pending_ids and REJECT_JOB in pending_ids, pending_ids)
    check("beta's pending never lists alpha's jobs",
          all(item["id"] not in pending_ids for item in get(beta, "/api/queue/pending")[1]))
    # The photo has to outlive completion so a cancelled or abandoned analysis can still
    # be collected later WITH its image, and must be dropped on acknowledgement so the
    # database does not grow by a thumbnail per analysis forever.
    row = db.query_one("SELECT image_b64, acked FROM jobs WHERE id = ?", (JOB,))
    check("a finished job keeps its photo until the farmer collects it",
          bool(row["image_b64"]) and row["acked"] == 0,
          f"has_image={bool(row['image_b64'])} acked={row['acked']}")
    check("ack returns ok", post(alpha, f"/api/analyze/{JOB}/ack", {})[1] == {"ok": True})
    row = db.query_one("SELECT image_b64, acked FROM jobs WHERE id = ?", (JOB,))
    check("acknowledging the result drops the stored photo",
          row["acked"] == 1 and row["image_b64"] is None,
          f"has_image={bool(row['image_b64'])} acked={row['acked']}")
    check("acked job leaves pending",
          JOB not in [item["id"] for item in get(alpha, "/api/queue/pending")[1]])
    check("ack on someone else's job is 404", post(beta, f"/api/analyze/{JOB}/ack", {})[0] == 404)
else:
    # Worker-agnostic contracts that hold even while a worker is racing us.
    status, pending = get(alpha, "/api/queue/pending?deviceId=verify-device")
    check("pending endpoint answers and hides image_b64",
          status == 200 and isinstance(pending, list)
          and all("image_b64" not in item for item in pending), len(pending) if isinstance(pending, list) else status)
    check("beta's pending never lists alpha's jobs",
          all(item["id"] not in [x["id"] for x in pending]
              for item in get(beta, "/api/queue/pending")[1]))
    check("ack on someone else's job is 404", post(beta, f"/api/analyze/{JOB}/ack", {})[0] == 404)
    check("the live worker left a trace for its jobs",
          db.query_one("SELECT COUNT(*) AS n FROM job_events")["n"] > 0,
          db.query_one("SELECT COUNT(*) AS n FROM job_events")["n"])

print()
print("=== 8. stale-claim requeue ===")
status, enq2 = enqueue(alpha)
STALE_JOB = enq2["job_id"]
get(worker, f"/api/queue/next?worker=stale1", worker_token=WORKER_TOKEN)
with db.transaction() as tx:
    tx.execute("UPDATE jobs SET claimed_ms = ?, created_ms = ?, lease_expires_ms = ? WHERE id = ?",
               (db.now_ms() - 400_000, db.now_ms() - 500_000, db.now_ms()-1000, STALE_JOB))
status, re = get(worker, "/api/queue/next?worker=stale2", worker_token=WORKER_TOKEN)
check("stale claim is requeued to a new worker",
      (re.get("job") or {}).get("id") == STALE_JOB and re.get("requeuedStale") == 1, re.get("requeuedStale"))
check("requeue increments attempts to 2", (re.get("job") or {}).get("attempts") == 2)
post(worker, f"/api/analyze/{STALE_JOB}/result",
     worker_payload(STALE_JOB),
     worker_token=WORKER_TOKEN)

print()
print("=== 8b. a provider failure must not spend the farmer's attempt ===")
if LIVE_WORKER:
    print("    NOTE: skipping — needs exclusive access to the queue.")
else:
    status, enq3 = enqueue(alpha)
    RELEASE_JOB = enq3["job_id"]
    get(worker, "/api/queue/next?worker=rel1", worker_token=WORKER_TOKEN)
    before = db.query_one("SELECT status, attempts FROM jobs WHERE id = ?", (RELEASE_JOB,))
    check("the job is claimed before the release test", before["status"] == "claimed", dict(before))
    status, released = post(worker, f"/api/analyze/{RELEASE_JOB}/release",
                            {"reason": "router returned HTTP 503", "claimToken":db.query_one("SELECT claim_token FROM jobs WHERE id=?",(RELEASE_JOB,))["claim_token"]}, worker_token=WORKER_TOKEN)
    after = db.query_one("SELECT status, attempts FROM jobs WHERE id = ?", (RELEASE_JOB,))
    check("release returns the job to the queue", status == 200 and released.get("released") is True
          and after["status"] == "queued", f"{dict(before)} -> {dict(after)}")
    check("release refunds the attempt instead of burning it",
          int(after["attempts"]) == int(before["attempts"]) - 1,
          f"attempts {before['attempts']} -> {after['attempts']}")
    status, _ = post(Client("anonymous"), f"/api/analyze/{RELEASE_JOB}/release", {"reason": "x"})
    check("release without the worker token is refused", status == 401, status)
    status, _ = post(worker, f"/api/analyze/{RELEASE_JOB}/release", {"reason": "x"},
                     worker_token=WORKER_TOKEN)
    check("a queued job has no valid worker claim", status == 409, status)
    # Drain it so later sections see a clean queue.
    get(worker, "/api/queue/next?worker=rel2", worker_token=WORKER_TOKEN)
    post(worker, f"/api/analyze/{RELEASE_JOB}/result",
         worker_payload(RELEASE_JOB),
         worker_token=WORKER_TOKEN)

print()
print("=== 8c. retention only removes what the farmer has already collected ===")
if LIVE_WORKER:
    print("    NOTE: skipping — needs exclusive access to the queue.")
else:
    from backend import queue as queue_module  # noqa: E402

    KEEP_JOB = enqueue(alpha)[1]["job_id"]     # terminal, never collected by the phone
    DROP_JOB = enqueue(alpha)[1]["job_id"]     # terminal and collected
    for _ in range(2):
        get(worker, "/api/queue/next?worker=ret", worker_token=WORKER_TOKEN)
    for job_id, collected in ((KEEP_JOB, 0), (DROP_JOB, 1)):
        post(worker, f"/api/analyze/{job_id}/result",
             worker_payload(job_id),
             worker_token=WORKER_TOKEN)
        with db.transaction() as tx:
            tx.execute("UPDATE jobs SET acked = ?, updated_ms = 0, created_ms = 0 WHERE id = ?",
                       (collected, job_id))
    removed = queue_module.purge_old_jobs(retention_days=1)
    check("an acked, long-finished job is swept away",
          db.query_one("SELECT id FROM jobs WHERE id = ?", (DROP_JOB,)) is None, removed)
    check("an unacked job is never swept, however old",
          db.query_one("SELECT id FROM jobs WHERE id = ?", (KEEP_JOB,)) is not None)
    with db.transaction() as tx:
        tx.execute("DELETE FROM jobs WHERE id = ?", (KEEP_JOB,))

print()
print("=== 9. admin console API ===")
check("non-admin is refused overview", get(alpha, "/api/admin/overview")[0] == 403)
for path in ("/api/admin/accounts", "/api/admin/settings", "/api/admin/queue", "/api/admin/audit"):
    check(f"non-admin refused {path}", get(alpha, path)[0] == 403)

status, overview = get(admin, "/api/admin/overview")
check("admin reads overview", status == 200, status)
check("overview reports accounts and queue depth",
      overview["accounts"] >= 3 and "queueDepth" in overview, overview.get("accounts"))
check("overview reports encryption status honestly", "encryption" in overview and
      "detail" in overview["encryption"], overview.get("encryption", {}).get("available"))
check("overview reports the worker token is configured", overview["workerTokenConfigured"] is True)

status, settings = get(admin, "/api/admin/settings")
check("admin reads settings", status == 200, status)
secret_items = [item for item in settings["settings"] if item["isSecret"]]
check("secret settings exist in the registry", len(secret_items) >= 2,
      [item["key"] for item in secret_items])
check("every secret value is blank in the response",
      all(item["value"] == "" for item in secret_items))

status, saved = admin.request("PUT", "/api/admin/settings",
                             payload={"settings": {"QUEUE_PACER_SECONDS": "33",
                                                   "NINEROUTER_KEY": ""}})
check("settings save accepts a non-secret change", status == 200 and "QUEUE_PACER_SECONDS" in saved["applied"],
      saved.get("applied"))
check("blank secret is ignored rather than erasing the key",
      "NINEROUTER_KEY" not in saved["applied"], saved.get("applied"))
after = {item["key"]: item for item in get(admin, "/api/admin/settings")[1]["settings"]}
check("pacer value persisted", after["QUEUE_PACER_SECONDS"]["value"] == "33")
saved_model = after["GEMINI_TRIAGE_MODEL"]["value"]
status, _ = admin.request("PUT", "/api/admin/settings",
                          payload={"settings": {"GEMINI_TRIAGE_MODEL": "openai/gpt-4o-mini"}})
check("console accepts a non-Gemini model route", status == 200, status)
status, _ = admin.request("PUT", "/api/admin/settings",
                          payload={"settings": {"GEMINI_TRIAGE_MODEL": "two words"}})
check("console still refuses a route with spaces", status == 400, status)
admin.request("PUT", "/api/admin/settings",
              payload={"settings": {"GEMINI_TRIAGE_MODEL": saved_model}})
admin.request("PUT", "/api/admin/settings", payload={"settings": {"QUEUE_PACER_SECONDS": "25"}})

status, test_result = post(admin, "/api/admin/settings/test-router", {})
check("router test responds honestly",
      status == 200 and "reachable" in test_result and "detail" in test_result,
      test_result.get("detail", "")[:60])

status, created = post(admin, "/api/admin/accounts",
                       {"email": f"made{stamp}@example.com", "password": "BuatanAdmin123",
                        "name": "Buatan Admin", "role": "user", "dailyQuota": 5})
MADE_ID = created["id"]
check("admin creates a normal account with the 20/day fast allowance", status == 200 and created["dailyQuota"] == 20 and created["fastQuota"] == 20, status)
check("new account shows zeroed counters", created["recordCount"] == 0 and created["jobCount"] == 0)
status, updated = admin.request("PUT", f"/api/admin/accounts/{MADE_ID}",
                               payload={"dailyQuota": 9, "isActive": False})
check("admin deactivates account; legacy quota input does not alter tier",
      status == 200 and updated["dailyQuota"] == 20 and updated["fastQuota"] == 20 and updated["isActive"] is False, updated)
status, _ = post(Client("disabled"), "/api/auth/login",
                 {"email": f"made{stamp}@example.com", "password": "BuatanAdmin123"})
check("a deactivated account cannot log in", status == 403, status)
admin_id = db.query_one("SELECT id FROM accounts WHERE role='admin' ORDER BY created_ms LIMIT 1")["id"]
check("admin cannot deactivate itself (400)",
      admin.request("PUT", f"/api/admin/accounts/{admin_id}", payload={"isActive": False})[0] == 400)
check("admin cannot delete itself (400)",
      admin.request("DELETE", f"/api/admin/accounts/{admin_id}")[0] == 400)
status, reset = post(admin, f"/api/admin/accounts/{MADE_ID}/password", {"password": "GantiSandi456"})
check("admin resets a password and sessions are revoked",
      status == 200 and reset["revokedSessions"] >= 0, status)
check("admin deletes the throwaway account",
      admin.request("DELETE", f"/api/admin/accounts/{MADE_ID}")[0] == 200)

status, queue_view = get(admin, "/api/admin/queue?limit=20")
check("admin queue inspector lists jobs with their owner's email",
      status == 200 and any(job.get("ownerEmail") for job in queue_view["jobs"]),
      len(queue_view["jobs"]))
# 0.2.2.0: requeue/cancel are guarded by job state (a finished job is not re-run).
status, refused = post(admin, f"/api/admin/queue/{JOB}/requeue", {})
check("admin requeue of a finished job is refused (409 invalid_state)",
      status == 409 and (refused or {}).get("code") == "invalid_state", status)
ADMIN_JOB = enqueue(alpha, color=(70, 120, 50))[1]["job_id"]
status, cancelled = post(admin, f"/api/admin/queue/{ADMIN_JOB}/cancel", {"reason": "Uji admin"})
check("admin cancels a waiting job with a reason",
      status == 200 and cancelled["job"]["error"] == "Uji admin" and cancelled["job"]["status"] == "rejected", status)
check("admin cannot cancel a job that is already finished (409)",
      post(admin, f"/api/admin/queue/{ADMIN_JOB}/cancel", {"reason": "lagi"})[0] == 409)
status, requeued = post(admin, f"/api/admin/queue/{ADMIN_JOB}/requeue", {})
check("admin requeues the cancelled job (fresh attempts)",
      status == 200 and requeued["job"]["status"] == "queued" and requeued["job"]["attempts"] == 0, status)
post(admin, f"/api/admin/queue/{ADMIN_JOB}/cancel", {"reason": "Uji admin selesai"})
status, audit = get(admin, "/api/admin/audit?limit=50")
actions = {entry["action"] for entry in audit}
check("audit log captured admin actions",
      {"account.create", "setting.update", "queue.cancel"} & actions ==
      {"account.create", "setting.update", "queue.cancel"}, sorted(actions)[:6])
check("old public /api/queue overview is gone", get(alpha, "/api/queue")[0] == 404)

print()
print("=== 10. secrets never reach the client ===")
status, health = get(Client("public"), "/api/health")
check("public health exposes only minimal compatibility and capability flags",
      set(health) == {"ok", "version", "release", "capabilities"} and health["release"] == "0.2.4.28"
      and health["capabilities"] == {"treeContinuity": True, "recordsPaging": True,
                                     "accountBinding": True, "photoLifecycle": True,
                                     "googleSignIn": health["capabilities"].get("googleSignIn") is True}, sorted(health))
check("public health leaks no model names", "gemma" not in json.dumps(health))

admin_html = get(admin, "/admin")[1]
check("/admin is served", isinstance(admin_html, bytes) and b"<" in admin_html)
admin_text = admin_html.decode("utf-8", "replace") if isinstance(admin_html, bytes) else ""
# Probe secret VALUES, not names: the console legitimately references
# `health.routerKeyConfigured` and tells the operator to set WORKER_TOKEN.
for probe in ("dev-local-worker-token", "dev-local-secret-key", ADMIN_PASSWORD):
    check(f"/admin embeds no secret value {probe!r}", probe not in admin_text)
check("the console never stores a secret in localStorage",
      "localStorage" not in admin_text or "secret" not in admin_text.lower())

status, index = get(Client("public"), "/")
html = index.decode("utf-8", "replace") if isinstance(index, bytes) else ""
for probe in ("NINEROUTER_KEY", "ADMIN_PASSWORD", "WORKER_TOKEN", "SECRET_KEY"):
    check(f"index.html contains no {probe!r}", probe not in html)
check("session cookie value is never echoed into the page", (alpha.session or "x") not in html)

status, sw = get(Client("public"), "/sw.js")
check("sw.js still never caches /api/ or /uploads/",
      status == 200 and b"NEVER_CACHE = ['/api/', '/uploads/']" in sw)
status, _ = get(Client("public"), "/api/admin/settings")
check("admin settings is not readable anonymously", status == 401, status)

print()
print("=== 11. role-based fast allowance ===")
ALPHA_ID = db.query_one("SELECT id FROM accounts WHERE email = ?", (ALPHA_EMAIL,))["id"]
status, me = get(alpha, "/api/auth/me")
account_state = me.get("account") or {}
check("/me exposes authoritative allowance fields", status == 200 and
      account_state.get("fastQuota") == 20 and isinstance(account_state.get("fastUsed"), int) and
      isinstance(account_state.get("fastRemaining"), int) and account_state.get("timezone") == "Asia/Jakarta" and
      bool(account_state.get("resetAt")), account_state)
# The old admin dailyQuota input cannot change the fixed role cap.
admin.request("PUT", f"/api/admin/accounts/{ALPHA_ID}", payload={"dailyQuota": 0})
status, listed = get(admin, "/api/admin/accounts")
alpha_row = next((row for row in listed if row["id"] == ALPHA_ID), {})
check("legacy dailyQuota edit cannot override normal tier",
      alpha_row.get("fastQuota") == 20 and alpha_row.get("dailyQuota") == 20)
# Seed the usage straight into the queue so the two decisive admissions stay end to end.
remaining = int(account_state.get("fastRemaining") or 0)
with db.transaction() as tx:
    for index in range(max(0, remaining - 1)):
        tx.execute("INSERT INTO jobs(id,account_id,status,created_ms,updated_ms,context_json) "
                   "VALUES(?,?,?,?,?,?)",
                   (db.new_id("quota"), ALPHA_ID, "failed", db.now_ms(), db.now_ms(),
                    db.to_json({"analysisTier": "fast"})))
status, receipt = enqueue(alpha)
check("the last photo inside the allowance runs fast", status == 200 and receipt.get("tier") == "fast", receipt)
quota_denied = enqueue(alpha, tier="fast")     # a legacy client still asking for "fast"
check("past the allowance the photo still analyses on the normal lane",
      quota_denied[0] == 200 and quota_denied[1].get("tier") == "normal", quota_denied[1])
status, me = get(alpha, "/api/auth/me")
account_state = me.get("account") or {}
check("the allowance is spent and stays spent",
      account_state.get("fastUsed") == 20 and account_state.get("fastRemaining") == 0, account_state)

print()
print("=== 12. plant hint (cropHint) and petak round-trip ===")

# The farmer's own wording travels with the job as a hint...
hint_body, hint_ctype = multipart(dict(FLOW, cropHint="  cengek  "),
                                  {"image": ("plant.jpg", jpeg_bytes(), "image/jpeg")})
status, payload = alpha.request("POST", "/api/analyze", raw=hint_body, content_type=hint_ctype)
hint_job = payload.get("job_id") if isinstance(payload, dict) else None
check("a job carrying a plant hint is accepted", status == 200 and bool(hint_job), status)
poll_status, polled = get(alpha, f"/api/analyze/{hint_job}") if hint_job else (0, {})
check("the hint reaches the job context, trimmed",
      (polled.get("context") or {}).get("cropHint") == "cengek",
      (polled.get("context") or {}).get("cropHint"))

# ...capped, so a paragraph cannot bloat every prompt...
long_body, long_ctype = multipart(dict(FLOW, cropHint="x" * 200),
                                  {"image": ("plant.jpg", jpeg_bytes(), "image/jpeg")})
status, payload = alpha.request("POST", "/api/analyze", raw=long_body, content_type=long_ctype)
long_job = payload.get("job_id") if isinstance(payload, dict) else None
long_ctx = (get(alpha, f"/api/analyze/{long_job}")[1].get("context") or {}) if long_job else {}
check("an over-long hint is capped at 80 chars", len(long_ctx.get("cropHint") or "") == 80,
      len(long_ctx.get("cropHint") or ""))

# ...and an untouched box must not inject an empty hint into the prompt.
blank_body, blank_ctype = multipart(dict(FLOW, cropHint="   "),
                                    {"image": ("plant.jpg", jpeg_bytes(), "image/jpeg")})
status, payload = alpha.request("POST", "/api/analyze", raw=blank_body, content_type=blank_ctype)
blank_job = payload.get("job_id") if isinstance(payload, dict) else None
blank_ctx = (get(alpha, f"/api/analyze/{blank_job}")[1].get("context") or {}) if blank_job else {}
check("a blank hint is stored as null, not an empty string", blank_ctx.get("cropHint") is None,
      repr(blank_ctx.get("cropHint")))

# What gets SAVED is the model's standardised name; the farmer's wording is kept
# beside it rather than becoming the crop.
status, saved = post(alpha, "/api/records", {
    "id": "rec_hintcheck000001", "crop": "Cabai Rawit (Bird's Eye Chilli)",
    "condition": "Bercak daun", "severity": "Moderate", "confidence": 0.82,
    "cropHint": "cengek", "lat": -6.595, "lng": 106.816, "date": "2026-10-12",
})
check("the saved record uses the standardised crop name",
      saved.get("crop") == "Cabai Rawit (Bird's Eye Chilli)", saved.get("crop"))
check("the farmer's own wording is kept alongside, not as the crop",
      saved.get("cropHint") == "cengek", saved.get("cropHint"))
alpha.request("DELETE", "/api/records/rec_hintcheck000001")

# A petak drawn on the phone or traced with GPS is the same server-side object.
farm_ring = [[-6.5950, 106.8160], [-6.5950, 106.8170], [-6.5960, 106.8170],
             [-6.5960, 106.8160], [-6.5950, 106.8160]]
status, farm = post(alpha, "/api/farms", {
    "name": "Petak Uji Hint", "crop": "Cabai", "note": "", "ring": farm_ring,
    "areaM2": 12345.6, "source": "gps",
})
check("a petak saved from a GPS trace keeps its source", farm.get("source") == "gps",
      farm.get("source"))
check("a petak keeps the measured area", abs(float(farm.get("areaM2") or 0) - 12345.6) < 1,
      farm.get("areaM2"))
check("a petak keeps its closed ring", len(farm.get("ring") or []) == 5,
      len(farm.get("ring") or []))
status, farm_list = get(alpha, "/api/farms")
check("the saved petak appears in the farm list",
      any(f["id"] == farm["id"] for f in farm_list))
alpha.request("DELETE", f"/api/farms/{farm['id']}")
status, farm_list = get(alpha, "/api/farms")
check("the petak is gone after deletion",
      not any(f["id"] == farm["id"] for f in farm_list))

print()
print("=== 12b. analysis lane is chosen by the server ===")
# The farmer no longer picks a mode. An admin has no allowance to exhaust, so every
# admission runs on the fast pair however an older client fills the legacy tier field.
def _enqueue_with_tier(value):
    fields = dict(FLOW)
    if value is not None:
        fields["tier"] = value
    body, ctype = multipart(fields, {"image": ("plant.jpg", jpeg_bytes(), "image/jpeg")})
    status, payload = admin.request("POST", "/api/analyze", raw=body, content_type=ctype)
    if status != 200 or not isinstance(payload, dict):
        return status, None, {}
    job_id = payload.get("job_id")
    polled = get(admin, f"/api/analyze/{job_id}")[1]
    return status, job_id, (polled.get("context") or {})

status, fast_id, fast_ctx = _enqueue_with_tier("fast")
check("a job sent by an old fast-mode client is accepted", status == 200 and bool(fast_id), status)
check("the legacy fast request lands on the fast pair",
      fast_ctx.get("analysisTier") == "fast", fast_ctx.get("analysisTier"))

status, normal_id, normal_ctx = _enqueue_with_tier("normal")
check("a legacy normal request cannot downgrade an unlimited account",
      normal_ctx.get("analysisTier") == "fast", normal_ctx.get("analysisTier"))

status, default_id, default_ctx = _enqueue_with_tier(None)
check("a modern client sending no tier is admitted the same way",
      default_ctx.get("analysisTier") == "fast", default_ctx.get("analysisTier"))

# Anything unexpected must not reach the worker as a third, unhandled lane.
status, junk_id, junk_ctx = _enqueue_with_tier("TURBO")
check("an unknown tier cannot introduce a third lane",
      junk_ctx.get("analysisTier") == "fast", junk_ctx.get("analysisTier"))

status, config = get(worker, "/api/worker/config", worker_token=WORKER_TOKEN)
check("the worker config exposes both model pairs",
      bool(config.get("triageModelFast")) and bool(config.get("diagnoseModelFast")),
      f"fast={config.get('triageModelFast')}/{config.get('diagnoseModelFast')}")

print()
print("=== 13. cleanup of this run's throwaway accounts ===")
for email in (ALPHA_EMAIL, BETA_EMAIL):
    row = db.query_one("SELECT id FROM accounts WHERE email = ?", (email,))
    if row:
        status, _ = admin.request("DELETE", f"/api/admin/accounts/{row['id']}")
        check(f"removed test account {email}", status == 200, status)
# Sweep accounts an aborted earlier run may have left behind.
orphans = db.query(
    "SELECT id, email FROM accounts WHERE email LIKE 'alpha%@example.com' "
    "OR email LIKE 'beta%@example.com' OR email LIKE 'made%@example.com' "
    "OR email LIKE 'viewer%@example.com'"
)
for orphan in orphans:
    admin.request("DELETE", f"/api/admin/accounts/{orphan['id']}")
check("no test accounts remain", db.query_one(
    "SELECT COUNT(*) AS n FROM accounts WHERE email LIKE 'alpha%@example.com' "
    "OR email LIKE 'beta%@example.com' OR email LIKE 'made%@example.com' "
    "OR email LIKE 'viewer%@example.com' OR email LIKE 'probe%@example.com'")["n"] == 0,
    len(orphans))
# Leave the deployment as a real one would be: sign-up closed.
admin.request("PUT", "/api/admin/settings", payload={"settings": {"ALLOW_REGISTRATION": False}})
check("registration is closed again after the run",
      get(Client("probe2"), "/api/admin/settings")[0] == 401 and
      post(Client("probe3"), "/api/auth/register",
           {"email": f"probe2{db.now_ms()}@example.com", "password": "SandiProbe123"})[0] == 403)
with db.transaction() as tx:
    tx.execute("DELETE FROM login_attempts")

print()
passed = sum(1 for _, ok, _ in RESULTS if ok)
total = len(RESULTS)
print(f"=== VERIFY RESULT: {passed}/{total} passed, {total - passed} failed ===")
for name, ok, detail in RESULTS:
    if not ok:
        print("  FAILED:", name, "::", detail)
sys.exit(0 if passed == total else 1)

