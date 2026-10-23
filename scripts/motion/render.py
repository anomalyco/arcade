"""Deterministic line-rig evidence from production joint traces. No browser, wall clock, audio or raw-frame residue."""
import json, math, pathlib, subprocess, sys
from PIL import Image, ImageDraw, ImageFont, ImageStat

out = pathlib.Path(sys.argv[1])
data = json.loads((out / "moments.json").read_text())
font = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 14)
small = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 12)
colors = {"left": "#6bb5ff", "right": "#ffbc7d", "spine": "#e4e9f2"}
W, H = 720, 480

def draw_frame(clip, frame):
    v = clip["finding"]
    im = Image.new("RGB", (W, H), "#131a24")
    d = ImageDraw.Draw(im)
    d.text((20, 15), f'{v["actor"]} / {v["scenario"]} / {clip["pass"].split(":")[0]}', font=font, fill="white")
    d.text((20, 38), f'{v["joint"]} {v["metric"]} ({v["space"]})', font=font, fill="#ff6f7d")
    d.text((20, 61), f'{v["value"]:.4g} {">" if v["value"] > v["threshold"] else "<="} {v["threshold"]:.4g} {v["unit"]}  |  event {v["time"]:.3f}s', font=small, fill="#c1cbd9")
    j = frame["joints"]
    # A single event-anchored camera across every frame: root motion is visible, never camera-smoothed away.
    spans = []
    centers = []
    for axis in [0, 2]:
        values = [p[axis] for f in clip["frames"] for p in f["joints"].values()]
        centers.append((min(values)+max(values))/2)
        spans.append(max(values)-min(values))
    heights = [p[1] for f in clip["frames"] for p in f["joints"].values()]
    scale = min(155, 310 / max(0.1, *spans, max(heights)))
    hit = set(v["joint"].split(":"))
    for view in range(2):
        cx = 180 + view * 360
        def p(q):
            return (cx + (q[0 if view == 0 else 2] - centers[view]) * scale, 400 - q[1] * scale)
        d.line((cx-165, 400, cx+165, 400), fill="#5b6979", width=2)
        d.text((cx-30, 418), "WORLD X" if view == 0 else "WORLD Z", font=small, fill="#c1cbd9")
        for s in data["segments"]:
            if s["from"] not in j or s["to"] not in j: continue
            d.line((p(j[s["from"]]), p(j[s["to"]])), fill=colors.get(s["group"], "yellow"), width=4)
        for name, q in j.items():
            x, y = p(q)
            r = 7 if name in hit else 3
            d.ellipse((x-r,y-r,x+r,y+r), fill="#ff364f" if name in hit else "#dbe1eb")
        if "torso" in hit:
            x, y = p(j["chest"]); d.ellipse((x-8,y-8,x+8,y+8), outline="#ff364f", width=3)
        for grip in frame.get("grips", {}).values():
            x, y = p(grip["anchor"])
            d.line((p(j[grip["hand"]]), (x,y)), fill="#70ffe0", width=2)
            d.line((x-5,y,x+5,y), fill="#70ffe0", width=2)
            d.line((x,y-5,x,y+5), fill="#70ffe0", width=2)
    d.text((20, 451), f't={frame["time"]:.4f}s  dt={frame["dt"]*1000:.2f}ms | {v["fps"]}fps source | playback 0.25x', font=small, fill="white")
    return im

cards = []
proof = []
for clip in data["clips"]:
    frames = clip["frames"]
    if not frames: raise RuntimeError("empty moment")
    target = out / (clip["id"] + ".mp4")
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", f"{W}x{H}", "-framerate", "60", "-i", "pipe:0",
           "-an", "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-threads", "2", str(target)]
    count = max(1, math.ceil((frames[-1]["time"]-frames[0]["time"])*4*60))
    if "--strips-only" not in sys.argv or not target.exists():
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
        for i in range(count):
            t = frames[0]["time"] + i / 240
            # Hold each sampled pose until the next sample. The 100 ms hitch stays visible, with its real duration.
            frame = next((f for f in reversed(frames) if f["time"] <= t), frames[0])
            proc.stdin.write(draw_frame(clip, frame).tobytes())
        proc.stdin.close()
        if proc.wait(): raise RuntimeError("ffmpeg failed")
    strip = Image.new("RGB", (W*3, H*2))
    contrast = []
    event = min(range(len(frames)), key=lambda k: abs(frames[k]["time"] - clip["finding"]["time"]))
    for k in range(6):
        # Adjacent samples include the exact violating frame (tile 3). Even spacing can miss a one-frame pop.
        frame = frames[max(0, min(len(frames)-1, event + k - 2))]
        tile = draw_frame(clip, frame)
        contrast.append(ImageStat.Stat(tile.crop((20,90,W-20,410)).convert("L")).stddev[0])
        strip.paste(tile, ((k%3)*W, (k//3)*H))
    if min(contrast) < 3: raise RuntimeError(f"blank rig tile: {contrast}")
    strip.save(out / (clip["id"] + "-strip.png"))
    meta = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "stream=nb_frames,width,height:format=duration", "-of", "json", str(target)]))
    if int(meta["streams"][0]["nb_frames"]) != count: raise RuntimeError("frame count mismatch")
    proof.append({"id": clip["id"], "contrast": contrast, "video": meta, "rawFrames": 0})
    v = clip["finding"]
    cards.append(f'<section><h2>{clip["pass"]}: {v["actor"]}, {v["scenario"]}</h2><p>{v["joint"]}: {v["metric"]}, {v["value"]:.4g} &gt; {v["threshold"]:.4g} {v["unit"]} at {v["time"]:.3f}s</p><video controls muted playsinline preload="metadata" src="{clip["id"]}.mp4"></video><a href="{clip["id"]}-strip.png"><img src="{clip["id"]}-strip.png"></a></section>')

report = json.loads((out / "report.json").read_text())
import html
rows = []
for name, findings in report["reports"].items():
    for v in findings[:15]:
        cells = [name, v["actor"], v["scenario"], v["joint"], v["metric"], f'{v["fps"]}'+(" +hitch" if v["hitch"] else ""), f'{v["time"]:.3f}s', f'{v["value"]:.4g}', f'{v["threshold"]:.4g}', v["unit"]]
        rows.append('<tr>' + ''.join('<td>'+html.escape(str(c))+'</td>' for c in cells) + '</tr>')
gaps = ''.join('<li>'+html.escape(x)+'</li>' for x in report["coverage"]["missing"])
sources = '; '.join(html.escape(p['name'] + ': ' + p['revision']) for p in report['coverage'].get('passes', []))
note = html.escape(report['coverage'].get('note', ''))
(out / "media-proof.json").write_text(json.dumps(proof, indent=2))
(out / "index.html").write_text(f'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Arcade body motion invariants</title>
<style>body{{background:#111820;color:#e3eaf3;font:16px system-ui;margin:24px auto;max-width:1050px;padding:0 16px}}h1{{font-size:30px}}h2{{font-size:21px}}p,li{{line-height:1.5}}section{{margin:40px 0}}video,img{{width:100%;border-radius:8px;margin:8px 0}}table{{font:12px monospace;border-collapse:collapse;width:100%}}td,th{{text-align:left;padding:8px;border-bottom:1px solid #344152}}a{{color:#88caff}}.scroll{{overflow:auto}}</style>
<h1>Arcade body motion invariants</h1><p>Production joint traces at 30, 60 and 144 fps, with a 100 ms hitch. CMU walk/run calibration passes with zero findings. Red marks the reported joint; clips play at ¼ speed. These are iteration candidates, not animation fixes.</p>
<p>{sources}</p><p>{note}</p>
<p><a href="report.json">Full ranked report and thresholds</a> · <a href="media-proof.json">Media verification</a> · <a href="report.md">Engineering report</a></p>
<div class="scroll"><table><thead><tr><th>Revision</th><th>Body</th><th>Scenario</th><th>Joint</th><th>Rule</th><th>Clock</th><th>Time</th><th>Value</th><th>Limit</th><th>Unit</th></tr></thead><tbody>{''.join(rows)}</tbody></table></div>
{''.join(cards)}<h2>Coverage boundaries</h2><ul>{gaps}</ul></html>''')
print(f"Verified {len(proof)} clips, six nonblank tiles each, no raw frame files. {out / 'index.html'}")
