"""Real loopback transport fixtures: never send a real credential or model call."""
import importlib.util
import os
from pathlib import Path
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('staged_worker_transport',ROOT/'worker/gemini_worker.py')
worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)

class RedirectTests(unittest.TestCase):
    def setUp(self):
        self.visits=[]
        parent=self
        class Sink(BaseHTTPRequestHandler):
            def do_GET(self):
                parent.visits.append('credential-target-contacted')
                self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(b'{"test_fixture":true}')
            def log_message(self,*args):pass
        self.sink=ThreadingHTTPServer(('127.0.0.1',0),Sink)
        destination=f'http://127.0.0.1:{self.sink.server_port}/sink'
        class Origin(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path=='/slow-headers':
                    time.sleep(.5)
                    try:self.send_response(200);self.end_headers();self.wfile.write(b'{}')
                    except OSError:pass
                    return
                if self.path=='/drip':
                    self.send_response(200);self.end_headers()
                    try:
                        for part in [b'{',b'"',b'x',b'"',b':',b'1',b'}']:
                            self.wfile.write(part);self.wfile.flush();time.sleep(.08)
                    except OSError:pass
                    return
                if self.path=='/large':
                    self.send_response(200);self.end_headers();self.wfile.write(b'"'+b'x'*10000+b'"');return
                if self.path=='/normal':
                    self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(b'{"test_fixture":true}');return
                self.send_response(302);self.send_header('Location',destination);self.end_headers()
            def log_message(self,*args):pass
        self.origin=ThreadingHTTPServer(('127.0.0.1',0),Origin)
        self.threads=[threading.Thread(target=s.serve_forever,daemon=True) for s in [self.sink,self.origin]]
        for t in self.threads:t.start()
    def tearDown(self):
        for s in [self.origin,self.sink]:s.shutdown();s.server_close()
        for t in self.threads:t.join()
    def test_secret_bearing_redirect_is_never_followed(self):
        status,_=worker._http(f'http://127.0.0.1:{self.origin.server_port}/redirect',headers={'Authorization':'Bearer SYNTHETIC_TEST_ONLY','X-Worker-Token':'SYNTHETIC_TEST_ONLY'},timeout=3)
        self.assertEqual(self.visits,[],'Credential-bearing transport followed redirect to a different origin')
        self.assertEqual(status,302)
    def test_normal_json_transport_still_works(self):
        status,body=worker._http(f'http://127.0.0.1:{self.origin.server_port}/normal',timeout=3)
        self.assertEqual(status,200);self.assertEqual(body,{'test_fixture':True})
    def test_total_deadline_cancels_slow_headers_and_dripping_body(self):
        for path in ['/slow-headers','/drip']:
            started=time.monotonic()
            status,body=worker._http(f'http://127.0.0.1:{self.origin.server_port}'+path,timeout=.15)
            self.assertEqual(status,0);self.assertEqual(body.get('_error'),'request_deadline')
            self.assertLess(time.monotonic()-started,.4,'Total deadline waited for response completion')
    def test_response_size_is_bounded(self):
        import asyncio
        from worker.transport import request_json_async
        status,body=asyncio.run(request_json_async(f'http://127.0.0.1:{self.origin.server_port}/large',timeout=2,max_bytes=128))
        self.assertEqual(status,0);self.assertEqual(body,{'_error':'response_too_large'})

if __name__=='__main__':unittest.main()
