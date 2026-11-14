"""Generate Android launcher densities from the owner's existing leaf artwork."""
from pathlib import Path
import json
import hashlib
from PIL import Image, ImageChops, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'app/frontend/icons/logo-master.png'
RES = ROOT / 'android-client/android/app/src/main/res'
DENSITIES = {'mdpi': (48,108), 'hdpi':(72,162), 'xhdpi':(96,216), 'xxhdpi':(144,324), 'xxxhdpi':(192,432)}


def main():
    image = Image.open(SOURCE).convert('RGBA')
    rgb = Image.new('RGB', image.size, 'white')
    rgb.paste(image, mask=image.getchannel('A'))
    box = ImageChops.difference(rgb, Image.new('RGB', rgb.size, 'white')).getbbox()
    assert box is not None
    logo = image.crop(box)
    outputs = {}
    preview = Image.new('RGB', (384,192), '#f1f5f9')
    for density, (legacy_size, adaptive_size) in DENSITIES.items():
        folder = RES / ('mipmap-' + density)
        folder.mkdir(exist_ok=True)
        for name, size, coverage in [('ic_launcher.png',legacy_size,.78), ('ic_launcher_round.png',legacy_size,.78), ('ic_launcher_foreground.png',adaptive_size,.59)]:
            canvas = Image.new('RGBA',(size,size),(255,255,255,0))
            if 'foreground' not in name:
                mask=Image.new('L',(size*4,size*4),0)
                draw=ImageDraw.Draw(mask)
                draw.rounded_rectangle((0,0,size*4-1,size*4-1),radius=size*4*(.5 if 'round' in name else .22),fill=255)
                mask=mask.resize((size,size),Image.Resampling.LANCZOS)
                canvas=Image.new('RGBA',(size,size),'white')
                canvas.putalpha(mask)
            mark = logo.copy()
            mark.thumbnail((int(size*coverage),int(size*coverage)),Image.Resampling.LANCZOS)
            canvas.alpha_composite(mark,((size-mark.width)//2,(size-mark.height)//2))
            if 'foreground' not in name:
                canvas.putalpha(ImageChops.multiply(canvas.getchannel('A'),mask))
            target = folder / name
            if target.exists():target.read_bytes()
            canvas.save(target)
            outputs[str(target.relative_to(ROOT))] = hashlib.sha256(target.read_bytes()).hexdigest()
            if density=='xxxhdpi' and name=='ic_launcher.png':preview.paste(canvas.convert('RGB'),(0,0))
            if density=='xxxhdpi' and name=='ic_launcher_foreground.png':
                small=canvas.resize((192,192),Image.Resampling.LANCZOS);preview.paste(small,(192,0),small)
    out = ROOT / 'review/final-evidence-0218'
    preview.save(out / 'launcher-icons-preview.png')
    (out / 'launcher-icon-manifest.json').write_text(json.dumps({'source_sha256':hashlib.sha256(SOURCE.read_bytes()).hexdigest(),'derived_existing_brand_not_new_logo':True,'outputs':outputs},indent=2))
    print(json.dumps({'density_files':len(outputs),'source':'existing JagaKebond leaf logo','foreground_safe_zone_coverage':.59}))


if __name__ == '__main__':
    main()
