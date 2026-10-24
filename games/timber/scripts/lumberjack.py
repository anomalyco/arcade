# Repaints Rocketbox m05's outfit texture for TIMBER's lumberjack: the long-sleeved shirt becomes a red and black
# buffalo-check flannel, the field vest black waxed canvas, the trousers dark work trousers and the shoes dark boots.
# Each keeps the original's folds and seams (its own shading, divided by the piece's mean). Called by lumberjack.ts.
#   uv run --with numpy --with pillow python lumberjack.py <in.webp> <out.webp> [preview.png]
import sys

import numpy as np
from PIL import Image

src = np.asarray(Image.open(sys.argv[1]).convert("RGB"), np.float32) / 255
H, W = src.shape[:2]
y, x = np.mgrid[0:H, 0:W].astype(np.float32)
x /= W
y /= H
mx, mn = src.max(axis=2), src.min(axis=2)
sat = (mx - mn) / np.maximum(mx, 1e-4)
r, g, b = src[..., 0], src[..., 1], src[..., 2]
d = np.maximum(mx - mn, 1e-4)
hue = np.where(mx == r, ((g - b) / d) % 6, np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) * 60
lum = src @ np.array((0.2126, 0.7152, 0.0722), np.float32)
skin = (x < 0.215) & (y > 0.83) | (x > 0.785) & (y > 0.83)

shirt = (hue > 60) & (hue < 140) & (sat > 0.12) & ~skin
tan = (hue > 18) & (hue < 52) & (sat > 0.12) & (mx > 0.08) & ~skin
vest = tan & (x > 0.29) & (x < 0.71) & (y < 0.77)
boots = tan & ~vest & (y > 0.42)
trousers = (y < 0.42) & ((x < 0.3) | (x > 0.7)) & ~shirt


def shade(mask):
    """The piece's own light and dark (folds, seams) around 1."""
    return np.minimum(lum / max(float(np.median(lum[mask])), 1e-3), 1.3)[..., None] if mask.any() else 1


def srgb(c):
    return np.array(c, np.float32) / 255


out = src.copy()
# Buffalo check: red and black stripes both ways (red over red, black over black, dark red where they cross), a twill
# grain and a little fuzz between the stripes.
P = 1 / 22
su = (np.floor(x / (P / 2)) % 2).astype(np.float32)
sv = (np.floor(y / (P / 2)) % 2).astype(np.float32)
red, black, cross = srgb((92, 16, 14)), srgb((15, 13, 13)), srgb((44, 12, 11))
check = np.where((su + sv)[..., None] == 0, red, np.where((su + sv)[..., None] == 2, black, cross))
twill = 0.9 + 0.2 * (((x * W + y * H) % 3) < 1.5).astype(np.float32)[..., None]
fuzz = 0.92 + 0.16 * np.random.default_rng(5).random((H, W, 1)).astype(np.float32)
out = np.where(shirt[..., None], np.clip(check * twill * fuzz * shade(shirt), 0, 1), out)
out = np.where(vest[..., None], np.clip(srgb((30, 26, 22)) * shade(vest) ** 1.2, 0, 1), out)
out = np.where(trousers[..., None], np.clip(srgb((42, 38, 33)) * shade(trousers), 0, 1), out)
out = np.where(boots[..., None], np.clip(srgb((34, 24, 17)) * shade(boots), 0, 1), out)

img = Image.fromarray((out * 255 + 0.5).astype(np.uint8))
img.save(sys.argv[2], "WEBP", quality=90, method=6)
if len(sys.argv) > 3:
    img.save(sys.argv[3])
