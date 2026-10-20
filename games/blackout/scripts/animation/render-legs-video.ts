import { chromium } from "playwright-core"
import { createServer } from "vite"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { findChromeExecutable } from "../compare"
import { parseArgs, repoRoot } from "./common"

// Today vs shared-rig legs on Outbreak's survivor, one headless muted browser run: a circle strafe round a target,
// a slow and a snap turn on the spot, backpedal, the four diagonals and A/D reversals, the pistol raised. The same
// WASD + mouse script plays twice (Lab › Survivor strafe › Legs = Today, then Shared rig) and is stitched side by side.
//   bun games/blackout/scripts/animation/render-legs-video.ts [--out dir] [--zoom 11] [--capture-only | --stitch-only]
// (--capture-only on a browser worker, then --stitch-only where Pillow and ffmpeg are installed.)
const { out: OUT_DIR, values, flags } = parseArgs(process.argv.slice(2), { tag: "after", out: "survivor-legs" })
const ZOOM = Number(values.zoom ?? 11)
const centre = { x: 31.4, y: 41.2 }, radius = 2.6

type Seg = { name: string; seconds: number }
// Plan +y is the survivor's right when it aims along +x.
const SEGMENTS: Seg[] = [
  { name: "circle strafe round the target", seconds: 5.5 },
  { name: "turn on the spot (slow)", seconds: 3.2 },
  { name: "flick 180°", seconds: 1.4 },
  { name: "backpedal", seconds: 1.5 },
  { name: "walk forward", seconds: 1.5 },
  { name: "diagonal forward-right", seconds: 1 },
  { name: "diagonal back-right", seconds: 1 },
  { name: "diagonal back-left", seconds: 1 },
  { name: "diagonal forward-left", seconds: 1 },
  { name: "A/D reversals", seconds: 2.4 },
  { name: "stop", seconds: 1 },
]
const frameSegs = SEGMENTS.flatMap((s, i) => Array.from({ length: Math.round(s.seconds * 60) }, () => i))

const framesDir = (pass: string) => join(OUT_DIR, `legs-video-frames-${pass}`)
if (!flags.has("stitch-only")) await capture()
if (!flags.has("capture-only")) stitchFrames()

async function capture() {
  const outbreakRoot = join(repoRoot, "games/outbreak")
  spawnSync("bun", ["scripts/build-id.ts"], { cwd: outbreakRoot, stdio: "inherit" })
  const server = await createServer({ root: outbreakRoot, optimizeDeps: { force: true }, server: { host: "127.0.0.1", port: 0, strictPort: false } })
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
    for (const [pass, legs] of [["today", 0], ["shared", 1]] as const) {
      rmSync(framesDir(pass), { recursive: true, force: true })
      mkdirSync(framesDir(pass), { recursive: true })
      const page = await browser.newPage({ viewport: { width: 640, height: 640 }, deviceScaleFactor: 1 })
      await page.goto(`${base}/?solo&seed=7&peaceful&bench&infiniteAmmo=1`, { waitUntil: "networkidle" })
      await page.waitForFunction(() => (window as any).__arcadeHarness?.ready === true, null, { timeout: 60000 })
      await page.addStyleTag({ content: `#status, #prompt, #stamina, #battery, #hotbar, .outbreak-hud, .coop-hud, aside[data-lab] { display: none !important; }` })
      await page.evaluate(({ centre, radius, legs, zoom }) => {
        const h = (window as any).__arcadeHarness
        h.setLab("zombieCount", 0)
        h.reset(7)
        h.setLab("legs", legs)
        h.setLab("timeScale", 0)
        h.setLab("hour", 15.5)
        h.setLab("cone", 180)
        h.setLab("range", 40)
        h.pose(centre.x - radius, centre.y, 0)
        h.setZoomRaw(zoom)
        h.spawnZombie(centre.x, centre.y, "chase", Math.PI)
      }, { centre, radius, legs, zoom: ZOOM })
      let segStart = 0, last = -1, holdAim = 0
      for (let f = -60; f < frameSegs.length; f++) {
        const seg = f < 0 ? 0 : frameSegs[f]!
        if (seg !== last) { segStart = f; last = seg }
        await page.evaluate(({ f, seg, t, centre, radius, zoom, holdAim }) => {
          const h = (window as any).__arcadeHarness
          const st = h.state()
          if (st.zombies[0]) Object.assign(st.zombies[0], { x: centre.x, y: centre.y, hp: 100, state: "chase" })
          const p = st.player
          let mx = 0, my = 0, aim = holdAim
          const along = (rel: number) => { mx = Math.cos(aim + rel); my = Math.sin(aim + rel) }
          if (seg === 0) {
            const dx = p.x - centre.x, dy = p.y - centre.y, r = Math.hypot(dx, dy) || 1
            mx = -dy / r + (radius - r) * 1.5 * dx / r
            my = dx / r + (radius - r) * 1.5 * dy / r
            const m = Math.hypot(mx, my) || 1
            mx /= m; my /= m
            aim = Math.atan2(centre.y - p.y, centre.x - p.x)
          } else if (seg === 1) aim = holdAim + Math.min(1, t / 2.8) * Math.PI * 2
          else if (seg === 2) aim = holdAim + Math.min(1, t / 0.3) * Math.PI
          else if (seg === 3) along(Math.PI)
          else if (seg === 4) along(0)
          else if (seg === 5) along(Math.PI / 4)
          else if (seg === 6) along(Math.PI * 3 / 4)
          else if (seg === 7) along(-Math.PI * 3 / 4)
          else if (seg === 8) along(-Math.PI / 4)
          else if (seg === 9) along(Math.floor(t / 0.6) % 2 ? -Math.PI / 2 : Math.PI / 2)
          ;(window as any).__legsAim = aim
          h.step(1 / 60, { mx, my, aim, fire: f % 80 === 0, interact: false })
          h.setZoomRaw(zoom)
        }, { f, seg, t: (f - segStart) / 60, centre, radius, zoom: ZOOM, holdAim })
        // Each segment after the circle starts from where the previous one left the aim.
        const nextSeg = f + 1 < 0 ? 0 : frameSegs[f + 1]
        if (nextSeg !== undefined && nextSeg !== seg) holdAim = await page.evaluate(() => (window as any).__legsAim as number)
        if (f >= 0) await page.screenshot({ path: join(framesDir(pass), `${String(f).padStart(4, "0")}.png`) })
      }
      await page.close()
      console.log(`${pass}: captured ${frameSegs.length} frames`)
    }
  } finally {
    await browser.close()
    await server.close()
  }
}

function stitchFrames() {
  const pairsDir = join(OUT_DIR, "legs-video-pairs")
  rmSync(pairsDir, { recursive: true, force: true })
  mkdirSync(pairsDir, { recursive: true })
  const labels = join(OUT_DIR, "legs-video-segments.json")
  writeFileSync(labels, JSON.stringify(frameSegs.map(i => SEGMENTS[i]!.name)))
  const stitch = `
import json, os, sys
from PIL import Image, ImageDraw, ImageFont
b_dir, a_dir, out_dir, labels = sys.argv[1], sys.argv[2], sys.argv[3], json.load(open(sys.argv[4]))
def font(sz):
    for p in ["/System/Library/Fonts/SFNSMono.ttf", "/System/Library/Fonts/Menlo.ttc"]:
        if os.path.exists(p):
            try: return ImageFont.truetype(p, sz)
            except Exception: pass
    return ImageFont.load_default()
f, big = font(14), font(18)
for i, name in enumerate(labels):
    b = Image.open(os.path.join(b_dir, f"{i:04d}.png")).convert("RGB")
    a = Image.open(os.path.join(a_dir, f"{i:04d}.png")).convert("RGB")
    out = Image.new("RGB", (1280, 680), (14, 18, 24))
    out.paste(b, (0, 34)); out.paste(a, (640, 34))
    d = ImageDraw.Draw(out)
    d.line([(640, 34), (640, 674)], fill=(55, 68, 84), width=2)
    d.text((14, 9), "TODAY · own stride clock", fill=(255, 120, 136), font=f)
    d.text((654, 9), "NEW · shared contact solver, planted feet, catch steps", fill=(108, 242, 158), font=f)
    d.rectangle((0, 640, 1280, 680), fill=(14, 18, 24))
    d.text((14, 650), name, fill=(230, 236, 242), font=big)
    out.save(os.path.join(out_dir, f"{i:04d}.png"))
  `
  const py = spawnSync("python3", ["-c", stitch, framesDir("today"), framesDir("shared"), pairsDir, labels], { stdio: "inherit" })
  if (py.status !== 0) process.exit(py.status ?? 1)
  const mp4 = join(OUT_DIR, "survivor-legs-today-vs-new.mp4")
  const ff = spawnSync("ffmpeg", ["-y", "-framerate", "60", "-i", join(pairsDir, "%04d.png"), "-an", "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", mp4], { stdio: "inherit" })
  if (ff.status !== 0) process.exit(ff.status ?? 1)
  console.log(`Saved ${mp4}`)
}

