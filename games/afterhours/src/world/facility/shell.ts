import * as THREE from "three/webgpu"
import { BUILDING, CORE as PLAN, FIRE_ESCAPE, ROOF_Y, storeyY } from "../layout"
import type { Lamp, WorldContext } from "../context"
import { Batch, QuadBuilder, SKIP_BOTTOM, rng } from "./geo"
import { material } from "../../render/materials"
import { buildFireEscape } from "./firescape"
import { addFacadeDoor, glassLeaf, steelLeaf } from "./doors"
import { clearGlassMaterial, decalMaterial, windowMaterial } from "./windows"

// The facility's outer shell: board-formed concrete walls built inward from the footprint, recessed window rows on
// every storey, floor-line bands, fins, plinth, parapets and coping, walkable roof decks, the stair/lift core tower
// (open to the interior's stair, with a door out onto the roof), the west fire escape, the glazed lobby front with
// its canopy, the ground slab and the exterior wall colliders. Interior partitions and upper slabs are the
// interior builder's. Main-block windows are real glass (the interior's rooms show through); only the annex, which
// has no interior, keeps fake lit rooms.

const T = BUILDING.wallThickness
const MAIN = BUILDING.main
const ANNEX = BUILDING.annex
const FY = BUILDING.floorY
const ENT = BUILDING.entrance

const SH = MAIN.storeyHeight
const STOREYS = MAIN.storeys
/** Window row (sill/head above grade) for storey `k`; the ground floor keeps its low strip windows. */
export const storeyRow = (k: number) => (k === 0 ? { sill: 1.0, head: 2.35 } : { sill: k * SH + 0.95, head: k * SH + 2.75 })
/** Floor-line band expressing the slab edge at storey `k` (k ≥ 1). */
export const band = (k: number) => ({ y0: k * SH - 0.35, y1: k * SH + 0.3, proj: 0.12 })
/** Heavy crown fascia round the top of the main block, over the top storey's windows. */
export const CROWN = { y0: STOREYS * SH - 0.45, proj: 0.4 }
const FIN = { w: 0.42, proj: 0.55 }
const PLINTH = { y1: 0.55, proj: 0.05 }
const COPING = { h: 0.14, proj: 0.07 }
export const MAIN_ROOF_Y = ROOF_Y
export const ANNEX_ROOF_Y = 4.6
/** Parapet tops: a guard height above each walkable roof deck. */
export const MAIN_TOP = ROOF_Y + 1.05
export const ANNEX_TOP = ANNEX_ROOF_Y + 1.0
/** Stair and lift core tower: projects from the south face and rises above the roof as the stair house. */
export const CORE = { x0: PLAN.stair.min[0] - T, x1: PLAN.lift.max[0] + T, z0: PLAN.stair.min[1] - T, z1: MAIN.max[1] + 3.2, top: MAIN_TOP + 3.2 }
/** Door from the stair house onto the roof (north face of the tower). */
export const ROOF_DOOR = { x0: PLAN.roofDoor.x - PLAN.roofDoor.width / 2, x1: PLAN.roofDoor.x + PLAN.roofDoor.width / 2, y0: ROOF_Y, y1: ROOF_Y + 2.1 }
const FE = FIRE_ESCAPE
const FE_DOOR = { z0: FE.door.z - FE.door.width / 2, z1: FE.door.z + FE.door.width / 2, h: 2.1 }
const coreSkip: [number, number][] = [[CORE.x0 + 0.1, CORE.x1 - 0.1]]
const GLASS_D = 0.26
const MODULE = 5.4
const OPENING = 3.3
const PANES = 3

type Hole = { u0: number; u1: number; y0: number; y1: number; kind: "window" | "storefront" | "door" | "rollup" | "rollupOpen" | "fireDoor" | "open" }

export type Facade = {
  name: string
  axis: "x" | "z"
  /** Outer face coordinate on the other axis. */
  fixed: number
  /** Outward normal sign on the other axis. */
  out: 1 | -1
  u0: number
  u1: number
  y0: number
  y1: number
  holes: Hole[]
}

export const tangent = (f: Facade) => (f.axis === "x" ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1))
export const normal = (f: Facade) => (f.axis === "x" ? new THREE.Vector3(0, 0, f.out) : new THREE.Vector3(f.out, 0, 0))
/** World point at facade coords: u along, y up, d inward from the outer face (negative = proud of the wall). */
export const point = (f: Facade, u: number, y: number, d: number) =>
  f.axis === "x" ? new THREE.Vector3(u, y, f.fixed - f.out * d) : new THREE.Vector3(f.fixed - f.out * d, y, u)

export function fbox(b: Batch, mat: Parameters<Batch["box"]>[0], f: Facade, u0: number, u1: number, y0: number, y1: number, d0: number, d1: number, skip = 0) {
  const c0 = f.fixed - f.out * d0
  const c1 = f.fixed - f.out * d1
  if (f.axis === "x") b.box(mat, u0, y0, c0, u1, y1, c1, skip)
  else b.box(mat, c0, y0, u0, c1, y1, u1, skip)
}

function windowRow(u0: number, u1: number, row: { sill: number; head: number }, skip: [number, number][] = [], edge = 2.2): Hole[] {
  const pier = MODULE - OPENING
  const len = u1 - u0 - edge * 2
  const n = Math.max(0, Math.floor((len + pier) / MODULE))
  const start = (u0 + u1) / 2 - (n * MODULE - pier) / 2
  const out: Hole[] = []
  for (let i = 0; i < n; i++) {
    const a = start + i * MODULE
    const bnd = a + OPENING
    if (skip.some(([s0, s1]) => bnd > s0 && a < s1)) continue
    out.push({ u0: a, u1: bnd, y0: row.sill, y1: row.head, kind: "window" })
  }
  return out
}

function upperRows(u0: number, u1: number, skip: [number, number][] = [], from = 1): Hole[] {
  const out: Hole[] = []
  for (let k = from; k < STOREYS; k++) out.push(...windowRow(u0, u1, storeyRow(k), skip))
  return out
}

/** Pier centres between window bays on the upper storeys (where the vertical fins go). */
export function finPositions(f: Facade) {
  const wins = f.holes.filter((h) => h.kind === "window" && h.y0 > SH).sort((a, c) => a.u0 - c.u0)
  const us = new Set<number>()
  for (const h of wins) {
    us.add(Math.round((h.u0 - (MODULE - OPENING) / 2) * 100) / 100)
    us.add(Math.round((h.u1 + (MODULE - OPENING) / 2) * 100) / 100)
  }
  return [...us]
    .filter(
      (u) =>
        u > f.u0 + 0.4 &&
        u < f.u1 - 0.4 &&
        !(f.name === "main-south" && u > CORE.x0 - 0.3 && u < CORE.x1 + 0.3) &&
        !(f.name === "main-west" && u > FE.z0 - 0.6 && u < FE.z1 + 0.6),
    )
    .sort((a, c) => a - c)
}

export const DOCK_DOORS = {
  open: { u0: -29.7, u1: -26.5 },
  closed: { u0: -35.5, u1: -32.3 },
  man: { u0: -24.75, u1: -23.75 },
  y0: BUILDING.dock.height,
  head: 3.75,
  openHeight: 1.35,
}

export function facades(): Facade[] {
  const dockSkip: [number, number][] = [[-38, -21.5]]
  const lobbySkip: [number, number][] = [[-10.5, 10.5]]
  const mainSouth: Facade = {
    name: "main-south",
    axis: "x",
    fixed: MAIN.max[1],
    out: 1,
    u0: MAIN.min[0],
    u1: MAIN.max[0],
    y0: -0.3,
    y1: MAIN_TOP,
    holes: [
      ...windowRow(MAIN.min[0], MAIN.max[0], storeyRow(0), [...lobbySkip, ...coreSkip]),
      ...upperRows(MAIN.min[0], MAIN.max[0], coreSkip),
      { u0: -9, u1: 9, y0: FY, y1: 3.1, kind: "storefront" },
      // The core tower is open to the building on every storey (the interior's stair and lift run through).
      { u0: CORE.x0 + T, u1: CORE.x1 - T, y0: FY, y1: MAIN_TOP + 1, kind: "open" },
    ],
  }
  const d = DOCK_DOORS
  const mainNorth: Facade = {
    name: "main-north",
    axis: "x",
    fixed: MAIN.min[1],
    out: -1,
    u0: MAIN.min[0],
    u1: MAIN.max[0],
    y0: -0.3,
    y1: MAIN_TOP,
    holes: [
      ...windowRow(MAIN.min[0], MAIN.max[0], storeyRow(0), dockSkip),
      ...upperRows(MAIN.min[0], MAIN.max[0]),
      { ...d.open, y0: d.y0, y1: d.head, kind: "rollupOpen" },
      { ...d.closed, y0: d.y0, y1: d.head, kind: "rollup" },
      { ...d.man, y0: d.y0, y1: d.y0 + 2.1, kind: "door" },
    ],
  }
  const mainWest: Facade = {
    name: "main-west",
    axis: "z",
    fixed: MAIN.min[0],
    out: -1,
    u0: MAIN.min[1] + T,
    u1: MAIN.max[1] - T,
    y0: -0.3,
    y1: MAIN_TOP,
    holes: [
      ...windowRow(MAIN.min[1], MAIN.max[1], storeyRow(0), [[-12.5, -7]]),
      ...upperRows(MAIN.min[1], MAIN.max[1], [[FE_DOOR.z0 - 1.2, FE_DOOR.z1 + 1.2]]),
      { u0: -10.5, u1: -9.5, y0: FY, y1: FY + 2.1, kind: "door" },
      // Fire-escape doors onto each landing.
      ...Array.from({ length: STOREYS - 1 }, (_, i) => ({ u0: FE_DOOR.z0, u1: FE_DOOR.z1, y0: storeyY(i + 1), y1: storeyY(i + 1) + FE_DOOR.h, kind: "fireDoor" as const })),
    ],
  }
  const mainEast: Facade = {
    name: "main-east",
    axis: "z",
    fixed: MAIN.max[0],
    out: 1,
    u0: MAIN.min[1] + T,
    u1: MAIN.max[1] - T,
    y0: -0.3,
    y1: MAIN_TOP,
    holes: [
      ...windowRow(ANNEX.max[1], MAIN.max[1], storeyRow(0), [], 2.6),
      ...windowRow(ANNEX.max[1], MAIN.max[1], storeyRow(1), [], 2.6),
      ...upperRows(MAIN.min[1], MAIN.max[1], [[-17.2, -12.8]], 2),
    ],
  }
  const annexRow = { sill: 1.0, head: 2.35 }
  const annexSouth: Facade = {
    name: "annex-south",
    axis: "x",
    fixed: ANNEX.max[1],
    out: 1,
    u0: ANNEX.min[0],
    u1: ANNEX.max[0],
    y0: -0.3,
    y1: ANNEX_TOP,
    holes: windowRow(ANNEX.min[0], ANNEX.max[0], annexRow, [], 1.6),
  }
  const annexNorth: Facade = {
    name: "annex-north",
    axis: "x",
    fixed: ANNEX.min[1],
    out: -1,
    u0: ANNEX.min[0],
    u1: ANNEX.max[0],
    y0: -0.3,
    y1: ANNEX_TOP,
    holes: [...windowRow(ANNEX.min[0], ANNEX.max[0], annexRow, [[46, 50]], 1.6), { u0: 47.5, u1: 48.5, y0: FY, y1: FY + 2.1, kind: "door" }],
  }
  const annexEast: Facade = {
    name: "annex-east",
    axis: "z",
    fixed: ANNEX.max[0],
    out: 1,
    u0: ANNEX.min[1] + T,
    u1: ANNEX.max[1] - T,
    y0: -0.3,
    y1: ANNEX_TOP,
    holes: windowRow(ANNEX.min[1], ANNEX.max[1], annexRow, [[-24, -18]], 2),
  }
  const annexWest: Facade = {
    name: "annex-west",
    axis: "z",
    fixed: ANNEX.min[0],
    out: -1,
    u0: ANNEX.min[1] + T,
    u1: MAIN.min[1],
    y0: -0.3,
    y1: ANNEX_TOP,
    holes: windowRow(ANNEX.min[1], MAIN.min[1], annexRow, [], 1.6),
  }
  return [mainSouth, mainNorth, mainWest, mainEast, annexSouth, annexNorth, annexEast, annexWest]
}

/** Wall solid minus rectangular holes, as a set of boxes (strips between hole edges). */
function wallBoxes(b: Batch, f: Facade, mat: "concrete_wall") {
  const ys = new Set([f.y0, f.y1])
  for (const h of f.holes) {
    ys.add(Math.max(f.y0, Math.min(f.y1, h.y0)))
    ys.add(Math.max(f.y0, Math.min(f.y1, h.y1)))
  }
  const cuts = [...ys].sort((a, c) => a - c)
  for (let i = 0; i < cuts.length - 1; i++) {
    const ya = cuts[i]!
    const yb = cuts[i + 1]!
    const spans = f.holes
      .filter((h) => h.y0 <= ya + 1e-6 && h.y1 >= yb - 1e-6)
      .map((h) => [h.u0, h.u1] as const)
      .sort((a, c) => a[0] - c[0])
    let u = f.u0
    for (const [a, c] of spans) {
      if (a > u) fbox(b, mat, f, u, a, ya, yb, 0, T)
      u = Math.max(u, c)
    }
    if (u < f.u1) fbox(b, mat, f, u, f.u1, ya, yb, 0, T)
  }
}

export type ShellResult = {
  litPanes: { center: THREE.Vector3; normal: THREE.Vector3; color: [number, number, number]; facade: string; row: string }[]
}

const WARM: [number, number, number] = [1.4, 0.78, 0.36]
const COOL: [number, number, number] = [0.85, 1.1, 0.95]
const PALE: [number, number, number] = [1.25, 1.02, 0.62]
const GRIME: [number, number, number] = [0, 0, 0]
const RUST: [number, number, number] = [0.2, 0.075, 0.02]
const COPE = COPING.h

/** Spans of [a, b] left after removing `cuts`. */
function spans(a: number, b: number, cuts: readonly (readonly [number, number])[]) {
  const out: [number, number][] = []
  let u = a
  for (const [c0, c1] of [...cuts].sort((p, q) => p[0] - q[0])) {
    if (c1 <= u || c0 >= b) continue
    if (c0 > u) out.push([u, c0])
    u = Math.max(u, c1)
  }
  if (u < b) out.push([u, b])
  return out
}

const CORE_CUT: [number, number][] = [[CORE.x0, CORE.x1]]
const FE_CUT: [number, number][] = [[FE_DOOR.z0 - 0.05, FE_DOOR.z1 + 0.05]]

export function buildShell(ctx: WorldContext, root: THREE.Object3D): ShellResult {
  const b = new Batch()
  const glass = new Batch()
  const lit = new QuadBuilder(4)
  const stain = new QuadBuilder(4)
  const rand = rng(1984)
  const result: ShellResult = { litPanes: [] }
  const alu = material("metal_dark")
  const clear = clearGlassMaterial()

  // CRT rooms: specific openings left with a terminal on (facade, storey, index).
  const crtSlots = new Set(["main-south:s2:5", "main-west:s3:1", "main-north:s4:9", "main-north:s1:3", "main-south:s4:12", "annex-south:ground:1"])
  // Ground-floor windows that are guaranteed lit, because their spill matters for the views.
  const forcedLit = new Set(["main-south:ground:3", "main-south:ground:10", "main-north:ground:12", "annex-south:ground:3", "main-east:ground:0"])
  // 3 a.m.: one office corner on the fourth floor (south-east) still fully lit, someone working late.
  // and the second floor's south offices (the concepts' band of fluorescent windows) mostly still on.
  const lateFloor = (f: Facade, k: number, h: Hole) =>
    (k === 3 && ((f.name === "main-south" && h.u0 > 17) || (f.name === "main-east" && h.u0 > 9))) ||
    (k === 2 && f.name === "main-south" && h.u0 > -34 && h.u0 < 30 && Math.sin(h.u0 * 12.9898) * 43758.5 % 1 < 0.32)

  for (const f of facades()) {
    wallBoxes(b, f, "concrete_wall")
    const t = tangent(f)
    const n = normal(f)
    const isMain = f.name.startsWith("main")
    const counters = new Map<string, number>()
    for (const h of f.holes) {
      if (h.kind === "fireDoor") {
        fireDoor(ctx, root, b, f, h)
        continue
      }
      if (h.kind !== "window") continue
      const storey = isMain ? Math.floor(h.y0 / SH) : 0
      const row = storey === 0 ? "ground" : `s${storey}`
      const index = counters.get(row) ?? 0
      counters.set(row, index + 1)
      const id = `${f.name}:${row}:${index}`
      // Precast sill, proud of the wall, and the steel frame set back in the reveal.
      fbox(b, "concrete_dark", f, h.u0 - 0.08, h.u1 + 0.08, h.y0 - 0.1, h.y0 + 0.02, -0.07, GLASS_D)
      const fr = 0.06
      fbox(b, "metal_dark", f, h.u0, h.u1, h.y0 + 0.02, h.y0 + 0.02 + fr, GLASS_D - 0.04, GLASS_D + 0.04)
      fbox(b, "metal_dark", f, h.u0, h.u1, h.y1 - fr, h.y1, GLASS_D - 0.04, GLASS_D + 0.04)
      fbox(b, "metal_dark", f, h.u0, h.u0 + fr, h.y0, h.y1, GLASS_D - 0.04, GLASS_D + 0.04)
      fbox(b, "metal_dark", f, h.u1 - fr, h.u1, h.y0, h.y1, GLASS_D - 0.04, GLASS_D + 0.04)
      const paneW = (h.u1 - h.u0 - fr * 2) / PANES
      for (let p = 1; p < PANES; p++) {
        const m = h.u0 + fr + paneW * p
        fbox(b, "metal_dark", f, m - 0.035, m + 0.035, h.y0, h.y1, GLASS_D - 0.04, GLASS_D + 0.04)
      }
      // Hopper transom low in the taller office windows.
      if (storey > 0) fbox(b, "metal_dark", f, h.u0, h.u1, h.y0 + 0.5, h.y0 + 0.56, GLASS_D - 0.04, GLASS_D + 0.04)
      const roll = rand()
      const isCrt = crtSlots.has(id)
      const pLit = storey === 0 ? 0.1 : 0.06
      const roomLit = forcedLit.has(id) || lateFloor(f, storey, h) || (!isCrt && roll < pLit)
      const oneLit = !roomLit && !isCrt && roll < pLit + 0.05
      const tintRoll = rand()
      const tint = storey === 2 && f.name === "main-south" ? (tintRoll < 0.7 ? COOL : PALE) : tintRoll < 0.45 ? WARM : tintRoll < 0.8 ? PALE : COOL
      const litPane = Math.floor(rand() * PANES)
      const crtPane = Math.floor(rand() * PANES)
      // Main-block panes are see-through (real rooms behind): seeds offset by 2 switch the shaders to their
      // translucent, outward-only mode.
      const mode = isMain ? 2 : 0
      const y0 = h.y0 + 0.02 + fr
      const y1 = h.y1 - fr
      for (let p = 0; p < PANES; p++) {
        const a = h.u0 + fr + paneW * p + (p ? 0.035 : 0)
        const c = h.u0 + fr + paneW * (p + 1) - (p < PANES - 1 ? 0.035 : 0)
        const o = point(f, f.out > 0 === (f.axis === "x") ? a : c, y0, GLASS_D)
        const uVec = t.clone().multiplyScalar((c - a) * (f.out > 0 === (f.axis === "x") ? 1 : -1))
        const vVec = new THREE.Vector3(0, y1 - y0, 0)
        if (isCrt && p === crtPane) {
          lit.quad(o, uVec, vVec, n, [1, 1], [0.25 + rand() * 0.5, 0.25 + rand() * 0.2, rand(), rand() + mode + 4])
          if (isMain) fbox(glass, clear, f, a, c, y0, y1, GLASS_D + 0.005, GLASS_D + 0.012)
        } else if (roomLit || (oneLit && p === litPane)) {
          const k = 0.75 + rand() * 0.45
          const col: [number, number, number] = [tint[0] * k, tint[1] * k, tint[2] * k]
          lit.quad(o, uVec, vVec, n, [1, 1], [...col, rand() + mode])
          if (isMain) fbox(glass, clear, f, a, c, y0, y1, GLASS_D + 0.005, GLASS_D + 0.012)
          if (p === 1 || oneLit) {
            result.litPanes.push({ center: point(f, (a + c) / 2, (y0 + y1) / 2, GLASS_D), normal: n.clone(), color: col, facade: id, row })
          }
        } else if (isMain) {
          fbox(glass, clear, f, a, c, y0, y1, GLASS_D - 0.006, GLASS_D + 0.006)
        } else {
          fbox(glass, "glass_dark", f, a, c, y0, y1, GLASS_D - 0.01, GLASS_D + 0.01)
        }
      }
      // Streaks of grime running down from each sill.
      const below = storey > 0 ? h.y0 - 0.1 - band(storey).y1 : h.y0 - 0.1 - PLINTH.y1
      const len = Math.min(1.7, below)
      if (len > 0.2) addStain(stain, f, h.u0, h.u1, h.y0 - 0.1, len, 0.55 + rand() * 0.35)
    }

    // Plinth, coping and splash-back grime along the whole facade (the south face stops at the core tower).
    const top = f.y1
    const cp = COPING.proj + (isMain ? CROWN.proj : 0)
    const ext0 = f.axis === "z" ? T : 0
    const cuts = f.name === "main-south" ? CORE_CUT : []
    // The plinth stops at the lobby storefront so the threshold is flush.
    const plinthCuts: [number, number][] = f.name === "main-south" ? [...CORE_CUT, [-9.05, 9.05]] : cuts
    const px = f.axis === "x" ? PLINTH.proj : 0
    const cx = f.axis === "x" ? cp : 0
    for (const [a, c] of spans(f.u0 - ext0 - px, f.u1 + ext0 + px, plinthCuts)) fbox(b, "concrete_dark", f, a, c, -0.05, PLINTH.y1, -PLINTH.proj, 0, SKIP_BOTTOM)
    const zf = f.axis === "z" ? 0.002 : 0
    for (const [a, c] of spans(f.u0 - ext0 - cx, f.u1 + ext0 + cx, cuts)) fbox(b, "concrete_dark", f, a, c, top - zf, top + COPE - zf, -cp, T + 0.05)
    for (const [a, c] of spans(f.u0, f.u1, cuts)) addStain(stain, f, a, c, isMain ? CROWN.y0 : top, 1.4, 0.5)
    // Vertical fins between the upper window bays: the block's brutalist rhythm.
    if (isMain) {
      for (const u of finPositions(f)) {
        const y0 = f.name === "main-east" && u < ANNEX.max[1] + 0.5 ? ANNEX_TOP : SH - 0.35
        fbox(b, "concrete_wall", f, u - FIN.w / 2, u + FIN.w / 2, y0, CROWN.y0, -FIN.proj, 0)
        addStain(stain, f, u - FIN.w / 2 - 0.1, u + FIN.w / 2 + 0.1, CROWN.y0, 2.2, 0.35)
      }
    }
    for (const [a, c] of spans(f.u0, f.u1, plinthCuts)) addSplash(stain, f, a, c, PLINTH.y1, 0.7, 0.35)
  }

  // Floor-line bands at every slab and the heavy crown fascia (the annex covers the east band at the first floor).
  for (let k = 1; k < STOREYS; k++) {
    const bd = band(k)
    ring(b, "concrete_wall", bd.y0, bd.y1, bd.proj, bd.y0 < ANNEX_TOP ? ANNEX.max[1] : undefined, FE_CUT)
  }
  ring(b, "concrete_wall", CROWN.y0, MAIN_TOP, CROWN.proj)
  buildCore(ctx, root, b, glass, clear, stain, lit)

  // Fire escape on the west face, with rust weeping down the wall under each landing.
  const west = facades().find((f) => f.name === "main-west")!
  buildFireEscape(ctx, b, (z0, z1, yTop, len) => addStain(stain, west, z0, z1, yTop, len, 0.7, RUST))

  buildRoofDecks(ctx, b)

  // Ground-floor slabs: the player walks on these inside.
  b.box("concrete_floor", MAIN.min[0], -0.3, MAIN.min[1], MAIN.max[0], FY, MAIN.max[1], SKIP_BOTTOM)
  b.box("concrete_floor", ANNEX.min[0], -0.3, ANNEX.min[1], ANNEX.max[0], FY, ANNEX.max[1], SKIP_BOTTOM)
  ctx.floors.push({ min: MAIN.min, max: MAIN.max, y: FY }, { min: ANNEX.min, max: ANNEX.max, y: FY })

  buildEntrance(ctx, root, b, glass, alu, clear)

  b.flush(root, { name: "shell" })
  glass.flush(root, { name: "shell-glass", castShadow: false })

  const litMesh = new THREE.Mesh(lit.geometry("paneA"), windowMaterial())
  const stainMesh = new THREE.Mesh(stain.geometry("decal"), decalMaterial())
  stainMesh.renderOrder = 1
  for (const m of [litMesh, stainMesh]) {
    m.matrixAutoUpdate = false
    root.add(m)
  }

  wallColliders(ctx)
  return result
}

function addStain(q: QuadBuilder, f: Facade, u0: number, u1: number, yTop: number, len: number, strength: number, color = GRIME) {
  if (len <= 0 || strength <= 0) return
  const n = normal(f)
  const t = tangent(f)
  const flip = f.out > 0 === (f.axis === "x")
  const o = point(f, flip ? u0 : u1, yTop - len, -0.008)
  const uVec = t.clone().multiplyScalar((u1 - u0) * (flip ? 1 : -1))
  q.quad(o, uVec, new THREE.Vector3(0, len, 0), n, [flip ? u1 : -u1, 0], [...color, strength], [flip ? u0 : -u0, 1])
}

function addSplash(q: QuadBuilder, f: Facade, u0: number, u1: number, yBottom: number, len: number, strength: number) {
  const n = normal(f)
  const t = tangent(f)
  const flip = f.out > 0 === (f.axis === "x")
  const o = point(f, flip ? u0 : u1, yBottom, -0.008)
  const uVec = t.clone().multiplyScalar((u1 - u0) * (flip ? 1 : -1))
  q.quad(o, uVec, new THREE.Vector3(0, len, 0), n, [flip ? u1 : -u1, 1], [...GRIME, strength], [flip ? u0 : -u0, 0])
}

/** A projecting band all round the main block; the south side skips the core tower, the west side the fire doors. */
function ring(b: Batch, mat: "concrete_wall" | "concrete_dark", y0: number, y1: number, proj: number, eastFromZ?: number, westCuts: [number, number][] = []) {
  const min = MAIN.min
  const max = MAIN.max
  for (const [a, c] of spans(min[0] - proj, max[0] + proj, CORE_CUT)) b.box(mat, a, y0, max[1] - 0.05, c, y1, max[1] + proj)
  b.box(mat, min[0] - proj, y0, min[1] - proj, eastFromZ === undefined ? max[0] + proj : max[0], y1, min[1] + 0.05)
  for (const [a, c] of spans(min[1] + 0.05, max[1] - 0.05, westCuts)) b.box(mat, min[0] - proj, y0, a, min[0] + 0.05, y1, c)
  b.box(mat, max[0] - 0.05, y0, eastFromZ ?? min[1] + 0.05, max[0] + proj, y1, max[1] - 0.05)
}

/** Steel fire door onto a fire-escape landing: frame, flush threshold through the wall, a working leaf. */
function fireDoor(ctx: WorldContext, root: THREE.Object3D, b: Batch, f: Facade, h: Hole) {
  const fr = 0.06
  fbox(b, "metal_dark", f, h.u0 - fr, h.u1 + fr, h.y1, h.y1 + fr, -0.02, T)
  fbox(b, "metal_dark", f, h.u0 - fr, h.u0, h.y0, h.y1, -0.02, T)
  fbox(b, "metal_dark", f, h.u1, h.u1 + fr, h.y0, h.y1, -0.02, T)
  fbox(b, "metal_galvanized", f, h.u0, h.u1, h.y0 - 0.01, h.y0 + 0.006, 0, T)
  const a = point(f, h.u0, 0, -0.05)
  const c = point(f, h.u1, 0, T + 0.05)
  ctx.floors.push({ min: [Math.min(a.x, c.x), Math.min(a.z, c.z)], max: [Math.max(a.x, c.x), Math.max(a.z, c.z)], y: h.y0 })
  const k = Math.round(h.y0 / SH)
  // ~165° either way: flat against the wall outside (clear of the flights) or against the corridor's end wall inside.
  addFacadeDoor(ctx, root, {
    id: `fire-escape-${k}`,
    f,
    u0: h.u0 + 0.01,
    u1: h.u1 - 0.01,
    y0: h.y0,
    depth: 0.1,
    height: h.y1 - h.y0 - 0.02,
    leaf: steelLeaf(`fire-escape-${k}`, h.u1 - h.u0 - 0.02, h.y1 - h.y0 - 0.02),
    openAngle: 2.85,
    swing: "auto",
    sound: "steel",
  })
}

/**
 * The stair/lift core tower: projects 3.2 m from the south face and continues above the roof as the stair house
 * (north face with the roof door). Hollow: the interior builds the stair and lift inside it. A tall glazed slot over
 * the stair lets its landings glow through the fog.
 */
function buildCore(ctx: WorldContext, root: THREE.Object3D, b: Batch, glass: Batch, clear: THREE.Material, stain: QuadBuilder, lit: QuadBuilder) {
  const { x0, x1, z0, z1, top } = CORE
  const zs = MAIN.max[1]
  const col = (bx0: number, by0: number, bz0: number, bx1: number, by1: number, bz1: number) => {
    ctx.colliders.push({ min: [bx0, by0, bz0], max: [bx1, by1, bz1] })
  }
  // Side walls: full height where the tower projects, roof-to-top over the main block.
  for (const [a, c] of [[x0, x0 + T], [x1 - T, x1]] as const) {
    b.box("concrete_wall", a, -0.05, zs, c, top, z1, SKIP_BOTTOM)
    b.box("concrete_wall", a, ROOF_Y - 0.3, z0, c, top, zs)
    col(a, -0.5, zs, c, top, z1)
    col(a, ROOF_Y - 0.3, z0, c, top, zs)
  }
  // South wall with the stair slot.
  const sx0 = PLAN.stair.min[0] + 0.9
  const sx1 = PLAN.stair.max[0] - 0.9
  const sy0 = 1.0
  const sy1 = top - 1.3
  b.box("concrete_wall", x0 + T, -0.05, z1 - T, sx0, top, z1, SKIP_BOTTOM)
  b.box("concrete_wall", sx1, -0.05, z1 - T, x1 - T, top, z1, SKIP_BOTTOM)
  b.box("concrete_wall", sx0, -0.05, z1 - T, sx1, sy0, z1, SKIP_BOTTOM)
  b.box("concrete_wall", sx0, sy1, z1 - T, sx1, top, z1)
  col(x0, -0.5, z1 - T, x1, top, z1)
  glass.box(clear, sx0, sy0, z1 - 0.2, sx1, sy1, z1 - 0.19)
  b.box("metal_dark", sx0, sy0, z1 - 0.24, sx0 + 0.06, sy1, z1 - 0.16)
  b.box("metal_dark", sx1 - 0.06, sy0, z1 - 0.24, sx1, sy1, z1 - 0.16)
  for (let k = 0; k <= STOREYS; k++) {
    const y = Math.min(sy1 - 0.08, Math.max(sy0, storeyY(k) - 0.2))
    b.box("metal_dark", sx0, y, z1 - 0.25, sx1, y + 0.08, z1 - 0.15)
  }
  // Stairwell fluorescents left on all night: a glow on the slot glass around each half landing (one tube out).
  const n = new THREE.Vector3(0, 0, 1)
  for (let k = 0; k < STOREYS; k++) {
    if (k === 2) continue
    const yc = storeyY(k) + SH * 0.5
    const ya = Math.max(sy0 + 0.05, yc - 1.0)
    const yb = Math.min(sy1 - 0.05, yc + 1.0)
    lit.quad(new THREE.Vector3(sx0 + 0.06, ya, z1 - 0.185), new THREE.Vector3(sx1 - sx0 - 0.12, 0, 0), new THREE.Vector3(0, yb - ya, 0), n, [1, 1], [0.8, 0.98, 0.9, 2.92])
  }
  // North face of the stair house with the roof door.
  const D = ROOF_DOOR
  b.box("concrete_wall", x0, ROOF_Y - 0.3, z0, D.x0, top, z0 + T)
  b.box("concrete_wall", D.x1, ROOF_Y - 0.3, z0, x1, top, z0 + T)
  b.box("concrete_wall", D.x0, D.y1, z0, D.x1, top, z0 + T)
  col(x0, ROOF_Y - 0.3, z0, D.x0, top, z0 + T)
  col(D.x1, ROOF_Y - 0.3, z0, x1, top, z0 + T)
  col(D.x0, D.y1, z0, D.x1, top, z0 + T)
  roofDoor(ctx, root, b)
  // Roof slab, coping and plinth.
  b.box("concrete_wall", x0, top - 0.3, z0, x1, top, z1)
  b.box("concrete_dark", x0 - 0.08, top, z0 - 0.08, x1 + 0.08, top + 0.16, z1 + 0.08)
  b.box("concrete_dark", x0 - 0.06, -0.05, z1, x1 + 0.06, PLINTH.y1, z1 + PLINTH.proj, SKIP_BOTTOM)
  // Ground slab of the projecting part.
  b.box("concrete_floor", x0 + T, -0.3, zs, x1 - T, FY, z1 - T, SKIP_BOTTOM)
  ctx.floors.push({ min: [x0 + T, zs], max: [x1 - T, z1 - T], y: FY })
  // Lift motor-room louvres near the top of the east side.
  for (let k = 0; k < 7; k++) b.box("metal_dark", x1, top - 2.6 + k * 0.28, zs + 0.8, x1 + 0.04, top - 2.48 + k * 0.28, z1 - 0.8)
  const south: Facade = { name: "core", axis: "x", fixed: z1, out: 1, u0: x0, u1: x1, y0: 0, y1: top, holes: [] }
  addStain(stain, south, x0, sx0, top, 3.5, 0.6)
  addStain(stain, south, sx1, x1, top, 3.5, 0.6)
}

/** Steel door from the stair house onto the roof (working leaf), with a flood light above it (head from props.ts). */
function roofDoor(ctx: WorldContext, root: THREE.Object3D, b: Batch) {
  const D = ROOF_DOOR
  const z = CORE.z0
  const fr = 0.07
  b.box("metal_dark", D.x0 - fr, D.y0, z - 0.03, D.x0, D.y1 + fr, z + T)
  b.box("metal_dark", D.x1, D.y0, z - 0.03, D.x1 + fr, D.y1 + fr, z + T)
  b.box("metal_dark", D.x0, D.y1, z - 0.03, D.x1, D.y1 + fr, z + T)
  b.box("metal_galvanized", D.x0, D.y0 - 0.01, z, D.x1, D.y0 + 0.006, z + T)
  ctx.floors.push({ min: [D.x0, z - 0.1], max: [D.x1, z + T + 0.1], y: D.y0 })
  const leaf = steelLeaf("roof-door", D.x1 - D.x0 - 0.02, D.y1 - D.y0 - 0.02, 0.05, false)
  leaf.rotation.y = 0
  root.add(leaf)
  ctx.doors.add({
    id: "roof-door",
    leaf,
    hinge: [D.x0 + 0.01, D.y0, z + 0.06],
    width: D.x1 - D.x0 - 0.02,
    height: D.y1 - D.y0 - 0.02,
    thickness: 0.05,
    openAngle: 1.75,
    swing: "auto",
    sound: "steel",
  })
  ctx.lamps.push({
    kind: "incandescent",
    position: [(D.x0 + D.x1) / 2, D.y1 + 0.3, z - 0.45],
    direction: [0, -0.9, -0.43],
    color: [1, 0.7, 0.4],
    intensity: 60,
    range: 10,
    angle: 1.15,
    penumbra: 0.8,
    size: 0.15,
  })
}

/**
 * Walkable roof decks inside the parapets (gravel ballast), the parapet copings as narrow floors so a climber can
 * step over from a ladder, and the stair/lift openings left out of the main deck so the interior stair continues up.
 */
function buildRoofDecks(ctx: WorldContext, b: Batch) {
  const x0 = MAIN.min[0] + T
  const x1 = MAIN.max[0] - T
  const z0 = MAIN.min[1] + T
  const z1 = MAIN.max[1] - T
  const stair = PLAN.stair
  const lift = PLAN.lift
  const rects: [number, number, number, number][] = [
    [x0, stair.min[0], z0, z1],
    [lift.max[0], x1, z0, z1],
    [stair.min[0], lift.max[0], z0, stair.min[1]],
    [stair.max[0], lift.max[0], stair.min[1], lift.min[1]],
  ]
  for (const [a, c, d, e] of rects) {
    b.box("gravel", a, ROOF_Y - 0.3, d, c, ROOF_Y, e, SKIP_BOTTOM)
    ctx.floors.push({ min: [a, d], max: [c, e], y: ROOF_Y })
  }
  b.box("gravel", ANNEX.min[0], ANNEX_ROOF_Y - 0.3, ANNEX.min[1] + T, ANNEX.max[0] - T, ANNEX_ROOF_Y, ANNEX.max[1] - T, SKIP_BOTTOM)
  ctx.floors.push({ min: [ANNEX.min[0], ANNEX.min[1] + T], max: [ANNEX.max[0] - T, ANNEX.max[1] - T], y: ANNEX_ROOF_Y })
  // Coping tops.
  const cm = COPING.proj + CROWN.proj
  const my = MAIN_TOP + COPE
  for (const [a, c] of spans(MAIN.min[0] - cm, MAIN.max[0] + cm, CORE_CUT)) ctx.floors.push({ min: [a, MAIN.max[1] - T], max: [c, MAIN.max[1] + cm], y: my })
  ctx.floors.push({ min: [MAIN.min[0] - cm, MAIN.min[1] - cm], max: [MAIN.max[0] + cm, MAIN.min[1] + T], y: my })
  ctx.floors.push({ min: [MAIN.min[0] - cm, MAIN.min[1]], max: [MAIN.min[0] + T, MAIN.max[1]], y: my })
  ctx.floors.push({ min: [MAIN.max[0] - T, MAIN.min[1]], max: [MAIN.max[0] + cm, MAIN.max[1]], y: my })
  const ay = ANNEX_TOP + COPE
  const ap = COPING.proj
  ctx.floors.push({ min: [ANNEX.min[0], ANNEX.max[1] - T], max: [ANNEX.max[0] + ap, ANNEX.max[1] + ap], y: ay })
  ctx.floors.push({ min: [ANNEX.min[0] - ap, ANNEX.min[1] - ap], max: [ANNEX.max[0] + ap, ANNEX.min[1] + T], y: ay })
  ctx.floors.push({ min: [ANNEX.max[0] - T, ANNEX.min[1]], max: [ANNEX.max[0] + ap, ANNEX.max[1]], y: ay })
  ctx.floors.push({ min: [ANNEX.min[0] - ap, ANNEX.min[1]], max: [ANNEX.min[0] + T, MAIN.min[1]], y: ay })
}

/** Lobby storefront, aluminium door frame with both leaves standing open, canopy on columns, landing and step. */
function buildEntrance(ctx: WorldContext, root: THREE.Object3D, b: Batch, glass: Batch, alu: THREE.Material, clear: THREE.Material) {
  const z = MAIN.max[1]
  const gz = z - 0.12
  const top = 3.1
  const doorTop = FY + ENT.height
  const hw = ENT.width / 2
  const mullions = [-9, -6.4, -3.8, 3.8, 6.4, 9]
  for (const x of mullions) b.box(alu, x - 0.05, FY, gz - 0.07, x + 0.05, top, gz + 0.07)
  // Door frame: deeper jambs and head, a flush threshold plate (no step into the lobby).
  for (const s of [-1, 1]) b.box(alu, s * hw - 0.06, FY, gz - 0.1, s * hw + 0.06, top, gz + 0.1)
  b.box(alu, -hw, doorTop, gz - 0.1, hw, doorTop + 0.14, gz + 0.1)
  b.box("metal_galvanized", -hw, FY - 0.01, gz - 0.12, hw, FY + 0.012, gz + 0.12)
  for (const [a, c] of [[-9, -hw], [hw, 9]] as const) b.box(alu, a, FY, gz - 0.07, c, FY + 0.12, gz + 0.07)
  b.box(alu, -9, doorTop, gz - 0.08, 9, doorTop + 0.1, gz + 0.08)
  b.box(alu, -9, top - 0.08, gz - 0.07, 9, top, gz + 0.07)
  const xs = [-9, -6.4, -3.8, -hw, hw, 3.8, 6.4, 9]
  for (let i = 0; i < xs.length - 1; i++) {
    const x0 = xs[i]! + 0.06
    const x1 = xs[i + 1]! - 0.06
    if (Math.abs(x0 + x1) > 0.1) glass.box(clear, x0, FY + 0.12, gz - 0.006, x1, doorTop, gz + 0.006)
    glass.box(clear, x0, doorTop + 0.14, gz - 0.006, x1, top - 0.08, gz + 0.006)
  }
  // Working double doors (open on load so the lobby is reachable); the floor runs flush through the threshold.
  const w = hw - 0.08
  for (const sgn of [-1, 1] as const) {
    const id = sgn < 0 ? "entrance-left" : "entrance-right"
    const leaf = glassLeaf(id, -sgn * w, ENT.height - 0.02, clear, alu)
    root.add(leaf)
    ctx.doors.add({
      id,
      leaf,
      hinge: [sgn * (hw - 0.06), FY, gz],
      width: -sgn * w,
      height: ENT.height - 0.02,
      thickness: 0.05,
      openAngle: 1.45,
      swing: "auto",
      // About half open on load (a 1.3 m gap: the lobby is reachable without touching them); E swings them wide.
      startOpen: 0.49,
      double: sgn < 0 ? "entrance-right" : "entrance-left",
      sound: "glass",
    })
  }
  ctx.floors.push({ min: [-hw, z - T - 0.1], max: [hw, z + 0.1], y: FY })

  // Canopy: a thick board-formed slab on two square columns.
  const cz = z + 5
  b.box("concrete_wall", -6.6, 3.15, z, 6.6, 3.75, cz)
  b.box("concrete_dark", -6.65, 3.75, z, 6.65, 3.85, cz + 0.05)
  for (const x of [-6, 6]) {
    b.box("concrete_wall", x - 0.28, FY, cz - 0.8, x + 0.28, 3.15, cz - 0.24)
    ctx.colliders.push({ min: [x - 0.28, 0, cz - 0.8], max: [x + 0.28, 3.15, cz - 0.24] })
  }
  // Landing flush with the lobby, one shallow step with a dark nosing down to the walk.
  const stepZ = cz - 0.4
  b.box("concrete_floor", -7.2, -0.05, z, 7.2, FY, stepZ, SKIP_BOTTOM)
  b.box("concrete_floor", -7.6, -0.05, stepZ, 7.6, 0.09, stepZ + 1.0, SKIP_BOTTOM)
  b.box("concrete_dark", -7.2, FY - 0.03, stepZ - 0.06, 7.2, FY + 0.001, stepZ)
  b.box("concrete_dark", -7.6, 0.06, stepZ + 0.94, 7.6, 0.091, stepZ + 1.0)
  ctx.floors.push({ min: [-7.2, z], max: [7.2, stepZ], y: FY }, { min: [-7.6, stepZ], max: [7.6, stepZ + 1.0], y: 0.09 })
  // Recessed downlight in the canopy soffit.
  b.box("metal_dark", -0.3, 3.1, z + 2.2, 0.3, 3.15, z + 2.8)
  b.box("glass_lit", -0.24, 3.09, z + 2.26, 0.24, 3.1, z + 2.74)
  const lamp: Lamp = {
    kind: "incandescent",
    position: [0, 3.05, z + 2.5],
    direction: [0, -1, 0],
    color: [1, 0.72, 0.42],
    intensity: 160,
    range: 14,
    angle: 1.1,
    penumbra: 0.7,
    shadow: true,
    size: 0.4,
  }
  ctx.lamps.push(lamp)
}

/** Wall colliders from the facades: solid everywhere except walkable openings (doors, roll-ups, the core). */
function wallColliders(ctx: WorldContext) {
  const hw = ENT.width / 2
  for (const f of facades()) {
    const top = f.y1 + COPE
    const gaps = f.holes
      .filter((h) => h.kind === "door" || h.kind === "fireDoor" || h.kind === "rollup" || h.kind === "rollupOpen" || h.kind === "open")
      // Roll-up curtains lift into the wall above the head: no collider there either (nothing walks at that height).
      .map((h) => ({ u0: h.u0, u1: h.u1, y0: h.y0, y1: h.kind === "rollup" || h.kind === "rollupOpen" ? h.y1 + 2 : h.y1 }))
    if (f.name === "main-south") gaps.push({ u0: -hw, u1: hw, y0: FY, y1: FY + ENT.height })
    const cuts = [...new Set([f.u0, f.u1, ...gaps.flatMap((g) => [g.u0, g.u1])])].filter((u) => u >= f.u0 && u <= f.u1).sort((a, c) => a - c)
    for (let i = 0; i < cuts.length - 1; i++) {
      const a = cuts[i]!
      const c = cuts[i + 1]!
      const m = (a + c) / 2
      const here = gaps.filter((g) => g.u0 <= m && g.u1 >= m).sort((p, q) => p.y0 - q.y0)
      let y = -0.5
      const push = (y0: number, y1: number) => {
        if (y1 - y0 < 1e-3) return
        const p0 = point(f, a, y0, 0)
        const p1 = point(f, c, y1, T)
        ctx.colliders.push({ min: [Math.min(p0.x, p1.x), y0, Math.min(p0.z, p1.z)], max: [Math.max(p0.x, p1.x), y1, Math.max(p0.z, p1.z)] })
      }
      for (const g of here) {
        push(y, g.y0)
        y = Math.max(y, g.y1)
      }
      push(y, top)
    }
  }
}
