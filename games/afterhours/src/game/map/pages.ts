import {
  ACCESS_ROAD,
  ANNEX_DOOR,
  BOOTH,
  BUILDING,
  CORE,
  FENCE,
  FIRE_ESCAPE,
  FREIGHT,
  INTERIOR,
  NORTH_GATE,
  NORTH_TRACK,
  PARKING_LOT,
  POWER,
  RISER,
  accessRoadSamples,
  countyRoadSamples,
  northTrackDistance,
  northTrackSamples,
  type Vec2,
} from "../../world/layout"
import { WINDOWS, type Face } from "../../world/interior/plan"
import type { PlanData, PlanDoor, PlanRoom, StoreyPlan } from "./data"
import { FONT, INK, PAPER, Sheet, canvas, grain, reproduce, type Ctx } from "./paper"

// The clipboard's sheets: a site plan, one floor plan per storey and the roof, drawn from the world's own data
// (layout.ts, interior/plan.ts and the interior's wall/door/room registries) as 1984 reprographics: the original's
// linework is "reproduced" (photocopy, or a diazo blue-line print for the site plan) with skew, toner and grain, then the
// briefer's ballpoint notes go on top. Pure canvas code: runs in the page worker.
//
// Drawn for reading in first person at 1280×720 without zooming: a big level title, heavy walls, room numbers ≥ 12 pt,
// names only for the rooms that matter on that floor, a few large handwritten notes and little else. Sizes are in
// points on the 11 × 8½" sheet, which fills ~87% of the screen height when raised (≈ 2.9 px/mm at 720p).

export const SHEET_MM = [279.4, 215.9] as const
export const PAGE_COUNT = 7
/** Page index of storey `s` (0..4); 0 is the site plan, 6 the roof. */
export const pageOfStorey = (s: number) => 1 + s
export const PAGE_TITLES = ["SITE", "LEVEL 0", "LEVEL 1", "LEVEL 2", "LEVEL 3", "LEVEL 4", "ROOF"]

/** Main-thread facts the worker can't import (they live in modules that pull in three.js). */
export type SiteFacts = {
  /** Stair plan from world/interior/core.ts `ST`. */
  stair: { x0: number; x1: number; wellX0: number; wellX1: number; z0: number; zFlight: number; zMid: number; z1: number }
  /** Parking stall rows from world/compound/lot.ts. */
  lotRows: { head: number; facing: -1 | 1 }[]
  aisleX: number
}

export type PageJob = { index: number; plan: PlanData; facts: SiteFacts; width: number; briefing: string[] }

/**
 * Forest landmarks the briefer marked by hand on the vicinity map. Approximate by nature (world metres, +z south);
 * exported so the forest can put something there.
 */
export const SITE_NOTES = {
  trail: [[-95, -40], [-120, -70], [-150, -95], [-185, -130], [-210, -150]] as Vec2[],
  weatherShed: [-212, -156] as Vec2,
  loggingRoad: [[-12, 300], [-45, 292], [-90, 275], [-140, 262], [-178, 248]] as Vec2[],
  clearing: [150, 40] as Vec2,
}

const SUBTITLES = ["SITE & ACCESS", "GROUND FLOOR", "ADMINISTRATION", "SAMPLE SCIENCES · LABS", "COMPUTING · SIGNALS", "DIRECTORATE · REFURB", "ROOF PLAN"]
/** The rooms that get a name on each floor (short names, as a briefer would want them); the rest get a number only. */
const KEY_ROOMS: Record<string, string>[] = [
  { "0-01": "LOBBY", "0-38": "SECURITY", "0-30": "FACILITIES", "0-10": "STAFF ENTRANCE", "0-16": "RECEIVING", "0-39": "CAFETERIA", "0-35": "AUDITORIUM", "0-15": "DECON" },
  { "1-01": "RECORDS", "1-07": "CHIEF", "1-09": "PAYROLL", "1-24": "OPEN OFFICE", "1-10": "LIBRARY", "1-02": "CONFERENCE" },
  { "2-27": "LAB 4", "2-08": "LAB MANAGER", "2-10": "CONTAINMENT", "2-01": "CHEM STORE", "2-26": "BREAK ROOM", "2-07": "SPECIMENS" },
  { "3-08": "LISTENING ROOM", "3-04": "MACHINE ROOM", "3-06": "OPERATIONS", "3-03": "POWER", "3-24": "TERMINALS", "3-09": "ANALYSIS" },
  { "4-14": "DIRECTOR", "4-11": "RECEIVER", "4-12": "CONFERENCE", "4-10": "RECEPTION", "4-01": "GUTTED", "4-02": "GUTTED" },
]
const SHEET_NO = ["A-001", "A-100", "A-101", "A-102", "A-103", "A-104", "A-105"]
const MAIN = BUILDING.main
const W = SHEET_MM[0]
const Hs = SHEET_MM[1]

export async function drawPage(job: PageJob): Promise<ImageBitmap> {
  const px = job.width
  const mm = px / W
  const ph = Math.round(Hs * mm)
  const { c: orig, g: og } = canvas(px, ph)
  const { c: out, g } = canvas(px, ph)
  const seed = 1984 + job.index * 101
  const o = new Sheet(og, mm, W, Hs, seed)
  const site = job.index === 0
  const roof = job.index === PAGE_COUNT - 1
  header(o, job.index)
  if (site) drawSite(o, job)
  else if (roof) drawRoof(o)
  else drawFloor(o, job.index - 1, job.plan.storeys[job.index - 1] ?? { walls: [], doors: [], rooms: [] }, job.facts)
  g.fillStyle = site ? "#ece6d2" : "#f1efe8"
  g.fillRect(0, 0, px, ph)
  const q = new Sheet(g, mm, W, Hs, seed + 7)
  reproduce(g, orig, { ink: site ? INK.blueline : INK.toner, skew: q.rr(-0.007, 0.007), dx: q.rr(-5, 5), dy: q.rr(-4, 4), seed: seed + 3, copy: !site, density: site ? 1.2 : 0.8 })
  g.setTransform(mm, 0, 0, mm, 0, 0)
  if (site) siteNotes(q, job.briefing)
  else if (roof) roofNotes(q)
  else floorNotes(q, job.index - 1, job.plan.storeys[job.index - 1])
  copyStamp(q, job.index)
  grain(g, seed + 11, 8, site ? 0.26 : 0.14)
  return out.transferToImageBitmap()
}

// ------------------------------------------------------------------------------------------------ header

function header(o: Sheet, index: number) {
  o.rect(6, 6, W - 12, Hs - 12, 0.6)
  o.text(PAGE_TITLES[index]!, 12, 31, { font: FONT.title, pt: 46, weight: 700 })
  o.text(SUBTITLES[index]!, 12.5, 40, { pt: 12, weight: 700, spacing: 0.5 })
  o.text(SHEET_NO[index]!, W - 12, 24, { font: FONT.title, pt: 24, weight: 700, align: "right" })
  o.text(index === 0 ? "IOPS · ASHWOOD OUTPOST" : `IOPS · ASHWOOD OUTPOST · ${PAGE_TITLES[index]}`, W - 12, 31, { font: FONT.title, pt: 9, weight: 500, align: "right", spacing: 0.3 })
  o.text(`SHEET ${index + 1} OF ${PAGE_COUNT} · REV. 6 · 6/84`, W - 12, 36, { pt: 7, weight: 600, align: "right" })
  // Minor print line at the foot.
  o.text("ATMOSPHERIC PROPAGATION RESEARCH FACILITY · PROJECT AW-79-014 · REDUCED COPY · DO NOT SCALE", W - 12, Hs - 9, { pt: 6, weight: 500, align: "right" })
}

function northArrow(o: Sheet, x: number, y: number, r = 6) {
  o.circle(x, y, r, 0.35)
  o.poly([[x, y - r * 1.35], [x + r * 0.42, y + r * 0.55], [x, y + r * 0.28]], 0.2, INK.toner, { close: true, fill: INK.toner })
  o.poly([[x, y - r * 1.35], [x - r * 0.42, y + r * 0.55], [x, y + r * 0.28]], 0.25, INK.toner, { close: true })
  o.text("N", x, y - r * 1.55, { font: FONT.title, pt: 12, weight: 700, align: "center" })
}

// ------------------------------------------------------------------------------------------------ floor plans

const S = 2.72
let OY = 52
const X = (x: number) => 13.5 + (x + 58) * S
const Z = (z: number) => OY + (z + 22) * S

function wallRect(o: Sheet, x0: number, z0: number, x1: number, z1: number, min = 0.3) {
  const cx = (x0 + x1) / 2
  const cz = (z0 + z1) / 2
  const w = Math.max(x1 - x0, min)
  const d = Math.max(z1 - z0, min)
  o.fill(X(cx - w / 2), Z(cz - d / 2), w * S, d * S)
}

/** Exterior wall of the main block with its facade windows. */
function shell(o: Sheet, storey: number) {
  const T = 0.5
  const [x0, z0] = MAIN.min
  const [x1, z1] = MAIN.max
  const tower: [number, number] = [-43.45, -35.95]
  const runs: { face: Face; along: [number, number]; at: [number, number]; skip: [number, number][] }[] = [
    { face: "north", along: [x0, x1], at: [z0, z0 + T], skip: [] },
    { face: "south", along: [x0, x1], at: [z1 - T, z1], skip: [tower] },
    { face: "west", along: [z0, z1], at: [x0, x0 + T], skip: [] },
    { face: "east", along: [z0, z1], at: [x1 - T, x1], skip: [] },
  ]
  if (storey === 0) {
    runs[1]!.skip.push([-10.5, 10.5])
    runs[0]!.skip.push([-37, -23])
  } else runs[2]!.skip.push([FIRE_ESCAPE.door.z - FIRE_ESCAPE.door.width / 2, FIRE_ESCAPE.door.z + FIRE_ESCAPE.door.width / 2])
  for (const r of runs) {
    const wins = WINDOWS(storey, r.face).map((w) => [w.u0, w.u1] as [number, number])
    const holes = [...wins, ...r.skip].sort((a, b) => a[0] - b[0])
    let u = r.along[0]
    const seg = (a: number, b: number) => {
      if (b - a < 0.01) return
      if (r.face === "north" || r.face === "south") o.fill(X(a), Z(r.at[0]), (b - a) * S, T * S)
      else o.fill(X(r.at[0]), Z(a), T * S, (b - a) * S)
    }
    for (const [a, b] of holes) {
      seg(u, Math.max(u, a))
      u = Math.max(u, b)
    }
    seg(u, r.along[1])
    for (const [a, b] of wins) glazing(o, r.face === "north" || r.face === "south" ? "x" : "z", a, b, r.at[0], r.at[1])
  }
  const tz1 = MAIN.max[1] + 3.2
  o.fill(X(tower[0]), Z(MAIN.max[1]), T * S, (tz1 - MAIN.max[1]) * S)
  o.fill(X(tower[1] - T), Z(MAIN.max[1]), T * S, (tz1 - MAIN.max[1]) * S)
  o.fill(X(tower[0]), Z(tz1 - T), (tower[1] - tower[0]) * S, T * S)
  if (storey === 0) {
    const e = BUILDING.entrance
    glazing(o, "x", -10.5, -e.width / 2, z1 - 0.35, z1)
    glazing(o, "x", e.width / 2, 10.5, z1 - 0.35, z1)
    door(o, { x: 0, z: z1 - 0.15, axis: "x", w: e.width, state: "open" }, 1)
  }
}

function glazing(o: Sheet, axis: "x" | "z", a: number, b: number, c0: number, c1: number) {
  if (axis === "x") {
    o.rect(X(a), Z(c0), (b - a) * S, Math.max(0.5, (c1 - c0) * S), 0.2)
    o.line(X(a), Z((c0 + c1) / 2), X(b), Z((c0 + c1) / 2), 0.16)
  } else {
    o.rect(X(c0), Z(a), Math.max(0.5, (c1 - c0) * S), (b - a) * S, 0.2)
    o.line(X((c0 + c1) / 2), Z(a), X((c0 + c1) / 2), Z(b), 0.16)
  }
}

/** Door leaf and swing. `side` ±1 is the side of the wall the leaf opens to (+z / +x). */
function door(o: Sheet, d: Pick<PlanDoor, "x" | "z" | "axis" | "w" | "state"> & { roomRect?: PlanDoor["roomRect"] }, forceSide?: number) {
  let side = forceSide ?? 1
  if (forceSide === undefined && d.roomRect) {
    const [rx0, rx1, rz0, rz1] = d.roomRect
    side = d.axis === "x" ? Math.sign((rz0 + rz1) / 2 - d.z) || 1 : Math.sign((rx0 + rx1) / 2 - d.x) || 1
  }
  const leaves = d.w > 1.45 ? 2 : 1
  const lw = (d.w - 0.1) / leaves
  for (let k = 0; k < leaves; k++) {
    const dir = k === 0 ? 1 : -1
    const ha = (d.axis === "x" ? d.x : d.z) - (dir * (d.w - 0.1)) / 2
    const hc = d.axis === "x" ? d.z : d.x
    const hx = d.axis === "x" ? ha : hc
    const hz = d.axis === "x" ? hc : ha
    const ex = d.axis === "x" ? ha : hc + side * lw
    const ez = d.axis === "x" ? hc + side * lw : ha
    o.line(X(hx), Z(hz), X(ex), Z(ez), 0.4)
    const a0 = d.axis === "x" ? (side > 0 ? Math.PI / 2 : -Math.PI / 2) : side > 0 ? 0 : Math.PI
    const a1 = d.axis === "x" ? (dir > 0 ? 0 : Math.PI) : dir > 0 ? Math.PI / 2 : -Math.PI / 2
    let delta = a1 - a0
    while (delta > Math.PI) delta -= Math.PI * 2
    while (delta < -Math.PI) delta += Math.PI * 2
    o.arc(X(hx), Z(hz), lw * S, a0, a1, 0.16, INK.toner, delta < 0)
  }
}

/** Room number (and, for the floor's key rooms, its name), sized to fit the room, never below readable. */
function roomLabel(o: Sheet, r: PlanRoom, storey: number) {
  const named = KEY_ROOMS[storey]?.[r.id]
  if (!named && !/^\d-\d\d$/.test(r.id)) return
  const wmm = (r.x1 - r.x0) * S
  const hmm = (r.z1 - r.z0) * S
  const cx = X((r.x0 + r.x1) / 2)
  const cy = Z((r.z0 + r.z1) / 2)
  const tall = hmm > wmm * 1.6 && wmm < 15
  const room = (tall ? hmm : wmm) - 1.2
  let numPt = named ? 15 : 13
  const nw = o.width(r.id, numPt, FONT.letter, 800)
  if (nw > room) numPt = (numPt * room) / nw
  if (numPt < 10.5) return
  const rot = tall ? -Math.PI / 2 : 0
  if (!named) {
    o.text(r.id, cx + (tall ? 1.6 : 0), cy + (tall ? 0 : 1.8), { pt: numPt, weight: 800, align: "center", rot })
    return
  }
  const namePt = 10.5
  const lines = o.wrap(named, room, namePt, FONT.letter, 700)
  if (lines.some((l) => o.width(l, namePt, FONT.letter, 700) > room + 2)) lines.length = 0
  const lh = namePt * 0.3528 * 1.12
  const total = numPt * 0.3528 * 0.75 + lines.length * lh
  if (tall) {
    // Read up the room: number then name, side by side across it.
    const x0 = cx - (total / 2) + numPt * 0.3528 * 0.72
    o.text(r.id, x0, cy, { pt: numPt, weight: 800, align: "center", rot })
    lines.forEach((l, i) => o.text(l, x0 + (i + 1) * lh, cy, { pt: namePt, weight: 700, align: "center", rot }))
    return
  }
  let y = cy - total / 2 + numPt * 0.3528 * 0.75
  o.text(r.id, cx, y, { pt: numPt, weight: 800, align: "center" })
  for (const l of lines) o.text(l, cx, (y += lh), { pt: namePt, weight: 700, align: "center" })
}

function drawFloor(o: Sheet, storey: number, plan: StoreyPlan, facts: SiteFacts) {
  OY = storey === 0 ? 60 : 52
  shell(o, storey)
  for (const w of plan.walls) {
    if (w.kind === "full") wallRect(o, w.x0, w.z0, w.x1, w.z1)
    else if (w.kind === "low") {
      if (w.x1 - w.x0 >= w.z1 - w.z0) glazing(o, "x", w.x0, w.x1, w.z0 - 0.06, w.z1 + 0.06)
      else glazing(o, "z", w.z0, w.z1, w.x0 - 0.06, w.x1 + 0.06)
    }
  }
  // Stairs and lift.
  const st = facts.stair
  for (let z = st.zFlight; z <= st.zMid + 1e-3; z += 0.56) o.line(X(st.x0), Z(z), X(st.wellX0), Z(z), 0.18)
  if (storey > 0) for (let z = st.zFlight; z <= st.zMid + 1e-3; z += 0.56) o.line(X(st.wellX1), Z(z), X(st.x1), Z(z), 0.18)
  o.text("STAIRS", X((st.x0 + st.x1) / 2) + 1.4, Z((st.z0 + st.z1) / 2) + 1, { pt: 9.5, weight: 800, align: "center", rot: -Math.PI / 2 })
  const L = CORE.lift
  o.rect(X(L.min[0]), Z(L.min[1] + 0.3), (L.max[0] - L.min[0]) * S, (L.max[1] - L.min[1] - 0.4) * S, 0.35)
  o.line(X(L.min[0]), Z(L.min[1] + 0.3), X(L.max[0]), Z(L.max[1] - 0.1), 0.14)
  o.line(X(L.min[0]), Z(L.max[1] - 0.1), X(L.max[0]), Z(L.min[1] + 0.3), 0.14)
  o.text("LIFT", X((L.min[0] + L.max[0]) / 2), Z((L.min[1] + L.max[1]) / 2) + 1.4, { pt: 9.5, weight: 800, align: "center", alpha: 1 })
  // Riser W-1 (every floor).
  o.hatch(X(RISER.min[0]), Z(RISER.min[1]), (RISER.max[0] - RISER.min[0]) * S, (RISER.max[1] - RISER.min[1]) * S, 0.6, 0.15)
  o.rect(X(RISER.min[0]), Z(RISER.min[1]), (RISER.max[0] - RISER.min[0]) * S, (RISER.max[1] - RISER.min[1]) * S, 0.35)
  o.text("W-1", X(RISER.max[0]) + 1, Z(RISER.max[1]) - 0.2, { pt: 9, weight: 800 })
  if (storey === 0) {
    const F = FREIGHT.car
    o.rect(X(F.min[0]), Z(F.min[1]), (F.max[0] - F.min[0]) * S, (F.max[1] - F.min[1]) * S, 0.4)
    o.line(X(F.min[0]), Z(F.min[1]), X(F.max[0]), Z(F.max[1]), 0.14)
    o.line(X(F.min[0]), Z(F.max[1]), X(F.max[0]), Z(F.min[1]), 0.14)
    o.text("FL-1", X((F.min[0] + F.max[0]) / 2), Z((F.min[1] + F.max[1]) / 2) + 1.6, { pt: 11, weight: 800, align: "center" })
    const dk = BUILDING.dock
    o.rect(X(dk.x - dk.width / 2), Z(MAIN.min[1] - 4.5), dk.width * S, 4.5 * S, 0.4)
    o.text("DOCK", X(dk.x), Z(MAIN.min[1] - 2.2) + 1.4, { pt: 10, weight: 800, align: "center" })
    // Annex continues east off the sheet.
    const ax = MAIN.max[0]
    o.fill(X(ax), Z(BUILDING.annex.max[1]) - 0.5, 1.2 * S, 1)
    door(o, { x: ANNEX_DOOR.x, z: ANNEX_DOOR.z, axis: "z", w: ANNEX_DOOR.width, state: "keycard" }, 1)
    o.text("ANNEX →", X(ax) + 1.2, Z(-14), { pt: 8, weight: 800, rot: -Math.PI / 2 })
    o.text("MAIN ENTRANCE", X(0), Z(MAIN.max[1]) + 6, { pt: 10, weight: 800, align: "center" })
    o.poly([[X(0), Z(MAIN.max[1]) + 1.2], [X(0) - 1.4, Z(MAIN.max[1]) + 3], [X(0) + 1.4, Z(MAIN.max[1]) + 3]], 0, INK.toner, { close: true, fill: INK.toner })
    o.rect(X(MAIN.min[0] - FIRE_ESCAPE.depth), Z(FIRE_ESCAPE.z0), FIRE_ESCAPE.depth * S, (FIRE_ESCAPE.z1 - FIRE_ESCAPE.z0) * S, 0.2, INK.toner, undefined, [1.2, 0.8])
  } else {
    const fx0 = MAIN.min[0] - FIRE_ESCAPE.depth
    o.rect(X(fx0), Z(FIRE_ESCAPE.z0), FIRE_ESCAPE.depth * S, (FIRE_ESCAPE.z1 - FIRE_ESCAPE.z0) * S, 0.35)
    for (let z = FIRE_ESCAPE.z0 + 0.4; z < FIRE_ESCAPE.z1 - 0.2; z += 0.6) o.line(X(fx0), Z(z), X(MAIN.min[0]), Z(z), 0.12)
    door(o, { x: MAIN.min[0] + 0.25, z: FIRE_ESCAPE.door.z, axis: "z", w: FIRE_ESCAPE.door.width, state: "open" }, -1)
  }
  o.text("FIRE ESC.", X(MAIN.min[0] - FIRE_ESCAPE.depth) - 1.4, Z(0), { pt: 8.5, weight: 800, align: "center", rot: -Math.PI / 2 })
  for (const d of plan.doors) door(o, d)
  for (const r of plan.rooms) roomLabel(o, r, storey)
  // Washrooms: one word each, wherever the service stack is.
  for (const r of plan.rooms) {
    if (r.id !== "WCM" && r.id !== "WCW") continue
    o.text(r.id === "WCM" ? "WC · M" : "WC · W", X((r.x0 + r.x1) / 2) + 1.4, Z((r.z0 + r.z1) / 2), { pt: 8.5, weight: 800, align: "center", rot: -Math.PI / 2 })
  }
  if (storey === 0 && !plan.rooms.some((r) => r.id === "0-01")) {
    const l = INTERIOR.lobby
    roomLabel(o, { id: "0-01", name: "Lobby", x0: l.min[0], x1: l.max[0], z0: l.min[1] + 3, z1: l.max[1] }, 0)
  }
  for (const x of [-20, 18]) o.text("C O R R I D O R", X(x), Z(0) + 1.3, { pt: 8.5, weight: 800, align: "center" })
  northArrow(o, W - 18, Hs - 24)
}

// ------------------------------------------------------------------------------------------------ roof

function drawRoof(o: Sheet) {
  OY = 52
  northArrow(o, W - 18, Hs - 24)
  const [x0, z0] = MAIN.min
  const [x1, z1] = MAIN.max
  o.rect(X(x0), Z(z0), (x1 - x0) * S, (z1 - z0) * S, 1)
  o.rect(X(x0 + 0.4), Z(z0 + 0.4), (x1 - x0 - 0.8) * S, (z1 - z0 - 0.8) * S, 0.2)
  const hx0 = -43.45
  const hx1 = -35.95
  const hz0 = CORE.stair.min[1] - 0.15
  const hz1 = z1 + 3.2
  o.rect(X(hx0), Z(hz0), (hx1 - hx0) * S, (hz1 - hz0) * S, 0.6)
  o.hatch(X(hx0), Z(hz0), (hx1 - hx0) * S, (hz1 - hz0) * S, 1.4, 0.12)
  o.fill(X(CORE.roofDoor.x - CORE.roofDoor.width / 2), Z(hz0) - 0.4, CORE.roofDoor.width * S, 1.2, PAPER)
  door(o, { x: CORE.roofDoor.x, z: hz0, axis: "x", w: CORE.roofDoor.width, state: "open" }, -1)
  o.text("ROOF DOOR", X(CORE.roofDoor.x), Z(hz0) - 5, { pt: 10, weight: 800, align: "center" })
  o.text("STAIRS", X((hx0 + hx1) / 2) + 1.4, Z((hz0 + hz1) / 2) + 1, { pt: 9.5, weight: 800, align: "center", rot: -Math.PI / 2 })
  const P = { x0: -12, z0: -14, x1: 22, z1: 7 }
  o.rect(X(P.x0), Z(P.z0), (P.x1 - P.x0) * S, (P.z1 - P.z0) * S, 0.6)
  o.text("DISH PLINTH", X(P.x0) + 2, Z(P.z1) - 2.4, { pt: 9.5, weight: 800 })
  const d = BUILDING.dish
  o.circle(X(d.x), Z(d.z), 2.4 * S, 0.5)
  o.circle(X(d.x), Z(d.z), (d.diameter / 2) * S, 0.3, INK.toner, undefined, [2.4, 1.2])
  o.text("RADIO DISH (OVERHEAD)", X(d.x), Z(d.z - d.diameter / 2) - 2, { pt: 11, weight: 800, align: "center" })
  o.hatch(X(RISER.min[0]), Z(RISER.min[1]), (RISER.max[0] - RISER.min[0]) * S, (RISER.max[1] - RISER.min[1]) * S, 0.6, 0.15)
  o.text("FEED ↓ W-1", X(d.x) + 4, Z(d.z) + 1.4, { pt: 9.5, weight: 800 })
  const fx0 = x0 - FIRE_ESCAPE.depth
  o.rect(X(fx0), Z(FIRE_ESCAPE.z0), FIRE_ESCAPE.depth * S, (FIRE_ESCAPE.z1 - FIRE_ESCAPE.z0) * S, 0.2, INK.toner, undefined, [1.2, 0.8])
  const lz = FIRE_ESCAPE.z1 - 0.55
  o.rect(X(fx0 + 0.5), Z(lz - 0.4), 0.9 * S, 0.8 * S, 0.35)
  o.text("LADDER FROM FIRE ESC.", X(x0) + 2.5, Z(lz) + 1.6, { pt: 9.5, weight: 800 })
  const A = BUILDING.annex
  o.line(X(x1), Z(A.max[1]), X(x1 + 1.2), Z(A.max[1]), 0.6)
  for (const [x, z, w, dd] of [[-30, -8, 4.5, 2.2], [-20, 12, 4.5, 2.2], [28, 12, 2.2, 4.5]] as const) {
    o.rect(X(x - w / 2), Z(z - dd / 2), w * S, dd * S, 0.4)
    o.text("AHU", X(x), Z(z) + 1.2, { pt: 8.5, weight: 800, align: "center" })
  }
}

// ------------------------------------------------------------------------------------------------ site plan

const SC = 0.6
const SX = (x: number) => 16 + (x + 100) * SC
const SZ = (z: number) => 48 + (z + 128) * SC

function offsetLine(pts: Vec2[], d: number, map: (p: Vec2) => [number, number]) {
  const out: [number, number][] = []
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)]!
    const b = pts[Math.min(pts.length - 1, i + 1)]!
    const tx = b[0] - a[0]
    const tz = b[1] - a[1]
    const l = Math.hypot(tx, tz) || 1
    out.push(map([pts[i]![0] + (tz / l) * d, pts[i]![1] - (tx / l) * d]))
  }
  return out
}

function treeSymbol(o: Sheet, x: number, y: number, r: number) {
  const pts: [number, number][] = []
  const n = 9
  for (let i = 0; i <= n * 4; i++) {
    const t = (i / (n * 4)) * Math.PI * 2
    const k = 1 + 0.18 * Math.abs(Math.sin((t * n) / 2))
    pts.push([x + Math.cos(t) * r * k, y + Math.sin(t) * r * k])
  }
  o.poly(pts, 0.16, INK.toner, { close: true })
}

/** Vicinity map (key plan) on the right. */
const vx0 = 150
const vy0 = 52
const vw = 117
const vh = 128
const VS = 0.16
const VX = (x: number) => vx0 + vw / 2 + (x + 50) * VS
const VZ = (z: number) => vy0 + 8 + (z + 260) * VS
const VP = (p: Vec2) => [VX(p[0]), VZ(p[1])] as [number, number]

function clipped(o: Sheet, x0: number, y0: number, x1: number, y1: number, fn: () => void) {
  o.g.save()
  o.g.beginPath()
  o.g.rect(x0, y0, x1 - x0, y1 - y0)
  o.g.clip()
  fn()
  o.g.restore()
}

function drawSite(o: Sheet, job: PageJob) {
  const road = accessRoadSamples(4)
  clipped(o, 7, 46, 144, Hs - 7, () => {
    for (let i = 0; i < 260; i++) {
      const x = o.rr(-125, 125)
      const z = o.rr(-150, 175)
      if (x > FENCE.min[0] - 8 && x < FENCE.max[0] + 8 && z > FENCE.min[1] - 8 && z < FENCE.max[1] + 4) continue
      if (road.some(([rx, rz]) => Math.hypot(rx - x, rz - z) < 14)) continue
      if (northTrackDistance(x, z) < 8) continue
      if (Math.abs(x - BOOTH.x) < 20 && Math.abs(z - BOOTH.z) < 16) continue
      treeSymbol(o, SX(x), SZ(z), o.rr(1.4, 2.1))
    }
    const hw = ACCESS_ROAD.width / 2
    o.poly(offsetLine(road, hw, (p) => [SX(p[0]), SZ(p[1])]), 0.45)
    o.poly(offsetLine(road, -hw, (p) => [SX(p[0]), SZ(p[1])]), 0.45)
  })
  // Fence and gate.
  const [fx0, fz0] = FENCE.min
  const [fx1, fz1] = FENCE.max
  // Two runs: south gate → west → north gate, and north gate → east → south gate.
  const runs: [number, number][][] = [
    [[FENCE.gate.x0, fz1], [fx0, fz1], [fx0, fz0], [NORTH_GATE.x0, fz0]],
    [[NORTH_GATE.x1, fz0], [fx1, fz0], [fx1, fz1], [FENCE.gate.x1, fz1]],
  ]
  for (const fence of runs) {
    o.poly(fence.map(([x, z]) => [SX(x), SZ(z)] as [number, number]), 0.3)
    for (let i = 0; i < fence.length - 1; i++) {
      const [ax, az] = fence[i]!
      const [bx, bz] = fence[i + 1]!
      const len = Math.hypot(bx - ax, bz - az)
      for (let t = 7; t < len; t += 14) {
        const x = SX(ax + ((bx - ax) * t) / len)
        const y = SZ(az + ((bz - az) * t) / len)
        o.line(x - 0.8, y - 0.8, x + 0.8, y + 0.8, 0.18)
        o.line(x - 0.8, y + 0.8, x + 0.8, y - 0.8, 0.18)
      }
    }
  }
  // North track: dashed edges from the dock court through the north gate to the array site.
  const nt = northTrackSamples(2)
  const nhw = NORTH_TRACK.width / 2
  o.poly(offsetLine(nt, nhw, (p) => [SX(p[0]), SZ(p[1])]), 0.25, INK.toner, { dash: [1.2, 0.8] })
  o.poly(offsetLine(nt, -nhw, (p) => [SX(p[0]), SZ(p[1])]), 0.25, INK.toner, { dash: [1.2, 0.8] })
  o.text("N. GATE", SX(NORTH_GATE.x1) + 2, SZ(fz0) - 1.5, { pt: 8.5, weight: 800 })
  o.text("FENCE", SX(fx0) + 2, SZ(60), { pt: 8.5, weight: 800, rot: -Math.PI / 2 })
  o.text("GATE", SX(FENCE.gate.x0) - 2, SZ(fz1) + 4, { pt: 10, weight: 800, align: "right" })
  o.rect(SX(BOOTH.x - BOOTH.w / 2), SZ(BOOTH.z - BOOTH.d / 2), BOOTH.w * SC, BOOTH.d * SC, 0.3, INK.toner, INK.toner)
  o.text("BOOTH", SX(BOOTH.x) + 3, SZ(BOOTH.z) + 2, { pt: 10, weight: 800 })
  const L = PARKING_LOT
  o.rect(SX(L.min[0]), SZ(L.min[1]), (L.max[0] - L.min[0]) * SC, (L.max[1] - L.min[1]) * SC, 0.35)
  for (const r of job.facts.lotRows) {
    for (const side of [-1, 1]) {
      for (let i = 0; i <= 14; i += 2) {
        const x = side * (job.facts.aisleX + i * 2.7)
        if (Math.abs(x) > L.max[0] - 0.5) break
        o.line(SX(x), SZ(r.head), SX(x), SZ(r.head - r.facing * 5.4), 0.12)
      }
    }
  }
  o.text("PARKING", SX(-22), SZ(84), { pt: 11, weight: 800, align: "center" })
  const M = MAIN
  o.rect(SX(M.min[0]), SZ(M.min[1]), (M.max[0] - M.min[0]) * SC, (M.max[1] - M.min[1]) * SC, 0.7)
  o.hatch(SX(M.min[0]), SZ(M.min[1]), (M.max[0] - M.min[0]) * SC, (M.max[1] - M.min[1]) * SC, 1.6, 0.12)
  const A = BUILDING.annex
  o.rect(SX(A.min[0]), SZ(A.min[1]), (A.max[0] - A.min[0]) * SC, (A.max[1] - A.min[1]) * SC, 0.5, INK.toner, PAPER)
  o.text("ANNEX", SX((A.min[0] + A.max[0]) / 2), SZ(-14) + 1, { pt: 9, weight: 800, align: "center" })
  o.rect(SX(-43.45), SZ(M.max[1]), 7.5 * SC, 3.2 * SC, 0.3, INK.toner, INK.toner)
  const dk = BUILDING.dock
  o.rect(SX(dk.x - dk.width / 2), SZ(M.min[1] - 4.5), dk.width * SC, 4.5 * SC, 0.4, INK.toner, PAPER)
  o.text("DOCK", SX(dk.x), SZ(M.min[1] - 6) - 0.5, { pt: 9, weight: 800, align: "center" })
  o.circle(SX(BUILDING.dish.x), SZ(BUILDING.dish.z), (BUILDING.dish.diameter / 2) * SC, 0.25, INK.toner, PAPER, [1.4, 0.9])
  o.fill(SX(-24) - 16, SZ(-1) - 4.6, 32, 6.4, PAPER)
  o.text("MAIN BLOCK", SX(-24), SZ(-1), { pt: 12, weight: 800, align: "center" })
  o.text("ENTRANCE", SX(0), SZ(M.max[1]) + 4.5, { pt: 9, weight: 800, align: "center" })
  o.rect(SX(M.min[0] - FIRE_ESCAPE.depth), SZ(FIRE_ESCAPE.z0), FIRE_ESCAPE.depth * SC, (FIRE_ESCAPE.z1 - FIRE_ESCAPE.z0) * SC, 0.3)
  o.text("FIRE ESC.", SX(M.min[0]) - 3, SZ(0), { pt: 8, weight: 800, align: "center", rot: -Math.PI / 2 })
  // Closed north lot: from the truck court (z -50) to 6 m short of the north fence, whatever the fence bounds are.
  const nlZ0 = FENCE.min[1] + 6
  o.rect(SX(-40), SZ(nlZ0), 70 * SC, (-50 - nlZ0) * SC, 0.25, INK.toner, undefined, [2.4, 1.2])
  o.text("NORTH LOT", SX(-5), SZ((nlZ0 - 50) / 2), { pt: 11, weight: 800, align: "center" })
  o.text("(CLOSED)", SX(-5), SZ((nlZ0 - 50) / 2) + 4.6, { pt: 9, weight: 700, align: "center" })
  o.rect(SX(A.max[0] + 3.9), SZ(-19.4), 3.2 * SC, 6.8 * SC, 0.3, INK.toner, INK.toner)
  o.text("GEN.", SX(A.max[0] + 3.9) + 3, SZ(-16) + 1, { pt: 8.5, weight: 800 })

  // Vicinity map.
  o.rect(vx0, vy0, vw, vh, 0.5)
  o.text("VICINITY", vx0 + 3, vy0 + 7, { font: FONT.title, pt: 13, weight: 700 })
  o.text("NOT TO SCALE", vx0 + 3, vy0 + 11.5, { pt: 7, weight: 600 })
  clipped(o, vx0, vy0, vx0 + vw, vy0 + vh, () => {
    for (let i = 0; i < 110; i++) {
      const x = o.rr(-420, 320)
      const z = o.rr(-260, 520)
      if (Math.abs(x) < 105 && z > -135 && z < 135) continue
      if (accessRoadSamples(10).some(([rx, rz]) => Math.hypot(rx - x, rz - z) < 24)) continue
      if (Math.abs(z - 430) < 26) continue
      treeSymbol(o, VX(x), VZ(z), 1.3)
    }
    const r6 = accessRoadSamples(6)
    o.poly(r6.map((p) => [VX(p[0]), VZ(p[1])] as [number, number]), 0.7)
    const county = countyRoadSamples(-600, 600, 8)
    o.poly(offsetLine(county, 5, (p) => [VX(p[0]), VZ(p[1])]), 0.45)
    o.poly(offsetLine(county, -5, (p) => [VX(p[0]), VZ(p[1])]), 0.45)
    o.rect(VX(FENCE.min[0]), VZ(FENCE.min[1]), (FENCE.max[0] - FENCE.min[0]) * VS, (FENCE.max[1] - FENCE.min[1]) * VS, 0.35)
    o.fill(VX(MAIN.min[0]), VZ(MAIN.min[1]), (MAIN.max[0] - MAIN.min[0]) * VS, (MAIN.max[1] - MAIN.min[1]) * VS)
    o.poly(offsetLine(r6, -POWER.offset, (p) => [VX(p[0]), VZ(p[1])]), 0.16, INK.toner, { dash: [0.6, 1] })
  })
  o.text("STATION", VX(FENCE.max[0]) + 2, VZ(0), { pt: 9.5, weight: 800 })
  o.text("CO. RD 14", vx0 + 3, VZ(420) - 2, { pt: 9.5, weight: 800 })
  o.text("TOWN 6 MI →", vx0 + vw - 3, VZ(452) + 5, { pt: 9, weight: 800, align: "right" })
}

// ------------------------------------------------------------------------------------------------ notes on the copy

function copyStamp(q: Sheet, index: number) {
  q.stamp(["CONTROLLED COPY", "No. 14"], W - 40, Hs - 22, q.rr(-0.12, 0.04), INK.stamp, 7, 0.55)
  if (index === 4) q.stamp(["RESTRICTED"], W - 82, Hs - 19, 0.1, INK.stampRed, 9, 0.55)
}

type Note = { text: string[]; at: [number, number]; to?: [number, number]; ring?: [number, number, number, number]; pt?: number; slant?: number; color?: string; under?: boolean }

function writeNotes(q: Sheet, notes: Note[]) {
  for (const n of notes) {
    const pt = n.pt ?? 20
    const lh = pt * 0.3528 * 0.92
    n.text.forEach((l, i) => {
      const end = q.hand(l, n.at[0], n.at[1] + i * lh, { pt, slant: n.slant ?? q.rr(-0.03, 0.015), color: n.color })
      if (n.under && i === n.text.length - 1) q.scribble([[n.at[0], n.at[1] + i * lh + 1.6], [end - 2, n.at[1] + i * lh + 1.2]], 0.5, n.color)
    })
    if (n.ring) q.ring(n.ring[0], n.ring[1], n.ring[2], n.ring[3], n.color, 0.55)
    if (n.to) {
      const w = Math.min(40, q.width(n.text[0]!, pt, FONT.hand, 640))
      const sx = n.to[0] < n.at[0] ? n.at[0] - 1.5 : n.at[0] + w * 0.5
      const sy = n.to[1] < n.at[1] ? n.at[1] - pt * 0.3528 * 0.8 : n.at[1] + (n.text.length - 1) * lh + 2
      q.arrow(sx, sy, n.to[0], n.to[1], n.color, q.rr(-0.14, 0.14), 0.5)
    }
  }
}

function roomAt(plan: StoreyPlan | undefined, id: string, fx: number, fz: number): [number, number] {
  const r = plan?.rooms.find((p) => p.id === id)
  return r ? [X((r.x0 + r.x1) / 2), Z((r.z0 + r.z1) / 2)] : [X(fx), Z(fz)]
}

function floorNotes(q: Sheet, storey: number, plan: StoreyPlan | undefined) {
  OY = storey === 0 ? 60 : 52
  const at = (id: string, fx: number, fz: number) => roomAt(plan, id, fx, fz)
  const notes: Note[] = []
  // Notes sit in the band above the plan (right of the title) and the band under it.
  if (storey === 0) {
    const fl1: [number, number] = [X((FREIGHT.car.min[0] + FREIGHT.car.max[0]) / 2), Z((FREIGHT.car.min[1] + FREIGHT.car.max[1]) / 2)]
    const off = at("0-30", -51, 6)
    const sec = at("0-38", 13, 15)
    notes.push(
      { text: ["field team: 6 unaccounted"], at: [118, 30], to: [fl1[0] + 4, fl1[1] - 4], ring: [fl1[0], fl1[1], 7, 6] },
      { text: ["your office, keys in the cabinet"], at: [16, Hs - 12], to: [off[0] + 1, off[1] + 5] },
      { text: ["guard desk empty?"], at: [150, Hs - 12], to: [sec[0], sec[1] + 6] },
    )
  } else if (storey === 1) {
    const chief = at("1-07", -18, -17)
    const board = at("1-09", 0, -12)
    notes.push(
      { text: ["Chief's office. Memo re: the 6?"], at: [82, 30], to: [chief[0], chief[1] - 5] },
      { text: ["in/out board: 6 still out (field)"], at: [118, Hs - 12], to: [board[0] + 3, board[1] + 6] },
    )
  } else if (storey === 2) {
    const lab = at("2-27", 14, 12)
    const cont = at("2-10", 28, -12)
    notes.push(
      { text: ["hot plate on in 2-27. Turn it OFF"], at: [96, Hs - 12], to: [lab[0], lab[1] + 6], ring: [lab[0], lab[1], 12, 7] },
      { text: ["containment: keycard only"], at: [130, 30], to: [cont[0], cont[1] - 5] },
    )
  } else if (storey === 3) {
    const lr = at("3-08", 6, -12)
    notes.push({ text: ["RADIO TRAFFIC:", "LISTENING ROOM?"], at: [104, 21], to: [lr[0] + 1, lr[1] - 9], ring: [lr[0], lr[1], 12, 21], pt: 26, under: true })
    q.ring(lr[0], lr[1], 13.5, 22.5, INK.ballBlue, 0.45)
  } else if (storey === 4) {
    const dir = at("4-14", 28, 15)
    notes.push(
      { text: ["WEST HALF: DO NOT ENTER"], at: [86, 30], pt: 20, color: INK.red },
      { text: ["Director R.H. still in there??"], at: [120, Hs - 12], to: [dir[0] - 1, dir[1] + 6], ring: [dir[0], dir[1], 14, 9] },
    )
    q.scribble([[X(-54.4), Z(-2)], [X(-4.8), Z(-21.3)]], 0.5, INK.red, 0.25)
    q.scribble([[X(-54.4), Z(-21.3)], [X(-4.8), Z(-2)]], 0.5, INK.red, 0.25)
  }
  writeNotes(q, notes)
}

function roofNotes(q: Sheet) {
  OY = 52
  writeNotes(q, [
    { text: ["roof door, alarmed?"], at: [20, Hs - 12], to: [X(-39.7) + 1, Z(25.2) + 2] },
    { text: ["dish feed → down W-1 to 4-11"], at: [104, 30], to: [X(6) + 2, Z(-4) - 4] },
  ])
}

function siteNotes(q: Sheet, briefing: string[]) {
  const ink = INK.ballBlack
  // The briefing, across the top of the first sheet.
  if (briefing[0]) {
    const end = q.hand(briefing[0], 92, 22, { pt: 24, color: ink, slant: -0.012 })
    q.scribble([[92, 24], [end - 3, 23.2]], 0.55, ink)
  }
  if (briefing[1]) q.hand(briefing[1], 96, 33, { pt: 16, color: ink, slant: -0.01 })
  writeNotes(q, [
    { text: ["gate code?"], at: [SX(-88), SZ(108)], to: [SX(-6), SZ(FENCE.max[1]) - 1], ring: [SX(0), SZ(FENCE.max[1]), 6, 3], color: ink },
    { text: ["staff door (west)"], at: [SX(-96), SZ(-38)], to: [SX(-57), SZ(-9)], color: ink, pt: 17 },
  ])
  const pts = SITE_NOTES.trail.map(VP)
  q.scribble(pts, 0.4, ink, 0.3)
  const [sx, sy] = VP(SITE_NOTES.weatherShed)
  q.scribble([[sx - 1.6, sy - 1.3], [sx + 1.6, sy - 1.3], [sx + 1.6, sy + 1.3], [sx - 1.6, sy + 1.3], [sx - 1.6, sy - 1.3]], 0.4, ink, 0.1)
  q.hand("wx station shed", sx - 3, sy - 3, { pt: 13, color: ink })
  q.hand("trail", pts[2]![0] + 2, pts[2]![1] + 1, { pt: 13, color: ink, slant: 0.5 })
  const lr = SITE_NOTES.loggingRoad.map(VP)
  q.scribble(lr, 0.4, ink, 0.25)
  const [ex, ey] = lr[lr.length - 1]!
  q.scribble([[ex - 1.4, ey - 1.4], [ex + 1.4, ey + 1.4]], 0.45, ink, 0.05)
  q.scribble([[ex - 1.4, ey + 1.4], [ex + 1.4, ey - 1.4]], 0.45, ink, 0.05)
  q.hand("old logging rd, ends here", lr[1]![0] - 30, lr[1]![1] - 4, { pt: 13, color: ink, slant: 0.08 })
  const [cx, cy] = VP(SITE_NOTES.clearing)
  q.ring(cx, cy, 4.5, 3.4, ink, 0.4)
  q.hand("clearing", cx - 7, cy + 8, { pt: 13, color: ink })
  q.hand("Brandt: forest marks rough", vx0 + 3, vy0 + vh + 9, { pt: 13, color: ink })
}

export type { Ctx }
