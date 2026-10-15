# /// script
# dependencies = ["numpy", "pillow", "scikit-image"]
# ///
"""Evaluate Outbreak blood splatter before/after captures against gpt-image-1.5 paint-over targets.

Computes whole-frame and per-ROI metrics (CIE DeltaE2000, Luma MAE, Beam Blood Chroma,
Outside Noir Blood Chroma, Selective Colour Ratio) and writes side-by-side comparison sheets.
"""
import json
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
from skimage.color import deltaE_ciede2000, rgb2lab

OUT_DIR = Path(__file__).resolve().parents[3] / "captures/game-feel"
W, H = 1000, 680

ROIS = {
    "street": {
        "beam_blood": (468, 145, 558, 305),
        "outside_blood": (345, 225, 428, 305),
        "wall_splatter": (495, 135, 558, 185),
    },
    "interior": {
        "threshold_pool": (468, 222, 532, 285),
        "rug_fan": (462, 138, 548, 228),
        "wall_drips": (485, 68, 548, 138),
    },
}


def load_rgb(path: Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert("RGB").resize((W, H), Image.Resampling.LANCZOS), dtype=np.float64) / 255.0


def crop(img: np.ndarray, box: tuple[int, int, int, int]) -> np.ndarray:
    x0, y0, x1, y1 = box
    return img[y0:y1, x0:x1]


def roi_metrics(cap: np.ndarray, tgt: np.ndarray) -> dict:
    lab_c = rgb2lab(cap)
    lab_t = rgb2lab(tgt)
    de_pixel = float(deltaE_ciede2000(lab_c, lab_t).mean())
    mean_c = lab_c.reshape(-1, 3).mean(0, keepdims=True)
    mean_t = lab_t.reshape(-1, 3).mean(0, keepdims=True)
    de_mean = float(deltaE_ciede2000(mean_c, mean_t)[0])
    chroma_c = float(((cap.max(axis=-1) - cap.min(axis=-1)) * 255.0).mean())
    chroma_t = float(((tgt.max(axis=-1) - tgt.min(axis=-1)) * 255.0).mean())
    red_dominance_c = float((np.maximum(0.0, cap[..., 0] - np.maximum(cap[..., 1], cap[..., 2])) * 255.0).mean())
    red_dominance_t = float((np.maximum(0.0, tgt[..., 0] - np.maximum(tgt[..., 1], tgt[..., 2])) * 255.0).mean())
    return {
        "dE2000_mean": round(de_mean, 2),
        "dE2000_pixel": round(de_pixel, 2),
        "L_mean": [round(float(lab_c[..., 0].mean()), 2), round(float(lab_t[..., 0].mean()), 2)],
        "a_mean": [round(float(lab_c[..., 1].mean()), 2), round(float(lab_t[..., 1].mean()), 2)],
        "chroma": [round(chroma_c, 2), round(chroma_t, 2)],
        "red_dominance": [round(red_dominance_c, 2), round(red_dominance_t, 2)],
    }


def build_sheets(before: dict, target: dict, after: dict) -> None:
    # 1. Full-frame Before / Target / After comparison sheet
    cw, ch = 480, 326
    pad = 26
    sheet = Image.new("RGB", (cw * 3, (ch + pad) * 2), "#0e1316")
    draw = ImageDraw.Draw(sheet)
    for row, scene in enumerate(("street", "interior")):
        y0 = row * (ch + pad)
        for col, (label, imgs) in enumerate((("BEFORE (Legacy Splatter)", before), ("TARGET (gpt-image-1.5 Paint-Over)", target), ("AFTER (Wet Ballistic + Noir)", after))):
            im = Image.fromarray((imgs[scene] * 255.0).astype(np.uint8)).resize((cw, ch), Image.Resampling.LANCZOS)
            sheet.paste(im, (col * cw, y0 + pad))
            draw.text((col * cw + 10, y0 + 6), f"{scene.upper()} — {label}", fill="#e4e2d6")
    sheet.save(OUT_DIR / "blood-comparison-sheet.png")

    # 2. Cropped ROI comparison sheet (all 6 ROIs across street & interior)
    all_rois = [(f"street:{k}", "street", box) for k, box in ROIS["street"].items()] + [
        (f"interior:{k}", "interior", box) for k, box in ROIS["interior"].items()
    ]
    tw, th = 260, 200
    crop_sheet = Image.new("RGB", (tw * 3, (th + 24) * len(all_rois)), "#12181c")
    cdraw = ImageDraw.Draw(crop_sheet)
    for r, (title, scene, box) in enumerate(all_rois):
        y0 = r * (th + 24)
        for col, (label, imgs) in enumerate((("before", before), ("target", target), ("after", after))):
            c_arr = crop(imgs[scene], box)
            cim = Image.fromarray((c_arr * 255.0).astype(np.uint8))
            scale = min(tw / cim.width, th / cim.height)
            cim = cim.resize((max(1, round(cim.width * scale)), max(1, round(cim.height * scale))), Image.Resampling.NEAREST)
            crop_sheet.paste(cim, (col * tw + (tw - cim.width) // 2, y0 + 22 + (th - cim.height) // 2))
            cdraw.text((col * tw + 8, y0 + 4), f"{title} / {label}", fill="#d6deda")
    crop_sheet.save(OUT_DIR / "blood-crops-sheet.png")


def main() -> None:
    before = {s: load_rgb(OUT_DIR / f"blood-before-{s}.png") for s in ("street", "interior")}
    target = {s: load_rgb(OUT_DIR / f"blood-target-{s}.png") for s in ("street", "interior")}
    after = {s: load_rgb(OUT_DIR / f"blood-after-{s}.png") for s in ("street", "interior")}

    report: dict = {"scenes": {}}
    for scene in ("street", "interior"):
        report["scenes"][scene] = {"before": {}, "after": {}}
        for phase_name, imgs in (("before", before), ("after", after)):
            rois_out = {}
            for rname, box in ROIS[scene].items():
                rois_out[rname] = roi_metrics(crop(imgs[scene], box), crop(target[scene], box))
            report["scenes"][scene][phase_name] = rois_out

        if scene == "street":
            for phase_name in ("before", "after"):
                b_red = report["scenes"]["street"][phase_name]["beam_blood"]["red_dominance"][0]
                o_red = report["scenes"]["street"][phase_name]["outside_blood"]["red_dominance"][0]
                report["scenes"]["street"][phase_name]["noir_selective_red_ratio"] = round(b_red / max(0.25, o_red), 2)

    build_sheets(before, target, after)
    (OUT_DIR / "blood-metrics.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
