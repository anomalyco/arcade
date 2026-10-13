"""Assemble inspected run evidence. Pillow; no rendering or simulation."""
import json
import sys
import shutil
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(sys.argv[1])
data = json.loads((root / "evidence.json").read_text())
font = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 13)
small = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 11)
for view in {row["view"] for row in data["evidence"]}:
    for route in {row["route"] for row in data["evidence"]}:
        rows = [row for row in data["evidence"] if row["view"] == view and row["route"] == route]
        out = Image.new("RGB", (2000, len(rows) * 310 + 35), "#111820")
        draw = ImageDraw.Draw(out)
        draw.text((10, 8), f"{route} / {view} — time-locked (contact and wheel phases shown separately)", font=font, fill="white")
        for r, row in enumerate(rows):
            samples = [s for s in row["samples"] if 60 <= s["tick"] <= 96][:10]
            for c, sample in enumerate(samples):
                image = Image.open(root / f'{view}-{route}-{row["mode"]}' / f'{sample["tick"]:04d}.png').convert("RGB")
                # Fixed rectangles for every mode; keep both boots and weapon in view.
                image = image.crop((310, 140, 770, 670) if view != "game" else (330, 200, 750, 620))
                image.thumbnail((196, 238))
                x, y = c * 200, 35 + r * 310
                out.paste(image, (x + (200 - image.width) // 2, y))
                support = "".join(side for side, foot in zip("LR", sample["feet"]) if foot["planted"]) or "flight"
                draw.text((x + 4, y + 240), f'{row["mode"]} t={sample["time"]:.3f}', font=small, fill="white")
                draw.text((x + 4, y + 256), f'contact {support} / p {sample["phase"]:.2f}', font=small, fill="#a6cbd6")
                draw.text((x + 4, y + 272), f'hip {sample["pelvis"]["pitch"]*57.2958:.1f} chest {sample["chest"]["pitch"]*57.2958:.1f}', font=small, fill="#a6cbd6")
        out.save(root / f"{view}-{route}-strip.jpg", quality=92)

        phases = []
        for row in rows:
            path = root / f'{view}-{route}-{row["mode"]}' / "phase.json"
            if path.exists(): phases.append(json.loads(path.read_text()))
        if not phases: continue
        out = Image.new("RGB", (2000, len(phases) * 310 + 35), "#111820")
        draw = ImageDraw.Draw(out)
        draw.text((10, 8), f"{route} / {view} — left-touchdown cycle normalized; nearest 60 Hz frame, actual fraction shown", font=font, fill="white")
        for r, row in enumerate(phases):
            for c, sample in enumerate(row["samples"]):
                image = Image.open(root / f'{view}-{route}-{row["variant"]}' / "phase" / f'{c}.png').convert("RGB")
                image = image.crop((310, 140, 770, 670) if view != "game" else (440, 260, 640, 460))
                image.thumbnail((196, 238))
                x, y = c * 200, 35 + r * 310
                out.paste(image, (x + (200-image.width)//2, y))
                support = "".join(side for side, foot in zip("LR", sample["feet"]) if foot["planted"]) or "flight"
                draw.text((x+4,y+240), f'{row["variant"]} phase {sample["actualFraction"]:.2f}', font=small, fill="white")
                draw.text((x+4,y+256), f'{support} / t {sample["time"]:.3f}', font=small, fill="#a6cbd6")
                draw.text((x+4,y+272), f'hip {sample["pelvis"]["pitch"]*57.2958:.1f} chest {sample["chest"]["pitch"]*57.2958:.1f}', font=small, fill="#a6cbd6")
        out.save(root / f"{view}-{route}-phase.jpg", quality=92)

review = root / "review"
review.mkdir(exist_ok=True)
for pattern in ["*-strip.jpg", "*-phase.jpg", "lab.png", "lab.json"]:
    for path in root.glob(pattern): shutil.copy2(path, review / path.name)
for path in root.glob("*/phase.json"):
    shutil.copy2(path, review / f"{path.parent.name}-phase.json")
for name, directory, tick in [("load-acceptance", "side-run-refined", 72), ("mid-stance", "side-run-refined", 76),
                              ("toe-off", "side-run-refined", 144), ("flight", "three-run-refined", 68)]:
    path = root / directory / f"{tick:04d}.png"
    if path.exists(): shutil.copy2(path, review / f"refined-{name}.png")

# The film is time-locked. In the changed pair, contacts and phase must also be exactly identical.
agreement = []
for view in {row["view"] for row in data["evidence"]}:
    for route in {row["route"] for row in data["evidence"]}:
        rows = {row["mode"]: row for row in data["evidence"] if row["view"] == view and row["route"] == route}
        if not all(key in rows for key in ["old", "current", "refined"]): continue
        count = 0
        for old, current, refined in zip(rows["old"]["samples"], rows["current"]["samples"], rows["refined"]["samples"]):
            for field in ["tick", "time", "root", "velocity", "aim", "seed"]:
                assert old[field] == current[field] == refined[field], (view, route, field)
            for field in ["phase", "duty", "feet", "gun", "pelvisPosition"]:
                assert current[field] == refined[field], (view, route, field)
            count += 1
        agreement.append({"view": view, "route": route, "matchingFrames": count})
(review / "agreement.json").write_text(json.dumps(agreement, indent=2))
