"""Build the bounded review sheet from look-proof.ts captures and supplied paint-overs."""
import argparse
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

parser = argparse.ArgumentParser()
parser.add_argument("--references", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
captures = Path(__file__).resolve().parents[3] / "captures/blackout-look"
rows = [
    [("Now · main", "office-main"), ("All Look on", "office-all")],
    [("Grade only", "office-lookGrade"), ("Practicals only", "office-lookPractical"), ("Wall faces only", "office-lookWalls")],
    [("Contact AO only", "office-lookAO"), ("Cap rims only", "office-lookCaps"), ("Floor pattern only", "office-lookFloors")],
    [("City depth only", "office-lookCity"), ("Tile gloss only", "office-lookGloss"), ("Long shadows only · opt-in", "office-lookShadows")],
    [("C · target", args.references / "office2-polish.png"), ("A · reference", args.references / "office2-concept.png")],
    [("Downtown · all Look on", "downtown-all"), ("Vehicle lot · all Look on", "lot-all")],
]
width, height, gap, label = 360, 225, 10, 17
sheet = Image.new("RGB", (3 * width + 4 * gap, len(rows) * (height + label + gap) + gap), "#10161a")
draw = ImageDraw.Draw(sheet)
font = ImageFont.load_default(size=12)
for row, cards in enumerate(rows):
    for col, (title, name) in enumerate(cards):
        image = Image.open(name if isinstance(name, Path) else captures / f"{name}.png").convert("RGB")
        image = image.resize((width, height), Image.Resampling.LANCZOS)
        x, y = gap + col * (width + gap), gap + row * (height + label + gap)
        draw.text((x, y), title, fill="#e4e9ed", font=font)
        sheet.paste(image, (x, y + label))
sheet.thumbnail((1500, 1500), Image.Resampling.LANCZOS)
args.output.parent.mkdir(parents=True, exist_ok=True)
sheet.save(args.output, quality=93)
print(args.output)
