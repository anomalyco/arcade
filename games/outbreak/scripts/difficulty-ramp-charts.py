"""Charts for scripts/difficulty-ramp.ts: reads <dir>/summary.json, writes PNGs next to it.

uv run --with matplotlib python scripts/difficulty-ramp-charts.py captures/difficulty-ramp
"""
import json
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

out = Path(sys.argv[1])
data = json.loads((out / "summary.json").read_text())
presets = data["presets"]
curves = data["curves"]
summary = data["summary"]["byPreset"]
colors = {"Novice": "#d9534f", "Casual": "#f0ad4e", "Skilled": "#5bc0de", "Expert": "#337ab7", "Perfect": "#5cb85c"}
plt.rcParams.update({"figure.dpi": 130, "axes.grid": True, "grid.alpha": 0.25, "font.size": 9})


def shade_nights(ax, hours):
    for h in range(1, hours, 24):
        ax.axvspan(h, min(hours, h + 12), color="#1b2a3a", alpha=0.10, lw=0)


def hour_ticks(ax, hours):
    ticks = [0] + [h for h in range(1, hours, 12)]
    labels = [""] + [("N" if (h - 1) % 24 == 0 else "D") + str((h - 1) // 24 + 1 + ((h - 1) % 24 != 0)) for h in ticks[1:]]
    ax.set_xticks(ticks)
    ax.set_xticklabels(labels)


def per_hour(metrics, name, title):
    hours = len(next(iter(curves.values())))
    fig, axes = plt.subplots(len(metrics), 1, figsize=(10, 2.3 * len(metrics) + 0.6), sharex=True, squeeze=False)
    axes = axes[:, 0]
    for ax, (key, label) in zip(axes, metrics):
        shade_nights(ax, hours)
        for p in presets:
            xs = [c["hour"] for c in curves[p] if c["alive"] > 0]
            ys = [c[key] for c in curves[p] if c["alive"] > 0]
            ax.plot(xs, ys, color=colors.get(p), label=p, lw=1.4)
        ax.set_ylabel(label)
    hour_ticks(axes[-1], hours)
    axes[-1].set_xlabel("Game time (N = nightfall, D = dawn; shaded = night)")
    axes[0].legend(ncol=len(presets), loc="upper right", fontsize=8)
    fig.suptitle(title)
    fig.tight_layout()
    fig.savefig(out / name)
    plt.close(fig)


per_hour([("alive", "alive fraction")], "survival.png", "Survival by game hour (all seeds)")
per_hour(
    [("living", "living zombies"), ("aware", "aware zombies"), ("chasers", "active chasers"), ("specials", "specials"), ("hitsPerMin", "hits / min"), ("damage", "damage / hour")],
    "pressure.png",
    "Zombie pressure by game hour (mean over survivors alive)",
)
per_hour(
    [("ammo", "ammo"), ("meds", "meds"), ("battery", "flashlight"), ("indoors", "indoors"), ("hidden", "hidden")],
    "resources.png",
    "Resources and position by game hour (mean over survivors alive)",
)

labels = [p["label"] for p in summary[presets[0]]["phases"]]
fig, axes = plt.subplots(2, 2, figsize=(11, 6.5))
for ax, (key, title) in zip(
    axes.flat,
    [("deathRate", "Death rate per phase"), ("aware", "Aware zombies"), ("hitsPerMin", "Hits per minute"), ("damagePerHour", "Damage per game hour")],
):
    width = 0.8 / len(presets)
    for i, p in enumerate(presets):
        phases = summary[p]["phases"]
        xs = [j + i * width for j in range(len(phases))]
        ys = [ph[key] if ph["entered"] else 0 for ph in phases]
        ax.bar(xs, ys, width, color=colors.get(p), label=p)
    ax.set_xticks([j + 0.4 - width / 2 for j in range(len(labels))])
    ax.set_xticklabels(labels, rotation=35, fontsize=7)
    ax.set_title(title)
axes[0][0].legend(fontsize=7)
fig.tight_layout()
fig.savefig(out / "phases.png")
plt.close(fig)
print(f"charts: {out}/survival.png pressure.png resources.png phases.png")
