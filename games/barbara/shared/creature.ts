import { nextRandom, treesNear, type Tree, type WoodsWorld } from "./world"
import type { DistantState } from "./distant"

/**
 * The thing in the woods: now and then something tall and too thin sprints across in front of a distant light, a black
 * cut-out against the lit mist for under a second, then it's behind the trunks. Kit: "a fast shadowy thing", "has to be
 * distant and brief".
 *
 * Part of the distant-events schedule (`DistantState.creature`, its own seeded stream so the sounds' schedule is
 * unchanged), stepped by `stepWoods` and broadcast as a `CreatureEvent`, so everyone in a room sees it at the same
 * moment. Only + − × ÷ √ and `nextRandom`, so any machine that steps the sim places it the same.
 *
 * It only comes when it has something bright to cross, because a black figure reads only where it covers light: a person
 * looking towards a friend's signal, a friend's beam aimed back at them, a burning road flare (`Beacon`), or a lit camp
 * window or porch seen from outside camp, 49 m or more away with a clear line of sight. A beam aimed across the view doesn't count: at 45–80 m its lit mist
 * is too faint for the figure to read (scripts/creature-visibility.ts measures it from the rendered frames). If nobody
 * has such a light, nothing comes. It crosses in front of that light 45–80 m from them, never within 35 m of anyone,
 * starting and ending where a trunk hides it if it can.
 */

export type CreatureEvent = {
  kind: "creature"
  /** Sim time it starts running (s). */
  at: number
  /** Plan path start and end (m); the ground gives the height. */
  x0: number
  z0: number
  x1: number
  z1: number
  /** Seconds from start to end. */
  dur: number
  /** Gait and build variation (0..1). */
  seed: number
  seq: number
}

export type CreatureState = {
  rng: { seed: number }
  /** Not before this sim time (s). */
  next: number
  /** Next look for a light to cross while due (s). */
  tryAt: number
  seq: number
  /** Where it last crossed (the middle of its path) and when, so the woods can remember it (`far.taken`). */
  last?: { x: number; z: number; at: number }
}

/** The creature's knobs (in `FEEL`): off by default until Kit has seen it; a room runs the defaults. */
export type CreatureFeel = {
  creature: boolean
  /** How often (×): 1 is about once every five minutes when there is a light to cross. */
  creatureRate: number
  /** Distance band from the person who sees it (m). Never under `CREATURE_MIN`. */
  creatureNear: number
  creatureFar: number
  /** Running speed (m/s). */
  creatureSpeed: number
}

/** Nobody is ever this close to it (m). */
export const CREATURE_MIN = 35
/** Never in the first minutes of a night (s). */
export const CREATURE_FIRST = 240
/** Mean wait between sightings at rate 1 (s). */
export const CREATURE_INTERVAL = 300
/** The distant sounds stay out of its way this long after it starts (s). */
const CREATURE_QUIET = 6

export function createCreature(seed: number): CreatureState {
  const rng = { seed: (seed * 2246822519) | 0 }
  const next = CREATURE_FIRST + 120 * nextRandom(rng)
  return { rng, next, tryAt: next, seq: 0 }
}

export type Watcher = { x: number; z: number; yaw: number; pitch: number; light: boolean; bot: boolean; id: number; signal: number }
/** A bright thing seen from far off: its plan point and how much it is worth crossing. */
type Shaft = { x: number; z: number; owner: number; weight: number; kind: "signal" | "beam" | "lamp" | "flare"; /** A beam's plan direction. */ dir?: [number, number] }
/** A lit road flare (`shared/flares.ts` `flareSources`): its red glow in the mist is a backdrop from any side. */
export type Beacon = { x: number; z: number; by: number; held: boolean; level: number }

/** A beam backs a crossing only when it points at the watcher within about this (cos 35°), lens and glare behind it. */
const AIMED_BACK = 0.82

const sqrt = Math.sqrt

/** Whether a trunk stands between (ax, az) and (bx, bz), widened by `pad` (m). */
export function trunkBetween(world: WoodsWorld, ax: number, az: number, bx: number, bz: number, pad = 0.15, scratch: Tree[] = []): boolean {
  const dx = bx - ax, dz = bz - az
  const len = sqrt(dx * dx + dz * dz)
  if (len < 1e-3) return false
  const ux = dx / len, uz = dz / len
  for (let s = 2; s < len + 2; s += 4) {
    const cx = ax + ux * Math.min(s, len), cz = az + uz * Math.min(s, len)
    for (const t of treesNear(world, cx, cz, 3, scratch)) {
      const ox = t.x - ax, oz = t.z - az
      const along = ox * ux + oz * uz
      if (along < 0.6 || along > len - 0.6) continue
      const side = ox * -uz + oz * ux
      const r = t.radius + pad
      if (side * side < r * r) return true
    }
  }
  return false
}

function shafts(world: WoodsWorld, players: readonly Watcher[], signalHold: number, beacons: readonly Beacon[]): Shaft[] {
  const out: Shaft[] = []
  // A flare lights the mist round it like a signal does; one in someone's hand is theirs (they don't see it from 49 m).
  for (const b of beacons) if (b.level > 0.3) out.push({ x: b.x, z: b.z, owner: b.held ? b.by : -1, weight: 3 * Math.min(1, b.level), kind: "flare" })
  for (const p of players) {
    if (!p.light) continue
    if (p.signal > signalHold || p.pitch > 1.1) {
      // A signal: the beam stands straight up; its base glows a few metres over the hand.
      out.push({ x: p.x, z: p.z, owner: p.id, weight: 3, kind: "signal" })
    } else if (p.pitch > -0.35 && p.pitch < 0.35) {
      // A level beam: only worth it from in front (the lens and its glare), which planCreature checks per watcher.
      out.push({ x: p.x, z: p.z, owner: p.id, weight: 2, kind: "beam", dir: [-sinApprox(p.yaw), -cosApprox(p.yaw)] })
    }
  }
  for (const l of world.lamps) if (l.kind === "window" || l.kind === "porch") out.push({ x: l.x, z: l.z, owner: -1, weight: l.kind === "window" ? 1 : 0.6, kind: "lamp" })
  return out
}

/** Sine and cosine from + − × ÷ only (a fixed polynomial after range reduction), so every machine agrees. */
export function sinApprox(a: number): number {
  const TAU = 6.283185307179586, PI = 3.141592653589793
  let x = a - TAU * Math.floor((a + PI) / TAU)
  // x in [−π, π): fold to [−π/2, π/2].
  if (x > PI / 2) x = PI - x
  else if (x < -PI / 2) x = -PI - x
  const x2 = x * x
  return x * (1 - x2 / 6 * (1 - x2 / 20 * (1 - x2 / 42 * (1 - x2 / 72 * (1 - x2 / 110)))))
}
export const cosApprox = (a: number) => sinApprox(a + 1.5707963267948966)

export type CreaturePlan = Omit<CreatureEvent, "kind" | "seq" | "at"> & { watcher: number; shaft: { x: number; z: number }; cross: number }

/**
 * A crossing for now, or null if nobody is looking at a light it could cross. `rng` draws the choices; `relaxed` (the
 * Lab's Trigger now) widens the watcher's gaze to about 75°.
 */
export function planCreature(world: WoodsWorld, players: readonly Watcher[], feel: CreatureFeel, rng: { seed: number }, signalHold: number, relaxed = false, beacons: readonly Beacon[] = []): CreaturePlan | null {
  const people = players.filter((p) => !p.bot)
  if (!people.length) return null
  const near = Math.max(CREATURE_MIN + 5, feel.creatureNear), far = Math.max(near + 5, feel.creatureFar)
  const speed = Math.max(4, feel.creatureSpeed)
  const scratch: Tree[] = []
  const half = world.params.half - 4
  const options: { plan: CreaturePlan; weight: number }[] = []
  const lights = shafts(world, players, signalHold, beacons)
  for (const w of people) {
    const fx = -sinApprox(w.yaw), fz = -cosApprox(w.yaw)
    const cdx = w.x - world.camp.x, cdz = w.z - world.camp.z
    const outsideCamp = cdx * cdx + cdz * cdz > world.camp.radius * world.camp.radius
    for (const s of lights) {
      if (s.owner === w.id) continue
      if (s.kind === "lamp" && !outsideCamp) continue
      const dx = s.x - w.x, dz = s.z - w.z
      const dL = sqrt(dx * dx + dz * dz)
      if (dL < near + 4 || dL > 220) continue
      const ux = dx / dL, uz = dz / dL
      if (s.dir && -(s.dir[0] * ux + s.dir[1] * uz) < AIMED_BACK) continue
      // They're looking that way (within about 40°; Trigger now takes about 75°), and nothing stands between them and the light.
      if (ux * fx + uz * fz < (relaxed ? 0.26 : 0.76)) continue
      if (trunkBetween(world, w.x, w.z, s.x, s.z, 0.1, scratch)) continue
      // Where it crosses the line of sight: in front of the light, inside the band.
      const lo = near, hi = Math.min(far, dL - 4)
      if (hi < lo) continue
      // Nearer the near edge: the closer it runs to you against a farther light, the more of the shaft it cuts out.
      const r = nextRandom(rng)
      const cross = lo + (hi - lo) * r * r
      const cx = w.x + ux * cross, cz = w.z + uz * cross
      // Mostly across the line of sight, a little towards or away; left or right.
      const side = nextRandom(rng) < 0.5 ? -1 : 1
      const skew = (nextRandom(rng) - 0.5) * 0.9
      let px = -uz * side + ux * skew, pz = ux * side + uz * skew
      const pl = sqrt(px * px + pz * pz)
      px /= pl; pz /= pl
      const dur = 0.5 + 0.7 * nextRandom(rng)
      const length = speed * dur
      // The light falls a little past the middle of its run, so it's already moving fast when it crosses.
      const before = length * (0.4 + 0.2 * nextRandom(rng))
      const x0 = cx - px * before, z0 = cz - pz * before, x1 = x0 + px * length, z1 = z0 + pz * length
      if (Math.abs(x0) > half || Math.abs(z0) > half || Math.abs(x1) > half || Math.abs(z1) > half) continue
      // Never close to anyone, from any side.
      let tooClose = false
      for (const p of people) if (segmentDistance(p.x, p.z, x0, z0, x1, z1) < CREATURE_MIN) { tooClose = true; break }
      if (tooClose) continue
      if (insideLake(world, x0, z0) || insideLake(world, x1, z1) || insideLake(world, cx, cz)) continue
      // The crossing itself must be in sight, and its ends ideally behind trunks (out of nowhere, gone again).
      if (trunkBetween(world, w.x, w.z, cx, cz, 0.05, scratch)) continue
      const hidden = (trunkBetween(world, w.x, w.z, x0, z0, 0.2, scratch) ? 1 : 0) + (trunkBetween(world, w.x, w.z, x1, z1, 0.2, scratch) ? 1 : 0)
      const plan: CreaturePlan = { x0: cm(x0), z0: cm(z0), x1: cm(x1), z1: cm(z1), dur: Math.round(dur * 1000) / 1000, seed: Math.round(nextRandom(rng) * 1000) / 1000, watcher: w.id, shaft: { x: s.x, z: s.z }, cross }
      const cover = dL / cross
      options.push({ plan, weight: s.weight * (1 + hidden) * cover * cover })
    }
  }
  if (!options.length) return null
  let sum = 0
  for (const o of options) sum += o.weight
  let pick = nextRandom(rng) * sum
  for (const o of options) { pick -= o.weight; if (pick <= 0) return o.plan }
  return options[options.length - 1]!.plan
}

const cm = (v: number) => Math.round(v * 100) / 100

function insideLake(world: WoodsWorld, x: number, z: number): boolean {
  const L = world.lake
  const ex = (x - L.x) / L.rx, ez = (z - L.z) / L.rz
  return ex * ex + ez * ez < 1.05
}

export function segmentDistance(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az
  const l2 = dx * dx + dz * dz
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0
  t = Math.max(0, Math.min(1, t))
  const ox = ax + dx * t - px, oz = az + dz * t - pz
  return sqrt(ox * ox + oz * oz)
}

/**
 * Advances the creature's schedule to sim time `t` (once a tick, with every walker: bots carry beams too). Returns the
 * sighting that starts now, if any. Waits for a distant sound to finish and keeps the next one off it for a few seconds.
 */
export function stepCreature(ds: DistantState, world: WoodsWorld, players: readonly Watcher[], t: number, feel: CreatureFeel, signalHold: number, beacons: readonly Beacon[] = []): CreatureEvent | null {
  const cs = ds.creature
  if (!feel.creature || feel.creatureRate <= 0 || t < cs.next || t < cs.tryAt || t < ds.busyUntil) return null
  // Look for a light to cross about once a second while due.
  cs.tryAt = t + 1
  const plan = planCreature(world, players, feel, cs.rng, signalHold, false, beacons)
  if (!plan) return null
  return fire(ds, plan, t, feel)
}

/** The Lab's Trigger now: the same placement, now, with the watcher's gaze and the timing rules let off. */
export function triggerCreature(ds: DistantState, world: WoodsWorld, players: readonly Watcher[], t: number, feel: CreatureFeel, signalHold: number, beacons: readonly Beacon[] = []): CreatureEvent | null {
  const plan = planCreature(world, players, feel, ds.creature.rng, signalHold, false, beacons) ?? planCreature(world, players, feel, ds.creature.rng, signalHold, true, beacons)
  return plan ? fire(ds, plan, t, feel) : null
}

function fire(ds: DistantState, plan: CreaturePlan, t: number, feel: CreatureFeel): CreatureEvent {
  const cs = ds.creature
  cs.next = t + (CREATURE_INTERVAL * (0.6 + 0.8 * nextRandom(cs.rng))) / Math.max(feel.creatureRate, 0.05)
  cs.tryAt = cs.next
  ds.busyUntil = Math.max(ds.busyUntil, t + plan.dur + CREATURE_QUIET)
  cs.last = { x: Math.round(((plan.x0 + plan.x1) / 2) * 100) / 100, z: Math.round(((plan.z0 + plan.z1) / 2) * 100) / 100, at: Math.round(t * 1000) / 1000 }
  return { kind: "creature", at: Math.round(t * 1000) / 1000, x0: plan.x0, z0: plan.z0, x1: plan.x1, z1: plan.z1, dur: plan.dur, seed: plan.seed, seq: cs.seq++ }
}
