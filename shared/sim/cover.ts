import { DT, PLAYER_RADIUS, SPEED, SPRINT_SPEED } from "../config"
import { type Rect, gridOf, inRect, pushOut, raycast, rayRect } from "../geom"
import type { MapDef } from "../maps"
import { obstaclesOf, overlaps } from "./gear"
import { type Body, stepBody } from "./move"
import type { Intent } from "./world"

/** Cover tuning. Distances in metres, times in ticks unless noted. */
export const COVER = {
  /** How far ahead a surface can be taken, from the body centre. */
  reach: 2.5,
  /** Space in cover toward another surface this close hops to it. */
  hop: 5,
  /** Clearance between the body and the surface. */
  gap: 0.03,
  /** Ticks to slide into cover (0.2 s); hops take longer when they're long. */
  enter: 6,
  hopSpeed: 9,
  /** Sliding along cover, m/s. */
  speed: 2.4,
  /** Rest this far short of an edge you can peek around. */
  inset: 0.1,
  /** Leaning out at a corner moves the body this far past its rest spot, at this speed. */
  peek: 0.55,
  peekSpeed: 5.5,
  /** Within this of the end of the surface counts as at the corner. */
  corner: 0.35,
  /** Ticks you stay popped out after letting go of the trigger or right click. */
  out: 10,
  /** Seconds from popping out to the first shot. */
  pop: 0.12,
  /** Ticks holding away from the surface to leave it. */
  away: 8,
  /** Anything lower than this is low cover: you crouch behind it and pop up over it. */
  low: 1.5,
  /** Low cover protects a crouched body from shots that cross it this close. */
  guard: 1.2,
  /** Popped up, low walls this close don't stop your own shots. */
  skip: 1.0,
} as const

/**
 * Being in cover: the body slides along a line parallel to a surface. (ox, oy) is a point on that line, (nx, ny) the
 * surface's outward normal and the tangent is (-ny, nx). The body rests within [lo, hi] along the tangent and leans
 * out as far as loPeek or hiPeek at a corner (equal to lo or hi where there's no corner to peek around).
 */
export type Cover = {
  ox: number
  oy: number
  nx: number
  ny: number
  lo: number
  hi: number
  loPeek: number
  hiPeek: number
  low: boolean
  /** Ticks left of the slide in, toward (tx, ty). */
  enter: number
  tx: number
  ty: number
  /** Ticks left popped out (up over low cover, or leaning around a corner). */
  out: number
  /** Which corner you're leaning around: -1 the lo end, 1 the hi end, 0 none. */
  peek: number
  /** Ticks you've been holding away from the surface. */
  away: number
}

/** What other clients need to animate someone in cover. */
export type CoverView = { nx: number; ny: number; low: boolean; out: boolean; peek: number; enter: boolean }

/** The predicted or simulated body, with its cover. */
export type CoverBody = Body & { cover: Cover | null }

/** Cover or its view: enough to tell whether low cover protects someone. */
type CoverLike = { low: boolean; out: number | boolean; enter: number | boolean }

export const coverView = (c: Cover | null): CoverView | null => (c ? { nx: c.nx, ny: c.ny, low: c.low, out: c.out > 0, peek: c.peek, enter: c.enter > 0 } : null)

/** Map geometry for cover and shots: everything solid with its height, and the bullet blockers split by height. */
export type CoverGeo = { rects: readonly Rect[]; h: readonly number[]; high: Rect[]; lowWalls: Rect[]; low: Rect[] }

const geos = new WeakMap<MapDef, CoverGeo>()

export function coverGeo(map: MapDef): CoverGeo {
  let g = geos.get(map)
  if (!g) {
    const o = obstaclesOf(map)
    const tall = map.walls.filter((w) => w.h >= COVER.low).map((w) => w.rect)
    const lowWalls = map.walls.filter((w) => w.h < COVER.low).map((w) => w.rect)
    g = { rects: o.rects, h: o.h, high: [...tall, ...map.windows, ...map.glass], lowWalls, low: [...lowWalls, ...map.props.filter((p) => p.solid).map((p) => p.rect)] }
    geos.set(map, g)
  }
  return g
}

const near: number[] = []
const R = PLAYER_RADIUS
const LINE = R + COVER.gap

/** 2 when a point is inside something tall, 1 inside something low, else 0. */
function classAt(geo: CoverGeo, x: number, y: number): number {
  const grid = gridOf(geo.rects)
  const list = grid ? grid.query(x, y, x, y, near) : null
  const n = list ? list.length : geo.rects.length
  let c = 0
  for (let k = 0; k < n; k++) {
    const i = list ? list[k]! : k
    if (inRect(x, y, geo.rects[i]!)) c = Math.max(c, geo.h[i]! < COVER.low ? 1 : 2)
  }
  return c
}

/** The face a ray from (x, y) along (dx, dy) hits first within `reach`: hit point, outward normal and height class. */
function faceHit(geo: CoverGeo, x: number, y: number, dx: number, dy: number, reach: number): { hx: number; hy: number; nx: number; ny: number; cls: number; t: number } | null {
  const t = raycast(x, y, dx, dy, geo.rects, reach)
  if (t === Infinity) return null
  const hx = x + dx * t
  const hy = y + dy * t
  const grid = gridOf(geo.rects)
  const list = grid ? grid.query(hx - 0.01, hy - 0.01, hx + 0.01, hy + 0.01, near) : null
  const n = list ? list.length : geo.rects.length
  let best: { hx: number; hy: number; nx: number; ny: number; cls: number; t: number } | null = null
  let bd = Infinity
  for (let k = 0; k < n; k++) {
    const i = list ? list[k]! : k
    const r = geo.rects[i]!
    if (Math.abs(rayRect(x, y, dx, dy, r, t + 1e-3) - t) > 1e-3) continue
    // The entered face: the nearest side of the rect that faces the ray.
    const faces: [number, number, number][] = [
      [Math.abs(hx - r[0]), -1, 0],
      [Math.abs(hx - r[2]), 1, 0],
      [Math.abs(hy - r[1]), 0, -1],
      [Math.abs(hy - r[3]), 0, 1],
    ]
    for (const [d, fx, fy] of faces) {
      if (fx * dx + fy * dy >= 0 || d >= bd) continue
      bd = d
      best = { hx, hy, nx: fx, ny: fy, cls: geo.h[i]! < COVER.low ? 1 : 2, t }
    }
  }
  return best
}

/**
 * The surface a ray from the body along (dx, dy) runs into within `reach`, as cover, or null. The surface runs on
 * along the face for as long as the same kind of obstacle (low or tall) backs it and the body fits beside it; it ends
 * at a corner where the obstacle stops, or where something blocks the body.
 */
function surface(geo: CoverGeo, b: Body, dx: number, dy: number, reach: number): (Cover & { t: number }) | null {
  const f = faceHit(geo, b.x, b.y, dx, dy, reach)
  if (!f || f.nx * dx + f.ny * dy > -0.35) return null
  const tx = -f.ny
  const ty = f.nx
  // Snap the hit onto the exact face line, then the body line just off it.
  const ox = f.hx + f.nx * LINE
  const oy = f.hy + f.ny * LINE
  const back = (s: number) => classAt(geo, f.hx + tx * s - f.nx * 0.04, f.hy + ty * s - f.ny * 0.04) === f.cls
  const fits = (s: number) => !overlaps(ox + tx * s, oy + ty * s, R - 0.01, geo.rects)
  const ok = (s: number) => back(s) && fits(s)
  if (!ok(0)) return null
  const end = (dir: number): { edge: number; corner: boolean } => {
    let s = 0
    while (Math.abs(s) < 12 && ok(s + dir * 0.05)) s += dir * 0.05
    let a = s
    let c = s + dir * 0.05
    for (let i = 0; i < 7; i++) {
      const m = (a + c) / 2
      if (ok(m)) a = m
      else c = m
    }
    return { edge: a, corner: fits(c) && !back(c) }
  }
  const e1 = end(1)
  const e0 = end(-1)
  if (e1.edge - e0.edge < 0.3) return null
  let hi = e1.corner ? e1.edge - COVER.inset : e1.edge
  let lo = e0.corner ? e0.edge + COVER.inset : e0.edge
  if (lo > hi) lo = hi = (lo + hi) / 2
  const peekTo = (from: number, dir: number, corner: boolean): number => {
    if (!corner) return from
    let s = from
    while (Math.abs(s - from) < COVER.peek - 1e-6 && fits(s + dir * 0.05)) s += dir * 0.05
    return Math.abs(s - from) >= 0.25 ? s : from
  }
  const s0 = Math.max(lo, Math.min(hi, 0))
  return { ox, oy, nx: f.nx, ny: f.ny, lo, hi, loPeek: peekTo(lo, -1, e0.corner), hiPeek: peekTo(hi, 1, e1.corner), low: f.cls === 1, enter: 0, tx: ox + tx * s0, ty: oy + ty * s0, out: 0, peek: 0, away: 0, t: f.t }
}

const FAN = [0, 0.2, -0.2, 0.4, -0.4]

/**
 * Cover you could take from body `b` facing angle `dir`: the nearest suitable surface in a narrow fan ahead, preferring
 * the straight-ahead ray. `skip` excludes the surface you're already on. Doesn't change anything.
 */
export function findCover(geo: CoverGeo, b: Body, dir: number, reach: number = COVER.reach, skip: Cover | null = null): Cover | null {
  let best: Cover | null = null
  let score = Infinity
  for (const off of FAN) {
    const a = dir + off
    const c = surface(geo, b, Math.cos(a), Math.sin(a), reach)
    if (!c) continue
    if (skip && c.nx === skip.nx && c.ny === skip.ny && Math.abs((c.ox - skip.ox) * c.nx + (c.oy - skip.oy) * c.ny) < 0.05) continue
    const sc = c.t * (1 + Math.abs(off) * 2)
    if (sc < score) {
      score = sc
      const { t: _, ...rest } = c
      best = rest
    }
  }
  return best
}

/** Which way you're facing when you take cover: where you're moving, or else where you aim. */
export const facing = (i: Intent): number => (Math.hypot(i.mx, i.my) > 0.1 ? Math.atan2(i.my, i.mx) : i.aim)

/** Where the body is along the cover's tangent. */
export const along = (c: Cover, x: number, y: number): number => (x - c.ox) * -c.ny + (y - c.oy) * c.nx

function slide(b: Body, vx: number, vy: number, solids: readonly Rect[]): void {
  b.vx = vx
  b.vy = vy
  const steps = Math.max(1, Math.ceil((Math.hypot(vx, vy) * DT) / 0.12))
  for (let i = 0; i < steps; i++) {
    b.x += (vx * DT) / steps
    b.y += (vy * DT) / steps
    pushOut(b, R, solids)
  }
}

function start(b: CoverBody, c: Cover): void {
  const d = Math.hypot(c.tx - b.x, c.ty - b.y)
  c.enter = Math.max(COVER.enter, Math.ceil(d / COVER.hopSpeed / DT))
  b.cover = c
}

/**
 * One tick of movement, with cover; shared by the server and client prediction. `sprint` is whether the intent
 * sprints (see sprints()). Space takes the surface ahead, hops to another one in reach of your aim, or leaves; in
 * cover you slide along the surface, pop up over low cover or lean around a corner while the trigger or right click
 * is held. Returns whether you sprinted and whether you just popped out (the first shot waits COVER.pop).
 */
export function moveTick(b: CoverBody, i: Intent, sprint: boolean, geo: CoverGeo, solids: readonly Rect[]): { sprint: boolean; popped: boolean } {
  if (i.cover) {
    if (!b.cover) {
      const c = findCover(geo, b, facing(i))
      if (c) start(b, c)
    } else if (b.cover.enter === 0) {
      const c = findCover(geo, b, i.aim, COVER.hop, b.cover)
      if (c) start(b, c)
      else b.cover = null
    }
  }
  const c = b.cover
  if (c && c.enter === 0) {
    // Leave by holding away from the surface for a moment, or at once by sprinting away.
    const away = i.mx * c.nx + i.my * c.ny
    c.away = away > 0.6 ? c.away + 1 : 0
    if (c.away >= COVER.away || (sprint && away > 0.3)) b.cover = null
  }
  if (!b.cover) {
    stepBody(b, i.mx, i.my, sprint ? SPRINT_SPEED : SPEED, solids, DT)
    return { sprint, popped: false }
  }
  const cv = b.cover
  if (cv.enter > 0) {
    slide(b, (cv.tx - b.x) / (cv.enter * DT), (cv.ty - b.y) / (cv.enter * DT), solids)
    if (--cv.enter === 0) {
      // Something got in the way: no cover.
      if (Math.hypot(cv.tx - b.x, cv.ty - b.y) > 0.3) b.cover = null
      else {
        b.x = cv.tx
        b.y = cv.ty
      }
      b.vx = 0
      b.vy = 0
    }
    return { sprint: false, popped: false }
  }
  const tx = -cv.ny
  const ty = cv.nx
  const s = along(cv, b.x, b.y)
  const want = i.fire || i.peek
  const wasOut = cv.out > 0
  if (cv.low) cv.out = want ? COVER.out : Math.max(0, cv.out - 1)
  else {
    // Lean around a corner when you're at it and aim past it.
    const ax = Math.cos(i.aim) * tx + Math.sin(i.aim) * ty
    let side = 0
    if (ax > 0.2 && cv.hiPeek > cv.hi && s >= cv.hi - COVER.corner) side = 1
    else if (ax < -0.2 && cv.loPeek < cv.lo && s <= cv.lo + COVER.corner) side = -1
    if (want && (side || cv.peek)) {
      if (!cv.peek) cv.peek = side
      cv.out = COVER.out
    } else {
      cv.out = Math.max(0, cv.out - 1)
      if (!cv.out) cv.peek = 0
    }
  }
  let to: number
  if (cv.peek) {
    const target = cv.peek > 0 ? cv.hiPeek : cv.loPeek
    to = s + Math.max(-COVER.peekSpeed * DT, Math.min(COVER.peekSpeed * DT, target - s))
  } else if (s > cv.hi + 1e-6 || s < cv.lo - 1e-6) {
    const target = Math.max(cv.lo, Math.min(cv.hi, s))
    to = s + Math.max(-COVER.peekSpeed * DT, Math.min(COVER.peekSpeed * DT, target - s))
  } else {
    const mt = i.mx * tx + i.my * ty
    to = Math.max(cv.lo, Math.min(cv.hi, s + (Math.abs(mt) > 0.3 ? Math.sign(mt) * COVER.speed * DT : 0)))
  }
  b.x = cv.ox + tx * to
  b.y = cv.oy + ty * to
  b.vx = (tx * (to - s)) / DT
  b.vy = (ty * (to - s)) / DT
  return { sprint: false, popped: !wasOut && cv.out > 0 }
}

/** At a corner you can lean around: -1 the lo end, 1 the hi end, 0 none. */
export function cornerOf(c: Cover, x: number, y: number): number {
  if (c.low || c.enter > 0) return 0
  if (c.peek) return c.peek
  const s = along(c, x, y)
  if (c.hiPeek > c.hi && s >= c.hi - COVER.corner) return 1
  if (c.loPeek < c.lo && s <= c.lo + COVER.corner) return -1
  return 0
}

const exposedLow = (c: CoverLike | null | undefined): boolean => !!c && c.low && !!c.out && !c.enter
const hidingLow = (c: CoverLike | null | undefined): boolean => !!c && c.low && !c.out && !c.enter

/**
 * A hitscan shot from `from` along unit (dx, dy), with cover rules. `wall` is where it stops if it hits nobody, and
 * reaches() says whether a body `t` metres down the line can be hit:
 * - tall walls, windows and glass always stop it;
 * - low walls (cubicle partitions) stop it too, except right in front of a shooter popped up over low cover, or right
 *   in front of a target popped up behind low cover;
 * - a target crouched behind low cover (partitions and solid furniture) can't be hit through it.
 * With nobody in cover this is exactly a raycast against the bullet blockers.
 */
export function shotLane(geo: CoverGeo, from: { x: number; y: number; cover: CoverLike | null }, dx: number, dy: number, range: number) {
  const high = raycast(from.x, from.y, dx, dy, geo.high, range)
  const lo = exposedLow(from.cover) ? COVER.skip : 0
  const lowWall = (t0: number, t1: number) => t1 > t0 && raycast(from.x + dx * t0, from.y + dy * t0, dx, dy, geo.lowWalls, t1 - t0) !== Infinity
  const lw = raycast(from.x + dx * lo, from.y + dy * lo, dx, dy, geo.lowWalls, range - lo)
  return {
    wall: Math.min(high, lw === Infinity ? Infinity : lo + lw),
    reaches(q: { x: number; y: number; cover?: CoverLike | null }, t: number): boolean {
      if (t >= high) return false
      if (lowWall(lo, exposedLow(q.cover) ? t - COVER.guard : t)) return false
      return !(hidingLow(q.cover) && raycast(q.x, q.y, -dx, -dy, geo.low, Math.min(COVER.guard, t)) !== Infinity)
    },
  }
}
