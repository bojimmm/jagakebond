"""Telemetry fixtures never read production settings or contact providers."""
from pathlib import Path
import asyncio
import math
import sys
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend import api_app, db
from fastapi import HTTPException


class Telemetry217Tests(unittest.TestCase):
    def run_telemetry(self, *, hint='', search=None, fail_weather=False, lat=-6.2, lng=106.8):
        self.urls = []
        async def get_json(client, url):
            self.urls.append(url)
            host = urlsplit(url).hostname
            if host == 'api.open-meteo.com':
                if fail_weather:
                    raise RuntimeError('Synthetic upstream outage')
                return {'elevation': [0]} if '/elevation?' in url else {'current': {'temperature_2m': 0, 'relative_humidity_2m': 0}}
            if host == 'geocoding-api.open-meteo.com':
                return search or {'results': []}
            self.fail('Unrequested provider: ' + host)
        with patch.object(api_app.settings_store, 'secret_value', return_value=''), patch.object(api_app, '_get_json', side_effect=get_json):
            return asyncio.run(api_app.telemetry(lat, lng, account={'id':'synthetic-owner'}, placeHint=hint))

    def test_openmeteo_name_search_resolves_place_and_retains_gps(self):
        result = self.run_telemetry(hint='Jakarta & Barat', search={'results':[
            {'name':'Wrong place','latitude':50,'longitude':10},
            {'name':'Jakarta','admin1':'Jakarta','country':'Indonesia','latitude':-6.21,'longitude':106.81}]})
        self.assertEqual(result['locationName'], 'Jakarta, Indonesia')
        self.assertEqual(result['locationProvider'], 'open-meteo')
        self.assertTrue(result['locationApproximate'])
        self.assertEqual((result['lat'],result['lng']),(-6.2,106.8))
        self.assertEqual((result['elevation'],result['tempC'],result['rh']),(0,0,0))
        self.assertFalse(any('geocode.maps.co' in url for url in self.urls))
        query=next(url for url in self.urls if 'geocoding-api.open-meteo.com' in url)
        self.assertEqual(parse_qs(urlsplit(query).query)['name'],['Jakarta & Barat'])

    def test_empty_or_distant_search_stays_coordinates_only_without_other_provider(self):
        for search in ({'results': []}, {'results': [{'name':'Jakarta','latitude':50,'longitude':10}]}):
            with self.subTest(search=search):
                result = self.run_telemetry(hint='Jakarta', search=search)
                self.assertIsNone(result['locationName'])
                self.assertIsNone(result['locationProvider'])
                self.assertEqual(result['locationStatus'],'coordinates-only')
                self.assertFalse(result['locationApproximate'])
                self.assertEqual({urlsplit(url).hostname for url in self.urls},
                                 {'api.open-meteo.com','geocoding-api.open-meteo.com'})

    def test_no_hint_never_misrepresents_coordinates_as_name_search(self):
        result=self.run_telemetry()
        self.assertIsNone(result['locationName'])
        self.assertEqual(result['locationStatus'],'coordinates-only')
        self.assertFalse(any('geocoding-api.open-meteo.com' in url for url in self.urls))

    def test_upstream_absence_retains_coordinates_and_partial_weather(self):
        result=self.run_telemetry(hint='Unknown')
        self.assertIsNone(result['locationName'])
        self.assertEqual(result['locationStatus'],'coordinates-only')
        self.assertEqual(result['elevation'],0)
        self.assertEqual(result['weather'],'0°C • 0% RH')
        result=self.run_telemetry(hint='Kota',fail_weather=True)
        self.assertIsNone(result['locationName'])
        self.assertIsNone(result['weather'])

    def test_nonfinite_range_and_oversized_hint_rejected_before_network(self):
        for lat,lng in [(math.nan,0),(0,math.inf),(91,0),(0,-181)]:
            with self.subTest(lat=lat,lng=lng), self.assertRaises(HTTPException):
                self.run_telemetry(lat=lat,lng=lng)
            self.assertEqual(self.urls,[])
        with self.assertRaises(HTTPException):
            self.run_telemetry(hint='x'*121)
        self.assertEqual(self.urls,[])

    def test_openmeteo_host_allowed_without_expanding_arbitrary_hosts(self):
        api_app._validate_outbound_url('https://geocoding-api.open-meteo.com/v1/search?name=Kota')
        for url in ['https://geocoding-api.open-meteo.com.evil.invalid/v1/search',
                    'https://geocoding-api.open-meteo.com:8443/v1/search',
                    'https://user@geocoding-api.open-meteo.com/v1/search',
                    'https://geocode.maps.co.evil.invalid/reverse?lat=-6&lon=106']:
            with self.subTest(url=url),self.assertRaises(HTTPException):
                api_app._validate_outbound_url(url)

    def test_record_projection_distinguishes_saved_updates_from_photo_capture(self):
        from collections import defaultdict
        row=defaultdict(lambda:None,{'id':'fixture-record','timestamp_ms':1000,'created_ms':2000,'updated_ms':3000})
        record=db.row_record(row)
        self.assertEqual(record['timestampMs'],1000)
        self.assertEqual(record.get('createdMs'),2000)
        self.assertEqual(record.get('updatedMs'),3000)

    def test_asgi_query_binding_and_invalid_coordinate_status(self):
        import httpx
        from fastapi import FastAPI
        app=FastAPI()
        app.include_router(api_app.router)
        app.dependency_overrides[api_app.auth.current_account]=lambda:{'id':'synthetic-owner'}
        async def exercise():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://fixture.invalid') as client:
                with patch.object(api_app.settings_store,'secret_value',return_value=''), patch.object(api_app,'_get_json_safe',return_value=None):
                    response=await client.get('/api/telemetry',params={'lat':0,'lng':0,'placeHint':'Unknown'})
                    self.assertEqual(response.status_code,200)
                    self.assertEqual(response.json()['lat'],0)
                    self.assertEqual(response.json()['locationStatus'],'coordinates-only')
                    for coordinate in ['nan','inf','91']:
                        response=await client.get('/api/telemetry',params={'lat':coordinate,'lng':0})
                        self.assertEqual(response.status_code,400)
        asyncio.run(exercise())


if __name__ == '__main__':
    unittest.main()
