// The realistic night forest for TIMBER: the kit forest renderer fed from the sim's trees, felled trees posed over
// their hinge with a lagging, whipping crown, the fresh wood the cut leaves, and the lights for this frame.
import { flareFogLamp, flareSceneLight, type FlareLight } from "@arcade/kit/fx/flare"
import type { Particles } from "@arcade/kit/fx/particles"
import type { ForestTreePose } from "@arcade/kit/forest/posed"
import { createForestView, type ForestGlow, type ForestTorch, type ForestView } from "@arcade/kit/forest/view"
import type { FogLamp } from "@arcade/kit/gpu/fog-scatter"
import type { FrameParts } from "@arcade/kit/gpu/frame-parts"
import { MAT, Mesh, type Rgb } from "@arcade/kit/gpu/mesh"
import type { SceneLight } from "@arcade/kit/gpu/scene-frame"
import type { QualityTier } from "@arcade/kit/quality"
import { mulberry, smoothNoise } from "@arcade/kit/sim/forest-demo"
import type { ForestClearing, ForestLog, ForestRock, ForestTree, ForestWorld } from "@arcade/kit/sim/forest-world"
import type { Rect } from "@arcade/kit/sim/geom"
import { ARENA_HALF, type FeelConfig, type World } from "../shared/sim"
import { HINGE, predictedFall, standingLean, type Tree } from "../shared/trees"
import type { LookConfig } from "./look"

/** Bark radius drawn over the sim's trunk radius (the sim keeps its own for collisions and the kerf). */
const TRUNK_SCALE = 1.2
/** Mean bark radius at the cut over the drawn breast-height radius, until the posed tree reports its own. */
const CUT_FLARE = 1.15
/** Kerf depths modelled (the back cut growing in from behind). */
const KERF_STEPS = 6
const FRESH: Rgb = [0.6, 0.45, 0.27]
const LATE: Rgb = [0.44, 0.31, 0.17]
const HEART: Rgb = [0.52, 0.36, 0.2]
const BARK_EDGE: Rgb = [0.16, 0.1, 0.06]
const DUST: Rgb = [0.56, 0.44, 0.28]

const hash01 = (x: number, y: number, s: number) => {
  let h = (Math.imul(Math.round(x * 100), 374761393) + Math.imul(Math.round(y * 100), 668265263) + Math.imul(s, 982451653)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Flat inside the arena, rising gently into rolling ground past its edge. */
export function groundHeight(seed: number, x: number, z: number): number {
  const d = Math.max(Math.abs(x), Math.abs(z)) - (ARENA_HALF + 1.5)
  if (d <= 0) return 0
  const k = smooth(0, 14, d)
  return k * (d * 0.09 + 1.4 * (smoothNoise(seed + 3, x / 19, z / 19) * 0.5 + 0.5) + 0.5 * (smoothNoise(seed + 4, x / 7, z / 7) * 0.5 + 0.5))
}

/** The sim's trees as the forest's: mostly spruce, some pine, the cut height added to the hinge-to-tip length. */
export function forestTree(t: Tree): ForestTree {
  const species = hash01(t.x, t.y, 11) < 0.22 ? "pine" : "spruce"
  return { x: t.x, z: t.y, species, r: t.r * TRUNK_SCALE, h: t.h + HINGE, seed: Math.floor(hash01(t.x, t.y, 7) * 2147483647) }
}

export function toForestWorld(w: World): ForestWorld {
  const seed = w.seed >>> 0
  const rand = mulberry(seed + 5)
  // Deadfall lines the edge (a boundary you read without a wall), with a few rocks out in the trees.
  const logs: ForestLog[] = []
  const edge = ARENA_HALF + 1.3
  for (let side = 0; side < 4; side++) {
    for (let s = -ARENA_HALF - 2; s < ARENA_HALF + 2; ) {
      const length = 4.5 + rand() * 5
      const at = s + length / 2
      const off = edge + (rand() - 0.3) * 1.2
      const jitter = (rand() - 0.5) * 0.25
      const x = side === 0 ? at : side === 1 ? at : side === 2 ? -off : off
      const z = side === 0 ? -off : side === 1 ? off : at
      const yaw = (side < 2 ? 0 : Math.PI / 2) + jitter
      logs.push({ x, z, yaw, length, r: 0.22 + rand() * 0.18, seed: Math.floor(rand() * 1e9) })
      s += length + 0.3 + rand() * 2.2
    }
  }
  const rocks: ForestRock[] = []
  for (let i = 0; i < 16; i++) {
    const a = rand() * Math.PI * 2
    const d = ARENA_HALF + 3 + rand() * 8
    const x = Math.cos(a) * d * 1.1
    const z = Math.sin(a) * d * 1.1
    const r = 0.4 + rand() * 0.9
    rocks.push({ x, z, r, h: r * (0.5 + rand() * 0.5), yaw: rand() * 6.28, seed: Math.floor(rand() * 1e9), moss: 0.5 + rand() * 0.4 })
  }
  // The game owns every solid in the arena: ferns and litter only, plus room round the truck and the parts.
  const clearings: ForestClearing[] = [{ x: 0, z: 0, r: ARENA_HALF * 1.42, ferns: true }]
  if (w.truck) clearings.push({ x: w.truck.x, z: w.truck.y, r: 4.5 })
  for (const it of w.items) clearings.push({ x: it.x, z: it.y, r: 1.6 })
  return {
    seed,
    half: ARENA_HALF + 4,
    height: (x, z) => groundHeight(seed, x, z),
    trees: w.trees.map(forestTree),
    rocks,
    logs,
    clearings,
  }
}

type Crown = { landed: boolean; bend: number; bendV: number; shake: number; shakeV: number; omega: number; side: number }

/** Per-frame lights beyond the forest's own: survivors' torches, the saw lights, flares and the truck. */
export type TimberLights = {
  torches: ForestTorch[]
  scene: SceneLight[]
  fog: FogLamp[]
  glows: ForestGlow[]
  particles: SceneLight[]
}

const TORCH_CONE = Math.cos((20 * Math.PI) / 180)
const FLARE = { power: 4, reach: 18, fog: 2, fogRange: 18, glow: 1 }

export class TimberView {
  private trees: readonly Tree[] | null = null
  private count = -1
  private standing = -1
  private crowns = new Map<number, Crown>()
  private poses: ForestTreePose[] = []
  private posed = new Map<number, ForestTreePose>()
  private capModel: number
  private fibreUpModel: number
  private fibreDownModel: number
  private kerfModels: number[]
  private notchModel: number
  private heapModel: number
  private hintModel: number
  readonly lit: TimberLights = { torches: [], scene: [], fog: [], glows: [], particles: [] }

  private constructor(readonly forest: ForestView) {
    const r = forest.renderer
    this.capModel = r.addModel(capMesh())
    this.fibreUpModel = r.addModel(fibreMesh(1, 31))
    this.fibreDownModel = r.addModel(fibreMesh(-1, 47))
    this.kerfModels = Array.from({ length: KERF_STEPS }, (_, i) => r.addModel(kerfMesh(-1 + ((i + 1) / KERF_STEPS) * 1.45)))
    this.notchModel = r.addModel(notchMesh())
    this.heapModel = r.addModel(heapMesh())
    const dot = new Mesh()
    dot.prism(0, 0, 0.05, 0.05, 0, 0.006, 8, [0.75, 0.68, 0.55], MAT.lit)
    this.hintModel = r.addModel(dot)
  }

  static async create(gpu: { device: GPUDevice; context: GPUCanvasContext; format: GPUTextureFormat }, w: World, quality: QualityTier, smoke = false): Promise<TimberView> {
    // BARBARA's night: the catalogue sky with a full moon through the canopy and eyes that dark-adapt. The software-GPU
    // smoke keeps the kit's Today.
    const settings = { highlightShoulder: true, skyMode: smoke ? "today" as const : "physical" as const, skyMoon: "full" as const, darkAdapt: 1 }
    const forest = await createForestView(gpu, toForestWorld(w), { assetRoot: import.meta.env.BASE_URL + "forest-assets/", quality, markPrefix: "timber", settings, smoke })
    const view = new TimberView(forest)
    view.trees = w.trees
    view.count = w.trees.length
    return view
  }

  get renderer() {
    return this.forest.renderer
  }

  /** Rebuilds the static forest when the round's trees change (a new round or a staged scene). */
  sync(w: World): boolean {
    if (this.trees === w.trees && this.count === w.trees.length) return false
    this.trees = w.trees
    this.count = w.trees.length
    this.crowns.clear()
    this.posed.clear()
    this.standing = -1
    this.forest.setWorld(toForestWorld(w))
    this.forest.resetExposure()
    return true
  }

  /** Where the tree goes over: its fall line once falling, else the side its cuts push it to. */
  fallDir(t: Tree): { x: number; y: number } {
    if (t.state !== "standing") return { x: t.fx, y: t.fy }
    if (Math.hypot(t.cdx, t.cdy) < 1e-6) {
      const a = t.id * 2.399
      return { x: Math.cos(a), y: Math.sin(a) }
    }
    return predictedFall(t, t.x - t.cdx, t.y - t.cdy, 0)
  }

  /** Bark radius at the cut (m). */
  cutRadius(t: Tree, i: number): number {
    return this.forest.cutRadius(i) ?? t.r * TRUNK_SCALE * CUT_FLARE
  }

  /** A tree hit the ground at `omega` (rad/s): its crown whips on and thrashes. */
  land(tree: number, omega: number, look: LookConfig): void {
    const c = this.crowns.get(tree)
    if (!c || c.landed) return
    c.landed = true
    c.bendV += look.crownWhip * Math.abs(omega)
    c.shakeV += c.side * look.crownShake * Math.abs(omega)
  }

  /** Poses every leaning, falling and felled tree for this frame. */
  pose(w: World, feel: FeelConfig, look: LookConfig, dt: number): void {
    this.poses.length = 0
    this.posed.clear()
    let standing = 0
    w.trees.forEach((t, i) => {
      if (t.state === "standing") standing++
      if (t.state === "standing" && t.cut < feel.warnAt) {
        this.crowns.delete(t.id)
        return
      }
      const d = this.fallDir(t)
      const hinge = 0.6 * this.cutRadius(t, i)
      let angle: number
      let bend = 0
      let shake = 0
      if (t.state === "standing") {
        angle = standingLean(t, feel) + look.creak * Math.sin(w.t * 31 + t.id) * Math.sin(w.t * 3.7 + t.id * 1.3)
      } else {
        angle = t.theta
        let c = this.crowns.get(t.id)
        if (!c) this.crowns.set(t.id, (c = { landed: false, bend: 0, bendV: 0, shake: 0, shakeV: 0, omega: 0, side: hash01(t.x, t.y, 3) < 0.5 ? -1 : 1 }))
        c.omega = t.omega
        if (!c.landed && t.state === "falling") {
          // Air drag holds the crown back as the trunk turns: a lag growing with the square of the speed.
          const lag = -look.crownLag * t.omega * Math.abs(t.omega)
          c.bend += (lag - c.bend) * (1 - Math.exp(-dt * 10))
          bend = c.bend
          shake = look.crownFlutter * t.omega * Math.sin(w.t * 6.3 + t.id) * 0.3
        } else {
          if (!c.landed) this.land(t.id, 0, look)
          const k = (2 * Math.PI * look.crownFreq) ** 2
          const damp = 2 * look.crownDamp * Math.sqrt(k)
          const n = Math.max(1, Math.ceil(dt / (1 / 120)))
          const h = dt / n
          for (let s = 0; s < n; s++) {
            c.bendV += (-k * c.bend - damp * c.bendV) * h
            c.bend += c.bendV * h
            c.shakeV += (-k * c.shake - damp * c.shakeV) * h
            c.shake += c.shakeV * h
          }
          if (Math.abs(c.bend) + Math.abs(c.bendV) * 0.1 < 4e-4 && Math.abs(c.shake) + Math.abs(c.shakeV) * 0.1 < 2e-3) c.bend = c.bendV = c.shake = c.shakeV = 0
          bend = c.bend
          shake = c.shake
        }
      }
      const p: ForestTreePose = { tree: i, cut: HINGE, dir: [d.x, d.y], angle, bend, shake, hinge, ground: 0.05 }
      this.poses.push(p)
      this.posed.set(i, p)
    })
    this.forest.poseTrees(this.poses)
    if (standing !== this.standing) {
      this.standing = standing
      const boxes: { rect: Rect; h: number }[] = []
      for (const t of w.trees) {
        if (t.state !== "standing") continue
        const s = t.r * TRUNK_SCALE * 0.85
        boxes.push({ rect: [t.x - s, t.y - s, t.x + s, t.y + s], h: (t.h + HINGE) * 0.8 })
      }
      this.forest.setOccluders(boxes)
    }
  }

  /** The fresh wood a cut leaves: the kerf and notch, the stump's face and the butt's, torn fibres and a sawdust heap. */
  draw(fp: FrameParts, w: World, feel: FeelConfig): void {
    const white: Rgb = [1, 1, 1]
    w.trees.forEach((t, i) => {
      const fresh = t.notched ? t.cut - feel.notchedCut : t.cut
      if (t.cut <= 0.02 && t.state === "standing") return
      const d = this.fallDir(t)
      const yaw = Math.atan2(d.y, d.x)
      const R = this.cutRadius(t, i)
      // The heap lands on the cutter's side, growing with the work done there.
      const heap = t.state === "standing" ? Math.max(0, fresh) : Math.max(0.4, fresh)
      if (heap > 0.02) {
        const s = 0.18 + 0.4 * Math.min(1, heap)
        const side = hash01(t.x, t.y, 5) - 0.5
        fp.part(this.heapModel, t.x - d.x * (R + s * 0.55) - d.y * side * 0.3, 0, t.y - d.y * (R + s * 0.55) + d.x * side * 0.3, yaw + side, white, 0, 0, 0, 1, s)
      }
      const p = this.posed.get(i)
      if (t.state === "standing") {
        const k = Math.max(0, Math.min(KERF_STEPS - 1, Math.round(t.cut * KERF_STEPS) - 1))
        fp.part(this.kerfModels[k]!, t.x, HINGE, t.y, yaw, white, 0, 0, 0, 1, R)
        if (t.cut > 0.12) fp.part(this.notchModel, t.x, HINGE - 0.005, t.y, yaw, white, 0, 0, 0, 1, R)
      }
      if (!p) return
      fp.part(this.capModel, t.x, HINGE + 0.002, t.y, yaw, white, 0, 0, 0, 1, R)
      // The butt turns with the log about the hinge on the fall side.
      const h = p.hinge ?? 0
      const a = p.angle
      const along = h - h * Math.cos(a)
      const up = HINGE + h * Math.sin(a)
      fp.part(this.capModel, t.x + d.x * along, up - 0.002 * Math.cos(a), t.y + d.y * along, yaw, white, -a, 0, 0, 1, R)
      if (t.state !== "standing") {
        fp.part(this.fibreUpModel, t.x, HINGE, t.y, yaw, white, 0, 0, 0, 1, R)
        fp.part(this.fibreDownModel, t.x + d.x * along, up, t.y + d.y * along, yaw, white, -a, 0, 0, 1, R)
      }
    })
  }

  /** A faint line of pale dots where the tree will lie: shown only while you cut it. */
  hint(fp: FrameParts, t: Tree, dx: number, dy: number, strength: number): void {
    if (strength <= 0) return
    const L = t.h + HINGE
    for (let s = 1.2; s < L; s += 0.9) {
      const k = s / L
      const a = strength * (1 - k * 0.7) * smooth(0.5, 2, s)
      if (a < 0.02) continue
      // Opaque and dimmed rather than translucent: a translucent kit part in the forest pass blows the frame out.
      const v = Math.min(1, a)
      fp.part(this.hintModel, t.x + dx * s, 0.01, t.y + dy * s, 0, [v, v, v], 0, 0, 0, 1, 1 + k * 0.6)
    }
  }

  /**
   * This frame's lights: torches (beams through the forest), flares (shadowed points, fog lamps and glows), and the
   * particle lights that let chips, sawdust and smoke catch only the beams that cross them.
   */
  lights(torches: ForestTorch[], flares: readonly FlareLight[], eye: readonly number[], look: LookConfig): TimberLights {
    const L = this.lit
    // The forest's default veiling glare lifts the whole frame off a lamp spot a metre or two ahead: a milky wash.
    this.forest.settings.glare = look.glare
    L.torches = torches
    L.scene.length = 0
    L.fog.length = 0
    L.glows.length = 0
    L.particles.length = 0
    const byDist = (x: number, y: number, z: number) => Math.hypot(x - eye[0]!, y - eye[1]!, z - eye[2]!)
    const lit = torches.filter((t) => t.on).sort((a, b) => byDist(a.pos[0], a.pos[1], a.pos[2]) - byDist(b.pos[0], b.pos[1], b.pos[2]))
    for (const t of lit.slice(0, 6)) {
      const level = (t.level ?? 1) * look.fxLight
      const plan = Math.hypot(t.dir[0], t.dir[2])
      const cone = plan > 0.2 ? ([t.dir[0] / plan, t.dir[2] / plan, TORCH_CONE] as const) : undefined
      L.particles.push({ x: t.pos[0] - t.dir[0] * 0.1, h: t.pos[1] - t.dir[1] * 0.1, y: t.pos[2] - t.dir[2] * 0.1, r: plan > 0.2 ? look.fxLightReach : 2, color: [1, 0.93, 0.82], power: 0.7 * level, size: 0.03, ...(cone ? { cone } : {}) })
      L.particles.push({ x: t.pos[0], h: t.pos[1], y: t.pos[2], r: 1.2, color: [1, 0.93, 0.82], power: 0.3 * level, size: 0.03 })
    }
    const order = flares.filter((f) => f.level > 0.001).sort((a, b) => byDist(a.x, a.y, a.z) - byDist(b.x, b.y, b.z))
    order.forEach((l, n) => {
      const d = byDist(l.x, l.y, l.z)
      if (n < 6) {
        L.scene.push(flareSceneLight(l, FLARE.power, FLARE.reach, n < 3, 5000 + n))
        if (d < 70) L.fog.push(flareFogLamp(l, FLARE.power * 5 * FLARE.fog, FLARE.fogRange, 5000 + n))
      }
      if (n < 4) L.particles.push(flareSceneLight(l, FLARE.power, 12, false, 6000 + n))
      const far = Math.min(1, Math.max(0, (d - 8) / 12))
      if (far > 0) {
        const k = 100 * FLARE.power * FLARE.glow * l.level * far
        L.glows.push({ x: l.x, y: l.y - 0.18, z: l.z, radius: 0.35, color: [l.r * k, l.g * k, l.b * k] })
      }
    })
    return L
  }

  /** Lamps seen as points: the truck's headlights. */
  glow(x: number, y: number, z: number, k: number): void {
    this.lit.glows.push({ x, y, z, radius: 0.16, color: [140 * k, 128 * k, 100 * k] })
  }

  frame(input: {
    eye: readonly [number, number, number]
    viewProj: Float32Array
    width: number
    height: number
    time: number
    dt: number
    fovY: number
    fp: FrameParts
    pool: Particles
    /** Draw offscreen instead (the software-GPU smoke: a presented frame makes SwiftShader wait on it). */
    target?: GPUTextureView
  }): void {
    const L = this.lit
    const frame = {
      eye: input.eye,
      viewProj: input.viewProj,
      width: input.width,
      height: input.height,
      time: input.time,
      dt: input.dt,
      fovY: input.fovY,
      torches: L.torches,
      batches: input.fp.batches(),
      sprites: { alpha: input.fp.alpha as Float32Array<ArrayBuffer>, alphaCount: input.fp.nAlpha, add: input.fp.add, addCount: input.fp.nAdd },
      lights: L.scene,
      fogLamps: L.fog,
      glows: L.glows,
      particles: { pool: input.pool, lights: L.particles },
    }
    if (!input.target) return this.forest.frame(frame)
    this.forest.update(frame)
    this.forest.drawTo(input.target)
  }
}

/** Both windings of a triangle, so a thin face shows from either side. */
function tri2(m: Mesh, a: number[], b: number[], c: number[], col: Rgb) {
  m.facet(a, b, c, col, MAT.lit)
  m.facet(c, b, a, col, MAT.lit)
}

/** The fresh face of a cut at unit radius: growth rings from the heart out to a dark bark edge. */
function capMesh(): Mesh {
  const m = new Mesh()
  const seg = 22
  const radii = [0, 0.12, 0.2, 0.3, 0.38, 0.47, 0.55, 0.63, 0.7, 0.77, 0.83, 0.88, 0.93, 0.965, 1]
  const rnd = mulberry(17)
  const wob = Array.from({ length: seg }, () => 0.97 + rnd() * 0.06)
  for (let r = 0; r < radii.length - 1; r++) {
    const r0 = radii[r]!
    const r1 = radii[r + 1]!
    const col: Rgb = r === radii.length - 2 ? BARK_EDGE : r < 2 ? HEART : r % 2 ? LATE : FRESH
    for (let s = 0; s < seg; s++) {
      const a0 = (s / seg) * Math.PI * 2
      const a1 = ((s + 1) / seg) * Math.PI * 2
      const w0 = wob[s]!
      const w1 = wob[(s + 1) % seg]!
      const p = (rr: number, a: number, ww: number) => [Math.cos(a) * rr * ww, 0, Math.sin(a) * rr * ww]
      const shade = 0.94 + rnd() * 0.1
      const c: Rgb = [col[0] * shade, col[1] * shade, col[2] * shade]
      if (r0 === 0) tri2(m, p(0, 0, 1), p(r1, a1, w1), p(r1, a0, w0), c)
      else {
        tri2(m, p(r0, a0, w0), p(r1, a1, w1), p(r1, a0, w0), c)
        tri2(m, p(r0, a0, w0), p(r0, a1, w1), p(r1, a1, w1), c)
      }
    }
  }
  return m
}

/** Torn hinge fibres at unit radius, on the fall side (+x), standing up (`dir` 1) or hanging from the butt (−1). */
function fibreMesh(dir: number, seed: number): Mesh {
  const m = new Mesh()
  const rnd = mulberry(seed)
  for (let i = 0; i < 14; i++) {
    const z = (rnd() * 2 - 1) * 0.75
    const x = 0.35 + rnd() * (Math.sqrt(1 - z * z) - 0.4)
    const len = 0.12 + rnd() * (i < 4 ? 0.9 : 0.35)
    const r = 0.025 + rnd() * 0.04
    const k = 0.85 + rnd() * 0.2
    const col: Rgb = [FRESH[0] * k, FRESH[1] * k * 0.96, FRESH[2] * k * 0.9]
    m.prism(x, z, r, r * 0.15, dir > 0 ? 0 : -len, dir > 0 ? len : 0, 4, col, MAT.lit, 0, true, rnd())
  }
  // The strip of holding wood, torn and raised.
  m.box(0.5, dir > 0 ? 0 : -0.06, -0.55, 0.62, dir > 0 ? 0.06 : 0, 0.55, LATE, MAT.lit)
  return m
}

/** The back cut at unit radius: a dark kerf band round the bark from behind (−x) to `front`. */
function kerfMesh(front: number): Mesh {
  const m = new Mesh()
  const seg = 40
  const R = 1.03
  const hw = 0.028
  for (let s = 0; s < seg; s++) {
    const a0 = (s / seg) * Math.PI * 2
    const a1 = ((s + 1) / seg) * Math.PI * 2
    const x0 = Math.cos(a0)
    const x1 = Math.cos(a1)
    if (Math.min(x0, x1) > front) continue
    const z0 = Math.sin(a0)
    const z1 = Math.sin(a1)
    const n = [Math.cos((a0 + a1) / 2), 0, Math.sin((a0 + a1) / 2)]
    m.quad([x0 * R, -hw, z0 * R], [x0 * R, hw, z0 * R], [x1 * R, hw, z1 * R], [x1 * R, -hw, z1 * R], n, [0.025, 0.018, 0.012], MAT.lit)
    // Pale bruised lips either side of the slot.
    for (const [y0, y1] of [[hw, hw * 2.2], [-hw * 2.2, -hw]] as const) m.quad([x0 * R, y0, z0 * R], [x0 * R, y1, z0 * R], [x1 * R, y1, z1 * R], [x1 * R, y0, z1 * R], n, [0.42, 0.32, 0.2], MAT.lit)
  }
  return m
}

/** The face notch on the fall side at unit radius: a sloped mouth of fresh wood with a shadowed gap at its floor. */
function notchMesh(): Mesh {
  const m = new Mesh()
  const R = 1.03
  const seg = 12
  const a = Math.acos(0.45)
  for (let s = 0; s < seg; s++) {
    const a0 = -a + (s / seg) * 2 * a
    const a1 = -a + ((s + 1) / seg) * 2 * a
    const h0 = 0.9 * Math.max(0, (Math.cos(a0) - 0.45) / 0.55)
    const h1 = 0.9 * Math.max(0, (Math.cos(a1) - 0.45) / 0.55)
    const p = (ang: number, y: number) => [Math.cos(ang) * R, y, Math.sin(ang) * R]
    const n = [Math.cos((a0 + a1) / 2), 0, Math.sin((a0 + a1) / 2)]
    m.quad(p(a0, 0), p(a0, 0.05), p(a1, 0.05), p(a1, 0), n, [0.03, 0.02, 0.014], MAT.lit)
    m.quad(p(a0, 0.05), p(a0, Math.max(0.05, h0)), p(a1, Math.max(0.05, h1)), p(a1, 0.05), n, FRESH, MAT.lit)
    m.quad(p(a0, -0.03), p(a0, 0), p(a1, 0), p(a1, -0.03), n, LATE, MAT.lit)
  }
  return m
}

/** A low heap of sawdust at unit radius. */
function heapMesh(): Mesh {
  const m = new Mesh()
  const rnd = mulberry(5)
  const seg = 12
  const rings = [0, 0.35, 0.7, 1]
  const hs = [0.24, 0.18, 0.07, 0]
  const pts = rings.map((r, i) => Array.from({ length: seg }, (_, s) => {
    const a = (s / seg) * Math.PI * 2
    const w = r * (0.8 + rnd() * 0.4)
    return [Math.cos(a) * w * 1.25, hs[i]! * (0.8 + rnd() * 0.4), Math.sin(a) * w]
  }))
  for (let r = 0; r < rings.length - 1; r++)
    for (let s = 0; s < seg; s++) {
      const k = 0.9 + rnd() * 0.15
      const c: Rgb = [DUST[0] * k, DUST[1] * k, DUST[2] * k]
      const a = pts[r]![s]!
      const b = pts[r]![(s + 1) % seg]!
      const cc = pts[r + 1]![(s + 1) % seg]!
      const d = pts[r + 1]![s]!
      m.facet(a, cc, d, c, MAT.lit)
      if (r > 0) m.facet(a, b, cc, c, MAT.lit)
    }
  return m
}
