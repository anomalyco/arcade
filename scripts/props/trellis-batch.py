"""Step 2 of the prop pipeline: product shots -> 3D GLBs with TRELLIS.2 on Apple Silicon (PyTorch MPS + Metal).

Run with the trellis-mac venv (see scripts/props/README.md); scripts/props/generate.ts does this through hivemind:

  $TRELLIS_HOME/.venv/bin/python scripts/props/trellis-batch.py --work DIR [--ids a,b] [--force]

Uses the resident worker (`trellis_worker.py`, 5-minute idle unload) by default, or runs the same job executor
in-process when `--no-resident` is passed. For each `<work>/source/<id>.png` without `<work>/raw/<id>.glb`,
reuses RGBA alpha / cached cutout (or runs BiRefNet with a hard alpha > 200 threshold), runs the 512 pipeline,
and exports a 40k-triangle GLB with a 2048² UV/PBR atlas by default (`--vertex-color-only` opts out).
Timings are appended to `<work>/raw/timings.jsonl`.
"""

import argparse
import json
import os
import sys
import time
import struct

TRELLIS_HOME = os.environ.get("TRELLIS_HOME", os.path.expanduser("~/code/experiments/image-to-3d/trellis2-mac"))
if TRELLIS_HOME not in sys.path:
    sys.path.insert(0, TRELLIS_HOME)

import trellis_worker  # noqa: E402

trellis_worker._setup_env()

parser = argparse.ArgumentParser()
parser.add_argument("--work", required=True)
parser.add_argument("--ids", default="")
parser.add_argument("--force", action="store_true")
parser.add_argument("--seed", type=int, default=42)
parser.add_argument("--faces", type=int, default=40000)
parser.add_argument("--texture", type=int, default=2048)
parser.add_argument("--no-resident", action="store_true", help="Run in-process instead of using the resident trellis_worker daemon")
parser.add_argument("--idle-timeout", type=int, default=300, help="Resident worker idle unload timeout in seconds (default 300)")
parser.add_argument("--stage1a-only", action="store_true", help="Disable Stage 1B sampler/flood-fill/vertex-color changes (bit-identical mode)")
mode = parser.add_mutually_exclusive_group()
mode.add_argument("--vertex-color-only", action="store_true", help="Skip UV/PBR baking; explicit legacy vertex-only output")
mode.add_argument("--with-texture", action="store_true", help="Bake a 2048x2048 UV/PBR atlas (default)")
parser.add_argument("--shape-seeds", type=int, default=3, help="Number of coarse 32^3 shape seeds to score (default 3)")
args = parser.parse_args()

src_dir = os.path.join(args.work, "source")
raw_dir = os.path.join(args.work, "raw")
os.makedirs(raw_dir, exist_ok=True)
wanted = [s for s in args.ids.split(",") if s] or sorted(f[:-4] for f in os.listdir(src_dir) if f.endswith(".png"))
bake_texture = bool(args.with_texture or args.stage1a_only or (not args.vertex_color_only))


def cached(pid):
    path = os.path.join(raw_dir, f"{pid}.glb")
    if not os.path.exists(path):
        return False
    if not bake_texture:
        return True
    with open(path, "rb") as file:
        header = file.read(20)
        if len(header) != 20 or header[:4] != b"glTF":
            return False
        doc = json.loads(file.read(struct.unpack_from("<I", header, 12)[0]))
    return any(m.get("pbrMetallicRoughness", {}).get("baseColorTexture") for m in doc.get("materials", []))


todo = [
    i for i in wanted
    if os.path.exists(os.path.join(src_dir, f"{i}.png"))
    and (args.force or not cached(i))
]
if not todo:
    print("nothing to do")
    sys.exit(0)

fast_sampler = not args.stage1a_only
fill_interior = not args.stage1a_only
shape_seeds = 1 if args.stage1a_only else args.shape_seeds


def build_job(pid: str, report_cold: bool) -> dict:
    return {
        "cmd": "job",
        "id": pid,
        "image_path": os.path.join(src_dir, f"{pid}.png"),
        "cutout_path": os.path.join(raw_dir, f"{pid}-cutout.png"),
        "out_glb": os.path.join(raw_dir, f"{pid}.glb"),
        "out_ovoxel": None,
        "seed": args.seed,
        "faces": args.faces,
        "texture": args.texture,
        "bake_texture": bake_texture,
        "fast_sampler": fast_sampler,
        "fill_interior_voxels": fill_interior,
        "num_shape_seeds": shape_seeds,
        "report_cold_load": report_cold,
    }


t0 = time.time()
if args.no_resident:
    inline_worker = trellis_worker.TrellisResidentServer(socket_path="", idle_timeout=0)
    inline_worker.load_pipeline()
    load_s = inline_worker.initial_load_s
    cold = True
    run_job = inline_worker._execute_job
else:
    info, cold = trellis_worker.ensure_worker(idle_timeout=args.idle_timeout)
    load_s = info.get("initial_load_s", 0.0) if cold else 0.0
    print(f"resident worker ready (pid={info.get('pid')}, cold={cold}, load={load_s:.1f}s)", flush=True)
    run_job = trellis_worker.send_request

failed = [pid for pid in wanted if not os.path.exists(os.path.join(src_dir, f"{pid}.png"))]
with open(os.path.join(raw_dir, "timings.jsonl"), "a") as timings:
    for idx, pid in enumerate(todo):
        res = run_job(build_job(pid, report_cold=(cold and idx == 0)))
        if not res.get("ok"):
            print(f"{pid}: failed ({res.get('error')})", flush=True)
            failed.append(pid)
            continue
        timings.write(json.dumps(res) + "\n")
        timings.flush()
        print(json.dumps(res), flush=True)

print(f"done: {len(todo)} props in {time.time() - t0:.0f}s (load {load_s:.0f}s)")
if failed:
    raise SystemExit("Failed or missing source: " + ", ".join(failed))
