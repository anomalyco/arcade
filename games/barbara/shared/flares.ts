import { flareEnvelope } from "@arcade/kit/sim/flare-burn"
import { stepThrown, throwBody, type ThrownBody, type ThrownEnv } from "@arcade/kit/sim/thrown"
import { lakeDistance, standHeight, treesNear, type Tree, type WoodsWorld } from "./world"

/**
 * Road flares (1996 fusees) as plain data, stepped by `stepWoods`. Everyone carries one and the camp table has a couple
 * of spares. Holding the flare key scrapes the cap; it catches `FLARE_SCRAPE` later and flares up in the hand, and
 * letting go (no sooner than `FLARE_BEAT` after it caught) throws it. A tap does the whole thing. Held, it is a light
 * you carry.
 *
 * The throw is the room's: it leaves the hand at a launch the room rounds and sends (`Flare.launch`), and the flight
 * is `@arcade/kit/sim/thrown` (fixed 1/120 s substeps, + − × ÷ √), so every client flies the same arc from it and lands
 * it where the room did; the resting place is sent too, so a client that disagrees by a hair snaps to it. How bright
 * it is (`flareSources`) is a pure function of time (`@arcade/kit/sim/flare-burn`), so the creature (a lit flare is a
 * backdrop it crosses) and anything else in the sim can read it.
 */

/** Seconds of scraping before the cap catches (it lights at `Flare.lit`). */
export const FLARE_SCRAPE = 0.35
/** Seconds it burns in the hand after catching before letting go throws it. */
export const FLARE_BEAT = 0.55
/** Throw speed (m/s) and how far above the look it leaves (rad). */
export const FLARE_SPEED = 10.5
const FLARE_LIFT = 0.28
/** Spares on the camp table at the start of a night. */
export const FLARE_SPARES = 2
/** A room keeps at most this many flares; past it the oldest burnt-out one goes first. */
export const MAX_FLARES = 16
/** You pick a spare up within this of the table (m), with none in your pocket. */
export const FLARE_PICKUP = 1.9
/** Embers glow this long after the burn, and the smoke takes this long more to clear (s). */
const FLARE_AFTER = 14 + 9

export type Flare = {
  id: number
  /** Who struck it (player id). */
  by: number
  /** Seed of its sputter and spray. */
  seed: number
  /** Room time the cap caught (s): `flareEnvelope` age 0. */
  lit: number
  /** Room time it left the hand (s), −1 while held. */
  thrown: number
  /** Where it left the hand and how fast, rounded to mm and mm/s (what the room sends). */
  launch: [number, number, number, number, number, number] | null
  /** Its flight (null while held). */
  body: ThrownBody | null
}

export type FlareState = {
  list: Flare[]
  /** Spares left on the camp table. */
  spares: number
  next: number
  /** Bumped when a flare is struck, thrown, lands or goes, or a spare is taken, so a room re-sends them only then. */
  rev: number
}

export type FlareEvent =
  /** The cap is scraped now (`at`); it catches at `at + FLARE_SCRAPE`. */
  | { kind: "flare-struck"; by: number; flare: number; at: number }
  | { kind: "flare-thrown"; by: number; flare: number; at: number }
  | { kind: "flare-picked"; by: number; spares: number }

/** What a player needs for flares (a structural slice of `Player`). */
export type FlareHand = { id: number; x: number; z: number; vx: number; vz: number; yaw: number; pitch: number; flares: number; flareLatch: boolean }

export type FlareFeel = { /** Seconds a flare burns (a 1996 fusee: 10–30 min; the game's is shorter). */ flareBurn: number }

export const createFlares = (): FlareState => ({ list: [], spares: FLARE_SPARES, next: 1, rev: 0 })

const mm = (v: number) => Math.round(v * 1000) / 1000

/** Where the spares lie: the near corner of the camp's picnic table (the torch batteries lie along its middle), or the spawn. */
export function flareTable(world: WoodsWorld): { x: number; y: number; z: number } {
  const t = world.buildings.find((b) => b.kind === "table")
  if (!t) return { x: world.camp.spawn.x, y: standHeight(world, world.camp.spawn.x, world.camp.spawn.z), z: world.camp.spawn.z }
  return { x: t.rect[2] - 0.3, y: t.y + t.h, z: t.rect[1] + 0.25 }
}

/** The burning end of a flare in a player's right hand, held out and up a little (m). */
export function handFlare(world: WoodsWorld, p: { x: number; z: number; yaw: number }): [number, number, number] {
  const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw)
  const x = p.x + fx * 0.32 - fz * 0.26, z = p.z + fz * 0.32 + fx * 0.26
  return [x, standHeight(world, p.x, p.z) + 1.22, z]
}

/** The flare struck by `by` and still in their hand, if any. */
export const heldFlare = (s: FlareState, by: number) => s.list.find((f) => f.by === by && f.thrown < 0)

/**
 * One player's flare hand for a tick: strike on the key (one in the pocket, the key let go since the last throw), throw
 * when it's let go and the flare has flared up, and take a spare at the table. Bots carry one and never strike it.
 */
export function stepFlareHand(s: FlareState, world: WoodsWorld, p: FlareHand, key: boolean, t: number, events: { push(e: FlareEvent): unknown }): void {
  if (!key) p.flareLatch = false
  const held = heldFlare(s, p.id)
  if (!held) {
    if (key && !p.flareLatch && p.flares > 0) {
      p.flares--
      p.flareLatch = true
      const id = s.next++
      const f: Flare = { id, by: p.id, seed: (Math.imul(id, 2654435761) >>> 0) % 1000003, lit: mm(t + FLARE_SCRAPE), thrown: -1, launch: null, body: null }
      s.list.push(f)
      s.rev++
      events.push({ kind: "flare-struck", by: p.id, flare: f.id, at: mm(t) })
      trim(s)
    } else if (p.flares === 0 && s.spares > 0) {
      const tb = flareTable(world)
      const dx = p.x - tb.x, dz = p.z - tb.z
      if (dx * dx + dz * dz < FLARE_PICKUP * FLARE_PICKUP) {
        s.spares--
        p.flares = 1
        s.rev++
        events.push({ kind: "flare-picked", by: p.id, spares: s.spares })
      }
    }
    return
  }
  if (key || t < held.lit + FLARE_BEAT) return
  // Overhand, a little above where you look, carrying your walking speed.
  const pitch = Math.max(-0.25, Math.min(1.1, p.pitch + FLARE_LIFT))
  const c = Math.cos(pitch), fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw)
  const x = p.x + fx * 0.35 - fz * 0.2, z = p.z + fz * 0.35 + fx * 0.2
  held.launch = [mm(x), mm(standHeight(world, p.x, p.z) + 1.55), mm(z), mm(fx * c * FLARE_SPEED + p.vx), mm(Math.sin(pitch) * FLARE_SPEED), mm(fz * c * FLARE_SPEED + p.vz)]
  held.thrown = mm(t)
  held.body = launchBody(held)
  s.rev++
  events.push({ kind: "flare-thrown", by: p.id, flare: held.id, at: held.thrown })
}

/** A flare's flight from its launch. */
export function launchBody(f: Flare): ThrownBody | null {
  const l = f.launch
  return l ? throwBody(l[0], l[1], l[2], l[3], l[4], l[5], f.seed) : null
}

/** Flies a flare on for `seconds` (a client catching up with a throw it just heard of). */
export function flyFor(world: WoodsWorld, f: Flare, seconds: number): void {
  const env = flareEnv(world)
  for (let left = seconds; left > 1e-6 && f.body && !f.body.rest; left -= 0.2) stepThrown(f.body, Math.min(0.2, left), env)
}

/** Flies every thrown flare a tick; one coming to rest bumps `rev` (a room sends where it lies). Burnt-out ones go. */
export function stepFlareBodies(s: FlareState, world: WoodsWorld, t: number, dt: number, feel: FlareFeel, holders: ReadonlySet<number>): void {
  const env = flareEnv(world)
  for (const f of s.list) {
    if (!f.body || f.body.rest) continue
    stepThrown(f.body, dt, env)
    if (f.body.rest) {
      const b = f.body
      b.x = mm(b.x); b.y = mm(b.y); b.z = mm(b.z); b.spin = mm(b.spin)
      s.rev++
    }
  }
  const before = s.list.length
  // A held flare whose holder left drops where it is (gone with them).
  s.list = s.list.filter((f) => t < f.lit + feel.flareBurn + FLARE_AFTER && (f.thrown >= 0 || holders.has(f.by)))
  if (s.list.length !== before) s.rev++
}

function trim(s: FlareState) {
  while (s.list.length > MAX_FLARES) {
    const i = s.list.findIndex((f) => f.thrown >= 0)
    s.list.splice(i >= 0 ? i : 0, 1)
  }
}

const treeScratch: Tree[] = []
const envCache = new WeakMap<WoodsWorld, ThrownEnv>()

/**
 * The world as a flare meets it: the ground (a dock's deck, the lake's surface: a fusee floats and keeps burning),
 * trunks to the height they branch, rocks it can land on, and building walls with roofs.
 */
export function flareEnv(world: WoodsWorld): ThrownEnv {
  let env = envCache.get(world)
  if (env) return env
  const walls = world.buildings.filter((b) => b.kind !== "dock")
  env = {
    ground(x, z) {
      const g = standHeight(world, x, z)
      return lakeDistance(world.lake, x, z) < 1.2 ? Math.max(g, world.lake.level) : g
    },
    obstacles(x, z, reach, out) {
      let n = 0
      for (const t of treesNear(world, x, z, reach + 0.5, treeScratch)) { out.push(t.x, t.z, t.radius * 0.9, t.y + t.height * 0.6); n++ }
      for (const k of world.rocks) {
        const r = Math.max(k.w, k.d) * 0.42
        if (k.h < 0.2 || Math.abs(k.x - x) > reach + r || Math.abs(k.z - z) > reach + r) continue
        out.push(k.x, k.z, r, k.y + k.h)
        n++
      }
      return n
    },
    boxes(x, z, reach, out) {
      let n = 0
      for (const b of walls) {
        const [x0, z0, x1, z1] = b.rect
        if (x < x0 - reach || x > x1 + reach || z < z0 - reach || z > z1 + reach) continue
        out.push(x0, z0, x1, z1, b.y + b.h)
        n++
      }
      return n
    },
  }
  envCache.set(world, env)
  return env
}

/** A flare already burning on the ground at (x, z), struck `age` seconds ago, lying along `yaw` (automation, tests). */
export function layFlare(state: { t: number; flares: FlareState }, world: WoodsWorld, x: number, z: number, age = 20, yaw = 0.6): Flare {
  const s = state.flares, id = s.next++
  const y = flareEnv(world).ground(x, z) + 0.0125
  const f: Flare = { id, by: -1, seed: (Math.imul(id, 2654435761) >>> 0) % 1000003, lit: mm(state.t - age), thrown: mm(state.t), launch: [mm(x), mm(y), mm(z), mm(Math.cos(yaw) * 1e-3), 0, mm(Math.sin(yaw) * 1e-3)], body: null }
  f.body = launchBody(f)!
  Object.assign(f.body, { ax: Math.cos(yaw), az: Math.sin(yaw), vx: 0, vz: 0, rest: true })
  s.list.push(f)
  s.rev++
  trim(s)
  return f
}

/** A lit flare as a light source: where its flame is and how bright (×, 1 at a steady burn; ~2 at the flare-up). */
export type FlareSource = { id: number; by: number; held: boolean; x: number; y: number; z: number; level: number }

/**
 * Every lit flare as a light at room time `t` (no flicker: that's presentation). `players` places the held ones in
 * their holder's hand. For the creature's backdrops, a spider that keeps out of the light, anything in the sim.
 */
export function flareSources(s: FlareState, world: WoodsWorld, players: readonly { id: number; x: number; z: number; yaw: number }[], t: number, feel: FlareFeel, out: FlareSource[] = []): FlareSource[] {
  out.length = 0
  for (const f of s.list) {
    const level = flareEnvelope(t - f.lit, feel.flareBurn).level
    if (level <= 0) continue
    if (f.body) out.push({ id: f.id, by: f.by, held: false, x: f.body.x, y: f.body.y + 0.2, z: f.body.z, level })
    else {
      const p = players.find((q) => q.id === f.by)
      if (!p) continue
      const [x, y, z] = handFlare(world, p)
      out.push({ id: f.id, by: f.by, held: true, x, y, z, level })
    }
  }
  return out
}
