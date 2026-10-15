import json
import math
from PIL import Image

def load_pixels(path):
    im = Image.open(path).convert("RGB")
    w, h = im.size
    return w, h, list(im.getdata())

def srgb_to_lab_px(r, g, b):
    def lin(c):
        v = c / 255.0
        return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
    rl, gl, bl = lin(r), lin(g), lin(b)
    x = (rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375) / 0.95047
    y = (rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750) / 1.00000
    z = (rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041) / 1.08883
    def f(t):
        return t ** (1.0 / 3.0) if t > 0.008856 else 7.787 * t + 16.0 / 116.0
    fx, fy, fz = f(x), f(y), f(z)
    return 116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)

def eval_pair(src_path, tgt_path, beam_box, out_boxes, zombie_boxes):
    w, h, src = load_pixels(src_path)
    _, _, tgt = load_pixels(tgt_path)
    n = w * h
    luma_diff = 0.0
    rgb_diff = 0.0
    de_sum = 0.0
    src_luma_sum = 0.0
    tgt_luma_sum = 0.0

    # Sample every 2nd pixel in x/y for fast CIE Lab DeltaE; full resolution for luma/rgb/ROIs
    de_count = 0
    for i in range(n):
        sr, sg, sb = src[i]
        tr, tg, tb = tgt[i]
        sl = 0.2126 * sr + 0.7152 * sg + 0.0722 * sb
        tl = 0.2126 * tr + 0.7152 * tg + 0.0722 * tb
        src_luma_sum += sl
        tgt_luma_sum += tl
        luma_diff += abs(sl - tl)
        rgb_diff += (abs(sr - tr) + abs(sg - tg) + abs(sb - tb)) / 3.0
        if (i % w) % 2 == 0 and (i // w) % 2 == 0:
            L1, a1, b1 = srgb_to_lab_px(sr, sg, sb)
            L2, a2, b2 = srgb_to_lab_px(tr, tg, tb)
            de_sum += math.sqrt((L1 - L2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2)
            de_count += 1

    def box_chroma(px, x0, y0, x1, y1):
        s = 0.0
        c = 0
        for y in range(y0, y1):
            row = y * w
            for x in range(x0, x1):
                r, g, b = px[row + x]
                s += max(r, g, b) - min(r, g, b)
                c += 1
        return s / max(1, c)

    bx0, by0, bx1, by1 = beam_box
    beam_c_src = box_chroma(src, bx0, by0, bx1, by1)
    beam_c_tgt = box_chroma(tgt, bx0, by0, bx1, by1)

    out_c_src = sum(box_chroma(src, *b) for b in out_boxes) / len(out_boxes)
    out_c_tgt = sum(box_chroma(tgt, *b) for b in out_boxes) / len(out_boxes)

    z_metrics = {}
    for name, (x0, y0, x1, y1) in zombie_boxes.items():
        lumas = []
        chromas = []
        for y in range(y0, y1):
            row = y * w
            for x in range(x0, x1):
                r, g, b = src[row + x]
                lumas.append(0.2126 * r + 0.7152 * g + 0.0722 * b)
                chromas.append(max(r, g, b) - min(r, g, b))
        lumas.sort()
        p92 = lumas[int(len(lumas) * 0.92)]
        p20 = lumas[int(len(lumas) * 0.20)]
        z_metrics[name] = {
            "lumaP92": round(p92, 2),
            "lumaBgP20": round(p20, 2),
            "contrast": round(p92 - p20, 2),
            "meanChroma": round(sum(chromas) / len(chromas), 2),
        }

    return {
        "lumaMae": round(luma_diff / n, 2),
        "rgbMae": round(rgb_diff / n, 2),
        "deltaE": round(de_sum / max(1, de_count), 2),
        "meanLuma": round(src_luma_sum / n, 2),
        "targetMeanLuma": round(tgt_luma_sum / n, 2),
        "beamChroma": round(beam_c_src, 2),
        "targetBeamChroma": round(beam_c_tgt, 2),
        "outsideChroma": round(out_c_src, 2),
        "targetOutsideChroma": round(out_c_tgt, 2),
        "selectiveColorRatio": round(beam_c_src / max(0.5, out_c_src), 2),
        "zombies": z_metrics,
    }

out_dir = "/Users/kit/code/home/artifacts/2026-10-14-outbreak-noir"
res = {
    "street": eval_pair(
        f"{out_dir}/after-street-canvas.png",
        f"{out_dir}/target-street.png",
        beam_box=(465, 155, 535, 315),
        out_boxes=[(80, 60, 380, 260), (600, 60, 900, 260), (100, 360, 420, 560), (580, 360, 900, 560)],
        zombie_boxes={
            "beamZombie": (475, 195, 520, 265),
            "leftDarkLosZombie": (375, 240, 425, 300),
            "rightDarkLosZombie": (565, 240, 615, 300),
        },
    ),
    "open": eval_pair(
        f"{out_dir}/after-open-canvas.png",
        f"{out_dir}/target-open.png",
        beam_box=(470, 130, 540, 310),
        out_boxes=[(270, 340, 450, 470), (600, 260, 780, 450), (80, 80, 250, 350)],
        zombie_boxes={
            "bedroomBeamZombie": (480, 175, 525, 235),
            "hallwayDarkLosZombie": (535, 245, 585, 305),
        },
    ),
}
print(json.dumps(res, indent=2))
