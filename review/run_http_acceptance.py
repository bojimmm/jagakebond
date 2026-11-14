"""Run HTTP acceptance against a fresh disposable app on an ephemeral port.

No production app imports, env, databases or credentials. Model responses are
explicit synthetic test fixtures, not evidence of agronomic accuracy.
"""
from pathlib import Path
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / 'app'
OUT = ROOT / 'review' / 'http-acceptance.txt'
PYTHON = os.environ.get('JK_TEST_PYTHON', '/opt/jagakebond/venv/bin/python')
with tempfile.TemporaryDirectory(prefix='jk-http-acceptance-', dir=os.environ['TMPDIR']) as folder:
    fixture = Path(folder) / 'app'
    shutil.copytree(APP, fixture, ignore=shutil.ignore_patterns('.env','data','venv','.git','__pycache__','node_modules'))
    env = {key:os.environ[key] for key in ['PATH','HOME','TMPDIR','LANG'] if key in os.environ}
    env.update({'PYTHONDONTWRITEBYTECODE':'1','COOKIE_SECURE':'0','SECRET_KEY':'dev-local-secret-key-synthetic-fixture',
                'WORKER_TOKEN':'dev-local-worker-token','ADMIN_EMAIL':'admin@jagakebond.local',
                'ADMIN_PASSWORD':'AdminLokal123','ALLOW_REGISTRATION':'0','SEED_DEMO_DATA':'0',
                'NINEROUTER_KEY':'synthetic-fixture-router-key','NINEROUTER_URL':'http://127.0.0.1:9'})
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    base=f'http://127.0.0.1:{port}'
    with (Path(folder)/'server.log').open('w') as log:
        server=subprocess.Popen([PYTHON,'-m','uvicorn','backend.app:app','--host','127.0.0.1','--port',str(port),'--workers','1'],
                                cwd=fixture,env=env,stdout=log,stderr=subprocess.STDOUT)
        try:
            for _ in range(80):
                if server.poll() is not None:raise RuntimeError('Isolated server failed to start; inspect fixture log privately')
                try:
                    with urllib.request.urlopen(base+'/api/health',timeout=1) as response:
                        if json.load(response).get('ok'):break
                except OSError:time.sleep(.15)
            else:raise RuntimeError('Isolated server health timeout')
            result=subprocess.run([PYTHON,'verify_mvp.py',base],cwd=fixture,env=env,capture_output=True,text=True,timeout=180)
            OUT.write_text('Scope: synthetic disposable HTTP fixture; NO model call/production state.\n'+result.stdout+result.stderr)
            print(result.stdout)
            if result.stderr:print(result.stderr)
            print('Evidence:',OUT,'exit:',result.returncode)
            raise SystemExit(result.returncode)
        finally:
            server.terminate()
            try:server.wait(timeout=15)
            except subprocess.TimeoutExpired:server.kill();server.wait()
