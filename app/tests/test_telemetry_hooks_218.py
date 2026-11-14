"""Actual HTTPX hook regression: no production imports, database or network."""
import ast
import asyncio
from pathlib import Path
import unittest
from urllib.parse import urlsplit
import httpx
from fastapi import HTTPException

SOURCE = Path(__file__).resolve().parents[1] / 'backend/api_app.py'


def functions():
    names = {'_validate_outbound_url', '_validate_request_url', '_http_client', '_get_json', '_get_json_safe'}
    ns = {'httpx': httpx, 'HTTPException': HTTPException, 'urlsplit': urlsplit,
          'Any': object, '_TELEMETRY_HOSTS': {'api.open-meteo.com', 'geocoding-api.open-meteo.com'},
          '_UA': {'User-Agent': 'JagaKebond-isolated-regression'}, 'TELEMETRY_TIMEOUT': 5}
    for node in ast.parse(SOURCE.read_text()).body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names:
            exec(compile(ast.Module(body=[node], type_ignores=[]), '<isolated hooks>', 'exec'), ns)
    return ns


class AsyncTelemetryHookTests(unittest.TestCase):
    def test_real_async_client_hook_reaches_provider_transport(self):
        ns = functions()
        calls = []
        async def transport(request):
            calls.append(request.url.host)
            return httpx.Response(200, json={'elevation': [42]})
        async def exercise():
            async with httpx.AsyncClient(transport=httpx.MockTransport(transport),
                    event_hooks={'request': [ns['_validate_request_url']]}) as client:
                result = await ns['_get_json_safe'](client, 'https://api.open-meteo.com/v1/elevation?latitude=0&longitude=0')
                self.assertEqual(result, {'elevation': [42]})
        asyncio.run(exercise())
        self.assertEqual(calls, ['api.open-meteo.com'])

    def test_async_hook_rejects_disallowed_host_before_transport(self):
        ns = functions()
        calls = []
        async def transport(request):
            calls.append(str(request.url))
            return httpx.Response(200)
        async def exercise():
            async with httpx.AsyncClient(transport=httpx.MockTransport(transport),
                    event_hooks={'request': [ns['_validate_request_url']]}) as client:
                with self.assertRaises(HTTPException):
                    await client.get('https://evil.invalid/steal')
        asyncio.run(exercise())
        self.assertEqual(calls, [])


if __name__ == '__main__':
    unittest.main()
