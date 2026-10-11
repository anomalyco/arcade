import { CELL, GADGETS, ROAD_HALF, ROADBLOCK_THICK, SPIKE_THICK, type GadgetId, type Role } from "../config"
import type { Box } from "./city"
import { type Body, forward } from "./vehicle"

export type PropKind = GadgetId

/**
 * A deployed gadget. `h` is the heading of the road it sits on (strips and barriers span across it), `r` is the radius
 * (oil, smoke) or half-length across the road (spike, roadblock). `life` is seconds remaining, `ttl` the total lifetime.
 */
export type PropView = { id: number; kind: PropKind; x: number; z: number; h: number; r: number; life: number; ttl: number }

export type Prop = PropView & {
  /** Car id of the deployer. */
  owner: number
  team: Role
  /** Robber props are hidden from cops until a cop has been within sight range of them (or they were dropped in sight). */
  revealed: boolean
  /** Car ids already affected, so each car spins out once per oil slick. */
  hits: number[]
}

export type GadgetState = { id: GadgetId; charges: number; cooldown: number }
export type GadgetView = { id: GadgetId; charges: number; cooldown: number; ready: boolean }

export function newGadgets(ids: readonly GadgetId[]): GadgetState[] {
  return ids.map((id) => ({ id, charges: GADGETS[id].charges, cooldown: 0 }))
}

/** Nearest multiple of 90 degrees: city roads are axis aligned. */
export function snapAxis(h: number) {
  return Math.round(h / (Math.PI / 2)) * (Math.PI / 2)
}

/** Where a gadget lands relative to the car that drops it: oil and smoke behind, strips and barriers ahead, centered on the road. */
export function placeProp(kind: PropKind, b: Body, carLength: number): { x: number; z: number; h: number } {
  const [fx, fz] = forward(b.h)
  if (kind === "oil" || kind === "smoke") {
    const back = kind === "oil" ? carLength / 2 + GADGETS.oil.radius + 0.5 : 3
    return { x: b.x - fx * back, z: b.z - fz * back, h: b.h }
  }
  // Spike strips drop just behind the cop (lay it in the driver's path when you're ahead); roadblocks go ahead.
  const ahead = kind === "spike" ? -(carLength / 2 + 2.5) : 8
  const h = snapAxis(b.h)
  let x = b.x + fx * ahead
  let z = b.z + fz * ahead
  const alongZ = Math.abs(Math.cos(h)) > 0.5
  if (alongZ) {
    const line = Math.round(x / CELL) * CELL
    if (Math.abs(x - line) < ROAD_HALF + 1) x = line
  } else {
    const line = Math.round(z / CELL) * CELL
    if (Math.abs(z - line) < ROAD_HALF + 1) z = line
  }
  return { x, z, h }
}

/** The collision box of a roadblock (null for other props). Clients can add these to their own collideBoxes call for prediction. */
export function propBox(p: Pick<PropView, "kind" | "x" | "z" | "h" | "r">): Box | null {
  if (p.kind !== "roadblock") return null
  const alongZ = Math.abs(Math.cos(p.h)) > 0.5
  const ax = alongZ ? p.r : ROADBLOCK_THICK / 2
  const az = alongZ ? ROADBLOCK_THICK / 2 : p.r
  return { x0: p.x - ax, x1: p.x + ax, z0: p.z - az, z1: p.z + az, h: 1.3, color: [0.95, 0.55, 0.12], neon: null, kind: "special", label: "roadblock" }
}

export type Pose = { x: number; z: number; h: number }

/** Where the tires sit as fractions of the car's length (front and rear axles) and width. */
export const WHEEL_ALONG = 0.32
export const WHEEL_SIDE = 0.4

/** World positions of a car's tires in Body.wheels order: front left, front right, rear left, rear right. */
export function wheelPoints(p: Pose, length: number, width: number): [number, number][] {
  const [fx, fz] = forward(p.h)
  const a = length * WHEEL_ALONG
  const s = width * WHEEL_SIDE
  // Right is (fz, -fx).
  return [
    [p.x + fx * a - fz * s, p.z + fz * a + fx * s],
    [p.x + fx * a + fz * s, p.z + fz * a - fx * s],
    [p.x - fx * a - fz * s, p.z - fz * a + fx * s],
    [p.x - fx * a + fz * s, p.z - fz * a - fx * s],
  ]
}

/**
 * Tires that go over a spike strip on a move from `from` to `to`, in the order they cross it (indices into
 * Body.wheels). Only tires whose track passes over the strip's length count. Empty unless at least one of them reaches
 * the strip during this move, so the caller learns about a crossing the moment the first tire touches.
 */
export function stripWheels(p: PropView, from: Pose, to: Pose, length: number, width: number): number[] {
  const [fx, fz] = forward(p.h)
  const along = ([x, z]: [number, number]) => (x - p.x) * fx + (z - p.z) * fz
  const across = ([x, z]: [number, number]) => Math.abs((x - p.x) * fz - (z - p.z) * fx)
  const half = SPIKE_THICK / 2
  const w0 = wheelPoints(from, length, width)
  const w1 = wheelPoints(to, length, width)
  // Which way the car is moving across the strip: the tire furthest along that way crosses first.
  const c0 = (from.x - p.x) * fx + (from.z - p.z) * fz
  const c1 = (to.x - p.x) * fx + (to.z - p.z) * fz
  const way = c1 !== c0 ? Math.sign(c1 - c0) : -Math.sign(c1) || 1
  let touched = false
  const over: { i: number; key: number }[] = []
  for (let i = 0; i < 4; i++) {
    const a0 = along(w0[i]!)
    const a1 = along(w1[i]!)
    if (Math.min(across(w0[i]!), across(w1[i]!)) > p.r) continue
    if (Math.min(a0, a1) <= half && Math.max(a0, a1) >= -half) touched = true
    over.push({ i, key: -a1 * way })
  }
  if (!touched) return []
  // Ties (both tires of an axle square to the strip) go left before right, so the order is always the same.
  over.sort((a, b) => (Math.abs(a.key - b.key) > 0.05 ? a.key - b.key : a.i - b.i))
  return over.map((o) => o.i)
}

/** Segment from (ax, az) to (bx, bz) against an axis-aligned box (slab test). */
export function segmentHitsBox(ax: number, az: number, bx: number, bz: number, box: Box) {
  if (Math.max(ax, bx) < box.x0 || Math.min(ax, bx) > box.x1 || Math.max(az, bz) < box.z0 || Math.min(az, bz) > box.z1) return false
  let t0 = 0
  let t1 = 1
  const dx = bx - ax
  const dz = bz - az
  for (const [o, d, lo, hi] of [
    [ax, dx, box.x0, box.x1],
    [az, dz, box.z0, box.z1],
  ] as const) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return false
      continue
    }
    let ta = (lo - o) / d
    let tb = (hi - o) / d
    if (ta > tb) [ta, tb] = [tb, ta]
    t0 = Math.max(t0, ta)
    t1 = Math.min(t1, tb)
    if (t0 > t1) return false
  }
  return true
}

/** Segment against a circle. */
export function segmentHitsCircle(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, r: number) {
  const dx = bx - ax
  const dz = bz - az
  const len2 = dx * dx + dz * dz
  const t = len2 > 1e-9 ? Math.max(0, Math.min(1, ((cx - ax) * dx + (cz - az) * dz) / len2)) : 0
  return Math.hypot(ax + dx * t - cx, az + dz * t - cz) < r
}
