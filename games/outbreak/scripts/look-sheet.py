"""Real fixed-camera frames beside generated targets; targets are references, not game output."""
from pathlib import Path
import os
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[3] / "captures/outbreak-look"
targets = Path(os.environ.get("OUTBREAK_TARGETS", str(root / "targets")))
rows = [("street", "Dusk street"), ("open", "Open bedroom door"), ("yard", "Night yard")]
sheet = Image.new("RGB", (1260, 936), "#151c20")
draw = ImageDraw.Draw(sheet)
for row, (name, title) in enumerate(rows):
    sources = [root / "before" / f"{name}.png", targets / f"target-{name}.png", root / "after" / f"{name}.png"]
    for col, (source, label) in enumerate(zip(sources, ["BEFORE", "PAINTOVER TARGET", "ACTUAL AFTER"])):
        x, y = col * 420, row * 312
        draw.text((x + 8, y + 7), f"{label} / {title}", fill="#d4ddd8")
        image = Image.open(source).convert("RGB").resize((420, 286), Image.Resampling.LANCZOS)
        sheet.paste(image, (x, y + 26))
sheet.save(targets / "comparison.jpg", quality=94)
pair = Image.new("RGB", (1260, 455), "#151c20")
draw = ImageDraw.Draw(pair)
for i, phase in enumerate(["before", "after"]):
    draw.text((i * 630 + 10, 8), f"Closed door / {phase.upper()}", fill="#d4ddd8")
    pair.paste(Image.open(root / phase / "closed.png").convert("RGB").resize((630, 429), Image.Resampling.LANCZOS), (i * 630, 26))
pair.save(targets / "closed-comparison.jpg", quality=94)
