#!/usr/bin/env python3
"""Line-rig overlay sheets for reference-clips.ts: our gait (coloured) over each open reference clip (grey),
8 phases from left heel strike, side and front views, normalised to hip height 1."""
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

OUT_DIR = sys.argv[1]
TAG = sys.argv[2] if len(sys.argv) > 2 else "after"
data = json.load(open(os.path.join(OUT_DIR, f"reference-clips-{TAG}.json")))
SEGS = data["segments"]


def font(size):
    for p in ("/System/Library/Fonts/SFNSMono.ttf", "/System/Library/Fonts/Menlo.ttc", "/Library/Fonts/Arial.ttf"):
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except OSError:
                pass
    return ImageFont.load_default()


F12, F14, F18 = font(12), font(14), font(18)
BG = (18, 20, 24)
GRID = (40, 44, 52)
COL = {"spine": (235, 235, 235), "left": (80, 160, 255), "right": (255, 150, 60), "weapon": (230, 190, 60)}
REF = (120, 126, 136)
CW, CH = 150, 230


def to_px(pt, ox, oy, scale=85):
    return (ox + pt[0] * scale, oy - pt[1] * scale)


def draw_pose(d, pts, ox, oy, colour=None, width=3):
    for s in SEGS:
        a, b = s["from"], s["to"]
        if a not in pts or b not in pts:
            continue
        c = colour or COL[s["group"]]
        d.line([to_px(pts[a], ox, oy), to_px(pts[b], ox, oy)], fill=c, width=width)
    if "headTop" in pts:
        x, y = to_px(pts["headTop"], ox, oy)
        r = 9 if colour is None else 10
        d.ellipse([x - r, y - r + 4, x + r, y + r + 4], outline=colour or COL["spine"], width=2)


def strip(comp_key, view, out_name):
    comp = data["comparisons"][comp_key]
    ours = data["cycles"][comp_key]
    ref = data["references"][comp["ref"]]
    phases = 8
    W, H = CW * phases + 40, CH + 120
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    rm = comp["angleRmseDeg"]
    d.text((20, 12), f"{ours['name']} @ {ref['speed']} m/s (colour)  vs  {ref['label']} (grey, {ref['licence']})", fill=(240, 240, 240), font=F18)
    d.text(
        (20, 38),
        f"{view} view · angle RMSE overall {rm['overallAngleRmse']}°  arms {rm['meanArmAngleRmse']}°  legs {rm['meanLegAngleRmse']}°"
        f"  (hip {rm['hipFlex']}° knee {rm['kneeFlex']}° ankle {rm['anklePitch']}° shoulder {rm['shoulderFlex']}° elbow {rm['elbowFlex']}°)",
        fill=(190, 196, 206),
        font=F14,
    )
    d.text((20, 58), f"cadence {ours['cadenceStepsPerMin']} vs {ref['cadenceStepsPerMin']} steps/min · {ref['source']}", fill=(150, 156, 166), font=F12)
    for k in range(phases):
        ox, oy = 20 + k * CW + CW / 2, 90 + CH * 0.42
        d.line([(20 + k * CW, 90 + CH - 8), (20 + (k + 1) * CW - 6, 90 + CH - 8)], fill=GRID, width=1)
        key = "orthoSide" if view == "side" else "orthoFront"
        draw_pose(d, ref["phases8"][k][key]["points"], ox, oy, colour=REF, width=7)
        draw_pose(d, ours["phases8"][k][key]["points"], ox, oy)
        d.text((20 + k * CW + 6, 90 + CH - 2), f"{k}/8", fill=(150, 156, 166), font=F12)
    img.save(os.path.join(OUT_DIR, out_name))
    return out_name


def angle_plot(comp_key, out_name):
    comp = data["comparisons"][comp_key]
    ours = data["cycles"][comp_key]
    ref = data["references"][comp["ref"]]
    keys = [("trunkPitchDeg", "trunk pitch"), ("hipFlexL", "hip L"), ("kneeFlexL", "knee L"), ("anklePitchL", "ankle L"),
            ("shoulderFlexL", "shoulder L"), ("elbowFlexL", "elbow L")]
    pw, ph = 300, 150
    W, H = pw * 3 + 40, ph * 2 + 90
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.text((20, 10), f"{ours['name']} (colour) vs {ref['label']} (grey): left-side angles over one cycle, deg", fill=(240, 240, 240), font=F14)
    for i, (k, label) in enumerate(keys):
        bx, by = 20 + (i % 3) * pw, 40 + (i // 3) * (ph + 20)
        a = [s["angles"][k] for s in ours["denseSamples"]]
        b = [s["angles"][k] for s in ref["denseSamples"]]
        lo, hi = min(a + b) - 5, max(a + b) + 5
        d.rectangle([bx, by, bx + pw - 12, by + ph], outline=GRID)
        d.text((bx + 6, by + 4), f"{label}  [{lo:.0f}..{hi:.0f}]", fill=(190, 196, 206), font=F12)

        def pts(v):
            return [(bx + j / (len(v) - 1) * (pw - 12), by + ph - (x - lo) / (hi - lo) * ph) for j, x in enumerate(v)]

        d.line(pts(b), fill=REF, width=4)
        d.line(pts(a), fill=COL["left"], width=2)
    img.save(os.path.join(OUT_DIR, out_name))


def summary(out_name):
    rows = data["summary"]
    W, H = 1500, 60 + 24 * len(rows) + 30
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.text((20, 12), "Our procedural gaits vs open reference clips (angle RMSE, deg; lower = closer)", fill=(240, 240, 240), font=F18)
    cols = [("key", 20), ("speed", 330), ("overall", 400), ("arm", 470), ("leg", 530), ("worst", 590), ("cadence", 1020), ("knee", 1200)]
    for name, x in cols:
        d.text((x, 40), name, fill=(150, 156, 166), font=F12)
    for i, r in enumerate(rows):
        y = 60 + i * 24
        for name, x in cols:
            v = r[name]
            colour = (240, 240, 240)
            if name in ("overall", "arm", "leg"):
                colour = (120, 220, 140) if v < 15 else (240, 210, 90) if v < 25 else (255, 110, 100)
            d.text((x, y), str(v), fill=colour, font=F12)
    img.save(os.path.join(OUT_DIR, out_name))


made = [summary(f"summary-{TAG}.png")]
for key in data["comparisons"]:
    strip(key, "side", f"{key}-side-{TAG}.png")
    strip(key, "front", f"{key}-front-{TAG}.png")
    angle_plot(key, f"{key}-angles-{TAG}.png")
print(f"reference-clips: wrote {3 * len(data['comparisons']) + 1} PNGs to {OUT_DIR}")
