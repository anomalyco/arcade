"""Assemble the inspected Metal stills and concept crops (requires Pillow)."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageOps

root = Path(__file__).resolve().parents[3]
source = root / "captures/preview/lights"
sheet = Image.new("RGB", (1480, 1190), "#101620")
draw = ImageDraw.Draw(sheet)
font_path = "/System/Library/Fonts/Supplemental/Arial.ttf"
title = ImageFont.truetype(font_path, 24)
label = ImageFont.truetype(font_path, 18)
names = ["0 · Current", "1 · Recessed", "2 · Light bar", "3 · Cinematic"]
for n, name in enumerate(names):
    x = 16 + n * 366
    draw.text((x, 12), name, font=title, fill="#f1f4f7")
    for kind, y, crop, height, caption in [
        ("close", 72, (190, 180, 750, 560), 260, "Front"),
        ("rear", 375, (240, 180, 760, 490), 230, "Braking"),
        ("game", 648, None, 220, "Gameplay"),
    ]:
        draw.text((x, y - 27), caption, font=label, fill="#aab8c5")
        image = Image.open(source / f"{n}-{kind}.png").convert("RGB")
        if crop:
            image = image.crop(crop)
        sheet.paste(ImageOps.fit(image, (350, height)), (x, y))
for n, crop in [(1, (450, 315, 870, 510)), (2, (605, 260, 1015, 450))]:
    x = 16 + (n - 1) * 732
    draw.text((x, 896), f"Concept {n}", font=label, fill="#aab8c5")
    image = Image.open(root / f"games/getaway/concept/dir-d-lowpoly-{n}.png")
    image.thumbnail((1400, 1400))
    image = image.crop(crop).convert("RGB")
    sheet.paste(ImageOps.fit(image, (716, 250)), (x, 926))
sheet.save(root / "captures/preview/getaway-car-lights.jpg", quality=92)
