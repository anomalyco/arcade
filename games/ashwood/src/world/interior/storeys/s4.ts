import type { DocumentPlacement } from "../../../render/documents"
import {
  addDocuments,
  type Builder,
  type POpening,
  type StoreyContext,
  type StoreyHandle,
  type Style,
  CEIL_Y,
  DOOR_H,
  FLOOR_Y,
  M,
  PUDDLE,
  ROOM_BANDS,
  STYLES,
  T,
  hangingTroffer,
  partition,
  serviceStack,
  spine,
} from "../api"
import { type S4, floorPatches, paper, plasticX } from "./s4/common"
import { buildEast } from "./s4/east"
import { BROADLOOM, EXEC_BANDS, PLY, PLY_BANDS, TIMBER } from "./s4/mats"
import { rng } from "./s4/props"
import { buildWest } from "./s4/west"

/**
 * Storey 4 — Directorate / refurbishment (building program §2). West of the plywood hoarding at x −4.6 the former
 * Atmospheric Modelling Division is stripped to its steel studs (s4/west.ts); east of it the Directorate's carpeted,
 * walnut-panelled corridor runs to the Director's locked, lit door (s4/east.ts). Services keep running (taped "out of
 * order"). Small vignette props and the paperwork are drawn only on this storey (`b.small`).
 */

const HOARD_X = -4.6
const HOARD_T = 0.05

/** Directorate corridor finish (also the room faces of its panelled rooms). */
const EXEC: Style = { floor: BROADLOOM, bands: EXEC_BANDS, stripe: null, missing: 0, louvre: false }

export async function build(b: Builder, { pause }: StoreyContext): Promise<StoreyHandle> {
  const sb = b.smallBuilder
  const docs: DocumentPlacement[] = []
  const s: S4 = { b, sb, docs, rnd: rng(4401) }

  // ---------------------------------------------------------------- services (kept running) + west spine
  const svc = serviceStack(b, { refurb: true })
  const west = spine(b, {
    x1: HOARD_X - HOARD_T / 2,
    east: "open",
    finish: STYLES[4],
    nightCircuit: 0,
    north: [{ kind: "gap", from: -54.65, to: HOARD_X }],
    south: [
      { kind: "gap", from: -54.65, to: -47.8 },
      ...svc.spineOpenings,
      { kind: "door", at: -17.6, side: "a", door: { id: "4-02", state: "closed", room: "4-02s", sign: { number: "4-02", label: "SITE OFFICE" } } },
      { kind: "gap", from: -15.4, to: HOARD_X },
    ],
  })
  // Corridor decay: remnant vinyl and mastic on the slab, two fittings hanging out of the grid, a slit dust curtain.
  floorPatches(b, { x0: -54.4, x1: HOARD_X - 0.2, z0: -1.5, z1: 1.5 }, "linoleum", 9, s.rnd, 1)
  hangingTroffer(b, -22.5, s.rnd)
  hangingTroffer(b, -10.5, s.rnd)
  plasticX(b, -12.9, -1.6, -0.28, s.rnd, 0.05, "z")
  plasticX(b, -12.85, 0.32, 1.6, s.rnd, 0.05, "z")
  for (const [x, z, w] of [[-36.6, 0.6, 1.2], [-20.2, -0.5, 0.9], [-8.4, 0.4, 1.4]] as const) b.quad(PUDDLE, T(x, FLOOR_Y + 0.003, z, s.rnd() * 3, -Math.PI / 2), w, w * 0.6, { cast: false })
  // "OUT OF ORDER" taped beside both washroom doors.
  paper(s, "sign_out_of_order", [-33.62, FLOOR_Y + 1.5, 1.598], [0, 0, -1], { pin: "tape", rotation: -0.05 })
  paper(s, "sign_out_of_order", [-26.95, FLOOR_Y + 1.5, 1.598], [0, 0, -1], { pin: "tape", rotation: 0.04 })
  paper(s, "map_evac_4", [-43.3, FLOOR_Y + 1.5, 1.598], [0, 0, -1], { pin: "none" })
  await pause()

  // ---------------------------------------------------------------- hoarding across the floor at x −4.6
  hoarding(s)
  // ---------------------------------------------------------------- Directorate corridor (two lengths, one finish)
  const eastA = spine(b, {
    x0: HOARD_X + HOARD_T / 2,
    x1: 11.6,
    west: "open",
    east: "open",
    finish: EXEC,
    northRoomFinish: ROOM_BANDS,
    southRoomFinish: EXEC_BANDS,
    nightCircuit: 0,
    sconces: { from: HOARD_X + HOARD_T / 2, to: 11.6, every: 4.0 },
    north: [
      { kind: "door", at: -1.9, side: "b", door: { id: "4-16", state: "closed", room: "4-16", leaf: "veneer", sign: { number: "4-16", label: "FILES" } } },
      { kind: "door", at: 3.2, side: "b", door: { id: "4-11", state: "keycard:signal", room: "4-11", sign: { number: "4-11", label: "RF HAZARD · AUTHORIZED" } } },
    ],
    south: [
      { kind: "door", at: -1.9, side: "a", door: { id: "4-15", state: "closed", room: "4-15", leaf: "veneer", sign: { number: "4-15", label: "SECRETARY" } } },
      { kind: "door", at: 6.2, side: "a", door: { id: "4-10", state: "open", room: "4-10", leaf: "glass", double: true, sign: { number: "4-10", label: "DIRECTORATE" } } },
    ] satisfies POpening[],
    extinguishers: [{ x: -3.6, side: "north" }],
  })
  const eastB = spine(b, {
    x0: 11.6,
    x1: 22.4,
    west: "open",
    east: "open",
    finish: EXEC,
    northRoomFinish: EXEC_BANDS,
    southRoomFinish: EXEC_BANDS,
    nightCircuit: 0,
    sconces: { from: 11.6, to: 22.4, every: 4.0 },
    north: [{ kind: "door", at: 17.0, side: "b", door: { id: "4-12", state: "closed", room: "4-12", leaf: "veneer", double: true, sign: { number: "4-12", label: "CONFERENCE" } } }],
  })
  await pause()

  await buildWest(s, pause)
  await pause()
  await buildEast(s, pause)

  // Paperwork: one merged draw, drawn with the storey's small props.
  addDocuments(sb, docs)
  return {
    update: (t) => {
      west.update(t)
      eastA.update(t)
      eastB.update(t)
    },
    proxy: null,
  }
}

/**
 * Plywood hoarding on the old pier line: painted ply facing the Directorate, raw ply and 2×4 studs on the construction
 * side, hazard tape and the Director's halt order across the corridor, the contractor door standing open.
 */
function hoarding(s: S4) {
  const { b } = s
  const x = HOARD_X
  const face = x - HOARD_T / 2
  partition(b, {
    axis: "z",
    at: x,
    from: -21.65,
    to: 21.65,
    thickness: HOARD_T,
    finish: [PLY_BANDS, EXEC_BANDS],
    openings: [{ kind: "door", at: 0, side: "a", door: { id: "4-H", state: "open", leaf: PLY, glass: "none", sign: { number: "4-H", label: "CONTRACTOR" }, open: 1.35 } }],
  })
  // Studs, sole and head plates on the construction side (kept clear of the old stud tracks that butt into it).
  const sx0 = face - 0.089
  for (let z = -21.3; z <= 21.31; z += 0.6) {
    if (Math.abs(z) < 0.62) continue
    if ([1.675, 11.925].some((c) => Math.abs(Math.abs(z) - c) < 0.12)) continue
    b.box(TIMBER, sx0, FLOOR_Y + 0.038, z - 0.019, face, CEIL_Y - 0.038, z + 0.019)
  }
  for (const [z0, z1] of [[-21.6, -0.56], [0.56, 21.6]] as const) {
    b.box(TIMBER, sx0, FLOOR_Y, z0, face, FLOOR_Y + 0.038, z1)
    b.box(TIMBER, sx0, CEIL_Y - 0.038, z0, face, CEIL_Y, z1)
  }
  b.box(TIMBER, sx0, FLOOR_Y + DOOR_H + 0.12, -0.6, face - 0.004, FLOOR_Y + DOOR_H + 0.21, 0.6)
  // Hazard tape across the corridor face (both sides of the door).
  for (const y of [1.0, 1.26])
    for (const [z0, z1] of [[-1.6, -0.62], [0.62, 1.6]] as const) b.box(M.hazard, face - 0.003, FLOOR_Y + y, z0, face, FLOOR_Y + y + 0.075, z1, { cast: false })
  paper(s, "work_order_halt", [face - 0.001, FLOOR_Y + 1.58, -1.2], [-1, 0, 0], { pin: "tack", rotation: 0.03 })
  // Aluminium saddle across the doorway (the two corridor floors meet under the leaf).
  b.box(M.steel, face - 0.03, FLOOR_Y, -0.5, x + HOARD_T / 2 + 0.03, FLOOR_Y + 0.006, 0.5, { cast: false })
  b.walk(face - 0.03, -0.5, x + HOARD_T / 2 + 0.03, 0.5)
}
