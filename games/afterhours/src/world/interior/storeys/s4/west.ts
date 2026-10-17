import {
  CEIL_Y,
  FLOOR_Y,
  M,
  PUDDLE,
  ROOM_BANDS,
  STAIN,
  T,
  ceiling,
  clampWorkLight,
  fallenTile,
  partition,
  placeModels,
  rect,
  room,
  studWall,
  tarpFloor,
  tarpHung,
  yawToward,
} from "../../api"
import { MODELS } from "../../../../render/models"
import { type S4, floorCable, floorPatches, paper, plasticX } from "./common"
import { ADHESIVE, BLUEPRINT, GYPSUM, HARDHAT_W, PLY, SPRAY, SPRINKLER } from "./mats"
import { cableReel, drapedTarp, drywallStack, handset, hardHat, lunch, plenumRun, rubbleHopper, rubbleScatter, sawhorse, stepLadder, studBundle } from "./props"

// West half of storey 4 (building program 4-01, 4-02, 4-04): the former Atmospheric Modelling Division stripped to
// the studs. Two clamp work lights are the only light; plastic sheeting, drywall stacks, the contractor's site office
// with the phone off the hook and the Director's halt order. Every stud wall is see-through and has walk-through gaps.

type Run = { axis: "x" | "z"; at: number; from: number; to: number; doors?: number[] }

function studs(s: S4, runs: Run[]) {
  for (const r of runs) studWall(s.b, { axis: r.axis, at: r.at, from: r.from, to: r.to, openings: (r.doors ?? []).map((d) => ({ from: d - 0.5, to: d + 0.5 })) })
}

/** Ceiling for a gutted area: most tiles gone, a few lying on the slab. */
function gutCeiling(s: S4, r: { x0: number; x1: number; z0: number; z1: number }, missing: number, seed: number) {
  const { b, rnd } = s
  ceiling(b, r.x0, r.z0, r.x1, r.z1, missing, seed, (x, z) => {
    if (rnd() < 0.1) fallenTile(b, x, z, rnd)
  })
}

export async function buildWest(s: S4, pause: () => Promise<void>) {
  const { b, sb, rnd } = s

  // ---------------------------------------------------------------- 4-01 gutted floor plate (north)
  const n01 = rect(-54.65, -4.6, -21.65, -1.75)
  room(b, { id: "4-01", name: "Gutted floor plate (north)", rect: n01, floor: "concrete_floor_dry", ceiling: { none: true }, troffers: false, windows: { blinds: "up", radiators: "convector" } })
  gutCeiling(s, n01, 0.7, 41)
  studs(s, [
    // Old corridor wall (spine north): office doorways, the cleared bays opposite the stair hall, a torn-out stretch.
    { axis: "x", at: -1.675, from: -54.6, to: -41.8, doors: [-50.0, -46.6] },
    { axis: "x", at: -1.675, from: -33.0, to: -13.0, doors: [-27.8, -22.4, -17.0] },
    { axis: "x", at: -1.675, from: -11.4, to: -4.66, doors: [-6.4] },
    // Interior-zone office partitions on the pier lines (B2/B3 cleared for the work area, B6 half torn out).
    ...[-47.8, -42.4, -31.6, -26.2, -15.4, -10.0].map((x) => ({ axis: "z" as const, at: x, from: -1.73, to: -11.87 })),
    { axis: "z", at: -20.8, from: -1.73, to: -6.0 },
    // Zone wall: perimeter office doorways.
    { axis: "x", at: -11.925, from: -54.6, to: -36.0, doors: [-52.0, -45.5, -40.0] },
    { axis: "x", at: -11.925, from: -32.0, to: -4.66, doors: [-29.0, -23.6, -18.0, -12.6, -7.0] },
    // Perimeter offices (two-bay and one-bay).
    ...[-47.8, -37.0, -26.2, -15.4].map((x) => ({ axis: "z" as const, at: x, from: -11.98, to: -21.6 })),
    { axis: "z", at: -10.0, from: -11.98, to: -16.0 },
  ])
  // Board left on the old corridor wall where the extinguishers hang (the contractors work round them).
  for (const [x0, x1] of [[-53.7, -52.4], [-44.1, -42.6]] as const) b.box(GYPSUM, x0, FLOOR_Y + 0.02, -1.629, x1, CEIL_Y - 0.04, -1.616)
  // Slab: black mastic where the carpet came up, carpet and vinyl remnants in the offices.
  for (let i = 0; i < 9; i++) {
    const x0 = -54.65 + i * 5.4
    if (i === 2 || i === 3) continue
    floorPatches(b, { x0: x0 + 0.2, x1: x0 + 5.2, z0: -11.6, z1: -2.0 }, ADHESIVE, 3, rnd)
    floorPatches(b, { x0: x0 + 0.2, x1: x0 + 5.2, z0: -21.4, z1: -12.2 }, ADHESIVE, 3, rnd)
    if (i % 3 === 1) floorPatches(b, { x0: x0 + 0.5, x1: x0 + 4.8, z0: -21.0, z1: -12.6 }, M.carpet, 2, rnd, 4)
  }
  plenumRun(b, -54.55, -4.7, -7.0, -14.2, SPRINKLER)

  // Work area opposite the stair hall: plastic dust screen lit by the first work light, board behind it.
  plasticX(b, -8.2, -42.3, -31.7, rnd)
  clampWorkLight(b, -38.6, -3.4, 0.3, { shadow: true, pitch: 0.12, intensity: 170 })
  drywallStack(b, -40.0, -10.3, 0.02, 16, rnd)
  drywallStack(b, -34.5, -10.5, -0.03, 11, rnd)
  sawhorse(b, -36.4, -5.6, Math.PI / 2)
  sawhorse(b, -34.2, -5.6, Math.PI / 2 + 0.05)
  b.boxM(PLY, T(-35.3, FLOOR_Y + 0.765 + 0.009, -5.6, 0.04), 2.44, 0.018, 1.22)
  b.collide(-36.55, FLOOR_Y, -6.25, -34.05, FLOOR_Y + 0.79, -4.95)
  sb.rbox(M.safety, T(-35.0, FLOOR_Y + 0.84, -5.4, 0.6), 0.32, 0.13, 0.22, 0.02)
  sb.cyl(M.steel, T(-35.08, FLOOR_Y + 0.86, -5.43, 0.6, 0, Math.PI / 2), 0.09, 0.09, 0.01, 20)
  hardHat(sb, -36.1, FLOOR_Y + 0.783, -5.9, 0.4)
  stepLadder(b, -32.9, -3.6, 0.4)
  cableReel(b, -32.5, -9.0, 0.3, true)
  placeModels(b, "traffic_cone", [
    { position: [-41.4, FLOOR_Y, -2.3], yaw: 0.2 },
    { position: [-33.5, FLOOR_Y, -2.35], yaw: 1.1 },
    { position: [-5.4, FLOOR_Y, -1.15], yaw: 0.4 },
    { position: [-5.35, FLOOR_Y, 1.2], yaw: 2.0 },
    { position: [-12.4, FLOOR_Y, 17.6], yaw: 0.9 },
  ])
  // Second work light deep in the north-east perimeter, aimed west across the board and a second screen.
  plasticX(b, -22.6, -21.0, -12.5, rnd, 0.06, "z")
  clampWorkLight(b, -18.8, -17.0, Math.PI / 2 - 0.15, { pitch: 0.2, intensity: 140 })
  drywallStack(b, -24.0, -19.4, 0.0, 9, rnd)
  studBundle(b, -24.0, -9.4, 0.08)
  cableReel(b, -13.0, -7.2, 0.0, false)
  stepLadder(b, -11.2, -19.2, -0.7)
  // Temporary supply from the board in EL-4 to both lights, along the floor and through the doorways.
  floorCable(b, [[-45.0, 1.8], [-44.6, -0.6], [-41.0, -2.6], [-38.3, -2.9]], M.safety)
  floorCable(b, [[-38.3, -2.9], [-33.2, -1.25], [-22.4, -1.25], [-22.3, -3.0], [-19.6, -8.0], [-18.0, -11.925], [-18.5, -16.5]], M.safety)
  // Stores and leftovers.
  placeModels(b, "drum_steel", [
    { position: [-53.7, FLOOR_Y, -20.7], yaw: 0.3 },
    { position: [-53.0, FLOOR_Y, -20.95], yaw: 1.4 },
    { position: [-35.3, FLOOR_Y, 20.8], yaw: 0.7 },
  ])
  const ph = MODELS.pallet.size[1]
  const bh = MODELS.cardboard_box.size[1]
  placeModels(b, "pallet", [
    { position: [-50.6, FLOOR_Y, -15.0], yaw: 0.1 },
    { position: [-33.4, FLOOR_Y, 19.6], yaw: -0.15 },
    { position: [-45.4, FLOOR_Y, 19.4], yaw: 0.4 },
  ])
  placeModels(b, "cardboard_box", [
    ...[[-50.9, -15.2, 0.1], [-50.4, -14.7, 0.15], [-50.3, -15.4, 0.05], [-33.7, 19.4, -0.1], [-33.2, 19.9, -0.2]].map(([x, z, y]) => ({ position: [x!, FLOOR_Y + ph, z!] as const, yaw: y!, blob: 0 })),
    { position: [-50.7, FLOOR_Y + ph + bh, -15.0], yaw: 0.3, collide: false, blob: 0 },
    { position: [-33.5, FLOOR_Y + ph + bh, 19.6], yaw: 0.0, collide: false, blob: 0 },
    { position: [-45.6, FLOOR_Y + ph, 19.3], yaw: 0.4, blob: 0 },
  ])
  drapedTarp(b, -7.4, -16.8, 0.05, 2.6, 1.7, 0.95, M.tarp, rnd)
  drapedTarp(b, -29.2, -17.2, -0.1, 2.2, 1.5, 0.75, GYPSUM, rnd)
  tarpHung(b, -7.3, -21.61, rnd)
  rubbleScatter(b, -45.0, -6.0, 1.4, rnd)
  rubbleScatter(b, -28.0, -6.5, 1.0, rnd)
  rubbleScatter(b, -12.5, -15.0, 1.2, rnd)
  for (const [x, z, w, d] of [[-44.0, -18.6, 1.4, 0.9], [-9.2, -4.2, 0.9, 0.7], [-30.5, -13.4, 1.1, 0.6]] as const) {
    b.quad(PUDDLE, T(x, FLOOR_Y + 0.003, z, rnd() * 3, -Math.PI / 2), w, d, { cast: false })
    b.quad(STAIN, T(x, CEIL_Y + 0.025, z, rnd() * 3, Math.PI / 2), w + 0.6, d + 0.5, { cast: false })
  }
  // "DO NOT DEMO — SEE DIRECTOR": the one board left on the north wall, an access hatch sprayed round in orange.
  const zw = -21.61
  b.box(GYPSUM, -26.85, FLOOR_Y + 0.02, zw, -25.55, CEIL_Y - 0.02, zw + 0.013)
  b.box(M.cabinet, -26.5, FLOOR_Y + 0.95, zw + 0.013, -25.9, FLOOR_Y + 1.55, zw + 0.022)
  b.box(M.darkSteel, -26.0, FLOOR_Y + 1.2, zw + 0.022, -25.95, FLOOR_Y + 1.3, zw + 0.034)
  for (const [x0, y0, x1, y1] of [[-26.72, 0.82, -25.68, 0.86], [-26.72, 1.64, -25.68, 1.68], [-26.72, 0.82, -26.68, 1.68], [-25.72, 0.82, -25.68, 1.68]] as const)
    b.box(SPRAY, x0, FLOOR_Y + y0, zw + 0.014, x1, FLOOR_Y + y1, zw + 0.016, { cast: false })
  for (let k = 0; k < 9; k++) {
    const x = -26.6 + k * 0.11 + (k > 4 ? 0.06 : 0)
    b.boxM(SPRAY, T(x, FLOOR_Y + 1.95 + (rnd() - 0.5) * 0.03, zw + 0.015, 0, 0, (rnd() - 0.5) * 0.9), 0.025, 0.14, 0.002, 0, 0, 0, { cast: false })
  }
  for (let k = 0; k < 6; k++) b.boxM(SPRAY, T(-26.45 + k * 0.13, FLOOR_Y + 1.78, zw + 0.015, 0, 0, (rnd() - 0.5) * 0.9), 0.022, 0.1, 0.002, 0, 0, 0, { cast: false })
  await pause()

  // ---------------------------------------------------------------- 4-04 west end, 4-04b behind the telecom room
  const r04 = rect(-54.65, -47.8, 1.75, 21.65)
  room(b, { id: "4-04", name: "West end", rect: r04, floor: "concrete_floor_dry", ceiling: { none: true }, troffers: false, windows: { blinds: "up", radiators: "convector" } })
  gutCeiling(s, r04, 0.75, 44)
  const r04b = rect(-47.8, -43.25, 10.75, 21.65)
  room(b, { id: "4-04b", name: "West end (south)", rect: r04b, floor: "concrete_floor_dry", ceiling: { none: true }, troffers: false, windows: { blinds: "up", radiators: "convector" } })
  gutCeiling(s, r04b, 0.75, 45)
  b.floor("concrete_floor_dry", -43.25, 10.75, -42.15, 16.05)
  gutCeiling(s, { x0: -43.25, x1: -42.15, z0: 10.75, z1: 16.05 }, 0.6, 46)
  studs(s, [
    { axis: "x", at: 1.675, from: -54.6, to: -50.2, doors: [-52.4] },
    { axis: "x", at: 1.675, from: -48.9, to: -47.86 },
    { axis: "x", at: 11.925, from: -54.6, to: -47.86, doors: [-51.2] },
    { axis: "z", at: -47.8, from: 10.8, to: 21.6, doors: [14.6] },
  ])
  floorPatches(b, { x0: -54.4, x1: -48.0, z0: 2.0, z1: 11.6 }, ADHESIVE, 4, rnd)
  floorPatches(b, { x0: -54.4, x1: -48.0, z0: 12.2, z1: 21.4 }, ADHESIVE, 3, rnd)
  rubbleHopper(b, -50.8, 7.4, 0.3, rnd)
  rubbleScatter(b, -50.6, 6.2, 1.2, rnd, 20)
  tarpFloor(b, -52.6, 4.8, rnd)
  b.quad(STAIN, T(-52.6, CEIL_Y + 0.025, 4.8, 0.4, Math.PI / 2), 2.0, 1.6, { cast: false })
  b.quad(PUDDLE, T(-53.2, FLOOR_Y + 0.003, 3.6, 1.1, -Math.PI / 2), 1.3, 0.8, { cast: false })
  placeModels(b, "wet_floor_sign", [{ position: [-51.6, FLOOR_Y, 4.0], yaw: yawToward(1, -0.5), collide: false }])
  drapedTarp(b, -51.2, 17.0, 0.12, 2.6, 1.8, 1.0, M.tarp, rnd)
  cableReel(b, -45.6, 13.4, 0.0, true)
  await pause()

  // ---------------------------------------------------------------- 4-02 gutted south, contractor site office
  const r02 = rect(-36.15, -4.6, 9.75, 21.65)
  room(b, { id: "4-02", name: "Gutted south", rect: r02, floor: "concrete_floor_dry", ceiling: { none: true }, troffers: false, windows: { blinds: "up", radiators: "convector" } })
  gutCeiling(s, r02, 0.7, 42)
  const r02b = rect(-15.4, -4.6, 1.75, 9.75)
  room(b, { id: "4-02b", name: "Gutted south (inner)", rect: r02b, floor: "concrete_floor_dry", ceiling: { none: true }, troffers: false })
  gutCeiling(s, r02b, 0.7, 43)
  studs(s, [
    { axis: "x", at: 1.675, from: -15.34, to: -4.66, doors: [-13.0, -7.6] },
    { axis: "z", at: -10.0, from: 1.73, to: 11.87, doors: [6.0] },
    { axis: "x", at: 11.925, from: -36.0, to: -22.0, doors: [-33.0, -28.0, -23.4] },
    { axis: "x", at: 11.925, from: -19.0, to: -4.66, doors: [-12.8, -7.2] },
    ...[-31.6, -26.2, -15.4].map((x) => ({ axis: "z" as const, at: x, from: 11.98, to: 21.6 })),
    { axis: "z", at: -20.8, from: 16.0, to: 21.6 },
  ])
  for (const x0 of [-36.0, -31.6, -26.2, -20.8, -15.4, -10.0]) floorPatches(b, { x0: x0 + 0.2, x1: Math.min(x0 + 5.2, -4.8), z0: 12.2, z1: 21.4 }, ADHESIVE, 3, rnd)
  floorPatches(b, { x0: -15.2, x1: -4.8, z0: 2.0, z1: 9.6 }, ADHESIVE, 4, rnd)
  plenumRun(b, -36.1, -4.7, 16.2, 13.6, SPRINKLER)
  // Plastic taped over two south windows (the glazing is to be replaced).
  plasticX(b, 21.55, -25.4, -21.6, rnd, 1.6)
  plasticX(b, 21.55, -9.2, -5.4, rnd, 1.6)
  drywallStack(b, -23.5, 18.6, 0.0, 12, rnd)
  studBundle(b, -18.0, 15.0, Math.PI / 2 + 0.05)
  cableReel(b, -29.0, 14.6, 0.5, false)
  sawhorse(b, -12.4, 15.2, 0.3)
  stepLadder(b, -8.0, 4.6, 2.2)
  drapedTarp(b, -7.6, 18.2, -0.08, 2.4, 1.6, 0.85, GYPSUM, rnd)
  rubbleScatter(b, -33.5, 13.4, 1.2, rnd)
  rubbleScatter(b, -11.0, 7.4, 1.0, rnd)
  b.quad(PUDDLE, T(-27.6, FLOOR_Y + 0.003, 15.8, 0.3, -Math.PI / 2), 1.6, 0.9, { cast: false })
  b.quad(STAIN, T(-27.6, CEIL_Y + 0.025, 15.8, 0.3, Math.PI / 2), 2.0, 1.4, { cast: false })

  // Site office: the one room the contractors kept (old vinyl, intact grid), walls on its own lines.
  const so = rect(-26.2, -15.4, 1.75, 9.6)
  room(b, { id: "4-02s", name: "Contractor site office", rect: so, floor: "linoleum", ceiling: { missing: 0.06 }, lit: "none" })
  partition(b, { axis: "x", at: 9.675, from: -26.2, to: -15.34, thickness: 0.15, finish: [ROOM_BANDS, ROOM_BANDS] })
  partition(b, { axis: "z", at: -15.4, from: 1.75, to: 9.6, finish: [ROOM_BANDS, ROOM_BANDS] })
  // Plywood desk on two sawhorses against the south wall.
  sawhorse(b, -21.4, 8.6, Math.PI / 2, 0.9)
  sawhorse(b, -19.0, 8.6, Math.PI / 2, 0.9)
  const deskY = FLOOR_Y + 0.765 + 0.018
  b.box(PLY, -21.42, deskY - 0.018, 8.05, -18.98, deskY, 9.2)
  b.collide(-21.42, FLOOR_Y, 8.05, -18.98, deskY, 9.2)
  hardHat(sb, -18.0 - 1.3, deskY, 8.75, 0.7)
  hardHat(sb, -24.9, FLOOR_Y, 8.9, 2.1, HARDHAT_W)
  lunch(sb, -20.9, deskY, 8.6, 0.2)
  for (const [x, z, a] of [[-19.9, 8.4, 0.1], [-19.6, 8.55, 0.05]] as const) sb.cyl(BLUEPRINT, T(x, deskY + 0.04, z, a, 0, Math.PI / 2), 0.035, 0.035, 0.9, 12)
  sb.box(M.clipboard, -20.2, deskY, 8.85, -19.95, deskY + 0.006, 9.15)
  paper(s, "work_order_halt", [-20.08, deskY + 0.008, 9.0], [0, 1, 0], { rotation: 0.15, up: [0, 0, -1] })
  paper(s, "work_order_halt", [-15.47, FLOOR_Y + 1.55, 2.9], [-1, 0, 0], { pin: "tack", rotation: -0.04 })
  paper(s, "calendar_oct84", [-15.47, FLOOR_Y + 1.6, 3.6], [-1, 0, 0], { pin: "pin", rotation: 0.02 })
  paper(s, "directory_extensions", [-15.47, FLOOR_Y + 1.45, 4.2], [-1, 0, 0], { pin: "tape", rotation: 0.03 })
  // Drawings pinned on the west wall (blueprints and white prints), a wall telephone list.
  for (const [z, y, w, h, mat] of [[3.2, 1.55, 0.9, 0.62, BLUEPRINT], [4.3, 1.6, 0.9, 0.62, M.paper], [5.4, 1.5, 0.9, 0.62, BLUEPRINT], [6.6, 1.62, 0.6, 0.9, M.paper]] as const) {
    b.box(mat, -26.14, FLOOR_Y + y - h / 2, z - w / 2, -26.136, FLOOR_Y + y + h / 2, z + w / 2, { cast: false })
    for (let k = 0; k < 5; k++) b.box(mat === BLUEPRINT ? M.paper : M.felt, -26.136, FLOOR_Y + y - h / 2 + 0.08 + k * 0.1, z - w / 2 + 0.1, -26.134, FLOOR_Y + y - h / 2 + 0.083 + k * 0.1, z + w / 2 - 0.1 - (k % 2) * 0.2, { cast: false })
  }
  placeModels(b, "stack_chair", [{ position: [-20.3, FLOOR_Y, 7.4], yaw: yawToward(0, 1) + 0.5 }])
  placeModels(b, "space_heater", [{ position: [-22.4, FLOOR_Y, 8.8], yaw: yawToward(1, -1) }])
  placeModels(b, "cardboard_box", [
    { position: [-25.6, FLOOR_Y, 2.4], yaw: 0.1 },
    { position: [-25.6, FLOOR_Y + MODELS.cardboard_box.size[1], 2.45], yaw: -0.15, collide: false, blob: 0 },
  ])
  // The phone off the hook on the floor.
  placeModels(b, "telephone", [{ position: [-22.6, FLOOR_Y, 5.2], yaw: 0.9, collide: false }])
  handset(sb, -22.0, 4.5, 2.2, -22.6, 5.2)
  floorCable(sb, [[-22.6, 5.25], [-24.8, 6.0], [-26.1, 6.3]], M.beige, 0.003)
}
