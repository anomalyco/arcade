import type { LabControl } from "@arcade/kit/lab-panel"
import { DebrisObstacles, placeDebris, type DebrisInstance, type DebrisObstacle, type DebrisRule, type Vec2 } from "@arcade/kit/sim/debris"
import { packTexturedVerts } from "@arcade/kit/gpu/textured-mesh"
import { MAT } from "@arcade/kit/gpu/mesh"

// Ground dressing at the gate: weeds and grass at the fence and kerbs, leaf litter against walls and kerbs, gravel on
// the shoulders and in the gutters, a little litter. Placed by the kit's debris rules; the plant clumps are the source's
// own undergrowth templates, leaves/pebbles/paper are procedural, and the can is Poly Haven's CC0 Can Rusted.

export type DressingSettings = { look: "dressed" | "today"; weeds: number; leaves: number; gravel: number; litter: number; seed: number }
export const DRESSING_PRESETS = {
  dressed: { weeds: 1, leaves: 1, gravel: 1, litter: 1 },
  today: { weeds: 0, leaves: 0, gravel: 0, litter: 0 },
} as const
export const dressingDefaults = (): DressingSettings => ({ look: "dressed", ...DRESSING_PRESETS.dressed, seed: 1984 })

export function dressingControls(settings: DressingSettings, group = "Ground"): LabControl[] {
  const range = (key: "weeds" | "leaves" | "gravel" | "litter", label: string): LabControl => ({ key: `ground.${key}`, field: key, label, group, min: 0, max: 3, step: 0.05, unit: "×" })
  return [
    { key: "ground.look", field: "look", label: "Ground dressing", group, type: "select", options: [{ value: "dressed", label: "Dressed" }, { value: "today", label: "Today" }],
      change: value => Object.assign(settings, DRESSING_PRESETS[value as DressingSettings["look"]]) },
    range("weeds", "Weeds and grass"), range("leaves", "Leaf litter"), range("gravel", "Gravel"), range("litter", "Litter"),
    { key: "ground.seed", field: "seed", label: "Placement seed", group, min: 1, max: 9999, step: 1 },
  ]
}

export type Ground = {
  x0: number; z0: number; step: number; nx: number; nz: number; heights: number[]
  accessRoad: [number, number][]; roadHalfWidth: number; shoulder: number
  fence: { max: [number, number]; gate: { x0: number; x1: number } }
  booth: { x: number; z: number; w: number; d: number }
}

/** Raised concrete island under the booth (Ashwood compound/booth.ts), 0.12 m above the apron. */
const ISLAND = { min: [4.9, 124.3] as Vec2, max: [11.8, 131.4] as Vec2, top: 0.12 }
/** Wagon apron and the flat gate apron (Ashwood booth.ts APRON, height.ts GATE_APRON). */
const WAGON = { min: [-12.6, 133.4] as Vec2, max: [-4.8, 142.2] as Vec2 }
const APRON = { min: [-16, 122] as Vec2, max: [15.7, 136.4] as Vec2 }

export function groundHeight(g: Ground, x: number, z: number) {
  const fx = Math.min(g.nx - 1.001, Math.max(0, (x - g.x0) / g.step)), fz = Math.min(g.nz - 1.001, Math.max(0, (z - g.z0) / g.step))
  const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j
  const h = (a: number, b: number) => g.heights[b * g.nx + a]!
  const y = (h(i, j) * (1 - u) + h(i + 1, j) * u) * (1 - v) + (h(i, j + 1) * (1 - u) + h(i + 1, j + 1) * u) * v
  const island = x > ISLAND.min[0] && x < ISLAND.max[0] && z > ISLAND.min[1] && z < ISLAND.max[1]
  return y + (island ? ISLAND.top : 0)
}

/** Polyline offset sideways by `d` (positive = left of travel). */
function offsetLine(points: readonly Vec2[], d: number): Vec2[] {
  return points.map((p, i) => {
    const a = points[Math.max(0, i - 1)]!, b = points[Math.min(points.length - 1, i + 1)]!
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    return [p[0] - (b[1] - a[1]) / len * d, p[1] + (b[0] - a[0]) / len * d] as Vec2
  })
}

export function dressingRules(g: Ground, colliders: readonly { min: number[]; max: number[] }[]) {
  const booth = { min: [g.booth.x - g.booth.w / 2, g.booth.z - g.booth.d / 2] as Vec2, max: [g.booth.x + g.booth.w / 2, g.booth.z + g.booth.d / 2] as Vec2 }
  const fz = g.fence.max[1]
  const fence: Vec2[][] = [[[-40, fz], [g.fence.gate.x0, fz]], [[g.fence.gate.x1, fz], [40, fz]]]
  // Road shoulders south of the gate apron, where the road leaves the paved area.
  const road = g.accessRoad.filter(([, z]) => z > APRON.max[1] - 0.5 && z < 185)
  const edges = [offsetLine(road, g.roadHalfWidth), offsetLine(road, -g.roadHalfWidth)]
  const kerb = [{ box: ISLAND }], apron = [{ box: APRON }], walls = [{ box: booth }, { box: WAGON }]
  const props = [{ circle: { c: [11.25, 128.4] as Vec2, r: 0.33 } }, { box: { min: [9.75, 125.4] as Vec2, max: [10.45, 125.9] as Vec2 } }]
  const shoulders = edges.map(line => ({ line }))
  const rules: DebrisRule[] = [
    // Kerb gutter round the booth island.
    { item: "pebble", group: "gravel", along: kerb, offset: [0.02, 0.3], spacing: 0.55, chance: 0.75, cluster: { count: [4, 10], spread: 0.25 }, scale: [0.02, 0.055] },
    { item: "leaf", group: "leaves", along: kerb, offset: [0.02, 0.55], spacing: 0.8, chance: 0.65, cluster: { count: [3, 9], spread: 0.35 }, scale: [0.07, 0.13] },
    { item: "grass", group: "weeds", along: kerb, offset: [0.04, 0.2], spacing: 2.2, chance: 0.55, scale: [0.3, 0.55] },
    { item: "salal", group: "weeds", along: kerb, offset: [0.05, 0.22], spacing: 4.5, chance: 0.4, scale: [0.3, 0.5] },
    { item: "twigs", group: "leaves", along: kerb, offset: [0.05, 0.5], spacing: 3.2, chance: 0.45, scale: [0.35, 0.6] },
    { item: "paper", group: "litter", along: kerb, offset: [0.05, 0.4], spacing: 5.5, chance: 0.5, scale: [0.05, 0.09] },
    { item: "can", group: "litter", along: kerb, offset: [0.08, 0.3], spacing: 11, chance: 0.6, scale: [0.95, 1.05], align: 0.6 },
    // Against the booth and the wagon apron walls and around the props by the booth.
    { item: "leaf", group: "leaves", along: walls, offset: [0.02, 0.35], spacing: 0.7, chance: 0.7, cluster: { count: [3, 9], spread: 0.3 }, scale: [0.07, 0.12], clearance: 0.02 },
    { item: "paper", group: "litter", along: walls, offset: [0.03, 0.3], spacing: 4, chance: 0.45, scale: [0.05, 0.08], clearance: 0.02 },
    { item: "leaf", group: "leaves", along: props, offset: [0.02, 0.4], spacing: 0.4, chance: 0.8, cluster: { count: [2, 6], spread: 0.15 }, scale: [0.07, 0.12], clearance: 0.01 },
    { item: "can", group: "litter", along: [props[0]!], offset: [0.1, 0.35], spacing: 5, chance: 0.9, scale: [0.95, 1.05], clearance: 0.05 },
    // Fence base, both sides.
    { item: "grass", group: "weeds", along: fence.map(line => ({ line })), offset: [0, 0.45], side: 0, spacing: 1.1, chance: 0.8, scale: [0.55, 1.1] },
    { item: "salal", group: "weeds", along: fence.map(line => ({ line })), offset: [0.05, 0.6], side: 0, spacing: 2.4, chance: 0.5, scale: [0.5, 0.9] },
    { item: "fern", group: "weeds", along: fence.map(line => ({ line })), offset: [0.1, 0.6], side: 0, spacing: 4.5, chance: 0.35, scale: [0.35, 0.6] },
    { item: "leaf", group: "leaves", along: fence.map(line => ({ line })), offset: [0, 0.6], side: 0, spacing: 1, chance: 0.6, cluster: { count: [3, 8], spread: 0.4 }, scale: [0.07, 0.13] },
    { item: "twigs", group: "leaves", along: fence.map(line => ({ line })), offset: [0.05, 0.7], side: 0, spacing: 3, chance: 0.4, scale: [0.4, 0.7] },
    // Gate apron edges and the road shoulders.
    { item: "pebble", group: "gravel", along: apron, offset: [0, 0.5], spacing: 0.8, chance: 0.6, cluster: { count: [3, 8], spread: 0.3 }, scale: [0.025, 0.065] },
    { item: "grass", group: "weeds", along: apron, offset: [0.3, 1.3], spacing: 1.5, chance: 0.7, scale: [0.6, 1.1] },
    { item: "leaf", group: "leaves", along: apron, offset: [0, 0.8], spacing: 1.2, chance: 0.5, cluster: { count: [3, 7], spread: 0.4 }, scale: [0.07, 0.13] },
    { item: "pebble", group: "gravel", along: shoulders, offset: [0, g.shoulder], side: 0, spacing: 0.7, chance: 0.7, cluster: { count: [4, 10], spread: 0.35 }, scale: [0.025, 0.065] },
    { item: "leaf", group: "leaves", along: shoulders, offset: [-0.2, g.shoulder + 0.4], side: 0, spacing: 1.4, chance: 0.55, cluster: { count: [3, 8], spread: 0.5 }, scale: [0.07, 0.13] },
    { item: "grass", group: "weeds", along: shoulders, offset: [g.shoulder, g.shoulder + 1.2], side: 0, spacing: 1.4, chance: 0.75, scale: [0.6, 1.15] },
    { item: "paper", group: "litter", along: shoulders, offset: [0.2, g.shoulder], side: 0, spacing: 12, chance: 0.5, scale: [0.05, 0.09] },
  ]
  // Keep the driving lanes clear; the outer 0.45 m of asphalt still collects leaves, grit and kerb weeds.
  const lanes = g.accessRoad.slice(1).map((b, i): DebrisObstacle => ({ capsule: { a: g.accessRoad[i]!, b, r: g.roadHalfWidth - 0.45 } }))
  const obstacles: DebrisObstacle[] = [
    ...lanes,
    { box: booth, pad: 0.01 },
    ...colliders.filter(c => c.min[1]! < 1.2 && c.max[1]! > 0.05).map(c => ({ box: { min: [c.min[0]!, c.min[2]!] as Vec2, max: [c.max[0]!, c.max[2]!] as Vec2 }, pad: 0.03 })),
  ]
  return { rules, obstacles: new DebrisObstacles(obstacles) }
}

export function placeDressing(g: Ground, colliders: readonly { min: number[]; max: number[] }[], s: DressingSettings): DebrisInstance[] {
  const { rules, obstacles } = dressingRules(g, colliders)
  return placeDebris(rules, obstacles, { seed: s.seed, density: { weeds: s.weeds, leaves: s.leaves, gravel: s.gravel, litter: s.litter } })
}

// Procedural templates (32-byte textured vertices). Kit vertex colours are sRGB.
type V = [x: number, y: number, z: number, nx: number, ny: number, nz: number, r: number, g: number, b: number, u: number, v: number, aux?: number]
function pack(tris: V[]) {
  return packTexturedVerts(tris.flatMap(v => [v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8], MAT.lit, v[11] ?? 1]), tris.flatMap(v => [v[9], v[10]]))
}

/** Flat leaf card (1 m square, scaled per instance) on atlas cell 0..3 of the 2×2 leaf atlas. */
export function leafTemplate(cell: number) {
  const u0 = (cell % 2) * 0.5, v0 = Math.floor(cell / 2) * 0.5
  const c = (x: number, z: number, u: number, v: number): V => [x, 0.012 + 0.02 * Math.abs(x + z), z, 0, 1, 0, 1, 1, 1, u0 + u * 0.5, v0 + v * 0.5]
  return pack([c(-0.5, -0.5, 0, 0), c(0.5, -0.5, 1, 0), c(0.5, 0.5, 1, 1), c(-0.5, -0.5, 0, 0), c(0.5, 0.5, 1, 1), c(-0.5, 0.5, 0, 1)])
}

/** Low-poly pebble: a flattened, jittered octahedron (1 m across before scale). */
export function pebbleTemplate(seed: number) {
  let h = seed * 7919 + 13
  const rnd = () => ((h = (Math.imul(h, 48271) + 1) >>> 0) % 10000) / 10000
  const grey = 0.2 + rnd() * 0.14, warm = rnd() * 0.04
  const p = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map(([x, y, z]) => { const k = 0.38 + rnd() * 0.22; return [x! * k, Math.max(0, y! * k * 0.55 + 0.2), z! * k] })
  const faces = [[0, 2, 4], [4, 2, 1], [1, 2, 5], [5, 2, 0], [4, 3, 0], [1, 3, 4], [5, 3, 1], [0, 3, 5]]
  return pack(faces.flatMap(f => {
    const [a, b, c] = f.map(i => p[i]!) as [number[], number[], number[]]
    const ux = b[0]! - a[0]!, uy = b[1]! - a[1]!, uz = b[2]! - a[2]!, vx = c[0]! - a[0]!, vy = c[1]! - a[1]!, vz = c[2]! - a[2]!
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l
    if (nx * (a[0]! + b[0]! + c[0]!) + ny * (a[1]! + b[1]! + c[1]! - 0.6) + nz * (a[2]! + b[2]! + c[2]!) < 0) { nx = -nx; ny = -ny; nz = -nz }
    return [a, b, c].map((q): V => [q[0]!, q[1]!, q[2]!, nx, ny, nz, grey + warm, grey, grey - warm, 0.5, 0.5])
  }))
}

/** Crumpled paper scrap: a low, irregular fan (1 m across before scale). */
export function paperTemplate(seed: number) {
  const n = 7, tone = 0.62 + (seed % 3) * 0.06
  const ring = Array.from({ length: n }, (_, i) => { const a = i / n * Math.PI * 2, r = 0.38 + 0.12 * Math.sin(i * 2.7 + seed); return [Math.cos(a) * r, 0.02 + 0.05 * ((i * 5 + seed) % 3), Math.sin(a) * r] })
  return pack(ring.flatMap((p, i) => {
    const q = ring[(i + 1) % n]!
    return [[0, 0.16, 0], p, q].map((v): V => [v[0]!, v[1]!, v[2]!, 0, 1, 0, tone, tone * 0.97, tone * 0.9, 0.5, 0.5])
  }))
}

/** 2×2 atlas of fallen leaves: alder/maple-ish blades in dry browns and ochre, painted at load (no external art). */
export function paintLeafAtlas(size = 512): OffscreenCanvas {
  const canvas = new OffscreenCanvas(size, size), g = canvas.getContext("2d")!
  const cell = size / 2
  const tones = ["#6b4a22", "#8a6326", "#4a3218", "#7a5a2e"]
  for (let c = 0; c < 4; c++) {
    const cx = (c % 2) * cell + cell / 2, cy = Math.floor(c / 2) * cell + cell / 2
    g.save(); g.translate(cx, cy); g.rotate(c * 0.9)
    g.fillStyle = tones[c]!
    g.beginPath()
    const L = cell * 0.42, W = cell * (c === 1 ? 0.3 : 0.2)
    g.moveTo(0, -L); g.bezierCurveTo(W, -L * 0.4, W, L * 0.5, 0, L); g.bezierCurveTo(-W, L * 0.5, -W, -L * 0.4, 0, -L)
    g.fill()
    if (c === 1) { for (const s of [-1, 1]) { g.beginPath(); g.ellipse(s * W * 0.9, -L * 0.1, W * 0.55, L * 0.35, s * 0.6, 0, Math.PI * 2); g.fill() } }
    g.strokeStyle = "rgba(30,20,10,0.55)"; g.lineWidth = cell * 0.012
    g.beginPath(); g.moveTo(0, -L); g.lineTo(0, L * 1.15); g.stroke()
    g.restore()
  }
  return canvas
}
