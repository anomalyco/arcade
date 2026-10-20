import * as THREE from "three/webgpu"
import { abs, max, min, smoothstep, vec3 } from "three/tsl"
import type { Lamp } from "../world/context"
import { BOOTH, BUILDING, CORE, ROOF_Y, storeyY } from "../world/layout"

// Interior volumes shared by fog, ambient, lamp zoning and light masking: the main block, its stair/lift core, the
// annex and the guard booth. Outer bounds (the walls' outside faces); "inside" tests inset by half a wall so outside
// faces read as exterior and inside faces as interior.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any

export type Box = { min: readonly [number, number, number]; max: readonly [number, number, number]; building: boolean }

const ROOF_TOP = ROOF_Y - 0.2
export const VOLUMES: Box[] = [
  { min: [BUILDING.main.min[0], -1, BUILDING.main.min[1]], max: [BUILDING.main.max[0], ROOF_TOP, BUILDING.main.max[1]], building: true },
  { min: [CORE.stair.min[0] - 0.35, -1, BUILDING.main.max[1] - 0.5], max: [CORE.lift.max[0] + 0.35, ROOF_TOP, CORE.stair.max[1] + 0.3], building: true },
  { min: [BUILDING.annex.min[0], -1, BUILDING.annex.min[1]], max: [BUILDING.annex.max[0], BUILDING.annex.height - 0.4, BUILDING.annex.max[1]], building: true },
  { min: [BOOTH.x - BOOTH.w / 2, -1, BOOTH.z - BOOTH.d / 2], max: [BOOTH.x + BOOTH.w / 2, BOOTH.h, BOOTH.z + BOOTH.d / 2], building: false },
]
const HALF_WALL = BUILDING.wallThickness / 2

/** Signed distance (metres, negative inside) to a box. Cheap; used in shaders as a soft membership. */
const boxSdf = (p: N, b: Box) => {
  const c = vec3((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2)
  const h = vec3((b.max[0] - b.min[0]) / 2, (b.max[1] - b.min[1]) / 2, (b.max[2] - b.min[2]) / 2)
  const q = abs(p.sub(c)).sub(h)
  return max(max(q.x, q.y), q.z)
}

/** Soft 0..1 "inside any interior volume" in a shader, ramping over `soft` metres across the wall (doors blend). */
export const insideNode = (p: N, soft = 0.3, buildingOnly = false) => {
  let m: N = null
  for (const b of VOLUMES) {
    if (buildingOnly && !b.building) continue
    const d = boxSdf(p, b)
    m = m === null ? d : (m as N).min(d)
  }
  return smoothstep(soft - HALF_WALL, -HALF_WALL - soft, m)
}

function boxDist(p: THREE.Vector3, b: Box) {
  const dx = Math.max(b.min[0] - p.x, p.x - b.max[0])
  const dy = Math.max(b.min[1] - p.y, p.y - b.max[1])
  const dz = Math.max(b.min[2] - p.z, p.z - b.max[2])
  return Math.max(dx, dy, dz)
}

/** True when a point is inside the building (main block, core, annex); the booth counts only with `booth`. */
export function inside(p: THREE.Vector3, booth = false) {
  for (const b of VOLUMES) if ((b.building || booth) && boxDist(p, b) < -HALF_WALL) return true
  return false
}

export function distanceToBuilding(p: THREE.Vector3) {
  let d = Infinity
  for (const b of VOLUMES) if (b.building) d = Math.min(d, Math.max(0, boxDist(p, b)))
  return d
}

export const STOREYS = BUILDING.main.storeys
export const STOREY_H = BUILDING.main.storeyHeight

/** Storey index for a height inside the main block (clamped). */
export function storeyAt(y: number) {
  return Math.min(STOREYS - 1, Math.max(0, Math.floor((y - storeyY(0) + 0.05) / STOREY_H)))
}

export type LampZone = { interior: boolean; storey: number }

/** A lamp's zone: its own `zone` ("interior:N" / "exterior") when given, otherwise from where it hangs. */
export function lampZone(l: Lamp): LampZone {
  const z = l.zone
  if (z?.startsWith("interior")) {
    const n = Number(z.split(":")[1])
    return { interior: true, storey: Number.isFinite(n) ? n : storeyAt(l.position[1]) }
  }
  if (z === "exterior") return { interior: false, storey: -1 }
  const p = _p.set(l.position[0], l.position[1], l.position[2])
  const inBuilding = inside(p)
  return { interior: inBuilding, storey: inBuilding ? storeyAt(p.y) : -1 }
}
const _p = new THREE.Vector3()

/** Vertical extent of a storey (floor slab top to just under the next floor) for clipping its lamps. */
export function storeySlab(n: number): [number, number] {
  const y0 = storeyY(n)
  return [y0 - 0.12, y0 + STOREY_H - 0.25]
}

/** Shader: does the segment o + d·[0, len] (d unit) pass within `pad` metres of any interior volume? */
export const segmentTouchesNode = (o: N, d: N, len: N, pad = 0.6) => {
  let any: N = null
  const inv = vec3(1).div(d.add(vec3(1e-6)))
  for (const b of VOLUMES) {
    const ta = vec3(b.min[0] - pad, b.min[1] - pad, b.min[2] - pad).sub(o).mul(inv)
    const tb = vec3(b.max[0] + pad, b.max[1] + pad, b.max[2] + pad).sub(o).mul(inv)
    const lo = min(ta, tb)
    const hi = max(ta, tb)
    const t0 = max(max(lo.x, lo.y), max(lo.z, 0))
    const t1 = min(min(hi.x, hi.y), min(hi.z, len))
    const hit = t1.greaterThan(t0)
    any = any === null ? hit : (any as N).or(hit)
  }
  return any
}
