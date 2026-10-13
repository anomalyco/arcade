"""Matched native-size crops; run after look-proof and motion-proof from the repository root."""
from pathlib import Path
from PIL import Image, ImageDraw
import argparse

parser = argparse.ArgumentParser()
parser.add_argument("--output", type=Path, default=Path("captures/blackout-motion"))
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)

sheet = Image.new("RGB", (1200, 736), "#101418")
draw = ImageDraw.Draw(sheet)
for row, (before, after) in enumerate([
    ("before/office-off", "after/office-lookShadowFilter"),
    ("before/office-all", "after/office-all"),
]):
    for column, name in enumerate([before, after]):
        image = Image.open(f"captures/blackout-shadow/{name}.png")
        crop = image.crop((670, 175, 1100, 425)).resize((600, 349))
        sheet.paste(crop, (column * 600, row * 368 + 19))
        draw.text((column * 600 + 8, row * 368 + 3),
                  f"{'Before' if column == 0 else 'After'} / {'baseline look' if row == 0 else 'look pass'}", fill="white")
sheet.save(args.output / "blackout-shadow-crops.jpg", quality=92)

sheet = Image.new("RGB", (1280, 920), "#101418")
draw = ImageDraw.Draw(sheet)
for row, (view, mode, x, y) in enumerate([
    ("office", "camera", 630, 390), ("office", "object", 960, 530), ("lot", "both", 850, 200),
]):
    for column, switch in enumerate(["off", "on"]):
        image = Image.open(f"captures/blackout-motion/{view}-{mode}-{switch}.png")
        sheet.paste(image.crop((x, y, x + 640, y + 284)), (column * 640, row * 305 + 20))
        draw.text((column * 640 + 8, row * 305 + 3), f"{view} / {mode} motion / {switch}", fill="white")
sheet.save(args.output / "blackout-motion-crops.jpg", quality=92)
