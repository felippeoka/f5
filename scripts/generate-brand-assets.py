"""Regenerate bitmap assets with Python 3, Pillow 11.3.0 and macOS iconutil."""
from pathlib import Path
import shutil
import subprocess
import tempfile
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent


def resize(image, size):
    return image.resize((size, size), Image.Resampling.LANCZOS)


def generate():
    production = resize(Image.open(ROOT / "assets/icon.png").convert("RGBA"), 1024)
    development = production.copy()
    ImageDraw.Draw(development).ellipse((728, 728, 992, 992), fill="#2388ff", outline="white", width=16)
    for mode, image, prefix, web in [
        ("prod", production, "black", "t3-black"),
        ("dev", development, "blueprint", "blueprint"),
    ]:
        directory = ROOT / "assets" / mode
        for platform in ["ios", "macos", "universal"]:
            image.save(directory / f"{prefix}-{platform}-1024.png")
        for size in [16, 32]:
            resize(image, size).save(directory / f"{web}-web-favicon-{size}x{size}.png")
        resize(image, 180).save(directory / f"{web}-web-apple-touch-180.png")
        image.save(directory / f"{web}-web-favicon.ico", sizes=[(n, n) for n in [16, 32, 48]])
        windows = "t3-black" if mode == "prod" else prefix
        image.save(directory / f"{windows}-windows.ico", sizes=[(n, n) for n in [16, 32, 48, 64, 128, 256]])
    public = ROOT / "apps/web/public"
    for source, target in [
        ("t3-black-web-favicon.ico", "favicon.ico"),
        ("t3-black-web-favicon-16x16.png", "favicon-16x16.png"),
        ("t3-black-web-favicon-32x32.png", "favicon-32x32.png"),
        ("t3-black-web-apple-touch-180.png", "apple-touch-icon.png"),
    ]:
        shutil.copyfile(ROOT / "assets/prod" / source, public / target)
    resize(production, 512).save(public / "icon.png")
    resources = ROOT / "apps/desktop/resources"
    resize(development, 512).save(resources / "icon.png")
    shutil.copyfile(ROOT / "assets/dev/blueprint-windows.ico", resources / "icon.ico")
    with tempfile.TemporaryDirectory(prefix="f5-icons-") as temporary:
        iconset = Path(temporary) / "icon.iconset"
        iconset.mkdir()
        for size in [16, 32, 128, 256, 512]:
            resize(development, size).save(iconset / f"icon_{size}x{size}.png")
            resize(development, size * 2).save(iconset / f"icon_{size}x{size}@2x.png")
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(resources / "icon.icns")], check=True)


if __name__ == "__main__":
    generate()
