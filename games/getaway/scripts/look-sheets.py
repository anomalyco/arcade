from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parents[3]
shots = root / "captures/getaway-look"
font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 17)

def panel(canvas, path, label, x, y, width=500, height=312):
    image = Image.open(path).convert("RGB")
    image.thumbnail((width, height), Image.Resampling.LANCZOS)
    canvas.paste(image, (x + (width - image.width) // 2, y + 28 + (height - image.height) // 2))
    ImageDraw.Draw(canvas).text((x + 10, y + 5), label, fill="#e1e6ee", font=font)

sheet = Image.new("RGB", (1500, 1020), "#0c1019")
panels = [
    ("main-route-011.png", "Main · seed 7 · frame 12"),
    ("all-on-12.png", "All six Look switches on"),
    ("tightPools-12.png", "Tighter lamp pools only"),
    ("flatGround-12.png", "Flatter ground only"),
    ("shopSpill-12.png", "Shop-window spill only"),
    ("grounding-12.png", "Grounding only"),
    ("wallGradients-12.png", "Wall & roof gradients only"),
    ("colourGrade-12.png", "Colour grade only"),
]
for i, (name, title) in enumerate(panels):
    panel(sheet, shots / name, title, (i % 3) * 500, (i // 3) * 340)
draw = ImageDraw.Draw(sheet)
draw.text((1010, 685), "Car contact · off / on", fill="#e1e6ee", font=font)
for i, name in enumerate(["off-12.png", "grounding-12.png"]):
    image = Image.open(shots / name).crop((427, 266, 524, 343))
    image = image.resize((250, 198), Image.Resampling.LANCZOS)
    sheet.paste(image, (1000 + i * 250, 737))
sheet.save(shots / "getaway-look-sheet.jpg", quality=94)

comparison = Image.new("RGB", (1400, 990), "#0c1019")
for row, frame in enumerate(["12", "60"]):
    panel(comparison, root / f"games/getaway/concept/dir-d-lowpoly-{row + 1}.png", f"Concept {row + 1}", 0, row * 495, 700, 467)
    panel(comparison, shots / ("all-on-12.png" if frame == "12" else "all-on.png"), f"Look pass · frame {frame}", 700, row * 495, 700, 467)
comparison.save(shots / "getaway-look-vs-concept.jpg", quality=94)
