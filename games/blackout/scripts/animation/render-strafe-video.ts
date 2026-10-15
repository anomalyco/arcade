import { chromium } from "playwright-core"
import { createServer } from "vite"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { findChromeExecutable } from "../compare"
import { parseArgs, repoRoot } from "./common"

// Top-down Outbreak clip of the survivor circle-strafing a target while aiming at it (muted).
// Capture each checkout's frames, then stitch before | after:
//   bun render-strafe-video.ts --tag before --outbreak-root <baseline>/games/outbreak
//   bun render-strafe-video.ts --tag after
//   bun render-strafe-video.ts --stitch
const { tag, out: OUT_DIR, values, flags } = parseArgs(process.argv.slice(2), { tag: "after", out: "strafe" })
const FRAMES = Number(values.frames ?? 330)
const framesDir = (t: string) => join(OUT_DIR, `strafe-video-frames-${t}`)

if (!flags.has("stitch")) {
  const outbreakRoot = resolve(values["outbreak-root"] ?? join(repoRoot, "games/outbreak"))
  spawnSync("bun", ["scripts/build-id.ts"], { cwd: outbreakRoot, stdio: "inherit" })
  mkdirSync(framesDir(tag), { recursive: true })
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
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 640 }, deviceScaleFactor: 1 })
    await page.goto(`${base}/?solo&seed=7&peaceful&bench&infiniteAmmo=1`, { waitUntil: "networkidle" })
    await page.waitForFunction(() => (window as any).__arcadeHarness?.ready === true, null, { timeout: 60000 })
    await page.addStyleTag({ content: `#status, #prompt, #stamina, #battery, #hotbar, .outbreak-hud, .coop-hud, aside[data-lab] { display: none !important; }` })
    const centre = { x: 31.4, y: 41.2 }, radius = 2.4
    await page.evaluate(async ({ centre, radius }) => {
      const h = (window as any).__arcadeHarness
      h.setLab("zombieCount", 0)
      h.reset(7)
      h.setLab("timeScale", 0)
      h.setLab("hour", 15.5)
      h.setLab("cone", 180)
      h.setLab("range", 40)
      h.pose(centre.x - radius, centre.y, 0)
      h.setZoomRaw(15)
      h.spawnZombie(centre.x, centre.y, "chase", Math.PI)
    }, { centre, radius })
    for (let f = -60; f < FRAMES; f++) {
      await page.evaluate(async ({ f, centre, radius }) => {
        const h = (window as any).__arcadeHarness
        const st = h.state()
        if (st.zombies[0]) Object.assign(st.zombies[0], { x: centre.x, y: centre.y, hp: 100, state: "chase" })
        const p = st.player
        const dx = p.x - centre.x, dy = p.y - centre.y, r = Math.hypot(dx, dy) || 1
        // Anticlockwise tangent plus a radial correction that holds the radius.
        let mx = -dy / r + (radius - r) * 1.5 * dx / r
        let my = dx / r + (radius - r) * 1.5 * dy / r
        const m = Math.hypot(mx, my) || 1
        mx /= m; my /= m
        const aim = Math.atan2(centre.y - p.y, centre.x - p.x)
        await h.step(1 / 60, { mx, my, aim, fire: f % 80 === 0, interact: false })
        h.setZoomRaw(15)
      }, { f, centre, radius })
      if (f >= 0) await page.screenshot({ path: join(framesDir(tag), `${String(f).padStart(4, "0")}.png`) })
    }
  } finally {
    await browser.close()
    await server.close()
  }
  console.log(`Captured ${FRAMES} frames in ${framesDir(tag)}`)
  process.exit(0)
}

for (const t of ["before", "after"]) if (!existsSync(framesDir(t))) throw new Error(`Missing ${framesDir(t)}; capture it first`)
const count = Math.min(readdirSync(framesDir("before")).length, readdirSync(framesDir("after")).length)
const pairsDir = join(OUT_DIR, "strafe-video-pairs")
mkdirSync(pairsDir, { recursive: true })
const stitch = `
import os, sys
from PIL import Image, ImageDraw, ImageFont
b_dir, a_dir, out_dir, n = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
def font(sz):
    for p in ["/System/Library/Fonts/SFNSMono.ttf", "/System/Library/Fonts/Menlo.ttc"]:
        if os.path.exists(p):
            try: return ImageFont.truetype(p, sz)
            except Exception: pass
    return ImageFont.load_default()
f = font(14)
for i in range(n):
    b = Image.open(os.path.join(b_dir, f"{i:04d}.png")).convert("RGB")
    a = Image.open(os.path.join(a_dir, f"{i:04d}.png")).convert("RGB")
    out = Image.new("RGB", (1280, 640), (14, 18, 24))
    out.paste(b, (0, 0)); out.paste(a, (640, 0))
    d = ImageDraw.Draw(out)
    d.line([(640, 0), (640, 640)], fill=(55, 68, 84), width=2)
    d.rectangle((0, 0, 1280, 34), fill=(14, 18, 24))
    d.text((14, 9), "BEFORE (main) · knees bowed 22° off the boots, no crossover", fill=(255, 120, 136), font=f)
    d.text((654, 9), "AFTER · knees over boots, crossover steps, chest on aim", fill=(108, 242, 158), font=f)
    out.save(os.path.join(out_dir, f"{i:04d}.png"))
`
const py = spawnSync("python3", ["-c", stitch, framesDir("before"), framesDir("after"), pairsDir, String(count)], { stdio: "inherit" })
if (py.status !== 0) process.exit(py.status ?? 1)
const mp4 = join(OUT_DIR, "strafe-circle-topdown.mp4")
const ff = spawnSync("ffmpeg", ["-y", "-framerate", "60", "-i", join(pairsDir, "%04d.png"), "-an", "-c:v", "h264_videotoolbox", "-b:v", "5M", "-pix_fmt", "yuv420p", mp4], { stdio: "inherit" })
if (ff.status !== 0) process.exit(ff.status ?? 1)
console.log(`Saved ${mp4}`)
