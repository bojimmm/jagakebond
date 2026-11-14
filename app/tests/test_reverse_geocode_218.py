"""Reverse provider integration, synthetic credentials and HTTPX transport only."""
from pathlib import Path
import asyncio
import json
import sys
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import httpx
from fastapi import HTTPException
from backend import api_app, settings_store

KEY = 'fixture-key-not-a-real-credential'


class ReverseGeocodeTests(unittest.TestCase):
    def exercise(self, *, key=KEY, reverse=None, status=200, hint='', fail_reverse=False):
        self.requests = []
        async def transport(request):
            self.requests.append(request)
            if request.url.host == 'geocode.maps.co':
                if fail_reverse:
                    raise httpx.ConnectError('Synthetic transport failure', request=request)
                return httpx.Response(status, json=reverse if reverse is not None else {
                    'address': {'village':'Desa Uji','county':'Kabupaten Uji','state':'Provinsi Uji'}})
            if request.url.host == 'geocoding-api.open-meteo.com':
                return httpx.Response(200, json={'results': [{'name':'Kota Hint','latitude':0,'longitude':0}]})
            return httpx.Response(200, json={'elevation':[0]} if request.url.path.endswith('elevation') else {
                'current':{'temperature_2m':23,'relative_humidity_2m':85}})
        def factory():
            return httpx.AsyncClient(transport=httpx.MockTransport(transport), follow_redirects=False,
                event_hooks={'request':[api_app._validate_request_url]})
        with patch.object(settings_store,'secret_value',return_value=key), patch.object(api_app,'_http_client',side_effect=factory):
            return asyncio.run(api_app.telemetry(0, 0, account={'id':'synthetic-owner'}, placeHint=hint))

    def test_reverse_address_and_zero_coordinates_real_hook(self):
        result = self.exercise()
        self.assertEqual(result['locationName'], 'Desa Uji, Kabupaten Uji, Provinsi Uji')
        self.assertEqual(result['locationProvider'], 'geocode.maps.co')
        self.assertEqual((result['lat'], result['lng']), (0,0))
        self.assertEqual((result['tempC'],result['rh'],result['elevation']), (23,85,0))
        self.assertTrue(result['locationApproximate'])

    def test_key_only_in_reverse_request_header_never_query_weather_or_payload(self):
        result = self.exercise(hint='Kota')
        reverse = [r for r in self.requests if r.url.host=='geocode.maps.co']
        self.assertEqual(len(reverse),1)
        self.assertEqual(reverse[0].headers.get('authorization'), 'Bearer '+KEY)
        query=parse_qs(reverse[0].url.query.decode())
        self.assertEqual(query['lat'],['0'])
        self.assertEqual(query['lon'],['0'])
        self.assertEqual(query['format'],['json'])
        self.assertNotIn('api_key',query)
        for request in self.requests:
            self.assertNotIn(KEY,str(request.url))
            if request.url.host!='geocode.maps.co': self.assertNotIn('authorization',request.headers)
        self.assertNotIn(KEY,json.dumps(result))

    def test_no_key_makes_no_reverse_call(self):
        result=self.exercise(key='')
        self.assertIsNone(result['locationName'])
        self.assertEqual(result['locationStatus'],'coordinates-only')
        self.assertFalse(any(r.url.host=='geocode.maps.co' for r in self.requests))
        self.assertEqual(result['tempC'],23)

    def test_reverse_failure_never_discards_weather_or_echoes_error(self):
        for status in [401,403,429,500,503]:
            with self.subTest(status=status):
                result=self.exercise(status=status,reverse={'error':KEY})
                self.assertIsNone(result['locationName'])
                self.assertEqual(result['tempC'],23)
                self.assertNotIn(KEY,json.dumps(result))
                self.assertEqual(sum(r.url.host=='geocode.maps.co' for r in self.requests),1)
        self.assertEqual(self.exercise(fail_reverse=True)['rh'],85)

    def test_malformed_and_error_address_are_not_real_place(self):
        for value in [[],None,{'error':'no coverage'}, {'address':{'city':None}}, {'address':'bad'}]:
            if value is None: continue
            with self.subTest(value=value):
                self.assertIsNone(self.exercise(reverse=value)['locationName'])
        result=self.exercise(reverse={'display_name':' Region fixture '})
        self.assertEqual(result['locationName'],'Region fixture')

    def test_reverse_preferred_over_approximate_name_hint_with_hint_fallback(self):
        self.assertEqual(self.exercise(hint='Kota')['locationProvider'],'geocode.maps.co')
        result=self.exercise(status=429,hint='Kota')
        self.assertEqual(result['locationProvider'],'open-meteo')
        self.assertEqual(result['locationName'],'Kota Hint')

    def test_redirect_does_not_send_bearer_to_target(self):
        requests=[]
        async def transport(request):
            requests.append(str(request.url))
            return httpx.Response(302,headers={'location':'https://evil.invalid/steal'})
        async def exercise():
            async with httpx.AsyncClient(transport=httpx.MockTransport(transport),follow_redirects=True,
                    event_hooks={'request':[api_app._validate_request_url]}) as client:
                with patch.object(settings_store,'secret_value',return_value=KEY):
                    self.assertIsNone(await api_app._reverse_place(client,0,0))
        asyncio.run(exercise())
        self.assertEqual(len(requests),1)
        self.assertTrue(requests[0].startswith('https://geocode.maps.co/reverse?'))

    def test_secret_spec_registered_but_no_arbitrary_geocoder_host(self):
        spec=settings_store.spec('GEOCODE_API_KEY')
        self.assertIsNotNone(spec)
        self.assertTrue(spec['secret'])
        self.assertEqual(spec['env'],'GEOCODE_API_KEY')
        for url in ['https://geocode.maps.co.evil.invalid/reverse','http://geocode.maps.co/reverse',
                    'https://user@geocode.maps.co/reverse','https://geocode.maps.co:8443/reverse']:
            with self.subTest(url=url), self.assertRaises(HTTPException):
                api_app._validate_outbound_url(url)


if __name__=='__main__': unittest.main()
