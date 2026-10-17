#!/usr/bin/env bash
#
# Reproducible setup and patch applicator for the Apple Silicon TRELLIS.2
# runtime used by scripts/props/ (see scripts/props/README.md).
#
# Usage:
#   bash scripts/props/setup-trellis.sh [--dir PATH] [--apply-only] [--check-only]
#
# Clones the pinned upstream commits in scripts/props/patches/manifest.json,
# idempotently applies the Stage 1 patches (rejecting mismatched base commits
# cleanly), and unless --apply-only / --check-only is passed, builds the
# Python 3.11 + Metal (.venv) environment.
#
# Model weights (~11 GB in ~/.cache/huggingface/hub) and .venv stay external to Git.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PATCH_DIR="$SCRIPT_DIR/patches"
TARGET_DIR="${TRELLIS_HOME:-$HOME/code/experiments/image-to-3d/trellis2-mac}"
MODE="full"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)
      TARGET_DIR="$2"
      shift 2
      ;;
    --apply-only)
      MODE="apply"
      shift
      ;;
    --check-only)
      MODE="check"
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: $0 [--dir PATH] [--apply-only] [--check-only]" >&2
      exit 2
      ;;
  esac
done

clone_at_commit() {
  local name="$1" url="$2" dest="$3" commit="$4"
  if [[ ! -d "$dest/.git" ]]; then
    echo "▸ Cloning $name ($url @ ${commit:0:7}) -> $dest"
    mkdir -p "$(dirname "$dest")"
    git clone "$url" "$dest"
    git -C "$dest" checkout "$commit"
  else
    if ! git -C "$dest" merge-base --is-ancestor "$commit" HEAD 2>/dev/null; then
      echo "ERROR: $name at $dest is at $(git -C "$dest" rev-parse --short HEAD), which does not descend from required base commit $commit." >&2
      exit 1
    fi
  fi
}

apply_patch_idempotent() {
  local name="$1" dest="$2" commit="$3" patch_file="$4"
  if [[ ! -f "$patch_file" ]]; then
    echo "ERROR: Missing patch file $patch_file" >&2
    exit 1
  fi
  if ! git -C "$dest" merge-base --is-ancestor "$commit" HEAD 2>/dev/null; then
    echo "ERROR: Refusing to apply $(basename "$patch_file") to $name ($dest): HEAD $(git -C "$dest" rev-parse --short HEAD) is not based on $commit." >&2
    exit 1
  fi
  if git -C "$dest" apply --reverse --check "$patch_file" 2>/dev/null; then
    echo "✓ $name: $(basename "$patch_file") already applied"
    return 0
  fi
  if git -C "$dest" apply --check "$patch_file" 2>/dev/null; then
    if [[ "$MODE" == "check" ]]; then
      echo "✓ $name: $(basename "$patch_file") applies cleanly (check-only)"
    else
      git -C "$dest" apply "$patch_file"
      echo "✓ $name: applied $(basename "$patch_file")"
    fi
    return 0
  fi
  echo "ERROR: $(basename "$patch_file") does not apply cleanly to $name at $dest (expected base $commit, current HEAD $(git -C "$dest" rev-parse --short HEAD))." >&2
  exit 1
}

clone_at_commit "trellis-mac"    "https://github.com/shivampkumar/trellis-mac.git"        "$TARGET_DIR"                      "d58628f4f5b9c3de8274cb110074154f4b31cef2"
clone_at_commit "TRELLIS.2"      "https://github.com/microsoft/TRELLIS.2.git"             "$TARGET_DIR/TRELLIS.2"            "75fbf0183001ed9876c8dbb35de6b68552ee08bd"
clone_at_commit "trellis2-apple" "https://github.com/pedronaugusto/trellis2-apple.git"    "$TARGET_DIR/deps/trellis2-apple"  "17347247c91c36c8cdc1896234983e878a457bba"
clone_at_commit "mtlbvh"         "https://github.com/pedronaugusto/mtlbvh.git"            "$TARGET_DIR/deps/mtlbvh"          "6b2a0f63b476ad8225695d092902104beafd7f58"
clone_at_commit "mtldiffrast"    "https://github.com/pedronaugusto/mtldiffrast.git"       "$TARGET_DIR/deps/mtldiffrast"     "c9499ba2e4ed6849e95ce5da7aae5bf61addb528"
clone_at_commit "mtlgemm"        "https://github.com/pedronaugusto/mtlgemm.git"           "$TARGET_DIR/deps/mtlgemm"         "566c133781ce4992de3f77c3a97dd6feaae9d013"
clone_at_commit "mtlmesh"        "https://github.com/pedronaugusto/mtlmesh.git"           "$TARGET_DIR/deps/mtlmesh"         "7de3864f783407201486bf6c900a4bd76a4018a3"
clone_at_commit "utils3d"        "https://github.com/EasternJournalist/utils3d.git"       "$TARGET_DIR/deps/utils3d"         "9a4eb15e4021b67b12c460c7057d642626897ec8"

apply_patch_idempotent "trellis-mac"    "$TARGET_DIR"                     "d58628f4f5b9c3de8274cb110074154f4b31cef2" "$PATCH_DIR/trellis-mac.patch"
apply_patch_idempotent "TRELLIS.2"      "$TARGET_DIR/TRELLIS.2"           "75fbf0183001ed9876c8dbb35de6b68552ee08bd" "$PATCH_DIR/trellis2.patch"
apply_patch_idempotent "trellis2-apple" "$TARGET_DIR/deps/trellis2-apple" "17347247c91c36c8cdc1896234983e878a457bba" "$PATCH_DIR/trellis2-apple.patch"

if [[ "$MODE" == "check" ]]; then
  echo "All patches verified."
  exit 0
fi

if [[ "$MODE" == "apply" ]]; then
  if [[ -x "$TARGET_DIR/.venv/bin/python" ]]; then
    "$TARGET_DIR/.venv/bin/python" "$TARGET_DIR/patches/mps_compat.py"
    if [[ -d "$TARGET_DIR/.venv/lib/python3.11/site-packages/o_voxel" ]]; then
      cp "$TARGET_DIR/deps/trellis2-apple/o-voxel/o_voxel/postprocess.py" "$TARGET_DIR/.venv/lib/python3.11/site-packages/o_voxel/postprocess.py"
    fi
  fi
  echo "Patches applied to $TARGET_DIR."
  exit 0
fi

cd "$TARGET_DIR"
if [[ ! -d ".venv" ]]; then
  if command -v uv &>/dev/null; then
    uv venv .venv --python python3.11
  else
    python3.11 -m venv .venv
  fi
fi

source .venv/bin/activate
if command -v uv &>/dev/null; then
  PIP="uv pip install"
else
  PIP="pip install"
fi

$PIP torch torchvision torchaudio transformers accelerate huggingface_hub safetensors pillow numpy trimesh scipy tqdm easydict kornia timm imageio opencv-python-headless xatlas fast-simplification setuptools wheel pybind11
$PIP "deps/utils3d"

if [[ "${SKIP_METAL:-0}" != "1" ]]; then
  export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-12.0}"
  PIP_NB="$PIP --no-build-isolation"
  $PIP_NB "deps/mtlbvh"
  $PIP_NB "deps/mtldiffrast"
  $PIP_NB "deps/mtlmesh"
  $PIP_NB "deps/mtlgemm"
  $PIP_NB "deps/trellis2-apple/o-voxel"
fi

python3 patches/mps_compat.py
python3 tests/test_worker_and_extract.py
echo "=== TRELLIS.2 Stage 1 setup complete at $TARGET_DIR ==="
