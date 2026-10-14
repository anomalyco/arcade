import json
import os
import sys
from PIL import Image, ImageDraw, ImageFont

if len(sys.argv) < 2:
    sys.exit(f"usage: {os.path.basename(__file__)} <out-dir> [tag]")
OUT_DIR = sys.argv[1]
tag = sys.argv[2] if len(sys.argv) > 2 else "before"
frames_dir = os.path.join(OUT_DIR, f"frames-{tag}")

def get_font(size=16):
    for p in [
        "/System/Library/Fonts/SFNSMono.ttf",
        "/System/Library/Fonts/Menlo.ttc",
        "/System/Library/Fonts/Helvetica.ttc",
    ]:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()

FONT_HEADER = get_font(15)
FONT_SUB = get_font(12)
FONT_TITLE = get_font(22)

COL_L = (72, 196, 255)
COL_R = (255, 118, 88)
COL_GROUND = (90, 108, 130)
COL_PELVIS = (120, 236, 152)

def build_sheet(mode, view):
    meta_path = os.path.join(frames_dir, f"{mode}-{view}-meta.json")
    if not os.path.exists(meta_path):
        return
    with open(meta_path) as f:
        meta = json.load(f)

    # Output exact 1536x1024 (4x2 grid of 384x512 cells)
    CW, CH = 384, 512
    W, H = CW * 4, CH * 2
    sheet = Image.new("RGB", (W, H), (18, 22, 28))
    draw = ImageDraw.Draw(sheet)

    cells = meta["cells"]
    mean_pelvis_y = sum(c["pelvisY"] for c in cells) / len(cells)

    for idx, c in enumerate(cells):
        col = idx % 4
        row = idx // 4
        x0 = col * CW
        y0 = row * CH

        raw = Image.open(c["cellPath"]).convert("RGB")
        if "g1Path" in c and os.path.exists(c["g1Path"]) and "g2Path" in c and os.path.exists(c["g2Path"]):
            g1 = Image.open(c["g1Path"]).convert("RGB")
            g2 = Image.open(c["g2Path"]).convert("RGB")
            # Blend ghost2 (12%) and ghost1 (20%) where main character isn't foreground, or simple onion-skin blend:
            from PIL import ImageChops
            # Highlight difference of g1 and g2 from background so main character stays 100% sharp
            diff1 = ImageChops.difference(g1, raw)
            diff2 = ImageChops.difference(g2, raw)
            # Tint ghosts cool cyan-blue for unmistakable onion-skin readability
            r1, gr1, b1 = diff1.split()
            r2, gr2, b2 = diff2.split()
            ghost_layer = Image.merge("RGB", (
                ImageChops.add(r1.point(lambda p: int(p * 0.10)), r2.point(lambda p: int(p * 0.05))),
                ImageChops.add(gr1.point(lambda p: int(p * 0.18)), r2.point(lambda p: int(p * 0.09))),
                ImageChops.add(b1.point(lambda p: int(p * 0.30)), b2.point(lambda p: int(p * 0.15))),
            ))
            raw = ImageChops.add(raw, ghost_layer)
        # Resize from 768x1024 (2x DPR) to 384x512 with LANCZOS
        cell_img = raw.resize((CW, CH), Image.Resampling.LANCZOS)
        cdraw = ImageDraw.Draw(cell_img)

        # Ground reference line
        gl = [c["groundLeft2D"][0] * 0.5, c["groundLeft2D"][1] * 0.5]
        gr = [c["groundRight2D"][0] * 0.5, c["groundRight2D"][1] * 0.5]
        cdraw.line([tuple(gl), tuple(gr)], fill=COL_GROUND, width=2)

        # Pelvis height reference tick
        py_2d = [c["pelvis2D"][0] * 0.5, c["pelvis2D"][1] * 0.5]
        cdraw.line([(30, py_2d[1]), (CW - 30, py_2d[1])], fill=(60, 110, 80), width=1)
        cdraw.ellipse((py_2d[0] - 4, py_2d[1] - 4, py_2d[0] + 4, py_2d[1] + 4), fill=COL_PELVIS)

        # Foot contact markers (ankle -> toe bar when planted, hollow ring when swinging)
        for is_left, planted, f2d, t2d, color, label in [
            (True, c["plantedL"], c["footL2D"], c["toeL2D"], COL_L, "L"),
            (False, c["plantedR"], c["footR2D"], c["toeR2D"], COL_R, "R"),
        ]:
            fx, fy = f2d[0] * 0.5, f2d[1] * 0.5
            tx, ty = t2d[0] * 0.5, t2d[1] * 0.5
            if planted:
                cdraw.line([(fx, fy), (tx, ty)], fill=color, width=5)
                cdraw.ellipse((tx - 5, ty - 5, tx + 5, ty + 5), fill=color, outline=(255, 255, 255))
                cdraw.rectangle((fx - 10, fy + 2, tx + 6, ty + 7), fill=color)
            else:
                cdraw.ellipse((fx - 4, fy - 4, fx + 4, fy + 4), outline=color, width=2)

        # Top overlay label bar
        cdraw.rectangle((0, 0, CW, 48), fill=(14, 17, 22))
        pname = meta["phaseNames"][idx]
        cdraw.text((10, 6), f"{pname}  (φ={idx}/8)", fill=(235, 240, 248), font=FONT_HEADER)
        dy_cm = (c["pelvisY"] - mean_pelvis_y) * 100.0
        st_l = "L:PLANT" if c["plantedL"] else "L:SWING"
        st_r = "R:PLANT" if c["plantedR"] else "R:SWING"
        cdraw.text((10, 27), f"{st_l}  {st_r}   Pelvis ΔY: {dy_cm:+.2f} cm", fill=(160, 175, 195), font=FONT_SUB)

        # Cell border
        cdraw.rectangle((0, 0, CW - 1, CH - 1), outline=(42, 50, 62), width=1)
        sheet.paste(cell_img, (x0, y0))

    out_file = os.path.join(OUT_DIR, f"{mode}-sheet-{tag}-{view}.png")
    sheet.save(out_file)
    print(f"Saved {out_file}")

for m in ["walk", "run"]:
    for v in ["side", "iso"]:
        build_sheet(m, v)

# If ideal and after exist, build Before | Ideal | After comparison sheets
for m in ["walk", "run"]:
    for v in ["side", "iso"]:
        b_path = os.path.join(OUT_DIR, f"{m}-sheet-before-{v}.png")
        i_path = os.path.join(OUT_DIR, f"{m}-sheet-ideal-{v}.png")
        a_path = os.path.join(OUT_DIR, f"{m}-sheet-after-{v}.png")
        if os.path.exists(b_path) and os.path.exists(a_path):
            b_img = Image.open(b_path).convert("RGB")
            a_img = Image.open(a_path).convert("RGB")
            imgs = [("BEFORE", b_img)]
            if os.path.exists(i_path):
                i_img = Image.open(i_path).convert("RGB").resize(b_img.size, Image.Resampling.LANCZOS)
                imgs.append(("IDEAL TARGET (paint-over)", i_img))
            imgs.append(("AFTER", a_img))
            banner_h = 44
            comp = Image.new("RGB", (b_img.width, (b_img.height + banner_h) * len(imgs)), (12, 15, 20))
            cd = ImageDraw.Draw(comp)
            for idx, (lbl, im) in enumerate(imgs):
                y_off = idx * (b_img.height + banner_h)
                cd.rectangle((0, y_off, b_img.width, y_off + banner_h), fill=(24, 30, 38))
                cd.text((16, y_off + 10), f"{m.upper()} ({v.upper()}) — {lbl}", fill=(240, 244, 250), font=FONT_TITLE)
                comp.paste(im, (0, y_off + banner_h))
            out_comp = os.path.join(OUT_DIR, f"{m}-sheet-compare-{v}.png")
            comp.save(out_comp)
            print(f"Saved {out_comp}")
