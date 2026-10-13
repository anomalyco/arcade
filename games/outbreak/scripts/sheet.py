"""Assemble the real Metal proof frames, without changing their appearance."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[3] / "captures" / "outbreak-m1"
frames = [
    ("01-dusk-street", "Dusk street · 18:00"),
    ("02-house-interior", "House · windows pass sight"),
    ("02-house-closed", "Closed door · room hidden"),
    ("03-door-reveal", "Open door · room revealed"),
    ("04-explored-shroud", "Turn away · explored shroud"),
    ("05-night-lamps", "Night · streetlamps"),
]
sheet = Image.new("RGB", (1160, 1260), "#10161c")
draw = ImageDraw.Draw(sheet)
for i, (file, title) in enumerate(frames):
    x, y = (i % 2) * 580, (i // 2) * 420
    shot = Image.open(root / f"{file}.png").convert("RGB")
    shot = shot.resize((580, 394), Image.Resampling.LANCZOS)
    sheet.paste(shot, (x, y + 26))
    draw.text((x + 12, y + 7), title, fill="#d7dedb")
sheet.save(root / "outbreak-m1-sheet.jpg", quality=92)
print(root / "outbreak-m1-sheet.jpg")
