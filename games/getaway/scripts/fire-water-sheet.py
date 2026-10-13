"""Matched full-frame views: six columns, six environment/effect rows."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import sys

source = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("captures/fire-water")
target = Path(sys.argv[2]) if len(sys.argv) > 2 else source / "sheet.jpg"
font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 15)
small = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 13)
width, tile, photo, gap = 1440, 232, 167, 8
sheet = Image.new("RGB", (width, 1280), "#101519")
draw = ImageDraw.Draw(sheet)
for i, title in enumerate(["Current · gameplay", "Flowing · gameplay", "Graphic · gameplay", "Current · close", "Flowing · close", "Graphic · close"]):
    draw.text((i * (tile + gap) + 4, 10), title, font=font, fill="#f0f2f4")
for row, (environment, effect) in enumerate((env, fx) for env in ["downtown", "office", "alley"] for fx in ["fire", "water"]):
    y = 40 + row * 205
    draw.text((4, y), f'{ {"downtown":"Downtown night", "office":"Office", "alley":"Getaway alley"}[environment]} · {effect}', font=small, fill="#c4cbd1")
    for col, (zoom, style) in enumerate((zoom, style) for zoom in [1, 2.3] for style in [0, 1, 2]):
        image = Image.open(source / f"{environment}-{effect}-{zoom}-{style}.png").convert("RGB")
        image = image.resize((tile, photo), Image.Resampling.LANCZOS)
        sheet.paste(image, (col * (tile + gap), y + 23))
target.parent.mkdir(parents=True, exist_ok=True)
sheet.save(target, quality=93)
print(target)
