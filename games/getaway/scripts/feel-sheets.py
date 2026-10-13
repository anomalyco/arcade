"""Compose the bounded headless proof stills; run after prove-feel.ts."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parents[3] / "captures"
source = root / "getaway-feel"
dest = root / "preview"
dest.mkdir(parents=True, exist_ok=True)
font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 18)

def sheet(name, rows):
    canvas = Image.new("RGB", (1440, 1422), "#10141d")
    draw = ImageDraw.Draw(canvas)
    for row, cells in enumerate(rows):
        for col, (filename, label, crop) in enumerate(cells):
            image = Image.open(source / filename).convert("RGB")
            if crop:
                image = image.crop(crop)
            image = image.resize((720, 450), Image.Resampling.LANCZOS)
            x, y = col * 720, row * 474
            draw.text((x + 10, y + 3), label, font=font, fill="#edf0f5")
            canvas.paste(image, (x, y + 24))
    canvas.save(dest / name, quality=91)

sheet("getaway-jumps-sheet.jpg", [
    [("jump-before-015.png", "BEFORE · approach", None), ("jump-after-015.png", "AFTER · seeded construction ramp", None)],
    [("jump-before-039.png", "BEFORE · grounded", None), ("jump-after-039.png", "AFTER · 3.3 m airborne", None)],
    [("jump-before-060.png", "BEFORE · continuing", None), ("jump-after-060.png", "AFTER · landed", None)],
])
sheet("getaway-fixes-sheet.jpg", [
    [("smoke-before-030.png", "BEFORE · tire smoke", (220, 250, 700, 550)), ("smoke-after-030.png", "AFTER · soft, lit smoke", (220, 250, 700, 550))],
    [("launch-before-015.png", "BEFORE · nitro launch", (260, 225, 740, 525)), ("launch-after-015.png", "AFTER · rear-wheel skid burst", (260, 225, 740, 525))],
    [("startup-after-000.png", "AFTER · startup, effects on, 0 s", None), ("startup-after-090.png", "AFTER · 3 s · glow fade not reproduced", None)],
])
