"""Bounded proof contact sheet: python3 scripts/clutter-sheet.py INPUT_DIR OUTPUT.jpg."""
from pathlib import Path
import sys
from PIL import Image, ImageDraw, ImageFont

root, target = Path(sys.argv[1]), Path(sys.argv[2])
images = [
    ("scale.png", "Scale check beside the car"),
    ("city.png", "Seeded street furniture"),
    ("cones-30.png", "Cones & barriers"),
    ("furniture-30.png", "Bins, benches & papers"),
    ("hydrant-75.png", "Hydrant & puddle"),
    ("explosion-22.png", "Chain explosion"),
]
sheet = Image.new("RGB", (1440, 836), "#101521")
draw = ImageDraw.Draw(sheet)
font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 18)
for i, (name, label) in enumerate(images):
    image = Image.open(root / name).convert("RGB")
    image.thumbnail((720, 518) if i < 2 else (360, 259), Image.Resampling.LANCZOS)
    x, y = (i * 720, 0) if i < 2 else ((i - 2) * 360, 548)
    sheet.paste(image, (x, y + 29))
    draw.text((x + 12, y + 4), label, font=font, fill="#e1e5eb")
target.parent.mkdir(parents=True, exist_ok=True)
sheet.save(target, quality=90, optimize=True)
