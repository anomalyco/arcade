"""Assemble the current Lab proof without modifying the earlier FX benchmark evidence."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

source = Path(__file__).resolve().parents[3] / 'captures/fx-kit'
tiles = [
    ('playground-smoke-0.png', 'Effects'),
    ('lab-lighting.png', 'Lighting'),
    ('lab-lighting-5.png', 'Surface normals'),
    ('lab-physics-adapter.png', 'Physics adapter proof'),
]
sheet = Image.new('RGB', (1440, 1008), '#10161a')
draw = ImageDraw.Draw(sheet)
font = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 15)
for i, (name, title) in enumerate(tiles):
    x, y = i % 2 * 720, i // 2 * 504
    sheet.paste(Image.open(source / name).convert('RGB').resize((720, 480), Image.Resampling.LANCZOS), (x, y + 24))
    draw.text((x + 8, y + 3), title, fill='#e4e9ed', font=font)
sheet.save(source / 'lab-sheet.jpg', quality=92)
print(source / 'lab-sheet.jpg')
