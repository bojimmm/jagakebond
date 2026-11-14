"""Explicit admin-only synthetic image/JSON capability check, never farmer data."""
from __future__ import annotations

import base64
import json
import secrets
import struct
import time
import zlib

from worker.transport import request_json

COLORS = {"red": (230, 35, 35), "blue": (30, 60, 225),
          "green": (25, 180, 65), "yellow": (245, 215, 20)}


def fixture() -> tuple[str, dict[str, str]]:
    """A fresh visual challenge; the expected answer is not included in the prompt."""
    background, foreground = secrets.SystemRandom().sample(list(COLORS), 2)
    pixels = bytearray()
    for y in range(96):
        pixels.append(0)
        for x in range(96):
            pixels.extend(COLORS[foreground if (x - 48) ** 2 + (y - 48) ** 2 < 26 ** 2 else background])
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))
    png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', 96, 96, 8, 2, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(pixels)) + chunk(b'IEND', b''))
    return base64.b64encode(png).decode('ascii'), {
        "background_color": background, "shape_color": foreground, "shape": "circle"}


def probe(url: str, key: str, route: str) -> dict:
    image, expected = fixture()
    started = time.monotonic()
    status, body = request_json(url + '/v1/chat/completions', {
        'model': route, 'max_tokens': 600,
        'messages': [
            {'role': 'system', 'content': 'Describe only the supplied synthetic image. Return one JSON object without Markdown.'},
            {'role': 'user', 'content': [
                {'type': 'text', 'text': 'Identify the background color, the central shape color, and the shape. Keys: background_color, shape_color, shape. Use English lowercase color and shape names.'},
                {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,' + image}},
            ]},
        ],
    }, headers={'Authorization': 'Bearer ' + key}, timeout=30)
    result = {'route': route, 'ok': False, 'visionMatch':False, 'schemaValid':False,
              'latencyMs':round((time.monotonic()-started)*1000)}
    if status != 200 or not isinstance(body, dict):
        result['detail'] = 'Uji tidak selesai.' if not status else 'Penyedia menolak uji (HTTP ' + str(status) + ').'
        return result
    try:
        choice = body['choices'][0]
        message = choice['message']
        reply = json.loads(message['content'])
        if message.get('refusal') or choice.get('finish_reason') == 'length':
            raise ValueError('incomplete')
        result['schemaValid'] = (isinstance(reply,dict) and set(reply)==set(expected)
            and reply.get('background_color') in COLORS and reply.get('shape_color') in COLORS
            and reply.get('shape') in ('circle','square','triangle'))
        result['visionMatch'] = result['schemaValid'] and all(reply.get(k) == v for k, v in expected.items())
        result['ok'] = result['visionMatch']
    except (KeyError, IndexError, TypeError, ValueError):
        result['ok'] = False
    model = body.get('model')
    if isinstance(model, str):
        result['resolvedModel'] = model[:160]
    result['detail'] = ('Gambar sintetis dikenali dan JSON sesuai.' if result['ok'] else
                        'Jawaban gambar atau struktur JSON tidak sesuai. Periksa kemampuan rute ini.')
    return result
