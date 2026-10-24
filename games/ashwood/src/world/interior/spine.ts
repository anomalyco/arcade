import { type Builder, CEIL_Y, FLOOR_Y, LAYER, M, ceiling, doorOpening, paint, wall } from "./kit"
import { type TrofferCell, emergencyPack, exitSign, sconce, troffers } from "./lights"
import { NIGHT_EXTRA } from "./lighting-state"
import { CORE_PLAN, type DoorState, FIRE_DOOR, SHELL, WINDOWS } from "./plan"
import { type Finish, type POpening, partition } from "./partition"
import { extinguisher, bulletin } from "./fittings"
import { ROOM_BANDS, STYLES, type Style } from "./styles"

// The spine corridor (z ±1.6) of a storey: floor finish with edge stripes that stop at openings, both walls with the
// storey's finish on the corridor face and typed openings (doors, glazing, cased, open gaps), the core hall gap, ends
// (fire-escape door lining at the west, facade windows at the east), drop ceiling and the night-circuit troffers with
// their real lamps, plus fittings kept clear of every opening. Use `x0`/`x1` for part-length spines (storey 0 east).

export type SpineOpts = {
  x0?: number
  x1?: number
  /** Openings in the north (z −1.6) and south (z +1.6) walls; x is `at`/`from`/`to`. The hall gap is added for you. */
  north?: POpening[]
  south?: POpening[]
  /** Corridor-face finish (default STYLES[storey]); room-face finishes default to painted plaster. */
  finish?: Style
  northRoomFinish?: Finish
  southRoomFinish?: Finish
  /** Every Nth troffer lit (1 all, 2 every second, 0 none); real lamp on each lit one. Default 2. */
  nightCircuit?: number
  /** Troffer x positions forced lit / flickering (amount 0..1). */
  lit?: number[]
  flicker?: { x: number; amount: number }[]
  /** cd per lit troffer (default 5). */
  intensity?: number
  /** Raised access floor spans [x0, x1]. */
  raised?: [number, number][]
  /** Ladder cable tray along the ceiling. */
  tray?: boolean
  /** Incandescent wall sconces every `every` m on both walls instead of troffers (storey 4 east). */
  sconces?: { from: number; to: number; every?: number }
  /** Ceiling decay (missing tile fraction). */
  missing?: number
  /** West end: "fire" (fire-escape door opening, exit sign; storeys 1–4), "wall", or "open" (spine continues). */
  west?: "fire" | "wall" | "open"
  /** East end: "wall" (facade windows cut where the facade has them) or "open". */
  east?: "wall" | "open"
  /** Extra extinguishers / bulletins at x (moved clear of openings). */
  extinguishers?: { x: number; side: "north" | "south" }[]
  bulletins?: { x: number; side: "north" | "south" }[]
  /**
   * Cross-corridor fire-door baffles: a full-height wall across the spine at `x` with one fire door, held open against
   * the wall, in its north or south half. Alternate the halves so no straight line runs the length of the spine (the
   * hunter's sight and the lamps' reach stop at them); the solid half leaves a dark pocket to step into. `x` is moved
   * (in 0.3 m steps) clear of wall openings and the troffer line; the open leaf lies along the wall towards `swing`.
   */
  baffles?: Baffle[]
}

export type Baffle = { x: number; side: "north" | "south"; swing?: 1 | -1; state?: DoorState; leaf?: "steel" | "veneer" | "glass" }

export type SpineHandle = { update(time: number): void; cells: TrofferCell[]; clear(x: number, side: "north" | "south", width?: number): number }

const Z = 1.6
const T_SPINE = 0.15

export function spine(b: Builder, o: SpineOpts = {}): SpineHandle {
  const storey = b.storey
  const st = o.finish ?? STYLES[storey]!
  const x0 = o.x0 ?? SHELL.x0
  const x1 = o.x1 ?? SHELL.x1
  const north = [...(o.north ?? [])]
  const south = [...(o.south ?? [])]
  if (CORE_PLAN.hallOpening.x1 > x0 && CORE_PLAN.hallOpening.x0 < x1) south.push({ kind: "gap", from: CORE_PLAN.hallOpening.x0, to: CORE_PLAN.hallOpening.x1 })
  // Floor and stripes (stopping at every opening wider than a door, and the hall).
  b.floor(st.floor, x0, -Z - T_SPINE, x1, Z + T_SPINE)
  const spans = (ops: POpening[]) =>
    ops
      .map((p) => (p.kind === "door" ? null : ([p.from, p.to] as [number, number])))
      .filter((s): s is [number, number] => !!s)
      .sort((a, c) => a[0] - c[0])
  if (st.stripe)
    for (const [side, ops] of [
      [-1, north],
      [1, south],
    ] as const) {
      let cur = x0 + 0.4
      for (const [g0, g1] of [...spans(ops), [x1 - 0.4, x1] as [number, number]]) {
        if (g0 - cur > 0.2) b.box(st.stripe, cur, FLOOR_Y, side * 1.18 - 0.06, g0, FLOOR_Y + LAYER, side * 1.18 + 0.06, { cast: false })
        cur = Math.max(cur, g1)
      }
    }
  // Walls (partition handles doors, glazing, seams on solid spans).
  partition(b, { axis: "x", at: -Z - T_SPINE / 2, from: x0, to: x1, thickness: T_SPINE, finish: [o.northRoomFinish ?? ROOM_BANDS, st], openings: north })
  partition(b, { axis: "x", at: Z + T_SPINE / 2, from: x0, to: x1, thickness: T_SPINE, finish: [st, o.southRoomFinish ?? ROOM_BANDS], openings: south })
  // Ends.
  const ext = { y0: FLOOR_Y - 0.01, y1: CEIL_Y + 0.02, collide: false }
  const west = o.west ?? (storey >= 1 && x0 <= SHELL.x0 + 0.01 ? "fire" : "wall")
  if (west !== "open") {
    wall(b, "z", -Z, Z, x0, x0 + 0.04, st.bands, west === "fire" ? [doorOpening(FIRE_DOOR.z, FIRE_DOOR.width)] : [], ext)
    if (west === "fire") {
      exitSign(b, x0 + 0.04, 0, 1, 0)
      emergencyPack(b, x0 + 0.04, FLOOR_Y + 2.45, -1.0, 1, 0, NIGHT_EXTRA.emergency)
    }
  }
  if ((o.east ?? "wall") === "wall") {
    const wins = x1 >= SHELL.x1 - 0.01 ? WINDOWS(storey, "east").filter((w) => w.u0 >= -Z - 0.1 && w.u1 <= Z + 0.1) : []
    wall(b, "z", -Z, Z, x1 - 0.04, x1, st.bands, wins.map((w) => ({ a0: w.u0, a1: w.u1, bottom: w.sill, top: w.head })), ext)
  }
  // Ceiling and lights.
  ceiling(b, x0, -Z, x1, Z, o.missing ?? st.missing, 300 + storey)
  const night = NIGHT_EXTRA.spine[storey]
  const n = night && (o.nightCircuit ?? 2) === 0 ? night.circuit : night ? Math.min(o.nightCircuit ?? 2, night.circuit) || night.circuit : (o.nightCircuit ?? 2)
  const cells: TrofferCell[] = []
  const sc = o.sconces
  for (let x = Math.floor((x1 - 1.5) / 3) * 3; x >= x0 + 1.5; x -= 3) {
    const k = Math.round(x / 3)
    if (sc && x >= sc.from && x <= sc.to) continue
    let fl = o.flicker?.find((f) => Math.abs(f.x - x) < 1)
    const on = (n > 0 && k % n === 0) || !!o.lit?.some((lx) => Math.abs(lx - x) < 1) || !!fl
    // Night pass: a share of the lit fittings are tubes on their way out (deterministic per fitting).
    if (!fl && on && night && ((((k * 2654435761) >>> 0) % 1000) / 1000 < night.flicker)) fl = { x, amount: 0.7 }
    cells.push({ x, z: 0, on, flicker: fl?.amount })
  }
  const tr = troffers(b, cells, { louvre: st.louvre, intensity: o.intensity ?? 5, perLamp: 1 })
  const held = buildBaffles(b, o.baffles ?? [], { x0, x1, north, south, st, sconces: sc })
  // Openings (and the baffles with their held-open leaves) for the clearance check.
  const blocked = (side: "north" | "south") => [
    ...(side === "north" ? north : south).map((p) => (p.kind === "door" ? [p.at - 0.9, p.at + 0.9] : [p.from - 0.5, p.to + 0.5]) as [number, number]),
    ...held[side],
  ]
  const clear = (x: number, side: "north" | "south", width = 0.7) => {
    const bl = blocked(side)
    for (let k = 0; k < 40; k++) {
      const c = x + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.6
      if (c - width / 2 < x0 + 0.3 || c + width / 2 > x1 - 0.3) continue
      if (!bl.some(([a, z]) => c + width / 2 > a && c - width / 2 < z)) return c
    }
    return x
  }
  if (sc)
    for (let x = sc.from + 1; x <= sc.to - 0.5; x += sc.every ?? 4.5)
      for (const side of ["north", "south"] as const) {
        const cx = clear(x, side, 0.3)
        sconce(b, cx, side === "north" ? -Z : Z, 0, side === "north" ? 1 : -1)
      }
  if (o.tray) tray(b, x0, x1)
  for (const [a, c] of o.raised ?? []) raised(b, a, c)
  // Fittings: an extinguisher by the hall opening and by the west exit, plus any requested; bulletins.
  const fits = [...(o.extinguishers ?? [])]
  if (CORE_PLAN.hallOpening.x1 > x0 && CORE_PLAN.hallOpening.x0 < x1) fits.push({ x: CORE_PLAN.hallOpening.x0 - 1.2, side: "north" })
  if (west === "fire") fits.push({ x: x0 + 1.6, side: "north" })
  for (const f of fits) extinguisher(b, clear(f.x, f.side, 0.7), f.side === "north" ? -Z : Z)
  for (const f of o.bulletins ?? []) bulletin(b, clear(f.x, f.side, 1.8), f.side === "north" ? -Z : Z)
  return { update: tr.update, cells, clear }
}

const BAFFLE_DOOR = 1.1
/** Centre of the baffle's door off the corridor axis (its wall-side jamb 0.25 m from the corridor wall). */
const BAFFLE_DOOR_Z = Z - 0.25 - BAFFLE_DOOR / 2 - 0.05

/** Builds the spine's fire-door baffles; returns the wall spans each side must keep clear (wall end + open leaf). */
function buildBaffles(
  b: Builder,
  list: readonly Baffle[],
  o: { x0: number; x1: number; north: POpening[]; south: POpening[]; st: Style; sconces?: { from: number; to: number } },
) {
  const held: Record<"north" | "south", [number, number][]> = { north: [], south: [] }
  const halfW = (p: POpening) => (p.kind === "door" ? (p.door.width ?? (p.door.double ? 1.7 : 0.92)) / 2 : 0)
  // A wall span [a, c] meets a door frame (casings and the number plate) or a glazed / cased span or a doorway-sized
  // gap (the core hall). Open-plan edges (gaps over 6 m) don't count: a baffle may end free there.
  const hits = (ops: POpening[], a: number, c: number) =>
    ops.some((p) =>
      p.kind === "door" ? p.at + halfW(p) + 0.35 > a && p.at - halfW(p) - 0.35 < c : !(p.kind === "gap" && p.to - p.from > 6) && p.to + 0.3 > a && p.from - 0.3 < c,
    )
  const placed: number[] = []
  list.forEach((f, n) => {
    const side = f.side
    const ops = side === "north" ? o.north : o.south
    const lit = !(o.sconces && f.x >= o.sconces.from && f.x <= o.sconces.to)
    let at: number | undefined
    let dir: 1 | -1 = f.swing ?? 1
    for (let k = 0; k < 41 && at === undefined; k++) {
      const c = Math.round((f.x + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.3) * 100) / 100
      if (c < o.x0 + 1.2 || c > o.x1 - 1.2) continue
      // Keep off the troffer line (fittings every 3 m on the axis; a housing is 0.62 m long).
      if (lit && Math.abs(c - Math.round(c / 3) * 3) < 0.45) continue
      if (hits(o.north, c - 0.1, c + 0.1) || hits(o.south, c - 0.1, c + 0.1) || placed.some((q) => Math.abs(q - c) < 4)) continue
      for (const d of [dir, -dir as 1 | -1])
        if (!hits(ops, Math.min(c, c + d * 1.35), Math.max(c, c + d * 1.35))) {
          at = c
          dir = d
          break
        }
    }
    if (at === undefined) {
      console.warn(`spine baffle near x ${f.x} (storey ${b.storey}): no clear spot`)
      return
    }
    placed.push(at)
    // North half: the front faces −x (hinge on the wall side at −z); south half: +x. Open > 0 swings away from the front.
    const zc = side === "north" ? -BAFFLE_DOOR_Z : BAFFLE_DOOR_Z
    const front = side === "north" ? "a" : "b"
    const state = f.state ?? "open"
    const open = state === "open" ? 1.45 * (side === "north" ? dir : -dir) : 0
    partition(b, {
      axis: "z",
      at,
      from: -Z,
      to: Z,
      thickness: T_SPINE,
      finish: [o.st, o.st],
      openings: [{ kind: "door", at: zc, side: front, door: { id: `FD${n + 1}`, state, open, width: BAFFLE_DOOR, leaf: f.leaf, panic: true } }],
    })
    // Exit sign over the door on one face (battery-fed): the red at the end of a dark corridor.
    const nx = side === "north" ? 1 : -1
    exitSign(b, at + nx * (T_SPINE / 2), zc, nx, 0)
    const leaf: [number, number] = [Math.min(at, at + dir * 1.4) - 0.2, Math.max(at, at + dir * 1.4) + 0.2]
    held[side].push(leaf)
    held[side === "north" ? "south" : "north"].push([at - 0.4, at + 0.4])
  })
  return held
}

function tray(b: Builder, x0: number, x1: number) {
  const y = CEIL_Y - 0.32
  const z0 = 0.55
  const z1 = 0.95
  b.box("metal_galvanized", x0, y, z0, x1, y + 0.08, z0 + 0.012)
  b.box("metal_galvanized", x0, y, z1 - 0.012, x1, y + 0.08, z1)
  for (let x = x0 + 0.15; x < x1; x += 0.3) b.box("metal_galvanized", x - 0.01, y, z0 + 0.012, x + 0.01, y + 0.012, z1 - 0.012, { cast: false })
  for (let x = x0 + 0.75; x < x1; x += 1.5) {
    b.rod(M.darkSteel, [x, y, z0 - 0.02], [x, CEIL_Y, z0 - 0.02], 0.005, 4)
    b.rod(M.darkSteel, [x, y, z1 + 0.02], [x, CEIL_Y, z1 + 0.02], 0.005, 4)
    b.box(M.darkSteel, x - 0.015, y - 0.02, z0 - 0.04, x + 0.015, y, z1 + 0.04)
  }
  for (const [dz, r, mat] of [
    [0.08, 0.035, M.rubber],
    [0.17, 0.03, paint(0x5a5f62, 0.6)],
    [0.26, 0.04, M.rubber],
  ] as const)
    b.rod(mat, [x0, y + 0.012 + r, z0 + dz], [x1, y + 0.012 + r, z0 + dz], r, 6)
}

function raised(b: Builder, xa: number, xb: number) {
  const y = FLOOR_Y + 2 * LAYER
  b.box(M.raised, xa, y - 0.01, -Z, xb, y, Z, { cast: false, skip: "y" })
  for (let x = Math.ceil(xa / 0.6) * 0.6; x <= xb + 1e-3; x += 0.6) b.box(M.darkSteel, x - 0.005, y, -Z, x + 0.005, y + LAYER, Z, { cast: false })
  for (let z = -1.5; z <= Z; z += 0.6) b.box(M.darkSteel, xa, y, z - 0.005, xb, y + LAYER, z + 0.005, { cast: false })
  for (const x of [xa, xb]) b.box(M.hazard, x - 0.04, y - 0.01, -Z, x + 0.04, y + LAYER, Z, { cast: false })
}
