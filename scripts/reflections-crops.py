"""uv run --with pillow --with numpy scripts/reflections-crops.py CAPTURE_DIR [VARIANT ...] [--publish DIR]

Road crops and the wet-reflection iteration metric for scripts/reflections-compare.ts captures. For every pose it
crops the road (45–85 % of the frame height: wet asphalt from the horizon to a few metres ahead), stacks
Ashwood over each Lot variant, and scores each variant against Ashwood on that crop:

- mean linear luminance of the road (overall brightness of the reflections),
- reflection structure: luminance correlation of a 32×12 grid of log-luminance cells (does the road show the same
  bright streaks, windows and dark silhouettes in the same places; 1 is identical),
- grid error: mean |Δ log2 luminance| over those cells (stops),
- detail: mean vertical-gradient energy of log-luminance (streaks and reflected edges versus a flat smear).
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

args = sys.argv[1:]
publish = None
if "--publish" in args:
    i = args.index("--publish")
    publish = Path(args[i + 1])
    del args[i : i + 2]
root = Path(args[0])
variants = args[1:] or ["lot"]
TOP, BOTTOM = 0.45, 0.85


def load(path):
    rgb = np.asarray(Image.open(path).convert("RGB")).astype(float) / 255
    return rgb


def linear(rgb):
    return np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)


def road(rgb):
    h = rgb.shape[0]
    return rgb[int(h * TOP) : int(h * BOTTOM)]


def grid(lum, gx=32, gy=12):
    h, w = lum.shape
    cells = lum[: h - h % gy, : w - w % gx].reshape(gy, h // gy, gx, w // gx).mean(axis=(1, 3))
    return np.log2(cells + 1e-4)


def score(ref, cap):
    lr, lc = [linear(road(x)) @ np.array([0.2126, 0.7152, 0.0722]) for x in (ref, cap)]
    gr, gc = grid(lr), grid(lc)
    corr = float(np.corrcoef(gr.ravel(), gc.ravel())[0, 1])
    detail = lambda l: float(np.abs(np.diff(np.log2(l + 1e-4), axis=0)).mean())
    return {
        "road_luminance": float(lc.mean()),
        "ashwood_road_luminance": float(lr.mean()),
        "structure": corr,
        "grid_error_stops": float(np.abs(gr - gc).mean()),
        "detail": detail(lc),
        "ashwood_detail": detail(lr),
    }


def label(img, text):
    d = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 28)
    except OSError:
        font = ImageFont.load_default()
    d.rectangle([0, 0, 18 * len(text) + 24, 44], fill=(8, 12, 14))
    d.text((12, 7), text, fill=(220, 228, 228), font=font)
    return img


results = {}
for ash in sorted(root.glob("*-ashwood.png")):
    pose = ash.name.removesuffix("-ashwood.png")
    ref = load(ash)
    rows = [label(Image.fromarray((road(ref) * 255).astype(np.uint8)), f"Ashwood · {pose}")]
    results[pose] = {}
    for v in variants:
        p = root / f"{pose}-{v}.png"
        if not p.exists():
            continue
        cap = load(p)
        results[pose][v] = score(ref, cap)
        rows.append(label(Image.fromarray((road(cap) * 255).astype(np.uint8)), f"Lot {v} · {pose}"))
    w = rows[0].width
    sheet = Image.new("RGB", (w, sum(r.height for r in rows) + 6 * (len(rows) - 1)), (0, 0, 0))
    y = 0
    for r in rows:
        sheet.paste(r, (0, y))
        y += r.height + 6
    sheet = sheet.resize((w // 2, sheet.height // 2), Image.Resampling.LANCZOS)
    sheet.save(root / f"reflections-{pose}.jpg", quality=90)
    if publish:
        publish.mkdir(parents=True, exist_ok=True)
        sheet.save(publish / f"reflections-{pose}.jpg", quality=90)

(root / "reflections-metric.json").write_text(json.dumps(results, indent=2))
print(json.dumps(results, indent=2))
