import * as THREE from "three/webgpu"
import type { WorldContext } from "../context"
import { BUILDING, PARKING_LOT } from "../layout"
import { material } from "../../render/materials"
import { Batch, box, plane } from "./geo"
import { lensFollower, sodiumPole } from "./lamps"

// Parking lot in front of the building: asphalt pad, worn stall lines, curbs and wheel stops, the concrete apron and
// walk to the entrance, drainage grates and the sodium poles (one dead, one failing).

export const LOT_Y = 0.04
export const WALK_Y = 0.15

const STALL_W = 2.7
const STALL_D = 5.4
/** Central drive aisle kept clear of stalls. */
export const AISLE_X = 3.6

/** Stall rows: z of the stall head (where the wheel stop sits) and the direction cars face going in (-1 north, +1 south). */
export const ROWS: { head: number; facing: -1 | 1 }[] = [
  { head: PARKING_LOT.min[1] + 0.2, facing: -1 },
  { head: 56, facing: 1 },
  { head: 56, facing: -1 },
  { head: 74, facing: 1 },
  { head: 74, facing: -1 },
  // A single row nearer the gate, nosed south towards the entry drive.
  { head: 92, facing: 1 },
]

/** Centre of stall `i` (0 = nearest the aisle) on side `side` (-1 west, +1 east) of a row. */
export function stall(row: number, side: -1 | 1, i: number) {
  const r = ROWS[row]!
  const x = side * (AISLE_X + (i + 0.5) * STALL_W)
  const z = r.head - r.facing * (STALL_D / 2)
  return { x, z, heading: r.facing < 0 ? -Math.PI / 2 : Math.PI / 2 }
}

let seed = 11
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)

export function buildLot(ctx: WorldContext, root: THREE.Object3D) {
  const [x0, z0] = PARKING_LOT.min
  const [x1, z1] = PARKING_LOT.max
  const cx = (x0 + x1) / 2
  const cz = (z0 + z1) / 2
  const batch = new Batch()
  const asphalt = material("asphalt_lot")
  const line = material("road_line_white")
  const curb = material("concrete_wall")
  const walk = material("concrete_floor")

  // Asphalt pad, nudged above the terrain.
  const pad = plane(x1 - x0, z1 - z0)
  batch.at(asphalt, pad, cx, LOT_Y, cz)
  ctx.floors.push({ min: [x0, z0], max: [x1, z1], y: LOT_Y })

  // Stall lines: worn, some gone, some broken; double-row centre lines.
  const nStalls = Math.floor((x1 - 1.2 - AISLE_X) / STALL_W)
  ROWS.forEach((r, ri) => {
    for (const side of [-1, 1] as const) {
      for (let i = 0; i <= nStalls; i++) {
        if (rnd() < 0.12) continue
        const x = side * (AISLE_X + i * STALL_W)
        const full = rnd() < 0.75
        const len = full ? STALL_D - 0.3 : STALL_D * (0.35 + rnd() * 0.4)
        const zStart = r.head - r.facing * 0.15
        const zc = zStart - r.facing * (len / 2) - (full ? 0 : r.facing * rnd() * (STALL_D - len - 0.3))
        batch.at(line, plane(0.1, len), x, LOT_Y + 0.008, zc, rnd() * 0.01 - 0.005)
      }
      if (ri === 1 || ri === 3) {
        const span = nStalls * STALL_W
        batch.at(line, plane(span, 0.1), side * (AISLE_X + span / 2), LOT_Y + 0.008, r.head)
      }
    }
  })

  // Concrete wheel stops in most stalls: 1.8 m long in a 2.7 m stall with only a few cm of drift, so neighbours and
  // back-to-back rows never touch; none in the stalls beside the pole footings on the double-row head lines.
  const poleX = AISLE_X + 6 * STALL_W
  ROWS.forEach((r, ri) => {
    for (const side of [-1, 1] as const) {
      for (let i = 0; i < nStalls; i++) {
        if (rnd() < 0.3) continue
        const s = stall(ri, side, i)
        const jitter = (rnd() - 0.5) * 0.12
        const yaw = (rnd() - 0.5) * 0.03
        if ((r.head === 56 || r.head === 74) && Math.abs(Math.abs(s.x) - poleX) < 1.6) continue
        const z = r.head - r.facing * 0.55
        batch.at(curb, box(1.8, 0.12, 0.16), s.x + jitter, LOT_Y + 0.06, z, yaw)
        batch.at(curb, box(1.7, 0.03, 0.1), s.x + jitter, LOT_Y + 0.13, z, yaw)
        ctx.colliders.push({ min: [s.x + jitter - 0.9, 0, z - 0.1], max: [s.x + jitter + 0.9, 0.2, z + 0.1] })
      }
    }
  })

  // Curbs on the west, east and south edges (gap for the access road) and the walk along the north edge.
  const curbH = WALK_Y + 0.02
  const curbRun = (ax: number, az: number, bx: number, bz: number) => {
    const w = Math.max(Math.abs(bx - ax), 0.18)
    const d = Math.max(Math.abs(bz - az), 0.18)
    batch.at(curb, box(w, curbH, d), (ax + bx) / 2, curbH / 2, (az + bz) / 2)
  }
  curbRun(x0 - 0.09, z0, x0 - 0.09, z1 + 0.18)
  curbRun(x1 + 0.09, z0, x1 + 0.09, z1 + 0.18)
  curbRun(x0 - 0.18, z1 + 0.09, -5.2, z1 + 0.09)
  curbRun(5.2, z1 + 0.09, x1 + 0.18, z1 + 0.09)

  // North walk along the lot, split where the facility's entrance walk meets it.
  const ent = BUILDING.entrance
  const walkN = z0 - 2.6
  const slab = (ax: number, az: number, bx: number, bz: number) => {
    const w = bx - ax
    const d = bz - az
    batch.at(walk, box(w, WALK_Y, d), (ax + bx) / 2, WALK_Y / 2, (az + bz) / 2)
    ctx.floors.push({ min: [ax, az], max: [bx, bz], y: WALK_Y })
    // Expansion joints every 1.5 m along the long side.
    const joint = material("concrete_dark")
    if (w > d) for (let s = ax + 1.5; s < bx - 0.2; s += 1.5) batch.at(joint, box(0.015, 0.004, d - 0.02), s, WALK_Y + 0.001, (az + bz) / 2)
    else for (let s = az + 1.5; s < bz - 0.2; s += 1.5) batch.at(joint, box(w - 0.02, 0.004, 0.015), (ax + bx) / 2, WALK_Y + 0.001, s)
  }
  // The facility owns the canopy landing and the entrance walk (x ±2.6 up to the lot edge); leave a gap for it.
  const gap = 2.6
  slab(x0 - 0.18, walkN, ent.x - gap, z0)
  slab(ent.x + gap, walkN, x1 + 0.18, z0)
  // Curb face along the lot side of the north walk.
  batch.at(curb, box(x1 - x0 + 0.36, 0.02, 0.2), cx, WALK_Y + 0.01, z0 - 0.1)

  // Drainage grates: a dark recess with a steel grille.
  const grate = material("metal_dark")
  for (const [gx, gz] of [
    [0, 52],
    [0, 70],
    [-22, 46],
    [22, 64],
    [-30, 84],
    [14, 98],
    [-6, 106],
  ] as const) {
    batch.at(material("concrete_dark"), box(1.0, 0.012, 0.7), gx, LOT_Y + 0.002, gz)
    batch.at(material("rubber"), box(0.8, 0.012, 0.5), gx, LOT_Y + 0.004, gz)
    for (let k = -0.35; k <= 0.36; k += 0.07) batch.at(grate, box(0.025, 0.014, 0.5), gx + k, LOT_Y + 0.006, gz)
    batch.at(grate, box(0.82, 0.016, 0.03), gx, LOT_Y + 0.007, gz - 0.26)
    batch.at(grate, box(0.82, 0.016, 0.03), gx, LOT_Y + 0.007, gz + 0.26)
  }

  batch.build(root, { castShadow: (m) => m === curb, receiveShadow: true, name: "lot" })

  // Sodium poles on footings. Only two burn (one of them failing); the rest are dead, so the lot is mostly dark
  // between two pools of light (r5-01).
  const poles = new Batch()
  const pole = (x: number, z: number, heading: number, state: "on" | "dead" | "flicker", shadow: boolean) =>
    sodiumPole(ctx, poles, { x, z, height: 9.2, heading, arm: 1.6, style: "shoebox", state, shadow, intensity: 3600, range: 34, footing: 0.6 })
  const bx = AISLE_X + 6 * STALL_W
  pole(-bx, 56, Math.PI / 2, "dead", false)
  const failing = pole(bx, 56, Math.PI / 2, "flicker", true)
  pole(-bx, 74, Math.PI / 2, "dead", false)
  pole(bx, 74, Math.PI / 2, "dead", false)
  pole(-AISLE_X - 4.5, 100, 0, "on", true)
  poles.build(root, { castShadow: true, name: "lot-poles" })
  return failing ? lensFollower(failing) : null
}
