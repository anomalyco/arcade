from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import sys

source = Path(__file__).resolve().parents[3] / 'captures/motion-blur'
sheet = Image.new('RGB', (1440, 856), '#10161a')
draw = ImageDraw.Draw(sheet)
font = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 16)
for i, (file, title) in enumerate([('before.png', 'Off'), ('after.png', 'On · strength 0.65 · shutter 0.5')]):
    image = Image.open(source / file).convert('RGB')
    # Same central crop makes the car, road markings and tyre trail readable at review size.
    x, y = i * 720, 0
    image = image.crop((420, 80, 2140, 2060 if image.height > 2060 else 1440))
    image.thumbnail((720, 822), Image.Resampling.LANCZOS)
    sheet.paste(image, (x, y + 32))
    draw.text((x + 8, y + 7), title, fill='#e4e9ed', font=font)
sheet = sheet.crop((0, 0, 1440, 32 + image.height))
target = Path(sys.argv[1]) if len(sys.argv) > 1 else source / 'sheet.jpg'
target.parent.mkdir(parents=True, exist_ok=True)
sheet.save(target, quality=94)
print(target)
