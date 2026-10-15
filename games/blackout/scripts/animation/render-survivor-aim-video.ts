import { chromium } from "playwright-core"
import { createServer } from "vite"
import { mkdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { findChromeExecutable } from "../compare"
import { parseArgs, repoRoot } from "./common"

const { out: OUT_DIR, flags } = parseArgs(process.argv.slice(2), { tag: "video", out: "survivor-aim" })
const framesOnly = flags.has("frames-only")
const outbreakRoot = resolve(repoRoot, "games/outbreak")
spawnSync("bun", ["scripts/build-id.ts"], { cwd: outbreakRoot, stdio: "inherit" })
const vidFramesDir = join(OUT_DIR, "survivor-aim-video-frames")
mkdirSync(vidFramesDir, { recursive: true })

const server = await createServer({
  root: outbreakRoot,
  optimizeDeps: { force: true },
  server: { host: "127.0.0.1", port: 0, strictPort: false },
})
await server.listen()
const address = server.httpServer!.address()
if (!address || typeof address === "string") throw new Error("Missing Vite port")
const base = `http://127.0.0.1:${address.port}`

const browser = await chromium.launch({
  executablePath: findChromeExecutable(),
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})

const totalFrames = 144

try {
  const page = await browser.newPage({ viewport: { width: 640, height: 640 }, deviceScaleFactor: 1 })
  await page.goto(`${base}/?solo&seed=7&peaceful&bench`, { waitUntil: "networkidle" })
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready === true, null, { timeout: 30000 })

  await page.addStyleTag({
    content: `
      #status, #prompt, #stamina, #battery, #hotbar, .outbreak-hud, .coop-hud, aside[data-lab] { display: none !important; }
    `,
  })

  for (const mode of ["before", "after"] as const) {
    const isLegacy = mode === "before"
    await page.evaluate(async isLegacy => {
      const h = (window as any).__arcadeHarness
      h.setLab("zombieCount", 0)
      h.reset(7)
      h.setLegacyPistol(isLegacy)
      h.setLab("timeScale", 0)
      h.setLab("hour", 15.5)
      h.setLab("cone", 180)
      h.setLab("awareness", 5)
      h.setLab("range", 40)
      h.pose(29.0, 41.2, 0)
      h.setZoomRaw(15)
      // Spawn one target zombie downrange to the east
      h.spawnZombie(32.2, 41.2, "chase", Math.PI)
      // Warm up 36 walking steps so stride is in steady state at frame 0
      for (let i = 0; i < 36; i++) {
        const st = h.state()
        if (st.zombies[0]) {
          st.zombies[0].x = st.player.x + 2.6
          st.zombies[0].y = st.player.y
        }
        await h.step(1 / 60, { mx: 1, my: 0, aim: 0, interact: false })
        h.setZoomRaw(15)
      }
    }, isLegacy)

    for (let f = 0; f < totalFrames; f++) {
      await page.evaluate(async f => {
        const h = (window as any).__arcadeHarness
        // Keep target zombie 2.4 m downrange to the east so survivor silhouette is completely clear
        const st = h.state()
        if (st.zombies[0]) {
          st.zombies[0].x = st.player.x + 2.4
          st.zombies[0].y = st.player.y + 0.05
          st.zombies[0].hp = 100
          st.zombies[0].state = "chase"
        }

        let mx = 0.85
        let my = 0
        let aim = 0
        let fire = false
        let reload = false

        if (f < 36) {
          // Phase 1: Walking in Low Ready
          mx = 0.85
          my = 0
          aim = 0
        } else if (f < 84) {
          // Phase 2: Raise on Shot 1 (f=36), Shot 2 (f=54), Shot 3 (f=72) while walking/strafing
          mx = 0.55
          my = f < 60 ? 0.45 : -0.45
          aim = 0.03
          fire = f === 36 || f === 54 || f === 72
        } else if (f < 108) {
          // Phase 3: Post-shot raised aim hold while moving (no shots fired, gun stays raised!)
          mx = 0.65
          my = 0.35
          aim = -0.08
        } else {
          // Phase 4: Reloading (KeyR at f=108) — magazine from belt pouch to pistol grip well
          mx = 0.45
          my = 0
          aim = 0
          reload = f === 108
        }

        await h.step(1 / 60, { mx, my, aim, fire, reload, interact: false })
        h.setZoomRaw(15)
      }, f)

      await page.screenshot({ path: join(vidFramesDir, `${mode}-${String(f).padStart(4, "0")}.png`) })
    }
  }
} finally {
  await browser.close()
  await server.close()
}

if (framesOnly) {
  console.log(`Captured ${totalFrames * 2} frames in ${vidFramesDir}`)
  process.exit(0)
}

const stitchPy = `
import os, sys
from PIL import Image, ImageDraw, ImageFont

vid_dir = sys.argv[1]
out_dir = sys.argv[2]

def get_font(sz):
    for p in ["/System/Library/Fonts/SFNSMono.ttf", "/System/Library/Fonts/Menlo.ttc"]:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, sz)
            except Exception:
                pass
    return ImageFont.load_default()

font_title = get_font(16)
font_sub = get_font(13)
font_small = get_font(11)

# 1. Build 2x4 Before vs After Top-Down Game Camera Still Sheet
key_frames = [
    (18, "1 · Equipped Idle / Walk (1.4 m/s)", "Before: Unarmed swing, gun at hip", "After: Low Ready (-27.5° muzzle, L swing)"),
    (42, "2 · On Fire (0.15s Raise + Recoil)", "Before: Arms stay down (79° err)", "After: 2-Hand Shoulder Aim (0.0° err)"),
    (96, "3 · Post-Shot Hold (2.5s Hold Timer)", "Before: No hold (0.0s, swings at hip)", "After: Holds 2-Hand Aim While Moving"),
    (126, "4 · Reload (1.15s Belt -> Grip Well)", "Before: Arms swing during reload", "After: Left Hand Seats Mag + Head Look"),
]

cw, ch = 320, 320
header_h = 64
sheet = Image.new("RGB", (cw * 4, header_h + ch * 2), (14, 18, 24))
sd = ImageDraw.Draw(sheet)
sd.text((16, 10), "OUTBREAK TOP-DOWN CAMERA (62°) — SURVIVOR PISTOL READY, AIM, HOLD & RELOAD (BEFORE vs AFTER)", fill=(240, 245, 252), font=font_title)
sd.text((16, 34), "Top Row: BEFORE (arms swing unarmed while pistol floats at hip)   |   Bottom Row: AFTER (Low Ready -> 0.15s Raise to 2-Hand Shoulder Aim -> Recoil -> 2.5s Hold -> Belt-to-Grip Reload)", fill=(120, 232, 152), font=font_sub)

for col_idx, (f_idx, col_title, b_cap, a_cap) in enumerate(key_frames):
    b_im = Image.open(os.path.join(vid_dir, f"before-{f_idx:04d}.png")).convert("RGB")
    a_im = Image.open(os.path.join(vid_dir, f"after-{f_idx:04d}.png")).convert("RGB")
    # Center crop 380x380 around survivor and resize to 320x320 so character & weapon posture read clearly
    box = (130, 130, 510, 510)
    b_crop = b_im.crop(box).resize((cw, ch), Image.Resampling.LANCZOS)
    a_crop = a_im.crop(box).resize((cw, ch), Image.Resampling.LANCZOS)
    x0 = col_idx * cw
    sheet.paste(b_crop, (x0, header_h))
    sheet.paste(a_crop, (x0, header_h + ch))
    sd.rectangle([(x0, header_h), (x0 + cw - 1, header_h + ch - 1)], outline=(55, 68, 84))
    sd.rectangle([(x0, header_h + ch), (x0 + cw - 1, header_h + ch * 2 - 1)], outline=(55, 68, 84))
    sd.rectangle([(x0 + 4, header_h + 4), (x0 + cw - 4, header_h + 44)], fill=(14, 18, 24))
    sd.text((x0 + 10, header_h + 7), col_title, fill=(240, 245, 252), font=font_small)
    sd.text((x0 + 10, header_h + 24), b_cap, fill=(255, 115, 130), font=font_small)
    sd.rectangle([(x0 + 4, header_h + ch + 4), (x0 + cw - 4, header_h + ch + 44)], fill=(14, 18, 24))
    sd.text((x0 + 10, header_h + ch + 7), col_title, fill=(240, 245, 252), font=font_small)
    sd.text((x0 + 10, header_h + ch + 24), a_cap, fill=(108, 242, 158), font=font_small)

sheet_path = os.path.join(out_dir, "survivor-aim-topdown-sheet.png")
sheet.save(sheet_path)
print("Saved", sheet_path)

# 2. Build 144 paired video frames (BEFORE left | AFTER right)
for f in range(144):
    b_im = Image.open(os.path.join(vid_dir, f"before-{f:04d}.png")).convert("RGB")
    a_im = Image.open(os.path.join(vid_dir, f"after-{f:04d}.png")).convert("RGB")
    out = Image.new("RGB", (1280, 640), (14, 18, 24))
    out.paste(b_im, (0, 0))
    out.paste(a_im, (640, 0))
    d = ImageDraw.Draw(out)
    d.line([(640, 0), (640, 640)], fill=(55, 68, 84), width=2)
    if f < 36:
        phase = "1 · LOW READY WALK (1.4 m/s)"
    elif f < 84:
        phase = "2 · FIRE! (0.15s Raise to Shoulder + Two-Hand Aim + Recoil Kick)"
    elif f < 108:
        phase = "3 · POST-SHOT HOLD (2.5s Raised Aim Hold While Strafing)"
    else:
        phase = "4 · RELOAD (1.15s Left Hand Belt -> Grip Well + Slide Rack)"
    d.rectangle((0, 0, 1280, 38), fill=(14, 18, 24))
    d.text((16, 10), f"BEFORE (Unarmed Arm Swing)  ·  {phase}", fill=(255, 120, 136), font=font_sub)
    d.text((656, 10), f"AFTER (Stabilised Shoulder Pistol Aim)  ·  {phase}", fill=(108, 242, 158), font=font_sub)
    out.save(os.path.join(vid_dir, f"pair-{f:04d}.png"))
`
const pyRes = spawnSync("python3", ["-c", stitchPy, vidFramesDir, OUT_DIR], { stdio: "inherit" })
if (pyRes.status !== 0) process.exit(pyRes.status ?? 1)

const outMp4 = join(OUT_DIR, "survivor-aim-topdown.mp4")
const ff = spawnSync(
  "ffmpeg",
  [
    "-y",
    "-framerate",
    "48",
    "-i",
    join(vidFramesDir, "pair-%04d.png"),
    "-an",
    "-c:v",
    "h264_videotoolbox",
    "-b:v",
    "5M",
    "-pix_fmt",
    "yuv420p",
    outMp4,
  ],
  { stdio: "inherit" },
)
if (ff.status !== 0) process.exit(ff.status ?? 1)
// Clean up temporary frame directory
spawnSync("rm", ["-rf", vidFramesDir])
console.log(`Saved ${outMp4}`)
