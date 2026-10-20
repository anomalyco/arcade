"""Game-camera stick renders of survivor-legs.ts frames: per-segment strips (before above after) and an optional video.

usage: survivor-legs-render.py <out_dir> <stem> [--video]
The camera matches Outbreak's: orthographic view from 1.1 rad above the ground, looking toward -Z, X to the right.
"""
import json, math, os, subprocess, sys
from PIL import Image, ImageDraw, ImageFont

out_dir, stem = sys.argv[1], sys.argv[2]
video = "--video" in sys.argv
data = json.load(open(os.path.join(out_dir, f"{stem}-frames.json")))
segments = data["segments"]
passes = data["passes"]
PITCH = 1.1
SC = 150  # px per metre
BLUE, ORANGE, WHITE, GOLD, GREEN = (90, 170, 255), (255, 140, 70), (235, 235, 235), (240, 200, 90), (110, 230, 150)


def font(sz):
    for p in ["/System/Library/Fonts/SFNSMono.ttf", "/System/Library/Fonts/Menlo.ttc"]:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, sz)
            except Exception:
                pass
    return ImageFont.load_default()


F12, F14 = font(12), font(14)


def proj(p, ox, oz, cx, cy):
    x, y, z = p[0] - ox, p[1], p[2] - oz
    return (cx + x * SC, cy - (y * math.cos(PITCH) - z * math.sin(PITCH)) * SC)


def draw_body(d, fr, ox, oz, cx, cy, ghost=None, trail=None):
    j = fr["j"]
    P = lambda k: proj(j[k], ox, oz, cx, cy)
    # Ground grid every 0.5 m so planted feet visibly stay put while the camera follows the body.
    gx0 = math.floor((ox - 2) * 2) / 2
    for i in range(10):
        gx = gx0 + i * 0.5
        d.line([proj([gx, 0, oz - 2], ox, oz, cx, cy), proj([gx, 0, oz + 2], ox, oz, cx, cy)], fill=(34, 40, 50))
    gz0 = math.floor((oz - 2) * 2) / 2
    for i in range(10):
        gz = gz0 + i * 0.5
        d.line([proj([ox - 2, 0, gz], ox, oz, cx, cy), proj([ox + 2, 0, gz], ox, oz, cx, cy)], fill=(34, 40, 50))
    if trail:
        for (px, pz, side) in trail:
            q = proj([px, 0, pz], ox, oz, cx, cy)
            d.ellipse([q[0] - 2, q[1] - 2, q[0] + 2, q[1] + 2], fill=(60, 90, 130) if side == 0 else (130, 80, 50))
    # Aim (gold) and travel (green) arrows from the pelvis on the ground.
    base = [j["pelvis"][0], 0, j["pelvis"][2]]
    a = fr["aim"]
    d.line([proj(base, ox, oz, cx, cy), proj([base[0] + math.cos(a) * 0.6, 0, base[2] + math.sin(a) * 0.6], ox, oz, cx, cy)], fill=(120, 100, 50), width=2)
    sp = math.hypot(fr["vx"], fr["vy"])
    if sp > 0.1:
        d.line([proj(base, ox, oz, cx, cy), proj([base[0] + fr["vx"] / sp * 0.5, 0, base[2] + fr["vy"] / sp * 0.5], ox, oz, cx, cy)], fill=(60, 130, 90), width=2)
    for side, col in ((0, BLUE), (1, ORANGE)):
        s = "L" if side == 0 else "R"
        planted = fr["planted"][side]
        w = 5
        d.line([P("hip" + s), P("knee" + s), P("ankle" + s)], fill=col, width=w)
        d.line([P("ankle" + s), P("ball" + s), P("toe" + s)], fill=col, width=w + (3 if planted else 0))
        d.line([P("shoulder" + s), P("elbow" + s), P("wrist" + s)], fill=tuple(int(c * 0.7) for c in col), width=3)
    d.line([P("hipL"), P("hipR")], fill=WHITE, width=3)
    d.line([P("pelvis"), P("chest"), P("neck"), P("headTop")], fill=WHITE, width=3)
    d.line([P("shoulderL"), P("shoulderR")], fill=WHITE, width=3)


def segment_frames(frames, si):
    return [k for k, f in enumerate(frames) if f["seg"] == si]


def strip(si, n=8):
    rows = []
    for p in passes:
        ks = segment_frames(p["frames"], si)
        if not ks:
            continue
        # The last second of the segment (or all of it), evenly sampled.
        ks = ks[-60:] if len(ks) > 60 else ks
        pick = [ks[int(i * (len(ks) - 1) / max(1, n - 1))] for i in range(n)]
        rows.append((p["tag"], [p["frames"][k] for k in pick]))
    W, H = 200, 240
    img = Image.new("RGB", (110 + W * n, 30 + H * len(rows)), (14, 18, 24))
    d = ImageDraw.Draw(img)
    d.text((10, 8), f"{segments[si]} · game camera · last second, {n} frames · blue left, orange right, thick = planted", fill=WHITE, font=F14)
    for r, (tag, frs) in enumerate(rows):
        d.text((10, 30 + r * H + 10), tag, fill=(255, 120, 136) if tag == "before" else (108, 242, 158), font=F14)
        for c, fr in enumerate(frs):
            x0, y0 = 110 + c * W, 30 + r * H
            d.rectangle([x0, y0, x0 + W - 2, y0 + H - 2], outline=(40, 48, 60))
            cell = Image.new("RGB", (W - 4, H - 4), (18, 22, 30))
            cd = ImageDraw.Draw(cell)
            draw_body(cd, fr, fr["j"]["pelvis"][0], fr["j"]["pelvis"][2], W // 2, int(H * 0.62))
            img.paste(cell, (x0 + 1, y0 + 1))
    name = segments[si].replace(" ", "-").replace("↔", "-").replace("→", "-")
    img.save(os.path.join(out_dir, f"{stem}-strip-{si:02d}-{name}.png"))


for si in range(len(segments)):
    strip(si)
print(f"Rendered {len(segments)} strips into {out_dir}")

if video:
    vdir = os.path.join(out_dir, f"{stem}-video")
    os.makedirs(vdir, exist_ok=True)
    n = min(len(p["frames"]) for p in passes)
    W, H = 480, 480
    trails = [[] for _ in passes]
    for k in range(n):
        img = Image.new("RGB", (W * len(passes), H + 30), (14, 18, 24))
        d = ImageDraw.Draw(img)
        for c, p in enumerate(passes):
            fr = p["frames"][k]
            prev = p["frames"][k - 1] if k else None
            for side in (0, 1):
                if fr["planted"][side] and prev and not prev["planted"][side]:
                    a = fr["j"]["ankleL" if side == 0 else "ankleR"]
                    trails[c].append((a[0], a[2], side))
            trails[c] = trails[c][-24:]
            cell = Image.new("RGB", (W - 4, H), (18, 22, 30))
            draw_body(ImageDraw.Draw(cell), fr, fr["x"], fr["y"], W // 2, int(H * 0.6), trail=trails[c])
            img.paste(cell, (c * W + 2, 30))
            col = (255, 120, 136) if p["tag"] == "before" else (108, 242, 158)
            d.text((c * W + 12, 8), f"{p['tag']} · {segments[fr['seg']]}", fill=col, font=F14)
        img.save(os.path.join(vdir, f"{k:05d}.png"))
    mp4 = os.path.join(out_dir, f"{stem}.mp4")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", "60", "-i", os.path.join(vdir, "%05d.png"), "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", mp4], check=True)
    print(f"Saved {mp4}")
