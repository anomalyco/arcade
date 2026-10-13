"""Compose matched Metal frames; encode the resulting phone sequence with VideoToolbox."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageOps
import json
import subprocess
import sys

root = Path(__file__).resolve().parents[3]
lamps = "--lamps" in sys.argv
stem = "getaway-chassis-lamps" if lamps else "getaway-chassis"
source = root / "captures" / stem
dest = root / "captures/preview"
dest.mkdir(parents=True, exist_ok=True)
frames = source / "phone"
frames.mkdir(exist_ok=True)
font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 22)
small = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 17)
scenarios = [("launch", "Hard launch", 19), ("braking", "Hard braking", 19), ("corner", "Fast corner", 29),
             ("kerb", "Kerb", 37), ("landing", "Ramp landing", 51), ("countersteer", "Countersteer", 31)]
if lamps:
    scenarios = [s for s in scenarios if s[0] in ["braking", "kerb"]]
reports = json.loads((source / "clip.json").read_text())["reports"]
for name, _, _ in scenarios:
    off, on = [next(r for r in reports if r["scenario"] == name and r["enabled"] == enabled) for enabled in [False, True]]
    assert [s["car"] for s in off["states"]] == [s["car"] for s in on["states"]], name

sheet = Image.new("RGB", (900, 650) if lamps else (1350, 1300), "#11151c")
for index, (name, label, still) in enumerate(scenarios):
    x, y = (index % 3) * 450, (index // 3) * 650
    draw = ImageDraw.Draw(sheet)
    draw.text((x + 12, y + 7), label, font=font, fill="white")
    for row, variant in enumerate(["off", "on"]):
        image = ImageOps.fit(Image.open(source / f"{name}-{variant}-{still:03}.jpg"), (450, 300), Image.Resampling.LANCZOS)
        sheet.paste(image, (x, y + 40 + row * 300))
        draw.rectangle((x + 7, y + 47 + row * 300, x + 56, y + 71 + row * 300), fill="#11151c")
        draw.text((x + 13, y + 50 + row * 300), variant.upper(), font=small, fill="white")
    for frame in range(72):
        image = Image.new("RGB", (720, 1280), "#11151c")
        draw = ImageDraw.Draw(image)
        for row, variant in enumerate(["off", "on"]):
            image.paste(Image.open(source / f"{name}-{variant}-{frame:03}.jpg"), (0, row * 640 + 40))
            draw.text((18, row * 640 + 9), f"CHASSIS {variant.upper()}", font=font, fill="white")
            draw.text((720 - draw.textlength(label, font=font) - 18, row * 640 + 9), label, font=font, fill="white")
        image.save(frames / f"{index * 72 + frame:04}.jpg", quality=91)
sheet.save(dest / f"{stem}-sheet.jpg", quality=93)
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", "30", "-i", str(frames / "%04d.jpg"),
                "-vf", "scale=in_range=full:out_range=tv,format=yuv420p", "-color_range", "tv",
                "-c:v", "h264_videotoolbox", "-b:v", "2800k", "-profile:v", "main", "-pix_fmt", "yuv420p",
                "-movflags", "+faststart", str(dest / f"{stem}-phone.mp4")], check=True)
assert (dest / f"{stem}-phone.mp4").stat().st_size < 10_000_000
print(dest / f"{stem}-sheet.jpg")
print(dest / f"{stem}-phone.mp4")
