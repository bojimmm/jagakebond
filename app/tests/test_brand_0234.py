"""Brand rollout contract: original artwork, every surface, safe icon backgrounds."""
from pathlib import Path
import hashlib,json,re
from PIL import Image
ROOT=Path(__file__).resolve().parents[2]
APP=ROOT/'app'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
manifest=json.loads((APP/'brand/assets.json').read_text(encoding='utf-8'))
previous=json.loads((APP/'brand/previous-assets.json').read_text(encoding='utf-8'))
assert sha(APP/'brand/logo-source.png')==manifest['sourceSha256']=='2089c4ae9ec8e8b51a6d3f0a61590d931079b26b4260e5bec2ad4de2ae75fd5c'
foreground=APP/'brand/launcher-foreground-source.png'
assert sha(foreground)==manifest['launcherForegroundSha256']=='43ee395589e1c604aeca28db19c9019f8c40be9d410fa8de37d539bd37e73661'
assert len(manifest['outputs'])==33 and set(manifest['outputs'])==set(previous['sha256'])
for name,item in manifest['outputs'].items():
 p=ROOT/name
 assert sha(p)==item['sha256'] and item['sha256']!=previous['sha256'][name],name
 with Image.open(p) as im:
  assert list(im.size)==item['size'],name
  assert im.convert('RGBA').getchannel('A').getbbox(),name
  if name.endswith('/ic_launcher_foreground.png'):
   with Image.open(foreground) as source:
    assert im.tobytes()==source.resize(im.size,Image.Resampling.LANCZOS).tobytes(),name
with Image.open(APP/'brand/logo-source.png') as source, Image.open(APP/'frontend/icons/logo-256.png') as logo:
 assert logo.tobytes()==source.resize(logo.size,Image.Resampling.LANCZOS).tobytes()
for name in ['logo-256.png','favicon-32.png','icon-192.png','icon-512.png']:
 with Image.open(APP/'frontend/icons'/name) as im:assert im.mode=='RGBA' and im.getpixel((0,0))[3]==0,name
for name in ['apple-touch-icon.png','maskable-512.png']:
 with Image.open(APP/'frontend/icons'/name) as im:assert im.convert('RGBA').getpixel((0,0))==(255,255,255,255) and im.getchannel('A').getextrema()==(255,255),name
for page in ['index.html','admin.html','privacy.html','terms.html']:
 text=(APP/'frontend'/page).read_text(encoding='utf-8')
 refs=re.findall(r'(?:src|href)="([^\"]*icons/[^\"]+\.png[^\"]*)"',text)
 assert refs and all(ref.endswith('?v=3') for ref in refs),(page,refs)
 assert 'icons/logo-256.png?v=3' in text and 'favicon-32.png?v=3' in text,page
 assert 'aria-hidden="true">JK</div>' not in text,page
webmanifest=json.loads((APP/'frontend/manifest.webmanifest').read_text(encoding='utf-8'))
assert webmanifest['id']=='/' and all(icon['src'].endswith('?v=3') for icon in webmanifest['icons'])
sw=(APP/'frontend/sw.js').read_text(encoding='utf-8');assert "'jk-v68'" in sw
assert "'/manifest.webmanifest?v=3'" in sw
res=ROOT/'android-client/android/app/src/main/res'
for name in ['ic_launcher.xml','ic_launcher_round.xml']:
 assert '@mipmap/ic_launcher_foreground' in (res/'mipmap-anydpi-v26'/name).read_text(encoding='utf-8')
assert '@mipmap/ic_launcher_foreground' in (res/'drawable-v24/ic_launcher_foreground.xml').read_text(encoding='utf-8')
assert '<vector' not in (res/'drawable-v24/ic_launcher_foreground.xml').read_text(encoding='utf-8')
assert 'windowSplashScreenAnimatedIcon' in (res/'values/styles.xml').read_text(encoding='utf-8')
print('brand-0234: original source, 33 replaced assets, cached URLs, web/admin/legal/PWA/Android coverage PASS')

