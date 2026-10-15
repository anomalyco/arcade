import { chromium } from "playwright-core"
import { createServer } from "vite"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { findChromeExecutable } from "../compare"
import { blackoutRoot, parseArgs, repoRoot } from "./common"

// Renders a side-by-side (Side View | Top-Down Camera View) muted clip of the Zombie Shamble (with variants)
// and Crouch-Run through the real Characters page renderer.
const { out: OUT_DIR } = parseArgs(process.argv.slice(2), { tag: "video", out: "shamble-crouch" })
const kitUrl = `/@fs${repoRoot}/packages/kit`
const vidFramesDir = join(OUT_DIR, "shamble-video-frames")
mkdirSync(vidFramesDir, { recursive: true })

const server = await createServer({
  root: blackoutRoot,
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
  const page = await browser.newPage({ viewport: { width: 640, height: 720 }, deviceScaleFactor: 1 })
  await page.goto(`${base}/characters.html?manual&nolab#outbreak-zombie`)
  await page.waitForFunction(() => (window as any).ready === true, null, { timeout: 30000 })

  await page.addStyleTag({
    content: `
      .hub-bar, .char-hud-top, .char-dock, .char-status, aside[data-lab] { display: none !important; }
      body.characters-page, .characters-stage { background: #12161c !important; }
    `,
  })

  await page.evaluate(async kitUrl => {
    const w = window as any
    const p = w.charactersProof
    await p.invoke("character.reset", { target: "all" })
    for (const a of p.actors) {
      a.homeX = -100
      a.homeY = -100
      a.avatar.x = -100
      a.avatar.y = -100
      a.avatar.body = null
      a.action = "idle"
    }

    const animMod = await import(/* @vite-ignore */ "/src/game/anim.ts" as string)
    const profMod = await import(`${kitUrl}/human-profile.ts`)

    const stageX = 14.0, stageZ = 10.0
    const dt = 1 / 60

    // 1. Zombie shamble actors (dragger lead + limper & reacher pack mates for top-down view)
    const zLead = animMod.newAvatar("vid-z-lead", stageX, stageZ, 0, "rifle")
    zLead.profile = { ...profMod.humanProfiles.zombie, zombieVariant: "dragger" }
    const zLimp = animMod.newAvatar("vid-z-limp", stageX - 0.9, stageZ - 0.85, 0, "rifle")
    zLimp.profile = { ...profMod.humanProfiles.zombie, zombieVariant: "limper", timingBias: 0.3, hipDrop: 0.16, torsoRoll: 0.16 }
    zLimp.seed = 19
    const zReach = animMod.newAvatar("vid-z-reach", stageX - 0.65, stageZ + 0.85, 0, "rifle")
    zReach.profile = { ...profMod.humanProfiles.zombie, zombieVariant: "reacher", armReach: 0.48, torsoLean: 0.28 }
    zReach.seed = 43

    // 2. Crouch-run actor
    const cRunner = animMod.newAvatar("vid-crouch", stageX, stageZ, 0, "rifle")
    cRunner.profile = { ...profMod.humanProfiles.soldier, runPosture: 0.34, crouchDepth: 0.09 }
    cRunner.unarmed = true
    cRunner.crouchRun = true

    let zx = stageX, cx = stageX
    for (let n = 0; n < 120; n++) {
      zx += 0.95 * dt
      animMod.animate(zLead, dt, n * dt, zx, stageZ, 0.95, 0, 0, false)
      animMod.animate(zLimp, dt, n * dt, zx - 0.9, stageZ - 0.85, 0.92, 0, 0, false)
      animMod.animate(zReach, dt, n * dt, zx - 0.65, stageZ + 0.85, 0.98, 0, 0, false)
      cx += 4.2 * dt
      animMod.animate(cRunner, dt, n * dt, cx, stageZ, 4.2, 0, 0, false)
    }

    w.__shambleVid = { p, animMod, zLead, zLimp, zReach, cRunner, zx, cx, n: 120, dt, stageX, stageZ }
  }, kitUrl)

  const totalFrames = 144 // 2.4s @ 60fps (72 frames Zombie Shamble + 72 frames Crouch-Run)
  for (let f = 0; f < totalFrames; f++) {
    await page.evaluate(async fIdx => {
      const w = window as any
      const st = w.__shambleVid
      st.n++
      const t = st.n * st.dt
      const isShamble = fIdx < 72

      const shiftFrame = (fr: any, dx: number, dz: number) => ({
        p: [fr.p[0] + dx, fr.p[1], fr.p[2] + dz],
        x: [...fr.x],
        y: [...fr.y],
        z: [...fr.z],
      })
      const shiftBody = (b: any, dx: number, dz: number) => ({
        pelvis: shiftFrame(b.pelvis, dx, dz),
        torso: shiftFrame(b.torso, dx, dz),
        head: shiftFrame(b.head, dx, dz),
        ua: [shiftFrame(b.ua[0], dx, dz), shiftFrame(b.ua[1], dx, dz)],
        fa: [shiftFrame(b.fa[0], dx, dz), shiftFrame(b.fa[1], dx, dz)],
        th: [shiftFrame(b.th[0], dx, dz), shiftFrame(b.th[1], dx, dz)],
        sh: [shiftFrame(b.sh[0], dx, dz), shiftFrame(b.sh[1], dx, dz)],
        ft: [shiftFrame(b.ft[0], dx, dz), shiftFrame(b.ft[1], dx, dz)],
        gun: null,
        pump: null,
        mag: null,
      })

      for (const a of st.p.actors) {
        a.avatar.x = -100
        a.avatar.y = -100
        a.avatar.body = null
      }

      if (isShamble) {
        st.zx += 0.95 * st.dt
        st.animMod.animate(st.zLead, st.dt, t, st.zx, st.stageZ, 0.95, 0, 0, false)
        st.animMod.animate(st.zLimp, st.dt, t, st.zx - 0.9, st.stageZ - 0.85, 0.92, 0, 0, false)
        st.animMod.animate(st.zReach, st.dt, t, st.zx - 0.65, st.stageZ + 0.85, 0.98, 0, 0, false)
        const wrapX = st.stageX + ((st.zx - st.stageX) % 3.2) - 1.6
        const dx = wrapX - st.zx
        const outZ = st.p.actors.find((a: any) => a.id === "outbreak-zombie")!
        const boZ = st.p.actors.find((a: any) => a.id === "zombie")!
        const wiz = st.p.actors.find((a: any) => a.id === "wizard")!
        outZ.avatar.body = shiftBody(st.zLead.body!, dx, 0)
        boZ.avatar.body = shiftBody(st.zLimp.body!, dx, 0)
        wiz.models = outZ.models
        wiz.color = [0.52, 0.72, 0.36]
        wiz.avatar.body = shiftBody(st.zReach.body!, dx, 0)
        w.__curWrapX = wrapX
        w.__curMode = "shamble"
      } else {
        st.cx += 4.2 * st.dt
        st.animMod.animate(st.cRunner, st.dt, t, st.cx, st.stageZ, 4.2, 0, 0, false)
        const wrapX = st.stageX + ((st.cx - st.stageX) % 4.0) - 2.0
        const dx = wrapX - st.cx
        const surv = st.p.actors.find((a: any) => a.id === "survivor")!
        surv.avatar.body = shiftBody(st.cRunner.body!, dx, 0)
        w.__curWrapX = wrapX
        w.__curMode = "crouch"
      }
    }, f)

    // 1. Capture Side View (single lead character centered)
    await page.evaluate(async () => {
      const w = window as any
      const st = w.__shambleVid
      if (w.__curMode === "shamble") {
        // Hide background pack in side view so lead zombie silhouette is clean
        st.p.actors.find((a: any) => a.id === "zombie").avatar.body = null
        st.p.actors.find((a: any) => a.id === "wizard").avatar.body = null
      }
      await st.p.invoke("camera.set", {
        target: [w.__curWrapX, 0.82, st.stageZ],
        orbit: 0,
        elevation: 8,
        distance: 3.6,
      })
    })
    await page.screenshot({ path: join(vidFramesDir, `side-${String(f).padStart(4, "0")}.png`) })

    // 2. Capture Top-Down Outbreak Camera View (showing the 3-variant zombie pack in shamble mode)
    await page.evaluate(async () => {
      const w = window as any
      const st = w.__shambleVid
      if (w.__curMode === "shamble") {
        const dx = w.__curWrapX - st.zx
        const shiftFrame = (fr: any) => ({ p: [fr.p[0] + dx, fr.p[1], fr.p[2]], x: [...fr.x], y: [...fr.y], z: [...fr.z] })
        const shiftBody = (b: any) => ({
          pelvis: shiftFrame(b.pelvis), torso: shiftFrame(b.torso), head: shiftFrame(b.head),
          ua: [shiftFrame(b.ua[0]), shiftFrame(b.ua[1])], fa: [shiftFrame(b.fa[0]), shiftFrame(b.fa[1])],
          th: [shiftFrame(b.th[0]), shiftFrame(b.th[1])], sh: [shiftFrame(b.sh[0]), shiftFrame(b.sh[1])],
          ft: [shiftFrame(b.ft[0]), shiftFrame(b.ft[1])], gun: null, pump: null, mag: null,
        })
        st.p.actors.find((a: any) => a.id === "zombie").avatar.body = shiftBody(st.zLimp.body!)
        st.p.actors.find((a: any) => a.id === "wizard").avatar.body = shiftBody(st.zReach.body!)
      }
      await st.p.invoke("camera.set", {
        target: [w.__curWrapX - 0.25, 0.65, st.stageZ],
        orbit: 18,
        elevation: 62,
        distance: 5.4,
      })
    })
    await page.screenshot({ path: join(vidFramesDir, `top-${String(f).padStart(4, "0")}.png`) })
  }
} finally {
  await browser.close()
  await server.close()
}

// Stitch side-by-side with labels and encode MP4
const stitchPy = `
import os, sys
from PIL import Image, ImageDraw, ImageFont

vid_dir = sys.argv[1]
font = ImageFont.load_default()
for p in ["/System/Library/Fonts/SFNSMono.ttf", "/System/Library/Fonts/Menlo.ttc"]:
    if os.path.exists(p):
        font = ImageFont.truetype(p, 16)
        break

for f in range(144):
    s_path = os.path.join(vid_dir, f"side-{f:04d}.png")
    t_path = os.path.join(vid_dir, f"top-{f:04d}.png")
    s_img = Image.open(s_path).convert("RGB")
    t_img = Image.open(t_path).convert("RGB")
    out = Image.new("RGB", (1280, 720), (14, 18, 24))
    out.paste(s_img, (0, 0))
    out.paste(t_img, (640, 0))
    d = ImageDraw.Draw(out)
    d.line([(640, 0), (640, 720)], fill=(55, 68, 84), width=2)
    mode_l = "SIDE VIEW · Zombie Shamble (0.95 m/s)" if f < 72 else "SIDE VIEW · Crouch-Run (4.2 m/s, 28° Lean)"
    mode_r = "TOP-DOWN (62°) · Dragger / Limper / Reacher Pack" if f < 72 else "TOP-DOWN (62°) · Low Profile & Tight Guard"
    d.rectangle((0, 0, 1280, 36), fill=(14, 18, 24))
    d.text((16, 9), mode_l, fill=(235, 242, 250), font=font)
    d.text((656, 9), mode_r, fill=(120, 232, 152), font=font)
    out.save(os.path.join(vid_dir, f"pair-{f:04d}.png"))
`
spawnSync("python3", ["-c", stitchPy, vidFramesDir], { stdio: "inherit" })

const outMp4 = join(OUT_DIR, "zombie-shamble-crouch-side-top.mp4")
const ff = spawnSync(
  "ffmpeg",
  [
    "-y",
    "-framerate", "48",
    "-i", join(vidFramesDir, "pair-%04d.png"),
    "-c:v", "h264_videotoolbox",
    "-b:v", "5M",
    "-pix_fmt", "yuv420p",
    outMp4,
  ],
  { stdio: "inherit" },
)
if (ff.status !== 0) process.exit(ff.status ?? 1)
console.log(`Saved ${outMp4}`)
