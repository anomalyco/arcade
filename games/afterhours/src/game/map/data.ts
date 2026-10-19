import type { WorldContext } from "../../world/context"
import { BUILDING, storeyY } from "../../world/layout"
import { solidsOf } from "../../world/interior/kit"
import { interiorDoors, interiorRooms } from "../../world/interior/registry"

// What the floor plans are drawn from: the interior's registered wall solids (world AABBs, split at openings: full
// spans, heads over doors and glazing, sills under glazing), its door registry and its room registry. Plain data, so
// it can be posted to the page worker.

export type WallKind = "full" | "low" | "head"
export type PlanWall = { x0: number; z0: number; x1: number; z1: number; kind: WallKind }
export type PlanDoor = { x: number; z: number; axis: "x" | "z"; w: number; number?: string; label?: string; state: string; room?: string; roomRect?: [number, number, number, number] }
export type PlanRoom = { id: string; name: string; x0: number; x1: number; z0: number; z1: number }
export type StoreyPlan = { walls: PlanWall[]; doors: PlanDoor[]; rooms: PlanRoom[] }
export type PlanData = { storeys: StoreyPlan[]; key: string }

const STOREYS = BUILDING.main.storeys
const H = BUILDING.main.storeyHeight

/** Cheap change detector for the registries the plans are drawn from. */
export const planKey = (ctx: WorldContext) => `${solidsOf(ctx).length}/${interiorRooms.length}/${interiorDoors.length}`

export function collectPlan(ctx: WorldContext): PlanData {
  const storeys: StoreyPlan[] = Array.from({ length: STOREYS }, () => ({ walls: [], doors: [], rooms: [] }))
  const solids = solidsOf(ctx)
  for (const s of solids) {
    const [x0, y0, z0] = s.min
    const [x1, y1, z1] = s.max
    if (x1 - x0 < 0.015 && z1 - z0 < 0.015) continue
    for (let i = 0; i < STOREYS; i++) {
      const fy = storeyY(i)
      const r0 = y0 - fy
      const r1 = y1 - fy
      // Belongs to this storey if it overlaps its room height (0.3 .. 2.6 m above the floor, or a head above doors).
      if (r1 < 0.25 || r0 > H - 0.35) continue
      const kind: WallKind = r0 < 0.5 ? (r1 > 2.4 ? "full" : "low") : "head"
      if (kind === "low" && r1 < 0.3) continue
      storeys[i]!.walls.push({ x0, z0, x1, z1, kind })
    }
  }
  for (const r of interiorRooms) {
    const st = storeys[r.storey]
    if (st) st.rooms.push({ id: r.id, name: r.name, x0: r.rect.x0, x1: r.rect.x1, z0: r.rect.z0, z1: r.rect.z1 })
  }
  for (const d of interiorDoors) {
    const st = storeys[d.storey]
    if (!st) continue
    // The opening's head piece tells the wall's direction and the opening width.
    let best: PlanWall | null = null
    let bestLen = 0
    for (const w of st.walls) {
      if (w.kind !== "head") continue
      if (d.x < w.x0 - 0.12 || d.x > w.x1 + 0.12 || d.z < w.z0 - 0.12 || d.z > w.z1 + 0.12) continue
      const len = Math.max(w.x1 - w.x0, w.z1 - w.z0)
      if (len > 2.6) continue
      if (len > bestLen) {
        best = w
        bestLen = len
      }
    }
    let axis: "x" | "z" = "x"
    let w = 0.92
    let x = d.x
    let z = d.z
    if (best) {
      axis = best.x1 - best.x0 >= best.z1 - best.z0 ? "x" : "z"
      w = Math.max(0.7, axis === "x" ? best.x1 - best.x0 : best.z1 - best.z0)
      x = axis === "x" ? (best.x0 + best.x1) / 2 : (best.x0 + best.x1) / 2
      z = axis === "x" ? (best.z0 + best.z1) / 2 : (best.z0 + best.z1) / 2
    } else {
      // No head (full-height opening or a lift gate): the nearest wall face decides.
      let near = Infinity
      for (const q of st.walls) {
        if (q.kind !== "full") continue
        const dx = Math.max(q.x0 - d.x, 0, d.x - q.x1)
        const dz = Math.max(q.z0 - d.z, 0, d.z - q.z1)
        const dist = Math.hypot(dx, dz)
        if (dist < near) {
          near = dist
          axis = q.x1 - q.x0 >= q.z1 - q.z0 ? "x" : "z"
        }
      }
    }
    const room = d.room ? interiorRooms.find((r) => r.storey === d.storey && r.id === d.room) : undefined
    st.doors.push({
      x,
      z,
      axis,
      w,
      number: d.sign?.number,
      label: d.sign?.label,
      state: d.state,
      room: d.room,
      roomRect: room ? [room.rect.x0, room.rect.x1, room.rect.z0, room.rect.z1] : undefined,
    })
  }
  return { storeys, key: planKey(ctx) }
}
