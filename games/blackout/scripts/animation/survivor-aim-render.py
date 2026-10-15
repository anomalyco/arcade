import json
import math
import os
import sys
from PIL import Image, ImageDraw, ImageFont

if len(sys.argv) < 2:
    sys.exit("usage: survivor-aim-render.py <out-dir> [tag]")
OUT_DIR = sys.argv[1]
TAG = sys.argv[2] if len(sys.argv) > 2 else "after"

with open(os.path.join(OUT_DIR, f"survivor-aim-{TAG}.json")) as f:
    cur_data = json.load(f)

before_path = os.path.join(OUT_DIR, "survivor-aim-before.json")
before_data = cur_data
if os.path.exists(before_path):
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


FONT_TITLE = get_font(16)
FONT_SUB = get_font(12)
FONT_SMALL = get_font(10)
FONT_TINY = get_font(9)

COL_SPINE = (244, 247, 252, 255)
COL_LEFT = (56, 182, 255, 255)      # Left limbs blue
COL_RIGHT = (255, 120, 73, 255)     # Right limbs orange
COL_WEAPON = (255, 216, 76, 255)    # Weapon gold
COL_JOINT = (255, 255, 255, 255)

COL_REF = (72, 232, 138, 220)       # Reference green
COL_REF_L = (64, 215, 150, 210)
COL_REF_R = (110, 240, 120, 210)
COL_BEFORE = (255, 92, 116, 220)    # Before red-pink

BG_DARK = (14, 18, 24, 255)
CELL_BG = (20, 25, 33, 255)
GRID_LINE = (42, 52, 66, 255)
TORSO_BOX = (255, 215, 110, 70)

PHASE_LABELS_GAIT = [
    "0/8 L Contact",
    "1/8 L Down",
    "2/8 L Passing",
    "3/8 L Up",
    "4/8 R Contact",
    "5/8 R Down",
    "6/8 R Passing",
    "7/8 R Up",
]

PHASE_LABELS_RELOAD = [
    "0/8 Tilt Gun",
    "1/8 Drop Mag",
    "2/8 Belt Reach",
    "3/8 Grab Mag",
    "4/8 Lift Well",
    "5/8 Seat Mag",
    "6/8 Rack Slide",
    "7/8 Aim Ready",
]

SEGMENTS = cur_data["segments"]
JOINTS = cur_data["joints"]


def norm_to_px(pt, cw, ch, ground_y=-1.0):
    scale = (ch - 46) / 2.15
    cx = cw * 0.44
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
            if not p0 or not p1:
                continue
            a = norm_to_px(p0, cw, ch, ground_y)
            b = norm_to_px(p1, cw, ch, ground_y)
            a = (a[0] + x_off, a[1] + y_off)
            b = (b[0] + x_off, b[1] + y_off)

            if style == "ours":
                col = COL_LEFT if grp == "left" else COL_RIGHT if grp == "right" else COL_SPINE
                w = max(1, int(round((3.5 if grp in ("left", "right") else 3.0) * width_scale)))
            elif style == "ref":
                col = COL_REF_L if grp == "left" else COL_REF_R if grp == "right" else COL_REF
                w = max(1, int(round(2.2 * width_scale)))
            elif style == "before":
                col = COL_BEFORE
                w = max(1, int(round(2.2 * width_scale)))
            else:
                col = COL_SPINE
                w = 2

            draw.line([a, b], fill=col, width=w)

    if "gunGrip" in pts and "gunMuzzle" in pts:
        a = norm_to_px(pts["gunGrip"], cw, ch, ground_y)
        b = norm_to_px(pts["gunMuzzle"], cw, ch, ground_y)
        gcol = COL_WEAPON if style == "ours" else (180, 235, 140, 220) if style == "ref" else (255, 130, 90, 200)
        gw = 4 if style == "ours" else 3
        draw.line([(a[0] + x_off, a[1] + y_off), (b[0] + x_off, b[1] + y_off)], fill=gcol, width=gw)
        # Draw sights/muzzle tip dot
        mx, my = b[0] + x_off, b[1] + y_off
        draw.ellipse((mx - 2.5, my - 2.5, mx + 2.5, my + 2.5), fill=gcol)

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
            elif style == "ref":
                dcol = COL_REF
            else:
                dcol = COL_BEFORE
            draw.ellipse((px - r, py - r, px + r, py + r), fill=dcol)


def render_before_ref_after_sheet(cycle_key, ref_key, comp_key, mode_key, view, out_name, title):
    a_cycle = cur_data["cycles"][cycle_key]
    ref = cur_data["references"][ref_key]
    a_comp = cur_data["comparisons"][comp_key]
    a_mode = cur_data["locomotionModes"][mode_key]

    b_cycle = before_data["cycles"][cycle_key]
    b_comp = before_data["comparisons"][comp_key]
    b_mode = before_data["locomotionModes"][mode_key]

    cw, ch = 160, 225
    header_h = 68
    W = cw * 8
    H = header_h + ch * 3
    img = Image.new("RGBA", (W, H), BG_DARK)
    draw = ImageDraw.Draw(img)

    draw.text(
        (16, 10),
        f"{title} — BEFORE | REFERENCE | AFTER ({view.upper()} VIEW)",
        fill=(240, 245, 252, 255),
        font=FONT_TITLE,
    )
    sub1 = (
        f"BEFORE: Muzzle err={b_mode['muzzleAngleErrMeanDeg']:.1f}°  Forearm err={b_mode['forearmAimErrMeanDeg']:.1f}°  "
        f"MuzzleH={b_mode['muzzleHeightMeanCm']:.0f}cm (hip)  WristGap={b_mode['wristGripGapCm']:.1f}cm  ArmRMSE={b_comp['angleRmseDeg']['meanArmAngleRmse']:.1f}°"
    )
    sub2 = (
        f"AFTER:  Muzzle err={a_mode['muzzleAngleErrMeanDeg']:.2f}°  Forearm err={a_mode['forearmAimErrMeanDeg']:.1f}°  "
        f"MuzzleH={a_mode['muzzleHeightMeanCm']:.0f}cm (shoulder)  WristGap={a_mode['wristGripGapCm']:.1f}cm  ArmRMSE={a_comp['angleRmseDeg']['meanArmAngleRmse']:.1f}°  "
        f"ToeSlip={a_mode['maxPlantedToeSlipM']:.1e}m"
    )
    draw.text((16, 32), sub1, fill=(255, 130, 148, 255), font=FONT_SUB)
    draw.text((16, 48), sub2, fill=(108, 242, 158, 255), font=FONT_SUB)

    row_Specs = [
        ("ROW 1 · BEFORE (Unarmed swing + hip-glued pistol)", b_cycle, "before"),
        ("ROW 2 · REFERENCE (Two-handed shoulder aim + gait)", ref, "ref"),
        ("ROW 3 · AFTER (Stabilised shoulder pistol aim + overlay)", a_cycle, "ours"),
    ]

    for r_idx, (r_label, cyc, st_kind) in enumerate(row_Specs):
        y0 = header_h + r_idx * ch
        for k in range(8):
            x0 = k * cw
            draw.rectangle([(x0 + 2, y0 + 2), (x0 + cw - 2, y0 + ch - 2)], fill=CELL_BG, outline=GRID_LINE)
            ph = cyc["phases8"][k]
            ref_ph = ref["phases8"][k]
            ground_y = ph["orthoSide"]["groundY"]
            _, gy = norm_to_px((0, ground_y), cw, ch, ground_y)
            ox, oy = norm_to_px((0, 0), cw, ch, ground_y)
            # Draw shoulder-height aim line (gold dashed)
            _, aim_y = norm_to_px((0, (1.35 - 0.86) / 0.86), cw, ch, ground_y)
            draw.line([(x0 + 8, y0 + aim_y), (x0 + cw - 8, y0 + aim_y)], fill=(255, 216, 76, 55), width=1)
            draw.line([(x0 + 8, y0 + gy), (x0 + cw - 8, y0 + gy)], fill=(86, 102, 124, 200), width=1)
            draw.line([(x0 + ox, y0 + 20), (x0 + ox, y0 + ch - 8)], fill=(45, 56, 70, 130), width=1)

            draw_torso_silhouette(draw, ph, view, cw, ch, x0, y0)
            if r_idx == 0:
                draw_skeleton_2d(draw, ref_ph, view, cw, ch, x0, y0, style="ref", width_scale=0.8, draw_dots=False)
                draw_skeleton_2d(draw, ph, view, cw, ch, x0, y0, style="ours", width_scale=1.0, draw_dots=True)
            elif r_idx == 1:
                draw_skeleton_2d(draw, ph, view, cw, ch, x0, y0, style="ref", width_scale=1.15, draw_dots=True)
            else:
                draw_skeleton_2d(draw, b_cycle["phases8"][k], view, cw, ch, x0, y0, style="before", width_scale=0.75, draw_dots=False)
                draw_skeleton_2d(draw, ref_ph, view, cw, ch, x0, y0, style="ref", width_scale=0.85, draw_dots=False)
                draw_skeleton_2d(draw, ph, view, cw, ch, x0, y0, style="ours", width_scale=1.1, draw_dots=True)

            ang = ph["angles"]
            draw.text((x0 + 6, y0 + 4), PHASE_LABELS_GAIT[k], fill=(225, 232, 242, 255), font=FONT_TINY)
            draw.text(
                (x0 + 6, y0 + ch - 26),
                f"shR:{ang['shoulderFlexR']:.0f}° elbR:{ang['elbowFlexR']:.0f}°",
                fill=(255, 168, 120, 235),
                font=FONT_TINY,
            )
            draw.text(
                (x0 + 6, y0 + ch - 15),
                f"shL:{ang['shoulderFlexL']:.0f}° elbL:{ang['elbowFlexL']:.0f}°",
                fill=(120, 205, 255, 235),
                font=FONT_TINY,
            )

        draw.rectangle([(6, y0 + 16), (340, y0 + 31)], fill=(14, 18, 24, 215))
        draw.text((10, y0 + 17), r_label, fill=(255, 224, 130, 255), font=FONT_TINY)

    img.convert("RGB").save(os.path.join(OUT_DIR, out_name))
    print(f"Saved {out_name}")


def render_low_ready_and_reload_sheet(out_name):
    lr_cyc = cur_data["cycles"]["outbreakLowReadyWalk"]
    lr_ref = cur_data["references"]["pistolLowReadyWalkRef"]
    rel_cyc = cur_data["cycles"]["outbreakReloadWalk"]
    rel_ref = cur_data["references"]["pistolReloadWalkRef"]
    rel_kin = cur_data["reloadKinematics"]

    cw, ch = 160, 235
    header_h = 64
    W = cw * 8
    H = header_h + ch * 2
    img = Image.new("RGBA", (W, H), BG_DARK)
    draw = ImageDraw.Draw(img)

    draw.text(
        (16, 10),
        "SURVIVOR LOW-READY WALK (1.4 m/s) & PISTOL RELOAD CLIP (1.15 s) — SIDE VIEW",
        fill=(240, 245, 252, 255),
        font=FONT_TITLE,
    )
    draw.text(
        (16, 34),
        f"Row 1: Equipped idle Low Ready (muzzle pitched -27.5° forward/down in right hand, left arm counter-swings)  |  "
        f"Row 2: Reload (left hand -> belt {rel_kin['minHandToHipCm']:.1f}cm -> mag well {rel_kin['minHandToGripWellCm']:.1f}cm -> slide rack, gun roll {rel_kin['maxGunRollDeg']:.0f}°, head look {rel_kin['maxHeadLookDownDeg']:.0f}°)",
        fill=(140, 225, 255, 255),
        font=FONT_SUB,
    )

    rows = [
        ("ROW 1 · LOW-READY WALK (Pistol held in right hand, muzzle down/fwd, left hand free)", lr_cyc, lr_ref, PHASE_LABELS_GAIT),
        ("ROW 2 · PISTOL RELOAD (1.15 s driven by reloadRemaining: mag from belt to grip + slide rack)", rel_cyc, rel_ref, PHASE_LABELS_RELOAD),
    ]

    for r_idx, (r_label, cyc, ref_cyc, labels) in enumerate(rows):
        y0 = header_h + r_idx * ch
        for k in range(8):
            x0 = k * cw
            draw.rectangle([(x0 + 2, y0 + 2), (x0 + cw - 2, y0 + ch - 2)], fill=CELL_BG, outline=GRID_LINE)
            ph = cyc["phases8"][k]
            r_ph = ref_cyc["phases8"][k]
            ground_y = ph["orthoSide"]["groundY"]
            _, gy = norm_to_px((0, ground_y), cw, ch, ground_y)
            ox, oy = norm_to_px((0, 0), cw, ch, ground_y)
            draw.line([(x0 + 8, y0 + gy), (x0 + cw - 8, y0 + gy)], fill=(86, 102, 124, 200), width=1)
            draw.line([(x0 + ox, y0 + 20), (x0 + ox, y0 + ch - 8)], fill=(45, 56, 70, 130), width=1)

            draw_torso_silhouette(draw, ph, "side", cw, ch, x0, y0)
            draw_skeleton_2d(draw, r_ph, "side", cw, ch, x0, y0, style="ref", width_scale=0.85, draw_dots=False)
            draw_skeleton_2d(draw, ph, "side", cw, ch, x0, y0, style="ours", width_scale=1.1, draw_dots=True)

            ang = ph["angles"]
            draw.text((x0 + 6, y0 + 4), labels[k], fill=(225, 232, 242, 255), font=FONT_TINY)
            draw.text(
                (x0 + 6, y0 + ch - 26),
                f"shR:{ang['shoulderFlexR']:.0f}° elbR:{ang['elbowFlexR']:.0f}°",
                fill=(255, 168, 120, 235),
                font=FONT_TINY,
            )
            draw.text(
                (x0 + 6, y0 + ch - 15),
                f"shL:{ang['shoulderFlexL']:.0f}° elbL:{ang['elbowFlexL']:.0f}°",
                fill=(120, 205, 255, 235),
                font=FONT_TINY,
            )

        draw.rectangle([(6, y0 + 16), (480, y0 + 31)], fill=(14, 18, 24, 215))
        draw.text((10, y0 + 17), r_label, fill=(255, 224, 130, 255), font=FONT_TINY)

    img.convert("RGB").save(os.path.join(OUT_DIR, out_name))
    print(f"Saved {out_name}")


def render_lifecycle_and_recoil_plots(out_name):
    W, H = 1280, 740
    img = Image.new("RGBA", (W, H), BG_DARK)
    draw = ImageDraw.Draw(img)

    a_lc = cur_data["lifecycle"]
    b_lc = before_data["lifecycle"]
    a_rec = a_lc["recoil"]

    draw.text(
        (20, 12),
        "SURVIVOR PISTOL AIM: RAISE TIME, HOLD DURATION, MUZZLE ALIGNMENT & RECOIL CURVE",
        fill=(240, 245, 252, 255),
        font=FONT_TITLE,
    )
    draw.text(
        (20, 34),
        f"Raise (0→95%): {a_lc['raiseTimeTo95Ms']:.0f} ms ({a_lc['raiseTimeTo95Ms']/1000:.2f} s, 0 mm anticipation dip, {a_lc['settleOvershootPct']:.1f}% settle)  ·  "
        f"Hold after last shot: {a_lc['holdDurationSec']:.2f} s  ·  "
        f"Recoil peak: +{a_rec['peakPitchDeg']:.1f}° climb / {a_rec['peakBackCm']:.1f} cm back / +{a_rec['peakElbowAbsorbDeg']:.1f}° elbow absorb @ {a_rec['timeToPeakMs']:.0f} ms",
        fill=(108, 242, 158, 255),
        font=FONT_SUB,
    )

    panels = [
        (20, 66, 610, 310),
        (650, 66, 610, 310),
        (20, 404, 610, 310),
        (650, 404, 610, 310),
    ]

    # Panel 1: 5.0s Lifecycle (Muzzle Height cm & Aim Weight)
    px0, py0, pw, ph = panels[0]
    draw.rectangle([(px0, py0), (px0 + pw, py0 + ph)], fill=CELL_BG, outline=GRID_LINE)
    draw.text((px0 + 12, py0 + 8), "1 · Raise, 2.5s Hold & Lower Lifecycle (Muzzle Height cm)", fill=(235, 242, 250, 255), font=FONT_SUB)
    gx0, gy0, gw, gh = px0 + 48, py0 + 36, pw - 68, ph - 60
    draw.rectangle([(gx0, gy0), (gx0 + gw, gy0 + gh)], outline=(50, 62, 78, 255))

    y_min, y_max = 60.0, 150.0
    def to_xy1(t, y):
        return (gx0 + (t / 5.0) * gw, gy0 + gh - ((y - y_min) / (y_max - y_min)) * gh)

    for yv in [70, 90, 115, 138]:
        _, py = to_xy1(0, yv)
        draw.line([(gx0, py), (gx0 + gw, py)], fill=(38, 48, 62, 255), width=1)
        draw.text((gx0 - 38, py - 6), f"{yv}cm", fill=(150, 165, 185, 255), font=FONT_TINY)

    # Event markers: Shot 1 at 1.0s, Shot 2 at 1.6s, Hold ends at 4.1s
    for ev_t, ev_lbl in [(1.0, "Shot 1"), (1.6, "Shot 2"), (4.1, "Hold End (+2.5s)")]:
        ex, _ = to_xy1(ev_t, y_min)
        draw.line([(ex, gy0), (ex, gy0 + gh)], fill=(255, 216, 76, 90), width=1)
        draw.text((ex + 3, gy0 + 4), ev_lbl, fill=(255, 216, 76, 220), font=FONT_TINY)

    b_pts = [to_xy1(r["t"], r["muzzleHeightCm"]) for r in b_lc["series"]]
    a_pts = [to_xy1(r["t"], r["muzzleHeightCm"]) for r in a_lc["series"]]
    draw.line(b_pts, fill=COL_BEFORE, width=2)
    draw.line(a_pts, fill=COL_LEFT, width=3)
    draw.text((gx0 + 10, gy0 + gh + 6), "t = 0.0 s (Low Ready) ───────────────► 5.0 s   [Red: Before (hip 88cm) | Blue: After (111cm → 138cm shoulder)]", fill=(180, 195, 215, 255), font=FONT_TINY)

    # Panel 2: Single-Shot Recoil Curve (t = 1.60s .. 2.00s)
    px0, py0, pw, ph = panels[1]
    draw.rectangle([(px0, py0), (px0 + pw, py0 + ph)], fill=CELL_BG, outline=GRID_LINE)
    draw.text((px0 + 12, py0 + 8), "2 · Single-Shot Recoil Curve (Muzzle Climb °, Elbow Absorb °, Back mm)", fill=(235, 242, 250, 255), font=FONT_SUB)
    gx0, gy0, gw, gh = px0 + 48, py0 + 36, pw - 68, ph - 60
    draw.rectangle([(gx0, gy0), (gx0 + gw, gy0 + gh)], outline=(50, 62, 78, 255))

    rec_slice = a_lc["series"][95:120]
    base_elb = a_lc["series"][95]["elbowFlexR"]
    ry_min, ry_max = -4.0, 48.0
    def to_xy2(idx, val):
        return (gx0 + (idx / 24.0) * gw, gy0 + gh - ((val - ry_min) / (ry_max - ry_min)) * gh)

    for yv in [0, 10, 20, 30, 40]:
        _, py = to_xy2(0, yv)
        draw.line([(gx0, py), (gx0 + gw, py)], fill=(38, 48, 62, 255), width=1)
        draw.text((gx0 - 34, py - 6), f"{yv}", fill=(150, 165, 185, 255), font=FONT_TINY)

    pitch_pts = [to_xy2(i, r["muzzlePitchDeg"]) for i, r in enumerate(rec_slice)]
    back_pts = [to_xy2(i, r["recoilBackCm"] * 10.0) for i, r in enumerate(rec_slice)]
    elb_pts = [to_xy2(i, r["elbowFlexR"] - base_elb) for i, r in enumerate(rec_slice)]
    torso_pts = [to_xy2(i, r["torsoKickDeg"] * 4.0) for i, r in enumerate(rec_slice)]
    draw.line(pitch_pts, fill=COL_WEAPON, width=3)
    draw.line(back_pts, fill=COL_RIGHT, width=2)
    draw.line(elb_pts, fill=COL_LEFT, width=2)
    draw.line(torso_pts, fill=COL_REF, width=2)
    draw.text(
        (gx0 + 8, gy0 + gh + 6),
        "0..400 ms after shot  [Gold: Muzzle climb (°) | Orange: Slide back (mm) | Blue: ΔElbow absorb (°) | Green: Torso kick ×4 (°)]",
        fill=(180, 195, 215, 255),
        font=FONT_TINY,
    )

    # Panel 3: Muzzle & Forearm Alignment Error across 5 Locomotion Modes (Bar Chart)
    px0, py0, pw, ph = panels[2]
    draw.rectangle([(px0, py0), (px0 + pw, py0 + ph)], fill=CELL_BG, outline=GRID_LINE)
    draw.text((px0 + 12, py0 + 8), "3 · Arm / Muzzle Alignment Error vs Aim Across 5 Modes (deg, lower is better)", fill=(235, 242, 250, 255), font=FONT_SUB)
    gx0, gy0, gw, gh = px0 + 48, py0 + 36, pw - 68, ph - 60
    draw.rectangle([(gx0, gy0), (gx0 + gw, gy0 + gh)], outline=(50, 62, 78, 255))

    modes = ["idle", "walk", "run", "strafe", "backpedal"]
    ey_max = 95.0
    for yv in [0, 20, 40, 60, 80]:
        py = gy0 + gh - (yv / ey_max) * gh
        draw.line([(gx0, py), (gx0 + gw, py)], fill=(38, 48, 62, 255), width=1)
        draw.text((gx0 - 34, py - 6), f"{yv}°", fill=(150, 165, 185, 255), font=FONT_TINY)

    slot_w = gw / len(modes)
    for idx, m in enumerate(modes):
        b_err = before_data["locomotionModes"][m]["muzzleAngleErrMeanDeg"]
        a_err = cur_data["locomotionModes"][m]["muzzleAngleErrMeanDeg"]
        cx = gx0 + (idx + 0.5) * slot_w
        bh = (min(ey_max, b_err) / ey_max) * gh
        ah = max(3.0, (min(ey_max, a_err) / ey_max) * gh)
        draw.rectangle([(cx - 24, gy0 + gh - bh), (cx - 4, gy0 + gh)], fill=COL_BEFORE)
        draw.rectangle([(cx + 4, gy0 + gh - ah), (cx + 24, gy0 + gh)], fill=COL_REF)
        draw.text((cx - 26, gy0 + gh - bh - 13), f"{b_err:.0f}°", fill=COL_BEFORE, font=FONT_TINY)
        draw.text((cx + 2, gy0 + gh - ah - 13), f"{a_err:.2f}°", fill=COL_REF, font=FONT_TINY)
        draw.text((cx - 22, gy0 + gh + 6), m.upper(), fill=(220, 230, 242, 255), font=FONT_TINY)

    # Panel 4: Wrist & Elbow Angles over Aimed Walk Cycle (Before vs Ref vs After)
    px0, py0, pw, ph = panels[3]
    draw.rectangle([(px0, py0), (px0 + pw, py0 + ph)], fill=CELL_BG, outline=GRID_LINE)
    draw.text((px0 + 12, py0 + 8), "4 · Right & Left Arm Angles over Aimed Walk Cycle (deg)", fill=(235, 242, 250, 255), font=FONT_SUB)
    gx0, gy0, gw, gh = px0 + 48, py0 + 36, pw - 68, ph - 60
    draw.rectangle([(gx0, gy0), (gx0 + gw, gy0 + gh)], outline=(50, 62, 78, 255))

    b_dense = before_data["cycles"]["outbreakAimWalk"]["denseSamples"]
    r_dense = cur_data["references"]["pistolAimWalkRef"]["denseSamples"]
    a_dense = cur_data["cycles"]["outbreakAimWalk"]["denseSamples"]
    ay_min, ay_max = -40.0, 105.0
    def to_xy4(i, val):
        return (gx0 + (i / 63.0) * gw, gy0 + gh - ((val - ay_min) / (ay_max - ay_min)) * gh)

    for yv in [-30, 0, 30, 60, 90]:
        _, py = to_xy4(0, yv)
        draw.line([(gx0, py), (gx0 + gw, py)], fill=(38, 48, 62, 255), width=1)
        draw.text((gx0 - 36, py - 6), f"{yv}°", fill=(150, 165, 185, 255), font=FONT_TINY)

    draw.line([to_xy4(i, s["angles"]["shoulderFlexR"]) for i, s in enumerate(b_dense)], fill=COL_BEFORE, width=2)
    draw.line([to_xy4(i, s["angles"]["shoulderFlexR"]) for i, s in enumerate(r_dense)], fill=COL_REF, width=2)
    draw.line([to_xy4(i, s["angles"]["shoulderFlexR"]) for i, s in enumerate(a_dense)], fill=COL_RIGHT, width=3)
    draw.line([to_xy4(i, s["angles"]["elbowFlexL"]) for i, s in enumerate(r_dense)], fill=(64, 215, 150, 160), width=2)
    draw.line([to_xy4(i, s["angles"]["elbowFlexL"]) for i, s in enumerate(a_dense)], fill=COL_LEFT, width=2)
    draw.text(
        (gx0 + 8, gy0 + gh + 6),
        "0..100% Gait Cycle  [Red: Before ShFlexR (-30..+19°) | Green: Ref | Orange: After ShFlexR (~61°) | Blue: After ElbFlexL (~79°)]",
        fill=(180, 195, 215, 255),
        font=FONT_TINY,
    )

    img.convert("RGB").save(os.path.join(OUT_DIR, out_name))
    print(f"Saved {out_name}")


if TAG == "after":
    render_before_ref_after_sheet(
        "outbreakAimWalk",
        "pistolAimWalkRef",
        "aimWalkVsRef",
        "walk",
        "side",
        "before-ref-after-survivor-aim-walk-side.png",
        "Outbreak Survivor Aimed Walk (1.4 m/s)",
    )
    render_before_ref_after_sheet(
        "outbreakAimWalk",
        "pistolAimWalkRef",
        "aimWalkVsRef",
        "walk",
        "front",
        "before-ref-after-survivor-aim-walk-front.png",
        "Outbreak Survivor Aimed Walk (1.4 m/s)",
    )
    render_before_ref_after_sheet(
        "outbreakAimRun",
        "pistolAimRunRef",
        "aimRunVsRef",
        "run",
        "side",
        "before-ref-after-survivor-aim-run-side.png",
        "Outbreak Survivor Aimed Run (4.2 m/s)",
    )
    render_low_ready_and_reload_sheet("before-ref-after-survivor-low-ready-reload-side.png")
    render_lifecycle_and_recoil_plots("survivor-aim-lifecycle-recoil.png")
