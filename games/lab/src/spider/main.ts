/**
 * Spider gait station (`/arcade/lab/spider.html`): the arachnid gait (`@arcade/kit/creature`) walking a slow loop
 * through the night forest under the forest look (`@arcade/kit/forest`), on the seeded demo level. Distant is Kit's
 * first sight: a still view 45–60 m off its next few seconds of path, between the trunks; Walks past stands 20–30 m
 * off, on a longer lens that holds the body and every leg; Near follows it at 20 m; Walk is free (click, WASD, F
 * torch). A friend sweeps a beam across its legs (on by default; the standing shots place the friend 8–12 m off the
 * stretch it crosses: on the camera's side for Walks past; for Distant behind it, the beam running across the view). Spider and look settings are on the LabPanel (Backquote). `?camera=distant|near|pass|walk`,
 * `?smoke` draws two frames offscreen; `window.spider` is the automation API (step, pose, stats, project, hidden).
 */
import { keyPromptHtml } from "@arcade/kit/client/key-cap"
import { WalkCamera } from "@arcade/kit/client/walk-camera"
import { ArachnidLegs, interpolateArachnidPose, type ArachnidPose } from "@arcade/kit/creature/arachnid-legs"
import { createRoute, routeIntent } from "@arcade/kit/creature/arachnid-route"
import { ArachnidView, arachnidLook } from "@arcade/kit/creature/arachnid-view"
import { forestCreatureSurface } from "@arcade/kit/creature/forest-surface"
import { arachnidControls, arachnidLegMetres, arachnidScale, arachnidShape, createArachnidSettings } from "@arcade/kit/creature/arachnid-settings"
import { FOREST_QUALITY } from "@arcade/kit/forest/settings"
import { createForestView, type ForestTorch } from "@arcade/kit/forest/view"
import { openGpu } from "@arcade/kit/gpu/boot"
import { LabPanel } from "@arcade/kit/lab-panel"
import type { LabControl } from "@arcade/kit/lab-navigation"
import { AdaptiveQualityController, type QualityMode } from "@arcade/kit/quality"
import { CREATURE_STEP, createCreatureMotion, stepCreatureMotion, unitDt, unitSurface } from "@arcade/kit/sim/creature-motion"
import { demoForestWorld } from "@arcade/kit/sim/forest-demo"
import type { Rect } from "@arcade/kit/sim/geom"

type Camera = "distant" | "near" | "pass" | "walk"
/** Where a friend searches for the free cameras (the loop's middle, 10–20 m from its path); the standing shots place their own. */
const FRIEND: [number, number] = [-30, 18]
/** The friend's sweep: metres either side of the spider, and seconds per sweep and back. */
const SWEEP = { metres: 5, period: 5 }
/** Seconds of path a standing shot (Walks past, Distant) covers. */
const PASS = { seconds: 9 }
/** The spider's slow loop through the trunks, 55–80 m from the eye. */
const LOOP: [number, number][] = Array.from({ length: 10 }, (_, i) => {
  const a = (i / 10) * Math.PI * 2
  return [-30 + Math.cos(a) * 22, 18 + Math.sin(a) * 12]
})

async function main() {
  const canvas = document.querySelector<HTMLCanvasElement>("#view")!
  const hud = document.getElementById("hud")!
  hud.textContent = "Loading the woods…"
  const opened = await openGpu(canvas, "SPIDER")
  if (typeof opened === "string") throw new Error(opened)
  const gpu = opened
  const query = new URLSearchParams(location.search)
  const smoke = query.has("smoke")
  const world = demoForestWorld(7, 110)
  const qualitySettings = { quality: (query.get("quality") as QualityMode | null) ?? "auto" }
  const adaptive = new AdaptiveQualityController({ mode: smoke ? "low" : qualitySettings.quality, profiles: FOREST_QUALITY })
  const view = await createForestView(gpu, world, { assetRoot: import.meta.env.BASE_URL + "forest-assets/", quality: adaptive.getActiveTier(), smoke })

  // ---- The spider.
  const spider = createArachnidSettings()
  const scene = { camera: ((query.get("camera") as Camera | null) ?? "distant") as Camera, walking: true, beam: true, sweep: true }
  const surface = forestCreatureSurface(world, () => 0.32 * spider.size)
  let size = arachnidScale(spider)
  let ground = unitSurface(surface, size)
  const route = createRoute(LOOP)
  const start = LOOP[0]!
  const motion = createCreatureMotion(start[0] / size, start[1] / size, Math.PI / 2)
  let legs = new ArachnidLegs(motion, ground, size, arachnidShape(spider))
  const look = () => arachnidLook(spider)
  const spiderView = new ArachnidView(view.renderer, look())
  let previous: ArachnidPose = legs.pose(), current: ArachnidPose = previous
  /** Shape changes re-stand the legs where the root is (a retrigger boundary); thickness rebuilds meshes in place. */
  const reshape = () => {
    const x = motion.x * size, z = motion.z * size
    size = arachnidScale(spider)
    ground = unitSurface(surface, size)
    motion.x = x / size; motion.z = z / size; motion.vx = motion.vz = 0
    legs = new ArachnidLegs(motion, ground, size, arachnidShape(spider))
    previous = current = legs.pose()
    spiderView.setShape(look())
  }
  let accumulator = 0, ticks = 0
  const tickSpider = () => {
    const intent = scene.walking ? routeIntent(route, motion.x * size, motion.z * size, spider.pace, "walk", 6) : { dx: 0, dz: 0, pace: "walk" as const }
    const dt = unitDt(CREATURE_STEP, size)
    stepCreatureMotion(motion, intent, dt, ground)
    legs.step(motion, ground, dt)
    previous = current
    current = legs.pose()
    ticks++
  }

  // ---- Camera, panel.
  const walking = { cameraMotion: 1, reduceMotion: globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false, stepLength: 0.72, walkSettle: 0.3 }
  const playing = () => !panel.visible && !document.hidden && document.pointerLockElement === canvas
  const camera = new WalkCamera(canvas, () => panel.visible, walking, playing)
  camera.near = 0.1; camera.far = 600; camera.fov = 62; camera.speed = 1.6; camera.flashlight = true
  const settings = view.settings as unknown as Record<string, number | string | boolean>
  const panel = new LabPanel(settings, view.controls(), query, () => camera.release(), { open: false, pill: false, groupActions: false })
  const shapeKeys = new Set(["size", "legs", "hips", "ride", "swing", "lift"])
  panel.addControls(spider as unknown as Record<string, number>, arachnidControls(spider, { change: key => (shapeKeys.has(key) ? reshape() : spiderView.setShape(look())) }))
  const sceneControls: LabControl[] = [
    { key: "spider.camera", field: "camera", label: "Camera", group: "Spider", type: "select", options: [{ value: "distant", label: "Distant (first sight)" }, { value: "near", label: "Near (judge the gait)" }, { value: "pass", label: "Walks past (25 m, standing)" }, { value: "walk", label: "Walk (free)" }], change: () => placeCamera() },
    { key: "spider.walking", field: "walking", label: "Walking", group: "Spider", type: "toggle" },
    { key: "spider.beam", field: "beam", label: "Friend's beam on it", group: "Spider", type: "toggle" },
    { key: "spider.sweep", field: "sweep", label: "Beam sweeps", group: "Spider", type: "toggle" },
  ]
  panel.addControls(scene as unknown as Record<string, number | string | boolean>, sceneControls)
  panel.addControls(qualitySettings, [{ key: "spider.quality", field: "quality", label: "Quality", group: "Camera", subsection: "Performance", type: "select", options: [{ value: "auto", label: "Auto" }, { value: "high", label: "High" }, { value: "balanced", label: "Balanced" }, { value: "low", label: "Low" }] }])
  Object.assign(window, { __arcadeHarness: { lab: panel } })

  const groundAt = (x: number, z: number) => world.height(x, z)
  const aim = (from: readonly number[], to: readonly number[]) => {
    const d = [to[0]! - from[0]!, to[1]! - from[1]!, to[2]! - from[2]!], l = Math.hypot(d[0]!, d[1]!, d[2]!) || 1
    camera.yaw = Math.atan2(-d[0]! / l, -d[2]! / l)
    camera.pitch = Math.asin(d[1]! / l)
  }
  /** The root's path over the next `seconds`, by stepping a copy of the motion and route (both deterministic). */
  const pathAhead = (seconds: number) => {
    const m = { ...motion }, r = { ...route }, path: [number, number][] = []
    const dt = unitDt(CREATURE_STEP, size)
    for (let i = 0; i <= seconds * 60; i++) {
      if (i % 15 === 0) path.push([m.x * size, m.z * size])
      stepCreatureMotion(m, routeIntent(r, m.x * size, m.z * size, spider.pace, "walk", 6), dt, ground)
    }
    return path
  }
  /**
   * Trees a sightline from eye height at (ex, ez) to `rise` m over the ground at (x, z) passes through: trunks, and
   * crowns roughly as the forest builds them (spruce cones from a third of their height, saplings from the ground;
   * 70% of the radius, for the gaps between whorls).
   */
  const blocked = (ex: number, ez: number, x: number, z: number, rise = 4) => {
    const ey = groundAt(ex, ez) + 1.7, ty = groundAt(x, z) + rise
    const dx = x - ex, dz = z - ez, l2 = dx * dx + dz * dz || 1
    let n = 0
    for (const t of world.trees) {
      const u = Math.max(0, Math.min(1, ((t.x - ex) * dx + (t.z - ez) * dz) / l2))
      if (u < 0.01 || u > 0.99) continue
      const d = Math.hypot(ex + dx * u - t.x, ez + dz * u - t.z)
      if (d > 4) continue
      const y = ey + (ty - ey) * u - groundAt(t.x, t.z)
      if (y > t.h) continue
      if (d < t.r + 0.2) { n++; continue }
      const sapling = t.h < 6
      const start = sapling ? 0.06 : t.species === "pine" ? 0.6 : t.species === "spruce" ? 0.35 : 0.47
      const radius = sapling ? t.h * 0.3 : t.species === "pine" ? 3.9 : t.species === "spruce" ? 2.6 : 2.2
      const f = (y / t.h - start) / (1 - start)
      if (f >= 0 && d < 0.7 * (t.species === "spruce" || sapling ? radius * (1 - f) : radius)) n++
    }
    return n
  }
  /**
   * A standing shot of its next `seconds` of path: of the spots `distances` m off it, the one with the fewest trees
   * between it and the body and both ends of its leg span, chosen on entering the camera and again (a cut) once it has
   * walked that stretch. The friend stands either 8–12 m off the stretch on the camera's side, lighting the legs'
   * near side ("side"), or behind where the stretch starts, a little beyond it, so the beam runs along its path and
   * across the camera's view, never toward it, while it walks away from the friend ("behind").
   */
  let shotKind: "pass" | "distant" | null = null
  type Shot = { eye: [number, number]; mid: [number, number]; friend: [number, number]; until: number }
  let shot: Shot | null = null
  const chooseShot = (distances: readonly number[], along: readonly number[], seconds: number, friendAt: "side" | "behind"): Shot => {
    const path = pathAhead(seconds)
    const a = path[0]!, b = path[path.length - 1]!, mid = path[Math.floor(path.length / 2)]!
    const fl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, f = [(b[0] - a[0]) / fl, (b[1] - a[1]) / fl]
    const reach = arachnidLegMetres(spider) * 0.7
    const at = (sideSign: number, d: number, o: number): [number, number] => [mid[0] + f[0]! * o - f[1]! * d * sideSign, mid[1] + f[1]! * o + f[0]! * d * sideSign]
    let best = { eye: at(1, distances[0]!, 0), sideSign: 1 }, bestScore = Infinity
    for (const sideSign of [1, -1]) for (const d of distances) for (const o of along) {
      const [ex, ez] = at(sideSign, d, o)
      if (surface.walkable?.(ex, ez) === false) continue
      let score = Math.abs(d - distances[0]!) * 0.05 + Math.abs(o) * 0.02
      for (const [x, z] of path) score += blocked(ex, ez, x, z) * 2 + blocked(ex, ez, x + f[0]! * reach, z + f[1]! * reach, 2) + blocked(ex, ez, x - f[0]! * reach, z - f[1]! * reach, 2)
      if (score < bestScore) { bestScore = score; best = { eye: [ex, ez], sideSign } }
    }
    let friend: [number, number] = FRIEND
    const half = fl / 2
    const spots = friendAt === "side"
      ? [[10, 7], [8, 7], [12, 7], [10, -7], [10, 10], [8, -7]].map(([d, o]) => at(best.sideSign, d!, o!))
      : [[3, 8], [5, 8], [3, 11], [1, 8], [5, 12]].map(([d, o]) => at(-best.sideSign, d!, -half - o!))
    for (const p of spots) {
      if (surface.walkable?.(p[0], p[1]) !== false) { friend = p; break }
    }
    return { eye: best.eye, mid, friend, until: ticks + seconds * 60 }
  }
  /**
   * Walks past stands 20–30 m off and pans to follow on a lens that holds the leg span; Distant stands 45–60 m off,
   * still, on the game's lens, looking at the stretch it is about to cross; Near rides 20 m off its flank.
   */
  const placeCamera = () => {
    const kind = scene.camera === "pass" || scene.camera === "distant" ? scene.camera : null
    if (!kind) shot = null
    camera.fov = 62
    if (scene.camera === "walk") return
    const body = current.body
    if (kind && (!shot || shotKind !== kind || ticks > shot.until)) {
      shot = kind === "pass" ? chooseShot([25, 22.5, 27.5, 20, 30], [0, -3, 3, -6, 6], PASS.seconds, "side") : chooseShot([50, 45, 55, 60, 40], [0, -6, 6, -12, 12, -18, 18], PASS.seconds, "behind")
      shotKind = kind
    }
    if (shot) {
      camera.body.x = shot.eye[0]; camera.body.y = shot.eye[1]
      const eye = [shot.eye[0], groundAt(shot.eye[0], shot.eye[1]) + 1.7, shot.eye[1]]
      if (kind === "distant") {
        aim(eye, [shot.mid[0], groundAt(shot.mid[0], shot.mid[1]) + 4, shot.mid[1]])
        return
      }
      const g = groundAt(body[0], body[2])
      aim(eye, [body[0], g + (body[1] - g) * 0.8, body[2]])
      // A lens long enough that the leg span (with a margin) fills about three quarters of the width.
      const distance = Math.hypot(body[0] - eye[0]!, body[2] - eye[2]!)
      const half = Math.atan((arachnidLegMetres(spider) * 1.25) / Math.max(8, distance))
      const aspect = canvas.width / Math.max(1, canvas.height)
      camera.fov = Math.min(62, Math.max(24, (2 * Math.atan(Math.tan(half) / aspect) * 180) / Math.PI))
    } else {
      const side = [Math.sin(current.heading), Math.cos(current.heading)]
      const x = body[0] + side[0]! * 20, z = body[2] + side[1]! * 20
      camera.body.x = x; camera.body.y = z
      aim([x, groundAt(x, z) + 1.7, z], [body[0], body[1] - 1.5, body[2]])
    }
  }
  placeCamera()

  const prompts = () => {
    hud.innerHTML = [scene.camera === "walk" && document.pointerLockElement !== canvas ? keyPromptHtml("Mouse0", "Look") : "", scene.camera === "walk" ? keyPromptHtml("KeyW", "Move") : "", keyPromptHtml("KeyF", "Torch"), keyPromptHtml("Backquote", "Spider settings")].join(" ")
  }
  prompts()
  document.addEventListener("pointerlockchange", prompts)
  canvas.addEventListener("click", () => { if (scene.camera !== "walk") { scene.camera = "walk"; panel.refresh(); prompts() } })

  let last = performance.now(), clock = 0, frames = 0, paused = false, stepping = false, hidden = false
  const lastVp = new Float32Array(16)
  let drawn: ArachnidPose = current
  let smokeTarget: GPUTexture | null = null
  const torches: ForestTorch[] = []
  const lens: [number, number, number] = [0, 0, 0]

  function frame(now: number) {
    const q = adaptive.getProfile()
    const ratio = Math.min(devicePixelRatio, q.dprCap) * adaptive.getResolutionScale()
    const width = Math.max(1, Math.round(innerWidth * ratio)), height = Math.max(1, Math.round(innerHeight * ratio))
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; view.resize(width, height) }
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000)); last = now
    clock += dt
    // The gait at a fixed 60 Hz; the drawn pose blends the last two ticks.
    accumulator += dt
    while (accumulator >= CREATURE_STEP) { tickSpider(); accumulator -= CREATURE_STEP }
    const pose = interpolateArachnidPose(previous, current, accumulator / CREATURE_STEP)
    placeCamera()
    camera.height = groundAt(camera.body.x, camera.body.y) + 1.7
    const vp = camera.update(dt, width / height, [] as Rect[])
    const s = view.settings
    const right = [Math.cos(camera.yaw), 0, -Math.sin(camera.yaw)]
    for (let i = 0; i < 3; i++) lens[i] = camera.eye[i]! + right[i]! * s.torchSide + (i === 1 ? -s.torchDrop : 0) + camera.direction[i]! * 0.25
    torches.length = 0
    torches.push({ id: 0, pos: [...lens], dir: [...camera.direction], on: camera.flashlight, kind: "local" })
    // A friend inside the loop, searching: the beam sweeps side to side across its legs (concept 1, legs through the
    // beam), or holds on them with the sweep off.
    const friend = shot?.friend ?? FRIEND
    const fy = groundAt(friend[0], friend[1]) + 1.3
    const toward = [pose.body[0] - friend[0], pose.body[2] - friend[1]], tl = Math.hypot(toward[0]!, toward[1]!) || 1
    const swing = scene.sweep ? Math.sin((clock / SWEEP.period) * Math.PI * 2) * SWEEP.metres : 0
    const tx = pose.body[0] - (toward[1]! / tl) * swing, tz = pose.body[2] + (toward[0]! / tl) * swing
    const target = [tx, groundAt(pose.body[0], pose.body[2]) + 2.2, tz]
    const d = [target[0]! - friend[0], target[1]! - fy, target[2]! - friend[1]], dl = Math.hypot(d[0]!, d[1]!, d[2]!) || 1
    torches.push({ id: 1, pos: [friend[0], fy, friend[1]], dir: [d[0]! / dl, d[1]! / dl, d[2]! / dl], on: scene.beam, kind: "remote" })
    view.update({ eye: [...camera.eye], viewProj: vp as Float32Array, width, height, time: clock, dt, fovY: (camera.fov * Math.PI) / 180, torches, batches: hidden ? [] : spiderView.frame([pose]) })
    lastVp.set(vp as Float32Array); drawn = pose
    if (smoke) {
      if (!smokeTarget || smokeTarget.width !== width || smokeTarget.height !== height) { smokeTarget?.destroy(); smokeTarget = gpu.device.createTexture({ size: [width, height], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT }) }
      view.drawTo(smokeTarget.createView())
    } else if (stepping) view.drawTo()
    else view.draw()
    frames++
    if (smoke && frames >= 2) paused = true
    if (!smoke && !stepping && adaptive.recordFrame(dt * 1000, view.renderer.lastGpuMs)) view.setQuality(adaptive.getActiveTier())
  }
  let lastMode = qualitySettings.quality
  function loop(now: number) {
    if (qualitySettings.quality !== lastMode) { lastMode = qualitySettings.quality; if (adaptive.setMode(lastMode)) view.setQuality(adaptive.getActiveTier()) }
    if (paused) last = now
    else frame(now)
    requestAnimationFrame(loop)
  }
  /** Automation: one synchronous frame `ms` after the last on a synthetic clock (copy the canvas in the same task). */
  const step = (ms: number) => { stepping = true; try { frame(last + ms) } finally { stepping = false } }
  /** Automation: advance the gait `seconds` without drawing. */
  const advance = (seconds: number) => { for (let i = 0; i < Math.round(seconds * 60); i++) tickSpider() }
  /** Automation: the drawn pose's joints and body in canvas pixels from the last frame (x right, y down, behind = null). */
  const project = () => {
    const m = lastVp, w = canvas.width, h = canvas.height
    const toPixel = (p: readonly number[]) => {
      const cx = m[0]! * p[0]! + m[4]! * p[1]! + m[8]! * p[2]! + m[12]!, cy = m[1]! * p[0]! + m[5]! * p[1]! + m[9]! * p[2]! + m[13]!
      const cw = m[3]! * p[0]! + m[7]! * p[1]! + m[11]! * p[2]! + m[15]!
      return cw > 0 ? [((cx / cw) * 0.5 + 0.5) * w, (0.5 - (cy / cw) * 0.5) * h] : null
    }
    return { width: w, height: h, body: toPixel(drawn.body), joints: drawn.legs.flatMap(l => l.joints.map(toPixel)) }
  }
  Object.assign(window, {
    spider: {
      view, camera, settings: spider, scene, world, step, advance, reshape, project,
      get hidden() { return hidden }, set hidden(v: boolean) { hidden = v },
      pose: () => current,
      stats: () => ({ ...view.stats(), ticks, supports: legs.supports, distance: Math.hypot(current.body[0] - camera.eye[0]!, current.body[2] - camera.eye[2]!) }),
      measure: (n?: number) => view.measure(n),
      get frames() { return frames }, get paused() { return paused }, set paused(v: boolean) { paused = v },
      ready: true,
    },
  })
  requestAnimationFrame(loop)
}

void main().catch(error => { console.error(error); document.getElementById("hud")!.textContent = String(error) })
