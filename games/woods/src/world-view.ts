import type { FogLamp } from "@arcade/kit/gpu/fog-scatter"
import type { FrameParts } from "@arcade/kit/gpu/frame-parts"
import { MAT, Mesh, packVerts, type Rgb } from "@arcade/kit/gpu/mesh"
import type { Renderer } from "@arcade/kit/gpu/renderer"
import { flatLighting, type SceneLight } from "@arcade/kit/gpu/scene-frame"
import type { Rect } from "@arcade/kit/sim/geom"
import type { Feel, WoodsState } from "../shared/sim"
import { groundHeight, lakeDistance, trailDistance, type Building, type Rock, type Tree, type WoodsWorld } from "../shared/world"

/**
 * The only module that turns world data into pictures. Everything it draws comes from `WoodsWorld` (static: terrain,
 * lake, camp, trees, rocks, markers, place lights) and `WoodsState` (dynamic: tapes). Today it draws greybox primitives
 * (cylinders and cones for trees, boxes for rocks and cabins); a real forest renderer replaces this file's internals
 * and keeps its four entry points: `setWorld`, `lights`, `occluders`, `draw`.
 */

/** Material aux tags the scene hooks (`shaders.ts`) read. */
export const AUX = { tape: 7, sky: -1, water: 2 } as const
const CHUNK = 40

const BARK: Rgb = [0.15, 0.115, 0.085]
const BIRCH: Rgb = [0.52, 0.5, 0.46]
const SNAG: Rgb = [0.2, 0.18, 0.16]
const NEEDLES: Rgb = [0.045, 0.075, 0.05]
const LEAVES: Rgb = [0.08, 0.1, 0.05]
const FLOOR: Rgb = [0.12, 0.095, 0.065]
const MOSS: Rgb = [0.08, 0.1, 0.05]
const PATH: Rgb = [0.16, 0.13, 0.095]
const MUD: Rgb = [0.06, 0.055, 0.045]
const ROCK: Rgb = [0.22, 0.22, 0.21]
const WOOD: Rgb = [0.2, 0.13, 0.08]
const ROOF: Rgb = [0.09, 0.08, 0.075]
const WINDOW_GLOW: Rgb = [1, 0.58, 0.26]
const TAPE: Rgb = [1, 0.33, 0.04]

const mix3 = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
const scale3 = (a: Rgb, k: number): Rgb => [a[0] * k, a[1] * k, a[2] * k]
const frac = (v: number) => v - Math.floor(v)

function terrainTile(m: Mesh, world: WoodsWorld, x0: number, z0: number, x1: number, z1: number, step: number) {
  const h = (x: number, z: number) => groundHeight(world, x, z)
  const vert = (x: number, z: number) => {
    const y = h(x, z)
    const nx = h(x - 0.5, z) - h(x + 0.5, z), nz = h(x, z - 0.5) - h(x, z + 0.5)
    const l = Math.hypot(nx, 1, nz)
    let c = mix3(FLOOR, MOSS, frac(Math.abs(x * 0.137 + z * 0.091) * 3.7) * 0.5)
    c = scale3(c, 0.8 + 0.4 * frac(Math.abs(x * 0.71 - z * 0.37)))
    const trail = trailDistance(world.trail, x, z)
    if (trail.d < 2.2) c = mix3(c, PATH, (1 - trail.d / 2.2) * (1 - trail.along * 0.85))
    const wet = lakeDistance(world.lake, x, z)
    if (wet < 1.2) c = mix3(c, MUD, Math.min(1, (1.2 - wet) * 5))
    m.vert([x, y, z], [nx / l, 1 / l, nz / l], c, MAT.lit)
  }
  for (let x = x0; x < x1 - 1e-6; x += step) for (let z = z0; z < z1 - 1e-6; z += step) {
    const xa = x, xb = Math.min(x + step, x1), za = z, zb = Math.min(z + step, z1)
    // Box-top winding: (x0,z1) (x1,z1) (x1,z0), (x0,z1) (x1,z0) (x0,z0).
    vert(xa, zb); vert(xb, zb); vert(xb, za)
    vert(xa, zb); vert(xb, za); vert(xa, za)
  }
}

function tree(m: Mesh, t: Tree) {
  const tint = 0.8 + 0.4 * t.seed
  const sides = 6, phase = t.seed * 2
  const y0 = t.y - 0.4
  if (t.species === "birch") {
    m.prism(t.x, t.z, t.radius, t.radius * 0.45, y0, t.y + t.height * 0.85, sides, scale3(BIRCH, tint), MAT.lit, 0, false, phase)
    m.prism(t.x, t.z, 1 + 0.7 * t.seed, 0.35, t.y + t.height * 0.5, t.y + t.height, sides, scale3(LEAVES, tint), MAT.lit, 0, true, phase)
    return
  }
  if (t.species === "snag") {
    m.prism(t.x, t.z, t.radius, t.radius * 0.5, y0, t.y + t.height, sides, scale3(SNAG, tint), MAT.lit, 0, true, phase)
    return
  }
  m.prism(t.x, t.z, t.radius, t.radius * 0.3, y0, t.y + t.height * 0.92, sides, scale3(BARK, tint), MAT.lit, 0, false, phase)
  const needles = scale3(NEEDLES, tint)
  if (t.species === "pine") {
    const r = 1.1 + 0.8 * t.seed
    m.prism(t.x, t.z, r, 0.5, t.y + t.height * 0.55, t.y + t.height * 0.8, sides, needles, MAT.lit, 0, false, phase + 0.5)
    m.prism(t.x, t.z, r * 0.75, 0, t.y + t.height * 0.72, t.y + t.height, sides, needles, MAT.lit, 0, false, phase)
  } else {
    const r = 1.4 + 0.8 * t.seed
    m.prism(t.x, t.z, r, 0.4, t.y + t.height * 0.2, t.y + t.height * 0.6, sides, needles, MAT.lit, 0, false, phase)
    m.prism(t.x, t.z, r * 0.7, 0, t.y + t.height * 0.45, t.y + t.height, sides, needles, MAT.lit, 0, false, phase + 0.5)
  }
}

function rock(m: Mesh, k: Rock) {
  const tone = 0.75 + 0.5 * k.seed
  m.yawBox(k.x, k.z, k.w, k.d, k.y - 0.4, k.y + k.h, k.yaw, scale3(ROCK, tone), MAT.lit, 0, mix3(scale3(ROCK, tone), MOSS, 0.6))
}

function building(m: Mesh, b: Building) {
  const [x0, z0, x1, z1] = b.rect
  const y0 = b.y, y1 = b.y + b.h
  switch (b.kind) {
    case "cabin":
    case "mess-hall": {
      m.box(x0, y0 - 0.5, z0, x1, y1, z1, WOOD, MAT.lit)
      // Gable roof along x, overhanging.
      const o = 0.45, ridge = y1 + (z1 - z0) * 0.32, zm = (z0 + z1) / 2
      m.quadAuto([x0 - o, y1 - 0.15, z1 + o], [x1 + o, y1 - 0.15, z1 + o], [x1 + o, ridge, zm], [x0 - o, ridge, zm], ROOF)
      m.quadAuto([x1 + o, y1 - 0.15, z0 - o], [x0 - o, y1 - 0.15, z0 - o], [x0 - o, ridge, zm], [x1 + o, ridge, zm], ROOF)
      m.facet([x0, y1, z1], [x0, ridge, zm], [x0, y1, z0], WOOD)
      m.facet([x1, y1, z0], [x1, ridge, zm], [x1, y1, z1], WOOD)
      // Door on the lake side, steps.
      const xm = (x0 + x1) / 2
      m.box(xm - 0.5, y0, z1, xm + 0.5, y0 + 2.05, z1 + 0.04, [0.08, 0.06, 0.05])
      m.box(xm - 0.9, y0 - 0.5, z1, xm + 0.9, y0 + 0.15, z1 + 0.9, WOOD)
      if (b.kind === "cabin") {
        for (const s of [-1, 1]) m.box(xm + s * 1.3 - 0.4, y0 + 1.1, z1, xm + s * 1.3 + 0.4, y0 + 1.8, z1 + 0.03, [0.02, 0.025, 0.03], MAT.shiny)
        break
      }
      // Mess hall: warm lit panes on every side, a chimney.
      const pane = (ax: number, az: number, bx: number, bz: number) => m.box(Math.min(ax, bx), y0 + 1.1, Math.min(az, bz), Math.max(ax, bx), y0 + 2.3, Math.max(az, bz), WINDOW_GLOW, MAT.glow, 7)
      for (const px of [-4.6, -2, 2, 4.6]) {
        pane(xm + px - 0.6, z1, xm + px + 0.6, z1 + 0.04)
        pane(xm + px - 0.6, z0 - 0.04, xm + px + 0.6, z0)
      }
      for (const pz of [-1.6, 1.6]) {
        pane(x0 - 0.04, zm + pz - 0.6, x0, zm + pz + 0.6)
        pane(x1, zm + pz - 0.6, x1 + 0.04, zm + pz + 0.6)
      }
      m.box(x1 - 2.2, y1, zm - 0.5, x1 - 1.4, ridge + 1.1, zm + 0.5, [0.18, 0.16, 0.15])
      break
    }
    case "dock": {
      m.box(x0, y0, z0, x1, y1, z1, [0.24, 0.17, 0.11])
      for (let z = z0 + 1; z < z1; z += 3) for (const x of [x0 + 0.1, x1 - 0.1]) m.prism(x, z, 0.1, 0.1, y0 - 2.5, y0 + 0.05, 5, [0.15, 0.11, 0.08])
      break
    }
    case "canoe": {
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2
      m.prism(cx, cz - (z1 - z0) * 0.3, (x1 - x0) / 2, 0.05, y0, y0 + b.h, 6, [0.42, 0.08, 0.05])
      m.box(x0, y0, cz - (z1 - z0) * 0.3, x1, y0 + b.h, z1 - 0.3, [0.42, 0.08, 0.05])
      break
    }
    case "table":
      m.box(x0, y0 + b.h - 0.05, z0, x1, y0 + b.h, z1, WOOD)
      for (const [x, z] of [[x0 + 0.1, z0 + 0.1], [x1 - 0.1, z0 + 0.1], [x0 + 0.1, z1 - 0.1], [x1 - 0.1, z1 - 0.1]] as const) m.box(x - 0.04, y0, z - 0.04, x + 0.04, y0 + b.h, z + 0.04, WOOD)
      break
    case "mast": {
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2
      m.prism(cx, cz, 0.7, 0.15, y0 - 0.5, y1, 4, [0.3, 0.3, 0.32], MAT.lit, 0, true, Math.PI / 4)
      m.box(cx - 1.5, y0 - 0.5, cz - 1.5, cx + 1.5, y0 + 0.1, cz + 1.5, [0.3, 0.3, 0.29])
      break
    }
  }
}

function marker(m: Mesh, x: number, z: number, y: number, id: number) {
  // Old concrete survey monument with a brass disc, a few stones around and a faded witness post.
  m.bevelBox(x - 0.16, y - 0.4, z - 0.16, x + 0.16, y + 0.75, z + 0.16, 0.03, [0.42, 0.41, 0.38], [0.46, 0.45, 0.42])
  m.prism(x, z, 0.07, 0.07, y + 0.75, y + 0.77, 10, [0.55, 0.4, 0.16], MAT.shiny)
  for (let i = 0; i < 6; i++) {
    const a = i * 1.05 + id
    m.yawBox(x + Math.cos(a) * 0.55, z + Math.sin(a) * 0.55, 0.25, 0.2, y - 0.2, y + 0.12, a, ROCK)
  }
  const wx = x + 0.9, wz = z - 0.4
  m.box(wx - 0.05, y - 0.3, wz - 0.05, wx + 0.05, y + 1.2, wz + 0.05, [0.5, 0.48, 0.42])
  m.box(wx - 0.055, y + 0.95, wz - 0.055, wx + 0.055, y + 1.12, wz + 0.055, [0.7, 0.25, 0.06])
}

function lake(m: Mesh, world: WoodsWorld) {
  const L = world.lake, n = 48, y = L.level
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2
    const r = 1.15
    m.vert([L.x, y, L.z], [0, 1, 0], [0.012, 0.016, 0.02], MAT.shiny, AUX.water)
    m.vert([L.x + Math.cos(a1) * L.rx * r, y, L.z + Math.sin(a1) * L.rz * r], [0, 1, 0], [0.012, 0.016, 0.02], MAT.shiny, AUX.water)
    m.vert([L.x + Math.cos(a0) * L.rx * r, y, L.z + Math.sin(a0) * L.rz * r], [0, 1, 0], [0.012, 0.016, 0.02], MAT.shiny, AUX.water)
  }
}

function stringBulbs(m: Mesh, world: WoodsWorld) {
  for (const l of world.lamps) {
    if (l.kind === "string") m.box(l.x - 0.04, l.y - 0.06, l.z - 0.04, l.x + 0.04, l.y + 0.04, l.z + 0.04, [1, 0.72, 0.4], MAT.glow, 1.4)
    if (l.kind === "porch") m.box(l.x - 0.08, l.y - 0.1, l.z - 0.08, l.x + 0.08, l.y + 0.05, l.z + 0.08, [1, 0.66, 0.35], MAT.glow, 2)
  }
}

/** Static world geometry as renderer level chunks (each culled by plan rect). */
export function buildChunks(world: WoodsWorld): { data: ArrayBuffer; box: readonly [number, number, number, number] }[] {
  const half = world.params.half + 20
  const tiles = new Map<string, Mesh>()
  const tileAt = (x: number, z: number) => {
    const key = `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`
    let m = tiles.get(key)
    if (!m) tiles.set(key, (m = new Mesh()))
    return m
  }
  for (let x = -half; x < half; x += CHUNK) for (let z = -half; z < half; z += CHUNK) terrainTile(tileAt(x + 1, z + 1), world, x, z, x + CHUNK, z + CHUNK, 2.5)
  for (const t of world.trees) tree(tileAt(t.x, t.z), t)
  for (const k of world.rocks) rock(tileAt(k.x, k.z), k)
  for (const k of world.markers) marker(tileAt(k.x, k.z), k.x, k.z, k.y, k.id)
  const place = new Mesh()
  for (const b of world.buildings) building(place, b)
  lake(place, world)
  stringBulbs(place, world)
  const out: { data: ArrayBuffer; box: readonly [number, number, number, number] }[] = []
  for (const [key, m] of tiles) {
    const [i, j] = key.split(",").map(Number) as [number, number]
    // Crowns overhang their tile; pad the cull box.
    out.push({ data: packVerts(m.v), box: [i * CHUNK - 4, j * CHUNK - 4, (i + 1) * CHUNK + 4, (j + 1) * CHUNK + 4] })
  }
  out.push({ data: packVerts(place.v), box: [-half, -half, half, half] })
  return out
}

/** Plan rect that holds what a camera at `eye` looking along `yaw` can see within `far`. */
export function viewRect(eye: readonly number[], yaw: number, pitch: number, far: number, fovX: number): readonly [number, number, number, number] {
  if (Math.abs(pitch) > 0.7) return [eye[0]! - far * 0.75, eye[2]! - far * 0.75, eye[0]! + far * 0.75, eye[2]! + far * 0.75]
  const xs = [eye[0]!], zs = [eye[2]!]
  for (const a of [-fovX / 2 - 0.15, 0, fovX / 2 + 0.15]) {
    xs.push(eye[0]! - Math.sin(yaw + a) * far)
    zs.push(eye[2]! - Math.cos(yaw + a) * far)
  }
  const m = 6
  return [Math.min(...xs) - m, Math.min(...zs) - m, Math.max(...xs) + m, Math.max(...zs) + m]
}

export type PlaceLights = { scene: SceneLight[]; fog: FogLamp[] }

/** Ridge beacon: a slow aircraft-warning blink, 0..1. */
export function ridgeBlink(t: number): number {
  const p = (t % 1.6) / 1.6
  return p < 0.3 ? Math.sin((p / 0.3) * Math.PI) ** 0.6 : 0
}

export class WorldView {
  private tapeModels = new Map<number, number>()
  private skyModel: number
  private beaconModel: number

  constructor(private renderer: Renderer) {
    const sky = new Mesh()
    // Inward-facing dome the scene hooks shade as fog sky (aux −1).
    const n = 16, r = 280
    for (let i = 0; i < n; i++) for (let j = 0; j < 8; j++) {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2
      const b0 = (j / 8) * Math.PI * 0.5 - 0.15, b1 = ((j + 1) / 8) * Math.PI * 0.5 - 0.15
      const p = (a: number, b: number) => [Math.cos(a) * Math.cos(b) * r, Math.sin(b) * r, Math.sin(a) * Math.cos(b) * r]
      sky.quadAuto(p(a0, b0), p(a0, b1), p(a1, b1), p(a1, b0), [0, 0, 0], MAT.glow, AUX.sky)
    }
    this.skyModel = renderer.addModel(sky)
    const beacon = new Mesh()
    beacon.prism(0, 0, 0.6, 0.6, -0.6, 0.6, 8, [1, 1, 1], MAT.accent)
    this.beaconModel = renderer.addModel(beacon)
  }

  /** Uploads the static world. Call again when the world is regenerated (trunk density, seed). */
  setWorld(world: WoodsWorld): void {
    this.renderer.setLevel({ chunks: buildChunks(world), glass: [], ...flatLighting(0, 0, [0, 0, 0]) })
  }

  /** Polar-shadow occluders: trunks, rocks and buildings with their top heights. */
  occluders(world: WoodsWorld): { rect: Rect; h: number }[] {
    const out: { rect: Rect; h: number }[] = []
    for (const t of world.trees) {
      const s = t.radius * 0.85
      out.push({ rect: [t.x - s, t.z - s, t.x + s, t.z + s], h: t.y + t.height * 0.8 })
    }
    for (const k of world.rocks) if (k.h > 0.5) {
      const e = Math.min(k.w, k.d) * 0.4
      out.push({ rect: [k.x - e, k.z - e, k.x + e, k.z + e], h: k.y + k.h })
    }
    for (const b of world.buildings) if (b.kind === "cabin" || b.kind === "mess-hall") out.push({ rect: b.rect, h: b.y + b.h + 1.5 })
    return out
  }

  /** The place's own lights: mess hall windows, string lights, porches, the ridge beacon. */
  lights(world: WoodsWorld, t: number, feel: Feel): PlaceLights {
    const scene: SceneLight[] = [], fog: FogLamp[] = []
    let id = 1000
    for (const l of world.lamps) {
      const power = l.power * feel.campGlow
      scene.push({ id: id++, x: l.x, y: l.z, h: l.y, r: l.range, color: l.color, power, size: 0.3, unshadowed: l.kind !== "window" })
    }
    const hall = world.buildings.find((b) => b.kind === "mess-hall")
    if (hall) {
      const [x0, z0, x1, z1] = hall.rect
      fog.push({ id: 900, x: (x0 + x1) / 2, y: hall.y + 1.6, z: (z0 + z1) / 2, range: 40, color: [1, 0.55, 0.22], intensity: 60 * feel.campGlow * feel.beamHaze * 0.1, size: 10 })
    }
    const strings = world.lamps.filter((l) => l.kind === "string")
    if (strings.length) {
      const c = strings.reduce((a, l) => [a[0] + l.x / strings.length, a[1] + l.y / strings.length, a[2] + l.z / strings.length], [0, 0, 0])
      fog.push({ id: 901, x: c[0], y: c[1], z: c[2], range: 22, color: [1, 0.7, 0.35], intensity: 4 * feel.campGlow * feel.beamHaze * 0.1, size: 14 })
    }
    const blink = ridgeBlink(t) * feel.ridgeGlow
    const r = world.ridgeLight
    if (blink > 0) {
      scene.push({ id: 950, x: r.x, y: r.z, h: r.y, r: 40, color: [1, 0.06, 0.02], power: 60 * blink, size: 0.4, unshadowed: true })
      fog.push({ id: 950, x: r.x, y: r.y, z: r.z, range: 160, color: [1, 0.06, 0.02], intensity: 3000 * blink * feel.beamHaze * 0.1, size: 1.2, visibility: 1 })
    }
    return { scene, fog }
  }

  private tapeModel(radius: number): number {
    const bucket = Math.max(3, Math.ceil(radius / 0.02))
    let id = this.tapeModels.get(bucket)
    if (id !== undefined) return id
    const m = new Mesh()
    const r = bucket * 0.02 + 0.01
    m.prism(0, 0, r, r, -0.028, 0.028, 12, TAPE, MAT.lit, AUX.tape, false)
    // Two tails from the knot on +x, both faces so they read from behind.
    for (const [dz, lean, len] of [[-0.03, 0.12, 0.42], [0.03, 0.3, 0.34]] as const) {
      const top = [r, 0, dz], bot = [r + lean * len, -len, dz + lean * 0.3 * len]
      const w = 0.026
      const a = [top[0]!, top[1]!, top[2]! - w], b = [top[0]!, top[1]!, top[2]! + w], c = [bot[0]!, bot[1]!, bot[2]! + w], d = [bot[0]!, bot[1]!, bot[2]! - w]
      m.quadAuto(a, b, c, d, TAPE, MAT.lit, AUX.tape)
      m.quadAuto(d, c, b, a, TAPE, MAT.lit, AUX.tape)
    }
    id = this.renderer.addModel(m)
    this.tapeModels.set(bucket, id)
    return id
  }

  /** Per-frame world content: tapes, the ridge beacon, the sky dome around the eye. */
  draw(fp: FrameParts, world: WoodsWorld, state: WoodsState, t: number, eye: readonly number[], feel: Feel): void {
    fp.push(this.skyModel, eye[0]!, eye[1]! - 20, eye[2]!, 0, [1, 1, 1], 0, 0, 0)
    for (const tape of state.tapes) {
      const tree = world.trees[tape.tree]
      if (!tree) continue
      fp.push(this.tapeModel(tree.radius * (1 - (TAPE_RISE * 0.7) / tree.height)), tape.x, tape.y, tape.z, tape.yaw, [1, 1, 1], 0, 0, 0)
    }
    const blink = ridgeBlink(t) * feel.ridgeGlow
    const r = world.ridgeLight
    fp.push(this.beaconModel, r.x, r.y, r.z, 0, [40 * blink + 0.04, 1.2 * blink, 0.3 * blink], 0, 0, 0)
  }
}
const TAPE_RISE = 1.9
