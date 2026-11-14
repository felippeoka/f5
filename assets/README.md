# Icon assets

The preserved source is assets/icon.png. On macOS, regenerate with Python 3,
Pillow 11.3.0, and Apple's iconutil:

    python3 -m venv /tmp/f5-brand-tools
    /tmp/f5-brand-tools/bin/pip install Pillow==11.3.0
    /tmp/f5-brand-tools/bin/python scripts/generate-brand-assets.py

The recipe uses RGBA and Lanczos resizing, preserving the source canvas and alpha.
Production remains unbadged. Development adds a blue circular indicator with a
white outline. The 1024px platform sources retain the full square canvas; macOS
packaging derives ICNS entries from the production macOS source.
Windows ICOs contain 16, 32, 48, 64, 128 and 256px entries. Web favicons contain
16, 32 and 48px entries, alongside 16/32px PNGs, a 180px touch icon and a 512px
sidebar image. Desktop development resources contain 512px PNG, ICO and ICNS.

scripts/lib/brand-assets.ts selects production assets for publishing and
development assets for local builds. The marketing site has separate assets.
