"""Launch a disposable backend for real browser offline acceptance."""
from pathlib import Path
import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
PYTHON = os.environ.get('JK_TEST_PYTHON','/opt/jagakebond/venv/bin/python')
with tempfile.TemporaryDirectory(prefix='jk-browser-e2e-',dir=os.environ['TMPDIR']) as folder:
    folder=Path(folder);fixture=folder/'app'
    shutil.copytree(ROOT/'app',fixture,ignore=shutil.ignore_patterns('.env','data','venv','.git','__pycache__','node_modules'))
    env={key:os.environ[key] for key in ['PATH','HOME','TMPDIR','LANG'] if key in os.environ}
    env.update({'PYTHONDONTWRITEBYTECODE':'1','COOKIE_SECURE':'0','SECRET_KEY':'dev-local-secret-key-synthetic-fixture',
                'WORKER_TOKEN':'dev-local-worker-token','ADMIN_EMAIL':'admin@jagakebond.local','ADMIN_PASSWORD':'AdminLokal123',
                'ALLOW_REGISTRATION':'1','SEED_DEMO_DATA':'0','NINEROUTER_KEY':'','NINEROUTER_URL':'http://127.0.0.1:9'})
    image=folder/'test-only-gallery.jpg';Image.new('RGB',(400,500),(50,120,55)).save(image,format='JPEG')
    with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    base=f'http://127.0.0.1:{port}'
    with (folder/'server.log').open('w') as log:
        server=subprocess.Popen([PYTHON,'-m','uvicorn','backend.app:app','--host','127.0.0.1','--port',str(port),'--workers','1'],cwd=fixture,env=env,stdout=log,stderr=subprocess.STDOUT)
        try:
            for _ in range(80):
                if server.poll() is not None:raise RuntimeError('Isolated backend failed to start')
                try:
                    with urllib.request.urlopen(base+'/api/health',timeout=1) as r:
                        if json.load(r).get('ok'):break
                except OSError:time.sleep(.15)
            else:raise RuntimeError('Isolated backend health timeout')
            result=subprocess.run(['node','offline-e2e.cjs',base,str(image)],cwd=ROOT/'review/browser-tools',env=env,capture_output=True,text=True,timeout=240)
            print(result.stdout);print(result.stderr)
            (ROOT/'review/offline-e2e-output.txt').write_text(result.stdout+result.stderr)
            raise SystemExit(result.returncode)
        finally:
            server.terminate()
            try:server.wait(timeout=15)
            except subprocess.TimeoutExpired:server.kill();server.wait()
