"""Build the web and Android assets from the supplied logo and launcher foreground."""
import hashlib
import json
from pathlib import Path

from PIL import Image, ImageDraw

BRAND = Path(__file__).resolve().parent
APP = BRAND.parent
ROOT = APP.parent
SOURCE = BRAND / "logo-source.png"
FOREGROUND = BRAND / "launcher-foreground-source.png"
ICONS = APP / "frontend/icons"
RES = ROOT / "android-client/android/app/src/main/res"
DENSITIES = {
    "mdpi": (48, 108), "hdpi": (72, 162), "xhdpi": (96, 216),
    "xxhdpi": (144, 324), "xxxhdpi": (192, 432),
}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def resize(image, size):
    return image.resize((size, size), Image.Resampling.LANCZOS)


def centered_crop(image, fraction):
    side = round(image.width * fraction)
    margin = (image.width - side) // 2
    return image.crop((margin, margin, margin + side, margin + side))


def white_tile(mark, size, rounding=None):
    tile = Image.new("RGBA", (size, size), "white")
    tile.alpha_composite(resize(mark, size))
    if rounding is not None:
        side = size * 4
        mask = Image.new("L", (side, side), 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            (0, 0, side - 1, side - 1), radius=side * rounding, fill=255
        )
        tile.putalpha(resize(mask, size))
    return tile


def main():
    with Image.open(SOURCE) as supplied:
        source = supplied.convert("RGBA")
    with Image.open(FOREGROUND) as supplied:
        foreground = supplied.convert("RGBA")
    for mark in (source, foreground):
        assert mark.width == mark.height and mark.getpixel((0, 0))[3] == 0
        assert mark.getchannel("A").getbbox()

    outputs = {}

    def save(image, target):
        image.save(target, format="PNG", optimize=True)
        outputs[target.relative_to(ROOT).as_posix()] = {
            "sha256": sha(target), "size": list(image.size),
        }

    # Resize the entire canvas to retain the owner's optical alignment.
    save(source, ICONS / "logo-master.png")
    for name, size in (("favicon-32.png", 32), ("logo-256.png", 256),
                       ("icon-192.png", 192), ("icon-512.png", 512)):
        save(resize(source, size), ICONS / name)
    save(white_tile(source, 180), ICONS / "apple-touch-icon.png")
    save(white_tile(centered_crop(foreground, 0.8), 512), ICONS / "maskable-512.png")

    legacy_mark = centered_crop(foreground, 66 / 108)
    for density, (legacy, adaptive) in DENSITIES.items():
        mipmap = RES / ("mipmap-" + density)
        save(white_tile(legacy_mark, legacy, 0.22), mipmap / "ic_launcher.png")
        save(white_tile(legacy_mark, legacy, 0.5), mipmap / "ic_launcher_round.png")
        save(resize(foreground, adaptive), mipmap / "ic_launcher_foreground.png")

    previous = json.loads((BRAND / "previous-assets.json").read_text(encoding="utf-8"))
    for name, size in previous["splashSizes"].items():
        canvas = Image.new("RGBA", tuple(size), "white")
        mark_size = round(min(size) * 0.37)
        canvas.alpha_composite(
            resize(source, mark_size),
            ((size[0] - mark_size) // 2, (size[1] - mark_size) // 2),
        )
        save(canvas, ROOT / name)

    assert set(outputs) == set(previous["sha256"])
    assert all(row["sha256"] != previous["sha256"][name] for name, row in outputs.items())
    manifest = {
        "sourceSha256": sha(SOURCE), "sourceSize": list(source.size),
        "launcherForegroundSha256": sha(FOREGROUND), "outputs": outputs,
    }
    (BRAND / "assets.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"assetsReplaced": len(outputs), "sourceSha256": sha(SOURCE),
                      "launcherForegroundSha256": sha(FOREGROUND)}))


if __name__ == "__main__":
    main()
