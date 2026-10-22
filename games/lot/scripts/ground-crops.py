"""uv run --with pillow --with numpy games/lot/scripts/ground-crops.py CAPTURES OUT

The two renderers must have acknowledged the same camera in capture.json.
These fixed lower-frame crops compare ground, not whole-frame colour grading.
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

source, out = map(Path, sys.argv[1:])
out.mkdir(parents=True, exist_ok=True)
capture = json.loads((source / "capture.json").read_text())
assert not capture["errors"], capture["errors"]
# Fixed page captures avoid element-screenshot animation-frame waits. Split them only after a successful run.
for shot in capture["shots"]:
    name = shot["shot"]["name"]
    pair = source / f"{name}-pair.png"
    if pair.exists():
        with Image.open(pair) as im:
            assert im.size == (3840, 1080), im.size
            for engine, x in (("kit", 0), ("ashwood", 1920)):
                im.crop((x, 0, x + 1920, 1080)).save(source / f"{name}-{engine}.png")
metrics = {}
for name in ("road", "lot", "booth"):
    shot = next(s for s in capture["shots"] if s["shot"]["name"] == name)
    for key in ("x", "y", "z", "yaw", "pitch"):
        assert abs(shot["shot"][key] - shot["state"]["applied"][key]) < 1e-5
    a, b = [Image.open(source / f"{name}-{engine}.png").convert("RGB") for engine in ("ashwood", "kit")]
    assert a.size == b.size == (1920, 1080), (a.size, b.size)
    box = (0, 600, 1920, 1080)
    a, b = a.crop(box), b.crop(box)
    x, y = [np.asarray(im).astype(float) / 255 for im in (a, b)]
    linear = lambda c: np.where(c <= .04045, c / 12.92, ((c + .055) / 1.055) ** 2.4)
    lum = lambda c: float((linear(c) @ np.array([.2126, .7152, .0722])).mean())
    metrics[name] = {"bounds": box, "camera": shot["shot"], "rgb_mae_255": float(abs(x-y).mean()*255),
                     "reference_luminance": lum(x), "kit_luminance": lum(y)}
    sheet = Image.new("RGB", (3840, 522), "#12181a")
    sheet.paste(a, (0, 42)); sheet.paste(b, (1920, 42))
    draw = ImageDraw.Draw(sheet)
    draw.text((16, 14), f"ASHWOOD / {name}", fill="white")
    draw.text((1936, 14), f"LOT / {name}", fill="white")
    sheet.save(out / f"ground-{name}.jpg", quality=95)
(out / "ground-metrics.json").write_text(json.dumps(metrics, indent=2))
