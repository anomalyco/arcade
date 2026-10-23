/**
 * Woods look station (`/arcade/lab/woods.html`): the photoreal night-forest renderer (`@arcade/kit/forest`) on the
 * seeded demo level, walkable with the torch in hand and two teammates searching with theirs. Every look setting is on
 * the LabPanel (Backquote). `?view=trail|hollow|camp` picks the concept viewpoints; `?smoke` draws two frames offscreen
 * on a software GPU; `window.woods` is the automation API (step, measure, stats).
 */
import { WalkCamera } from "@arcade/kit/client/walk-camera"
import { keyPromptHtml } from "@arcade/kit/client/key-cap"
import { openGpu } from "@arcade/kit/gpu/boot"
import { LabPanel } from "@arcade/kit/lab-panel"
import type { LabControl } from "@arcade/kit/lab-navigation"
import { AdaptiveQualityController, type QualityMode } from "@arcade/kit/quality"
import { createForestView, type ForestTorch } from "@arcade/kit/forest/view"
import { FOREST_QUALITY } from "@arcade/kit/forest/settings"
import { demoForestWorld } from "@arcade/kit/sim/forest-demo"
import type { Rect } from "@arcade/kit/sim/geom"
import type { Vec3 } from "@arcade/kit/sim/forest-world"

type View = { label: string; eye: [number, number]; target: [number, number, number]; torch?: [number, number, number]; mates: { at: [number, number]; aim: [number, number, number]; sweep: number }[] }

/** Concept viewpoints (01 trail with flashlights, 02 survey in the misty hollow, 04 camp at the lake). */
const VIEWS: Record<string, View> = {
  trail: {
    label: "Trail at night (01)", eye: [-36.5, -47.5], target: [-28, 1.2, -32], torch: [-30.5, 0, -38],
    mates: [{ at: [-34.6, -41.5], aim: [-30, 0.8, -33], sweep: 0.35 }, { at: [-31.2, -38.2], aim: [-26, 1.5, -30], sweep: 0.25 }],
  },
  hollow: {
    label: "Mist in the hollow (02)", eye: [-44, -55], target: [-32, 1.5, -38],
    mates: [{ at: [-39.5, -47.5], aim: [-34, 0.5, -38], sweep: 0.2 }],
  },
  camp: {
    label: "Camp by the lake (04)", eye: [44, 30.5], target: [21, 3, 21], torch: [38.5, 0, 29.5],
    mates: [{ at: [38.6, 28.2], aim: [30, 0, 25.5], sweep: 0.15 }, { at: [34.5, 26.8], aim: [26, 0, 24], sweep: 0.15 }],
  },
}

async function main() {
  const canvas = document.querySelector<HTMLCanvasElement>("#view")!
  const hud = document.getElementById("hud")!
  hud.textContent = "Loading the woods…"
  const opened = await openGpu(canvas, "WOODS")
  if (typeof opened === "string") throw new Error(opened)
  const gpu = opened
  const query = new URLSearchParams(location.search)
  const smoke = query.has("smoke")
  const fixedTime = query.has("time") ? Number(query.get("time")) : null
  const world = demoForestWorld(7, 110)

  const qualitySettings = { quality: (query.get("quality") as QualityMode | null) ?? "auto" }
  const adaptive = new AdaptiveQualityController({ mode: smoke ? "low" : qualitySettings.quality, profiles: FOREST_QUALITY })
  const view = await createForestView(gpu, world, { assetRoot: import.meta.env.BASE_URL + "forest-assets/", quality: adaptive.getActiveTier(), smoke })

  // Colliders: trunks and buildings near the walker.
  const solids: { x: number; z: number; r: number }[] = world.trees.filter(t => t.r > 0.09).map(t => ({ x: t.x, z: t.z, r: t.r + 0.05 }))
  for (const r of world.rocks) if (r.h > 0.35) solids.push({ x: r.x, z: r.z, r: r.r * 0.85 })
  const grid = new Map<number, number[]>()
  const key = (x: number, z: number) => (Math.floor(x / 6) + 500) * 1000 + Math.floor(z / 6) + 500
  solids.forEach((s, i) => { const k = key(s.x, s.z); const l = grid.get(k); if (l) l.push(i); else grid.set(k, [i]) })
  const buildingWalls: Rect[] = (world.camp?.buildings ?? []).map(b => {
    const c = Math.abs(Math.cos(b.yaw)), s = Math.abs(Math.sin(b.yaw))
    const hx = (b.w * c + b.d * s) / 2, hz = (b.w * s + b.d * c) / 2
    return [b.x - hx * 0.8, b.z - hz * 0.8, b.x + hx * 0.8, b.z + hz * 0.8] as const
  })
  const walls: Rect[] = []
  const nearWalls = (x: number, z: number) => {
    walls.length = 0
    for (let gx = -1; gx <= 1; gx++) for (let gz = -1; gz <= 1; gz++) for (const i of grid.get(key(x + gx * 6, z + gz * 6)) ?? []) {
      const s = solids[i]!
      walls.push([s.x - s.r * 0.8, s.z - s.r * 0.8, s.x + s.r * 0.8, s.z + s.r * 0.8])
    }
    const lim = world.half - 2
    walls.push([-lim - 5, -lim - 5, -lim, lim + 5], [lim, -lim - 5, lim + 5, lim + 5], [-lim - 5, -lim - 5, lim + 5, -lim], [-lim - 5, lim, lim + 5, lim + 5], ...buildingWalls)
    return walls
  }

  const walking = { cameraMotion: 1, reduceMotion: globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false, stepLength: 0.72, walkSettle: 0.3 }
  const playing = () => !panel.visible && !document.hidden && document.pointerLockElement === canvas
  const camera = new WalkCamera(canvas, () => panel.visible, walking, playing)
  camera.near = 0.1; camera.far = 600; camera.fov = 62; camera.speed = 1.6; camera.flashlight = true
  const settings = view.settings as unknown as Record<string, number | string | boolean>
  const panel = new LabPanel(settings, view.controls(), query, () => camera.release(), { open: false, pill: false, groupActions: false })
  const qualityControls: LabControl[] = [{ key: "woods.quality", field: "quality", label: "Quality", group: "Camera", subsection: "Performance", type: "select", options: [{ value: "auto", label: "Auto" }, { value: "high", label: "High" }, { value: "balanced", label: "Balanced" }, { value: "low", label: "Low" }] }]
  panel.addControls(qualitySettings, qualityControls)
  Object.assign(window, { __arcadeHarness: { lab: panel } })

  // ---- Viewpoints and teammates.
  let current = VIEWS[query.get("view") ?? "trail"] ?? VIEWS.trail!
  const groundAt = (x: number, z: number) => world.height(x, z)
  const aimAt = (from: Vec3, to: readonly number[]): Vec3 => {
    const d = [to[0]! - from[0], to[1]! - from[1], to[2]! - from[2]], l = Math.hypot(d[0]!, d[1]!, d[2]!) || 1
    return [d[0]! / l, d[1]! / l, d[2]! / l]
  }
  const torchAim: [number, number, number] = [0, 0, -1]
  const setView = (name: string) => {
    current = VIEWS[name] ?? current
    const [x, z] = current.eye
    camera.body.x = x; camera.body.y = z
    const eyeY = groundAt(x, z) + 1.7
    const d = aimAt([x, eyeY, z], [current.target[0], groundAt(current.target[0], current.target[2]) + current.target[1], current.target[2]])
    camera.yaw = Math.atan2(-d[0], -d[2]); camera.pitch = Math.asin(d[1])
    const t = current.torch ?? current.target
    const td = aimAt([x, eyeY - 0.28, z], [t[0], groundAt(t[0], t[2]) + t[1], t[2]])
    torchAim.splice(0, 3, ...td)
    aimOverride = !!current.torch
  }
  let aimOverride = false
  setView(query.get("view") ?? "trail")
  window.addEventListener("pointerdown", () => { aimOverride = false })
  window.addEventListener("keydown", e => { if (e.code.startsWith("Key") || e.code.startsWith("Arrow")) aimOverride = false })

  const prompts = () => {
    hud.innerHTML = [document.pointerLockElement === canvas ? "" : keyPromptHtml("Mouse0", "Look"), keyPromptHtml("KeyW", "Move"), keyPromptHtml("KeyF", "Flashlight"), keyPromptHtml("Backquote", "Look settings")].join(" ")
  }
  prompts()
  document.addEventListener("pointerlockchange", prompts)

  let last = performance.now(), clock = fixedTime ?? 0, frames = 0, paused = false, stepping = false
  let smokeTarget: GPUTexture | null = null
  const lens: [number, number, number] = [0, 0, 0]
  const lagged: [number, number, number] = [0, 0, -1]
  let laggedReady = false
  const torches: ForestTorch[] = []

  function frame(now: number) {
    const q = adaptive.getProfile()
    const ratio = Math.min(devicePixelRatio, q.dprCap) * adaptive.getResolutionScale()
    const width = Math.max(1, Math.round(innerWidth * ratio)), height = Math.max(1, Math.round(innerHeight * ratio))
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; view.resize(width, height) }
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000)); last = now
    if (fixedTime === null || stepping) clock += dt
    camera.height = groundAt(camera.body.x, camera.body.y) + 1.7
    const vp = camera.update(dt, width / height, nearWalls(camera.body.x, camera.body.y))
    const s = view.settings
    // The hand trails the head; the lens sits low and to the right.
    const want = aimOverride ? torchAim : camera.direction
    const k = laggedReady ? 1 - Math.exp(-dt / Math.max(s.torchLag, 0.001)) : 1
    for (let i = 0; i < 3; i++) lagged[i] = lagged[i]! + (want[i]! - lagged[i]!) * k
    const l = Math.hypot(...lagged) || 1
    for (let i = 0; i < 3; i++) lagged[i] = lagged[i]! / l
    laggedReady = true
    const right = [Math.cos(camera.yaw), 0, -Math.sin(camera.yaw)]
    for (let i = 0; i < 3; i++) lens[i] = camera.eye[i]! + right[i]! * s.torchSide + (i === 1 ? -s.torchDrop : 0) + camera.direction[i]! * 0.25
    torches.length = 0
    torches.push({ id: 0, pos: [...lens], dir: [...lagged], on: camera.flashlight, kind: "local" })
    current.mates.forEach((m, i) => {
      const y = groundAt(m.at[0], m.at[1]) + 1.25
      const pos: Vec3 = [m.at[0], y, m.at[1]]
      const base = aimAt(pos, [m.aim[0], groundAt(m.aim[0], m.aim[2]) + m.aim[1], m.aim[2]])
      // A slow search sweep, each teammate on their own rhythm.
      const a = Math.sin(clock * (0.45 + i * 0.17) + i * 2.1) * m.sweep, b = Math.sin(clock * (0.31 + i * 0.11) + i) * m.sweep * 0.3
      const c = Math.cos(a), sn = Math.sin(a)
      const dir: Vec3 = [base[0] * c - base[2] * sn, base[1] + b, base[0] * sn + base[2] * c]
      torches.push({ id: 1 + i, pos, dir: aimAt([0, 0, 0], dir), on: true, kind: "remote" })
    })
    const fovY = camera.fov * Math.PI / 180
    view.update({ eye: [...camera.eye], viewProj: vp as Float32Array, width, height, time: clock, dt, fovY, torches })
    if (smoke) {
      if (!smokeTarget || smokeTarget.width !== width || smokeTarget.height !== height) { smokeTarget?.destroy(); smokeTarget = gpu.device.createTexture({ size: [width, height], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT }) }
      view.drawTo(smokeTarget.createView())
    } else if (stepping) view.drawTo()
    else view.draw()
    frames++
    if (smoke) performance.mark(`woods:frame-${frames - 1}-submitted`)
    if (smoke && frames >= 2) paused = true
    if (!smoke && !stepping) {
      const changed = adaptive.recordFrame(dt * 1000, view.renderer.lastGpuMs)
      if (changed) view.setQuality(adaptive.getActiveTier())
    }
  }
  let lastMode = qualitySettings.quality
  function loop(now: number) {
    if (qualitySettings.quality !== lastMode) { lastMode = qualitySettings.quality; if (adaptive.setMode(lastMode)) view.setQuality(adaptive.getActiveTier()) }
    if (paused) last = now
    else frame(now)
    requestAnimationFrame(loop)
  }
  /** Automation: one synchronous frame `ms` after the last on a synthetic clock (the caller copies the canvas in the same task). */
  const step = (ms: number) => { stepping = true; try { frame(last + ms) } finally { stepping = false } }
  Object.assign(window, {
    woods: {
      view, camera, settings: view.settings, world, adaptive, setView, step, views: Object.keys(VIEWS),
      measure: (n?: number) => view.measure(n),
      stats: () => view.stats(),
      get frames() { return frames }, get paused() { return paused }, set paused(v: boolean) { paused = v },
      set aimOverride(v: boolean) { aimOverride = v },
      ready: true,
    },
  })
  requestAnimationFrame(loop)
}

void main().catch(error => { console.error(error); document.getElementById("hud")!.textContent = String(error) })
