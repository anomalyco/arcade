import { mulberry32 } from "./rng"

// Rule-based ground clutter. Clutter gathers along features (kerbs, fence and wall bases, road shoulders, prop bases) and
// keeps clear of padded 2D obstacles (paths, doors, colliders) found through a spatial hash of signed distances.
// After Tidewater's src/world/debris/DebrisPlacement.js (MIT, © 2026 DRG Software Solutions LLC,
// https://github.com/dgreenheck/tidewater): the obstacle hash and box/capsule distances follow it; the rule format is ours.
// Pure and deterministic: each rule draws from its own seeded stream, and every candidate draws the same random numbers
// whatever the density, so raising a density only adds items and never moves the ones already placed.

export type Vec2 = readonly [number, number]

/** A feature clutter collects along: an open polyline, or the perimeter of an axis-aligned box. */
export type DebrisFeature = { line: readonly Vec2[] } | { box: { min: Vec2; max: Vec2 } } | { circle: { c: Vec2; r: number } }

export type DebrisObstacle = { pad?: number } & (
  | { box: { min: Vec2; max: Vec2 } }
  | { circle: { c: Vec2; r: number } }
  | { capsule: { a: Vec2; b: Vec2; r: number } }
)

export type DebrisRule = {
  /** Caller's catalogue entry. */
  item: string
  /** Density group: the caller scales each group (weeds, leaves, litter, gravel…). */
  group: string
  along: readonly DebrisFeature[]
  /** Perpendicular distance from the feature (m). Boxes and circles measure outward; lines use `side`. */
  offset: readonly [number, number]
  /** Lines: +1 left of travel, −1 right, 0 both. */
  side?: -1 | 0 | 1
  /** Mean metres between cluster centres along the feature. */
  spacing: number
  /** Chance a candidate cluster is placed at density 1. */
  chance?: number
  /** Items per cluster and their spread along the feature (m). */
  cluster?: { count: readonly [number, number]; spread: number }
  scale: readonly [number, number]
  /** Turn items to follow the feature (±jitter rad) instead of a random yaw. */
  align?: number
  /** Minimum clearance from obstacles (m). */
  clearance?: number
}

export type DebrisInstance = { item: string; group: string; x: number; z: number; yaw: number; scale: number; seed: number }

type Shape = { kind: 0 | 1 | 2; x: number; z: number; hx: number; hz: number; bx: number; bz: number; r: number; pad: number }

/** Padded obstacles in a 2D spatial hash; `clearance` is the signed distance (m) to the nearest, clamped at `far`. */
export class DebrisObstacles {
  private map = new Map<number, Shape[]>()
  constructor(obstacles: readonly DebrisObstacle[] = [], readonly cell = 4, readonly far = 3) { for (const o of obstacles) this.add(o) }
  add(o: DebrisObstacle) {
    const pad = o.pad ?? 0
    let s: Shape, x0: number, z0: number, x1: number, z1: number
    if ("box" in o) {
      const { min, max } = o.box
      s = { kind: 0, x: (min[0] + max[0]) / 2, z: (min[1] + max[1]) / 2, hx: (max[0] - min[0]) / 2, hz: (max[1] - min[1]) / 2, bx: 0, bz: 0, r: 0, pad }
      ;[x0, z0, x1, z1] = [min[0], min[1], max[0], max[1]]
    } else if ("circle" in o) {
      const { c, r } = o.circle
      s = { kind: 1, x: c[0], z: c[1], hx: 0, hz: 0, bx: 0, bz: 0, r, pad }
      ;[x0, z0, x1, z1] = [c[0] - r, c[1] - r, c[0] + r, c[1] + r]
    } else {
      const { a, b, r } = o.capsule
      s = { kind: 2, x: a[0], z: a[1], hx: 0, hz: 0, bx: b[0], bz: b[1], r, pad }
      ;[x0, z0, x1, z1] = [Math.min(a[0], b[0]) - r, Math.min(a[1], b[1]) - r, Math.max(a[0], b[0]) + r, Math.max(a[1], b[1]) + r]
    }
    const m = pad + this.far, c = this.cell
    for (let j = Math.floor((z0 - m) / c); j <= Math.floor((z1 + m) / c); j++) for (let i = Math.floor((x0 - m) / c); i <= Math.floor((x1 + m) / c); i++) {
      const k = key(i, j)
      const list = this.map.get(k)
      if (list) list.push(s); else this.map.set(k, [s])
    }
  }
  clearance(x: number, z: number) {
    const list = this.map.get(key(Math.floor(x / this.cell), Math.floor(z / this.cell)))
    let best = this.far
    for (const s of list ?? []) best = Math.min(best, shapeDistance(s, x, z) - s.pad)
    return best
  }
}

const key = (i: number, j: number) => (i * 73856093) ^ (j * 19349663)

function shapeDistance(s: Shape, x: number, z: number) {
  if (s.kind === 1) return Math.hypot(x - s.x, z - s.z) - s.r
  if (s.kind === 0) {
    const qx = Math.abs(x - s.x) - s.hx, qz = Math.abs(z - s.z) - s.hz
    return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0)
  }
  const abx = s.bx - s.x, abz = s.bz - s.z
  const t = Math.max(0, Math.min(1, ((x - s.x) * abx + (z - s.z) * abz) / (abx * abx + abz * abz || 1)))
  return Math.hypot(x - s.x - abx * t, z - s.z - abz * t) - s.r
}

/** Path of a feature. Boxes and circles run so that the left of travel, (−tz, tx), points outward. */
function featurePath(f: DebrisFeature): { points: Vec2[]; closed: boolean } {
  if ("line" in f) return { points: [...f.line], closed: false }
  if ("box" in f) {
    const { min, max } = f.box
    return { points: [[min[0], min[1]], [min[0], max[1]], [max[0], max[1]], [max[0], min[1]]], closed: true }
  }
  const { c, r } = f.circle, n = Math.max(8, Math.ceil(r * 12))
  return { points: Array.from({ length: n }, (_, i): Vec2 => [c[0] + Math.cos(-i / n * Math.PI * 2) * r, c[1] + Math.sin(-i / n * Math.PI * 2) * r]), closed: true }
}

/** Densities above 1 grow clusters, up to this many times their authored size. */
export const MAX_DENSITY = 3

const hashString = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0 }

export function placeDebris(rules: readonly DebrisRule[], obstacles: DebrisObstacles, options: { seed: number; density: Readonly<Record<string, number>> }): DebrisInstance[] {
  const out: DebrisInstance[] = []
  rules.forEach((rule, ri) => {
    const density = Math.max(0, options.density[rule.group] ?? 0)
    const rnd = mulberry32((options.seed ^ hashString(rule.item) ^ Math.imul(ri + 1, 0x9e3779b1)) >>> 0)
    const chance = rule.chance ?? 1
    for (const feature of rule.along) {
      const { points, closed } = featurePath(feature)
      const segments = closed ? points.length : points.length - 1
      let s = rnd() * rule.spacing
      for (let si = 0; si < segments; si++) {
        const a = points[si]!, b = points[(si + 1) % points.length]!
        const len = Math.hypot(b[0] - a[0], b[1] - a[1])
        if (len < 1e-6) continue
        const tx = (b[0] - a[0]) / len, tz = (b[1] - a[1]) / len
        const nx = -tz, nz = tx
        for (; s < len; s += rule.spacing * (0.5 + rnd())) {
          const accept = rnd(), countR = rnd(), sideR = rnd()
          const [c0, c1] = rule.cluster?.count ?? [1, 1]
          const count = c0 + Math.floor(countR * (c1 - c0 + 1))
          const side = rule.side === undefined || !("line" in feature) ? 1 : rule.side === 0 ? (sideR < 0.5 ? -1 : 1) : rule.side
          const placed = accept < chance * Math.min(density, 1)
          // Above density 1, more items join each placed cluster (up to MAX_DENSITY×).
          const n = Math.round(count * Math.min(MAX_DENSITY, Math.max(1, density)))
          for (let k = 0; k < c1 * MAX_DENSITY; k++) {
            const along = s + (rnd() - 0.5) * 2 * (rule.cluster?.spread ?? 0)
            const off = rule.offset[0] + rnd() * (rule.offset[1] - rule.offset[0])
            const yawR = rnd(), scaleR = rnd(), seed = rnd()
            if (!placed || k >= n) continue
            const x = a[0] + tx * along + nx * off * side, z = a[1] + tz * along + nz * off * side
            if (obstacles.clearance(x, z) < (rule.clearance ?? 0)) continue
            const yaw = rule.align === undefined ? yawR * Math.PI * 2 : Math.atan2(tz, tx) + (yawR - 0.5) * 2 * rule.align
            out.push({ item: rule.item, group: rule.group, x, z, yaw, scale: rule.scale[0] + scaleR * (rule.scale[1] - rule.scale[0]), seed })
          }
        }
        s -= len
      }
    }
  })
  return out
}
