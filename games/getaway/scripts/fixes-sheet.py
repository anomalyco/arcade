"""Compose the matched Metal stills from prove-fixes.ts. Requires Pillow."""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

source, output = map(Path, sys.argv[1:3])
sheet = Image.new("RGB", (1440, 1476), "#111522")
draw = ImageDraw.Draw(sheet)
font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 19)
draw.text((16, 8), "Before", font=font, fill="white")
draw.text((736, 8), "After", font=font, fill="white")
y = 40
for name, title, crop, height in [
    ("spotlight", "Spotlight pool", (0, 150, 960, 630), 360),
    ("ground", "Grounded contact shadow", (120, 220, 840, 500), 280),
    ("jump", "Ramp jump · 3.26 m", (120, 160, 840, 440), 280),
    ("chase", "Four-cop chase", (0, 160, 960, 720), 420),
]:
    draw.text((16, y), title, font=font, fill="#c3cad7")
    y += 24
    for i, label in enumerate(["before", "after"]):
        image = Image.open(source / f"{label}-{name}.png").convert("RGB").crop(crop)
        sheet.paste(image.resize((720, height), Image.Resampling.LANCZOS), (i * 720, y))
    y += height
output.parent.mkdir(parents=True, exist_ok=True)
sheet.save(output, quality=91)
