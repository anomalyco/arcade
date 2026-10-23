# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow", "scipy", "scikit-image"]
# ///
"""uv run games/barbara/scripts/autoresearch-score.py CAPTURE_DIR TARGET_ROOT [FIXED_MASK_BASELINE_DIR]

Target distance is a direction aid, not a realism score. Paint-overs are unregistered:
60% Lab marginal histogram Wasserstein, 25% regional tone, 15% coarse luminance SSIM.
All crops exclude HUD margins and compare upper forest / middle / ground separately.
Scrawl's unwanted frames are NOT optimization targets; their checkpoint-2 paint-overs are.
"""
import json
import sys
import os
from pathlib import Path
import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter
from scipy.stats import wasserstein_distance
from skimage.color import rgb2lab
from skimage.metrics import structural_similarity

root, targets = map(Path, sys.argv[1:3])
baseline = Path(sys.argv[3]) if len(sys.argv) > 3 else None
manifest = json.loads((root / "capture.json").read_text())
NAMES = {"camp": "camp", "beam": "friend-beam", "trail": "tape-trail", "marker": "marker"}
REGIONS = {"upper": (0.06, 0.38), "middle": (0.38, 0.72), "ground": (0.72, 0.94)}

def image(path):
    return np.asarray(Image.open(path).convert("RGB").resize((640, 360), Image.Resampling.LANCZOS), dtype=float) / 255

def lum(rgb):
    return rgb @ [0.2126, 0.7152, 0.0722]

def tone(rgb):
    y = lum(rgb)
    lin = np.where(rgb <= .04045, rgb / 12.92, ((rgb + .055) / 1.055) ** 2.4) @ [0.2126, .7152, .0722]
    return dict(p5=float(np.quantile(y, .05)), median=float(np.median(y)), p95=float(np.quantile(y, .95)),
                dark_pct=float(np.mean(y < .04) * 100), local_contrast=float(np.mean(np.abs(y - gaussian_filter(y, 3)))),
                black_pct=float(np.mean(y < 1 / 255) * 100), clipped_pct=float(np.mean(np.max(rgb, axis=-1) >= 254 / 255) * 100),
                linear_p5=float(np.quantile(lin, .05)), linear_median=float(np.median(lin)), linear_p95=float(np.quantile(lin, .95)))

def distance(a, b):
    regions = {}
    for name, (y0, y1) in REGIONS.items():
        aa, bb = [v[int(y0 * 360):int(y1 * 360), 20:620] for v in [a, b]]
        la, lb = rgb2lab(aa), rgb2lab(bb)
        hist = sum(wasserstein_distance(la[..., i].ravel(), lb[..., i].ravel()) / scale for i, scale in enumerate([100, 128, 128])) / 3
        ta, tb = tone(aa), tone(bb)
        terr = sum(abs(ta[k] - tb[k]) for k in ["p5", "median", "p95"]) / 3
        ya, yb = lum(aa), lum(bb)
        # Low-frequency structure only: not a pixel alignment / texture fidelity claim.
        ssims = [structural_similarity(gaussian_filter(ya, s)[::s, ::s], gaussian_filter(yb, s)[::s, ::s], data_range=1) for s in [2, 4, 8]]
        structural = 1 - float(np.mean(ssims))
        regions[name] = dict(lab_histogram=hist, tone_error=terr, coarse_ssim_distance=structural,
                             distance=.6 * hist + .25 * terr + .15 * structural, current=ta, target=tb)
    return dict(distance=float(np.mean([r["distance"] for r in regions.values()])), regions=regions)

def signal(records, directory):
    if "signal60" not in records or "signal60off" not in records:
        return None
    on, off = [lum(image(directory / f"{n}.png")) for n in ["signal60", "signal60off"]]
    rec = records["signal60"]
    depth = rec.get("signalDepth", {})
    points = depth if isinstance(depth, list) else depth.get("points", [])
    visible_points = [p for p in points if p["visible"]]
    valid_probe = len(visible_points) >= 40
    if not valid_probe:
        return dict(valid_probe=False, unoccluded_points=len(visible_points), visible=False,
                    reason="fewer than 40/80 unoccluded shaft samples" if points else "no depth evidence recorded")
    torch = next(t for t in rec["torches"] if t["kind"] == "remote")
    vp = np.array(rec["viewProj"]).reshape(4, 4).T
    mask = np.zeros_like(on, dtype=bool)
    for index, d in enumerate(np.linspace(3, 23, 80)):
        if points and not points[index]["visible"]: continue
        p = np.array(torch["pos"]) + np.array(torch["dir"]) * d
        clip = vp @ np.r_[p, 1]
        if clip[3] <= 0: continue
        x = int((clip[0] / clip[3] * .5 + .5) * 640)
        y = int((.5 - clip[1] / clip[3] * .5) * 360)
        if 6 <= x < 634 and 6 <= y < 354: mask[y-5:y+6, x-5:x+6] = True
    if mask.sum() < 50: raise ValueError("signal shaft ROI is outside frame or occluded")
    delta = float(np.quantile((on - off)[mask], .9))
    background = float(np.median(off[mask]))
    return dict(delta_p90=delta, background=background, contrast=delta / max(background, .01),
                valid_probe=valid_probe, unoccluded_points=len(visible_points),
                 visible=bool(valid_probe and delta >= .02 and delta / max(background, .01) >= .25), pixels=int(mask.sum()))

def trunk_contrast(record, path):
    probe = record.get("trunkDepth")
    if not probe: return None
    # Native-resolution luminance: preserve narrow distant trunks. A vertical 3-pixel
    # mean reduces sensor noise without mixing across either silhouette edge.
    y = lum(np.asarray(Image.open(path).convert("RGB"), dtype=float) / 255)
    assert y.shape == (probe["height"], probe["width"])
    bins = {}
    for lo, hi in [(8, 20), (20, 30), (30, 50), (50, 100)]:
        points = [p for p in probe["points"] if lo <= p["distance"] < hi]
        pairs = [(float(y[p["y"]-1:p["y"]+2, p["x"]].mean()),
                  float(y[p["y"]-1:p["y"]+2, p["bx"]].mean())) for p in points]
        absolute = [abs(a-b) for a,b in pairs]
        contrast = [abs(a-b) / max(a+b, .02) for a,b in pairs]
        bins[f"{lo}-{hi}"] = dict(samples=len(points), sufficient=len(points) >= 10,
            absolute_median=float(np.median(absolute)) if pairs else None,
            contrast_median=float(np.median(contrast)) if pairs else None,
            absolute_p90=float(np.quantile(absolute, .9)) if pairs else None)
    return bins

def near_bark(path):
    # Fixed native-pixel ROI inside the deterministic trunkClose silhouette. Never
    # choose pixels by candidate brightness: that would hide a clipped highlight.
    rgb = np.asarray(Image.open(path).convert("RGB"), dtype=float)
    h, w = rgb.shape[:2]
    roi = rgb[int(h*.18):int(h*.88), int(w*.43):int(w*.59)]
    peak = roi.max(axis=-1)
    y = lum(roi / 255)
    hot = rgb[int(h*.55):int(h*.73), int(w*.55):int(w*.59)] / 255
    hy = lum(hot)
    return dict(roi_normalized=[.43,.18,.59,.88], pixels=int(peak.size),
                max_channel_clip_pct=float(np.mean(peak == 255)*100),
                near_clip_pct=float(np.mean(peak >= 254)*100),
                p95=float(np.quantile(y,.95)),
                hotspot_contrast=float(np.std(hy)),
                hotspot_detail=float(np.mean(np.abs(hy-gaussian_filter(hy,3)))))

result = {"definition": "v3; display luminance unless linear_ prefixed; dark <0.04; p5 <0.025 on p5_guard_views (close-up trunk detail probes excluded); signal requires >=40/80 depth-visible points, delta >=0.02 and contrast >=0.25", "variants": {}}
for variant, records in manifest["variants"].items():
    directory = root / variant
    views = {}
    tones = {}
    target_tones = {}
    depth = {}
    for name in records:
        if name in ["motion", "adaptation", "profile"]: continue
        current = image(directory / f"{name}.png")
        tones[name] = tone(current[22:338, 20:620])
        depth[name] = trunk_contrast(records[name], directory / f"{name}.png")
        target = targets / "paintover" / f"po-{NAMES[name]}.jpg" if name in NAMES else targets / "look/checkpoints/2/renders" / f"po-{name}.png"
        if os.environ.get("AUTORESEARCH_TARGETS"):
            candidates = [Path(p) / f"{name}.png" for p in os.environ["AUTORESEARCH_TARGETS"].split(os.pathsep)]
            target = next((p for p in candidates if p.exists()), candidates[0])
        if target.exists():
            reference = image(target)
            views[name] = distance(current, reference)
            target_tones[name] = tone(reference[22:338, 20:620])
    darks = [tones[f"l{n}"]["dark_pct"] for n in [0, 1, 2, 4] if f"l{n}" in tones]
    strict_dark = all(b >= a for a, b in zip(darks, darks[1:])) if len(darks) == 4 else None
    gpu = [r["gpu"]["median"] for name, r in records.items() if isinstance(r, dict) and r.get("gpu")]
    sig = signal(records, directory)
    between = {}
    if baseline and all((baseline / f"l{n}.png").exists() for n in [0, 4]):
        off, on = [lum(image(baseline / f"l{n}.png"))[22:338, 20:620] for n in [0, 4]]
        # Fixed old-build mask, shared by every candidate: dark surroundings outside strongly lit beam pixels.
        mask = (off < .08) & ((on - off) < .025)
        for n in [0, 1, 2, 4]:
            if f"l{n}" not in tones: continue
            y = lum(image(directory / f"l{n}.png"))[22:338, 20:620][mask]
            between[f"l{n}"] = dict(p5=float(np.quantile(y, .05)), median=float(np.median(y)), dark_pct=float(np.mean(y < .04) * 100), pixels=int(mask.sum()))
    guard_views = [name for name in tones if name not in ["trunkFoot", "trunkClose"]]
    summary = dict(distance=float(np.mean([v["distance"] for v in views.values()])) if views else None, views=views, tone=tones,
                    gpu_median=float(np.median(gpu)) if gpu else None, gpu_view_p95=float(np.quantile(gpu, .95)) if gpu else None,
                    near_bark=near_bark(directory / "trunkClose.png") if "trunkClose" in records else None,
                    signal=sig, trunk_depth=depth, motion=records.get("motion"), adaptation=records.get("adaptation"), target_tone=target_tones, between_beams=between,
                   proposed_target_bounds={name: dict(p5_max=t["p5"] + .008, dark_min=max(0, t["dark_pct"] - 12), dark_max=min(100, t["dark_pct"] + 12)) for name, t in target_tones.items()},
                   constraints=dict(dark_monotone=strict_dark, dark_percentages=darks,
                                     p5_guard_views=guard_views,
                                     no_milky_lift=all(tones[name]["p5"] < .025 for name in guard_views) if guard_views else None, signal_visible=sig and sig["visible"]))
    result["variants"][variant] = summary
    print("METRIC", variant, json.dumps({k: summary[k] for k in ["distance", "gpu_median", "gpu_view_p95", "constraints", "signal"]}))
(root / "score.json").write_text(json.dumps(result, indent=2))
