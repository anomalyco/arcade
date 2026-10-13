"""Matched captures from prove-splatter.ts; output is already bounded to 1280 px."""
from pathlib import Path
import sys
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parents[3]
source = root / "captures/splatter"
output = Path(sys.argv[1]) if len(sys.argv) > 1 else source / "sheet.jpg"
font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 13)
sheet = Image.new("RGB", (1280, 1260), "#14171d")
draw = ImageDraw.Draw(sheet)
rows = [("office", "floor", "Pale tile"), ("office", "wall", "Wall"), ("office", "desk", "Desk"), ("downtown", "floor", "Dark street")]
for row, (room, target, label) in enumerate(rows):
    for col, (zoom, style) in enumerate([(1, 0), (1, 1), (2.5, 0), (2.5, 1)]):
        image = Image.open(source / f"{room}-{target}-{zoom}-{style}.png").convert("RGB")
        sheet.paste(image.resize((320, 230), Image.Resampling.LANCZOS), (col * 320, row * 252 + 22))
        draw.text((col * 320 + 6, row * 252 + 4), f"{label} · {'Current' if style == 0 else 'Splatter'} · {'game' if zoom == 1 else 'close'}", fill="#edf0f4", font=font)
for col, (room, style) in enumerate([("office", 0), ("office", 1), ("downtown", 0), ("downtown", 1)]):
    image = Image.open(source / f"production-{room}-{style}.png").convert("RGB")
    sheet.paste(image.resize((320, 230), Image.Resampling.LANCZOS), (col * 320, 1030))
    draw.text((col * 320 + 6, 1012), f"Blackout {room} · {'Current' if style == 0 else 'Splatter'}", fill="#edf0f4", font=font)
output.parent.mkdir(parents=True, exist_ok=True)
sheet.save(output, quality=94)
print(output)
