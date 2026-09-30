"""Derive the guide's image assets from the brand character sheet.

Source of truth: design/guide-character-source.png (the 2D character sheet the
brand supplied). Regenerate with:

    python3 design/derive-guide-images.py

Both outputs are square head-and-shoulder crops taken from the same head so the
mark, the welcome portrait, and the turn avatar stay the same person. They are
upscaled 2x with LANCZOS because the art is smooth vector-like shading, which
keeps the mark crisp on 2x and 3x displays.
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "design" / "guide-character-source.png"
PUBLIC = ROOT / "public"

# (output, crop box in source pixels, output size)
DERIVATIVES = [
    ("guide-mark.png", (630, 125, 795, 290), 330),
    ("guide-portrait.png", (606, 104, 806, 304), 400),
]


def main() -> None:
    sheet = Image.open(SOURCE).convert("RGB")
    for name, box, size in DERIVATIVES:
        crop = sheet.crop(box).resize((size, size), Image.LANCZOS)
        crop.save(PUBLIC / name, optimize=True)
        print(f"{name}: {box} -> {size}x{size}")


if __name__ == "__main__":
    main()
