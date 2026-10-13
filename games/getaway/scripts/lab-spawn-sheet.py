"""Contact sheet for the real-input Metal Spawn proof."""
from pathlib import Path
import sys
from PIL import Image, ImageDraw, ImageFont

source = Path(__file__).resolve().parents[3] / 'captures/lab-spawn'
tiles = [('getaway-before.png', 'Car · cones and propane'), ('getaway-eruption.png', 'Impact · explosion and debris'),
         ('getaway-physics.png', 'Physics · colliders and sleep state'), ('blackout-soldier.png', 'Soldier · walk and sprint')]
sheet = Image.new('RGB', (1440, 1044), '#10161a')
draw = ImageDraw.Draw(sheet)
font = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 15)
for i, (name, title) in enumerate(tiles):
    x, y = i % 2 * 720, i // 2 * 522
    sheet.paste(Image.open(source / name).convert('RGB').resize((720, 498), Image.Resampling.LANCZOS), (x, y + 24))
    draw.text((x + 8, y + 3), title, fill='#e4e9ed', font=font)
target = Path(sys.argv[1]) if len(sys.argv) > 1 else source / 'sheet.jpg'
target.parent.mkdir(parents=True, exist_ok=True)
sheet.save(target, quality=92)
print(target)
