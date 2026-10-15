"""Before/after sheet of the HUD polish crops at native pixels (no resampling, so sharpness is judged as captured).

python3 scripts/hud-polish-sheet.py <before-dir> <after-dir> <out.png> [name ...]
Either dir may be "-" to make a single-column sheet.
"""
import json
import sys
from pathlib import Path
from PIL import Image, ImageDraw

before, after, out = sys.argv[1], sys.argv[2], Path(sys.argv[3])
names = sys.argv[4:]
cols = [Path(d) for d in (before, after) if d != "-"]


def crops(d: Path):
    data = json.loads((d / "index.json").read_text())
    return {f"{s['name']}@{s['dpr']}x": s for s in data["shots"] if s.get("crop")}


sets = [crops(d) for d in cols]
keys = names or [k for k in sets[-1] if all(k in s for s in sets)]
rows = []
for k in keys:
    imgs = []
    for d, s in zip(cols, sets):
        shot = s.get(k)
        imgs.append(Image.open(d / Path(shot["crop"]).name).convert("RGB") if shot else None)
    rows.append((k, imgs))

gap, head = 16, 28
col_w = [max((r[1][i].width if r[1][i] else 0) for r in rows) for i in range(len(cols))]
height = sum(head + max((im.height if im else 0) for im in imgs) + gap for _, imgs in rows) + head
sheet = Image.new("RGB", (sum(col_w) + gap * (len(cols) + 1), height), "#111110")
draw = ImageDraw.Draw(sheet)
for i, d in enumerate(cols):
    draw.text((gap + sum(col_w[:i]) + gap * i, 8), ("Before" if len(cols) == 2 and i == 0 else "After" if len(cols) == 2 else d.name), fill="#e9e3d4")
y = head
for k, imgs in rows:
    draw.text((gap, y + 6), k, fill="#b3ad9f")
    y += head
    x = gap
    for i, im in enumerate(imgs):
        if im:
            sheet.paste(im, (x, y))
        x += col_w[i] + gap
    y += max((im.height if im else 0) for im in imgs) + gap
out.parent.mkdir(parents=True, exist_ok=True)
sheet.save(out)
print(out)
