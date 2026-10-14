import json
import math
import os
import sys
from PIL import Image, ImageDraw, ImageFont

OUT_DIR = sys.argv[1] if len(sys.argv) > 1 else "/Users/kit/code/home/artifacts/2026-10-14-pose-diff"
TAG = sys.argv[2] if len(sys.argv) > 2 else "before"

with open(os.path.join(OUT_DIR, f"pose-diff-{TAG}.json")) as f:
    cur_data = json.load(f)

before_path = os.path.join(OUT_DIR, "pose-diff-before.json")
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

# Palette (RGBA)
COL_SPINE = (244, 247, 252, 255)
COL_LEFT = (56, 182, 255, 255)      # Left limbs blue
COL_RIGHT = (255, 120, 73, 255)     # Right limbs orange
COL_WEAPON = (245, 208, 96, 255)    # Weapon gold
COL_JOINT = (255, 255, 255, 255)

COL_MOCAP = (72, 232, 138, 220)     # Reference mocap green
COL_MOCAP_L = (64, 215, 150, 210)
COL_MOCAP_R = (110, 240, 120, 210)
COL_WILLIAMS = (148, 172, 200, 150) # Classic key poses muted grey-blue
COL_BEFORE = (255, 92, 116, 210)    # Before red-pink

BG_DARK = (14, 18, 24, 255)
CELL_BG = (20, 25, 33, 255)
GRID_LINE = (42, 52, 66, 255)
TORSO_BOX = (255, 215, 110, 70)     # Semi-transparent torso silhouette box

PHASE_LABELS_WALK = [
    "0/8 L Contact",
    "1/8 L Down",
    "2/8 L Pass",
    "3/8 L Up",
    "4/8 R Contact",
    "5/8 R Down",
    "6/8 R Pass",
    "7/8 R Up",
]

PHASE_LABELS_RUN = [
    "0/8 L Contact",
    "1/8 L Down",
    "2/8 L ToeOff",
    "3/8 Flight",
    "4/8 R Contact",
    "5/8 R Down",
    "6/8 R ToeOff",
    "7/8 Flight",
]

SEGMENTS = cur_data["segments"]
JOINTS = cur_data["joints"]

def norm_to_px(pt, cw, ch, ground_y=-1.0):
    """Map normalized orthographic coordinates (pelvis at (0,0), hipHeight=1, ground at -1) to cell pixel coordinates."""
    # Vertical span: y in [-1.12, +1.08] -> 2.20 units mapped to ch * 0.80
    scale = (ch - 46) / 2.15
    cx = cw * 0.5
    # Put pelvis origin (y=0) near middle-lower so ground (y=-1) is at ch - 22
    cy_origin = (ch - 22) + ground_y * scale
    px = cx + pt[0] * scale
    py = cy_origin - pt[1] * scale
    return (px, py)

def draw_torso_silhouette(draw, phase_sample, view, cw, ch, x_off=0, y_off=0):
    """Draw the 3D torso box silhouette projected into side/front view so upper-arm occlusion is visible."""
    pts = phase_sample["orthoSide"]["points"] if view == "side" else phase_sample["orthoFront"]["points"]
    ground_y = phase_sample["orthoSide"]["groundY"]
    waist = pts["waist"]
    neck = pts["neck"]
    scale = (ch - 46) / 2.15
    # Torso box is 0.28m deep (-0.14..+0.14 in X) and 0.40m wide (-0.20..+0.20 in Z), HIP=0.86m
    half_w_norm = (0.14 / 0.86) if view == "side" else (0.20 / 0.86)
    wx, wy = norm_to_px(waist, cw, ch, ground_y)
    nx, ny = norm_to_px(neck, cw, ch, ground_y)
    dx = half_w_norm * scale
    box = [
        (x_off + wx - dx, y_off + ny),
        (x_off + wx + dx, y_off + wy),
    ]
    draw.rectangle(box, outline=TORSO_BOX, width=1)

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

    # Draw back limb first (left in side view facing +X, since camera looks along -Z from +Z right side)
    order = ["left", "spine", "right", "weapon"] if view == "side" else ["spine", "left", "right", "weapon"]

    for grp in order:
        for seg in SEGMENTS:
            if seg["group"] != grp:
                continue
            p0 = pts.get(seg["from"])
            p1 = pts.get(seg["to"])
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
                w = max(1, int(round(2.0 * width_scale)))
            elif style == "williams":
                col = COL_WILLIAMS
                w = max(1, int(round(1.5 * width_scale)))
            elif style == "before":
                col = COL_BEFORE
                w = max(1, int(round(2.0 * width_scale)))
            else:
                col = COL_SPINE
                w = 2

            draw.line([a, b], fill=col, width=w)

    # Weapon segment if present
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
                if jid.endswith("L"):
                    dcol = COL_LEFT
                elif jid.endswith("R"):
                    dcol = COL_RIGHT
                else:
                    dcol = COL_JOINT
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
    # Transparent RGBA background as requested in step 1!
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    for idx, ph in enumerate(phases):
        c = idx % cols
        r = idx // cols
        x0, y0 = c * cw, r * ch
        ground_y = ph["orthoSide"]["groundY"]
        _, gy = norm_to_px((0, ground_y), cw, ch, ground_y)
        # Subtle ground & pelvis origin crosshair
        ox, oy = norm_to_px((0, 0), cw, ch, ground_y)
        draw.line([(x0 + 14, y0 + gy), (x0 + cw - 14, y0 + gy)], fill=(120, 140, 165, 110), width=1)
        draw.line([(x0 + ox - 6, y0 + oy), (x0 + ox + 6, y0 + oy)], fill=(255, 255, 255, 90), width=1)
        draw.line([(x0 + ox, y0 + oy - 6), (x0 + ox, y0 + oy + 6)], fill=(255, 255, 255, 90), width=1)
        draw_skeleton_2d(draw, ph, view, cw, ch, x0, y0, style="ours", width_scale=1.0, draw_dots=True)
        draw.text((x0 + 6, y0 + 4), f"φ={idx}/{num_phases}", fill=(235, 242, 250, 230), font=FONT_TINY)

    img.save(os.path.join(OUT_DIR, out_name))
    print(f"Saved {out_name}")

def err_color(dist_norm):
    # dist_norm in hip-height units (1.0 = 86 cm): 0.04 (~3.4 cm) is green, 0.10 (~8.6 cm) is amber, >0.16 (~14 cm) is red
    u = min(1.0, max(0.0, (dist_norm - 0.02) / 0.16))
    if u < 0.5:
        t = u * 2.0
        return (int(72 + 183 * t), int(232 - 32 * t), int(138 - 78 * t), 255)
    else:
        t = (u - 0.5) * 2.0
        return (255, int(200 - 125 * t), int(60 + 20 * t), 255)

def render_overlay_diff_sheet(cycle_key, ref_key, williams_key, comp_key, view, out_name, title):
    cycle = cur_data["cycles"][cycle_key]
    ref = cur_data["references"][ref_key]
    williams = cur_data["references"][williams_key] if williams_key else None
    comp = cur_data["comparisons"][comp_key]

    cw, ch = 160, 235
    header_h = 56
    W = cw * 8
    H = header_h + ch * 2
    img = Image.new("RGBA", (W, H), BG_DARK)
    draw = ImageDraw.Draw(img)

    # Header bar
    rms = comp["angleRmseDeg"]
    kin_o = comp["kinematics"]["ours"]
    kin_r = comp["kinematics"]["ref"]
    draw.text((14, 8), f"{title} [{TAG.upper()}] — View: {view.upper()} (Hip Height = 1, Pelvis Origin)", fill=COL_SPINE, font=FONT_TITLE)
    sub_txt = (
        f"Arm Angle RMSE: {rms['meanArmAngleRmse']:.1f}° (ShFlex {rms['shoulderFlex']:.1f}°, ElbFlex {rms['elbowFlex']:.1f}°, Forearm {rms['forearmPitch']:.1f}°, ShAbd {rms['shoulderAbd']:.1f}°)  |  "
        f"Leg RMSE: {rms['meanLegAngleRmse']:.1f}°  |  "
        f"Ours ShFlex: [{kin_o['shoulderFlexMinDeg']:+.0f}°..{kin_o['shoulderFlexMaxDeg']:+.0f}°] (Mocap [{kin_r['shoulderFlexMinDeg']:+.0f}°..{kin_r['shoulderFlexMaxDeg']:+.0f}°])  "
        f"Elb: [{kin_o['elbowFlexMinDeg']:.0f}°..{kin_o['elbowFlexMaxDeg']:.0f}°]  Lag: {kin_o['armPhaseLagDeg']:+.1f}°"
    )
    draw.text((14, 32), sub_txt, fill=(175, 190, 210, 255), font=FONT_SMALL)

    labels = PHASE_LABELS_WALK if cycle["mode"] == "walk" else PHASE_LABELS_RUN

    for idx in range(8):
        o_ph = cycle["phases8"][idx]
        r_ph = ref["phases8"][idx]
        w_ph = williams["phases8"][idx] if williams else None

        # Row 0: Overlay (Ours solid blue/orange/white over Mocap green + Williams grey + torso silhouette)
        x0 = idx * cw
        y0 = header_h
        draw.rectangle((x0, y0, x0 + cw - 1, y0 + ch - 1), fill=CELL_BG, outline=GRID_LINE, width=1)
        ground_y = o_ph["orthoSide"]["groundY"]
        _, gy = norm_to_px((0, ground_y), cw, ch, ground_y)
        draw.line([(x0 + 10, y0 + gy), (x0 + cw - 10, y0 + gy)], fill=(70, 86, 106, 200), width=1)
        draw_torso_silhouette(draw, o_ph, view, cw, ch, x0, y0)
        if w_ph:
            draw_skeleton_2d(draw, w_ph, view, cw, ch, x0, y0, style="williams", width_scale=1.0, draw_dots=False)
        draw_skeleton_2d(draw, r_ph, view, cw, ch, x0, y0, style="mocap", width_scale=1.1, draw_dots=True)
        draw_skeleton_2d(draw, o_ph, view, cw, ch, x0, y0, style="ours", width_scale=1.1, draw_dots=True)

        draw.text((x0 + 6, y0 + 5), labels[idx], fill=COL_SPINE, font=FONT_SMALL)
        oa = o_ph["angles"]
        ra = r_ph["angles"]
        draw.text(
            (x0 + 6, y0 + 19),
            f"L sh:{oa['shoulderFlexL']:+.0f}°({ra['shoulderFlexL']:+.0f}°) el:{oa['elbowFlexL']:.0f}°",
            fill=COL_LEFT,
            font=FONT_TINY,
        )
        draw.text(
            (x0 + 6, y0 + 30),
            f"R sh:{oa['shoulderFlexR']:+.0f}°({ra['shoulderFlexR']:+.0f}°) el:{oa['elbowFlexR']:.0f}°",
            fill=COL_RIGHT,
            font=FONT_TINY,
        )

        # Row 1: Diff Panel (Faint reference + per-joint error vectors from Ref -> Ours + Δangle table)
        y1 = header_h + ch
        draw.rectangle((x0, y1, x0 + cw - 1, y1 + ch - 1), fill=(16, 20, 27, 255), outline=GRID_LINE, width=1)
        draw.line([(x0 + 10, y1 + gy), (x0 + cw - 10, y1 + gy)], fill=(55, 68, 84, 180), width=1)
        draw_skeleton_2d(draw, r_ph, view, cw, ch, x0, y1, style="williams", width_scale=0.9, draw_dots=False)

        o_pts = o_ph["orthoSide"]["points"] if view == "side" else o_ph["orthoFront"]["points"]
        r_pts = r_ph["orthoSide"]["points"] if view == "side" else r_ph["orthoFront"]["points"]

        arm_err_cm = []
        for jid in JOINTS:
            op = o_pts[jid]
            rp = r_pts[jid]
            dist_norm = math.hypot(op[0] - rp[0], op[1] - rp[1])
            if jid in ("elbowL", "wristL", "elbowR", "wristR"):
                arm_err_cm.append(dist_norm * 86.0)
            col = err_color(dist_norm)
            p_ref = norm_to_px(rp, cw, ch, ground_y)
            p_our = norm_to_px(op, cw, ch, ground_y)
            p_ref = (p_ref[0] + x0, p_ref[1] + y1)
            p_our = (p_our[0] + x0, p_our[1] + y1)
            draw.line([p_ref, p_our], fill=col, width=2)
            draw.ellipse((p_our[0] - 2.5, p_our[1] - 2.5, p_our[0] + 2.5, p_our[1] + 2.5), fill=col)

        d_sh_l = oa["shoulderFlexL"] - ra["shoulderFlexL"]
        d_el_l = oa["elbowFlexL"] - ra["elbowFlexL"]
        d_sh_r = oa["shoulderFlexR"] - ra["shoulderFlexR"]
        d_el_r = oa["elbowFlexR"] - ra["elbowFlexR"]
        mean_arm_cm = sum(arm_err_cm) / max(1, len(arm_err_cm))
        draw.text((x0 + 6, y1 + 5), f"DIFF Vectors (Arm err {mean_arm_cm:.1f}cm)", fill=(210, 220, 232, 255), font=FONT_TINY)
        draw.text((x0 + 6, y1 + 17), f"ΔL sh:{d_sh_l:+.0f}° el:{d_el_l:+.0f}°", fill=err_color(abs(d_sh_l) / 90.0), font=FONT_TINY)
        draw.text((x0 + 6, y1 + 28), f"ΔR sh:{d_sh_r:+.0f}° el:{d_el_r:+.0f}°", fill=err_color(abs(d_sh_r) / 90.0), font=FONT_TINY)

    img.convert("RGB").save(os.path.join(OUT_DIR, out_name))
    print(f"Saved {out_name}")

def render_before_after_overlay_sheet(cycle_key, ref_key, comp_key, view, out_name, title):
    if not before_data:
        return
    b_cycle = before_data["cycles"][cycle_key]
    a_cycle = cur_data["cycles"][cycle_key]
    ref = cur_data["references"][ref_key]
    b_comp = before_data["comparisons"][comp_key]
    a_comp = cur_data["comparisons"][comp_key]

    cw, ch = 160, 225
    header_h = 62
    W = cw * 8
    H = header_h + ch * 3
    img = Image.new("RGBA", (W, H), BG_DARK)
    draw = ImageDraw.Draw(img)

    b_rms = b_comp["angleRmseDeg"]
    a_rms = a_comp["angleRmseDeg"]
    draw.text((14, 8), f"{title} — BEFORE vs. AFTER vs. MOCAP ({view.upper()} VIEW)", fill=COL_SPINE, font=FONT_TITLE)
    draw.text(
        (14, 30),
        f"BEFORE: Mean Arm RMSE {b_rms['meanArmAngleRmse']:.1f}° (ShFlex {b_rms['shoulderFlex']:.1f}°, ElbFlex {b_rms['elbowFlex']:.1f}°, Forearm {b_rms['forearmPitch']:.1f}°) | WristΔX RMSE {b_comp['positionRmse']['wristRelHipXCm']:.1f}cm | 2D RMSE {b_comp['positionRmse']['side2DNorm']:.3f}",
        fill=COL_BEFORE,
        font=FONT_SMALL,
    )
    draw.text(
        (14, 44),
        f"AFTER:  Mean Arm RMSE {a_rms['meanArmAngleRmse']:.1f}° (ShFlex {a_rms['shoulderFlex']:.1f}°, ElbFlex {a_rms['elbowFlex']:.1f}°, Forearm {a_rms['forearmPitch']:.1f}°) | WristΔX RMSE {a_comp['positionRmse']['wristRelHipXCm']:.1f}cm | 2D RMSE {a_comp['positionRmse']['side2DNorm']:.3f}",
        fill=COL_MOCAP,
        font=FONT_SMALL,
    )

    labels = PHASE_LABELS_WALK if a_cycle["mode"] == "walk" else PHASE_LABELS_RUN

    for idx in range(8):
        b_ph = b_cycle["phases8"][idx]
        a_ph = a_cycle["phases8"][idx]
        r_ph = ref["phases8"][idx]
        x0 = idx * cw
        ground_y = a_ph["orthoSide"]["groundY"]
        _, gy = norm_to_px((0, ground_y), cw, ch, ground_y)

        # Row 0: BEFORE vs Mocap
        y0 = header_h
        draw.rectangle((x0, y0, x0 + cw - 1, y0 + ch - 1), fill=CELL_BG, outline=GRID_LINE, width=1)
        draw.line([(x0 + 10, y0 + gy), (x0 + cw - 10, y0 + gy)], fill=(70, 86, 106, 200), width=1)
        draw_torso_silhouette(draw, b_ph, view, cw, ch, x0, y0)
        draw_skeleton_2d(draw, r_ph, view, cw, ch, x0, y0, style="mocap", width_scale=1.0, draw_dots=True)
        draw_skeleton_2d(draw, b_ph, view, cw, ch, x0, y0, style="ours", width_scale=1.0, draw_dots=True)
        ba = b_ph["angles"]
        ra = r_ph["angles"]
        draw.text((x0 + 6, y0 + 4), f"BEFORE {labels[idx]}", fill=COL_BEFORE, font=FONT_TINY)
        draw.text((x0 + 6, y0 + 15), f"L sh:{ba['shoulderFlexL']:+.0f}° el:{ba['elbowFlexL']:.0f}°", fill=COL_LEFT, font=FONT_TINY)

        # Row 1: AFTER vs Mocap
        y1 = header_h + ch
        draw.rectangle((x0, y1, x0 + cw - 1, y1 + ch - 1), fill=CELL_BG, outline=GRID_LINE, width=1)
        draw.line([(x0 + 10, y1 + gy), (x0 + cw - 10, y1 + gy)], fill=(70, 86, 106, 200), width=1)
        draw_torso_silhouette(draw, a_ph, view, cw, ch, x0, y1)
        draw_skeleton_2d(draw, r_ph, view, cw, ch, x0, y1, style="mocap", width_scale=1.0, draw_dots=True)
        draw_skeleton_2d(draw, a_ph, view, cw, ch, x0, y1, style="ours", width_scale=1.0, draw_dots=True)
        aa = a_ph["angles"]
        draw.text((x0 + 6, y1 + 4), f"AFTER {labels[idx]}", fill=COL_MOCAP, font=FONT_TINY)
        draw.text((x0 + 6, y1 + 15), f"L sh:{aa['shoulderFlexL']:+.0f}° el:{aa['elbowFlexL']:.0f}°", fill=COL_LEFT, font=FONT_TINY)

        # Row 2: Direct 3-way overlay (Before red, Mocap green, After blue/orange) + After error vectors
        y2 = header_h + ch * 2
        draw.rectangle((x0, y2, x0 + cw - 1, y2 + ch - 1), fill=(16, 20, 27, 255), outline=GRID_LINE, width=1)
        draw.line([(x0 + 10, y2 + gy), (x0 + cw - 10, y2 + gy)], fill=(55, 68, 84, 180), width=1)
        draw_skeleton_2d(draw, b_ph, view, cw, ch, x0, y2, style="before", width_scale=0.9, draw_dots=False)
        draw_skeleton_2d(draw, r_ph, view, cw, ch, x0, y2, style="mocap", width_scale=1.0, draw_dots=False)
        draw_skeleton_2d(draw, a_ph, view, cw, ch, x0, y2, style="ours", width_scale=1.0, draw_dots=True)
        draw.text((x0 + 6, y2 + 4), "RED:Before GRN:Mocap", fill=(200, 210, 224, 255), font=FONT_TINY)
        draw.text(
            (x0 + 6, y2 + 15),
            f"Δsh:{aa['shoulderFlexL']-ra['shoulderFlexL']:+.0f}°(was {ba['shoulderFlexL']-ra['shoulderFlexL']:+.0f}°)",
            fill=COL_MOCAP,
            font=FONT_TINY,
        )

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

def draw_plot_panel(draw, box, title, ymin, ymax, legend, zero_line=True, band=None):
    x0, y0, x1, y1 = box
    draw.rectangle(box, fill=CELL_BG, outline=GRID_LINE, width=1)
    if band:
        b_lo, b_hi, b_col = band
        v_lo = max(0.0, min(1.0, (b_lo - ymin) / (ymax - ymin)))
        v_hi = max(0.0, min(1.0, (b_hi - ymin) / (ymax - ymin)))
        by0 = y1 - v_hi * (y1 - y0)
        by1 = y1 - v_lo * (y1 - y0)
        draw.rectangle((x0 + 1, by0, x1 - 1, by1), fill=b_col)
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

def render_angle_plots(cycle_key, ref_key, williams_key, comp_key, out_name, title, include_before=False):
    cycle = cur_data["cycles"][cycle_key]
    ref = cur_data["references"][ref_key]
    williams = cur_data["references"][williams_key] if williams_key else None
    comp = cur_data["comparisons"][comp_key]
    b_cycle = before_data["cycles"][cycle_key] if (include_before and before_data) else None
    b_comp = before_data["comparisons"][comp_key] if (include_before and before_data) else None

    W, H = 1280, 920
    img = Image.new("RGBA", (W, H), BG_DARK)
    draw = ImageDraw.Draw(img)

    rms = comp["angleRmseDeg"]
    ko = comp["kinematics"]["ours"]
    kr = comp["kinematics"]["ref"]
    draw.text((20, 10), f"{title} — Joint Angles & Limb Kinematics Over Gait Cycle (0..100%)", fill=COL_SPINE, font=FONT_TITLE)
    if b_comp:
        br = b_comp["angleRmseDeg"]
        sub = (
            f"BEFORE -> AFTER Arm Angle RMSE: {br['meanArmAngleRmse']:.1f}° -> {rms['meanArmAngleRmse']:.1f}° "
            f"(ShFlex {br['shoulderFlex']:.1f}°->{rms['shoulderFlex']:.1f}°, ElbFlex {br['elbowFlex']:.1f}°->{rms['elbowFlex']:.1f}°, "
            f"Forearm {br['forearmPitch']:.1f}°->{rms['forearmPitch']:.1f}°, WristΔX {b_comp['positionRmse']['wristRelHipXCm']:.1f}->{comp['positionRmse']['wristRelHipXCm']:.1f}cm) | "
            f"Leg RMSE: {rms['meanLegAngleRmse']:.1f}° | Opp-Leg Corr: r={ko['armOppositeLegCorr']:.2f} (lag {ko['armPhaseLagDeg']:+.1f}°)"
        )
    else:
        sub = (
            f"Arm Angle RMSE: {rms['meanArmAngleRmse']:.1f}° (ShFlex {rms['shoulderFlex']:.1f}°, ElbFlex {rms['elbowFlex']:.1f}°, Forearm {rms['forearmPitch']:.1f}°, ShAbd {rms['shoulderAbd']:.1f}°) | "
            f"Leg RMSE: {rms['meanLegAngleRmse']:.1f}° | ShFlex: [{ko['shoulderFlexMinDeg']:+.1f}°..{ko['shoulderFlexMaxDeg']:+.1f}°] "
            f"ElbFlex: [{ko['elbowFlexMinDeg']:.1f}°..{ko['elbowFlexMaxDeg']:.1f}°] | Opp-Leg Corr: r={ko['armOppositeLegCorr']:.2f} (lag {ko['armPhaseLagDeg']:+.1f}°)"
        )
    draw.text((20, 34), sub, fill=(175, 190, 210, 255), font=FONT_SMALL)

    o_s = cycle["denseSamples"]
    r_s = ref["denseSamples"]
    w_s = williams["denseSamples"] if williams else None
    b_s = b_cycle["denseSamples"] if b_cycle else None
    us = [s["phaseFrac"] for s in o_s]

    pw = 604
    ph = 256
    x_cols = [20, 656]
    y_rows = [62, 344, 626]
    is_walk = cycle["mode"] == "walk"

    # Panel 0 (0,0): Shoulder Sagittal Flexion / Extension (deg)
    box0 = (x_cols[0], y_rows[0], x_cols[0] + pw, y_rows[0] + ph)
    sh_min, sh_max = (-45, 45) if is_walk else (-90, 40)
    leg0 = [("Ours L", COL_LEFT), ("Ours R", COL_RIGHT), ("Mocap L", COL_MOCAP)]
    if b_s:
        leg0.insert(0, ("Before L", COL_BEFORE))
    elif w_s:
        leg0.append(("Williams L", COL_WILLIAMS))
    draw_plot_panel(draw, box0, "1. Shoulder Sagittal Flex(+)/Ext(-) [deg]", sh_min, sh_max, leg0, band=(-14, 14, (255, 215, 110, 18)))
    if w_s and not b_s:
        draw_curve(draw, box0, us, [s["angles"]["shoulderFlexL"] for s in w_s], sh_min, sh_max, COL_WILLIAMS, width=2, dashed=True)
    if b_s:
        draw_curve(draw, box0, us, [s["angles"]["shoulderFlexL"] for s in b_s], sh_min, sh_max, COL_BEFORE, width=2, dashed=True)
    draw_curve(draw, box0, us, [s["angles"]["shoulderFlexL"] for s in r_s], sh_min, sh_max, COL_MOCAP, width=2, dashed=True)
    draw_curve(draw, box0, us, [s["angles"]["shoulderFlexR"] for s in o_s], sh_min, sh_max, COL_RIGHT, width=2)
    draw_curve(draw, box0, us, [s["angles"]["shoulderFlexL"] for s in o_s], sh_min, sh_max, COL_LEFT, width=3)

    # Panel 1 (1,0): Elbow Flexion (deg)
    box1 = (x_cols[1], y_rows[0], x_cols[1] + pw, y_rows[0] + ph)
    el_min, el_max = (0, 60) if is_walk else (20, 135)
    leg1 = [("Ours L", COL_LEFT), ("Ours R", COL_RIGHT), ("Mocap L", COL_MOCAP)]
    if b_s:
        leg1.insert(0, ("Before L", COL_BEFORE))
    elif w_s:
        leg1.append(("Williams L", COL_WILLIAMS))
    draw_plot_panel(draw, box1, "2. Elbow Flexion Angle [deg] (0°=straight)", el_min, el_max, leg1, zero_line=False)
    if w_s and not b_s:
        draw_curve(draw, box1, us, [s["angles"]["elbowFlexL"] for s in w_s], el_min, el_max, COL_WILLIAMS, width=2, dashed=True)
    if b_s:
        draw_curve(draw, box1, us, [s["angles"]["elbowFlexL"] for s in b_s], el_min, el_max, COL_BEFORE, width=2, dashed=True)
    draw_curve(draw, box1, us, [s["angles"]["elbowFlexL"] for s in r_s], el_min, el_max, COL_MOCAP, width=2, dashed=True)
    draw_curve(draw, box1, us, [s["angles"]["elbowFlexR"] for s in o_s], el_min, el_max, COL_RIGHT, width=2)
    draw_curve(draw, box1, us, [s["angles"]["elbowFlexL"] for s in o_s], el_min, el_max, COL_LEFT, width=3)

    # Panel 2 (0,1): Forearm World Pitch & Shoulder Abduction (deg)
    box2 = (x_cols[0], y_rows[1], x_cols[0] + pw, y_rows[1] + ph)
    fa_min, fa_max = (-40, 75) if is_walk else (-40, 135)
    leg2 = [("Forearm L", COL_LEFT), ("Mocap FA", COL_MOCAP), ("ShAbd L", COL_WEAPON)]
    if b_s:
        leg2.insert(0, ("Before FA", COL_BEFORE))
    draw_plot_panel(draw, box2, "3. Forearm Sagittal Pitch & Shoulder Abduction [deg]", fa_min, fa_max, leg2)
    if b_s:
        draw_curve(draw, box2, us, [s["angles"]["forearmPitchL"] for s in b_s], fa_min, fa_max, COL_BEFORE, width=2, dashed=True)
    draw_curve(draw, box2, us, [s["angles"]["forearmPitchL"] for s in r_s], fa_min, fa_max, COL_MOCAP, width=2, dashed=True)
    draw_curve(draw, box2, us, [s["angles"]["shoulderAbdL"] for s in o_s], fa_min, fa_max, COL_WEAPON, width=2)
    draw_curve(draw, box2, us, [s["angles"]["forearmPitchL"] for s in o_s], fa_min, fa_max, COL_LEFT, width=3)

    # Panel 3 (1,1): Wrist Position Relative to Hip (dX forward & dY vertical, cm)
    box3 = (x_cols[1], y_rows[1], x_cols[1] + pw, y_rows[1] + ph)
    w_min, w_max = (-32, 36) if is_walk else (-28, 52)
    leg3 = [("Wrist ΔX", COL_LEFT), ("Mocap ΔX", COL_MOCAP), ("Wrist ΔY", COL_WEAPON)]
    if b_s:
        leg3.insert(0, ("Before ΔX", COL_BEFORE))
    draw_plot_panel(draw, box3, "4. Left Wrist Relative to Hip (ΔX Fwd & ΔY Up) [cm]", w_min, w_max, leg3, band=(-14, 14, (255, 215, 110, 18)))
    if b_s:
        draw_curve(draw, box3, us, [s["angles"]["wristRelHipL"][0] for s in b_s], w_min, w_max, COL_BEFORE, width=2, dashed=True)
        draw_curve(draw, box3, us, [s["angles"]["wristRelHipL"][1] for s in b_s], w_min, w_max, (255, 140, 150, 160), width=1, dashed=True)
    draw_curve(draw, box3, us, [s["angles"]["wristRelHipL"][0] for s in r_s], w_min, w_max, COL_MOCAP, width=2, dashed=True)
    draw_curve(draw, box3, us, [s["angles"]["wristRelHipL"][1] for s in r_s], w_min, w_max, (140, 235, 180, 170), width=1, dashed=True)
    draw_curve(draw, box3, us, [s["angles"]["wristRelHipL"][1] for s in o_s], w_min, w_max, COL_WEAPON, width=2)
    draw_curve(draw, box3, us, [s["angles"]["wristRelHipL"][0] for s in o_s], w_min, w_max, COL_LEFT, width=3)

    # Panel 4 (0,2): Hip Flexion, Knee Flexion & Ankle Pitch (deg)
    box4 = (x_cols[0], y_rows[2], x_cols[0] + pw, y_rows[2] + ph)
    l_min, l_max = (-35, 90) if is_walk else (-55, 135)
    leg4 = [("Hip L", COL_LEFT), ("Knee L", COL_RIGHT), ("Ankle L", COL_WEAPON), ("Mocap Knee", COL_MOCAP)]
    draw_plot_panel(draw, box4, "5. Left Leg Angles: Hip Flex, Knee Flex & Ankle Pitch [deg]", l_min, l_max, leg4)
    draw_curve(draw, box4, us, [s["angles"]["kneeFlexL"] for s in r_s], l_min, l_max, COL_MOCAP, width=2, dashed=True)
    draw_curve(draw, box4, us, [s["angles"]["hipFlexL"] for s in r_s], l_min, l_max, (120, 210, 255, 140), width=1, dashed=True)
    draw_curve(draw, box4, us, [s["angles"]["anklePitchL"] for s in o_s], l_min, l_max, COL_WEAPON, width=2)
    draw_curve(draw, box4, us, [s["angles"]["kneeFlexL"] for s in o_s], l_min, l_max, COL_RIGHT, width=2)
    draw_curve(draw, box4, us, [s["angles"]["hipFlexL"] for s in o_s], l_min, l_max, COL_LEFT, width=3)

    # Panel 5 (1,2): Phase Coordination: Left Shoulder Flexion vs Opposite (Right) Hip Flexion
    box5 = (x_cols[1], y_rows[2], x_cols[1] + pw, y_rows[2] + ph)
    p_min, p_max = (-45, 50) if is_walk else (-85, 65)
    leg5 = [("L Shoulder Flex", COL_LEFT), ("R Hip Flex (Opp Leg)", COL_RIGHT), ("Mocap L Sh", COL_MOCAP)]
    if b_s:
        leg5.insert(0, ("Before L Sh", COL_BEFORE))
    draw_plot_panel(
        draw,
        box5,
        f"6. Arm vs Opposite Leg Phase (r={ko['armOppositeLegCorr']:.2f}, lag={ko['armPhaseLagDeg']:+.1f}°)",
        p_min,
        p_max,
        leg5,
    )
    if b_s:
        draw_curve(draw, box5, us, [s["angles"]["shoulderFlexL"] for s in b_s], p_min, p_max, COL_BEFORE, width=2, dashed=True)
    draw_curve(draw, box5, us, [s["angles"]["shoulderFlexL"] for s in r_s], p_min, p_max, COL_MOCAP, width=2, dashed=True)
    draw_curve(draw, box5, us, [s["angles"]["hipFlexR"] for s in o_s], p_min, p_max, COL_RIGHT, width=2)
    draw_curve(draw, box5, us, [s["angles"]["shoulderFlexL"] for s in o_s], p_min, p_max, COL_LEFT, width=3)

    # X-axis phase labels along bottom
    labels = PHASE_LABELS_WALK if is_walk else PHASE_LABELS_RUN
    for col_x in x_cols:
        for p_idx in range(8):
            px = col_x + (p_idx / 8.0) * pw
            draw.text((px + 4, H - 28), f"{p_idx}/8", fill=(150, 165, 185, 255), font=FONT_TINY)

    img.convert("RGB").save(os.path.join(OUT_DIR, out_name))
    print(f"Saved {out_name}")

# 1. Transparent orthographic line-rig sheets (8 and 16 phases, side and front)
render_transparent_line_sheet("survivorWalk", "side", 8, f"line-rig-walk-side-{TAG}.png")
render_transparent_line_sheet("survivorWalk", "front", 8, f"line-rig-walk-front-{TAG}.png")
render_transparent_line_sheet("survivorWalk", "side", 16, f"line-rig-walk-16-{TAG}.png")
render_transparent_line_sheet("survivorRun", "side", 8, f"line-rig-run-side-{TAG}.png")
render_transparent_line_sheet("survivorRun", "front", 8, f"line-rig-run-front-{TAG}.png")
render_transparent_line_sheet("survivorRun", "side", 16, f"line-rig-run-16-{TAG}.png")
render_transparent_line_sheet("soldierWalk", "side", 8, f"line-rig-soldier-walk-side-{TAG}.png")
render_transparent_line_sheet("soldierRun", "side", 8, f"line-rig-soldier-run-side-{TAG}.png")

# 2. Per-phase Overlay + Diff sheets
render_overlay_diff_sheet(
    "survivorWalk", "mocapWalk", "williamsWalk", "survivorWalkVsMocap", "side",
    f"overlay-diff-walk-side-{TAG}.png", "Survivor Unarmed Walk (1.4 m/s)"
)
render_overlay_diff_sheet(
    "survivorWalk", "mocapWalk", "williamsWalk", "survivorWalkVsMocap", "front",
    f"overlay-diff-walk-front-{TAG}.png", "Survivor Unarmed Walk (1.4 m/s)"
)
render_overlay_diff_sheet(
    "survivorRun", "mocapRun", "williamsRun", "survivorRunVsMocap", "side",
    f"overlay-diff-run-side-{TAG}.png", "Survivor Unarmed Run (4.2 m/s)"
)
render_overlay_diff_sheet(
    "survivorRun", "mocapRun", "williamsRun", "survivorRunVsMocap", "front",
    f"overlay-diff-run-front-{TAG}.png", "Survivor Unarmed Run (4.2 m/s)"
)
render_overlay_diff_sheet(
    "outbreakWalk", "mocapWalk", "williamsWalk", "outbreakWalkVsMocap", "side",
    f"overlay-diff-outbreak-walk-side-{TAG}.png", "Outbreak Survivor Walk (1.4 m/s)"
)
render_overlay_diff_sheet(
    "outbreakRun", "mocapRun", "williamsRun", "outbreakRunVsMocap", "side",
    f"overlay-diff-outbreak-run-side-{TAG}.png", "Outbreak Survivor Run (4.2 m/s)"
)
render_overlay_diff_sheet(
    "soldierWalk", "mocapWalk", None, "soldierWalkVsMocapLegs", "side",
    f"overlay-diff-soldier-walk-side-{TAG}.png", "Soldier Armed Walk (1.4 m/s, Rifle Aim)"
)
render_overlay_diff_sheet(
    "soldierRun", "mocapRun", None, "soldierRunVsMocapLegs", "side",
    f"overlay-diff-soldier-run-side-{TAG}.png", "Soldier Armed Run (4.2 m/s, Rifle Aim)"
)

# 3. Cycle Angle & Trajectory Plots
render_angle_plots("survivorWalk", "mocapWalk", "williamsWalk", "survivorWalkVsMocap", f"angles-walk-{TAG}.png", f"Survivor Walk (1.4 m/s) [{TAG.upper()}]")
render_angle_plots("survivorRun", "mocapRun", "williamsRun", "survivorRunVsMocap", f"angles-run-{TAG}.png", f"Survivor Run (4.2 m/s) [{TAG.upper()}]")
render_angle_plots("soldierRun", "mocapRun", None, "soldierRunVsMocapLegs", f"angles-soldier-run-{TAG}.png", f"Soldier Armed Run (4.2 m/s) [{TAG.upper()}]")

# 4. If both before and after exist, generate combined comparison overlays, plots, and summary JSON
if TAG == "after" and before_data:
    render_before_after_overlay_sheet("survivorWalk", "mocapWalk", "survivorWalkVsMocap", "side", "overlay-compare-walk-side.png", "Survivor Walk (1.4 m/s)")
    render_before_after_overlay_sheet("survivorWalk", "mocapWalk", "survivorWalkVsMocap", "front", "overlay-compare-walk-front.png", "Survivor Walk (1.4 m/s)")
    render_before_after_overlay_sheet("survivorRun", "mocapRun", "survivorRunVsMocap", "side", "overlay-compare-run-side.png", "Survivor Run (4.2 m/s)")
    render_before_after_overlay_sheet("survivorRun", "mocapRun", "survivorRunVsMocap", "front", "overlay-compare-run-front.png", "Survivor Run (4.2 m/s)")
    render_before_after_overlay_sheet("outbreakWalk", "mocapWalk", "outbreakWalkVsMocap", "side", "overlay-compare-outbreak-walk-side.png", "Outbreak Survivor Walk (1.4 m/s)")
    render_before_after_overlay_sheet("outbreakRun", "mocapRun", "outbreakRunVsMocap", "side", "overlay-compare-outbreak-run-side.png", "Outbreak Survivor Run (4.2 m/s)")

    render_angle_plots("survivorWalk", "mocapWalk", "williamsWalk", "survivorWalkVsMocap", "angles-walk-compare.png", "Survivor Walk (1.4 m/s) — BEFORE vs AFTER vs MOCAP", include_before=True)
    render_angle_plots("survivorRun", "mocapRun", "williamsRun", "survivorRunVsMocap", "angles-run-compare.png", "Survivor Run (4.2 m/s) — BEFORE vs AFTER vs MOCAP", include_before=True)

    summary = {
        "generatedAt": cur_data["timestamp"],
        "metrics": {},
    }
    for k in cur_data["comparisons"]:
        bc = before_data["comparisons"][k]
        ac = cur_data["comparisons"][k]
        summary["metrics"][k] = {
            "before": {
                "angleRmseDeg": bc["angleRmseDeg"],
                "positionRmse": bc["positionRmse"],
                "kinematics": bc["kinematics"]["ours"],
            },
            "after": {
                "angleRmseDeg": ac["angleRmseDeg"],
                "positionRmse": ac["positionRmse"],
                "kinematics": ac["kinematics"]["ours"],
            },
            "reference": ac["kinematics"]["ref"],
        }
    with open(os.path.join(OUT_DIR, "pose-diff-summary.json"), "w") as sf:
        json.dump(summary, sf, indent=2)
    print("Saved pose-diff-summary.json")

    # 5. Overlay Before (red/pink dashed) vs After (blue/orange solid) vs Mocap (green) line rigs directly onto the Ideal Paint-Over sheets
    def project_stage_side(pt_world, pelvis_x, pelvis_z, cw=320, ch=426):
        stage_x, stage_z = 14.0, 10.0
        wx = pt_world[0] - pelvis_x + stage_x
        wy = pt_world[1]
        wz = pt_world[2] - pelvis_z + stage_z
        target = (stage_x, 0.85, stage_z)
        pitch = 8.0 * math.pi / 180.0
        dist = 4.15
        eye = (target[0], target[1] + math.sin(pitch) * dist, target[2] + math.cos(pitch) * dist)
        # Camera basis looking from eye to target
        zx, zy, zz = eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]
        zlen = math.hypot(zx, zy, zz)
        kz = (zx / zlen, zy / zlen, zz / zlen)
        kx = (1.0, 0.0, 0.0)
        ky = (kz[1] * kx[2] - kz[2] * kx[1], kz[2] * kx[0] - kz[0] * kx[2], kz[0] * kx[1] - kz[1] * kx[0])
        rx, ry, rz = wx - eye[0], wy - eye[1], wz - eye[2]
        cx = rx * kx[0] + ry * kx[1] + rz * kx[2]
        cy = rx * ky[0] + ry * ky[1] + rz * ky[2]
        cz = -(rx * kz[0] + ry * kz[1] + rz * kz[2])
        f = 1.0 / math.tan(0.5 / 2.0)
        aspect = cw / float(ch)
        ndc_x = (cx * (f / aspect)) / max(0.1, cz)
        ndc_y = (cy * f) / max(0.1, cz)
        return ((ndc_x * 0.5 + 0.5) * cw, (0.5 - ndc_y * 0.5) * ch)

    for mode, cyc_key, ref_key in [("walk", "survivorWalk", "mocapWalk"), ("run", "survivorRun", "mocapRun")]:
        ideal_src = os.path.join(OUT_DIR, f"{mode}-3d-ideal-side.png")
        if not os.path.exists(ideal_src):
            alt_src = os.path.join("/Users/kit/code/home/artifacts/2026-10-14-walk-audit", f"{mode}-sheet-ideal-side.png")
            if os.path.exists(alt_src):
                ideal_src = alt_src
        if not os.path.exists(ideal_src):
            continue
        CW, CH = 320, 426
        base_img = Image.open(ideal_src).convert("RGBA").resize((CW * 4, CH * 2), Image.Resampling.LANCZOS)
        header_h = 46
        out_img = Image.new("RGBA", (CW * 4, CH * 2 + header_h), BG_DARK)
        out_img.paste(base_img, (0, header_h))
        odraw = ImageDraw.Draw(out_img)
        odraw.text(
            (14, 6),
            f"{mode.upper()} — IDEAL PAINT-OVER + LINE-RIG OVERLAY (Red Dashed = Before, Green = Mocap, Blue/Orange = After)",
            fill=COL_SPINE,
            font=FONT_TITLE,
        )
        odraw.text(
            (14, 27),
            "Shows why Before failed (upper arm stuck vertical in torso / run elbow unbending downward) vs After matching paint-over & mocap.",
            fill=(175, 190, 210, 255),
            font=FONT_SMALL,
        )

        b_phases = before_data["cycles"][cyc_key]["phases8"]
        a_phases = cur_data["cycles"][cyc_key]["phases8"]
        r_phases = cur_data["references"][ref_key]["phases8"]

        for idx in range(8):
            col = idx % 4
            row = idx // 4
            x0 = col * CW
            y0 = header_h + row * CH

            for ph, style in [(r_phases[idx], "mocap"), (b_phases[idx], "before"), (a_phases[idx], "after")]:
                j = ph["joints"]
                px0, pz0 = j["pelvis"][0], j["pelvis"][2]
                for side_key, sh_id, el_id, wr_id in [
                    ("L", "shoulderL", "elbowL", "wristL"),
                    ("R", "shoulderR", "elbowR", "wristR"),
                ]:
                    p_sh = project_stage_side(j[sh_id], px0, pz0, CW, CH)
                    p_el = project_stage_side(j[el_id], px0, pz0, CW, CH)
                    p_wr = project_stage_side(j[wr_id], px0, pz0, CW, CH)
                    p_sh = (p_sh[0] + x0, p_sh[1] + y0)
                    p_el = (p_el[0] + x0, p_el[1] + y0)
                    p_wr = (p_wr[0] + x0, p_wr[1] + y0)

                    if style == "before":
                        for seg_a, seg_b in [(p_sh, p_el), (p_el, p_wr)]:
                            for step_i in range(0, 10, 2):
                                t0, t1 = step_i / 10.0, (step_i + 1) / 10.0
                                q0 = (seg_a[0] + (seg_b[0] - seg_a[0]) * t0, seg_a[1] + (seg_b[1] - seg_a[1]) * t0)
                                q1 = (seg_a[0] + (seg_b[0] - seg_a[0]) * t1, seg_a[1] + (seg_b[1] - seg_a[1]) * t1)
                                odraw.line([q0, q1], fill=(255, 80, 105, 220), width=2)
                        odraw.ellipse((p_wr[0] - 3, p_wr[1] - 3, p_wr[0] + 3, p_wr[1] + 3), fill=(255, 80, 105, 230))
                    elif style == "mocap":
                        odraw.line([p_sh, p_el, p_wr], fill=(72, 232, 138, 190), width=2)
                    else:
                        acol = COL_LEFT if side_key == "L" else COL_RIGHT
                        odraw.line([p_sh, p_el, p_wr], fill=acol, width=4)
                        for pt in (p_sh, p_el, p_wr):
                            odraw.ellipse((pt[0] - 3.5, pt[1] - 3.5, pt[0] + 3.5, pt[1] + 3.5), fill=acol, outline=(255, 255, 255, 255))

        out_path = os.path.join(OUT_DIR, f"paintover-overlay-{mode}-side.png")
        out_img.convert("RGB").save(out_path)
        print(f"Saved {out_path}")
