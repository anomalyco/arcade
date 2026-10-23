"""Compose the two requested review stills; run on the capture worker through HiveMind."""
from pathlib import Path
import json
from PIL import Image, ImageChops, ImageDraw, ImageFont

root = Path('captures/weather-rain-look')
font = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 30)
small = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 24)
parity = {}
for subject, title, crop in (
    ('lamp', 'Lamp rain', (940, 420, 1300, 660)),
    ('torch', 'Carried torch', (690, 370, 1230, 730)),
):
    images = [Image.open(root / f'{candidate}-{subject}.png').convert('RGB') for candidate in ('today', 'candidate')]
    baseline = Image.open(root / 'baseline' / f'today-{subject}.png').convert('RGB')
    diff = ImageChops.difference(baseline, images[0])
    parity[subject] = {'identical': diff.getbbox() is None, 'maxChannelDifference': max(hi for lo, hi in diff.getextrema())}
    canvas = Image.new('RGB', (2560, 1340), '#0c0e10')
    draw = ImageDraw.Draw(canvas)
    for i, (name, image) in enumerate(zip(('Today', 'Candidate'), images)):
        x = i * 1280
        draw.text((x + 24, 18), f'{title} | {name}', font=font, fill='white')
        canvas.paste(image.resize((1280, 720), Image.Resampling.LANCZOS), (x, 66))
        draw.text((x + 24, 806), 'Detail · same crop and exposure', font=small, fill='#bdc6d1')
        detail = image.crop(crop).resize((720, 480), Image.Resampling.LANCZOS)
        canvas.paste(detail, (x + 280, 850))
    canvas.save(root / f'{subject}-comparison.png')
(root / 'parity.json').write_text(json.dumps(parity, indent=2))
print(json.dumps(parity, indent=2))
assert all(v['identical'] for v in parity.values()), 'Today differs from the shipped renderer'
