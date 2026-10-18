import * as THREE from "three/webgpu"
import { BUILDING, FIRE_ESCAPE, ROOF_Y, storeyY } from "../layout"
import type { WorldContext } from "../context"
import { Batch } from "./geo"
import { GRATING, cagedLadder, crossover } from "./access"

// The west-face fire escape: a 1970s bolted steel escape with a grated landing at every upper storey, zig-zag
// flights between them (/ \ /), pipe railings, knee brackets anchored to the wall, a counterweighted drop ladder from
// the first landing (stowed up) and a caged ladder from the top landing over the parapet onto the roof. Everything is
// walkable: landings and treads are floors, the outer railings and the flights' guard rails are colliders.

const W = FIRE_ESCAPE.x // wall face (outward is -X)
// Flights need ≥ 0.9 m clear between their guards (a 0.6 m body): 2.1 m deep = a 1.05 m inner walkway beside 1.05 m
// flights (0.93 m clear). layout.ts still says 1.5 (change requested); the escape builds at 2.1 regardless.
export const FE_DEPTH = Math.max(FIRE_ESCAPE.depth, 2.1)
const D = FE_DEPTH
const XO = W - D // outer edge
const XS = W - D / 2 // stair / walkway split: flights run in the outer half
const Z0 = FIRE_ESCAPE.z0
const Z1 = FIRE_ESCAPE.z1
const RAIL = 1.05
const STEEL = "metal_dark" as const
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)

/** Footprint of the flight leaving landing i (1-based storey) upward; alternates sides of the door. */
// The flights stop 0.85 m short of the door's centre line so the approach to each door stays clear of their rails.
const flightSpan = (i: number) => (i % 2 === 1 ? { lo: Z0 + 1.0, hi: -0.85, up: 1 } : { lo: 0.85, hi: Z1 - 1.0, up: -1 })

export const DROP_LADDER_Z = Z1 - 0.6
export const ROOF_LADDER_Z = Z1 - 0.55

export function buildFireEscape(ctx: WorldContext, b: Batch, rustStreak: (z0: number, z1: number, yTop: number, len: number) => void) {
  const top = BUILDING.main.storeys - 1
  for (let i = 1; i <= top; i++) {
    const y = storeyY(i)
    const below = i > 1 ? flightSpan(i - 1) : null
    landing(ctx, b, y, below ? [below.lo, below.hi] : null, i === 1)
    if (i < top) flight(ctx, b, i, y, storeyY(i + 1))
    rustStreak(Z0 + 0.4, Z1 - 0.4, y - 0.25, 2.4)
    // Bulkhead light over the door (head model from props.ts); only the bottom and top landings are still burning.
    if (i === 1 || i === top) {
      ctx.lamps.push({
        kind: "incandescent",
        position: [W - 0.35, y + 2.35, FIRE_ESCAPE.door.z],
        direction: [-0.45, -0.89, 0],
        color: [1, 0.7, 0.4],
        intensity: 45,
        range: 9,
        angle: 1.15,
        penumbra: 0.8,
        size: 0.15,
      })
    }
  }
  dropLadder(ctx, b, storeyY(1))
  // Roof access: caged ladder from the top landing against the wall at the south end, clear of the stair hole.
  const yTopLanding = storeyY(top)
  const coping = ROOF_Y + 1.05 + 0.14
  cagedLadder(ctx, b, { x: W, z: ROOF_LADDER_Z, nx: -1, nz: 0, y0: yTopLanding, y1: coping + 1.0, arrive: coping, cageFrom: yTopLanding + 2.3, standoff: 0.18, mat: STEEL })
  crossover(ctx, b, W, ROOF_LADDER_Z, -1, 0, ROOF_Y, coping, BUILDING.wallThickness + 0.1)
}

function landing(ctx: WorldContext, b: Batch, y: number, hole: [number, number] | null, first: boolean) {
  const th = 0.04
  // Grating: the inner walkway runs the full length; the outer half is cut where the flight from below comes up.
  const outer: [number, number][] = []
  if (hole) {
    if (hole[0] > Z0) outer.push([Z0, hole[0]])
    if (hole[1] < Z1) outer.push([hole[1], Z1])
  } else outer.push([Z0, Z1])
  const pieces: [number, number, number, number][] = [[XS, W, Z0, Z1], ...outer.map(([a, c]) => [XO, XS, a, c] as [number, number, number, number])]
  for (const [x0, x1, z0, z1] of pieces) {
    // Drop-ladder hatch in the first landing's outer half.
    if (first && x0 === XO) {
      const h0 = DROP_LADDER_Z - 0.4
      const h1 = DROP_LADDER_Z + 0.4
      if (z0 < h0) gratePiece(ctx, b, x0, x1, z0, Math.min(z1, h0), y, th)
      if (z1 > h1) gratePiece(ctx, b, x0, x1, Math.max(z0, h1), z1, y, th)
      continue
    }
    gratePiece(ctx, b, x0, x1, z0, z1, y, th)
  }
  // Frame: channel edges round the landing and over the hole.
  b.box(STEEL, XO, y - 0.16, Z0, XO + 0.06, y, Z1)
  b.box(STEEL, XO, y - 0.16, Z0, W, y, Z0 + 0.06)
  b.box(STEEL, XO, y - 0.16, Z1 - 0.06, W, y, Z1)
  b.box(STEEL, W - 0.08, y - 0.12, Z0, W, y, Z1)
  if (hole) b.box(STEEL, XS - 0.03, y - 0.12, hole[0], XS + 0.03, y, hole[1])
  // Knee brackets to the wall at both ends and the middle, with anchor plates.
  for (const z of [Z0 + 0.2, (Z0 + Z1) / 2 + 2.2, Z1 - 0.2]) {
    b.strut(STEEL, V(XO + 0.05, y - 0.08, z), V(W, y - 1.25, z), 0.07)
    b.box(STEEL, W - 0.02, y - 1.4, z - 0.12, W, y - 1.1, z + 0.12)
    b.box(STEEL, W - 0.02, y - 0.25, z - 0.12, W, y + 0.05, z + 0.12)
  }
  // Outer railing (pipe posts, top rail and mid rail), returns at both ends.
  const post = (x: number, z: number) => b.cylinder(STEEL, x, y, z, 0.022, RAIL, 8)
  for (let z = Z0 + 0.04; z <= Z1 - 0.04 + 1e-6; z += (Z1 - Z0 - 0.08) / 6) post(XO + 0.03, z)
  for (const z of [Z0 + 0.04, Z1 - 0.04]) post(XS, z)
  const rail = (a: THREE.Vector3, c: THREE.Vector3) => b.strut(STEEL, a, c, 0.04, true)
  for (const h of [RAIL, RAIL * 0.5]) {
    rail(V(XO + 0.03, y + h, Z0 + 0.04), V(XO + 0.03, y + h, Z1 - 0.04))
    rail(V(XO + 0.03, y + h, Z0 + 0.04), V(W - 0.05, y + h, Z0 + 0.04))
    rail(V(XO + 0.03, y + h, Z1 - 0.04), V(W - 0.05, y + h, Z1 - 0.04))
  }
  ctx.colliders.push({ min: [XO - 0.05, y, Z0], max: [XO + 0.08, y + RAIL, Z1] })
  ctx.colliders.push({ min: [XO, y, Z0 - 0.05], max: [W, y + RAIL, Z0 + 0.08] })
  ctx.colliders.push({ min: [XO, y, Z1 - 0.08], max: [W, y + RAIL, Z1 + 0.05] })
  // Guard rail along the inner edge of the hole and across its far end, so you can't step off into it.
  if (hole) {
    const [h0, h1] = hole
    for (const h of [RAIL, RAIL * 0.5]) rail(V(XS, y + h, h0), V(XS, y + h, h1))
    for (const z of [h0, (h0 + h1) / 2, h1]) post(XS, z)
    ctx.colliders.push({ min: [XS - 0.04, y, h0], max: [XS + 0.04, y + RAIL, h1] })
    // The end of the hole where the flight below is lowest gets a rail across the outer half.
    const lowEnd = (h0 + h1) / 2 < 0 ? h0 : h1
    for (const h of [RAIL, RAIL * 0.5]) rail(V(XO + 0.03, y + h, lowEnd), V(XS, y + h, lowEnd))
    ctx.colliders.push({ min: [XO, y, lowEnd - 0.04], max: [XS, y + RAIL, lowEnd + 0.04] })
  }
}

function gratePiece(ctx: WorldContext, b: Batch, x0: number, x1: number, z0: number, z1: number, y: number, th: number) {
  if (z1 - z0 < 0.05) return
  b.box(GRATING, x0, y - th, z0, x1, y, z1)
  ctx.floors.push({ min: [x0, z0], max: [x1, z1], y })
}

/** One flight in the outer half from landing i (at y) to landing i+1 (at yTop). */
function flight(ctx: WorldContext, b: Batch, i: number, y: number, yTop: number) {
  const s = flightSpan(i)
  const risers = Math.round((yTop - y) / 0.2)
  const rise = (yTop - y) / risers
  const treads = risers - 1
  const len = s.hi - s.lo
  const run = len / treads
  // z of the start (bottom) and travel direction.
  const zStart = s.up > 0 ? s.lo : s.hi
  const dir = s.up
  const xa = XO + 0.08
  const xb = XS - 0.04
  for (let k = 1; k <= treads; k++) {
    const ty = y + rise * k
    const za = zStart + dir * run * (k - 1)
    const zb = zStart + dir * run * k
    const [z0, z1] = za < zb ? [za, zb] : [zb, za]
    b.box(GRATING, xa, ty - 0.035, z0, xb, ty, z1 + 0.03)
    b.box(STEEL, xa, ty - 0.035, dir > 0 ? z1 - 0.02 : z0, xb, ty, dir > 0 ? z1 + 0.03 : z0 + 0.05)
    ctx.floors.push({ min: [xa, z0], max: [xb, z1], y: ty })
  }
  // Channel stringers each side, from the lower landing to the upper landing.
  const zEnd = zStart + dir * len
  for (const x of [xa - 0.02, xb + 0.02]) {
    const a = V(x, y - 0.1, zStart - dir * 0.1)
    const c = V(x, yTop - 0.1, zEnd)
    b.strut(STEEL, a, c, 0.06)
    b.strut(STEEL, a.clone().add(V(0, 0.12, 0)), c.clone().add(V(0, 0.12, 0)), 0.03)
  }
  // Handrails both sides (sloped pipe on posts), plus guard colliders stepping up along the flight.
  for (const x of [XO + 0.03, XS]) {
    const posts = 4
    for (let k = 0; k <= posts; k++) {
      const t = k / posts
      const z = zStart + dir * len * t
      const fy = y + (yTop - y) * t
      b.cylinder(STEEL, x, fy, z, 0.02, RAIL - 0.15, 8)
    }
    b.strut(STEEL, V(x, y + RAIL - 0.15, zStart), V(x, yTop + RAIL - 0.15, zEnd), 0.04, true)
    b.strut(STEEL, V(x, y + (RAIL - 0.15) / 2, zStart), V(x, yTop + (RAIL - 0.15) / 2, zEnd), 0.03, true)
  }
  const segs = 4
  for (let k = 0; k < segs; k++) {
    const za = zStart + (dir * len * k) / segs
    const zb = zStart + (dir * len * (k + 1)) / segs
    const ya = y + ((yTop - y) * k) / segs
    const yb = y + ((yTop - y) * (k + 1)) / segs
    const [z0, z1] = za < zb ? [za, zb] : [zb, za]
    ctx.colliders.push({ min: [XO - 0.05, ya + 0.2, z0], max: [XO + 0.08, yb + RAIL, z1] })
  }
}

/** Counterweighted drop ladder stowed up through the first landing's hatch: bottom rung ~1.7 m above grade. */
function dropLadder(ctx: WorldContext, b: Batch, yLanding: number) {
  const x = (XO + XS) / 2
  const z = DROP_LADDER_Z
  const bottom = 1.7
  const topY = yLanding + 1.0
  for (const dz of [-0.24, 0.24]) b.strut(STEEL, V(x, bottom, z + dz), V(x, topY, z + dz), 0.05)
  for (let y = bottom + 0.05; y < topY - 0.1; y += 0.3) b.strut(STEEL, V(x, y, z - 0.24), V(x, y, z + 0.24), 0.026, true)
  // Guide channels on the landing frame, pulley, cable and the counterweight hanging beside it.
  for (const dz of [-0.32, 0.32]) b.box(STEEL, x - 0.04, yLanding - 0.3, z + dz - 0.03, x + 0.04, yLanding + 1.25, z + dz + 0.03)
  b.cylinder(STEEL, x + 0.25, yLanding + 1.25, z + 0.38, 0.08, 0.04, 10)
  b.strut(STEEL, V(x + 0.25, yLanding + 1.25, z + 0.38), V(x + 0.25, yLanding - 0.9, z + 0.38), 0.012, true)
  b.box(STEEL, x + 0.17, yLanding - 1.5, z + 0.3, x + 0.33, yLanding - 0.9, z + 0.46)
  // Reachable from the ground by reaching up to the bottom rung: the climb volume starts at grade.
  ctx.ladders.push({ min: [XO + 0.05, 0, z - 0.4], max: [XS, yLanding + 0.12, z + 0.4] })
}
