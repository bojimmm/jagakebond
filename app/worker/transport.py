"""Bounded, cancellable JSON transport. No redirects or environment proxy inheritance."""
from __future__ import annotations

import asyncio
import json
import httpx

MAX_RESPONSE_BYTES = 8 * 1024 * 1024


async def request_json_async(url: str, payload=None, headers=None, timeout: float = 180,
                             method: str | None = None, *, max_bytes: int = MAX_RESPONSE_BYTES):
    total = max(.01, float(timeout))
    try:
        async with asyncio.timeout(total):
            limits = httpx.Timeout(total, connect=min(total, 15), read=min(total, 30))
            async with httpx.AsyncClient(timeout=limits, follow_redirects=False, trust_env=False) as client:
                async with client.stream(method or ("POST" if payload is not None else "GET"), url,
                                         json=payload, headers=headers) as response:
                    body = bytearray()
                    async for chunk in response.aiter_bytes(chunk_size=65536):
                        if len(body) + len(chunk) > max_bytes:
                            return 0, {"_error": "response_too_large"}
                        body.extend(chunk)
                    if not body:
                        return response.status_code, {}
                    try:
                        return response.status_code, json.loads(body.decode("utf-8"))
                    except (ValueError, UnicodeError, RecursionError):
                        return response.status_code, {"_error": "invalid_json_response"}
    except (TimeoutError, httpx.TimeoutException):
        return 0, {"_error": "request_deadline"}
    except (httpx.HTTPError, ValueError):
        return 0, {"_error": "transport_failure"}


def request_json(url: str, payload=None, headers=None, timeout: float = 180, method=None):
    return asyncio.run(request_json_async(url, payload, headers, timeout, method))
