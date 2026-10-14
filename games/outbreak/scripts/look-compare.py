# /// script
# dependencies = ["numpy", "pillow", "scikit-image"]
# ///
"""Compare look-proof captures with the sodium-70s paintover targets.

Usage: uv run games/outbreak/scripts/look-compare.py <phaseA> <phaseB> [out-dir]
Phases are captures/outbreak-look/<phase>/ directories written by look-proof.ts (LOOK_PHASE).
Targets default to ~/code/home/artifacts/2026-10-14-outbreak-review (OUTBREAK_TARGETS overrides).

The targets are paintings with different geometry, so whole-frame ΔE2000 is a coarse tone/palette signal.
Per-region metrics pair semantically matching boxes (capture box vs target box) and compare mean colour
(ΔE2000 of region means), lightness contrast (L* std) and warm share. Crops are written for visual review.
"""
import json
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from skimage.color import deltaE_ciede2000, rgb2lab

ROOT = Path(__file__).resolve().parents[3] / "captures/outbreak-look"
TARGETS = Path(os.environ.get("OUTBREAK_TARGETS", Path.home() / "code/home/artifacts/2026-10-14-outbreak-review"))
W, H = 1000, 680
HUD = (0, 575, 410, 680)  # hotbar + status panel, excluded from whole-frame metrics

# (name, capture box at 1000x680, target box at 1536x1024)
REGIONS = {
    "street": [
        ("lamp_air", (690, 380, 880, 560), (1180, 470, 1440, 860)),
        ("lamp_head", (735, 432, 790, 470), (1270, 488, 1330, 530)),
        ("window_L", (300, 160, 372, 192), (466, 242, 558, 302)),
        ("window_R", (585, 160, 667, 192), (920, 242, 1020, 302)),
        ("actor_ground", (455, 300, 545, 370), (700, 530, 840, 670)),
        ("road_pool", (600, 300, 1000, 470), (880, 520, 1460, 780)),
        ("road_dark", (60, 380, 480, 530), (60, 690, 640, 830)),
        ("shrubs", (250, 185, 740, 255), (380, 280, 1180, 420)),
        ("roof", (260, 10, 720, 150), (380, 20, 1110, 220)),
    ],
    "open": [
        ("window_L", (318, 462, 418, 494), (478, 728, 622, 796)),
        ("window_R", (712, 462, 830, 494), (1116, 728, 1258, 796)),
        ("lamp_head", (960, 8, 1000, 40), (1405, 40, 1460, 75)),
        ("kitchen", (610, 245, 870, 450), (955, 370, 1340, 715)),
        ("living", (275, 265, 470, 450), (390, 380, 715, 715)),
        ("bedroom", (370, 70, 630, 240), (520, 95, 940, 360)),
        ("actor", (470, 280, 530, 345), (715, 420, 785, 535)),
        ("shrubs", (250, 480, 950, 560), (330, 770, 1400, 880)),
    ],
}


def load(path: Path, size=(W, H)) -> np.ndarray:
    return np.asarray(Image.open(path).convert("RGB").resize(size, Image.Resampling.LANCZOS), dtype=np.float64) / 255.0


def crop_t(img: np.ndarray, box) -> np.ndarray:
    x0, y0, x1, y1 = box
    return img[y0:y1, x0:x1]


def region_stats(rgb: np.ndarray) -> dict:
    lab = rgb2lab(rgb)
    hue_warm = (rgb[..., 0] > rgb[..., 2] * 1.6) & (lab[..., 0] > 18)
    return {
        "L_mean": float(lab[..., 0].mean()),
        "L_std": float(lab[..., 0].std()),
        "L_p95": float(np.percentile(lab[..., 0], 95)),
        "a_mean": float(lab[..., 1].mean()),
        "b_mean": float(lab[..., 2].mean()),
        "warm_share": float(hue_warm.mean()),
        "lab_mean": lab.reshape(-1, 3).mean(0),
    }


def compare(capture: np.ndarray, target_full: np.ndarray, scene: str) -> dict:
    target = np.asarray(Image.fromarray((target_full * 255).astype(np.uint8)).resize((W, H), Image.Resampling.LANCZOS), dtype=np.float64) / 255.0
    mask = np.ones((H, W), bool)
    mask[HUD[1]:HUD[3], HUD[0]:HUD[2]] = False
    de = deltaE_ciede2000(rgb2lab(capture), rgb2lab(target))
    out = {"global_dE2000": float(de[mask].mean()), "global_dE2000_p90": float(np.percentile(de[mask], 90)), "regions": {}}
    for name, cbox, tbox in REGIONS[scene]:
        c = region_stats(crop_t(capture, cbox))
        t = region_stats(crop_t(target_full, tbox))
        out["regions"][name] = {
            "dE2000_mean_colour": float(deltaE_ciede2000(c["lab_mean"][None], t["lab_mean"][None])[0]),
            "L_mean": [round(c["L_mean"], 2), round(t["L_mean"], 2)],
            "L_std": [round(c["L_std"], 2), round(t["L_std"], 2)],
            "L_p95": [round(c["L_p95"], 2), round(t["L_p95"], 2)],
            "warm_share": [round(c["warm_share"], 3), round(t["warm_share"], 3)],
            "contrast_err": round(abs(c["L_std"] - t["L_std"]), 2),
        }
    return out


def sheet(scene: str, phases: list[str], captures: list[np.ndarray], target_full: np.ndarray, out: Path) -> None:
    rows = REGIONS[scene]
    cw, ch = 300, 200
    img = Image.new("RGB", (cw * (len(phases) + 1), (ch + 22) * len(rows)), "#151c20")
    d = ImageDraw.Draw(img)
    for r, (name, cbox, tbox) in enumerate(rows):
        y = r * (ch + 22)
        srcs = [(Image.fromarray((cap * 255).astype(np.uint8)).crop(cbox), p) for cap, p in zip(captures, phases)]
        srcs.append((Image.fromarray((target_full * 255).astype(np.uint8)).crop(tbox), "target"))
        for col, (im, label) in enumerate(srcs):
            k = min(cw / im.width, ch / im.height)
            im = im.resize((max(1, round(im.width * k)), max(1, round(im.height * k))), Image.Resampling.LANCZOS)
            img.paste(im, (col * cw + (cw - im.width) // 2, y + 20 + (ch - im.height) // 2))
            d.text((col * cw + 6, y + 4), f"{name} / {label}", fill="#d4ddd8")
    img.save(out / f"crops-{scene}-{'-vs-'.join(phases)}.png")


def main() -> None:
    phases = sys.argv[1:3]
    out = Path(sys.argv[3]) if len(sys.argv) > 3 else ROOT / f"compare-{'-vs-'.join(phases)}"
    out.mkdir(parents=True, exist_ok=True)
    report = {}
    for scene in ("street", "open"):
        target_full = np.asarray(Image.open(TARGETS / f"target-sodium70s-{scene}.png").convert("RGB"), dtype=np.float64) / 255.0
        caps = [load(ROOT / p / f"{scene}.png") for p in phases]
        report[scene] = {p: compare(c, target_full, scene) for p, c in zip(phases, caps)}
        sheet(scene, phases, caps, target_full, out)
        a, b = (report[scene][p] for p in phases)
        print(f"{scene}: global dE2000 {a['global_dE2000']:.2f} -> {b['global_dE2000']:.2f}")
        for name in a["regions"]:
            ra, rb = a["regions"][name], b["regions"][name]
            print(
                f"  {name:13s} dE(mean) {ra['dE2000_mean_colour']:6.2f} -> {rb['dE2000_mean_colour']:6.2f}"
                f"   L {ra['L_mean'][0]:5.1f} -> {rb['L_mean'][0]:5.1f} (t {ra['L_mean'][1]:5.1f})"
                f"   Lstd {ra['L_std'][0]:5.1f} -> {rb['L_std'][0]:5.1f} (t {ra['L_std'][1]:5.1f})"
                f"   p95 {ra['L_p95'][0]:5.1f} -> {rb['L_p95'][0]:5.1f} (t {ra['L_p95'][1]:5.1f})"
            )
    (out / "metrics.json").write_text(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
