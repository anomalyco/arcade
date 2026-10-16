// Scaffolds a minimal low-res greybox toy prototype on @arcade/kit:
//   bun scripts/new-toy.ts <name> [--out <dir>]
// See docs/prototyping.md for the toy-first workflow and graduation gate.
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const args = process.argv.slice(2)
const nameArg = args.find((a) => !a.startsWith("-"))
const outIdx = args.indexOf("--out")
const outArg = outIdx >= 0 ? args[outIdx + 1] : undefined

if (!nameArg || !/^[a-z][a-z0-9-]{1,23}$/.test(nameArg)) {
  console.error("Usage: bun scripts/new-toy.ts <name> [--out <dir>]")
  process.exit(1)
}

const name = nameArg
const title = name.toUpperCase()
const repo = resolve(import.meta.dir, "..")
const root = resolve(outArg ?? join(repo, "games", name))

if (existsSync(root)) {
  console.error(`Target directory already exists: ${root}`)
  process.exit(1)
}

mkdirSync(join(root, "shared"), { recursive: true })
mkdirSync(join(root, "src"), { recursive: true })
mkdirSync(join(root, "tests"), { recursive: true })

writeFileSync(
  join(root, "package.json"),
  JSON.stringify(
    {
      name: `@arcade/${name}`,
      private: true,
      type: "module",
      scripts: {
        dev: "vite",
        build: "vite build",
        test: "bun test",
        check: "tsc --noEmit && bun test && vite build",
      },
      dependencies: {
        "@arcade/kit": "workspace:*",
      },
    },
    null,
    2,
  ) + "\n",
)

writeFileSync(
  join(root, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        types: ["@webgpu/types", "bun-types"],
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      include: ["src", "shared", "tests"],
    },
    null,
    2,
  ) + "\n",
)

writeFileSync(
  join(root, "vite.config.ts"),
  `import { defineConfig } from "vite"

export default defineConfig({
  base: "/arcade/${name}/",
  build: {
    outDir: "dist/arcade/${name}",
    emptyOutDir: true,
    target: "es2022",
  },
})
`,
)

writeFileSync(
  join(root, "index.html"),
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${title} (Toy)</title>
    <style>
      html, body { margin: 0; height: 100%; background: #0d1016; color: #e8eef4; font-family: monospace; overflow: hidden; }
      #view { width: 100vw; height: 100vh; display: block; }
      #hud { position: fixed; top: 12px; left: 14px; pointer-events: none; font-size: 13px; opacity: 0.8; }
    </style>
  </head>
  <body>
    <canvas id="view"></canvas>
    <div id="hud">WASD move · LMB dash-slam · \` Lab feel knobs</div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`,
)

writeFileSync(
  join(root, "shared/sim.ts"),
  `import type { LabControl } from "@arcade/kit/lab-panel"
import type { Rect } from "@arcade/kit/sim/geom"
import { stepBody } from "@arcade/kit/sim/move"

export const ARENA_HALF = 11
export const PILLARS: readonly Rect[] = [
  [-4.5, -4.5, -2.5, -2.5],
  [2.5, -4.5, 4.5, -2.5],
  [-4.5, 2.5, -2.5, 4.5],
  [2.5, 2.5, 4.5, 4.5],
]
export const WALLS: readonly Rect[] = [
  ...PILLARS,
  [-ARENA_HALF - 1, -ARENA_HALF - 1, ARENA_HALF + 1, -ARENA_HALF],
  [-ARENA_HALF - 1, ARENA_HALF, ARENA_HALF + 1, ARENA_HALF + 1],
  [-ARENA_HALF - 1, -ARENA_HALF, -ARENA_HALF, ARENA_HALF],
  [ARENA_HALF, -ARENA_HALF, ARENA_HALF + 1, ARENA_HALF],
]

export const FEEL = {
  moveSpeed: 7.5,
  accel: 22,
  dashImpulse: 16,
  dashCooldown: 0.45,
  knockback: 13,
  hitStopMs: 55,
  shake: 0.45,
}
export type FeelConfig = typeof FEEL

export const FEEL_CONTROLS: LabControl[] = [
  { key: "moveSpeed", label: "Move speed", group: "Feel", min: 3, max: 14, step: 0.25, unit: "m/s" },
  { key: "accel", label: "Acceleration", group: "Feel", min: 6, max: 45, step: 1, unit: "/s" },
  { key: "dashImpulse", label: "Dash impulse", group: "Feel", min: 6, max: 28, step: 0.5, unit: "m/s" },
  { key: "dashCooldown", label: "Dash cooldown", group: "Feel", min: 0.15, max: 1.2, step: 0.05, unit: "s" },
  { key: "knockback", label: "Hit knockback", group: "Feel", min: 4, max: 25, step: 0.5, unit: "m/s" },
  { key: "hitStopMs", label: "Hit-stop", group: "Feel", min: 0, max: 120, step: 5, unit: "ms" },
  { key: "shake", label: "Impact shake", group: "Feel", min: 0, max: 1, step: 0.05 },
]

export type Dummy = { id: number; x: number; y: number; vx: number; vy: number; flash: number; hits: number }
export type ToyState = {
  t: number
  player: { x: number; y: number; vx: number; vy: number; aim: number; cooldown: number; dashing: number }
  dummies: Dummy[]
}

export type ToyInput = { mx: number; my: number; aim: number; dash: boolean }

export function createToyState(): ToyState {
  return {
    t: 0,
    player: { x: 0, y: 0, vx: 0, vy: 0, aim: 0, cooldown: 0, dashing: 0 },
    dummies: [
      { id: 1, x: -5, y: 0, vx: 0, vy: 0, flash: 0, hits: 0 },
      { id: 2, x: 5, y: 0, vx: 0, vy: 0, flash: 0, hits: 0 },
      { id: 3, x: 0, y: -5, vx: 0, vy: 0, flash: 0, hits: 0 },
    ],
  }
}

export function stepToy(state: ToyState, input: ToyInput, dt: number, feel: Readonly<FeelConfig> = FEEL): number {
  state.t += dt
  const p = state.player
  p.aim = input.aim
  p.cooldown = Math.max(0, p.cooldown - dt)
  p.dashing = Math.max(0, p.dashing - dt)
  if (input.dash && p.cooldown <= 0) {
    p.vx += Math.cos(p.aim) * feel.dashImpulse
    p.vy += Math.sin(p.aim) * feel.dashImpulse
    p.cooldown = feel.dashCooldown
    p.dashing = 0.16
  }
  stepBody(p, input.mx, input.my, feel.moveSpeed, WALLS, dt, 0.45, feel.accel)
  let hits = 0
  for (const d of state.dummies) {
    d.flash = Math.max(0, d.flash - dt * 5)
    stepBody(d, 0, 0, 0, WALLS, dt, 0.5, 9)
    const dx = d.x - p.x
    const dy = d.y - p.y
    const dist = Math.hypot(dx, dy)
    if (dist < 1.05 && dist > 1e-4) {
      const nx = dx / dist
      const ny = dy / dist
      const overlap = 1.05 - dist
      d.x += nx * overlap * 0.6
      d.y += ny * overlap * 0.6
      p.x -= nx * overlap * 0.4
      p.y -= ny * overlap * 0.4
      if (p.dashing > 0) {
        d.vx = nx * feel.knockback
        d.vy = ny * feel.knockback
        d.flash = 1
        d.hits++
        p.dashing = 0
        hits++
      }
    }
  }
  return hits
}
`,
)

writeFileSync(
  join(root, "src/main.ts"),
  `import { Camera, HitStop } from "@arcade/kit/client/camera"
import { Input } from "@arcade/kit/client/input"
import { openGpu } from "@arcade/kit/gpu/boot"
import { MAT, Mesh, packVerts } from "@arcade/kit/gpu/mesh"
import { INST_FLOATS, Renderer } from "@arcade/kit/gpu/renderer"
import { flatLighting, newSceneFrame, packSceneFrame, SceneLights } from "@arcade/kit/gpu/scene-frame"
import { LabPanel } from "@arcade/kit/lab-panel"
import { ARENA_HALF, createToyState, FEEL, FEEL_CONTROLS, PILLARS, stepToy } from "../shared/sim"

async function main() {
  const canvas = document.getElementById("view") as HTMLCanvasElement
  const gpu = await openGpu(canvas, "${title}")
  if (typeof gpu === "string") {
    document.getElementById("hud")!.textContent = gpu
    return
  }
  const renderer = new Renderer(gpu.device, gpu.context, gpu.format)
  const level = new Mesh()
  level.box(-ARENA_HALF, -0.2, -ARENA_HALF, ARENA_HALF, 0, ARENA_HALF, [0.16, 0.19, 0.24], MAT.lit)
  for (const [x0, y0, x1, y1] of PILLARS) level.box(x0, 0, y0, x1, 1.8, y1, [0.28, 0.33, 0.4], MAT.lit)
  const lighting = flatLighting(0, 1, [0.18, 0.2, 0.26])
  renderer.setLevel({
    chunks: [{ data: packVerts(level.v), box: [-ARENA_HALF, -ARENA_HALF, ARENA_HALF, ARENA_HALF] }],
    glass: [],
    floor: lighting.floor,
    bounce: lighting.bounce,
  })

  const playerMesh = new Mesh()
  playerMesh.prism(0, 0, 0.42, 0.42, 0, 1.35, 14, [0.35, 0.82, 0.96], MAT.actor)
  playerMesh.box(0.15, 0.85, -0.1, 0.55, 1.05, 0.1, [0.95, 0.98, 1], MAT.glow, 0.8)
  const playerModel = renderer.addModel(playerMesh)

  const dummyMesh = new Mesh()
  dummyMesh.box(-0.45, 0, -0.45, 0.45, 1.25, 0.45, [0.92, 0.38, 0.32], MAT.actor)
  const dummyModel = renderer.addModel(dummyMesh)

  const state = createToyState()
  const input = new Input(canvas)
  input.enabled = true
  const cam = new Camera()
  cam.snap(0, 0)
  const hitStop = new HitStop()
  const lights = new SceneLights()
  lights.setBoxes(PILLARS.map((rect) => ({ rect, h: 1.8 })))
  const sceneFrame = newSceneFrame()
  const panel = new LabPanel(FEEL, FEEL_CONTROLS, new URLSearchParams(location.search), () => input.release())
  input.onKey = (code) => {
    if (code === "Backquote") panel.toggle()
  }

  const playerInst = new Float32Array(INST_FLOATS)
  const dummyInst = new Float32Array(state.dummies.length * INST_FLOATS)
  const emptySprites = new Float32Array(0)
  let last = performance.now()
  let acc = 0
  const DT = 1 / 60

  const frame = (now: number) => {
    const elapsed = Math.min(0.1, (now - last) / 1000)
    last = now
    const scaledDt = hitStop.step(elapsed)
    acc += scaledDt
    while (acc >= DT) {
      acc -= DT
      const cursor = cam.unproject(input.mouse.x, input.mouse.y, innerWidth, innerHeight, 0)
      const heading = Math.atan2(cursor.y - state.player.y, cursor.x - state.player.x)
      const { mx, my } = input.move()
      const hits = stepToy(state, { mx, my, aim: heading, dash: input.takeFirePress() }, DT, FEEL)
      if (hits > 0) {
        hitStop.trigger(FEEL.hitStopMs / 1000)
        cam.add(FEEL.shake, heading)
      }
    }
    cam.follow(state.player.x, state.player.y, 0, 0, elapsed, false)
    const vp = cam.update(innerWidth / innerHeight)

    lights.update(
      [{ x: state.player.x, y: state.player.y, h: 2.6, r: 12, color: [0.65, 0.88, 1.0], power: 1.1 }],
      [{ x: state.player.x, y: state.player.y }, ...state.dummies],
    )
    packSceneFrame(sceneFrame, {
      viewProj: vp as Float32Array,
      eye: cam.eye,
      time: state.t,
      width: renderer.width,
      height: renderer.height,
      lightCount: lights.lightCount,
      ambient: [0.14, 0.16, 0.22, 0],
      mapSize: [ARENA_HALF * 2, ARENA_HALF * 2],
      ao: 0.4,
    })

    playerInst.set([state.player.x, state.player.y, 0, state.player.aim, 1, 1, 1, 0, 0, state.player.dashing > 0 ? 0.6 : 0, 0, 1])
    for (let i = 0; i < state.dummies.length; i++) {
      const d = state.dummies[i]!
      dummyInst.set([d.x, d.y, 0, 0, 1, 1, 1, 0, 0, d.flash, 0, 1], i * INST_FLOATS)
    }
    renderer.render({
      frame: sceneFrame as Float32Array<ArrayBuffer>,
      lights: lights.lights as Float32Array<ArrayBuffer>,
      lightCount: lights.lightCount,
      shadowLightCount: lights.shadowLightCount,
      occluders: lights.occ as Float32Array<ArrayBuffer>,
      occluderCount: lights.occCount,
      lampPower: lights.power as Float32Array<ArrayBuffer>,
      lampCount: 0,
      view: cam.groundRect(),
      batches: [
        { model: playerModel, data: playerInst, count: 1 },
        { model: dummyModel, data: dummyInst, count: state.dummies.length },
      ],
      alphaSprites: emptySprites,
      alphaCount: 0,
      addSprites: emptySprites,
      addCount: 0,
      grade: [state.t, 0, 0, 1],
    })
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

void main()
`,
)

writeFileSync(
  join(root, "tests/sim.test.ts"),
  `import { expect, test } from "bun:test"
import { createToyState, stepToy } from "../shared/sim"

test("dash into a dummy transfers knockback and increments hit count", () => {
  const s = createToyState()
  s.player.x = -3.8
  s.player.y = 0
  let totalHits = 0
  for (let i = 0; i < 20; i++) {
    totalHits += stepToy(s, { mx: -1, my: 0, aim: Math.PI, dash: i === 0 }, 1 / 60)
  }
  expect(totalHits).toBeGreaterThan(0)
  expect(s.dummies[0]!.hits).toBeGreaterThan(0)
})
`,
)

console.log(`Scaffolded greybox toy in ${root}`)
