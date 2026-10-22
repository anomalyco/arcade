import { browserBudget } from "../../../../scripts/browser-budget"
import { createServer } from "vite"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { findChromeExecutable } from "../compare"
import { blackoutRoot, parseArgs, repoRoot } from "./common"

await using budget = browserBudget()
const { chromium } = budget

// Side-view video of the unarmed survivor: 2 s walk, then 2 s run, frame-stepped through the Characters page.
// Usage: bun games/blackout/scripts/animation/render-video.ts [--out dir]
const { out: OUT_DIR } = parseArgs(process.argv.slice(2), { tag: "video", out: "video" })
const kitUrl = `/@fs${repoRoot}/packages/kit`
const vidFramesDir = join(OUT_DIR, "video-frames")
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
  await page.goto(`${base}/characters.html?manual&nolab#survivor`)
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
      if (a.id !== "survivor") {
        a.homeX = -100
        a.homeY = -100
        a.avatar.x = -100
        a.avatar.y = -100
        a.avatar.body = null
        a.action = "idle"
      }
    }
    const survivor = p.actors.find((a: any) => a.id === "survivor")!
    survivor.action = "idle"
    survivor.unarmedSwing = true

    const animMod = await import(/* @vite-ignore */ "/src/game/anim.ts" as string)
    const poseMod = await import(`${kitUrl}/human-pose.ts`)

    const stageX = 14.0, stageZ = 10.0
    const a = animMod.newAvatar("vid-survivor", stageX, stageZ, 0, "rifle")
    a.profile = { ...survivor.profile }
    a.unarmed = true
    let x = stageX, y = stageZ
    const dt = 1 / 60

    // Warmup 120 frames at walk speed (1.4 m/s)
    for (let n = 0; n < 120; n++) {
      x += 1.4 * dt
      animMod.animate(a, dt, n * dt, x, y, 1.4, 0, 0, false)
    }

    w.__vidState = { a, x, y, n: 120, dt, stageX, stageZ, animMod, poseMod, survivor, p }
  }, kitUrl)

  // Record 240 frames (4.0s at 60 fps): 120 frames steady walk (1.4 m/s) + 120 frames steady run (4.2 m/s)
  for (let f = 0; f < 240; f++) {
    await page.evaluate(async fIdx => {
      const w = window as any
      const st = w.__vidState
      const speed = fIdx < 120 ? 1.4 : 4.2
      st.x += speed * st.dt
      st.n++
      const t = st.n * st.dt
      st.animMod.animate(st.a, st.dt, t, st.x, st.y, speed, 0, 0, false)
      const b = st.a.body!
      const [hL, hR] = st.poseMod.unarmedHands(st.a, b.torso, t * 2)
      const arms = st.poseMod.poseUnarmedArms(b.torso, hL, hR)
      b.ua = arms.ua
      b.fa = arms.fa
      b.gun = null
      b.mag = null
      b.pump = null

      // Keep actor centered in camera while floor tiles scroll or camera tracks smoothly in side view
      const wrapX = st.stageX + ((st.x - st.stageX) % 4.0) - 2.0
      const dx = wrapX - st.x, dz = st.stageZ - st.y
      const shiftFrame = (fr: any) => ({
        p: [fr.p[0] + dx, fr.p[1], fr.p[2] + dz],
        x: [...fr.x],
        y: [...fr.y],
        z: [...fr.z],
      })
      st.survivor.avatar.x = -100
      st.survivor.avatar.y = -100
      st.survivor.avatar.body = {
        pelvis: shiftFrame(b.pelvis),
        torso: shiftFrame(b.torso),
        head: shiftFrame(b.head),
        ua: [shiftFrame(b.ua[0]), shiftFrame(b.ua[1])],
        fa: [shiftFrame(b.fa[0]), shiftFrame(b.fa[1])],
        th: [shiftFrame(b.th[0]), shiftFrame(b.th[1])],
        sh: [shiftFrame(b.sh[0]), shiftFrame(b.sh[1])],
        ft: [shiftFrame(b.ft[0]), shiftFrame(b.ft[1])],
        gun: null,
        pump: null,
        mag: null,
      }
      await st.p.invoke("camera.set", {
        target: [wrapX, 0.85, st.stageZ],
        orbit: 0,
        elevation: 8,
        distance: 3.8,
      })
    }, f)
    await page.screenshot({ path: join(vidFramesDir, `${String(f).padStart(4, "0")}.png`) })
  }
} finally {
  await browser.close()
  await server.close()
}

const outMp4 = join(OUT_DIR, "survivor-walk-run-side.mp4")
const ff = spawnSync(
  "ffmpeg",
  [
    "-y",
    "-framerate", "60",
    "-i", join(vidFramesDir, "%04d.png"),
    "-c:v", "h264_videotoolbox",
    "-b:v", "6M",
    "-pix_fmt", "yuv420p",
    outMp4,
  ],
  { stdio: "inherit" },
)
if (ff.status !== 0) await budget.exit(ff.status ?? 1)
console.log(`Saved ${outMp4}`)
