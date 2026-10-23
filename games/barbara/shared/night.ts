import { cosApprox, sinApprox } from "./creature"
import { isDeepWater, nextRandom, terrainHeight, treesNear, type WoodsWorld } from "./world"

/**
 * One night as a game (NIGHT.md): STORY.md's five key moments as a trail of clues, each pointing to the next, ending at
 * the red light on the ridge; a clock that runs out at dawn, torch batteries that run out sooner, and the end. Plain data stepped in `stepWoods` after everyone moves, so the room,
 * solo play and every client agree; the layout comes from the night's seed alone (`placeNight`, only + − × ÷ √ and
 * `nextRandom`), so a replay of the same seed is the same night.
 */

/** STORY.md's key moments: the car, the page, the badge, the cassette, and the extra searcher's strip of tape. */
export const CLUE_KINDS = ["car", "page", "badge", "cassette", "strip"] as const
export type ClueKind = (typeof CLUE_KINDS)[number]
export const CLUE = { car: 0, page: 1, badge: 2, cassette: 3, strip: 4 } as const
/** What each clue is called in a caption ("Tess found her ID badge."). */
export const CLUE_NAMES: Record<ClueKind, string> = { car: "her car unlocked, a donut box on the seat", page: "a page from her appointment book", badge: "her ID badge in the creek mud", cassette: "her tape recorder", strip: "the strip of tape on the ridge" }
/** Where Barbara was going: the radio tower, the red light on the ridge everyone can see (`world.ridgeLight`). */
export const RIDGE_NAME = "the radio tower, the red light on the ridge"

/** A bearing line from a clue towards the next one's area (unit plan direction), or the ridge for the cassette's. */
export type Lead = { to: number; x: number; z: number; dx: number; dz: number; ridge?: true }
export type Clue = {
  id: number
  kind: ClueKind
  x: number
  z: number
  y: number
  /** Height of the thing above the ground (m): what a beam has to fall on. */
  h: number
  /** Plan direction the model faces (unit vector, for drawing). */
  fx: number
  fz: number
  /** How close you must be (m). */
  reach: number
  /** The trunk it's tied to (the page, the strip), or −1. */
  tree: number
  leads: Lead[]
}
export type Spare = { id: number; x: number; z: number; y: number; camp: boolean }
export type NightLayout = { seed: number; /** The ridge light's plan position. */ ridge: { x: number; z: number }; clues: Clue[]; spares: Spare[] }

export type NightPhase = "camp" | "search" | "won" | "lost"
export type NightReason = "" | "strip" | "dawn" | "dark"
export type Find = {
  clue: number
  by: number
  at: number
  /** Who has it on their map now, when the finder has left (`handOff`); else the finder. */
  held?: number
}
/** A bot's current lead: the clue it's after and how far through its sweep it is. */
export type BotLead = { clue: number; step: number }

export type NightState = {
  seed: number
  layout: NightLayout
  phase: NightPhase
  /** Sim time the search began (left camp), dawn, and the end (0 until then). */
  start: number
  dawn: number
  end: number
  reason: NightReason
  finds: Find[]
  /** Spare batteries picked up (ids). */
  taken: number[]
  /** Seconds every torch has been dead with no spare left to swap in. */
  dark: number
  /** The cassette plays at this time from whoever found it (0 when not due). */
  tapeAt: number
  tapeBy: number
  /** Dawn's first line has been said. */
  dawnSaid: boolean
  /** The extra searcher calls "Over here!" from the strip at this time (0 until the tape has played), and again after. */
  callAt: number
  /** Times it has called. */
  calls: number
  bots: Record<number, BotLead>
  /** Bumped when anything a room sends in `NightWire` changes. */
  rev: number
}

export type NightFeel = { dawnMinutes: number; batteryMinutes: number; swapSeconds: number }

/** Clock on the watch: the search starts at 12:40 AM and dawn (civil twilight) is 6:40 AM. */
export const WATCH_START = 40
export const WATCH_DAWN = 6 * 60 + 40
/** The sky starts to grey this many minutes of play before dawn. */
export const GREY_MINUTES = 4
/** Within this of a clue, with your torch lit and on it, you've found it (m); the car is bigger. */
export const FIND_REACH = 4.5
const CAR_REACH = 7
/** The beam must be within this of the clue (rad, half-angle about the view axis). */
export const FIND_CONE = 0.45
const FIND_COS = Math.cos(FIND_CONE)
const PICKUP = 1.4
/** Everything dead this long with no spare in anyone's pocket and the night is lost (s). */
const DARK_LOSS = 20
/** A person further than this from any lit walker, with their own torch off, is on their own (s counted on `isolated`). */
export const ISOLATED_RANGE = 25
const MIN_FROM_CAMP = 62
/** Clues stay this far inside the world's edge (m), clear of its boundary. */
export const EDGE_MARGIN = 40
/** Seconds between the extra searcher's calls until someone reaches the strip. */
export const CALL_EVERY = 45

const dist = (ax: number, az: number, bx: number, bz: number) => Math.sqrt((ax - bx) * (ax - bx) + (az - bz) * (az - bz))
function direction(rng: { seed: number }): [number, number] {
  for (let i = 0; i < 16; i++) {
    const x = nextRandom(rng) * 2 - 1, z = nextRandom(rng) * 2 - 1, l = Math.sqrt(x * x + z * z)
    if (l > 0.2 && l <= 1) return [x / l, z / l]
  }
  return [1, 0]
}
const unit = (x: number, z: number): [number, number] => { const l = Math.sqrt(x * x + z * z) || 1; return [x / l, z / l] }

/** Somewhere you can stand: in bounds, not in the lake, stepped off any trunk. */
function walkable(world: WoodsWorld, x: number, z: number): boolean {
  const h = world.params.half - EDGE_MARGIN
  return Math.abs(x) < h && Math.abs(z) < h && !isDeepWater(world, x, z) && dist(x, z, world.lake.x, world.lake.z) > 8
}
/** Clear of solids by this much (m): a person stands right beside it. */
const SOLID_CLEAR = 0.28 + 0.6 // PLAYER_RADIUS (sim.ts) and a hand's width
/** Out of a rectangle grown by `SOLID_CLEAR`, by its nearest side; null if already clear. */
function outOfRect(x: number, z: number, x0: number, z0: number, x1: number, z1: number): [number, number] | null {
  x0 -= SOLID_CLEAR; z0 -= SOLID_CLEAR; x1 += SOLID_CLEAR; z1 += SOLID_CLEAR
  if (x <= x0 || x >= x1 || z <= z0 || z >= z1) return null
  const l = x - x0, r = x1 - x, b = z - z0, f = z1 - z, m = Math.min(l, r, b, f)
  return m === l ? [x0, z] : m === r ? [x1, z] : m === b ? [x, z0] : [x, z1]
}
/** Stepped off any trunk, rock or building (`solidsNear`'s solids, every rock however low), so it can be reached. */
function offTrunks(world: WoodsWorld, x: number, z: number): [number, number] {
  for (let k = 0; k < 6; k++) {
    let moved = false
    for (const t of treesNear(world, x, z, 1.2)) {
      const d = dist(x, z, t.x, t.z), need = t.radius + 0.9
      if (d >= need) continue
      const [ux, uz] = d > 1e-3 ? [(x - t.x) / d, (z - t.z) / d] : [1, 0]
      x = t.x + ux * need; z = t.z + uz * need; moved = true
    }
    for (const r of world.rocks) {
      const e = Math.max(r.w, r.d) * 0.5
      if (Math.abs(r.x - x) > e + SOLID_CLEAR || Math.abs(r.z - z) > e + SOLID_CLEAR) continue
      const out = outOfRect(x, z, r.x - e, r.z - e, r.x + e, r.z + e)
      if (out) { [x, z] = out; moved = true }
    }
    for (const b of world.buildings) {
      if (b.kind === "dock" || b.kind === "canoe") continue
      const out = outOfRect(x, z, ...b.rect)
      if (out) { [x, z] = out; moved = true }
    }
    if (!moved) break
  }
  return [x, z]
}

/** The trunk nearest (x, z) within `r` that a page or tape could be tied to, or null. */
function trunkNear(world: WoodsWorld, x: number, z: number, r: number) {
  let best: { id: number; x: number; z: number; radius: number } | null = null, bd = r
  for (const t of treesNear(world, x, z, r)) { const d = dist(x, z, t.x, t.z); if (d < bd && t.radius > 0.12) { bd = d; best = t } }
  return best
}

/** Down to the lowest ground within `r` of (x, z) (the creek bed in a hollow), sampled on a small grid. */
function lowest(world: WoodsWorld, x: number, z: number, r: number): [number, number] {
  let bx = x, bz = z, by = terrainHeight(world.terrain, x, z)
  for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
    const qx = x + (i * r) / 2, qz = z + (j * r) / 2
    if (i * i + j * j > 5 || !walkable(world, qx, qz)) continue
    const y = terrainHeight(world.terrain, qx, qz)
    if (y < by - 0.05) { by = y; bx = qx; bz = qz }
  }
  return [bx, bz]
}

/**
 * The night's layout from its seed: the car at the lot, the cassette part-way up towards the ridge light, the page and
 * the badge either side of the car→cassette line so their bearings cross at it, the strip on a trunk near the tower,
 * and the spare batteries (three on the mess table, one or two along the way). Everything stays `EDGE_MARGIN` inside
 * the world's edge.
 */
export function placeNight(world: WoodsWorld, seed: number): NightLayout {
  const rng = { seed: (Math.imul(seed | 0, 1597334677) ^ 0x2c1b3c6d) | 0 }
  const r = () => nextRandom(rng)
  const ridge = { x: world.ridgeLight.x, z: world.ridgeLight.z }
  const camp = world.camp
  const ground = (x: number, z: number) => terrainHeight(world.terrain, x, z)
  const farFromCamp = (x: number, z: number, margin = 0) => dist(x, z, camp.x, camp.z) >= MIN_FROM_CAMP + margin
  // The strip: on a trunk 12–26 m from the tower, on the side you come up from, inside the edge.
  let sx = 0, sz = 0, stree = -1
  {
    const [ux, uz] = unit(camp.x - ridge.x, camp.z - ridge.z)
    for (let k = 0; k < 40 && stree < 0; k++) {
      const a = (r() - 0.5) * 2.2, d = 12 + 14 * r()
      const ca = cosApprox(a), sa = sinApprox(a)
      const dx = ux * ca - uz * sa, dz = ux * sa + uz * ca
      const x = ridge.x + dx * d, z = ridge.z + dz * d
      if (!walkable(world, x, z)) continue
      const t = trunkNear(world, x, z, 5)
      if (!t || !walkable(world, t.x, t.z)) continue
      // The tape faces back down the hill (towards camp).
      const [fx, fz] = unit(camp.x - t.x, camp.z - t.z)
      sx = t.x + fx * (t.radius + 0.05); sz = t.z + fz * (t.radius + 0.05); stree = t.id
    }
    if (stree < 0) { [sx, sz] = offTrunks(world, ridge.x + ux * 16, ridge.z + uz * 16) }
  }
  const dest = { x: sx, z: sz }
  // The car: the gravel lot at the head of the old path.
  const cx = camp.x + 14 + (r() - 0.5) * 3, cz = camp.z - 26 + (r() - 0.5) * 2
  const [ux, uz] = unit(dest.x - cx, dest.z - cz)
  const span = dist(cx, cz, dest.x, dest.z)
  // Where the cassette's area is, then the page's and badge's along bearings either side of it.
  let kx = 0, kz = 0, px = 0, pz = 0, bx = 0, bz = 0
  for (let tries = 0; tries < 80; tries++) {
    const f = 0.5 + 0.12 * r(), off = (10 + 30 * r()) * (r() < 0.5 ? -1 : 1)
    kx = cx + ux * span * f - uz * off; kz = cz + uz * span * f + ux * off
    const [kux, kuz] = unit(kx - cx, kz - cz)
    const t1 = 0.7 + 0.7 * r(), t2 = 0.7 + 0.7 * r()
    const [d1x, d1z] = unit(kux - kuz * t1, kuz + kux * t1), [d2x, d2z] = unit(kux + kuz * t2, kuz - kux * t2)
    const l1 = 70 + 40 * r(), l2 = 70 + 40 * r()
    px = cx + d1x * l1; pz = cz + d1z * l1; bx = cx + d2x * l2; bz = cz + d2z * l2
    const ok = [[kx, kz], [px, pz], [bx, bz]].every(([x, z]) => walkable(world, x!, z!) && farFromCamp(x!, z!, 6))
    if (ok) break
  }
  // Each clue lies a few metres from the point its leads aim at, off any trunk.
  const near = (ax: number, az: number, spread: number): [number, number] => {
    for (let k = 0; k < 12; k++) {
      const [dx, dz] = direction(rng), s = spread * r()
      const x = ax + dx * s, z = az + dz * s
      if (walkable(world, x, z) && farFromCamp(x, z)) return offTrunks(world, x, z)
    }
    return offTrunks(world, ax, az)
  }
  // The page is tied to the nearest trunk; the badge lies in the lowest ground near its point (the creek mud).
  let ptree = -1
  let [qx, qz] = near(px, pz, 2)
  const pt = trunkNear(world, qx, qz, 5)
  if (pt && walkable(world, pt.x, pt.z) && farFromCamp(pt.x, pt.z)) {
    const [fx, fz] = unit(cx - pt.x, cz - pt.z)
    qx = pt.x + fx * (pt.radius + 0.03); qz = pt.z + fz * (pt.radius + 0.03); ptree = pt.id
  }
  const [lx, lz] = lowest(world, ...near(bx, bz, 1.5), 3.5)
  const pts: [number, number][] = [offTrunks(world, cx, cz), [qx, qz], offTrunks(world, lx, lz), near(kx, kz, 4), [sx, sz]]
  const lead = (from: number, to: number, ax: number, az: number, ridgeLead = false): Lead => {
    const [fx, fz] = pts[from]!, [dx, dz] = unit(ax - fx, az - fz)
    return { to, x: fx, z: fz, dx, dz, ...(ridgeLead ? { ridge: true as const } : {}) }
  }
  const leads: Lead[][] = [
    [lead(0, CLUE.page, px, pz), lead(0, CLUE.badge, bx, bz)],
    [lead(1, CLUE.cassette, kx, kz)],
    [lead(2, CLUE.cassette, kx, kz)],
    [lead(3, CLUE.strip, ridge.x, ridge.z, true)],
    [],
  ]
  const HEIGHT: Record<ClueKind, number> = { car: 0.8, page: 1.3, badge: 0.05, cassette: 0.05, strip: 1.5 }
  const clues: Clue[] = CLUE_KINDS.map((kind, id) => {
    const [x, z] = pts[id]!
    // Most face back the way you'd come; the car faces up the path.
    const [fx, fz] = id === 0 ? [0, -1] : unit(cx - x, cz - z)
    const tree = id === CLUE.page ? ptree : id === CLUE.strip ? stree : -1
    return { id, kind, x, z, y: ground(x, z), h: HEIGHT[kind], fx, fz, reach: id === 0 ? CAR_REACH : FIND_REACH, tree, leads: leads[id]! }
  })
  // Spares: three on the mess table, and one or two out along the way.
  const table = world.buildings.find((b) => b.kind === "table")
  const spares: Spare[] = []
  if (table) {
    const tz = (table.rect[1] + table.rect[3]) / 2, ty = table.y + table.h
    for (let i = 0; i < 3; i++) spares.push({ id: i, x: table.rect[0] + 0.5 + i * 0.6, z: tz, y: ty, camp: true })
  }
  const legs: [number, number, number, number][] = [[cx, cz, kx, kz], [kx, kz, dest.x, dest.z]]
  const woods = r() < 0.5 ? 2 : 1
  for (let i = 0; i < woods; i++) {
    const [ax, az, bx2, bz2] = legs[i % 2]!
    for (let k = 0; k < 12; k++) {
      const t = 0.3 + 0.4 * r(), off = (8 + 12 * r()) * (r() < 0.5 ? -1 : 1)
      const [lx2, lz2] = unit(bx2 - ax, bz2 - az)
      const x = ax + (bx2 - ax) * t - lz2 * off, z = az + (bz2 - az) * t + lx2 * off
      if (!walkable(world, x, z) || !farFromCamp(x, z)) continue
      const [q2x, q2z] = offTrunks(world, x, z)
      spares.push({ id: spares.length, x: q2x, z: q2z, y: ground(q2x, q2z), camp: false })
      break
    }
  }
  return { seed, ridge, clues, spares }
}

export function createNight(world: WoodsWorld, seed: number): NightState {
  return { seed, layout: placeNight(world, seed), phase: "camp", start: 0, dawn: 0, end: 0, reason: "", finds: [], taken: [], dark: 0, tapeAt: 0, tapeBy: -1, dawnSaid: false, callAt: 0, calls: 0, bots: {}, rev: 0 }
}

/** Minutes after midnight on the watch at sim time `t` (12:40 until the search starts; it stops at the end). */
export function watchMinutes(n: Pick<NightState, "phase" | "start" | "dawn" | "end">, t: number): number {
  if (n.phase === "camp" || n.dawn <= n.start) return WATCH_START
  const now = n.end > 0 ? n.end : t
  return WATCH_START + ((now - n.start) / (n.dawn - n.start)) * (WATCH_DAWN - WATCH_START)
}

/** How grey the sky has gone (0 night, 1 dawn): from `GREY_MINUTES` before dawn. */
export function dawnShare(n: Pick<NightState, "phase" | "start" | "dawn" | "end">, t: number): number {
  if (n.phase === "camp" || n.dawn <= n.start) return 0
  const now = n.end > 0 ? n.end : t
  const k = (now - (n.dawn - GREY_MINUTES * 60)) / (GREY_MINUTES * 60)
  return Math.max(0, Math.min(1, k))
}

/** The walker fields the night reads and writes (the sim's `Player` fits). */
export type NightWalker = {
  id: number
  bot: boolean
  name: string
  x: number
  z: number
  yaw: number
  pitch: number
  light: boolean
  /** Battery left, 0..1. */
  charge: number
  /** A spare battery in the pocket. */
  spare: boolean
  /** Seconds left fumbling a fresh battery in (torch off meanwhile). */
  swap: number
  /** Seconds this person has been on their own in the dark (the spider's hook; see NIGHT.md). */
  isolated: number
  /** Something has hold of this walker (the spider's hook): they can't move and their torch is out. Null today. */
  capture: { by: number; left: number } | null
  map: { clues: number[]; trail: number[] }
}

/** A torch that can be lit: charge left, not mid-swap, not held. */
export const canLight = (p: Pick<NightWalker, "charge" | "swap" | "capture">) => p.charge > 0 && p.swap <= 0 && !p.capture

/** Whether `p`'s lit torch is on `c` from where they stand. */
export function seesClue(p: NightWalker, c: Clue, eyeY: number): boolean {
  if (!p.light) return false
  const dx = c.x - p.x, dz = c.z - p.z, d = Math.sqrt(dx * dx + dz * dz)
  if (d > c.reach) return false
  if (d < 1.2) return true
  const dy = c.y + c.h - eyeY
  const len = Math.sqrt(d * d + dy * dy)
  const cp = Math.cos(p.pitch)
  const vx = -Math.sin(p.yaw) * cp, vy = Math.sin(p.pitch), vz = -Math.cos(p.yaw) * cp
  return (vx * dx + vy * dy + vz * dz) / len >= FIND_COS
}

export type NightEvent =
  | { kind: "clue-found"; by: number; clue: number; what: ClueKind; x: number; z: number; at: number }
  | { kind: "spare-taken"; by: number; spare: number }
  | { kind: "torch"; by: number; state: "low" | "dead" | "swap" | "fresh" }
  | { kind: "night"; phase: NightPhase; reason: NightReason; at: number; debrief?: Debrief }

/** The end's record: each walker's path (thinned) and the finds. */
export type Debrief = {
  start: number
  end: number
  walkers: { id: number; name: string; bot: boolean; trail: number[] }[]
  finds: Find[]
  /** Every tape up at the end: x, z (0.1 m) and who tied it. The searched ground. */
  tapes: number[][]
}

const DEBRIEF_POINTS = 300
function thin(trail: readonly number[]): number[] {
  const n = trail.length >> 1
  if (n <= DEBRIEF_POINTS) return trail.map((v) => Math.round(v * 10) / 10)
  const out: number[] = []
  for (let i = 0; i < DEBRIEF_POINTS; i++) { const k = Math.round((i * (n - 1)) / (DEBRIEF_POINTS - 1)); out.push(Math.round(trail[k * 2]! * 10) / 10, Math.round(trail[k * 2 + 1]! * 10) / 10) }
  return out
}

export type TapeMark = { x: number; z: number; by: number }
function end(n: NightState, walkers: readonly NightWalker[], tapes: readonly TapeMark[], t: number, phase: "won" | "lost", reason: NightReason, events: NightEvent[]) {
  n.phase = phase; n.reason = reason; n.end = t; n.rev++
  const r1 = (v: number) => Math.round(v * 10) / 10
  const debrief: Debrief = { start: n.start, end: t, walkers: walkers.map((w) => ({ id: w.id, name: w.name, bot: w.bot, trail: thin(w.map.trail) })), finds: n.finds.map((f) => ({ ...f })), tapes: tapes.map((k) => [r1(k.x), r1(k.z), k.by]) }
  events.push({ kind: "night", phase, reason, at: t, debrief })
}

const addUnique = (list: number[], v: number) => { if (!list.includes(v)) list.push(v) }

/**
 * One tick of the night, after everyone has moved: start the clock when someone leaves camp; batteries, swaps and
 * spares; finds; who's on their own; dawn and darkness. Torches that can't light are put out here, so a walker's
 * `light` after this step is what everyone sees.
 */
export function stepNight(n: NightState, world: WoodsWorld, walkers: readonly NightWalker[], tapes: readonly TapeMark[], t: number, dt: number, feel: NightFeel, eyeY: (w: NightWalker) => number): NightEvent[] {
  const events: NightEvent[] = []
  const camp = world.camp
  if (n.phase === "camp" && walkers.some((w) => !w.bot && dist(w.x, w.z, camp.x, camp.z) > camp.radius + 4)) {
    n.phase = "search"; n.start = t; n.dawn = t + Math.max(0.5, feel.dawnMinutes) * 60; n.rev++
    events.push({ kind: "night", phase: "search", reason: "", at: t })
  }
  const live = n.phase === "camp" || n.phase === "search"
  for (const w of walkers) {
    if (w.capture) w.light = false
    if (w.swap > 0) {
      w.swap = Math.max(0, w.swap - dt)
      w.light = false
      if (w.swap <= 0) { w.charge = 1; w.spare = false; events.push({ kind: "torch", by: w.id, state: "fresh" }) }
    } else if (w.charge <= 0) {
      w.light = false
      if (w.spare && live) { w.swap = Math.max(0.1, feel.swapSeconds); events.push({ kind: "torch", by: w.id, state: "swap" }) }
    } else if (w.light && n.phase === "search") {
      const was = w.charge
      w.charge = Math.max(0, w.charge - dt / (Math.max(0.1, feel.batteryMinutes) * 60))
      if (was > 0.25 && w.charge <= 0.25) events.push({ kind: "torch", by: w.id, state: "low" })
      if (w.charge <= 0) { w.light = false; events.push({ kind: "torch", by: w.id, state: "dead" }) }
    }
    if (live && !w.spare && !w.capture) {
      for (const s of n.layout.spares) {
        if (n.taken.includes(s.id) || dist(w.x, w.z, s.x, s.z) > PICKUP) continue
        n.taken.push(s.id); n.rev++; w.spare = true
        events.push({ kind: "spare-taken", by: w.id, spare: s.id })
        break
      }
    }
  }
  if (n.phase === "search") {
    for (const w of walkers) {
      if (!w.light) continue
      for (const c of n.layout.clues) {
        if (w.map.clues.includes(c.id) || !seesClue(w, c, eyeY(w))) continue
        w.map.clues.push(c.id)
        // Anyone can look at a clue someone else found; only the first sighting is news.
        if (n.finds.some((f) => f.clue === c.id)) continue
        n.finds.push({ clue: c.id, by: w.id, at: t }); n.rev++
        events.push({ kind: "clue-found", by: w.id, clue: c.id, what: c.kind, x: c.x, z: c.z, at: t })
        if (c.kind === "cassette") { n.tapeAt = t + 3.5; n.tapeBy = w.id }
      }
    }
    // Bots tell each other, and pick up what a person near them has seen (people compare maps themselves).
    for (const a of walkers) for (const b of walkers) {
      if (a === b || !b.bot || dist(a.x, a.z, b.x, b.z) > 6) continue
      for (const id of a.map.clues) addUnique(b.map.clues, id)
    }
  }
  // On your own in the dark: your torch out, nobody lit near (the spider's hook; nothing reacts yet).
  for (const w of walkers) {
    if (w.bot) continue
    const alone = !w.light && !walkers.some((o) => o !== w && o.light && dist(o.x, o.z, w.x, w.z) < ISOLATED_RANGE)
    w.isolated = alone ? w.isolated + dt : 0
  }
  if (n.phase !== "search") return events
  if (n.finds.some((f) => f.clue === CLUE.strip)) { end(n, walkers, tapes, t, "won", "strip", events); return events }
  if (t >= n.dawn) { end(n, walkers, tapes, t, "lost", "dawn", events); return events }
  const out = walkers.every((w) => w.capture || (w.charge <= 0 && !w.spare && w.swap <= 0))
  n.dark = out ? n.dark + dt : 0
  if (n.dark >= DARK_LOSS) end(n, walkers, tapes, t, "lost", "dark", events)
  return events
}

/**
 * A walker leaves the night: the nearest one left takes what was on their map, so no clue is stranded with nobody
 * holding it, and the finds they held say who has them now.
 */
export function handOff(n: NightState, gone: NightWalker, rest: readonly NightWalker[]): void {
  if (!gone.map.clues.length || !rest.length) return
  let heir = rest[0]!
  for (const w of rest) if (dist(w.x, w.z, gone.x, gone.z) < dist(heir.x, heir.z, gone.x, gone.z)) heir = w
  for (const id of gone.map.clues) addUnique(heir.map.clues, id)
  for (const f of n.finds) if ((f.held ?? f.by) === gone.id) { f.held = heir.id; n.rev++ }
}

// ---------------------------------------------------------------- bots

/** Where a walker's map says a clue is: a point (with how wide to search) or a bearing line to walk. */
export type Target = { clue: number; x: number; z: number; radius: number; line?: { dx: number; dz: number } }

/**
 * Clues not yet found that `known` (a map's clue ids) points at. Everyone knows where the car is, and once the extra
 * searcher has called (`called`) everyone heard where from.
 */
export function targetsFrom(layout: NightLayout, known: readonly number[], found: ReadonlySet<number>, called = false): Target[] {
  const out: Target[] = []
  for (const c of layout.clues) {
    if (found.has(c.id)) continue
    if (c.id === CLUE.car) { out.push({ clue: c.id, x: c.x, z: c.z, radius: 4 }); continue }
    if (c.id === CLUE.strip && called) { out.push({ clue: c.id, x: c.x, z: c.z, radius: 6 }); continue }
    const leads = layout.clues.filter((k) => known.includes(k.id)).flatMap((k) => k.leads.filter((l) => l.to === c.id))
    if (!leads.length) continue
    if (leads.some((l) => l.ridge)) { out.push({ clue: c.id, x: layout.ridge.x, z: layout.ridge.z, radius: 28 }); continue }
    if (leads.length >= 2) {
      const [a, b] = leads as [Lead, Lead]
      const cross = a.dx * b.dz - a.dz * b.dx
      if (Math.abs(cross) > 0.2) {
        const s = ((b.x - a.x) * b.dz - (b.z - a.z) * b.dx) / cross
        out.push({ clue: c.id, x: a.x + a.dx * s, z: a.z + a.dz * s, radius: 9 })
        continue
      }
    }
    const l = leads[0]!
    out.push({ clue: c.id, x: l.x, z: l.z, radius: 6, line: { dx: l.dx, dz: l.dz } })
  }
  return out
}

/** How far a bot walks a bearing line before turning back (m). */
const LINE_REACH = 150

/**
 * Where a bot with a torch should head next, from what its map knows: the least-taken lead (then the nearest), swept
 * either side of a bearing line or spiralled round a point. Null when it knows of nothing left to look for.
 */
export function botWaypoint(n: NightState, bot: NightWalker, others: readonly NightWalker[]): { x: number; z: number; searching: boolean } | null {
  if (n.phase !== "search") return null
  // What it hasn't seen itself is still to look for, even if someone else found it (it can sight it again).
  const targets = targetsFrom(n.layout, bot.map.clues, new Set(bot.map.clues), n.calls > 0)
  let lead = n.bots[bot.id]
  let target = lead ? targets.find((t) => t.clue === lead!.clue) : undefined
  if (!target) {
    if (!targets.length) { delete n.bots[bot.id]; return null }
    const taken = (clue: number) => others.filter((o) => o !== bot && n.bots[o.id]?.clue === clue).length
    const start = (t: Target) => dist(bot.x, bot.z, t.x, t.z)
    target = [...targets].sort((a, b) => taken(a.clue) - taken(b.clue) || (a.line ? 1 : 0) - (b.line ? 1 : 0) || start(a) - start(b))[0]!
    lead = n.bots[bot.id] = { clue: target.clue, step: 0 }
  }
  const at = (k: number): [number, number] => {
    if (target.line) {
      const s = 10 + (k % Math.floor(LINE_REACH / 6)) * 6, side = k % 2 ? 4 : -4
      return [target.x + target.line.dx * s - target.line.dz * side, target.z + target.line.dz * s + target.line.dx * side]
    }
    // A spiral out to the search radius and back in.
    const turns = Math.max(4, Math.round(target.radius * 1.4)), j = k % (turns * 2), r = target.radius * Math.min(j, turns * 2 - j) / turns
    const a = k * 1.3
    return [target.x + Math.cos(a) * r, target.z + Math.sin(a) * r]
  }
  let [x, z] = at(lead!.step)
  if (dist(bot.x, bot.z, x, z) < 2.2) { lead!.step++; [x, z] = at(lead!.step) }
  const searching = target.line ? true : dist(bot.x, bot.z, target.x, target.z) < target.radius + 6
  return { x, z, searching }
}

// ---------------------------------------------------------------- wording

const POINTS = ["north", "north-north-east", "north-east", "east-north-east", "east", "east-south-east", "south-east", "south-south-east", "south", "south-south-west", "south-west", "west-south-west", "west", "west-north-west", "north-west", "north-north-west"]
/** A plan direction as a searcher would say it off the compass: "north-east, about 45°" (map north, −z). */
export function bearingWords(dx: number, dz: number): string {
  let deg = (Math.atan2(dx, -dz) * 180) / Math.PI
  if (deg < 0) deg += 360
  return `${POINTS[Math.round(deg / 22.5) % 16]}, about ${Math.round(deg / 5) * 5 % 360}°`
}

/** What a clue tells whoever has it (the finder's caption, and the end card). */
export function leadText(c: Clue): string {
  const [a, b] = c.leads
  switch (c.kind) {
    case "car": return `The driver's door is unlocked now, and there's a pink donut box on the passenger seat that wasn't there this afternoon. Two sets of footprints leave the lot: one heads ${bearingWords(a!.dx, a!.dz)}, the other ${bearingWords(b!.dx, b!.dz)}.`
    case "page": return `"Sunday 17: 11:00 Hike? 6:00 R." Tied on with flagging tape that isn't ours. An arrow in pen points ${bearingWords(a!.dx, a!.dz)}.`
    case "badge": return `BARBARA K. NAKAMURA, EXECUTIVE SYSTEMS, on a snapped lanyard in the creek mud. Drag marks lead ${bearingWords(a!.dx, a!.dz)}.`
    case "cassette": return `Rewound and played, it's Barbara: she was walking up to ${RIDGE_NAME}.`
    case "strip": return "Only tape: one strip, tied the way Walt ties it. Nobody is here."
  }
}

/**
 * The search's next step for one person, in plain words: what their own map knows, what they heard and what friends
 * found. Drawn small in a corner so the goal is never a guess (Kit's playtest: "make it clear what the goal is").
 */
export function nextStep(n: Pick<NightState, "phase" | "layout" | "finds" | "calls">, known: readonly number[], name: (id: number) => string): string {
  if (n.phase === "won") return "You reached the ridge. Tab: the debrief."
  if (n.phase === "lost") return "The search is over for tonight. Tab: the debrief."
  const has = (k: number) => known.includes(k)
  const c = n.layout.clues
  if (n.calls > 0) return "Someone shouted \"Over here!\" from up by the red light on the ridge. Go."
  if (has(CLUE.cassette)) return `She was going up to ${RIDGE_NAME}. Head for it.`
  // A friend's find you haven't seen: go and get it from them.
  const news = [...n.finds].reverse().find((f) => !has(f.clue))
  const what = news ? CLUE_NAMES[c[news.clue]!.kind] : ""
  const tell = !news ? "" : news.held === undefined || news.held === news.by
    ? ` ${name(news.by)} found ${what}: find them and compare maps (hold G together).`
    : ` ${name(news.held)} has ${what} on their map: find them and compare maps (hold G together).`
  if (has(CLUE.page) && has(CLUE.badge)) return "Rule both bearings on your map (G): her tape recorder is where they cross." + tell
  if (has(CLUE.page) || has(CLUE.badge)) {
    const one = has(CLUE.page) ? c[CLUE.page]! : c[CLUE.badge]!
    return `Follow ${bearingWords(one.leads[0]!.dx, one.leads[0]!.dz)} from the ${one.kind === "page" ? "page" : "badge"}; the other trail's clue gives a second bearing that crosses it.` + tell
  }
  if (has(CLUE.car)) { const [a, b] = c[CLUE.car]!.leads; return `Two trails leave her car: ${bearingWords(a!.dx, a!.dz)} and ${bearingWords(b!.dx, b!.dz)}. Split up and follow them.` + tell }
  if (tell) return tell.trim()
  return "Start at her car in the lot by the trailhead. Look it over with your torch."
}
