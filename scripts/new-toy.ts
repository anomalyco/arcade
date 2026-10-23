// Scaffolds a minimal low-res greybox toy prototype on @arcade/kit
// (cheap presentation, shared feel on by default):
//   bun scripts/new-toy.ts <name> [--out <dir>]
// See docs/prototyping.md for the toy-first workflow and graduation gate.
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"

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
const scriptsRel = relative(root, join(repo, "scripts")).replace(/\\/g, "/")

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
        typecheck: `bun ${scriptsRel}/typecheck.ts`,
        check: "bun run typecheck && bun test && vite build",
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
        types: ["@webgpu/types", "bun", "vite/client"],
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
import { audioAssets, TOY_SFX } from "${scriptsRel}/audio-assets"
import { textureAssets } from "${scriptsRel}/texture-assets"

export default defineConfig({
  plugins: [audioAssets({ sfx: TOY_SFX }), textureAssets()],
  base: "/arcade/${name}/",
  build: {
    outDir: "dist/arcade/${name}",
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    fs: { allow: ["${relative(root, repo).replace(/\\/g, "/") || "."}"] },
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
      #hud { position: fixed; top: 12px; left: 14px; pointer-events: none; font-size: 13px; display: flex; gap: 12px; align-items: center; opacity: 0.9; }
    </style>
  </head>
  <body>
    <canvas id="view"></canvas>
    <div id="hud"></div>
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

export type ViewStyle = "top-down" | "iso" | "side"
export type ActorMeshMode = "rig" | "primitives"

export const FEEL = {
  viewStyle: "top-down" as ViewStyle,
  actorMesh: "rig" as ActorMeshMode,
  moveSpeed: 7.5,
  accel: 22,
  dashImpulse: 16,
  dashCooldown: 0.45,
  knockback: 13,
  hitStopMs: 55,
  shake: 0.45,
  botSpeed: 3.4,
  botAggro: 0.65,
}
export type FeelConfig = typeof FEEL

export const FEEL_CONTROLS: LabControl[] = [
  {
    key: "viewStyle",
    label: "Camera style",
    group: "Style",
    type: "select",
    options: [
      { value: "top-down", label: "Top-down" },
      { value: "iso", label: "Isometric" },
      { value: "side", label: "Side-view (2.5D)" },
    ],
  },
  {
    key: "actorMesh",
    label: "Actor models",
    group: "Style",
    type: "select",
    options: [
      { value: "rig", label: "Shared human rig" },
      { value: "primitives", label: "Capsule & cube primitives" },
    ],
  },
  { key: "moveSpeed", label: "Move speed", group: "Feel", min: 3, max: 14, step: 0.25, unit: "m/s" },
  { key: "accel", label: "Acceleration", group: "Feel", min: 6, max: 45, step: 1, unit: "/s" },
  { key: "dashImpulse", label: "Dash impulse", group: "Feel", min: 6, max: 28, step: 0.5, unit: "m/s" },
  { key: "dashCooldown", label: "Dash cooldown", group: "Feel", min: 0.15, max: 1.2, step: 0.05, unit: "s" },
  { key: "knockback", label: "Hit knockback", group: "Feel", min: 4, max: 25, step: 0.5, unit: "m/s" },
  { key: "hitStopMs", label: "Hit-stop", group: "Feel", min: 0, max: 120, step: 5, unit: "ms" },
  { key: "shake", label: "Impact shake", group: "Feel", min: 0, max: 1, step: 0.05 },
  { key: "botSpeed", label: "Bot speed", group: "Bots", min: 0, max: 9, step: 0.25, unit: "m/s" },
  { key: "botAggro", label: "Bot chase bias", group: "Bots", min: 0, max: 1, step: 0.05 },
]

export type Bot = {
  id: number
  x: number
  y: number
  vx: number
  vy: number
  aim: number
  hp: number
  maxHp: number
  flash: number
  hits: number
  strafeSign: 1 | -1
}

export type ToyEvent =
  | { kind: "dash"; x: number; y: number; aim: number }
  | { kind: "hit"; botId: number; x: number; y: number; nx: number; ny: number; ko: boolean }

export type ToyState = {
  t: number
  player: { x: number; y: number; vx: number; vy: number; aim: number; cooldown: number; dashing: number }
  bots: Bot[]
  events: ToyEvent[]
}

export type ToyInput = { mx: number; my: number; aim: number; dash: boolean }

export function createToyState(): ToyState {
  return {
    t: 0,
    player: { x: 0, y: 0, vx: 0, vy: 0, aim: 0, cooldown: 0, dashing: 0 },
    bots: [
      { id: 1, x: -5, y: 0, vx: 0, vy: 0, aim: 0, hp: 3, maxHp: 3, flash: 0, hits: 0, strafeSign: 1 },
      { id: 2, x: 5, y: 0, vx: 0, vy: 0, aim: Math.PI, hp: 3, maxHp: 3, flash: 0, hits: 0, strafeSign: -1 },
      { id: 3, x: 0, y: -5, vx: 0, vy: 0, aim: Math.PI / 2, hp: 3, maxHp: 3, flash: 0, hits: 0, strafeSign: 1 },
    ],
    events: [],
  }
}

export function stepToy(state: ToyState, input: ToyInput, dt: number, feel: Readonly<FeelConfig> = FEEL): number {
  state.t += dt
  state.events.length = 0
  const p = state.player
  p.aim = input.aim
  p.cooldown = Math.max(0, p.cooldown - dt)
  p.dashing = Math.max(0, p.dashing - dt)
  if (input.dash && p.cooldown <= 0) {
    p.vx += Math.cos(p.aim) * feel.dashImpulse
    p.vy += Math.sin(p.aim) * feel.dashImpulse
    p.cooldown = feel.dashCooldown
    p.dashing = 0.18
    state.events.push({ kind: "dash", x: p.x, y: p.y, aim: p.aim })
  }
  stepBody(p, input.mx, input.my, feel.moveSpeed, WALLS, dt, 0.45, feel.accel)

  let hits = 0
  for (const b of state.bots) {
    b.flash = Math.max(0, b.flash - dt * 5)
    const toPx = p.x - b.x
    const toPy = p.y - b.y
    const distToP = Math.hypot(toPx, toPy) || 1
    const ux = toPx / distToP
    const uy = toPy / distToP
    b.aim = Math.atan2(toPy, toPx)
    // Simple steering bot: blends orbit strafe with direct pursuit when botSpeed > 0.
    const wantChase = distToP > 2.4 ? feel.botAggro : -0.35
    const strafe = 1 - Math.abs(wantChase)
    const bmx = b.flash > 0.2 ? 0 : ux * wantChase + -uy * b.strafeSign * strafe
    const bmy = b.flash > 0.2 ? 0 : uy * wantChase + ux * b.strafeSign * strafe
    stepBody(b, bmx, bmy, feel.botSpeed, WALLS, dt, 0.48, 10)

    const dx = b.x - p.x
    const dy = b.y - p.y
    const dist = Math.hypot(dx, dy)
    if (dist < 1.05 && dist > 1e-4) {
      const nx = dx / dist
      const ny = dy / dist
      const overlap = 1.05 - dist
      b.x += nx * overlap * 0.6
      b.y += ny * overlap * 0.6
      p.x -= nx * overlap * 0.4
      p.y -= ny * overlap * 0.4
      if (p.dashing > 0) {
        b.vx = nx * feel.knockback
        b.vy = ny * feel.knockback
        b.flash = 1
        b.hits++
        b.hp--
        const ko = b.hp <= 0
        if (ko) {
          b.hp = b.maxHp
          b.strafeSign = b.strafeSign === 1 ? -1 : 1
        }
        p.dashing = 0
        hits++
        state.events.push({ kind: "hit", botId: b.id, x: b.x, y: b.y, nx, ny, ko })
      }
    }
  }
  return hits
}
`,
)

writeFileSync(
  join(root, "src/main.ts"),
  `import { SoundBank, TOY_SFX } from "@arcade/kit/audio"
import { animate, type Avatar, EV, hit as flinch, newAvatar, pose, swing } from "@arcade/kit/avatar/anim"
import { registerPersonModels } from "@arcade/kit/avatar/soldier"
import { Camera, cameraShakeControls, cameraShakeDefaults, HitStop } from "@arcade/kit/client/camera"
import { Input } from "@arcade/kit/client/input"
import { keyPromptHtml } from "@arcade/kit/client/key-cap"
import { GameQuality } from "@arcade/kit/client/quality"
import { attachLabPanelControl } from "@arcade/kit/dev-control"
import { EXPLOSION_PRESETS, explosionFlashLight, spawnExplosion } from "@arcade/kit/fx/explosion"
import { Particles, type ParticleSpec } from "@arcade/kit/fx/particles"
import { SkidMarks } from "@arcade/kit/fx/skids"
import { openGpu } from "@arcade/kit/gpu/boot"
import { FrameParts, SPRITE } from "@arcade/kit/gpu/frame-parts"
import { createLookSettings } from "@arcade/kit/gpu/look"
import { MAT, Mesh, packVerts } from "@arcade/kit/gpu/mesh"
import { Renderer } from "@arcade/kit/gpu/renderer"
import { flatLighting, newSceneFrame, packSceneFrame, type SceneLight, SceneLights } from "@arcade/kit/gpu/scene-frame"
import { GpuPerf } from "@arcade/kit/gpu-perf"
import { LabPanel } from "@arcade/kit/lab-panel"
import { QUALITY_PROFILES } from "@arcade/kit/quality"
import { mulberry32 } from "@arcade/kit/sim/rng"
import { ARENA_HALF, createToyState, FEEL, FEEL_CONTROLS, PILLARS, stepToy } from "../shared/sim"

const SPARK: ParticleSpec = { kind: "spark", life: 0.32, size: 0.06, growth: 0, gravity: 9, drag: 2.4, bounce: 0.35, r: 4, g: 2.8, b: 1.4, alpha: 1 }
const SMOKE: ParticleSpec = { kind: "soft", life: 0.65, size: 0.28, growth: 1.4, gravity: -0.5, drag: 3, bounce: 0, r: 0.85, g: 0.88, b: 0.94, alpha: 0.45 }

async function main() {
  const canvas = document.getElementById("view") as HTMLCanvasElement
  const hud = document.getElementById("hud")!
  hud.innerHTML = [
    keyPromptHtml("KeyW", "Move"),
    keyPromptHtml("Mouse0", "Dash-slam"),
    keyPromptHtml("KeyM", "Mute"),
    keyPromptHtml("Backquote", "Feel knobs"),
  ].join(" ")

  const gpu = await openGpu(canvas, "${title}")
  if (typeof gpu === "string") {
    hud.textContent = gpu
    return
  }
  const perf = new GpuPerf(gpu.device)
  const renderer = new Renderer(gpu.device, gpu.context, gpu.format)
  renderer.setLook(createLookSettings())
  const params = new URLSearchParams(location.search)
  const quality = new GameQuality({
    game: "${name}",
    tiers: QUALITY_PROFILES,
    params,
    gpuMs: () => perf.gpuMs ?? renderer.lastGpuMs,
    onChange: (tier) => renderer.setBloomLevels(tier.bloomLevels),
  }).expose()
  renderer.setBloomLevels(quality.profile.bloomLevels)

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

  // Shared human rig + primitive test models (capsule, cube, triangle prism).
  const humanParts = registerPersonModels((m) => renderer.addModel(m))
  const capsuleMesh = new Mesh()
  capsuleMesh.prism(0, 0, 0.4, 0.4, 0, 1.35, 14, [1, 1, 1], MAT.actor)
  capsuleMesh.prism(0.32, 0, 0.16, 0.02, 0.85, 1.1, 3, [0.95, 0.98, 1], MAT.glow, 0.8)
  const capsuleModel = renderer.addModel(capsuleMesh)
  const cubeMesh = new Mesh()
  cubeMesh.box(-0.42, 0, -0.42, 0.42, 1.25, 0.42, [1, 1, 1], MAT.actor)
  const cubeModel = renderer.addModel(cubeMesh)

  const state = createToyState()
  const playerAvatar = newAvatar("player", 0, 0, 0, "rifle")
  playerAvatar.unarmed = true
  const botAvatars = new Map<number, Avatar>(
    state.bots.map((b) => {
      const a = newAvatar(\`bot-\${b.id}\`, b.x, b.y, b.aim, "rifle")
      a.unarmed = true
      return [b.id, a]
    }),
  )

  const sound = new SoundBank("${name}", TOY_SFX)
  const particles = new Particles()
  const skids = new SkidMarks(1024)
  const booms: { x: number; y: number; t0: number }[] = []
  const rand = mulberry32(42)
  const fp = new FrameParts()

  const input = new Input(canvas)
  input.enabled = true
  const shakeSettings = cameraShakeDefaults()
  const cam = new Camera(shakeSettings)
  cam.snap(0, 0)
  const hitStop = new HitStop()
  const lights = new SceneLights()
  lights.setBoxes(PILLARS.map((rect) => ({ rect, h: 1.8 })))
  const sceneFrame = newSceneFrame()

  const labSettings = Object.assign(FEEL, shakeSettings)
  const panel = new LabPanel(labSettings, [...FEEL_CONTROLS, ...cameraShakeControls], params, () => {
    input.release()
    Object.assign(shakeSettings, labSettings)
  })
  quality.addTo(panel)
  sound.bindControls(panel)
  attachLabPanelControl(panel)

  input.onKey = (code) => {
    if (code === "Backquote") panel.toggle()
    if (code === "KeyM") sound.toggleMute()
  }
  const resize = () => {
    if (quality.fit(canvas, innerWidth, innerHeight)) renderer.resize(canvas.width, canvas.height)
  }
  resize()
  addEventListener("resize", resize)

  let last = performance.now()
  let acc = 0
  const DT = 1 / 60

  const frame = (now: number) => {
    quality.frame(now)
    resize()
    const elapsed = Math.min(0.1, (now - last) / 1000)
    last = now
    const scaledDt = hitStop.step(elapsed)
    acc += scaledDt
    const aspect = innerWidth / Math.max(1, innerHeight)

    while (acc >= DT) {
      acc -= DT
      const prevPx = state.player.x
      const prevPy = state.player.y
      const cursor = cam.unproject(input.mouse.x, input.mouse.y, innerWidth, innerHeight, 0)
      const heading = Math.atan2(cursor.y - state.player.y, cursor.x - state.player.x)
      const { mx, my } = input.move()
      stepToy(state, { mx, my, aim: heading, dash: input.takeFirePress() }, DT, FEEL)

      if (state.player.dashing > 0) {
        skids.skidSegment(prevPx, prevPy, state.player.x, state.player.y, 0.75)
        particles.spawn(SMOKE, prevPx, 0.15, prevPy, (rand() - 0.5) * 1.2, 0.6, (rand() - 0.5) * 1.2, rand() * 50)
      }
      for (const b of state.bots) {
        if (Math.hypot(b.vx, b.vy) > 6) skids.skidSegment(b.x - b.vx * DT, b.y - b.vy * DT, b.x, b.y, 0.65)
      }

      for (const ev of state.events) {
        if (ev.kind === "dash") {
          swing(playerAvatar, state.t)
          sound.play("melee.swing.heavy", ev.x, ev.y)
        } else if (ev.kind === "hit") {
          const hitDir = Math.atan2(ev.ny, ev.nx)
          hitStop.trigger(FEEL.hitStopMs / 1000)
          cam.add(FEEL.shake, hitDir)
          const botAv = botAvatars.get(ev.botId)
          if (botAv) flinch(botAv, ev.nx, ev.ny, 1.3)
          for (let i = 0; i < 14; i++) {
            const a = hitDir + (rand() - 0.5) * 1.3
            const sp = 4 + rand() * 8
            particles.spawn(SPARK, ev.x, 0.8, ev.y, Math.cos(a) * sp, 2 + rand() * 4, Math.sin(a) * sp, rand() * 100)
          }
          if (ev.ko) {
            spawnExplosion(particles, null, ev.x, 0, ev.y, EXPLOSION_PRESETS.propane.settings, rand, 0.45)
            booms.push({ x: ev.x, y: ev.y, t0: state.t })
            sound.play("impact_crash_layered", ev.x, ev.y, { intensity: 0.7 })
          } else {
            sound.play("melee.hit.metal", ev.x, ev.y)
            sound.play("body.hurt", ev.x, ev.y, { gain: 0.6 })
          }
        }
      }
    }

    particles.update(scaledDt, [], () => 0)
    skids.update(scaledDt)
    sound.listen(state.player.x, state.player.y)

    cam.pitch = FEEL.viewStyle === "side" ? 0.32 : FEEL.viewStyle === "iso" ? 0.72 : 1.18
    cam.dist = FEEL.viewStyle === "side" ? 30 : FEEL.viewStyle === "iso" ? 28 : 24
    cam.follow(state.player.x, state.player.y, 0, 0, elapsed, false)
    const vp = cam.update(aspect) as Float32Array
    const eye = cam.eye
    const viewRect = cam.groundRect()

    fp.begin()
    const pColor: readonly [number, number, number] = [0.25, 0.82, 0.98]
    const pCues = animate(playerAvatar, scaledDt, state.t, state.player.x, state.player.y, state.player.vx, state.player.vy, state.player.aim)
    if (pCues & EV.step) sound.play("foot.concrete.run", state.player.x, state.player.y, { gain: 0.35 })
    playerAvatar.flash = state.player.dashing > 0 ? 0.55 : 0
    if (FEEL.actorMesh === "rig") {
      pose(fp.push, playerAvatar, pColor, humanParts)
    } else {
      fp.push(capsuleModel, state.player.x, 0, state.player.y, state.player.aim, pColor, 0, 0, playerAvatar.flash)
    }
    fp.sprite(false, state.player.x, 0.03, state.player.y, 0.55, 0.2, 0.75, 0.95, 0.45, SPRITE.ring)

    for (const b of state.bots) {
      const bColor: readonly [number, number, number] = [0.95, 0.36, 0.3]
      const botAv = botAvatars.get(b.id)!
      animate(botAv, scaledDt, state.t, b.x, b.y, b.vx, b.vy, b.aim)
      botAv.flash = b.flash
      if (FEEL.actorMesh === "rig") {
        pose(fp.push, botAv, bColor, humanParts)
      } else {
        fp.push(cubeModel, b.x, 0, b.y, b.aim, bColor, 0, 0, b.flash)
      }
      fp.sprite(false, b.x, 0.03, b.y, 0.52, 0.95, 0.3, 0.25, 0.38, SPRITE.disc)
    }

    const activeLights: SceneLight[] = [
      { x: state.player.x, y: state.player.y, h: 2.6, r: 14, color: [0.65, 0.88, 1.0], power: 1.15 },
    ]
    for (let i = booms.length - 1; i >= 0; i--) {
      const bm = booms[i]!
      const age = state.t - bm.t0
      if (age > 1.2) {
        booms.splice(i, 1)
        continue
      }
      const fl = explosionFlashLight(bm.x, 0, bm.y, age, EXPLOSION_PRESETS.propane.settings)
      if (fl) activeLights.push({ x: fl.x, y: fl.z, h: fl.y, r: fl.radius, color: [fl.r, fl.g, fl.b], power: fl.power * 0.5 })
    }

    lights.update(activeLights, [{ x: state.player.x, y: state.player.y }, ...state.bots])
    packSceneFrame(sceneFrame, {
      viewProj: vp,
      eye,
      time: state.t,
      width: renderer.width,
      height: renderer.height,
      lightCount: lights.lightCount,
      ambient: [0.16, 0.18, 0.24, 0],
      mapSize: [ARENA_HALF * 2, ARENA_HALF * 2],
      ao: 0.4,
    })

    renderer.render({
      frame: sceneFrame as Float32Array<ArrayBuffer>,
      fxParticles: particles,
      skids,
      skidsVisible: true,
      lights: lights.lights as Float32Array<ArrayBuffer>,
      lightCount: lights.lightCount,
      shadowLightCount: lights.shadowLightCount,
      occluders: lights.occ as Float32Array<ArrayBuffer>,
      occluderCount: lights.occCount,
      lampPower: lights.power as Float32Array<ArrayBuffer>,
      lampCount: 0,
      view: viewRect,
      batches: fp.batches(),
      alphaSprites: fp.alpha as Float32Array<ArrayBuffer>,
      alphaCount: fp.nAlpha,
      addSprites: fp.add as Float32Array<ArrayBuffer>,
      addCount: fp.nAdd,
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

test("dash into a bot transfers knockback, emits hit event, and increments hit count", () => {
  const s = createToyState()
  s.player.x = -3.8
  s.player.y = 0
  let totalHits = 0
  for (let i = 0; i < 20; i++) {
    totalHits += stepToy(s, { mx: -1, my: 0, aim: Math.PI, dash: i === 0 }, 1 / 60)
  }
  expect(totalHits).toBeGreaterThan(0)
  expect(s.bots[0]!.hits).toBeGreaterThan(0)
})
`,
)

console.log(`Scaffolded greybox toy in ${root}`)
