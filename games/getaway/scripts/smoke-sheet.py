"""Assemble the real Metal captures; no paint-over or generated smoke."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parents[3]
out = root / "captures/getaway-smoke"
font = "/System/Library/Fonts/Helvetica.ttc"
title = ImageFont.truetype(font, 28)
label = ImageFont.truetype(font, 18)
small = ImageFont.truetype(font, 16)
sheet = Image.new("RGB", (1440, 1450), "#10151e")
d = ImageDraw.Draw(sheet)
d.text((16, 16), "Getaway · Boost smoke", font=title, fill="#f1f4f7")
d.text((16, 59), "Same seeded launch and turn · real in-engine Metal renders", font=label, fill="#abb8ca")
concept = Image.open(root / "games/getaway/concept/dir-d-lowpoly-1.png")
concept.thumbnail((1200, 1200))
crop = concept.crop((390, 315, 625, 490)).resize((168, 125), Image.Resampling.LANCZOS)
sheet.paste(crop, (1248, 8))
d.text((1050, 16), "Concept reference", font=small, fill="#abb8ca")
for col, text in enumerate(["Launch · 0.6 s", "Turning boost · 2.1 s", "Streetlamps · 3.1 s"]):
    d.text((16 + col * 476, 140), text, font=label, fill="#abb8ca")
names = ["0 · Current / reference", "1 · Faceted puffs", "2 · Soft volume", "3 · Cel smoke", "4 · Flame & wisps", "5 · Ribbon trails"]
for style, name in enumerate(names):
    y = 170 + style * 211
    d.text((16, y), name, font=label, fill="#f1f4f7")
    for col, frame in enumerate([18, 64, 92]):
        image = Image.open(out / f"style-{style}-{frame}.png")
        image = image.crop((0, 250, 960, 632)).resize((464, 185), Image.Resampling.LANCZOS)
        sheet.paste(image, (16 + col * 476, y + 23))
sheet.save(out / "getaway-smoke-styles.jpg", quality=94)
crop.save(out / "concept-smoke-crop.jpg", quality=94)
