"""Assemble the headless old/new pose strips; keep every dimension <= 1500px."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import sys

root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[3] / "captures" / "blackout-anim"
sheet = Image.new("RGB", (1080, 1480), "#10161a")
draw = ImageDraw.Draw(sheet)
font = ImageFont.load_default(size=15)
draw.text((12, 12), "BLACKOUT / Old above new / fixed 60 Hz / Metal", font=font, fill="#d5dce5")
labels = ["Walk", "Run", "Strafe left", "Strafe right", "Backpedal", "Turn in place", "Hard stop", "Recoil", "Death / before", "Death / +0.05 s", "Death / +0.35 s", "Death / +0.80 s"]
for index in range(12):
    x, y = (index % 3) * 360, 40 + (index // 3) * 360
    for row, mode in enumerate(["old", "new"]):
        image = Image.open(root / f"close-{mode}" / f"still-{index}.png").convert("RGB")
        image.thumbnail((360, 180), Image.Resampling.LANCZOS)
        sheet.paste(image, (x, y + row * 180))
        draw.rectangle((x, y + row * 180, x + 360, y + row * 180 + 22), fill="#10161a")
        draw.text((x + 8, y + row * 180 + 3), f"{mode.title()} / {labels[index]}", font=font, fill="#d5dce5")
sheet.save(root / "blackout-anim-sheet.jpg", quality=94)
