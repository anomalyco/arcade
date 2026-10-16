/**
 * Seeded room furnishing. Pure and deterministic (seeded `Rng`, no DOM), so a game may run it in `shared/` when the
 * result must collide; as client-only dressing it never touches pathing.
 *
 * Two passes: `furnishRoom` lines a room's walls and corners with thin pieces and floor clutter, keeping doorways,
 * tall-piece window spans and every occupied footprint clear; `dressSurfaces` scatters tabletop clutter on the tops
 * of anchors (sideboards, counters, tables, nightstands).
 */
import { Rng } from "../sim/rng"
import { PROP_SPECS, type PropRoom, type PropSpec } from "./catalogue"
import type { PropInstance } from "./models"

export type Rect = readonly [number, number, number, number]
export type WallSide = "n" | "s" | "w" | "e"

export type RoomSpec = {
  /** Interior floor rectangle [x0, z0, x1, z1] in metres (inside the walls). */
  rect: Rect
  room: PropRoom
  /** Door openings: nothing is placed within `doorClearance` of one. */
  doors: readonly Rect[]
  /** Window openings: pieces taller than `sillHeight` keep off their span. */
  windows: readonly Rect[]
  /** Sides that are real walls (open sides of an open-plan zone get nothing). Default: all four. */
  walls?: Partial<Record<WallSide, boolean>>
  /** Footprints already taken (gameplay colliders, anchors, walk lanes to keep). */
  occupied: readonly Rect[]
}

export type FurnishOptions = {
  seed: number
  /** Scales how many pieces go in: 0 none, 1 the default dressing, 2 crowded. */
  density: number
  /** Deepest wall piece allowed (m). Client-only dressing has no collider, so it must hug the wall. */
  maxWallDepth?: number
  doorClearance?: number
  sillHeight?: number
  specs?: readonly PropSpec[]
  /** Ids to leave out (for example one per house: the clock). */
  exclude?: ReadonlySet<string>
}

export type PlacedProp = PropInstance & { footprint: Rect; spec: PropSpec }

/** A usable top in world space: centre, yaw (as the anchor's), width along its local x, depth along local z, height. */
export type Surface = { x: number; z: number; yaw: number; w: number; d: number; h: number; room: PropRoom }

const overlaps = (a: Rect, b: Rect, pad = 0) => a[0] < b[2] + pad && a[2] > b[0] - pad && a[1] < b[3] + pad && a[3] > b[1] - pad
const rectDist = (a: Rect, b: Rect) => Math.hypot(Math.max(0, b[0] - a[2], a[0] - b[2]), Math.max(0, b[1] - a[3], a[1] - b[3]))
const inside = (a: Rect, r: Rect) => a[0] >= r[0] - 1e-6 && a[1] >= r[1] - 1e-6 && a[2] <= r[2] + 1e-6 && a[3] <= r[3] + 1e-6

const fits = (spec: PropSpec, room: PropRoom) => spec.rooms.includes(room) || spec.rooms.includes("any")

/** Axis-aligned footprint of a prop of size (w, d) at (x, z) turned by `yaw`. */
export function footprintOf(x: number, z: number, w: number, d: number, yaw: number): Rect {
  const c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw))
  const hx = (w * c + d * s) / 2, hz = (w * s + d * c) / 2
  return [x - hx, z - hz, x + hx, z + hz]
}

/** Yaw that puts a wall piece's back against `side` (the instance shader turns +Z by yaw: 0 faces +Z). */
const WALL_YAW: Record<WallSide, number> = { n: 0, s: Math.PI, w: -Math.PI / 2, e: Math.PI / 2 }

export function furnishRoom(room: RoomSpec, opts: FurnishOptions): PlacedProp[] {
  const rng = new Rng(opts.seed)
  const specs = (opts.specs ?? PROP_SPECS).filter(s => fits(s, room.room) && !opts.exclude?.has(s.id))
  const maxDepth = opts.maxWallDepth ?? 0.42
  const doorClear = opts.doorClearance ?? 0.95
  const sill = opts.sillHeight ?? 1.0
  const [x0, z0, x1, z1] = room.rect
  const walls = { n: true, s: true, w: true, e: true, ...room.walls }
  const placed: PlacedProp[] = []
  const used = new Set<string>()
  const taken = (f: Rect) => room.occupied.some(o => overlaps(f, o, 0.06)) || placed.some(p => overlaps(f, p.footprint, 0.04))
  const nearDoor = (f: Rect) => room.doors.some(d => rectDist(f, d) < doorClear)
  const nearWindow = (f: Rect) => room.windows.some(w => rectDist(f, w) < 0.25)
  const tryPlace = (spec: PropSpec, x: number, z: number, yaw: number, scale: number): boolean => {
    const f = footprintOf(x, z, spec.size[0] * scale, spec.size[2] * scale, yaw)
    if (!inside(f, room.rect) || taken(f) || nearDoor(f)) return false
    if (spec.size[1] * scale > sill && nearWindow(f)) return false
    placed.push({ id: spec.id, x, y: 0, z, yaw, scale, footprint: f, spec })
    used.add(spec.id)
    return true
  }

  // Wall pieces: thin anchors and wall clutter, one per ~3 m of wall at density 1. Big pieces appear once per room.
  const wallSpecs = specs.filter(s => s.placement === "wall" && s.size[2] <= maxDepth)
  const sides = (["n", "s", "w", "e"] as const).filter(s => walls[s])
  for (const side of sides) {
    const along = side === "n" || side === "s" ? x1 - x0 : z1 - z0
    const want = Math.round((along / 3) * opts.density * rng.range(0.6, 1.2))
    for (let n = 0, tries = 0; n < want && tries < want * 8 && wallSpecs.length; tries++) {
      const pool = wallSpecs.filter(s => !(s.role === "anchor" && used.has(s.id)))
      if (!pool.length) break
      const spec = rng.pick(pool)
      const scale = rng.range(0.95, 1.05)
      const half = (spec.size[0] * scale) / 2, depth = (spec.size[2] * scale) / 2
      const t = rng.range(half, Math.max(half, along - half))
      const yaw = WALL_YAW[side]
      const [x, z] = side === "n" ? [x0 + t, z0 + depth] : side === "s" ? [x0 + t, z1 - depth] : side === "w" ? [x0 + depth, z0 + t] : [x1 - depth, z0 + t]
      if (tryPlace(spec, x, z, yaw, scale)) n++
    }
  }

  // Corners: plants, crates and boxes, turned a little off the grid so they do not read as stamped.
  const cornerSpecs = specs.filter(s => s.placement === "corner" || (s.placement === "floor" && s.role === "clutter"))
  const corners: [number, number, WallSide, WallSide][] = [[x0, z0, "n", "w"], [x1, z0, "n", "e"], [x0, z1, "s", "w"], [x1, z1, "s", "e"]]
  for (const [cx, cz, a, b] of corners) {
    if (!walls[a] || !walls[b] || !cornerSpecs.length || rng.next() > 0.45 * opts.density) continue
    const spec = rng.pick(cornerSpecs)
    const scale = rng.range(0.9, 1.08)
    const yaw = WALL_YAW[a] + rng.range(-0.25, 0.25)
    const r = (Math.max(spec.size[0], spec.size[2]) * scale) / 2 * 1.08
    tryPlace(spec, cx + (cx === x0 ? r : -r), cz + (cz === z0 ? r : -r), yaw, scale)
  }
  return placed
}

/** Tabletop clutter: up to three pieces per surface, kept inside the top and apart, lamps at most one per top. */
export function dressSurfaces(surfaces: readonly Surface[], opts: Pick<FurnishOptions, "seed" | "density" | "specs" | "exclude">): PlacedProp[] {
  const rng = new Rng(opts.seed)
  const all = (opts.specs ?? PROP_SPECS).filter(s => s.placement === "tabletop" && !opts.exclude?.has(s.id))
  const out: PlacedProp[] = []
  for (const s of surfaces) {
    const pool = all.filter(p => fits(p, s.room))
    if (!pool.length) continue
    const want = Math.min(3, Math.floor(s.w * s.d * 4 * opts.density * rng.range(0.6, 1.3) + rng.next()))
    const local: Rect[] = []
    let lamp = false
    const c = Math.cos(s.yaw), sn = Math.sin(s.yaw)
    for (let n = 0, tries = 0; n < want && tries < want * 10; tries++) {
      const spec = rng.pick(pool)
      if (spec.id === "table-lamp" && lamp) continue
      const scale = rng.range(0.92, 1.06)
      const turn = rng.range(-0.5, 0.5)
      const f = footprintOf(0, 0, spec.size[0] * scale, spec.size[2] * scale, turn)
      const hw = (f[2] - f[0]) / 2, hd = (f[3] - f[1]) / 2
      if (hw * 2 > s.w - 0.06 || hd * 2 > s.d - 0.06) continue
      const lx = rng.range(-s.w / 2 + hw + 0.03, s.w / 2 - hw - 0.03)
      const lz = rng.range(-s.d / 2 + hd + 0.03, s.d / 2 - hd - 0.03)
      const lf: Rect = [lx - hw, lz - hd, lx + hw, lz + hd]
      if (local.some(o => overlaps(lf, o, 0.03))) continue
      local.push(lf)
      if (spec.id === "table-lamp") lamp = true
      // Local (lx, lz) through the surface's yaw, the same rotation the instance shader applies.
      const x = s.x + lx * c - lz * sn, z = s.z + lx * sn + lz * c
      out.push({ id: spec.id, x, y: s.h, z, yaw: s.yaw + turn, scale, footprint: footprintOf(x, z, spec.size[0] * scale, spec.size[2] * scale, s.yaw + turn), spec })
      n++
    }
  }
  return out
}

/** Triangles a set of placements costs at a LOD, from the catalogue budgets (what the pipeline decimates to). */
export const placementTriangles = (props: readonly { spec: PropSpec }[], lod = 0): number => props.reduce((n, p) => n + p.spec.lod[Math.min(lod, 1)]!, 0)
