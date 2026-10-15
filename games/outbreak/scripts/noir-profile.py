# Flashlight pool profile and selective-colour edge metrics from noir-proof.ts captures.
#   uv run --with numpy --with pillow --with matplotlib scripts/noir-profile.py OUT_DIR LABEL=DIR[:SCENE=IMG] ...
# Each DIR holds probes.json and <scene>.png. A label may override one scene's image (for a paint-over target that
# shares that capture's composition), e.g. target=captures/before:street-long=/path/t-beam-1000.png.
import json
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from PIL import Image


def lin(c):
    c = c / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lab(img):
    rgb = lin(img.astype(np.float64))
    m = np.array([[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]])
    xyz = rgb @ m.T / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    L = 116 * f[..., 1] - 16
    a = 500 * (f[..., 0] - f[..., 1])
    b = 200 * (f[..., 1] - f[..., 2])
    return L, np.hypot(a, b)


def sample(arr, x, y, r=2):
    h, w = arr.shape[:2]
    if y is None or x < 0 or x >= w or y < 0 or y >= h:
        return np.nan
    xi, yi = int(round(x)), int(round(y))
    return float(np.nanmean(arr[max(0, yi - r) : yi + r + 1, max(0, xi - r) : xi + r + 1]))


def load(spec):
    label, _, rest = spec.partition("=")
    parts = rest.split(":")
    d = Path(parts[0])
    overrides = dict(p.split("=", 1) for p in parts[1:])
    probes = json.loads((d / "probes.json").read_text())["probes"]
    return label, d, overrides, probes


def main():
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    runs = [load(s) for s in sys.argv[2:]]
    scenes = [s for s in runs[0][3].keys()]
    metrics = {}
    for scene in scenes:
        fig, ax = plt.subplots(1, 5, figsize=(26, 4.4))
        for label, d, overrides, probes in runs:
            img_path = Path(overrides.get(scene, d / f"{scene}.png"))
            if not img_path.exists() or scene not in probes:
                continue
            img = np.asarray(Image.open(img_path).convert("RGB"))
            Y = lin(img.astype(np.float64)) @ np.array([0.2126, 0.7152, 0.0722])
            L, C = lab(img)
            p = probes[scene]
            ax_d = [a[0] for a in p["axial"]]
            ax_y = [sample(Y, a[1], a[2]) for a in p["axial"]]
            ax_c = [sample(C, a[1], a[2]) for a in p["axial"]]
            ax[0].plot(ax_d, ax_y, label=label)
            ring = p["angular"]["5"]
            deg = np.array([a[0] for a in ring])
            ry = np.array([sample(Y, a[1], a[2]) for a in ring])
            rc = np.array([sample(C, a[1], a[2]) for a in ring])
            ax[1].plot(deg, ry, label=label)
            ax[2].plot(deg, rc, label=label)
            # Edge metric: largest chroma change per screen pixel across the 5 m ring and along the axis.
            px = np.array([[a[1], a[2] if a[2] is not None else np.nan] for a in ring], dtype=float)
            step = np.hypot(*np.diff(px, axis=0).T)
            grad_ring = np.nanmax(np.abs(np.diff(rc)) / np.maximum(step, 1e-3))
            apx = np.array([[a[1], a[2] if a[2] is not None else np.nan] for a in p["axial"]], dtype=float)
            astep = np.hypot(*np.diff(apx, axis=0).T)
            grad_axial = np.nanmax(np.abs(np.diff(ax_c)) / np.maximum(astep, 1e-3))
            grad_lum = np.nanmax(np.abs(np.diff(ry)) / np.maximum(step, 1e-3))
            ax[3].scatter(np.concatenate([ax_y, ry]), np.concatenate([ax_c, rc]), s=6, label=label)
            mask_path = d / f"{scene}-diag7.png"
            mask_metrics = {}
            if mask_path.exists() and scene not in overrides:
                M = np.asarray(Image.open(mask_path).convert("L")).astype(np.float64) / 255.0
                rm = np.array([sample(M, a[1], a[2], 1) for a in ring])
                am = np.array([sample(M, a[1], a[2], 1) for a in p["axial"]])
                ax[4].plot(deg, rm, label=f"{label} ring 5 m")
                def edge_width(row):
                    widths = []
                    c = int(np.nanargmax(row))
                    for side in (row[c::-1], row[c:]):
                        s10 = next((i for i, v in enumerate(side) if v < 0.1), None)
                        s90 = next((i for i, v in enumerate(side) if v < 0.9), None)
                        if s10 is not None and s90 is not None:
                            widths.append((s10 - s90) * 1.5)
                    return round(float(np.mean(widths)), 1) if widths else None

                smooth = np.convolve(np.nan_to_num(rm), np.ones(3) / 3, mode="same")
                mask_metrics = {
                    "ring5_mask_10_90_width_deg": edge_width(smooth),
                    "ring5_max_dMask_per_px_smoothed": round(float(np.nanmax(np.abs(np.diff(smooth)) / np.maximum(step, 1e-3))), 4),
                    "ring5_max_dMask_per_px": round(float(np.nanmax(np.abs(np.diff(rm)) / np.maximum(step, 1e-3))), 4),
                    "axial_max_dMask_per_px": round(float(np.nanmax(np.abs(np.diff(am)) / np.maximum(astep, 1e-3))), 4),
                    "frame_max_dMask_per_px": round(float(max(np.abs(np.diff(M, axis=0)).max(), np.abs(np.diff(M, axis=1)).max())), 4),
                    "frame_p999_dMask_per_px": round(float(np.percentile(np.hypot(np.diff(M, axis=0)[:, :-1], np.diff(M, axis=1)[:-1, :]), 99.9)), 4),
                }
            peak = np.nanmax(ax_y)
            dpeak = ax_d[int(np.nanargmax(ax_y))]
            half = [d_ for d_, y_ in zip(ax_d, ax_y) if d_ > dpeak and y_ < peak * 0.5]
            tenth = [d_ for d_, y_ in zip(ax_d, ax_y) if d_ > dpeak and y_ < peak * 0.1]
            base = float(np.nanpercentile(Y, 20))
            inside = ry > (np.nanmax(ry) * 0.5)
            fwhm = float(deg[inside].max() - deg[inside].min()) if inside.any() else 0.0
            metrics.setdefault(scene, {})[label] = {
                "axial_peak_Y": round(float(peak), 4),
                "axial_peak_m": dpeak,
                "axial_half_m": half[0] if half else None,
                "axial_tenth_m": tenth[0] if tenth else None,
                "ring5_fwhm_deg": round(fwhm, 1),
                "ring5_max_dLum_per_px": round(float(grad_lum), 5),
                "ring5_max_dChroma_per_px": round(float(grad_ring), 3),
                "axial_max_dChroma_per_px": round(float(grad_axial), 3),
                "beam_chroma_p90": round(float(np.nanpercentile(rc, 90)), 2),
                "frame_Y_p20": round(base, 4),
                "frame_L_p50": round(float(np.nanpercentile(L, 50)), 2),
                "frame_chroma_p50": round(float(np.nanpercentile(C, 50)), 2),
                **mask_metrics,
            }
        ax[0].set_title(f"{scene}: luminance along beam axis")
        ax[0].set_xlabel("distance from survivor (m)")
        ax[0].set_ylabel("relative luminance Y")
        ax[1].set_title("luminance across beam at 5 m")
        ax[1].set_xlabel("angle from aim (deg)")
        ax[2].set_title("CIELAB chroma across beam at 5 m")
        ax[2].set_xlabel("angle from aim (deg)")
        ax[3].set_title("chroma vs luminance (beam samples)")
        ax[3].set_xlabel("relative luminance Y")
        ax[3].set_ylabel("CIELAB chroma")
        ax[4].set_title("selective-colour mask across beam at 5 m")
        ax[4].set_xlabel("angle from aim (deg)")
        for a in ax:
            a.grid(alpha=0.3)
            a.legend()
        fig.tight_layout()
        fig.savefig(out / f"profile-{scene}.png", dpi=90)
        plt.close(fig)
    (out / "profile-metrics.json").write_text(json.dumps(metrics, indent=1))
    print(json.dumps(metrics, indent=1))


main()
