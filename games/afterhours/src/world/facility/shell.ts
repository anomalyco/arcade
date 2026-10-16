import * as THREE from "three/webgpu"
import { BUILDING } from "../layout"
import type { Lamp, WorldContext } from "../context"
import { Batch, QuadBuilder, SKIP_BOTTOM, rng } from "./geo"
import { clearGlassMaterial, crtWindowMaterial, litWindowMaterial, stainMaterial } from "./windows"

// The facility's outer shell: board-formed concrete walls built inward from the footprint, recessed window rows on
// both floors, floor-line band, plinth, parapet coping, roof decks, the glazed lobby front with its canopy, floor
// slabs and the exterior wall colliders. Interior partitions belong to the interior builder.

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
export const MAIN_ROOF_Y = STOREYS * SH + 0.05
export const ANNEX_ROOF_Y = 4.6
/** Stair and lift core expressed on the south face: a windowless tower rising above the parapet. */
export const CORE = { x0: -43.45, x1: -35.95, z1: MAIN.max[1] + 3.2, top: MAIN.height + 3.8 }
const coreSkip: [number, number][] = [[CORE.x0 + 0.1, CORE.x1 - 0.1]]
const GLASS_D = 0.26
const MODULE = 5.4
const OPENING = 3.3
const PANES = 3

type Hole = { u0: number; u1: number; y0: number; y1: number; kind: "window" | "storefront" | "door" | "rollup" | "rollupOpen" }

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
  return [...us].filter((u) => u > f.u0 + 0.4 && u < f.u1 - 0.4 && !(f.name === "main-south" && u > CORE.x0 - 0.3 && u < CORE.x1 + 0.3)).sort((a, c) => a - c)
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
    y1: MAIN.height,
    holes: [
      ...windowRow(MAIN.min[0], MAIN.max[0], storeyRow(0), [...lobbySkip, ...coreSkip]),
      ...upperRows(MAIN.min[0], MAIN.max[0], coreSkip),
      { u0: -9, u1: 9, y0: FY, y1: 3.1, kind: "storefront" },
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
    y1: MAIN.height,
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
    y1: MAIN.height,
    holes: [
      ...windowRow(MAIN.min[1], MAIN.max[1], storeyRow(0), [[-12.5, -7]]),
      ...upperRows(MAIN.min[1], MAIN.max[1]),
      { u0: -10.5, u1: -9.5, y0: FY, y1: FY + 2.1, kind: "door" },
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
    y1: MAIN.height,
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
    y1: ANNEX.height,
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
    y1: ANNEX.height,
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
    y1: ANNEX.height,
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
    y1: ANNEX.height,
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

export function buildShell(ctx: WorldContext, root: THREE.Object3D): ShellResult {
  const b = new Batch()
  const glass = new Batch()
  const lit = new QuadBuilder(4)
  const crt = new QuadBuilder(4)
  const stain = new QuadBuilder(1)
  const rand = rng(1984)
  const result: ShellResult = { litPanes: [] }
  const alu = new THREE.MeshStandardNodeMaterial({ color: 0x34322d, metalness: 0.75, roughness: 0.42 })
  alu.name = "facility_aluminium"
  const clear = clearGlassMaterial()

  // CRT rooms: specific openings left with a terminal on (facade, storey, index).
  const crtSlots = new Set(["main-south:s2:5", "main-west:s3:1", "main-north:s4:9", "main-north:s1:3", "main-south:s4:12", "annex-south:ground:1"])
  // Ground-floor windows that are guaranteed lit, because their spill matters for the views.
  const forcedLit = new Set(["main-south:ground:3", "main-south:ground:10", "main-north:ground:12", "annex-south:ground:3", "main-east:ground:0"])
  // 3 a.m.: one office corner on the fourth floor (south-east) still fully lit, someone working late.
  const lateFloor = (f: Facade, k: number, h: Hole) =>
    k === 3 && ((f.name === "main-south" && h.u0 > 17) || (f.name === "main-east" && h.u0 > 9))

  for (const f of facades()) {
    wallBoxes(b, f, "concrete_wall")
    const t = tangent(f)
    const n = normal(f)
    const counters = new Map<string, number>()
    for (const h of f.holes) {
      if (h.kind !== "window") continue
      const storey = f.name.startsWith("main") ? Math.floor(h.y0 / SH) : 0
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
      const pLit = storey === 0 ? 0.12 : 0.05
      const roomLit = forcedLit.has(id) || lateFloor(f, storey, h) || (!isCrt && roll < pLit)
      const oneLit = !roomLit && !isCrt && roll < pLit + 0.05
      const tintRoll = rand()
      const tint = tintRoll < 0.45 ? WARM : tintRoll < 0.8 ? PALE : COOL
      const litPane = Math.floor(rand() * PANES)
      const crtPane = Math.floor(rand() * PANES)
      const y0 = h.y0 + 0.02 + fr
      const y1 = h.y1 - fr
      for (let p = 0; p < PANES; p++) {
        const a = h.u0 + fr + paneW * p + (p ? 0.035 : 0)
        const c = h.u0 + fr + paneW * (p + 1) - (p < PANES - 1 ? 0.035 : 0)
        const o = point(f, f.out > 0 === (f.axis === "x") ? a : c, y0, GLASS_D)
        const uVec = t.clone().multiplyScalar((c - a) * (f.out > 0 === (f.axis === "x") ? 1 : -1))
        const vVec = new THREE.Vector3(0, y1 - y0, 0)
        if (isCrt && p === crtPane) {
          crt.quad(o, uVec, vVec, n, [1, 1], [0.25 + rand() * 0.5, 0.25 + rand() * 0.2, rand(), rand()])
        } else if (roomLit || (oneLit && p === litPane)) {
          const k = 0.75 + rand() * 0.45
          const col: [number, number, number] = [tint[0] * k, tint[1] * k, tint[2] * k]
          lit.quad(o, uVec, vVec, n, [1, 1], [...col, rand()])
          if (p === 1 || oneLit) {
            result.litPanes.push({ center: point(f, (a + c) / 2, (y0 + y1) / 2, GLASS_D), normal: n.clone(), color: col, facade: id, row })
          }
        } else {
          fbox(glass, "glass_dark", f, a, c, y0, y1, GLASS_D - 0.01, GLASS_D + 0.01)
        }
      }
      // Streaks of grime running down from each sill.
      const below = storey > 0 ? h.y0 - 0.1 - band(storey).y1 : h.y0 - 0.1 - PLINTH.y1
      const len = Math.min(1.7, below)
      if (len > 0.2) addStain(stain, f, h.u0, h.u1, h.y0 - 0.1, len, 0.55 + rand() * 0.35)
    }

    // Plinth, coping and splash-back grime along the whole facade.
    const top = f.y1
    const isMain = f.name.startsWith("main")
    const cp = COPING.proj + (isMain ? CROWN.proj : 0)
    const ext0 = f.axis === "z" ? T : 0
    fbox(b, "concrete_dark", f, f.u0 - ext0 - (f.axis === "x" ? PLINTH.proj : 0), f.u1 + ext0 + (f.axis === "x" ? PLINTH.proj : 0), -0.05, PLINTH.y1, -PLINTH.proj, 0, SKIP_BOTTOM)
    fbox(b, "concrete_dark", f, f.u0 - ext0 - (f.axis === "x" ? cp : 0), f.u1 + ext0 + (f.axis === "x" ? cp : 0), top - (f.axis === "z" ? 0.002 : 0), top + COPING.h - (f.axis === "z" ? 0.002 : 0), -cp, T + 0.05)
    addStain(stain, f, f.u0, f.u1, isMain ? CROWN.y0 : top, 1.4, 0.5)
    // Vertical fins between the upper window bays: the block's brutalist rhythm.
    if (isMain) {
      for (const u of finPositions(f)) {
        const y0 = f.name === "main-east" && u < ANNEX.max[1] + 0.5 ? ANNEX.height : SH - 0.35
        fbox(b, "concrete_wall", f, u - FIN.w / 2, u + FIN.w / 2, y0, CROWN.y0, -FIN.proj, 0)
        addStain(stain, f, u - FIN.w / 2 - 0.1, u + FIN.w / 2 + 0.1, CROWN.y0, 2.2, 0.35)
      }
    }
    addSplash(stain, f, f.u0, f.u1, PLINTH.y1, 0.7, 0.35)
  }

  // Floor-line bands at every slab and the heavy crown fascia (the annex covers the east band at the first floor).
  for (let k = 1; k < STOREYS; k++) {
    const bd = band(k)
    ring(b, "concrete_wall", MAIN.min, MAIN.max, bd.y0, bd.y1, bd.proj, bd.y0 < ANNEX.height ? ANNEX.max[1] : undefined)
  }
  ring(b, "concrete_wall", MAIN.min, MAIN.max, CROWN.y0, MAIN.height, CROWN.proj)
  buildCore(ctx, b, lit, stain)

  // Roof decks (gravel ballast) inside the parapets.
  b.box("gravel", MAIN.min[0] + T, MAIN_ROOF_Y - 0.3, MAIN.min[1] + T, MAIN.max[0] - T, MAIN_ROOF_Y, MAIN.max[1] - T, SKIP_BOTTOM)
  b.box("gravel", ANNEX.min[0], ANNEX_ROOF_Y - 0.3, ANNEX.min[1] + T, ANNEX.max[0] - T, ANNEX_ROOF_Y, ANNEX.max[1] - T, SKIP_BOTTOM)

  // Ground-floor slabs: the player walks on these inside.
  b.box("concrete_floor", MAIN.min[0], -0.3, MAIN.min[1], MAIN.max[0], FY, MAIN.max[1], SKIP_BOTTOM)
  b.box("concrete_floor", ANNEX.min[0], -0.3, ANNEX.min[1], ANNEX.max[0], FY, ANNEX.max[1], SKIP_BOTTOM)
  ctx.floors.push({ min: MAIN.min, max: MAIN.max, y: FY }, { min: ANNEX.min, max: ANNEX.max, y: FY })

  buildEntrance(ctx, b, glass, alu, clear)

  b.flush(root, { name: "shell" })
  glass.flush(root, { name: "shell-glass", castShadow: false })

  const litMesh = new THREE.Mesh(lit.geometry("paneA"), litWindowMaterial())
  const crtMesh = new THREE.Mesh(crt.geometry("paneA"), crtWindowMaterial())
  const stainMesh = new THREE.Mesh(stain.geometry("stain"), stainMaterial())
  stainMesh.renderOrder = 1
  for (const m of [litMesh, crtMesh, stainMesh]) {
    m.matrixAutoUpdate = false
    root.add(m)
  }

  wallColliders(ctx)
  return result
}

function addStain(q: QuadBuilder, f: Facade, u0: number, u1: number, yTop: number, len: number, strength: number) {
  if (len <= 0 || strength <= 0) return
  const n = normal(f)
  const t = tangent(f)
  const flip = f.out > 0 === (f.axis === "x")
  const o = point(f, flip ? u0 : u1, yTop - len, -0.008)
  const uVec = t.clone().multiplyScalar((u1 - u0) * (flip ? 1 : -1))
  q.quad(o, uVec, new THREE.Vector3(0, len, 0), n, [flip ? u1 : -u1, 0], [strength], [flip ? u0 : -u0, 1])
}

function addSplash(q: QuadBuilder, f: Facade, u0: number, u1: number, yBottom: number, len: number, strength: number) {
  const n = normal(f)
  const t = tangent(f)
  const flip = f.out > 0 === (f.axis === "x")
  const o = point(f, flip ? u0 : u1, yBottom, -0.008)
  const uVec = t.clone().multiplyScalar((u1 - u0) * (flip ? 1 : -1))
  q.quad(o, uVec, new THREE.Vector3(0, len, 0), n, [flip ? u1 : -u1, 1], [strength], [flip ? u0 : -u0, 0])
}

/** A projecting band all round a rectangle footprint. */
function ring(b: Batch, mat: "concrete_wall" | "concrete_dark", min: readonly [number, number], max: readonly [number, number], y0: number, y1: number, proj: number, eastFromZ?: number) {
  b.box(mat, min[0] - proj, y0, max[1] - 0.05, max[0] + proj, y1, max[1] + proj)
  b.box(mat, min[0] - proj, y0, min[1] - proj, eastFromZ === undefined ? max[0] + proj : max[0], y1, min[1] + 0.05)
  b.box(mat, min[0] - proj, y0, min[1] + 0.05, min[0] + 0.05, y1, max[1] - 0.05)
  b.box(mat, max[0] - 0.05, y0, eastFromZ ?? min[1] + 0.05, max[0] + proj, y1, max[1] - 0.05)
}

/** The stair/lift core on the south face: blank board-formed tower, a recessed glazed slot lit at every landing. */
function buildCore(ctx: WorldContext, b: Batch, lit: QuadBuilder, stain: QuadBuilder) {
  const { x0, x1, z1, top } = CORE
  const z0 = MAIN.max[1]
  const xc = (x0 + x1) / 2
  const sw = 0.55
  const recess = 0.3
  b.box("concrete_wall", x0, -0.05, z0, xc - sw, top, z1, SKIP_BOTTOM)
  b.box("concrete_wall", xc + sw, -0.05, z0, x1, top, z1, SKIP_BOTTOM)
  b.box("concrete_wall", xc - sw, -0.05, z0, xc + sw, top, z1 - recess, SKIP_BOTTOM)
  b.box("concrete_dark", x0 - 0.08, top, z0 - 0.5, x1 + 0.08, top + 0.16, z1 + 0.08)
  b.box("concrete_dark", x0 - 0.06, -0.05, z1, x1 + 0.06, PLINTH.y1, z1 + PLINTH.proj, SKIP_BOTTOM)
  // Lift motor-room louvres near the top of the east side.
  for (let k = 0; k < 7; k++) b.box("metal_dark", x1, top - 2.6 + k * 0.28, z0 + 0.8, x1 + 0.04, top - 2.48 + k * 0.28, z1 - 0.8)
  const n = new THREE.Vector3(0, 0, 1)
  const gz = z1 - recess + 0.02
  for (let k = 0; k <= STOREYS; k++) {
    const yLanding = k * SH + SH * 0.5
    const yA = Math.max(0.9, yLanding - 0.9)
    const yB = Math.min(top - 1.2, yLanding + 0.9)
    if (yB <= yA) continue
    // Stairwells stay lit all night: pale fluorescent behind reeded glass, one landing out.
    if (k === 2) b.box("glass_dark", xc - sw, yA, gz - 0.01, xc + sw, yB, gz)
    else lit.quad(new THREE.Vector3(xc - sw, yA, gz), new THREE.Vector3(sw * 2, 0, 0), new THREE.Vector3(0, yB - yA, 0), n, [1, 1], [0.7, 0.85, 0.78, 0.13 + k * 0.17])
    b.box("metal_dark", xc - sw, yB, gz - 0.02, xc + sw, yB + 0.08, gz + 0.02)
    b.box("metal_dark", xc - sw, yA - 0.08, gz - 0.02, xc + sw, yA, gz + 0.02)
  }
  addStain(stain, { name: "core", axis: "x", fixed: z1, out: 1, u0: x0, u1: x1, y0: 0, y1: top, holes: [] }, x0, x1, top, 3.5, 0.6)
  ctx.colliders.push({ min: [x0, -0.5, z0], max: [x1, top, z1] })
}

/** Lobby storefront, glass doors, canopy on columns, landing and the entrance light. */
function buildEntrance(ctx: WorldContext, b: Batch, glass: Batch, alu: THREE.Material, clear: THREE.Material) {
  const z = MAIN.max[1]
  const gz = z - 0.12
  const top = 3.1
  const doorTop = FY + ENT.height
  const hw = ENT.width / 2
  const mullions = [-9, -6.4, -3.8, -hw, hw, 3.8, 6.4, 9]
  for (const x of mullions) b.box(alu, x - 0.05, FY, gz - 0.07, x + 0.05, top, gz + 0.07)
  b.box(alu, -9, FY, gz - 0.07, 9, FY + 0.12, gz + 0.07)
  b.box(alu, -9, doorTop, gz - 0.08, 9, doorTop + 0.1, gz + 0.08)
  b.box(alu, -9, top - 0.08, gz - 0.07, 9, top, gz + 0.07)
  for (let i = 0; i < mullions.length - 1; i++) {
    const x0 = mullions[i]! + 0.05
    const x1 = mullions[i + 1]! - 0.05
    if (Math.abs(x0 + x1) > 0.1) glass.box(clear, x0, FY + 0.12, gz - 0.006, x1, doorTop, gz + 0.006)
    glass.box(clear, x0, doorTop + 0.1, gz - 0.006, x1, top - 0.08, gz + 0.006)
  }
  // Door leaves: the left one shut, the right one propped open (the way someone left it).
  const leaf = (m: THREE.Matrix4) => {
    const w = hw - 0.06
    const parts: [number, number, number, number][] = [
      [0, 0, w, 0.1],
      [0, ENT.height - 0.12, w, ENT.height - 0.02],
      [0, 0, 0.08, ENT.height - 0.02],
      [w - 0.08, 0, w, ENT.height - 0.02],
      [0.08, 0.95, w - 0.08, 1.05],
    ]
    for (const [x0, y0, x1, y1] of parts) {
      const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, 0.05)
      g.translate((x0 + x1) / 2, (y0 + y1) / 2, 0)
      b.add(alu, g, m)
    }
    const pane = new THREE.BoxGeometry(w - 0.16, ENT.height - 0.24, 0.012)
    pane.translate(w / 2, ENT.height / 2, 0)
    glass.add(clear, pane, m)
  }
  leaf(new THREE.Matrix4().makeTranslation(-hw + 0.03, FY, gz))
  const open = new THREE.Matrix4().makeTranslation(hw - 0.03, FY, gz).multiply(new THREE.Matrix4().makeRotationY(-(Math.PI - 1.75)))
  leaf(open)
  ctx.colliders.push({ min: [hw - 0.15, 0, gz], max: [hw + 0.35, 3, gz + hw] })

  // Canopy: a thick board-formed slab on two square columns, landing slab underneath.
  const cz = z + 5
  b.box("concrete_wall", -6.6, 3.15, z, 6.6, 3.75, cz)
  b.box("concrete_dark", -6.65, 3.75, z, 6.65, 3.85, cz + 0.05)
  for (const x of [-6, 6]) {
    b.box("concrete_wall", x - 0.28, FY, cz - 0.8, x + 0.28, 3.15, cz - 0.24)
    ctx.colliders.push({ min: [x - 0.28, 0, cz - 0.8], max: [x + 0.28, 3.15, cz - 0.24] })
  }
  b.box("concrete_floor", -7.2, -0.05, z, 7.2, FY, cz + 0.6, SKIP_BOTTOM)
  ctx.floors.push({ min: [-7.2, z], max: [7.2, cz + 0.6], y: FY })
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

function wallColliders(ctx: WorldContext) {
  const H = MAIN.height + 0.2
  const hw = ENT.width / 2
  const z = MAIN.max[1]
  const add = (x0: number, z0: number, x1: number, z1: number, h = H) => ctx.colliders.push({ min: [x0, -0.5, z0], max: [x1, h, z1] })
  // South face with the doorway (the left leaf is shut, so the gap is the right half).
  add(MAIN.min[0], z - T, 0, z)
  add(hw - 0.05, z - T, MAIN.max[0], z)
  add(MAIN.min[0], MAIN.min[1], MAIN.max[0], MAIN.min[1] + T)
  add(MAIN.min[0], MAIN.min[1], MAIN.min[0] + T, MAIN.max[1])
  add(MAIN.max[0] - T, MAIN.min[1], MAIN.max[0], MAIN.max[1])
  const AH = ANNEX.height + 0.2
  add(ANNEX.min[0], ANNEX.max[1] - T, ANNEX.max[0], ANNEX.max[1], AH)
  add(ANNEX.min[0], ANNEX.min[1], ANNEX.max[0], ANNEX.min[1] + T, AH)
  add(ANNEX.max[0] - T, ANNEX.min[1], ANNEX.max[0], ANNEX.max[1], AH)
  add(ANNEX.min[0], ANNEX.min[1], ANNEX.min[0] + T, MAIN.min[1], AH)
}
