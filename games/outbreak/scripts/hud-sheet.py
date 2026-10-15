"""Side-by-side sheets of real hud-proof crops: callout placements, and stamina ring states."""
from pathlib import Path
import os
from PIL import Image, ImageDraw

root = Path(os.environ.get("HUD_OUT", Path(__file__).resolve().parents[3] / "captures/outbreak-hud"))
rows = [("noir", "street"), ("sodium_70s", "street"), ("noir", "interior"), ("sodium_70s", "interior")]
look_label = {"noir": "Noir", "sodium_70s": "70s sodium"}
W, H, HEAD, LEFT = 420, 280, 26, 120


def sheet(columns, name_of, title, out):
    image = Image.new("RGB", (LEFT + W * len(columns), HEAD + (H + 6) * len(rows)), "#151c20")
    draw = ImageDraw.Draw(image)
    for col, (_, label) in enumerate(columns):
        draw.text((LEFT + col * W + 8, 7), label, fill="#d4ddd8")
    draw.text((8, 7), title, fill="#8c9890")
    for row, (look, place) in enumerate(rows):
        y = HEAD + row * (H + 6)
        draw.text((8, y + H // 2 - 12), f"{look_label[look]}\n{place}", fill="#d4ddd8")
        for col, (key, _) in enumerate(columns):
            crop = Image.open(root / f"{name_of(key, look, place)}-crop.png").convert("RGB")
            image.paste(crop.resize((W, H), Image.Resampling.LANCZOS), (LEFT + col * W, y))
    image.save(root / out, quality=92)


sheet(
    [("below", "BELOW (default)"), ("above", "ABOVE (previous)"), ("beside", "BESIDE")],
    lambda key, look, place: f"place-{key}-{look}-{place}",
    "Callout placement",
    "placement-sheet.jpg",
)
sheet(
    [("full", "FULL: hidden"), ("draining", "SPRINTING"), ("low", "LOW: amber"), ("exhausted", "EXHAUSTED: red")],
    lambda key, look, place: f"stamina-{key}-{look}-{place}",
    "Stamina ring",
    "stamina-sheet.jpg",
)
style_rows = [("noir", "street"), ("sodium_70s", "street")]
styles = [("today", "TODAY"), ("below", "BELOW FEET (default)"), ("hades", "HADES STYLE"), ("zomboid", "ZOMBOID STYLE"), ("diegetic", "DIEGETIC")]
image = Image.new("RGB", (LEFT + W * len(styles), HEAD + (H + 6) * len(style_rows)), "#151c20")
draw = ImageDraw.Draw(image)
draw.text((8, 7), "HUD style", fill="#8c9890")
for col, (_, label) in enumerate(styles):
    draw.text((LEFT + col * W + 8, 7), label, fill="#d4ddd8")
for row, (look, place) in enumerate(style_rows):
    y = HEAD + row * (H + 6)
    draw.text((8, y + H // 2 - 12), f"{look_label[look]}\n{place}", fill="#d4ddd8")
    for col, (key, _) in enumerate(styles):
        crop = Image.open(root / f"style-{key}-{look}-crop.png").convert("RGB")
        image.paste(crop.resize((W, H), Image.Resampling.LANCZOS), (LEFT + col * W, y))
image.save(root / "style-sheet.jpg", quality=92)
print(root / "placement-sheet.jpg", root / "stamina-sheet.jpg", root / "style-sheet.jpg")
