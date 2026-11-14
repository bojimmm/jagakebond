"""Vendor the offline map assets (Geoman + Turf) into frontend/vendor/.

The PWA must work without a CDN for the map draw tools, so these three files are
downloaded once at build time and served from our own origin.
"""

import sys
import urllib.request
from pathlib import Path

VENDOR = Path(__file__).resolve().parent / "frontend" / "vendor"
VENDOR.mkdir(parents=True, exist_ok=True)

ASSETS = {
    "leaflet-geoman.min.js": "https://unpkg.com/@geoman-io/leaflet-geoman-free@2.19.1/dist/leaflet-geoman.min.js",
    "leaflet-geoman.css": "https://unpkg.com/@geoman-io/leaflet-geoman-free@2.19.1/dist/leaflet-geoman.css",
    "turf.min.js": "https://unpkg.com/@turf/turf@7.2.0/turf.min.js",
}

failures = []
for name, url in ASSETS.items():
    target = VENDOR / name
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "JagaKebond-build/1.0"})
        with urllib.request.urlopen(request, timeout=60) as response:
            blob = response.read()
        if len(blob) < 2000:
            raise ValueError(f"suspiciously small ({len(blob)} bytes)")
        target.write_bytes(blob)
        print(f"OK   {name:26s} {len(blob):>9,} bytes  <- {url}")
    except Exception as error:
        failures.append((name, url, f"{type(error).__name__}: {error}"))
        print(f"FAIL {name:26s} {error}")

print()
if failures:
    print(f"{len(failures)} asset(s) NOT vendored:")
    for name, url, error in failures:
        print(f"  - {name}: {error}\n    from {url}")
    sys.exit(1)
print("all vendor assets present")
