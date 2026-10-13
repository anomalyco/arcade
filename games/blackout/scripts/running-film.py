"""Stream labelled, pixel-scale comparison frames into the hardware encoder. Run through hivemind."""
import subprocess
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(sys.argv[1])
font = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 19)
output = root / "blackout-running-comparison.mp4"
command = ["ffmpeg", "-hide_banner", "-loglevel", "warning", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
           "-s", "1080x1440", "-r", "30", "-i", "pipe:0", "-an", "-c:v", "h264_videotoolbox",
           "-profile:v", "high", "-q:v", "75", "-b:v", "12M", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output)]
with subprocess.Popen(command, stdin=subprocess.PIPE) as encoder:
    for view in ["game", "three", "side"]:
        sequences = [(route, range(2, 145, 2), 1) for route in ["run", "sprint", "diagonal", "acceleration", "braking"]]
        sequences += [(route, range(60, 108, 2), 4) for route in ["run", "sprint"]]
        for route, ticks, repeat in sequences:
            for tick in ticks:
                frame = Image.new("RGB", (1080, 1440))
                for row, variant in enumerate(["old", "current", "refined"]):
                    source = Image.open(root / f"{view}-{route}-{variant}" / f"{tick:04d}.png").convert("RGB")
                    # Same crop, no scaling. Keep the actual gameplay pixel size and all close-view body parts.
                    frame.paste(source.crop((0, 90, 1080, 570)), (0, row * 480))
                    draw = ImageDraw.Draw(frame)
                    draw.rectangle((0, row*480, 1080, row*480+31), fill="#101820")
                    text = f'{variant.upper()} / {route} / {view} / {"0.25×" if repeat == 4 else "1×"} / t={tick/60:.2f}'
                    draw.text((12,row*480+5), text, font=font, fill="white")
                pixels = frame.tobytes()
                for _ in range(repeat): encoder.stdin.write(pixels)
    encoder.stdin.close()
    if encoder.wait() != 0: raise SystemExit("Hardware encoding failed")
print(output)
