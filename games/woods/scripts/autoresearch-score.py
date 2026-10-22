# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow", "scipy", "scikit-image"]
# ///
"""uv run games/woods/scripts/autoresearch-score.py CAPTURE_DIR TARGET_ROOT

Target distance is a direction aid, not a realism score. Paint-overs are unregistered:
60% Lab marginal histogram Wasserstein, 25% regional tone, 15% coarse luminance SSIM.
All crops exclude HUD margins and compare upper forest / middle / ground separately.
Scrawl's unwanted frames are NOT optimization targets; their checkpoint-2 paint-overs are.
"""
import json
import sys
from pathlib import Path
import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter
from scipy.stats import wasserstein_distance
from skimage.color import rgb2lab
from skimage.metrics import structural_similarity

root, targets = map(Path, sys.argv[1:3])
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

result = {"definition": "v2; display luminance unless linear_ prefixed; dark <0.04; p5 <0.025; signal requires >=40/80 depth-visible points, delta >=0.02 and contrast >=0.25", "variants": {}}
for variant, records in manifest["variants"].items():
    directory = root / variant
    views = {}
    tones = {}
    for name in records:
        if name == "motion": continue
        current = image(directory / f"{name}.png")
        tones[name] = tone(current[22:338, 20:620])
        target = targets / "paintover" / f"po-{NAMES[name]}.jpg" if name in NAMES else targets / "look/checkpoints/2/renders" / f"po-{name}.png"
        if target.exists(): views[name] = distance(current, image(target))
    darks = [tones[f"l{n}"]["dark_pct"] for n in [0, 1, 2, 4] if f"l{n}" in tones]
    strict_dark = all(b >= a for a, b in zip(darks, darks[1:])) if len(darks) == 4 else None
    gpu = [r["gpu"]["median"] for name, r in records.items() if name != "motion" and r.get("gpu")]
    sig = signal(records, directory)
    summary = dict(distance=float(np.mean([v["distance"] for v in views.values()])) if views else None, views=views, tone=tones,
                   gpu_median=float(np.median(gpu)), gpu_view_p95=float(np.quantile(gpu, .95)),
                   signal=sig, motion=records.get("motion"),
                   constraints=dict(dark_monotone=strict_dark, dark_percentages=darks,
                                    no_milky_lift=all(t["p5"] < .025 for t in tones.values()), signal_visible=sig and sig["visible"]))
    result["variants"][variant] = summary
    print("METRIC", variant, json.dumps({k: summary[k] for k in ["distance", "gpu_median", "gpu_view_p95", "constraints", "signal"]}))
(root / "score.json").write_text(json.dumps(result, indent=2))
