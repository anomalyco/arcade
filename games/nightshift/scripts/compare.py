"""uv run --with pillow --with numpy games/nightshift/scripts/compare.py TARGETS CAPTURES OUT/iteration-N

Concept images are art-direction references, not registered renders of this scene.
Pixel error describes composition/color difference, not a perceptual fidelity score.
"""
import colorsys
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

targets, captures, dest = map(Path, sys.argv[1:])
dest.parent.mkdir(parents=True, exist_ok=True)
sheet = Image.new("RGB", (2000, 1225), "#101615")
draw = ImageDraw.Draw(sheet)
reports = {}


def stats(rgb):
    linear = np.where(rgb <= .04045, rgb / 12.92, ((rgb + .055) / 1.055) ** 2.4)
    lum = linear @ np.array([.2126, .7152, .0722])
    mean = rgb.mean(axis=(0, 1))
    hue, sat, _ = colorsys.rgb_to_hsv(*mean)
    return {"linear_luminance": float(lum.mean()), "rgb": mean.tolist(),
            "hue_degrees": hue * 360, "saturation": sat,
            "luminance_percentiles": np.percentile(lum, [5, 25, 50, 75, 95, 99]).tolist(),
            "display_histogram": np.histogram(rgb @ np.array([.2126, .7152, .0722]), bins=32, range=(0, 1))[0].tolist()}


def measure(a, b):
    sa, sb = stats(a), stats(b)
    dh = abs(sa["hue_degrees"] - sb["hue_degrees"])
    return {"reference": sa, "capture": sb, "rgb_mae_255": float(abs(a-b).mean()*255),
            "luminance_error": abs(sa["linear_luminance"]-sb["linear_luminance"]),
            "hue_error_degrees": min(dh, 360-dh)}


for index, view in enumerate(["wide", "phone"]):
    a = Image.open(targets / f"01-night-shift-{view}.png").convert("RGB")
    b = Image.open(captures / f"{view}.png").convert("RGB")
    original = b.size
    b = b.resize(a.size, Image.Resampling.LANCZOS)
    ar, br = [np.asarray(im).astype(float) / 255 for im in (a, b)]
    h, w = ar.shape[:2]
    grid = []
    for row in range(6):
        for col in range(8):
            ys, xs = slice(row*h//6, (row+1)*h//6), slice(col*w//8, (col+1)*w//8)
            grid.append({"row": row, "column": col, **measure(ar[ys, xs], br[ys, xs])})
    reports[view] = {"original_capture_size": original, "resized": original != a.size,
                     "global": measure(ar, br), "grid_8x6": grid}
    diff = Image.fromarray(np.uint8(np.clip(abs(ar-br)*4*255, 0, 255)))
    diff.save(str(dest)+f"-{view}-diff.jpg", quality=92)
    y = index * 602
    draw.text((16, y+12), f"Approved concept / {view}", fill="white")
    draw.text((1016, y+12), f"{dest.name} / {view} / RGB MAE {reports[view]['global']['rgb_mae_255']:.2f}/255", fill="white")
    sheet.paste(a.resize((1000, 562), Image.Resampling.LANCZOS), (0, y+34))
    sheet.paste(b.resize((1000, 562), Image.Resampling.LANCZOS), (1000, y+34))

draw.text((16, 1210), "Concept vs reconstruction: different geometry and framing. Pixel errors are descriptive, not a similarity score.", fill="#aaaaaa")
sheet.save(dest.with_suffix(".jpg"), quality=94)
dest.with_suffix(".json").write_text(json.dumps(reports, indent=2))
print(json.dumps({view: report["global"] for view, report in reports.items()}, indent=2))
