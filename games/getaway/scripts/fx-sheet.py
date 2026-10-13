"""Assemble the inspected Metal stills; fail if the tyre port changed a pixel."""
from pathlib import Path
import json
import sys
from PIL import Image, ImageChops, ImageDraw, ImageFont

root = Path(__file__).resolve().parents[3]
source = root / 'captures/fx-kit'
before = Image.open(source / 'getaway-before.png').convert('RGB')
after = Image.open(source / 'getaway-after.png').convert('RGB')
assert ImageChops.difference(before, after).getbbox() is None, 'Tyre smoke pixel mismatch'
rows = [
    [('blackout-old.png', 'Blackout · legacy'), ('blackout-new.png', 'Blackout · wall-clipped volume')],
    [('playground-smoke-0.png', 'Grenade smoke'), ('playground-water-0.png', 'Hydrant water'), ('playground-sparks-0.png', 'Bouncing sparks')],
    [('playground-smoke-1.png', 'Density'), ('playground-smoke-2.png', 'Optical depth')],
    [('getaway-before.png', 'Getaway · before'), ('getaway-after.png', 'Getaway · shared path (pixel-identical)')],
]
width = 1120
heights = [int(width / len(row) * 2 / 3) + 24 for row in rows]
sheet = Image.new('RGB', (width, sum(heights)), '#0b1119')
draw = ImageDraw.Draw(sheet)
font = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 15)
y = 0
for row, height in zip(rows, heights):
    tile = width // len(row)
    for i, (name, label) in enumerate(row):
        image = Image.open(source / name).convert('RGB').resize((tile, height - 24), Image.Resampling.LANCZOS)
        sheet.paste(image, (tile * i, y + 24))
        draw.text((tile * i + 8, y + 4), label, fill='#dce5ef', font=font)
    y += height
assert max(sheet.size) <= 1500
target = Path(sys.argv[1]) if len(sys.argv) > 1 else source / 'sheet.jpg'
target.parent.mkdir(parents=True, exist_ok=True)
sheet.save(target, quality=92)
proof = json.loads((source / 'proof.json').read_text())
proof.pop('floors', None)
proof['tyrePixelDifference'] = 0
proof['method'] = 'Blackout total GPU interval: first polar compute start (main start when no compute) through dependent load/store of equal-format offscreen composite target. One warmup pair; nine alternating pairs of eight frozen frames. Old sprites suppressed on both sides; only volume renderer toggled. No pass sums.'
(root / 'perf/fx-kit.json').write_text(json.dumps(proof, indent=2) + '\n')
print(target, sheet.size)
