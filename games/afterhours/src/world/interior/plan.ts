import { CORE, CORRIDOR_EAST, FIRE_ESCAPE, FREIGHT, RISER, ANNEX_DOOR, BUILDING, storeyY } from "../layout"

// The building program's coordinates (docs/building-program.md §1), the single source every storey file uses.
// World metres, +x east, +z south. Heights in this file are ABOVE THE STOREY'S FINISHED FLOOR unless marked world.
// Never re-derive these in a storey file: import them.

export type Rect = { x0: number; x1: number; z0: number; z1: number }
export const rect = (x0: number, x1: number, z0: number, z1: number): Rect => ({ x0: Math.min(x0, x1), x1: Math.max(x0, x1), z0: Math.min(z0, z1), z1: Math.max(z0, z1) })

/** `r` minus the `holes` (axis-aligned), as up to 4 pieces per hole (slabs west/east, then north/south strips). */
export function subtract(r: Rect, holes: readonly Rect[]): Rect[] {
  let out: Rect[] = [r]
  for (const h of holes) {
    const next: Rect[] = []
    for (const p of out) {
      if (h.x1 <= p.x0 || h.x0 >= p.x1 || h.z1 <= p.z0 || h.z0 >= p.z1) {
        next.push(p)
        continue
      }
      const ix0 = Math.max(p.x0, h.x0)
      const ix1 = Math.min(p.x1, h.x1)
      if (ix0 > p.x0 + 1e-4) next.push({ ...p, x1: ix0 })
      if (ix1 < p.x1 - 1e-4) next.push({ ...p, x0: ix1 })
      if (h.z0 > p.z0 + 1e-4) next.push({ x0: ix0, x1: ix1, z0: p.z0, z1: h.z0 })
      if (h.z1 < p.z1 - 1e-4) next.push({ x0: ix0, x1: ix1, z0: h.z1, z1: p.z1 })
    }
    out = next
  }
  return out
}

/** Shell inner faces. */
export const SHELL: Rect = { x0: -54.65, x1: 34.65, z0: -21.65, z1: 21.65 }

/** Bay grid: partitions sit on these pier centres; bay i lies between G[i] and G[i+1] with one window each. */
export const G = [-54.65, -47.8, -42.4, -37.0, -31.6, -26.2, -20.8, -15.4, -10.0, -4.6, 0.8, 6.2, 11.6, 17.0, 22.4, 27.8, 34.65] as const
export const BAYS = G.length - 1
/** Bay i (0..15): its span and its window centre on the north/south facades. */
export const BAY = (i: number) => ({ x0: G[i]!, x1: G[i + 1]!, window: -50.5 + 5.4 * i })

/** Depth zones (|z|): spine corridor, room faces, interior zone, optional zone wall, perimeter (window) zone. */
export const ZONE = {
  /** Spine wall centre lines are at |z| 1.6..1.75 (wall thickness 0.15); corridor clear width ±1.6. */
  spine: 1.6,
  face: 1.75,
  interior: [1.75, 11.85] as const,
  zoneWall: [11.85, 12.0] as const,
  perimeter: [12.0, 21.61] as const,
  /** Exterior lining face (inside face of the room-side lining over the shell). */
  lining: 21.61,
} as const

/** Structural columns (0.45 m square, plastered) at these x, |z| = 11.9 both sides. */
export const COLUMNS = { xs: [-47.8, -37.0, -26.2, -15.4, -4.6, 6.2, 17.0, 27.8] as const, z: 11.9, size: 0.45 }

/** Walls: standard thicknesses. */
export const WALL = { spine: 0.15, partition: 0.12, stud: 0.1, lining: 0.04 } as const

export type Face = "north" | "south" | "west" | "east"
/** A window opening on a facade: u0..u1 along the face (x for north/south, z for west/east), sill/head above floor. */
export type Window = { face: Face; u0: number; u1: number; sill: number; head: number }

const MODULE = 5.4
const OPENING = 3.3
/** Same bay rule as facility/shell.ts `windowRow` (keep in step with it). Outer faces: x −55..35, z −22..22. */
function row(u0: number, u1: number, skip: [number, number][], edge = 2.2) {
  const pier = MODULE - OPENING
  const n = Math.max(0, Math.floor((u1 - u0 - edge * 2 + pier) / MODULE))
  const start = (u0 + u1) / 2 - (n * MODULE - pier) / 2
  const out: [number, number][] = []
  for (let i = 0; i < n; i++) {
    const a = start + i * MODULE
    if (!skip.some(([s0, s1]) => a + OPENING > s0 && a < s1)) out.push([a, a + OPENING])
  }
  return out
}

/** Window sill/head heights above the finished floor (the facade rows, measured from grade, minus the floor). */
export const SILL_HEAD = (storey: number) => (storey === 0 ? { sill: 1.0 - 0.16, head: 2.35 - 0.16 } : { sill: 0.95 - 0.16, head: 2.75 - 0.16 })

/**
 * Facade window openings of the main block on a storey and face (matches the facility shell). South ground skips the
 * lobby storefront and the core tower; north ground skips the dock doors; the core tower blocks the south face on every
 * storey; west upper storeys skip the fire-escape door; east has only the part north of the annex on storeys 0–1.
 */
export function WINDOWS(storey: number, face: Face): Window[] {
  const { sill, head } = SILL_HEAD(storey)
  const core: [number, number] = [-43.35, -36.05]
  const fe: [number, number] = [FIRE_ESCAPE.door.z - FIRE_ESCAPE.door.width / 2 - 1.2, FIRE_ESCAPE.door.z + FIRE_ESCAPE.door.width / 2 + 1.2]
  let spans: [number, number][] = []
  if (face === "south") spans = row(-55, 35, storey === 0 ? [[-10.5, 10.5], core] : [core])
  else if (face === "north") spans = row(-55, 35, storey === 0 ? [[-38, -21.5]] : [])
  else if (face === "west") spans = row(-22, 22, storey === 0 ? [[-12.5, -7]] : [fe])
  else spans = storey <= 1 ? row(6, 22, [], 2.6) : row(-22, 22, [[-17.2, -12.8]])
  return spans.map(([u0, u1]) => ({ face, u0, u1, sill, head }))
}

/**
 * The window spanning `u` on a face, if any. Use it before placing a partition that meets the facade: a few facade
 * windows straddle the zone line (west face z −12.45..−9.15, east face z 9.15..12.45 on storeys 2–4, and the bays
 * either side of the core on the south face), so a wall at |z| 11.85..12.0 would run into the glass. Move the wall to
 * the window's edge (`windowAt(...).u0 - 0.06` / `.u1 + 0.06`) or end it short of the lining.
 */
export function windowAt(storey: number, face: Face, u: number): Window | undefined {
  return WINDOWS(storey, face).find((w) => u > w.u0 - 0.06 && u < w.u1 + 0.06)
}

/** Windows whose opening falls inside a room's wall on the given face (the room touches that shell face). */
export function windowsOn(storey: number, r: Rect): Window[] {
  const out: Window[] = []
  const eps = 0.3
  if (r.z1 >= ZONE.lining - eps) out.push(...WINDOWS(storey, "south").filter((w) => w.u0 >= r.x0 - 0.01 && w.u1 <= r.x1 + 0.01))
  if (r.z0 <= -ZONE.lining + eps) out.push(...WINDOWS(storey, "north").filter((w) => w.u0 >= r.x0 - 0.01 && w.u1 <= r.x1 + 0.01))
  if (r.x0 <= SHELL.x0 + eps) out.push(...WINDOWS(storey, "west").filter((w) => w.u0 >= r.z0 - 0.01 && w.u1 <= r.z1 + 0.01))
  if (r.x1 >= SHELL.x1 - eps) out.push(...WINDOWS(storey, "east").filter((w) => w.u0 >= r.z0 - 0.01 && w.u1 <= r.z1 + 0.01))
  return out
}

/** The stair/lift core (built by the kit; storeys leave it alone). */
export const CORE_PLAN = {
  hall: rect(CORE.hall.min[0], CORE.hall.max[0], CORE.hall.min[1], CORE.hall.max[1]),
  /** Opening the spine's south wall must leave for the hall. */
  hallOpening: { x0: CORE.hall.min[0] - 0.15, x1: CORE.hall.max[0] + 0.15 },
  stair: rect(CORE.stair.min[0], CORE.stair.max[0], CORE.stair.min[1], CORE.stair.max[1]),
  lift: rect(CORE.lift.min[0], CORE.lift.max[0], CORE.lift.min[1], CORE.lift.max[1]),
  liftLobby: rect(CORE.liftLobby.min[0], CORE.liftLobby.max[0], CORE.liftLobby.min[1], CORE.liftLobby.max[1]),
  /** Mechanical chase between the hall and WC-M (solid, built with the service stack). */
  chase: rect(-38.35, -36.0, 1.75, 16.05),
}

/** Service stack south of the spine on every storey (built by `serviceStack`). */
export const SERVICE = {
  EL: rect(-47.8, -42.15, 1.75, 6.4),
  TC: rect(-47.8, -42.15, 6.55, 10.6),
  WCM: rect(-36.0, -32.75, 1.75, 9.6),
  JC: rect(-32.6, -29.4, 1.75, 5.0),
  STORE: rect(-32.6, -29.4, 5.15, 9.6),
  WCW: rect(-29.25, -26.2, 1.75, 9.6),
  /** Drinking fountain on the spine wall between the WC doors. */
  fountain: { x: -30.9, z: 1.6 },
  /** Whole footprint (rooms of a storey must not overlap it). */
  footprint: [rect(-47.8, -42.15, 1.75, 10.75), rect(-36.15, -26.2, 1.75, 9.75)],
}

/** Riser W-1: locked cupboard on every storey (dish feed → SL trunk). */
export const RISER_W1 = rect(RISER.min[0], RISER.max[0], RISER.min[1], RISER.max[1])
/** Freight lift FL-1 (ground ↔ Sublevel). */
export const FL1 = { car: rect(FREIGHT.car.min[0], FREIGHT.car.max[0], FREIGHT.car.min[1], FREIGHT.car.max[1]), stops: FREIGHT.stops }
/** Ground east spine and the annex door (storey 0 only). */
export const EAST_SPINE = rect(CORRIDOR_EAST.min[0], CORRIDOR_EAST.max[0], CORRIDOR_EAST.min[1], CORRIDOR_EAST.max[1])
export const ANNEX = { x: ANNEX_DOOR.x, z: ANNEX_DOOR.z, width: ANNEX_DOOR.width }
/** Fire-escape door at the spine's west end (storeys 1–4; the facility owns the leaf). */
export const FIRE_DOOR = { x: SHELL.x0, z: FIRE_ESCAPE.door.z, width: FIRE_ESCAPE.door.width }

export const STOREY_COUNT = BUILDING.main.storeys
/** World y of a storey's finished floor (the kit's local FLOOR_Y 0.16 maps to this). */
export const floorWorldY = (storey: number) => storeyY(storey) + 0.01

// ---------------------------------------------------------------------------------------------- program types

/** Door states from the program legend. Openable = open | closed | janitor (the player starts with the key). */
export type DoorState = "open" | "closed" | "janitor" | `keycard:${string}` | "locked"
/**
 * Whether door locks are enforced. Off: every door opens (Aiden: none should be locked by default). The janitor,
 * keycard and locked states stay on the doors (signs, hardware, registry) for future gameplay: turn this on, or
 * unlock per door at runtime (`door.locked`), when keys exist.
 */
export const LOCKS_ACTIVE = false
/** Can the player open a door in this state now? */
export const openable = (s: DoorState) => !LOCKS_ACTIVE || s === "open" || s === "closed" || s === "janitor"
/** Is this state a lock (for hardware: padlock, reader, key cylinder), whether or not locks are enforced? */
export const lockState = (s: DoorState) => !(s === "open" || s === "closed" || s === "janitor")

/** A room as the program lists it (§2 tables). */
export type RoomSpec = {
  /** Program id, e.g. "1-07". */
  id: string
  name: string
  rect: Rect
  /** Fittings lit at 3 a.m. (see `room()`), or "all" / "none". */
  lit?: "all" | "none" | readonly (readonly [number, number])[]
}
