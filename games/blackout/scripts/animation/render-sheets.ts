import { chromium } from "playwright-core"
import { createServer } from "vite"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { findChromeExecutable } from "../compare"
import { blackoutRoot, parseArgs, repoRoot } from "./common"

// Shaded 3D key-frame sheets of the unarmed survivor through the real Characters page renderer.
// Usage: bun games/blackout/scripts/animation/render-sheets.ts --tag before|after [--out dir]
const { tag, out: OUT_DIR } = parseArgs(process.argv.slice(2), { tag: "before", out: "sheets" })
const kitUrl = `/@fs${repoRoot}/packages/kit`
const framesDir = join(OUT_DIR, `frames-${tag}`)
mkdirSync(framesDir, { recursive: true })

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

const PHASE_NAMES_WALK = [
  "1. L Contact (DS)",
  "2. L Down / Load",
  "3. L Passing (Mid)",
  "4. L Up / Term",
  "5. R Contact (DS)",
  "6. R Down / Load",
  "7. R Passing (Mid)",
  "8. R Up / Term",
]

const PHASE_NAMES_RUN = [
  "1. L Contact",
  "2. L Down (Mid-St)",
  "3. L Toe-Off",
  "4. Flight (L->R)",
  "5. R Contact",
  "6. R Down (Mid-St)",
  "7. R Toe-Off",
  "8. Flight (R->L)",
]

try {
  // Cell size 384x512 -> 4x2 grid = 1536x1024 (exact gpt-image-1.5 landscape size!)
  const page = await browser.newPage({ viewport: { width: 384, height: 512 }, deviceScaleFactor: 2 })
  await page.goto(`${base}/characters.html?manual&nolab#survivor`)
  await page.waitForFunction(() => (window as any).ready === true, null, { timeout: 30000 })

  // Hide all HUD chrome for a clean neutral stage
  await page.addStyleTag({
    content: `
      .hub-bar, .char-hud-top, .char-dock, .char-status, aside[data-lab] { display: none !important; }
      body.characters-page, .characters-stage { background: #12161c !important; }
    `,
  })

  for (const mode of ["walk", "run"] as const) {
    const speed = mode === "walk" ? 1.4 : 4.2
    for (const view of ["side", "iso"] as const) {
      // Simulate deterministically inside page, find a clean steady-state cycle starting at Left Foot Contact,
      // and capture 8 evenly spaced frames across that full cycle with onion-skin ghosts.
      const meta = await page.evaluate(
        async ({ mode, speed }) => {
          const w = window as any
          const p = w.charactersProof
          // Reset all actors and hide non-survivor actors far offstage
          await p.invoke("character.reset", { target: "all" })
          const survivor = p.actors.find((a: any) => a.id === "survivor")!
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
          p.selectActor("survivor", false)
          survivor.action = "idle" // We will drive survivor.avatar directly at constant velocity along +X (dir = 0)
          survivor.profile.handPose = "weapon"
          survivor.unarmedSwing = true

          return { ok: true }
        },
        { mode, speed },
      )

      // Now run our deterministic stepping and capture 8 phases in page context
      const cycleInfo = await page.evaluate(
        async ({ mode, speed, view, kitUrl }) => {
          const w = window as any
          const p = w.charactersProof
          const survivor = p.actors.find((a: any) => a.id === "survivor")!
          // Remove any previous ghost actors
          while (p.actors.length > 5) p.actors.pop()

          // Re-initialize survivor at (14, 10) facing +X (aim = 0)
          const startX = 10.0, startY = 10.0
          survivor.homeX = startX
          survivor.homeY = startY
          survivor.homeAim = 0
          p.resetActor("survivor")
          survivor.action = "idle"

          const dt = 1 / 60
          const history: {
            frame: number
            t: number
            x: number
            y: number
            pelvisY: number
            headY: number
            plantedL: boolean
            plantedR: boolean
            footL: [number, number, number]
            footR: [number, number, number]
            toeL: [number, number, number]
            toeR: [number, number, number]
            bodyClone: any
          }[] = []

          const cloneFrame = (f: any) => ({ p: [...f.p], x: [...f.x], y: [...f.y], z: [...f.z] })
          const cloneBody = (b: any) => ({
            pelvis: cloneFrame(b.pelvis),
            torso: cloneFrame(b.torso),
            head: cloneFrame(b.head),
            ua: [cloneFrame(b.ua[0]), cloneFrame(b.ua[1])],
            fa: [cloneFrame(b.fa[0]), cloneFrame(b.fa[1])],
            th: [cloneFrame(b.th[0]), cloneFrame(b.th[1])],
            sh: [cloneFrame(b.sh[0]), cloneFrame(b.sh[1])],
            ft: [cloneFrame(b.ft[0]), cloneFrame(b.ft[1])],
            gun: null,
            pump: null,
            mag: null,
          })

          // The page's Walk/Run loops travel at 0.72 rad with aim sway and wrap at 5.8 m. Drive a private
          // avatar straight along +X instead, so the cycle is steady and every sheet uses the same heading.
          const animMod = await import(/* @vite-ignore */ "/src/game/anim.ts" as string)
          const poseMod = await import(`${kitUrl}/human-pose.ts`)
          const rigMod = await import(`${kitUrl}/rig.ts`)

          const a = animMod.newAvatar("sheet-survivor", startX, startY, 0, "rifle")
          a.profile = { ...survivor.profile }
          a.unarmed = true
          let x = startX, y = startY
          const touchdownsL: number[] = []
          let prevPlantedL = true

          for (let n = 0; n < 360; n++) {
            const t = n * dt
            x += speed * dt
            animMod.animate(a, dt, t, x, y, speed, 0, 0, false)
            const b = a.body!
            const [hL, hR] = poseMod.unarmedHands(a, b.torso, t * 2)
            const arms = poseMod.poseUnarmedArms(b.torso, hL, hR)
            b.ua = arms.ua
            b.fa = arms.fa
            b.gun = null
            b.mag = null
            b.pump = null

            if (n >= 150 && !prevPlantedL && a.feet[0].planted) {
              touchdownsL.push(n)
            }
            prevPlantedL = a.feet[0].planted

            const toeL = rigMod.at(b.ft[0], 0.19, -rigMod.RIG.ankle, 0)
            const toeR = rigMod.at(b.ft[1], 0.19, -rigMod.RIG.ankle, 0)
            history.push({
              frame: n,
              t,
              x,
              y,
              pelvisY: b.pelvis.p[1],
              headY: b.head.p[1],
              plantedL: a.feet[0].planted,
              plantedR: a.feet[1].planted,
              footL: [b.ft[0].p[0], b.ft[0].p[1], b.ft[0].p[2]],
              footR: [b.ft[1].p[0], b.ft[1].p[1], b.ft[1].p[2]],
              toeL,
              toeR,
              bodyClone: cloneBody(b),
            })
          }

          const fStart = touchdownsL[1]!
          const fEnd = touchdownsL[2]!
          const cycleFrames = fEnd - fStart
          const phaseFrames: number[] = []
          for (let k = 0; k < 8; k++) {
            phaseFrames.push(fStart + Math.round((k * cycleFrames) / 8))
          }

          ;(window as any).__sheetHistory = history
          ;(window as any).__sheetPhaseFrames = phaseFrames
          return { fStart, fEnd, cycleFrames, phaseFrames }
        },
        { mode, speed, view, kitUrl },
      )

      const cellMeta: any[] = []
      for (let k = 0; k < 8; k++) {
        const frameIdx = cycleInfo.phaseFrames[k]!
        const info = await page.evaluate(
          async ({ frameIdx, view }) => {
            const w = window as any
            const p = w.charactersProof
            const history = w.__sheetHistory as any[]
            const cur = history[frameIdx]!
            const ghost1 = history[Math.max(0, frameIdx - 2)]!
            const ghost2 = history[Math.max(0, frameIdx - 4)]!

            const survivor = p.actors.find((a: any) => a.id === "survivor")!
            while (p.actors.length > 5) p.actors.pop()
            for (const a of p.actors) {
              if (a.id !== "survivor") a.avatar.body = null
            }

            // Re-center current pose at stage center (14.0, 10.0) so every cell has identical lighting and framing,
            // while keeping ghosts at their true world-space offset behind the character!
            const stageX = 14.0, stageZ = 10.0
            const dx = stageX - cur.x, dz = stageZ - cur.y

            const shiftFrame = (f: any, ox: number, oz: number) => ({
              p: [f.p[0] + ox, f.p[1], f.p[2] + oz],
              x: [...f.x],
              y: [...f.y],
              z: [...f.z],
            })
            const shiftBody = (b: any, ox: number, oz: number) => ({
              pelvis: shiftFrame(b.pelvis, ox, oz),
              torso: shiftFrame(b.torso, ox, oz),
              head: shiftFrame(b.head, ox, oz),
              ua: [shiftFrame(b.ua[0], ox, oz), shiftFrame(b.ua[1], ox, oz)],
              fa: [shiftFrame(b.fa[0], ox, oz), shiftFrame(b.fa[1], ox, oz)],
              th: [shiftFrame(b.th[0], ox, oz), shiftFrame(b.th[1], ox, oz)],
              sh: [shiftFrame(b.sh[0], ox, oz), shiftFrame(b.sh[1], ox, oz)],
              ft: [shiftFrame(b.ft[0], ox, oz), shiftFrame(b.ft[1], ox, oz)],
              gun: null,
              pump: null,
              mag: null,
            })

            // Put selection ring offscreen so it doesn't clutter the foot contact markers
            survivor.avatar.x = -100
            survivor.avatar.y = -100

            // Set camera for side view (looking along -Z at +X walker: orbit = 0 deg) or isometric (orbit = 36 deg)
            if (view === "side") {
              await p.invoke("camera.set", {
                target: [stageX, 0.85, stageZ],
                orbit: 0,
                elevation: 8,
                distance: 4.15,
              })
            } else {
              await p.invoke("camera.set", {
                target: [stageX, 0.85, stageZ],
                orbit: 38,
                elevation: 22,
                distance: 4.25,
              })
            }

            ;(window as any).__setPoseForShot = async (modeShot: "main" | "ghost1" | "ghost2") => {
              const src = modeShot === "main" ? cur : modeShot === "ghost1" ? ghost1 : ghost2
              survivor.avatar.x = -100
              survivor.avatar.y = -100
              survivor.avatar.body = shiftBody(src.bodyClone, dx, dz)
              await p.invoke("camera.set", {})
            }
            await (window as any).__setPoseForShot("main")

            // Project 3D markers to 2D canvas coordinates (width=384, height=512)
            // Matches the Characters page camera: 0.5 rad vertical FOV, looking from eye to focus.
            const camState = p.camera
            const W = 384, H = 512
            const aspect = W / H
            const fov = 0.5
            const f = 1.0 / Math.tan(fov / 2)
            const eye = camState.eye as [number, number, number]
            const target = camState.focus as [number, number, number]
            const zAxis = [eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]
            const zLen = Math.hypot(...zAxis)
            const kz = zAxis.map(v => v / zLen)
            const up = [0, 1, 0]
            const kxRaw = [
              up[1]! * kz[2]! - up[2]! * kz[1]!,
              up[2]! * kz[0]! - up[0]! * kz[2]!,
              up[0]! * kz[1]! - up[1]! * kz[0]!,
            ]
            const xLen = Math.hypot(...kxRaw)
            const kx = kxRaw.map(v => v / xLen)
            const ky = [
              kz[1]! * kx[2]! - kz[2]! * kx[1]!,
              kz[2]! * kx[0]! - kz[0]! * kx[2]!,
              kz[0]! * kx[1]! - kz[1]! * kx[0]!,
            ]
            const proj = (pt: [number, number, number]) => {
              const rx = pt[0] - eye[0], ry = pt[1] - eye[1], rz = pt[2] - eye[2]
              const cx = rx * kx[0]! + ry * kx[1]! + rz * kx[2]!
              const cy = rx * ky[0]! + ry * ky[1]! + rz * ky[2]!
              const cz = -(rx * kz[0]! + ry * kz[1]! + rz * kz[2]!)
              const ndcX = (cx * (f / aspect)) / cz
              const ndcY = (cy * f) / cz
              return [(ndcX * 0.5 + 0.5) * W * 2, (0.5 - ndcY * 0.5) * H * 2] // *2 for deviceScaleFactor=2 (768x1024)
            }

            return {
              frameIdx,
              pelvisY: cur.pelvisY,
              headY: cur.headY,
              plantedL: cur.plantedL,
              plantedR: cur.plantedR,
              footL2D: proj([cur.footL[0] + dx, 0, cur.footL[2] + dz]),
              footR2D: proj([cur.footR[0] + dx, 0, cur.footR[2] + dz]),
              toeL2D: proj([cur.toeL[0] + dx, 0, cur.toeL[2] + dz]),
              toeR2D: proj([cur.toeR[0] + dx, 0, cur.toeR[2] + dz]),
              pelvis2D: proj([stageX, cur.pelvisY, stageZ]),
              groundLeft2D: proj([stageX - 0.55, 0, stageZ]),
              groundRight2D: proj([stageX + 0.55, 0, stageZ]),
            }
          },
          { frameIdx, view },
        )

        const cellPath = join(framesDir, `${mode}-${view}-${k}.png`)
        const g1Path = join(framesDir, `${mode}-${view}-${k}-g1.png`)
        const g2Path = join(framesDir, `${mode}-${view}-${k}-g2.png`)
        await page.screenshot({ path: cellPath })
        await page.evaluate(() => (window as any).__setPoseForShot("ghost1"))
        await page.screenshot({ path: g1Path })
        await page.evaluate(() => (window as any).__setPoseForShot("ghost2"))
        await page.screenshot({ path: g2Path })
        cellMeta.push({ ...info, cellPath, g1Path, g2Path })
      }

      const metaPath = join(framesDir, `${mode}-${view}-meta.json`)
      writeFileSync(metaPath, JSON.stringify({ mode, view, speed, tag, phaseNames: mode === "walk" ? PHASE_NAMES_WALK : PHASE_NAMES_RUN, cells: cellMeta }, null, 2))
    }
  }
} finally {
  await browser.close()
  await server.close()
}

const py = spawnSync("python3", [join(import.meta.dir, "stitch-sheets.py"), OUT_DIR, tag], { stdio: "inherit" })
if (py.status !== 0) process.exit(py.status ?? 1)
