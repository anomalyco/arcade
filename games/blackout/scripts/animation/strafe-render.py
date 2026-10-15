import json
import math
import os
import sys
from PIL import Image, ImageDraw, ImageFont

# Strafe line-rig sheets (top and front views), before | reference | after, plus angle and sweep plots.
# Usage: strafe-render.py <out-dir> <tag>
if len(sys.argv) < 3:
    sys.exit("usage: strafe-render.py <out-dir> <tag>")
OUT = sys.argv[1]
TAG = sys.argv[2]


def load(tag):
    p = os.path.join(OUT, f"strafe-{tag}.json")
    if not os.path.exists(p):
        return None
    with open(p) as f:
        return json.load(f)


cur = load(TAG)
before = load("before") if TAG != "before" else None


def font(size):
    for p in ["/System/Library/Fonts/SFNSMono.ttf", "/System/Library/Fonts/Menlo.ttc", "/System/Library/Fonts/Helvetica.ttc"]:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


F_TITLE, F_SUB, F_SMALL = font(18), font(12), font(10)
BG = (14, 18, 24)
CELL = (20, 25, 33)
GRID = (42, 52, 66)
SPINE = (244, 247, 252)
LEFT = (56, 182, 255)
RIGHT = (255, 120, 73)
WEAPON = (245, 208, 96)
TRAVEL = (120, 230, 140)
AIM = (245, 208, 96)
MUTED = (150, 160, 175)
ROW_COL = {"before": (255, 92, 116), "reference": (72, 232, 138), "after": (120, 200, 255)}

SEGS = [
    ("pelvis", "waist", "s"), ("waist", "chest", "s"), ("chest", "neck", "s"), ("neck", "headTop", "s"),
    ("shoulderL", "shoulderR", "s"), ("hipL", "hipR", "s"),
    ("shoulderL", "elbowL", "l"), ("elbowL", "wristL", "l"), ("hipL", "kneeL", "l"), ("kneeL", "ankleL", "l"), ("ankleL", "toeL", "l"),
    ("shoulderR", "elbowR", "r"), ("elbowR", "wristR", "r"), ("hipR", "kneeR", "r"), ("kneeR", "ankleR", "r"), ("ankleR", "toeR", "r"),
]
COL = {"s": SPINE, "l": LEFT, "r": RIGHT}
CW, CH = 150, 190


def proj(p, view):
    # Top view: aim (+X) points up the page, the actor's right (+Z) to the right. Front view: right +Z, up +Y.
    if view == "top":
        s = 68.0
        return (CW * 0.5 + p[2] * s, CH * 0.5 - p[0] * s)
    s = 88.0
    return (CW * 0.5 + p[2] * s, CH - 10 - p[1] * s)


def draw_frame(d, fr, view, ox, oy, col_override=None, width=2):
    j = fr["joints"]
    if view == "top":
        # Planted boots as filled footprints so crossings and gaps read at a glance.
        for side, (a, t) in enumerate([("ankleL", "toeL"), ("ankleR", "toeR")]):
            if fr["planted"][side]:
                pa, pt = proj(j[a], view), proj(j[t], view)
                c = LEFT if side == 0 else RIGHT
                d.line([(ox + pa[0], oy + pa[1]), (ox + pt[0], oy + pt[1])], fill=c + (90,), width=9)
        tr = fr["travel"]
        c0 = (ox + CW * 0.5, oy + CH * 0.5)
        d.line([c0, (c0[0] + math.sin(tr) * 34, c0[1] - math.cos(tr) * 34)], fill=TRAVEL + (200,), width=2)
        d.line([c0, (c0[0], c0[1] - 40)], fill=AIM + (110,), width=1)
    order = ["s", "l", "r"]
    for g in order:
        for a, b, grp in SEGS:
            if grp != g:
                continue
            pa, pb = proj(j[a], view), proj(j[b], view)
            c = col_override or COL[grp]
            arm = a.startswith(("shoulder", "elbow")) and grp != "s"
            leg = a.startswith(("hip", "knee", "ankle")) and grp != "s"
            alpha = 120 if (arm and view == "top") else 255
            w = width + (1 if leg else 0) + (1 if a == "hipL" and b == "hipR" else 0)
            d.line([(ox + pa[0], oy + pa[1]), (ox + pb[0], oy + pb[1])], fill=c + (alpha,), width=w)
    if j.get("gunGrip") and j.get("gunMuzzle"):
        pa, pb = proj(j["gunGrip"], view), proj(j["gunMuzzle"], view)
        d.line([(ox + pa[0], oy + pa[1]), (ox + pb[0], oy + pb[1])], fill=WEAPON + (255,), width=3)
    for k in ["kneeL", "kneeR"]:
        p = proj(j[k], view)
        d.ellipse([ox + p[0] - 2.5, oy + p[1] - 2.5, ox + p[0] + 2.5, oy + p[1] + 2.5], fill=(255, 255, 255, 255))
    if view == "front":
        gy = CH - 12
        d.line([(ox + 4, oy + gy), (ox + CW - 4, oy + gy)], fill=GRID + (255,), width=1)


def sheet(name, title, rows, phases=16):
    """rows: list of (label, kind, cycle)."""
    rows = [r for r in rows if r[2]]
    if not rows:
        return
    step = 16 // phases
    for view in ["top", "front"]:
        W = 150 + CW * phases
        H = 54 + len(rows) * (CH + 6)
        img = Image.new("RGBA", (W, H), BG + (255,))
        d = ImageDraw.Draw(img, "RGBA")
        d.text((12, 10), f"{title} · {view} view · {phases} phases from left touchdown", font=F_TITLE, fill=(235, 240, 248))
        d.text((12, 32), "blue = left, orange = right, white = spine, gold = gun · green arrow = travel, faint gold = aim · shaded = planted boot", font=F_SMALL, fill=MUTED)
        for r, (label, kind, cyc) in enumerate(rows):
            y = 54 + r * (CH + 6)
            d.text((10, y + 6), label, font=F_SUB, fill=ROW_COL.get(kind, MUTED))
            d.text((10, y + 24), f"cycle {cyc['durationSec']:.2f}s", font=F_SMALL, fill=MUTED)
            for q in range(phases):
                x = 150 + q * CW
                d.rectangle([x + 1, y, x + CW - 1, y + CH], fill=CELL + (255,), outline=GRID + (255,))
                if r == 0:
                    d.text((x + 4, y + 2), f"{q * step}/16", font=F_SMALL, fill=MUTED)
                draw_frame(d, cyc["frames"][q * step], view, x, y)
        img.convert("RGB").save(os.path.join(OUT, f"line-rig-{name}-{phases}-{view}-{TAG}.png"))


def ref_for(actor_gait_angle):
    actor, gait, angle = actor_gait_angle.split("/")
    a = int(angle)
    refs = []
    if a == 180:
        refs.append(("mocap walk-back", cur["mocap"]["walk-back"]["cycle"]))
    if a == 90 and gait in ("walk", "slow"):
        refs.append(("authored side-step", cur["authored"]["sideStepWalk"]["cycle"]))
        refs.append(("mocap walk-right", cur["mocap"]["walk-right"]["cycle"]))
    if a == -90 and gait in ("walk", "slow"):
        refs.append(("mocap walk-left", cur["mocap"]["walk-left"]["cycle"]))
    if a == 90 and gait in ("jog", "run"):
        refs.append(("authored crossover", cur["authored"]["crossoverRun"]["cycle"]))
    return refs


for key, c in cur["cases"].items():
    if not c.get("cycle"):
        continue
    actor, gait, angle = key.split("/")
    rows = []
    if before and before["cases"].get(key, {}).get("cycle"):
        rows.append(("before", "before", before["cases"][key]["cycle"]))
    for lbl, cyc in ref_for(key):
        rows.append((lbl, "reference", cyc))
    rows.append((TAG, "after" if TAG != "before" else "before", c["cycle"]))
    name = key.replace("/", "-")
    title = f"{actor} · {gait} {c['speed']} m/s · travel {angle}° from aim"
    sheet(name, title, rows, 16)
    sheet(name, title, rows, 8)

# Reference-only sheet.
sheet("references", "references", [
    ("side-step 0.8", "reference", cur["authored"]["sideStepWalk"]["cycle"]),
    ("crossover 4.2", "reference", cur["authored"]["crossoverRun"]["cycle"]),
    ("mocap walk-right", "reference", cur["mocap"]["walk-right"]["cycle"]),
    ("mocap walk-back", "reference", cur["mocap"]["walk-back"]["cycle"]),
], 16)


# ---- plots -----------------------------------------------------------------------------------------------------
def plot(name, title, panels):
    """panels: list of (subtitle, ylabel, series[(label, color, [(x,y)])], yrange)."""
    PW, PH = 520, 250
    cols = 2
    rowsN = (len(panels) + cols - 1) // cols
    img = Image.new("RGB", (cols * PW + 20, 50 + rowsN * (PH + 20)), BG)
    d = ImageDraw.Draw(img, "RGBA")
    d.text((12, 12), title, font=F_TITLE, fill=(235, 240, 248))
    for k, (sub, ylab, series, yr) in enumerate(panels):
        ox = 10 + (k % cols) * PW
        oy = 46 + (k // cols) * (PH + 20)
        d.rectangle([ox, oy, ox + PW - 10, oy + PH], fill=CELL, outline=GRID)
        d.text((ox + 8, oy + 4), sub, font=F_SUB, fill=(225, 230, 240))
        x0, x1, y0, y1 = ox + 44, ox + PW - 20, oy + PH - 24, oy + 24
        lo, hi = yr
        def px(x, y):
            return (x0 + (x / 360.0) * (x1 - x0), y0 - (y - lo) / (hi - lo) * (y0 - y1))
        for gx in range(0, 361, 45):
            a, b = px(gx, lo), px(gx, hi)
            d.line([a, b], fill=GRID)
            d.text((a[0] - 8, y0 + 4), str(gx), font=F_SMALL, fill=MUTED)
        for gy in [lo, (lo + hi) / 2, hi, 0]:
            if lo <= gy <= hi:
                a, b = px(0, gy), px(360, gy)
                d.line([a, b], fill=GRID if gy != 0 else (90, 100, 115))
                d.text((ox + 4, a[1] - 6), f"{gy:g}", font=F_SMALL, fill=MUTED)
        d.text((x1 - 140, y0 + 4), "travel − aim (°)", font=F_SMALL, fill=MUTED)
        d.text((ox + 8, oy + 18), ylab, font=F_SMALL, fill=MUTED)
        ly = oy + 4
        for lbl, colr, pts in series:
            pts = sorted(pts)
            if not pts:
                continue
            seg = []
            for x, y in pts:
                p = px(x, max(lo, min(hi, y)))
                if seg and abs(x - seg[-1][2]) > 30:
                    if len(seg) > 1:
                        d.line([(a, b) for a, b, _ in seg], fill=colr, width=2)
                    seg = []
                seg.append((p[0], p[1], x))
            if len(seg) > 1:
                d.line([(a, b) for a, b, _ in seg], fill=colr, width=2)
            if len(pts) < 20:
                for x, y in pts:
                    p = px(x, max(lo, min(hi, y)))
                    d.ellipse([p[0] - 3, p[1] - 3, p[0] + 3, p[1] + 3], fill=colr)
            d.text((x1 - 150, ly), lbl, font=F_SMALL, fill=colr)
            ly += 12
    img.save(os.path.join(OUT, f"{name}-{TAG}.png"))


def angle_points(data, actor, gait, metric):
    pts = []
    for key, c in data["cases"].items():
        a, g, ang = key.split("/")
        if a == actor and g == gait:
            x = int(ang) % 360
            pts.append((x, c["metrics"][metric]))
            if x == 0:
                pts.append((360, c["metrics"][metric]))
    return pts


METRICS = [
    ("minFootGapCm", "closest boot gap (cm)", (0, 60)),
    ("cadence", "cadence (steps/min)", (100, 400)),
    ("pelvisVsAimDeg", "pelvis yaw − aim (°)", (-90, 90)),
    ("torsoVsAimDeg", "torso yaw − aim (°)", (-45, 45)),
    ("footVsPelvisDeg", "planted foot vs pelvis (°)", (0, 40)),
    ("kneeVsFootDeg", "knee bend vs foot direction (°)", (0, 70)),
    ("stepDirErrDeg", "step direction vs travel (°)", (0, 40)),
    ("touchdownWidthPelvisCm", "feet apart at touchdown, pelvis frame (cm)", (0, 70)),
]
for actor in ["survivor", "soldier", "outbreak-aim"]:
    panels = []
    for m, lab, yr in METRICS:
        series = []
        for gait, shade in [("walk", 1.0), ("run", 0.75)]:
            if before:
                series.append((f"before {gait}", tuple(int(c * shade) for c in ROW_COL["before"]), angle_points(before, actor, gait, m)))
            series.append((f"{TAG} {gait}", tuple(int(c * shade) for c in ROW_COL["after" if TAG != "before" else "before"]), angle_points(cur, actor, gait, m)))
        panels.append((m, lab, series, yr))
    plot(f"angles-{actor}", f"{actor}: metrics vs travel angle (walk 1.4, run 4.2 m/s)", panels)

for actor in ["survivor", "soldier", "outbreak-aim"]:
    panels = []
    for field, lab, yr in [("pelvisVsAim", "pelvis yaw − aim (°)", (-180, 180)), ("torsoVsAim", "torso yaw − aim (°)", (-90, 90)), ("latAimCm", "right − left ankle, aim lateral (cm)", (-80, 80)), ("footGapCm", "boot gap (cm)", (0, 80))]:
        series = []
        for gait in ["walk", "run"]:
            if before:
                series.append((f"before {gait}", ROW_COL["before"] if gait == "walk" else (190, 70, 90), [(s["rel"], s[field]) for s in before["sweeps"][f"{actor}/{gait}"]["series"]]))
            series.append((f"{TAG} {gait}", ROW_COL["after"] if gait == "walk" else (80, 140, 200), [(s["rel"], s[field]) for s in cur["sweeps"][f"{actor}/{gait}"]["series"]]))
        panels.append((field, lab, series, yr))
    plot(f"sweep-{actor}", f"{actor}: aim turns once while travelling straight (24 s)", panels)

print(f"Rendered strafe sheets and plots into {OUT}")
