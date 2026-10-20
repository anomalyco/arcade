"""uv run --with pillow --with numpy scripts/compare.py REFERENCE CAPTURE OUT/iteration-N

Whole-frame and 8×6 grid metrics in display RGB and linear luminance. The reference
is always the saved 1920×1080 frame. Earlier differently framed baselines are
explicitly marked as resized, so their pixel error is not mistaken for registration.
"""
import colorsys
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

reference, capture, dest = sys.argv[1:]
out = Path(dest)
out.parent.mkdir(parents=True, exist_ok=True)
a = Image.open(reference).convert("RGB")
b = Image.open(capture).convert("RGB")
original_size = b.size
b = b.resize(a.size, Image.Resampling.LANCZOS)
ar, br = [np.asarray(im).astype(float) / 255 for im in (a, b)]


def stats(rgb):
    linear = np.where(rgb <= .04045, rgb / 12.92, ((rgb + .055) / 1.055) ** 2.4)
    lum = linear @ np.array([.2126, .7152, .0722])
    mean = rgb.mean(axis=(0, 1))
    hue, sat, value = colorsys.rgb_to_hsv(*mean)
    return {"linear_luminance": float(lum.mean()), "rgb": mean.tolist(),
            "hue_degrees": hue * 360, "saturation": sat,
            "luminance_percentiles": np.percentile(lum, [5, 25, 50, 75, 95, 99]).tolist(),
            "display_histogram": np.histogram(rgb @ np.array([.2126, .7152, .0722]), bins=32, range=(0, 1))[0].tolist()}


def measure(x, y):
    sa, sb = stats(x), stats(y)
    dh = abs(sa["hue_degrees"] - sb["hue_degrees"])
    return {"reference": sa, "kit": sb, "rgb_mae_255": float(abs(x-y).mean()*255),
            "luminance_error": abs(sa["linear_luminance"]-sb["linear_luminance"]),
            "hue_error_degrees": min(dh, 360-dh)}


h, w = ar.shape[:2]
grid = []
for row in range(6):
    for col in range(8):
        ys, xs = slice(row*h//6, (row+1)*h//6), slice(col*w//8, (col+1)*w//8)
        grid.append({"row": row, "column": col, **measure(ar[ys, xs], br[ys, xs])})
report = {"reference": reference, "capture": capture, "original_capture_size": original_size,
          "resized": original_size != a.size, "global": measure(ar, br), "grid_8x6": grid}
out.with_suffix(".json").write_text(json.dumps(report, indent=2))
diff = Image.fromarray(np.uint8(np.clip(abs(ar-br)*4*255, 0, 255)))
sheet = Image.new("RGB", (w*2, h+42), "#12181a")
sheet.paste(a, (0, 42)); sheet.paste(b, (w, 42))
draw = ImageDraw.Draw(sheet)
draw.text((16, 14), "ASHWOOD — saved reference", fill="white")
draw.text((w+16, 14), f"LOT — {out.name}   RGB MAE {report['global']['rgb_mae_255']:.2f}/255", fill="white")
sheet.save(out.with_suffix(".jpg"), quality=94)
diff.save(str(out)+"-diff.jpg", quality=94)
print(json.dumps({"iteration":out.name,"global":report["global"],"comparison":str(out.with_suffix('.jpg'))}))
