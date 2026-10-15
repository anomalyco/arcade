"""Scores hud-sharpness.ts crops: edge acutance of the text and strokes, and a before/after zoom sheet.

Acutance here is the mean of the strongest 8 % of per-pixel luminance steps (|dx| + |dy|) divided by the crop's
luminance range (98th minus 2nd percentile). A crisp glyph edge changes in one device pixel, a soft one spreads the
same change over two or three, so its strongest steps are smaller. Compare like with like (same DPR, same element).

  python3 scripts/hud-sharpness.py captures/outbreak-hud-sharpness/before captures/outbreak-hud-sharpness/after
"""
import json
import sys
from pathlib import Path
from PIL import Image, ImageDraw


def acutance(path: Path) -> float:
    im = Image.open(path).convert("L")
    w, h = im.size
    px = im.load()
    steps = []
    for y in range(h - 1):
        for x in range(w - 1):
            v = px[x, y]
            steps.append(abs(px[x + 1, y] - v) + abs(px[x, y + 1] - v))
    values = sorted(px[x, y] for y in range(h) for x in range(w))
    lo, hi = values[int(len(values) * 0.02)], values[int(len(values) * 0.98) - 1]
    steps.sort(reverse=True)
    top = steps[: max(1, len(steps) * 8 // 100)]
    return (sum(top) / len(top)) / max(1, hi - lo)


def load(folder: Path):
    items = json.loads((folder / "items.json").read_text())
    for it in items:
        it["acutance"] = acutance(folder / it["file"])
    return items


def key(it):
    return (it["dpr"], it["kind"], it["label"])


runs = [Path(p) for p in sys.argv[1:]]
scored = [load(p) for p in runs]
summary = {}
for folder, items in zip(runs, scored):
    groups = {}
    for it in items:
        groups.setdefault((it["dpr"], it["kind"]), []).append(it["acutance"])
    summary[folder.name] = {f"dpr{d} {k}": round(sum(v) / len(v), 3) for (d, k), v in sorted(groups.items())}
    (folder / "scores.json").write_text(json.dumps(items, indent=2))
print(json.dumps(summary, indent=2))

# Zoomed before/after sheet of matching crops (nearest-neighbour 4× at DPR 1, 2× at DPR 2).
if len(scored) == 2:
    before = {key(i): i for i in scored[0]}
    pairs = [(before[key(a)], a) for a in scored[1] if key(a) in before]
    pairs.sort(key=lambda p: (p[1]["dpr"], p[1]["kind"] != "callout", p[1]["label"]))
    rows = []
    for b, a in pairs:
        z = 4 if a["dpr"] == 1 else 2
        ib = Image.open(runs[0] / b["file"]).convert("RGB")
        ia = Image.open(runs[1] / a["file"]).convert("RGB")
        ib = ib.resize((ib.width * z, ib.height * z), Image.Resampling.NEAREST)
        ia = ia.resize((ia.width * z, ia.height * z), Image.Resampling.NEAREST)
        rows.append((b, a, ib, ia))
    W = max(r[2].width + r[3].width for r in rows) + 60
    H = sum(max(r[2].height, r[3].height) + 30 for r in rows) + 30
    sheet = Image.new("RGB", (W, H), "#151c20")
    d = ImageDraw.Draw(sheet)
    d.text((8, 8), f"BEFORE (left) / AFTER (right) · acutance, higher is sharper", fill="#d4ddd8")
    y = 30
    for b, a, ib, ia in rows:
        d.text((8, y), f"DPR {a['dpr']} {a['kind']} '{a['label'][:28]}'  {b['acutance']:.3f} -> {a['acutance']:.3f}", fill="#d4ddd8")
        y += 16
        sheet.paste(ib, (8, y))
        sheet.paste(ia, (8 + ib.width + 40, y))
        y += max(ib.height, ia.height) + 14
    sheet.save(runs[1].parent / "sharpness-sheet.png")
    print(runs[1].parent / "sharpness-sheet.png")
