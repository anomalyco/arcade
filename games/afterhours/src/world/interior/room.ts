import { MODELS } from "../../render/models"
import { type Builder, type Mat, CEIL_Y, FLOOR_Y, M, T, ceiling, paint, wall } from "./kit"
import { type TrofferCell, troffers, trofferGrid } from "./lights"
import { NIGHT_EXTRA } from "./lighting-state"
import { COLUMNS, type Face, type Rect, type RoomSpec, SHELL, WALL, type Window, ZONE, subtract, windowsOn } from "./plan"
import { column } from "./partition"
import { placeModels } from "./props"
import { type Anchor, interiorRooms } from "./registry"
import { blindMats } from "./finishes"
import { ROOM_BANDS } from "./styles"

// A room's own surfaces: floor finish, drop ceiling, troffer grid with its lit fittings and real lamps, the exterior
// lining with the facade windows (sills, radiators, blinds) on every side that touches the shell, and the structural
// columns inside it. Walls to neighbours are partitions (partition.ts), built separately, so rooms can share them.

export type RoomOpts = RoomSpec & {
  floor?: Mat
  /** Drop ceiling: missing tile fraction (decay), seed; `none` for open plenum / no ceiling. */
  ceiling?: { missing?: number; seed?: number; none?: boolean }
  /** Troffer layout (grid spacing, louvres, warm tint, cd per lit pair), or false for no troffers. */
  troffers?: false | { dx?: number; dz?: number; louvre?: boolean; warm?: boolean; intensity?: number; flicker?: readonly (readonly [number, number])[]; /** Lit fittings per registered lamp (default 2). */ perLamp?: number }
  /** Extra openings cut in the exterior lining (exterior doors, dock openings), in the face's u (x on north/south, z on
   *  west/east) with heights above the floor. The facility owns the opening in the shell itself. */
  liningOpenings?: { face: Face; u0: number; u1: number; top: number; bottom?: number }[]
  /** Facade windows on shell sides: blinds and what sits under the sill; false = bare lining. */
  windows?: false | { blinds?: "random" | "closed" | "open" | "up"; radiators?: "models" | "convector" | "none" }
  /** Areas inside `rect` that are not this room (riser W-1, a column chase, a cupboard): no floor or ceiling there.
   *  The cut-out's own walls are the caller's (e.g. `riserW1`). */
  exclude?: Rect[]
  /** Columns from the structural grid that fall inside the room (default true). */
  columns?: boolean
  anchors?: Anchor[]
}

export type RoomHandle = {
  id: string
  rect: Rect
  /** World (x, z) at fractions u (west→east) and v (north→south) of the room. */
  at(u: number, v: number): [number, number]
  centre: [number, number]
  /** Troffer cells laid (with on/off). */
  cells: TrofferCell[]
  windows: Window[]
  /** Call from the storey's update (flickering fittings). */
  update(time: number): void
}

const hashStr = (s: string) => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0) % 2147483646 || 1
}

export function room(b: Builder, o: RoomOpts): RoomHandle {
  const r = o.rect
  let seed = hashStr(`${b.storey}:${o.id}`)
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const pieces = subtract(r, o.exclude ?? [])
  for (const p of pieces) b.floor(o.floor ?? "linoleum", p.x0, p.z0, p.x1, p.z1)
  if (!o.ceiling?.none) for (const p of pieces) ceiling(b, p.x0, p.z0, p.x1, p.z1, o.ceiling?.missing ?? 0, o.ceiling?.seed ?? seed % 997)
  // Troffers and lamps.
  let cells: TrofferCell[] = []
  let update = (_t: number) => {}
  if (o.troffers !== false) {
    const t = o.troffers ?? {}
    const ex = o.exclude ?? []
    const grid = trofferGrid(r, t.dx, t.dz).filter((c) => !ex.some((h) => c.x + 0.31 > h.x0 && c.x - 0.31 < h.x1 && c.z + 0.61 > h.z0 && c.z - 0.61 < h.z1))
    const lit = o.lit ?? "none"
    const litSet = new Set<number>()
    const extra = NIGHT_EXTRA.rooms[o.id] ?? []
    if (lit === "all") grid.forEach((_, i) => litSet.add(i))
    else
      for (const [px, pz] of [...(lit === "none" ? [] : lit), ...extra]) {
        let best = -1
        let bd = Infinity
        grid.forEach((c, i) => {
          const d = Math.hypot(c.x - px, c.z - pz)
          if (d < bd) (bd = d), (best = i)
        })
        if (best >= 0) litSet.add(best)
      }
    const flick = t.flicker ?? []
    cells = grid.map((c, i) => ({ ...c, on: litSet.has(i), flicker: flick.some(([fx, fz]) => Math.hypot(fx - c.x, fz - c.z) < 0.7) && litSet.has(i) ? 0.8 : undefined }))
    const h = troffers(b, cells, { louvre: t.louvre, warm: t.warm, intensity: t.intensity, perLamp: t.perLamp })
    update = h.update
  }
  // Exterior lining and windows.
  const wins = windowsOn(b.storey, r)
  for (const face of ["north", "south", "west", "east"] as Face[]) lining(b, r, face, wins.filter((w) => w.face === face), (o.liningOpenings ?? []).filter((l) => l.face === face))
  if (o.windows !== false) for (const w of wins) dressWindow(b, w, o.windows ?? {}, rnd)
  // Columns.
  if (o.columns ?? true)
    for (const x of COLUMNS.xs)
      for (const z of [-COLUMNS.z, COLUMNS.z])
        if (x > r.x0 + 0.3 && x < r.x1 - 0.3 && z > r.z0 + 0.3 && z < r.z1 - 0.3 && !(o.exclude ?? []).some((h) => x > h.x0 && x < h.x1 && z > h.z0 && z < h.z1)) column(b, x, z, COLUMNS.size)
  interiorRooms.push({ id: o.id, storey: b.storey, name: o.name, rect: r, lit: cells.some((c) => c.on), doors: [], anchors: o.anchors ?? [] })
  return {
    id: o.id,
    rect: r,
    at: (u, v) => [r.x0 + (r.x1 - r.x0) * u, r.z0 + (r.z1 - r.z0) * v],
    centre: [(r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2],
    cells,
    windows: wins,
    update,
  }
}

/** Lining over the shell's inner face on one side of the room, with that face's window openings. */
function lining(b: Builder, r: Rect, face: Face, wins: Window[], extra: { u0: number; u1: number; top: number; bottom?: number }[]) {
  const eps = 0.3
  const ext = { y0: FLOOR_Y - 0.01, y1: CEIL_Y + 0.02, collide: false }
  const holes = [...wins.map((w) => ({ a0: w.u0, a1: w.u1, bottom: w.sill, top: w.head })), ...extra.map((l) => ({ a0: l.u0, a1: l.u1, top: l.top, bottom: l.bottom }))]
  if (face === "south" && r.z1 >= ZONE.lining - eps) wall(b, "x", r.x0, r.x1, ZONE.lining, SHELL.z1, ROOM_BANDS, holes, ext)
  if (face === "north" && r.z0 <= -ZONE.lining + eps) wall(b, "x", r.x0, r.x1, SHELL.z0, -ZONE.lining, ROOM_BANDS, holes, ext)
  if (face === "west" && r.x0 <= SHELL.x0 + eps) wall(b, "z", r.z0, r.z1, SHELL.x0, SHELL.x0 + WALL.lining, ROOM_BANDS, holes, ext)
  if (face === "east" && r.x1 >= SHELL.x1 - eps) wall(b, "z", r.z0, r.z1, SHELL.x1 - WALL.lining, SHELL.x1, ROOM_BANDS, holes, ext)
}

const SILL_BOARD = paint(0x8b8878, 0.6)

/**
 * Sill board, under-sill heating (cast-iron radiator models or a convector cover) and a venetian blind for one facade
 * window. Works on every face.
 */
export function dressWindow(b: Builder, w: Window, o: { blinds?: "random" | "closed" | "open" | "up"; radiators?: "models" | "convector" | "none" }, rnd: () => number) {
  // Frame: u along the face, n = inward normal, f = lining face coordinate.
  const ns = w.face === "south" ? -1 : w.face === "north" ? 1 : w.face === "west" ? 1 : -1
  const f = w.face === "south" ? ZONE.lining : w.face === "north" ? -ZONE.lining : w.face === "west" ? SHELL.x0 + WALL.lining : SHELL.x1 - WALL.lining
  const alongX = w.face === "south" || w.face === "north"
  const yaw = w.face === "south" ? Math.PI : w.face === "north" ? 0 : w.face === "west" ? -Math.PI / 2 : Math.PI / 2
  const P = (u: number, d: number): [number, number] => (alongX ? [u, f + ns * d] : [f + ns * d, u])
  const bx = (u0: number, u1: number, d0: number, d1: number, y0: number, y1: number, mat: Mat, cast = true) => {
    const [ax, az] = P(u0, d0)
    const [cx, cz] = P(u1, d1)
    b.box(mat, ax, y0, az, cx, y1, cz, { cast })
  }
  const mid = (w.u0 + w.u1) / 2
  const len = w.u1 - w.u0
  bx(w.u0 - 0.05, w.u1 + 0.05, -0.02, 0.16, FLOOR_Y + w.sill - 0.025, FLOOR_Y + w.sill + 0.005, SILL_BOARD)
  const rad = o.radiators ?? "convector"
  if (rad === "models") {
    const [rw, , rd] = MODELS.radiator.size
    placeModels(b, "radiator", [-0.5, 0.5].map((k) => ({ position: pos3(P(mid + k * (rw + 0.06), rd / 2 + 0.05)), yaw: yaw + Math.PI, inset: 0 })))
    const [p0x, p0z] = P(mid - rw - 0.1, rd / 2 + 0.05)
    const [p1x, p1z] = P(mid + rw + 0.1, rd / 2 + 0.05)
    b.rod(M.darkSteel, [p0x, FLOOR_Y + 0.08, p0z], [p1x, FLOOR_Y + 0.08, p1z], 0.012, 8)
  } else if (rad === "convector") {
    bx(mid - 1.1, mid + 1.1, 0.03, 0.17, FLOOR_Y + 0.13, FLOOR_Y + 0.63, M.beige)
    for (let k = 0; k < 22; k++) bx(mid - 1.0 + k * 0.095, mid - 0.97 + k * 0.095, 0.05, 0.15, FLOOR_Y + 0.63, FLOOR_Y + 0.635, M.darkSteel, false)
    const [ax, az] = P(mid - 1.1, 0)
    const [cx, cz] = P(mid + 1.1, 0.2)
    b.collide(ax, FLOOR_Y, az, cx, FLOOR_Y + 0.65, cz)
  }
  const mode = o.blinds ?? "random"
  const drop = mode === "up" ? 0.06 : mode === "closed" || mode === "open" ? 1 : rnd() < 0.15 ? 0.06 : 0.35 + rnd() * 0.65
  const mat = mode === "open" ? blindMats.open : mode === "closed" ? blindMats.closed : rnd() < 0.4 ? blindMats.open : blindMats.closed
  const h = (w.head - w.sill) * drop
  const yTop = FLOOR_Y + w.head - 0.02
  bx(w.u0 + 0.02, w.u1 - 0.02, 0.02, 0.07, yTop - 0.04, yTop, M.beige, false)
  const crooked = mode === "random" && rnd() < 0.2 ? (rnd() - 0.5) * 0.12 : 0
  const [qx, qz] = P(mid, 0.045)
  b.quad(mat, T(qx, yTop - 0.04 - h / 2, qz, yaw, 0, crooked), len - 0.06, h, { cast: false })
  bx(w.u0 + 0.03, w.u1 - 0.03, 0.03, 0.06, yTop - 0.06 - h, yTop - 0.04 - h, M.beige, false)
}

const pos3 = ([x, z]: [number, number]) => [x, FLOOR_Y + 0.02, z] as const
