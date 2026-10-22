"""uv run --with numpy --with pillow --with scipy motion-metrics.py GALLERY

Track fixed world points on two fabric panels and the carpet through the saved
camera matrices. Temporal residual measures crawling, not intended camera motion.
"""
import json
import sys
from pathlib import Path
import numpy as np
from PIL import Image
from scipy.ndimage import map_coordinates

root = Path(sys.argv[1])
z, y = np.meshgrid(np.linspace(.2, .95, 48), np.linspace(.24, 1.24, 48))
regions = {"right_fabric": np.stack([np.full_like(z, 1.135), y, z, np.ones_like(z)], axis=-1).reshape(-1, 4),
           "left_fabric": np.stack([np.full_like(z, -1.135), y, z, np.ones_like(z)], axis=-1).reshape(-1, 4)}
z, y = np.meshgrid(np.linspace(1.05, 1.45, 256), np.linspace(.9, 1.3, 32))
regions["left_bands"] = np.stack([np.full_like(z, -1.135), y, z, np.ones_like(z)], axis=-1).reshape(-1, 4)
x, z = np.meshgrid(np.linspace(-.7, .7, 64), np.linspace(-1.4, .2, 48))
regions["carpet"] = np.stack([x, np.zeros_like(x), z, np.ones_like(x)], axis=-1).reshape(-1, 4)
result = {"method":"60 Hz; bilinear luminance at fixed world points, static lighting/dust; display RGB /255", "variants":{}}
poses = None
for variant in sys.argv[2:] or ["motion-before", "motion-filter-only", "motion-after"]:
    folder = root / variant
    trace = json.loads((folder / "trace.json").read_text())
    assert not trace.get("errors"), f"GPU errors in {variant}"
    current = np.array([f["eye"] + f["viewProj"] for f in trace["trace"]])
    if poses is not None:
        assert np.max(np.abs(current-poses)) < 1e-6, "Camera paths differ"
    poses = current
    samples = {name: [] for name in regions}
    for frame in trace["trace"]:
        rgb = np.asarray(Image.open(folder / f"{frame['frame']:03}.png").convert("RGB"), dtype=float)/255
        lum = rgb @ np.array([.2126, .7152, .0722])
        vp = np.array(frame["viewProj"]).reshape(4, 4).T
        for name, points in regions.items():
            clip = points @ vp.T
            ndc = clip[:, :3] / clip[:, 3:4]
            px = (ndc[:, 0]*.5+.5)*trace["width"]-.5
            py = (.5-ndc[:, 1]*.5)*trace["height"]-.5
            values = map_coordinates(lum, [py, px], order=1, mode="constant", cval=np.nan)
            values[(clip[:, 3]<=0)|(np.abs(ndc[:,0])>.97)|(np.abs(ndc[:,1])>.97)] = np.nan
            samples[name].append(values)
    stats = {}
    for name, frames in samples.items():
        a = np.array(frames); a = a[:, np.isfinite(a).all(axis=0)]
        delta = np.diff(a, axis=0)
        stats[name] = {"points":a.shape[1], "delta_rms":float(np.sqrt(np.mean(delta**2))),
            "delta_abs_p90":float(np.percentile(np.abs(delta),90)), "temporal_std_mean":float(np.std(a,axis=0).mean())}
    result["variants"][variant] = stats
result["caveat"] = "Reprojected surface samples, not a perceptual score or performance claim. All camera paths match."
(root / "motion-metrics.json").write_text(json.dumps(result, indent=2))
print(json.dumps(result, indent=2))
