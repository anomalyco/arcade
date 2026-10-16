"""Step 2 of the prop pipeline: product shots -> textured GLBs with TRELLIS.2 on Apple Silicon (PyTorch MPS + Metal).

Run with the trellis-mac venv (see scripts/props/README.md); scripts/props/generate.ts does this through hivemind:

  $TRELLIS_HOME/.venv/bin/python scripts/props/trellis-batch.py --work DIR [--ids a,b] [--force]

Loads the pipeline once, then for each <work>/source/<id>.png without <work>/raw/<id>.glb: removes the background
(BiRefNet, then a hard alpha threshold so soft shadow pixels do not become a floor card), runs the 512 pipeline and
bakes a 40k-triangle GLB with 2048² base colour + metallic/roughness. Timings go to <work>/raw/timings.jsonl.
"""

import argparse
import json
import os
import sys
import time

TRELLIS_HOME = os.environ.get("TRELLIS_HOME", os.path.expanduser("~/code/experiments/image-to-3d/trellis2-mac"))
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
os.environ.setdefault("ATTN_BACKEND", "sdpa")
os.environ.setdefault("SPARSE_ATTN_BACKEND", "sdpa")
try:
    import flex_gemm  # noqa: F401
    os.environ.setdefault("SPARSE_CONV_BACKEND", "flex_gemm")
except (ImportError, RuntimeError):
    os.environ.setdefault("SPARSE_CONV_BACKEND", "none")
sys.path.insert(0, os.path.join(TRELLIS_HOME, "TRELLIS.2"))
sys.path.insert(0, TRELLIS_HOME)
sys.path.append(os.path.join(TRELLIS_HOME, "stubs"))

import numpy as np  # noqa: E402
import torch  # noqa: E402
from PIL import Image  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--work", required=True)
parser.add_argument("--ids", default="")
parser.add_argument("--force", action="store_true")
parser.add_argument("--seed", type=int, default=42)
parser.add_argument("--faces", type=int, default=40000)
parser.add_argument("--texture", type=int, default=2048)
args = parser.parse_args()

src_dir = os.path.join(args.work, "source")
raw_dir = os.path.join(args.work, "raw")
os.makedirs(raw_dir, exist_ok=True)
wanted = [s for s in args.ids.split(",") if s] or sorted(f[:-4] for f in os.listdir(src_dir) if f.endswith(".png"))
todo = [i for i in wanted if os.path.exists(os.path.join(src_dir, f"{i}.png")) and (args.force or not os.path.exists(os.path.join(raw_dir, f"{i}.glb")))]
if not todo:
    print("nothing to do")
    sys.exit(0)

t0 = time.time()
from trellis2.pipelines.trellis2_image_to_3d import Trellis2ImageTo3DPipeline  # noqa: E402

pipeline = Trellis2ImageTo3DPipeline.from_pretrained("microsoft/TRELLIS.2-4B")
pipeline.to(torch.device("mps"))
load_s = time.time() - t0
print(f"pipeline loaded in {load_s:.1f}s", flush=True)

import fast_simplification  # noqa: E402
import o_voxel.postprocess  # noqa: E402

if not getattr(o_voxel.postprocess, "_HAS_FLEX_GEMM", False):
    import torch.nn.functional as F

    def _gs3d_fix(feats, coords, shape, grid, mode="trilinear"):
        B, C, D, H, W = shape[0], shape[1], shape[2], shape[3], shape[4]
        vol = torch.zeros(B, C, D, H, W, dtype=feats.dtype, device=feats.device)
        vol[coords[:, 0].long(), :, coords[:, 1].long(), coords[:, 2].long(), coords[:, 3].long()] = feats
        g = torch.stack([grid[..., 2] / (W - 1) * 2 - 1, grid[..., 1] / (H - 1) * 2 - 1, grid[..., 0] / (D - 1) * 2 - 1], dim=-1).reshape(B, 1, 1, -1, 3)
        s = F.grid_sample(vol, g, mode="bilinear", align_corners=True, padding_mode="border")
        return s.reshape(B, C, grid.shape[1]).permute(0, 2, 1).reshape(B * grid.shape[1], C)

    o_voxel.postprocess._grid_sample_3d = _gs3d_fix


def cutout(path):
    """BiRefNet matte with a hard threshold: soft shadow pixels under the object must not survive."""
    rgb = Image.open(path).convert("RGB")
    rgba = np.array(pipeline.rembg_model(rgb))
    rgba[:, :, 3] = np.where(rgba[:, :, 3] > 200, 255, 0).astype(np.uint8)
    return Image.fromarray(rgba, "RGBA")


timings = open(os.path.join(raw_dir, "timings.jsonl"), "a")
for pid in todo:
    t = time.time()
    img = cutout(os.path.join(src_dir, f"{pid}.png"))
    img.save(os.path.join(raw_dir, f"{pid}-cutout.png"))
    t_cut = time.time() - t
    out = pipeline.run(img, seed=args.seed, pipeline_type="512")
    mesh = out[0] if isinstance(out, list) else out
    t_gen = time.time() - t - t_cut
    v = mesh.vertices.cpu().numpy()
    f = mesh.faces.cpu().numpy()
    if v.shape[0] == 0 or f.shape[0] == 0:
        print(f"{pid}: empty mesh (GPU watchdog?), skipped", flush=True)
        continue
    target = min(200000, len(f))
    if len(f) > target:
        sv, sf = fast_simplification.simplify(v, f, 1.0 - target / len(f))
        vt, ft = torch.from_numpy(sv).float(), torch.from_numpy(sf.astype("int32"))
    else:
        vt, ft = mesh.vertices.cpu(), mesh.faces.cpu()
    glb = o_voxel.postprocess.to_glb(
        vertices=vt, faces=ft, attr_volume=mesh.attrs.cpu(), coords=mesh.coords.cpu(), attr_layout=mesh.layout,
        voxel_size=mesh.voxel_size, aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
        decimation_target=args.faces, texture_size=args.texture, verbose=False,
    )
    glb.export(os.path.join(raw_dir, f"{pid}.glb"))
    total = time.time() - t
    rec = {"id": pid, "cutout_s": round(t_cut, 1), "generate_s": round(t_gen, 1), "bake_s": round(total - t_cut - t_gen, 1), "total_s": round(total, 1), "raw_tris": int(len(f)), "load_s": round(load_s, 1), "at": time.strftime("%Y-%m-%dT%H:%M:%S")}
    timings.write(json.dumps(rec) + "\n")
    timings.flush()
    print(json.dumps(rec), flush=True)
    if torch.backends.mps.is_available():
        torch.mps.empty_cache()

print(f"done: {len(todo)} props in {time.time() - t0:.0f}s (load {load_s:.0f}s)")
