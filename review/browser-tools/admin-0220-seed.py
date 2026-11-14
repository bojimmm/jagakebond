"""Seed a DISPOSABLE backend with synthetic accounts and jobs for admin-0220.cjs.

Usage: python admin-0220-seed.py http://127.0.0.1:<port>
Everything goes through the public HTTP API (admin console + farmer + worker routes), exactly like
real traffic. Prints one JSON object with the ids the browser harness needs. Synthetic data only.
"""
import http.cookiejar
import io
import json
import sys
import urllib.error
import urllib.request

from PIL import Image

BASE = sys.argv[1].rstrip("/")
if not BASE.startswith("http://127.0.0.1:"):
    raise SystemExit("refusing a non-loopback target")
ADMIN = ("admin@jagakebond.local", "AdminLokal123")
WORKER = "dev-local-worker-token"


class Client:
    def __init__(self):
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def csrf(self):
        return next((c.value for c in self.jar if c.name == "jk_csrf"), None)

    def call(self, method, path, payload=None, raw=None, ctype=None, headers=None):
        data, hdrs = None, dict(headers or {})
        if raw is not None:
            data, hdrs["Content-Type"] = raw, ctype
        elif payload is not None:
            data, hdrs["Content-Type"] = json.dumps(payload).encode(), "application/json"
        if method != "GET" and self.csrf():
            hdrs["X-CSRF-Token"] = self.csrf()
        req = urllib.request.Request(BASE + path, data=data, method=method, headers=hdrs)
        try:
            with self.opener.open(req, timeout=60) as r:
                return r.status, json.loads(r.read().decode() or "null")
        except urllib.error.HTTPError as e:
            body = e.read().decode()
            try:
                return e.code, json.loads(body)
            except ValueError:
                return e.code, body


def jpeg(color):
    out = io.BytesIO()
    Image.new("RGB", (640, 480), color).save(out, "JPEG", quality=80)
    return out.getvalue()


def multipart(fields, image):
    b = "----jkseed0220"
    parts = [f'--{b}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode() for k, v in fields.items()]
    parts.append(f'--{b}\r\nContent-Disposition: form-data; name="image"; filename="p.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'.encode()
                 + image + b"\r\n")
    parts.append(f"--{b}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={b}"


admin = Client()
status, _ = admin.call("POST", "/api/auth/login", {"email": ADMIN[0], "password": ADMIN[1]})
assert status == 200, status
names = ["Budi Santoso", "Siti Aminah", "Joko Widodo", "Dewi Lestari", "Agus Salim", "Rina Marlina", "Eko Prasetyo", "Wati Kusuma"]
created = []
for i in range(1, 33):
    role = "priority" if i % 7 == 0 else "user"
    status, body = admin.call("POST", "/api/admin/accounts", {
        "email": f"petani{i:02d}@contoh.id", "name": f"{names[i % len(names)]} {i}", "password": "PetaniUji12345", "role": role})
    assert status == 200, (status, body)
    created.append(body["id"])

# a few edits so the audit log has more than one page of meaningful rows
for n, ident in enumerate(created[:24]):
    status, body = admin.call("PUT", f"/api/admin/accounts/{ident}", {"name": f"{names[(n + 3) % len(names)]} {n + 1}"})
    assert status == 200, (status, body)

farmers = [Client() for _ in range(3)]
for i, f in enumerate(farmers):
    status, _ = f.call("POST", "/api/auth/login", {"email": f"petani{i + 1:02d}@contoh.id", "password": "PetaniUji12345"})
    assert status == 200, status

flow = {"lat": "-6.5950", "lng": "106.8160", "elevation": "265", "locationName": "Bogor Tengah, Jawa Barat", "accuracy": "12",
        "weather": "27 C", "photoDate": "2026-10-11", "photoTimestampMs": "1760000000000", "farmId": "", "deviceId": "seed", "tier": "normal"}
jobs = []
for n in range(9):
    body, ctype = multipart(flow, jpeg((40 + n * 15, 140, 60)))
    status, res = farmers[n % 3].call("POST", "/api/analyze", raw=body, ctype=ctype)
    assert status == 200, (status, res)
    jobs.append(res["job_id"])

worker = Client()
claimed = []
claims = {}
for _ in range(5):
    status, res = worker.call("GET", "/api/queue/next?worker=seed", headers={"X-Worker-Token": WORKER})
    assert status == 200, (status, res)
    if res.get("job"):
        claimed.append(res["job"]["id"])
        claims[res["job"]["id"]] = res["job"]["claimToken"]
# claimed[0], [1] -> done; [2], [3] -> rejected; [4] stays claimed (being worked on)
report={'version':1,'active_conditions':[],'findings':['Gejala sintetis pada foto.'],'possible_causes':[],
        'actions':['Periksa daun.'],'prevention':[],'nutrition':[],'monitoring':['Foto ulang.'],'escalation':[]}
for jid in claimed[:2]:
    status,reply=worker.call("POST",f"/api/analyze/{jid}/result",{'claimToken':claims[jid],
        'triage':{'usable':True,'is_plant':True,'reason':'Foto sintetis jelas.'},
        'diagnosis':{'crop':'Kopi (data uji)','condition':'Data Uji','severity':'Moderate','confidence':.6,
                     'needs_review':True,'symptoms_id':'Gejala sintetis.','assessment':report}},headers={'X-Worker-Token':WORKER})
    assert status==200 and reply['status']=='done',(status,reply)
for jid in claimed[2:4]:
    status,reply=worker.call("POST",f"/api/analyze/{jid}/result",{'claimToken':claims[jid],
        'triage':{'usable':False,'is_plant':True,'reason':'Foto terlalu buram untuk dianalisis'},'diagnosis':{}},headers={'X-Worker-Token':WORKER})
    assert status==200 and reply['status']=='rejected',(status,reply)
print(json.dumps({"accounts": created, "jobs": jobs, "done": claimed[:2], "rejected": claimed[2:4], "claimed": claimed[4:5],
                  "queued": [j for j in jobs if j not in claimed]}))
