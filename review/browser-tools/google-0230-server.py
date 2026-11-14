"""Disposable backend for google-0230.cjs: the real app, with Google's JWKS replaced by a local test key.

    python google-0230-server.py <app copy> <key.pem out> <port>

Writes a freshly generated RSA private key (PKCS#8 PEM) for the harness to sign synthetic ID tokens
with, patches backend.google_auth._fetch_jwks to serve the matching public key, and runs uvicorn on
127.0.0.1:<port>. Nothing is ever fetched from Google. Test tooling only; never shipped.
"""

from __future__ import annotations

import base64
import os
import sys
from pathlib import Path

APP_DIR, KEY_OUT, PORT = Path(sys.argv[1]).resolve(), Path(sys.argv[2]), int(sys.argv[3])
sys.path.insert(0, str(APP_DIR))
os.chdir(APP_DIR)

from cryptography.hazmat.primitives import serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import rsa  # noqa: E402


def b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
KEY_OUT.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                      serialization.NoEncryption()))
numbers = key.public_key().public_numbers()
JWKS = {"keys": [{"kty": "RSA", "alg": "RS256", "use": "sig", "kid": "harness-0230",
                  "n": b64u(numbers.n.to_bytes((numbers.n.bit_length() + 7) // 8, "big")),
                  "e": b64u(numbers.e.to_bytes(3, "big"))}]}

from backend import google_auth  # noqa: E402

google_auth._fetch_jwks = lambda: (JWKS, 3600)

import uvicorn  # noqa: E402

from backend.app import app  # noqa: E402

uvicorn.run(app, host="127.0.0.1", port=PORT, workers=1, log_level="warning")
