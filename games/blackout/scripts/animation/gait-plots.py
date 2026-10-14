import json
import os
import sys
from PIL import Image, ImageDraw, ImageFont

if len(sys.argv) < 2:
    sys.exit(f"usage: {os.path.basename(__file__)} <out-dir> [tag]")
OUT_DIR = sys.argv[1]
tag = sys.argv[2] if len(sys.argv) > 2 else "before"

with open(os.path.join(OUT_DIR, f"{tag}-data.json")) as f:
    cur_data = json.load(f)

before_path = os.path.join(OUT_DIR, "before-data.json")
before_data = None
if tag == "after" and os.path.exists(before_path):
    with open(before_path) as f:
        before_data = json.load(f)

def get_font(size=16):
    for p in [
        "/System/Library/Fonts/SFNSMono.ttf",
        "/System/Library/Fonts/Menlo.ttc",
        "/System/Library/Fonts/Supplemental/Menlo.ttc",
        "/System/Library/Fonts/Helvetica.ttc",
    ]:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()

FONT_TITLE = get_font(22)
FONT_SUB = get_font(15)
FONT_AXIS = get_font(13)
FONT_SMALL = get_font(12)

BG = (14, 17, 22)
PANEL_BG = (22, 27, 34)
GRID = (42, 50, 62)
ZERO_LINE = (75, 88, 108)
TEXT = (230, 236, 244)
MUTED = (150, 162, 178)

COL_L = (72, 188, 255)      # Left foot / cyan
COL_R = (255, 122, 92)      # Right foot / coral
COL_PELVIS = (120, 236, 152) # Pelvis / green
COL_HEAD = (245, 208, 96)    # Head / gold
COL_MOCAP = (196, 148, 255)  # Mocap / violet
COL_BEFORE = (255, 96, 112)  # Before / red-pink
COL_AFTER = (88, 232, 148)   # After / bright green

def draw_series(draw, box, xs, ys, y_min, y_max, color, width=2, dashed=False):
    x0, y0, x1, y1 = box
    if not xs or not ys or len(xs) < 2:
        return
    t_min, t_max = xs[0], xs[-1]
    if t_max <= t_min:
        t_max = t_min + 1.0
    pts = []
    for x, y in zip(xs, ys):
        u = (x - t_min) / (t_max - t_min)
        v = (y - y_min) / max(1e-6, (y_max - y_min))
        v = max(0.0, min(1.0, v))
        px = x0 + u * (x1 - x0)
        py = y1 - v * (y1 - y0)
        pts.append((px, py))
    if dashed:
        for i in range(0, len(pts) - 1, 2):
            draw.line([pts[i], pts[i + 1]], fill=color, width=width)
    else:
        draw.line(pts, fill=color, width=width)

def draw_panel_frame(draw, box, title, unit, y_min, y_max, legend_items):
    x0, y0, x1, y1 = box
    draw.rectangle(box, fill=PANEL_BG, outline=GRID, width=1)
    for frac in [0.25, 0.5, 0.75]:
        gy = y0 + frac * (y1 - y0)
        draw.line([(x0, gy), (x1, gy)], fill=GRID, width=1)
    if y_min < 0 < y_max:
        zy = y1 - (-y_min / (y_max - y_min)) * (y1 - y0)
        draw.line([(x0, zy), (x1, zy)], fill=ZERO_LINE, width=1)
    draw.text((x0 + 10, y0 + 6), f"{title} ({unit})", fill=TEXT, font=FONT_SUB)
    draw.text((x0 - 58, y0 + 2), f"{y_max:+.1f}", fill=MUTED, font=FONT_SMALL)
    draw.text((x0 - 58, y1 - 14), f"{y_min:+.1f}", fill=MUTED, font=FONT_SMALL)
    lx = x1 - 12
    for label, col in reversed(legend_items):
        tw = len(label) * 8 + 26
        lx -= tw
        draw.line([(lx, y0 + 14), (lx + 16, y0 + 14)], fill=col, width=3)
        draw.text((lx + 22, y0 + 6), label, fill=col, font=FONT_SMALL)

def plot_single_run(run_key, mocap_key, out_name, title_prefix):
    run = cur_data["runs"][run_key]
    mocap = cur_data["mocap"][mocap_key] if mocap_key else None
    samples = run["samples3Cycles"]
    ts = [s["t"] for s in samples]

    W, H = 2000, 1480
    img = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)

    # Header + summary metrics
    draw.text((76, 20), f"{title_prefix} — {run['name']} ({run['speed']} m/s) [{tag.upper()}]", fill=TEXT, font=FONT_TITLE)
    stats = (
        f"Cadence: {run['cadenceStepsPerMin']} steps/min  |  "
        f"Step L/R: {run['stepDurationLMean']*1000:.1f} ms / {run['stepDurationRMean']*1000:.1f} ms (ratio {run['stepDurationRatioLR']:.3f}, CV {run['stepDurationCVPct']:.1f}%)  |  "
        f"Step Len L/R: {run['stepLengthLMean']:.3f} m / {run['stepLengthRMean']:.3f} m  |  "
        f"DS: {run['doubleSupportPct']:.1f}%  Flight: {run['flightPct']:.1f}%\n"
        f"Pelvis Amp: {run['pelvisAmpCm']:.2f} cm (sub-harm {run['harmonicSubRatio']:.2f})  |  "
        f"Head Bob: {run['headAmpCm']:.2f} cm  |  "
        f"Max |ay|: {run['pelvisMaxAy']:.2f} m/s²  |  "
        f"Touchdown Jerk: {run['touchdownMaxJerk']:.1f} m/s³  |  "
        f"Contact Foot Speed: {run['contactFootSpeedMean']:.3f} m/s (max {run['contactFootSpeedMax']:.3f})  |  "
        f"Arm vs Opp Leg: r={run['armOppositeLegCorr']:.2f} (lag {run['armPhaseLagDeg']:+.1f}°)"
    )
    draw.text((76, 52), stats, fill=MUTED, font=FONT_AXIS)

    panels = [
        ("1. Foot Contact Intervals & Lift Height", "cm", -1.5, 24.0),
        ("2. Pelvis Vertical Displacement (COM) & Head Bob", "cm", -6.0, 6.0),
        ("3. Ground Reaction Proxy: Pelvis Vertical Accel & Touchdown Jerk", "m/s²", -18.0, 18.0),
        ("4. Foot World Speed & Contact Velocity (Target ≈ 0 at Touchdown)", "m/s", -0.5, 16.0),
        ("5. Arm Swing Phase vs. Opposite Leg Forward Swing", "cm", -45.0, 45.0),
    ]

    top0 = 108
    ph = 240
    gap = 26
    x0, x1 = 76, W - 36

    for idx, (ptitle, unit, ymin, ymax) in enumerate(panels):
        y0 = top0 + idx * (ph + gap)
        y1 = y0 + ph
        box = (x0, y0, x1, y1)

        if idx == 0:
            draw_panel_frame(draw, box, ptitle, unit, ymin, ymax, [("Left Foot Y", COL_L), ("Right Foot Y", COL_R), ("Mocap L", COL_MOCAP)])
            # Draw contact bars at bottom of panel
            t_max = ts[-1] if ts else 1.0
            for i in range(len(samples) - 1):
                u0 = ts[i] / t_max
                u1 = ts[i + 1] / t_max
                px0 = x0 + u0 * (x1 - x0)
                px1 = x0 + u1 * (x1 - x0)
                if samples[i]["plantedL"]:
                    draw.rectangle((px0, y1 - 14, px1, y1 - 8), fill=(40, 110, 155))
                if samples[i]["plantedR"]:
                    draw.rectangle((px0, y1 - 7, px1, y1 - 1), fill=(155, 70, 55))
            if mocap:
                mts = [s["t"] * (ts[-1] / max(1e-6, mocap["samples"][-1]["t"])) for s in mocap["samples"]]
                draw_series(draw, box, mts, [s["footLYCm"] for s in mocap["samples"]], ymin, ymax, COL_MOCAP, width=2, dashed=True)
            draw_series(draw, box, ts, [s["footLYCm"] for s in samples], ymin, ymax, COL_L, width=3)
            draw_series(draw, box, ts, [s["footRYCm"] for s in samples], ymin, ymax, COL_R, width=3)

        elif idx == 1:
            draw_panel_frame(draw, box, ptitle, unit, ymin, ymax, [("Pelvis ΔY", COL_PELVIS), ("Head ΔY", COL_HEAD), ("Mocap Pelvis ΔY", COL_MOCAP)])
            if mocap:
                mts = [s["t"] * (ts[-1] / max(1e-6, mocap["samples"][-1]["t"])) for s in mocap["samples"]]
                draw_series(draw, box, mts, [s["pelvisYCm"] for s in mocap["samples"]], ymin, ymax, COL_MOCAP, width=2, dashed=True)
            draw_series(draw, box, ts, [s["pelvisYCm"] for s in samples], ymin, ymax, COL_PELVIS, width=3)
            draw_series(draw, box, ts, [s["headYCm"] for s in samples], ymin, ymax, COL_HEAD, width=2)

        elif idx == 2:
            draw_panel_frame(draw, box, ptitle, unit, ymin, ymax, [("Pelvis ay (m/s²)", COL_PELVIS), ("Pelvis Jerk / 40", COL_R), ("Mocap ay", COL_MOCAP)])
            if mocap:
                mts = [s["t"] * (ts[-1] / max(1e-6, mocap["samples"][-1]["t"])) for s in mocap["samples"]]
                draw_series(draw, box, mts, [s["pelvisAy"] for s in mocap["samples"]], ymin, ymax, COL_MOCAP, width=2, dashed=True)
            draw_series(draw, box, ts, [s["pelvisJy"] / 40.0 for s in samples], ymin, ymax, COL_R, width=2)
            draw_series(draw, box, ts, [s["pelvisAy"] for s in samples], ymin, ymax, COL_PELVIS, width=3)

        elif idx == 3:
            draw_panel_frame(draw, box, ptitle, unit, ymin, ymax, [("Left Foot Speed", COL_L), ("Right Foot Speed", COL_R)])
            draw_series(draw, box, ts, [s["footLSpeed"] for s in samples], ymin, ymax, COL_L, width=2)
            draw_series(draw, box, ts, [s["footRSpeed"] for s in samples], ymin, ymax, COL_R, width=2)

        elif idx == 4:
            draw_panel_frame(draw, box, ptitle, unit, ymin, ymax, [("Left Hand Fwd ×2", COL_L), ("Right Leg Fwd", COL_R), ("Right Hand Fwd ×2", COL_HEAD)])
            draw_series(draw, box, ts, [s["legRFwdCm"] for s in samples], ymin, ymax, COL_R, width=3)
            draw_series(draw, box, ts, [s["handLFwdCm"] * 2.0 for s in samples], ymin, ymax, COL_L, width=3)
            draw_series(draw, box, ts, [s["handRFwdCm"] * 2.0 for s in samples], ymin, ymax, COL_HEAD, width=2, dashed=True)

    # Time axis ticks
    t_max = ts[-1] if ts else 1.0
    for k in range(11):
        u = k / 10.0
        px = x0 + u * (x1 - x0)
        draw.text((px - 14, H - 28), f"{u * t_max:.2f}s", fill=MUTED, font=FONT_SMALL)

    img.save(os.path.join(OUT_DIR, out_name))
    print(f"Saved {out_name}")

def plot_overlay_comparison(run_key, mocap_key, out_name, title_prefix):
    if not before_data:
        return
    b_run = before_data["runs"][run_key]
    a_run = cur_data["runs"][run_key]
    mocap = cur_data["mocap"][mocap_key] if mocap_key else None

    b_s = b_run["samples3Cycles"]
    a_s = a_run["samples3Cycles"]
    b_ts = [s["t"] for s in b_s]
    a_ts = [s["t"] for s in a_s]

    W, H = 2000, 1480
    img = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)

    draw.text((76, 20), f"{title_prefix} — BEFORE vs. AFTER vs. MOCAP ({a_run['speed']} m/s)", fill=TEXT, font=FONT_TITLE)
    stats = (
        f"BEFORE: L/R Step Ratio {b_run['stepDurationRatioLR']:.3f} ({b_run['stepDurationLMean']*1000:.0f}/{b_run['stepDurationRMean']*1000:.0f} ms, CV {b_run['stepDurationCVPct']:.1f}%) | "
        f"Sub-harm {b_run['harmonicSubRatio']:.2f} | TD Jerk {b_run['touchdownMaxJerk']:.0f} m/s³ | Contact Vel {b_run['contactFootSpeedMax']:.3f} m/s\n"
        f"AFTER:  L/R Step Ratio {a_run['stepDurationRatioLR']:.3f} ({a_run['stepDurationLMean']*1000:.0f}/{a_run['stepDurationRMean']*1000:.0f} ms, CV {a_run['stepDurationCVPct']:.1f}%) | "
        f"Sub-harm {a_run['harmonicSubRatio']:.2f} | TD Jerk {a_run['touchdownMaxJerk']:.0f} m/s³ | Contact Vel {a_run['contactFootSpeedMax']:.3f} m/s"
    )
    draw.text((76, 52), stats, fill=MUTED, font=FONT_AXIS)

    panels = [
        ("1. Pelvis Vertical Curve (COM): Before vs. After vs. Real MoCap", "cm", -6.0, 6.0),
        ("2. Pelvis Vertical Acceleration (Ground Reaction Proxy)", "m/s²", -18.0, 18.0),
        ("3. Pelvis Vertical Jerk (Touchdown 'Boom' Impulse)", "m/s³", -700.0, 700.0),
        ("4. Foot Lift Curves (After L/R vs. Before L/R)", "cm", -1.5, 24.0),
        ("5. Foot Speed & Contact Velocity (Before vs. After)", "m/s", -0.5, 16.0),
    ]

    top0 = 108
    ph = 240
    gap = 26
    x0, x1 = 76, W - 36

    for idx, (ptitle, unit, ymin, ymax) in enumerate(panels):
        y0 = top0 + idx * (ph + gap)
        y1 = y0 + ph
        box = (x0, y0, x1, y1)

        if idx == 0:
            draw_panel_frame(draw, box, ptitle, unit, ymin, ymax, [("Before Pelvis", COL_BEFORE), ("After Pelvis", COL_AFTER), ("Real MoCap", COL_MOCAP)])
            if mocap:
                mts = [s["t"] * (a_ts[-1] / max(1e-6, mocap["samples"][-1]["t"])) for s in mocap["samples"]]
                draw_series(draw, box, mts, [s["pelvisYCm"] for s in mocap["samples"]], ymin, ymax, COL_MOCAP, width=2, dashed=True)
            draw_series(draw, box, b_ts, [s["pelvisYCm"] for s in b_s], ymin, ymax, COL_BEFORE, width=2)
            draw_series(draw, box, a_ts, [s["pelvisYCm"] for s in a_s], ymin, ymax, COL_AFTER, width=3)

        elif idx == 1:
            draw_panel_frame(draw, box, ptitle, unit, ymin, ymax, [("Before ay", COL_BEFORE), ("After ay", COL_AFTER), ("Real MoCap ay", COL_MOCAP)])
            if mocap:
                mts = [s["t"] * (a_ts[-1] / max(1e-6, mocap["samples"][-1]["t"])) for s in mocap["samples"]]
                draw_series(draw, box, mts, [s["pelvisAy"] for s in mocap["samples"]], ymin, ymax, COL_MOCAP, width=2, dashed=True)
            draw_series(draw, box, b_ts, [s["pelvisAy"] for s in b_s], ymin, ymax, COL_BEFORE, width=2)
            draw_series(draw, box, a_ts, [s["pelvisAy"] for s in a_s], ymin, ymax, COL_AFTER, width=3)

        elif idx == 2:
            draw_panel_frame(draw, box, ptitle, unit, ymin, ymax, [("Before Jerk", COL_BEFORE), ("After Jerk", COL_AFTER)])
            draw_series(draw, box, b_ts, [s["pelvisJy"] for s in b_s], ymin, ymax, COL_BEFORE, width=2)
            draw_series(draw, box, a_ts, [s["pelvisJy"] for s in a_s], ymin, ymax, COL_AFTER, width=3)

        elif idx == 3:
            draw_panel_frame(draw, box, ptitle, unit, ymin, ymax, [("After L", COL_L), ("After R", COL_R), ("Before L (dashed)", COL_BEFORE)])
            draw_series(draw, box, b_ts, [s["footLYCm"] for s in b_s], ymin, ymax, COL_BEFORE, width=2, dashed=True)
            draw_series(draw, box, a_ts, [s["footLYCm"] for s in a_s], ymin, ymax, COL_L, width=3)
            draw_series(draw, box, a_ts, [s["footRYCm"] for s in a_s], ymin, ymax, COL_R, width=3)

        elif idx == 4:
            draw_panel_frame(draw, box, ptitle, unit, ymin, ymax, [("Before L Speed", COL_BEFORE), ("After L Speed", COL_AFTER), ("After R Speed", COL_L)])
            draw_series(draw, box, b_ts, [s["footLSpeed"] for s in b_s], ymin, ymax, COL_BEFORE, width=2, dashed=True)
            draw_series(draw, box, a_ts, [s["footLSpeed"] for s in a_s], ymin, ymax, COL_AFTER, width=3)
            draw_series(draw, box, a_ts, [s["footRSpeed"] for s in a_s], ymin, ymax, COL_L, width=2)

    img.save(os.path.join(OUT_DIR, out_name))
    print(f"Saved {out_name}")

plot_single_run("survivorWalk", "walk", f"walk-curves-{tag}.png", "Survivor Walk")
plot_single_run("survivorWalkStage", "walk", f"walk-stage-curves-{tag}.png", "Survivor Walk (Characters Stage 1.45 m/s)")
plot_single_run("survivorRun", "run", f"run-curves-{tag}.png", "Survivor Run")
plot_single_run("survivorSprint", "run", f"sprint-curves-{tag}.png", "Survivor Sprint")
plot_single_run("soldierRun", "run", f"soldier-run-curves-{tag}.png", "Soldier Armed Run")

if tag == "after" and before_data:
    plot_overlay_comparison("survivorWalk", "walk", "walk-curves-overlay.png", "Survivor Walk (1.4 m/s)")
    plot_overlay_comparison("survivorWalkStage", "walk", "walk-stage-curves-overlay.png", "Survivor Walk Stage (1.45 m/s)")
    plot_overlay_comparison("survivorRun", "run", "run-curves-overlay.png", "Survivor Run (4.2 m/s)")
    plot_overlay_comparison("survivorSprint", "run", "sprint-curves-overlay.png", "Survivor Sprint (6.3 m/s)")
