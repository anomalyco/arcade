import json
import math
import os
import sys
from PIL import Image, ImageDraw, ImageFont

if len(sys.argv) < 2:
    sys.exit("usage: shamble-crouch-render.py <out-dir> [tag]")
OUT_DIR = sys.argv[1]
TAG = sys.argv[2] if len(sys.argv) > 2 else "after"

with open(os.path.join(OUT_DIR, f"shamble-crouch-{TAG}.json")) as f:
    cur_data = json.load(f)

before_path = os.path.join(OUT_DIR, "shamble-crouch-before.json")
before_data = None
if TAG == "after" and os.path.exists(before_path):
    with open(before_path) as f:
        before_data = json.load(f)

def get_font(size=13):
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

FONT_TITLE = get_font(17)
FONT_SUB = get_font(12)
FONT_SMALL = get_font(10)
FONT_TINY = get_font(9)

COL_SPINE = (244, 247, 252, 255)
COL_LEFT = (56, 182, 255, 255)      # Left limbs blue
COL_RIGHT = (255, 120, 73, 255)     # Right limbs orange
COL_WEAPON = (245, 208, 96, 255)    # Weapon gold
COL_JOINT = (255, 255, 255, 255)

COL_MOCAP = (72, 232, 138, 220)     # Reference green
COL_MOCAP_L = (64, 215, 150, 210)
COL_MOCAP_R = (110, 240, 120, 210)
COL_WILLIAMS = (148, 172, 200, 165) # Secondary reference muted grey-blue
COL_BEFORE = (255, 92, 116, 215)    # Before red-pink

BG_DARK = (14, 18, 24, 255)
CELL_BG = (20, 25, 33, 255)
GRID_LINE = (42, 52, 66, 255)
TORSO_BOX = (255, 215, 110, 70)

PHASE_LABELS_SHAMBLE = [
    "0/8 L Contact",
    "1/8 L Catch/Dn",
    "2/8 L DragStart",
    "3/8 L Hitch/Up",
    "4/8 R ShortPlt",
    "5/8 R Buckle",
    "6/8 R FallFwd",
    "7/8 R Lunge",
]

PHASE_LABELS_CROUCH = [
    "0/8 L Contact",
    "1/8 L CrouchDn",
    "2/8 L ToeOff",
    "3/8 LowFlight",
    "4/8 R Contact",
    "5/8 R CrouchDn",
    "6/8 R ToeOff",
    "7/8 LowFlight",
]

SEGMENTS = cur_data["segments"]
JOINTS = cur_data["joints"]

def norm_to_px(pt, cw, ch, ground_y=-1.0):
    scale = (ch - 46) / 2.15
    cx = cw * 0.5
    cy_origin = (ch - 22) + ground_y * scale
    px = cx + pt[0] * scale
    py = cy_origin - pt[1] * scale
    return (px, py)

def draw_torso_silhouette(draw, phase_sample, view, cw, ch, x_off=0, y_off=0):
    pts = phase_sample["orthoSide"]["points"] if view == "side" else phase_sample["orthoFront"]["points"]
    ground_y = phase_sample["orthoSide"]["groundY"]
    waist = pts["waist"]
    neck = pts["neck"]
    scale = (ch - 46) / 2.15
    half_w_norm = (0.14 / 0.86) if view == "side" else (0.20 / 0.86)
    wx, wy = norm_to_px(waist, cw, ch, ground_y)
    nx, ny = norm_to_px(neck, cw, ch, ground_y)
    dx = half_w_norm * scale
    x0 = min(wx, nx) - dx
    x1 = max(wx, nx) + dx
    y0 = min(wy, ny)
    y1 = max(wy, ny)
    draw.rectangle([(x_off + x0, y_off + y0), (x_off + x1, y_off + y1)], outline=TORSO_BOX, width=1)

def draw_skeleton_2d(
    draw,
    phase_sample,
    view,
    cw,
    ch,
    x_off=0,
    y_off=0,
    style="ours",
    width_scale=1.0,
    draw_dots=True,
):
    ortho = phase_sample["orthoSide"] if view == "side" else phase_sample["orthoFront"]
    pts = ortho["points"]
    ground_y = ortho["groundY"]
    order = ["left", "spine", "right", "weapon"] if view == "side" else ["spine", "left", "right", "weapon"]

    for grp in order:
        for seg in SEGMENTS:
            if seg["group"] != grp:
                continue
            p0 = pts.get(seg["from"])
            p1 = pts.get(seg["to"])
            if not p1 and seg["to"] in ("ballL", "ballR"):
                p1 = pts.get("toeL" if seg["to"] == "ballL" else "toeR")
            if not p0 or not p1:
                continue
            a = norm_to_px(p0, cw, ch, ground_y)
            b = norm_to_px(p1, cw, ch, ground_y)
            a = (a[0] + x_off, a[1] + y_off)
            b = (b[0] + x_off, b[1] + y_off)

            if style == "ours":
                col = COL_LEFT if grp == "left" else COL_RIGHT if grp == "right" else COL_SPINE
                w = max(1, int(round((3.5 if grp in ("left", "right") else 3.0) * width_scale)))
            elif style == "mocap":
                col = COL_MOCAP_L if grp == "left" else COL_MOCAP_R if grp == "right" else COL_MOCAP
                w = max(1, int(round(2.2 * width_scale)))
            elif style == "williams":
                col = COL_WILLIAMS
                w = max(1, int(round(1.6 * width_scale)))
            elif style == "before":
                col = COL_BEFORE
                w = max(1, int(round(2.2 * width_scale)))
            else:
                col = COL_SPINE
                w = 2

            draw.line([a, b], fill=col, width=w)

    if style == "ours" and "gunGrip" in pts and "gunMuzzle" in pts:
        a = norm_to_px(pts["gunGrip"], cw, ch, ground_y)
        b = norm_to_px(pts["gunMuzzle"], cw, ch, ground_y)
        draw.line([(a[0] + x_off, a[1] + y_off), (b[0] + x_off, b[1] + y_off)], fill=COL_WEAPON, width=3)

    if draw_dots:
        r = 2.5 if style == "ours" else 1.8
        for jid in JOINTS:
            p = pts.get(jid)
            if not p:
                continue
            px, py = norm_to_px(p, cw, ch, ground_y)
            px += x_off
            py += y_off
            if style == "ours":
                dcol = COL_LEFT if jid.endswith("L") else COL_RIGHT if jid.endswith("R") else COL_JOINT
            elif style == "mocap":
                dcol = COL_MOCAP
            elif style == "before":
                dcol = COL_BEFORE
            else:
                dcol = COL_WILLIAMS
            draw.ellipse((px - r, py - r, px + r, py + r), fill=dcol)

def render_transparent_line_sheet(cycle_key, view, num_phases, out_name):
    cycle = cur_data["cycles"][cycle_key]
    phases = cycle["phases8"] if num_phases == 8 else cycle["phases16"]
    cols = 8
    rows = 1 if num_phases == 8 else 2
    cw, ch = 160, 240
    W, H = cols * cw, rows * ch
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    for idx, ph in enumerate(phases):
        c = idx % cols
        r = idx // cols
        x0, y0 = c * cw, r * ch
        ground_y = ph["orthoSide"]["groundY"]
        _, gy = norm_to_px((0, ground_y), cw, ch, ground_y)
        ox, oy = norm_to_px((0, 0), cw, ch, ground_y)
        draw.line([(x0 + 14, y0 + gy), (x0 + cw - 14, y0 + gy)], fill=(120, 140, 165, 110), width=1)
        draw.line([(x0 + ox - 6, y0 + oy), (x0 + ox + 6, y0 + oy)], fill=(255, 255, 255, 90), width=1)
        draw.line([(x0 + ox, y0 + oy - 6), (x0 + ox, y0 + oy + 6)], fill=(255, 255, 255, 90), width=1)
        draw_skeleton_2d(draw, ph, view, cw, ch, x0, y0, style="ours", width_scale=1.0, draw_dots=True)
        draw.text((x0 + 6, y0 + 4), f"φ={idx}/{num_phases}", fill=(235, 242, 250, 230), font=FONT_TINY)

    img.save(os.path.join(OUT_DIR, out_name))
    print(f"Saved {out_name}")

def render_before_ref_after_sheet(cycle_key, ref_key, mocap_key, comp_key, view, out_name, title, is_shamble=True):
    a_cycle = cur_data["cycles"][cycle_key]
    ref = cur_data["references"][ref_key]
    mocap = cur_data["references"][mocap_key] if mocap_key else None
    a_comp = cur_data["comparisons"][comp_key]
    a_gait = cur_data["gaitMetrics"][cycle_key]

    b_cycle = before_data["cycles"][cycle_key] if before_data else a_cycle
    b_comp = before_data["comparisons"][comp_key] if before_data else a_comp
    b_gait = before_data["gaitMetrics"][cycle_key] if before_data else a_gait

    cw, ch = 160, 225
    header_h = 68
    W = cw * 8
    H = header_h + ch * 3
    img = Image.new("RGBA", (W, H), BG_DARK)
    draw = ImageDraw.Draw(img)

    b_rms = b_comp["angleRmseDeg"]
    a_rms = a_comp["angleRmseDeg"]
    draw.text((14, 8), f"{title} — BEFORE | REFERENCE | AFTER ({view.upper()} VIEW)", fill=COL_SPINE, font=FONT_TITLE)
    draw.text(
        (14, 30),
        f"BEFORE: Overall RMSE {b_rms['overallAngleRmse']:.1f}° (Arm {b_rms['meanArmAngleRmse']:.1f}°, Leg {b_rms['meanLegAngleRmse']:.1f}°) | "
        f"Cadence {b_gait['cadenceStepsPerMin']:.0f} spm | Lift L/R {b_gait['footLiftLMaxCm']:.1f}/{b_gait['footLiftRMaxCm']:.1f} cm | "
        f"Trunk {b_gait['trunkPitchMeanDeg']:.1f}° (Δ{b_gait['trunkPitchRangeDeg']:.1f}°) | Knee [{b_gait['stanceKneeMinDeg']:.0f}°..{b_gait['swingKneeMaxDeg']:.0f}°]",
        fill=COL_BEFORE,
        font=FONT_SMALL,
    )
    draw.text(
        (14, 46),
        f"AFTER:  Overall RMSE {a_rms['overallAngleRmse']:.1f}° (Arm {a_rms['meanArmAngleRmse']:.1f}°, Leg {a_rms['meanLegAngleRmse']:.1f}°) | "
        f"Cadence {a_gait['cadenceStepsPerMin']:.0f} spm | Lift L/R {a_gait['footLiftLMaxCm']:.1f}/{a_gait['footLiftRMaxCm']:.1f} cm | "
        f"Trunk {a_gait['trunkPitchMeanDeg']:.1f}° (Δ{a_gait['trunkPitchRangeDeg']:.1f}°) | Knee [{a_gait['stanceKneeMinDeg']:.0f}°..{a_gait['swingKneeMaxDeg']:.0f}°]",
        fill=COL_MOCAP,
        font=FONT_SMALL,
    )

    labels = PHASE_LABELS_SHAMBLE if is_shamble else PHASE_LABELS_CROUCH

    for idx in range(8):
        b_ph = b_cycle["phases8"][idx]
        r_ph = ref["phases8"][idx]
        m_ph = mocap["phases8"][idx] if mocap else None
        a_ph = a_cycle["phases8"][idx]
        x0 = idx * cw
        ground_y = a_ph["orthoSide"]["groundY"]
        _, gy = norm_to_px((0, ground_y), cw, ch, ground_y)

        # Row 0: BEFORE
        y0 = header_h
        draw.rectangle((x0, y0, x0 + cw - 1, y0 + ch - 1), fill=CELL_BG, outline=GRID_LINE, width=1)
        draw.line([(x0 + 10, y0 + gy), (x0 + cw - 10, y0 + gy)], fill=(70, 86, 106, 200), width=1)
        draw_torso_silhouette(draw, b_ph, view, cw, ch, x0, y0)
        draw_skeleton_2d(draw, r_ph, view, cw, ch, x0, y0, style="williams", width_scale=0.9, draw_dots=False)
        draw_skeleton_2d(draw, b_ph, view, cw, ch, x0, y0, style="ours", width_scale=1.0, draw_dots=True)
        ba = b_ph["angles"]
        draw.text((x0 + 6, y0 + 4), f"BEFORE · {labels[idx]}", fill=COL_BEFORE, font=FONT_TINY)
        draw.text((x0 + 6, y0 + 16), f"tr:{ba['trunkPitchDeg']:.0f}° knL:{ba['kneeFlexL']:.0f}° R:{ba['kneeFlexR']:.0f}°", fill=COL_LEFT, font=FONT_TINY)
        draw.text((x0 + 6, y0 + 27), f"shL:{ba['shoulderFlexL']:+.0f}° shR:{ba['shoulderFlexR']:+.0f}°", fill=COL_RIGHT, font=FONT_TINY)

        # Row 1: REFERENCE (Key-pose reference green + Mocap grey-blue)
        y1 = header_h + ch
        draw.rectangle((x0, y1, x0 + cw - 1, y1 + ch - 1), fill=(17, 23, 30, 255), outline=GRID_LINE, width=1)
        draw.line([(x0 + 10, y1 + gy), (x0 + cw - 10, y1 + gy)], fill=(70, 86, 106, 200), width=1)
        draw_torso_silhouette(draw, r_ph, view, cw, ch, x0, y1)
        if m_ph:
            draw_skeleton_2d(draw, m_ph, view, cw, ch, x0, y1, style="williams", width_scale=1.0, draw_dots=True)
        draw_skeleton_2d(draw, r_ph, view, cw, ch, x0, y1, style="mocap", width_scale=1.15, draw_dots=True)
        ra = r_ph["angles"]
        draw.text((x0 + 6, y1 + 4), f"REFERENCE · {labels[idx]}", fill=COL_MOCAP, font=FONT_TINY)
        draw.text((x0 + 6, y1 + 16), f"tr:{ra['trunkPitchDeg']:.0f}° knL:{ra['kneeFlexL']:.0f}° R:{ra['kneeFlexR']:.0f}°", fill=COL_MOCAP, font=FONT_TINY)
        draw.text((x0 + 6, y1 + 27), f"shL:{ra['shoulderFlexL']:+.0f}° shR:{ra['shoulderFlexR']:+.0f}°", fill=(165, 220, 185, 255), font=FONT_TINY)

        # Row 2: AFTER (with Reference overlay)
        y2 = header_h + ch * 2
        draw.rectangle((x0, y2, x0 + cw - 1, y2 + ch - 1), fill=CELL_BG, outline=GRID_LINE, width=1)
        draw.line([(x0 + 10, y2 + gy), (x0 + cw - 10, y2 + gy)], fill=(70, 86, 106, 200), width=1)
        draw_torso_silhouette(draw, a_ph, view, cw, ch, x0, y2)
        draw_skeleton_2d(draw, r_ph, view, cw, ch, x0, y2, style="mocap", width_scale=0.95, draw_dots=False)
        draw_skeleton_2d(draw, a_ph, view, cw, ch, x0, y2, style="ours", width_scale=1.05, draw_dots=True)
        aa = a_ph["angles"]
        draw.text((x0 + 6, y2 + 4), f"AFTER · {labels[idx]}", fill=COL_SPINE, font=FONT_TINY)
        draw.text((x0 + 6, y2 + 16), f"tr:{aa['trunkPitchDeg']:.0f}° knL:{aa['kneeFlexL']:.0f}° R:{aa['kneeFlexR']:.0f}°", fill=COL_LEFT, font=FONT_TINY)
        draw.text((x0 + 6, y2 + 27), f"shL:{aa['shoulderFlexL']:+.0f}° shR:{aa['shoulderFlexR']:+.0f}°", fill=COL_RIGHT, font=FONT_TINY)

    img.convert("RGB").save(os.path.join(OUT_DIR, out_name))
    print(f"Saved {out_name}")

def draw_curve(draw, box, us, ys, ymin, ymax, col, width=2, dashed=False):
    x0, y0, x1, y1 = box
    pts = []
    for u, y in zip(us, ys):
        v = (y - ymin) / max(1e-6, ymax - ymin)
        v = max(0.0, min(1.0, v))
        px = x0 + u * (x1 - x0)
        py = y1 - v * (y1 - y0)
        pts.append((px, py))
    if len(pts) < 2:
        return
    if dashed:
        for i in range(0, len(pts) - 1, 2):
            draw.line([pts[i], pts[i + 1]], fill=col, width=width)
    else:
        draw.line(pts, fill=col, width=width)

def draw_plot_panel(draw, box, title, ymin, ymax, legend, zero_line=True):
    x0, y0, x1, y1 = box
    draw.rectangle(box, fill=CELL_BG, outline=GRID_LINE, width=1)
    for frac in [0.25, 0.5, 0.75]:
        gy = y0 + frac * (y1 - y0)
        draw.line([(x0, gy), (x1, gy)], fill=(34, 42, 54, 255), width=1)
    for p_idx in range(1, 8):
        gx = x0 + (p_idx / 8.0) * (x1 - x0)
        draw.line([(gx, y0), (gx, y1)], fill=(30, 38, 48, 255), width=1)
    if zero_line and ymin < 0 < ymax:
        zy = y1 - (-ymin / (ymax - ymin)) * (y1 - y0)
        draw.line([(x0, zy), (x1, zy)], fill=(75, 90, 112, 255), width=1)
    draw.text((x0 + 8, y0 + 5), title, fill=COL_SPINE, font=FONT_SUB)
    draw.text((x0 + 6, y0 + 22), f"{ymax:+.0f}", fill=(140, 155, 175, 255), font=FONT_TINY)
    draw.text((x0 + 6, y1 - 14), f"{ymin:+.0f}", fill=(140, 155, 175, 255), font=FONT_TINY)
    lx = x1 - 8
    for lbl, lcol in reversed(legend):
        tw = len(lbl) * 6 + 20
        lx -= tw
        draw.line([(lx, y0 + 11), (lx + 12, y0 + 11)], fill=lcol, width=2)
        draw.text((lx + 15, y0 + 5), lbl, fill=lcol, font=FONT_TINY)

def render_cycle_curves(cycle_key, ref_key, mocap_key, comp_key, out_name, title):
    cycle = cur_data["cycles"][cycle_key]
    ref = cur_data["references"][ref_key]
    mocap = cur_data["references"][mocap_key] if mocap_key else None
    comp = cur_data["comparisons"][comp_key]
    b_cycle = before_data["cycles"][cycle_key] if before_data else None
    b_comp = before_data["comparisons"][comp_key] if before_data else None

    W, H = 1280, 920
    img = Image.new("RGBA", (W, H), BG_DARK)
    draw = ImageDraw.Draw(img)

    rms = comp["angleRmseDeg"]
    draw.text((20, 10), f"{title} — Joint Angles & Gait Kinematics Over Cycle", fill=COL_SPINE, font=FONT_TITLE)
    if b_comp:
        br = b_comp["angleRmseDeg"]
        sub = (
            f"BEFORE -> AFTER Overall Angle RMSE: {br['overallAngleRmse']:.1f}° -> {rms['overallAngleRmse']:.1f}° "
            f"| Arm RMSE: {br['meanArmAngleRmse']:.1f}° -> {rms['meanArmAngleRmse']:.1f}° "
            f"| Leg RMSE: {br['meanLegAngleRmse']:.1f}° -> {rms['meanLegAngleRmse']:.1f}° "
            f"| Side 2D RMSE: {b_comp['positionRmse']['side2DNorm']:.3f} -> {comp['positionRmse']['side2DNorm']:.3f}"
        )
    else:
        sub = (
            f"Overall Angle RMSE: {rms['overallAngleRmse']:.1f}° | Arm RMSE: {rms['meanArmAngleRmse']:.1f}° "
            f"| Leg RMSE: {rms['meanLegAngleRmse']:.1f}° | Side 2D RMSE: {comp['positionRmse']['side2DNorm']:.3f}"
        )
    draw.text((20, 34), sub, fill=(175, 190, 210, 255), font=FONT_SMALL)

    o_s = cycle["denseSamples"]
    r_s = ref["denseSamples"]
    m_s = mocap["denseSamples"] if mocap else None
    b_s = b_cycle["denseSamples"] if b_cycle else None
    us = [s["phaseFrac"] for s in o_s]

    pw, ph = 604, 256
    x_cols = [20, 656]
    y_rows = [62, 344, 626]

    # Panel 0: Trunk Pitch & Shoulder Roll (Lurch & Cant)
    box0 = (x_cols[0], y_rows[0], x_cols[0] + pw, y_rows[0] + ph)
    leg0 = [("Trunk Pitch", COL_LEFT), ("Sh Roll", COL_RIGHT), ("Ref Pitch", COL_MOCAP)]
    if b_s:
        leg0.insert(0, ("Before Pitch", COL_BEFORE))
    draw_plot_panel(draw, box0, "1. Torso Lurch (Trunk Pitch) & Shoulder Cant (Roll) [deg]", -20, 45, leg0)
    if b_s:
        draw_curve(draw, box0, us, [s["angles"]["trunkPitchDeg"] for s in b_s], -20, 45, COL_BEFORE, width=2, dashed=True)
    if m_s:
        draw_curve(draw, box0, us, [s["angles"]["trunkPitchDeg"] for s in m_s], -20, 45, COL_WILLIAMS, width=2, dashed=True)
    draw_curve(draw, box0, us, [s["angles"]["trunkPitchDeg"] for s in r_s], -20, 45, COL_MOCAP, width=2, dashed=True)
    draw_curve(draw, box0, us, [s["angles"]["shoulderRollDeg"] for s in o_s], -20, 45, COL_RIGHT, width=2)
    draw_curve(draw, box0, us, [s["angles"]["trunkPitchDeg"] for s in o_s], -20, 45, COL_LEFT, width=3)

    # Panel 1: Foot Lift L vs R (Drag & Asymmetry)
    box1 = (x_cols[1], y_rows[0], x_cols[1] + pw, y_rows[0] + ph)
    leg1 = [("Lift L", COL_LEFT), ("Lift R (Drag)", COL_RIGHT), ("Ref L", COL_MOCAP)]
    if b_s:
        leg1.insert(0, ("Before R", COL_BEFORE))
    draw_plot_panel(draw, box1, "2. Foot Clearance L vs R [cm] (Right Foot Drag)", -2, 26, leg1)
    if b_s:
        draw_curve(draw, box1, us, [s["angles"]["footLiftRCm"] for s in b_s], -2, 26, COL_BEFORE, width=2, dashed=True)
    draw_curve(draw, box1, us, [s["angles"]["footLiftLCm"] for s in r_s], -2, 26, COL_MOCAP, width=2, dashed=True)
    draw_curve(draw, box1, us, [s["angles"]["footLiftRCm"] for s in r_s], -2, 26, COL_WILLIAMS, width=2, dashed=True)
    draw_curve(draw, box1, us, [s["angles"]["footLiftLCm"] for s in o_s], -2, 26, COL_LEFT, width=3)
    draw_curve(draw, box1, us, [s["angles"]["footLiftRCm"] for s in o_s], -2, 26, COL_RIGHT, width=3)

    # Panel 2: Shoulder Sagittal Flexion L vs R
    box2 = (x_cols[0], y_rows[1], x_cols[0] + pw, y_rows[1] + ph)
    leg2 = [("Ours Sh L", COL_LEFT), ("Ours Sh R", COL_RIGHT), ("Ref Sh L", COL_MOCAP)]
    if b_s:
        leg2.insert(0, ("Before Sh L", COL_BEFORE))
    draw_plot_panel(draw, box2, "3. Shoulder Flexion L vs R [deg] (Asymmetric Reach)", -75, 75, leg2)
    if b_s:
        draw_curve(draw, box2, us, [s["angles"]["shoulderFlexL"] for s in b_s], -75, 75, COL_BEFORE, width=2, dashed=True)
    draw_curve(draw, box2, us, [s["angles"]["shoulderFlexL"] for s in r_s], -75, 75, COL_MOCAP, width=2, dashed=True)
    draw_curve(draw, box2, us, [s["angles"]["shoulderFlexR"] for s in r_s], -75, 75, COL_WILLIAMS, width=2, dashed=True)
    draw_curve(draw, box2, us, [s["angles"]["shoulderFlexR"] for s in o_s], -75, 75, COL_RIGHT, width=2)
    draw_curve(draw, box2, us, [s["angles"]["shoulderFlexL"] for s in o_s], -75, 75, COL_LEFT, width=3)

    # Panel 3: Elbow Flexion L vs R
    box3 = (x_cols[1], y_rows[1], x_cols[1] + pw, y_rows[1] + ph)
    leg3 = [("Ours Elb L", COL_LEFT), ("Ours Elb R", COL_RIGHT), ("Ref Elb L", COL_MOCAP)]
    if b_s:
        leg3.insert(0, ("Before Elb R", COL_BEFORE))
    draw_plot_panel(draw, box3, "4. Elbow Flexion L vs R [deg]", 0, 130, leg3, zero_line=False)
    if b_s:
        draw_curve(draw, box3, us, [s["angles"]["elbowFlexR"] for s in b_s], 0, 130, COL_BEFORE, width=2, dashed=True)
    draw_curve(draw, box3, us, [s["angles"]["elbowFlexL"] for s in r_s], 0, 130, COL_MOCAP, width=2, dashed=True)
    draw_curve(draw, box3, us, [s["angles"]["elbowFlexR"] for s in o_s], 0, 130, COL_RIGHT, width=2)
    draw_curve(draw, box3, us, [s["angles"]["elbowFlexL"] for s in o_s], 0, 130, COL_LEFT, width=3)

    # Panel 4: Knee Flexion L vs R
    box4 = (x_cols[0], y_rows[2], x_cols[0] + pw, y_rows[2] + ph)
    leg4 = [("Knee L", COL_LEFT), ("Knee R", COL_RIGHT), ("Ref Knee L", COL_MOCAP)]
    if b_s:
        leg4.insert(0, ("Before Knee L", COL_BEFORE))
    draw_plot_panel(draw, box4, "5. Knee Flexion L vs R [deg] (Bent-Knee Stance & Swing)", 0, 130, leg4, zero_line=False)
    if b_s:
        draw_curve(draw, box4, us, [s["angles"]["kneeFlexL"] for s in b_s], 0, 130, COL_BEFORE, width=2, dashed=True)
    draw_curve(draw, box4, us, [s["angles"]["kneeFlexL"] for s in r_s], 0, 130, COL_MOCAP, width=2, dashed=True)
    draw_curve(draw, box4, us, [s["angles"]["kneeFlexR"] for s in o_s], 0, 130, COL_RIGHT, width=2)
    draw_curve(draw, box4, us, [s["angles"]["kneeFlexL"] for s in o_s], 0, 130, COL_LEFT, width=3)

    # Panel 5: Hip Flexion L vs R & Pelvis Bob
    box5 = (x_cols[1], y_rows[2], x_cols[1] + pw, y_rows[2] + ph)
    leg5 = [("Hip L", COL_LEFT), ("Hip R", COL_RIGHT), ("Ref Hip L", COL_MOCAP), ("Bob×5", COL_WEAPON)]
    if b_s:
        leg5.insert(0, ("Before Hip L", COL_BEFORE))
    draw_plot_panel(draw, box5, "6. Hip Flexion L/R [deg] & Pelvis Vertical Bob (×5 cm)", -45, 80, leg5)
    if b_s:
        draw_curve(draw, box5, us, [s["angles"]["hipFlexL"] for s in b_s], -45, 80, COL_BEFORE, width=2, dashed=True)
    draw_curve(draw, box5, us, [s["angles"]["hipFlexL"] for s in r_s], -45, 80, COL_MOCAP, width=2, dashed=True)
    draw_curve(draw, box5, us, [s["angles"]["pelvisBobCm"] * 5.0 for s in o_s], -45, 80, COL_WEAPON, width=2)
    draw_curve(draw, box5, us, [s["angles"]["hipFlexR"] for s in o_s], -45, 80, COL_RIGHT, width=2)
    draw_curve(draw, box5, us, [s["angles"]["hipFlexL"] for s in o_s], -45, 80, COL_LEFT, width=3)

    img.convert("RGB").save(os.path.join(OUT_DIR, out_name))
    print(f"Saved {out_name}")

# 1. Transparent line-rig sheets (8 and 16 phases, side and front)
for key, slug in [
    ("outbreakZombie", "outbreak-zombie"),
    ("blackoutZombie", "blackout-zombie"),
    ("survivorCrouchRun", "crouch-run"),
    ("soldierCrouchRun", "soldier-crouch-run"),
]:
    render_transparent_line_sheet(key, "side", 8, f"line-rig-{slug}-side-{TAG}.png")
    render_transparent_line_sheet(key, "front", 8, f"line-rig-{slug}-front-{TAG}.png")
    render_transparent_line_sheet(key, "side", 16, f"line-rig-{slug}-16-{TAG}.png")

# 2. Cycle curves
render_cycle_curves(
    "outbreakZombie", "williamsShamble", "mocapWalkTired", "outbreakZombieVsShambleRef",
    f"angles-outbreak-zombie-{TAG}.png", f"Outbreak Zombie Shamble (0.95 m/s) [{TAG.upper()}]"
)
render_cycle_curves(
    "blackoutZombie", "williamsShamble", "mocapWalkTired", "blackoutZombieVsShambleRef",
    f"angles-blackout-zombie-{TAG}.png", f"Blackout Zombie Shamble (0.95 m/s) [{TAG.upper()}]"
)
render_cycle_curves(
    "survivorCrouchRun", "williamsCrouchRun", "mocapRunCrouch", "survivorCrouchRunVsCrouchRef",
    f"angles-crouch-run-{TAG}.png", f"Survivor Crouch-Run (4.2 m/s) [{TAG.upper()}]"
)
render_cycle_curves(
    "soldierCrouchRun", "williamsCrouchRun", "mocapRunCrouch", "soldierCrouchRunVsCrouchRef",
    f"angles-soldier-crouch-run-{TAG}.png", f"Soldier Crouch-Run (4.2 m/s) [{TAG.upper()}]"
)

# 3. Before | Reference | After sheets
render_before_ref_after_sheet(
    "outbreakZombie", "williamsShamble", "mocapWalkTired", "outbreakZombieVsShambleRef",
    "side", "before-ref-after-shamble-side.png", "Outbreak Zombie Shamble (0.95 m/s)", is_shamble=True
)
render_before_ref_after_sheet(
    "outbreakZombie", "williamsShamble", "mocapWalkTired", "outbreakZombieVsShambleRef",
    "front", "before-ref-after-shamble-front.png", "Outbreak Zombie Shamble (0.95 m/s)", is_shamble=True
)
render_before_ref_after_sheet(
    "blackoutZombie", "williamsShamble", "mocapWalkTired", "blackoutZombieVsShambleRef",
    "side", "before-ref-after-blackout-zombie-side.png", "Blackout Zombie Shamble (0.95 m/s)", is_shamble=True
)
render_before_ref_after_sheet(
    "survivorCrouchRun", "williamsCrouchRun", "mocapRunCrouch", "survivorCrouchRunVsCrouchRef",
    "side", "before-ref-after-crouch-run-side.png", "Survivor Crouch-Run (4.2 m/s)", is_shamble=False
)
render_before_ref_after_sheet(
    "survivorCrouchRun", "williamsCrouchRun", "mocapRunCrouch", "survivorCrouchRunVsCrouchRef",
    "front", "before-ref-after-crouch-run-front.png", "Survivor Crouch-Run (4.2 m/s)", is_shamble=False
)
render_before_ref_after_sheet(
    "soldierCrouchRun", "williamsCrouchRun", "mocapRunCrouch", "soldierCrouchRunVsCrouchRef",
    "side", "before-ref-after-soldier-crouch-side.png", "Soldier Armed Crouch-Run (4.2 m/s)", is_shamble=False
)

if TAG == "after" and before_data:
    summary = {
        "generatedAt": cur_data["timestamp"],
        "gaitMetrics": {},
        "comparisons": {},
    }
    for k in cur_data["gaitMetrics"]:
        summary["gaitMetrics"][k] = {
            "before": before_data["gaitMetrics"][k],
            "after": cur_data["gaitMetrics"][k],
        }
    for k in cur_data["comparisons"]:
        summary["comparisons"][k] = {
            "before": before_data["comparisons"][k]["angleRmseDeg"],
            "after": cur_data["comparisons"][k]["angleRmseDeg"],
            "side2DBefore": before_data["comparisons"][k]["positionRmse"]["side2DNorm"],
            "side2DAfter": cur_data["comparisons"][k]["positionRmse"]["side2DNorm"],
        }
    with open(os.path.join(OUT_DIR, "shamble-crouch-summary.json"), "w") as sf:
        json.dump(summary, sf, indent=2)
    print("Saved shamble-crouch-summary.json")
