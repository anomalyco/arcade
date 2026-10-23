import { createCreatureMotion, stepCreatureMotion, unitDt, unitSurface, type CreatureMotion, type CreatureSurface } from "@arcade/kit/sim/creature-motion"
import { cosApprox, planCreature, segmentDistance, sinApprox, trunkBetween, type CreatureFeel, type Watcher } from "./creature"
import { groundHeight, isDeepWater, nextRandom, solidsNear, treesNear, type Tree, type WoodsWorld } from "./world"

/**
 * The spider (Kit's harvestman, `@arcade/kit/creature`): one stalker per night, authoritative in the room and stepped
 * locally solo, with its own seeded stream so nothing else's schedule moves. v1 has three modes and no chase, catch or
 * climbing:
 *
 * - **Shadow.** It keeps out of sight, 80–110 m from everyone. Darkness and being alone draw it in: someone on their
 *   own with their torch out (`Player.isolated`) has it come to 36–46 m, out of every beam, a trunk between them if it
 *   can find one, drumming the leaf litter now and then.
 * - **Beat.** Now and then, a slow distant walk across someone's view at 45–85 m, preferably in front of a friend's
 *   light or a lit window (the figure's own `planCreature`, so it's lit from behind), else at the far edge of their own
 *   beam. It starts out of sight, walks 14 m, and goes back into the shadow.
 * - **Flee.** A beam held on it within 38 m drives it off: it turns away from the light and walks fast until it's 70 m
 *   from everyone and out of every beam.
 *
 * The root is the kit's `CreatureMotion` (creature units, Froude scaled from `SPIDER_SIZE`); the legs are presentation
 * and run on each client from the root (`src/spider-view.ts`). The wire carries one row (`stalkerRow`).
 */

/** Metres per creature unit: body scale 3.5 × legs 2.5 (the Lab's harvestman defaults). */
export const SPIDER_SIZE = 8.75
/** Its body's half-width against trunks (m), and the body's height over the ground for sightlines (m). */
const BODY_RADIUS = 0.8
export const SPIDER_BODY_Y = 4.5
/** Never this close to a person (m). v1 has no catch. */
export const STALKER_MIN = 20
/** No beat in the first minutes of a night, then about one every `BEAT_EVERY` s. */
export const BEAT_FIRST = 270
const BEAT_EVERY = 260
/** A person on their own in the dark this long draws it in (s). */
const LONE = 12
/** A beam drives it off: within this range (m) and angle (cos 14°), held this long (s). */
const GLARE_RANGE = 38
const GLARE_COS = 0.97
const GLARE_HOLD = 0.6
/** Paces as a share of its full walk (1 ≈ 3.4 m/s at this size). */
const PACE = { shadow: 0.25, beat: 0.33, retreat: 0.75, flee: 1 } as const

export type StalkerMode = "shadow" | "beat" | "flee"
export const STALKER_MODES: readonly StalkerMode[] = ["shadow", "beat", "flee"]

export type StalkerState = {
  rng: { seed: number }
  motion: CreatureMotion
  mode: StalkerMode
  /** Where it's walking to (m) and how fast (share of a full walk). */
  tx: number
  tz: number
  pace: number
  /** When it picks somewhere new to wait (shadow) or gives up (beat, flee) (s). */
  until: number
  /** Seconds a beam has been on it, and since one last was. */
  glare: number
  dark: number
  /** When the next beat is due (s), and the next look for one while due. */
  nextBeat: number
  tryAt: number
  /** When it may drum again (s). */
  drumAt: number
  /** Bumped when it moves without walking (a beat starts out of sight), so clients re-stand its legs there. */
  jump: number
  /** Seconds it has been held up (wedged between trunks) while trying to walk. */
  stuck: number
  seq: number
}

/** It drums dry leaves with its palps: a soft rapid patter in the dark, heard by whoever is near. */
export type SpiderDrumEvent = { kind: "spider-drum"; at: number; x: number; z: number; seed: number; seq: number }
/** A beat starts (for voices and the Lab); the walk itself is in the snapshot row. */
export type SpiderBeatEvent = { kind: "spider-beat"; at: number; x0: number; z0: number; x1: number; z1: number; watcher: number; seq: number }
export type StalkerEvent = SpiderDrumEvent | SpiderBeatEvent

/** What it perceives of a walker. */
export type StalkerWalker = Watcher & { isolated: number }

/** The forest as its ground (metres): feet off trunks, rocks, buildings and deep water; the body off trunks only. */
export function spiderSurface(world: WoodsWorld): CreatureSurface {
  const scratch: Tree[] = []
  return {
    heightAt: (x, z) => groundHeight(world, x, z),
    walkable: (x, z) => {
      if (isDeepWater(world, x, z)) return false
      for (const t of treesNear(world, x, z, 0.2, scratch)) if (Math.hypot(t.x - x, t.z - z) < t.radius + 0.12) return false
      for (const r of solidsNear(world, x, z, 0.5)) if (x > r[0] && x < r[2] && z > r[1] && z < r[3]) return false
      return true
    },
    // Rocks and buildings sit under a body riding 4 m up; a body pushed off a trunk spends what it lost round the edge.
    constrain: (fx, fz, tx, tz) => {
      const step = Math.hypot(tx - fx, tz - fz)
      let x = tx, z = tz
      for (const t of treesNear(world, x, z, BODY_RADIUS + 0.2, scratch)) {
        const dx = x - t.x, dz = z - t.z, d = Math.hypot(dx, dz), min = t.radius + 0.12 + BODY_RADIUS
        if (d >= min || d < 1e-6) continue
        const nx = dx / d, nz = dz / d
        const ex = t.x + nx * min, ez = t.z + nz * min
        const side = (tx - fx) * -nz + (tz - fz) * nx >= 0 ? 1 : -1
        const lost = Math.max(0, step - Math.hypot(ex - fx, ez - fz))
        const sx = ex - nz * side * lost - t.x, sz = ez + nx * side * lost - t.z, sl = Math.hypot(sx, sz) || 1
        x = t.x + (sx / sl) * min
        z = t.z + (sz / sl) * min
      }
      return [x, z]
    },
  }
}

const surfaces = new WeakMap<WoodsWorld, CreatureSurface>()
/** The surface in creature units, cached per world. */
function ground(world: WoodsWorld): CreatureSurface {
  let g = surfaces.get(world)
  if (!g) surfaces.set(world, (g = unitSurface(spiderSurface(world), SPIDER_SIZE)))
  return g
}

/** A night's stalker, waiting well away from camp. */
export function createStalker(world: WoodsWorld, seed: number): StalkerState {
  const rng = { seed: (seed * 1597334677) | 0 }
  const a = nextRandom(rng) * 6.283185307179586
  const r = Math.min(world.params.half - 30, 150)
  const x = world.camp.x + sinApprox(a) * r, z = world.camp.z + cosApprox(a) * r
  const nextBeat = BEAT_FIRST + 90 * nextRandom(rng)
  return {
    rng, motion: createCreatureMotion(x / SPIDER_SIZE, z / SPIDER_SIZE, a), mode: "shadow", tx: x, tz: z, pace: PACE.shadow,
    until: 0, glare: 0, dark: 0, nextBeat, tryAt: nextBeat, drumAt: 60, jump: 0, stuck: 0, seq: 0,
  }
}

export const stalkerX = (s: StalkerState) => s.motion.x * SPIDER_SIZE
export const stalkerZ = (s: StalkerState) => s.motion.z * SPIDER_SIZE

type Eye = (w: StalkerWalker) => readonly [number, number, number]

/** Whether a walker's lit beam is on it (body or legs), in range, with no trunk between. */
function lit(world: WoodsWorld, w: StalkerWalker, eye: readonly [number, number, number], x: number, z: number, scratch: Tree[]): boolean {
  if (!w.light) return false
  const g = groundHeight(world, x, z)
  const cp = Math.cos(w.pitch)
  const fx = -Math.sin(w.yaw) * cp, fy = Math.sin(w.pitch), fz = -Math.cos(w.yaw) * cp
  for (const y of [g + SPIDER_BODY_Y, g + 2]) {
    const dx = x - eye[0], dy = y - eye[1], dz = z - eye[2], d = Math.hypot(dx, dy, dz)
    if (d > GLARE_RANGE || d < 1e-3) continue
    if ((dx * fx + dy * fy + dz * fz) / d < GLARE_COS) continue
    if (!trunkBetween(world, eye[0], eye[2], x, z, 0.05, scratch)) return true
  }
  return false
}

const nearestPerson = (people: readonly StalkerWalker[], x: number, z: number) => {
  let best = Infinity
  for (const p of people) best = Math.min(best, Math.hypot(p.x - x, p.z - z))
  return best
}

/** A spot at least `min` m from every person, inside the map, on the ground and out of the lake. */
function fair(world: WoodsWorld, people: readonly StalkerWalker[], x: number, z: number, min: number): boolean {
  const half = world.params.half - 20
  if (Math.abs(x) > half || Math.abs(z) > half || isDeepWater(world, x, z)) return false
  return nearestPerson(people, x, z) >= min
}

/**
 * Somewhere to wait: near someone alone in the dark, out of their beam and behind a trunk; else (or `far`) far from
 * everyone.
 */
function shadowSpot(s: StalkerState, world: WoodsWorld, walkers: readonly StalkerWalker[], people: readonly StalkerWalker[], eye: Eye, scratch: Tree[], far = false): boolean {
  const x = stalkerX(s), z = stalkerZ(s)
  const lone = far ? undefined : people.filter((p) => p.isolated > LONE && !p.light).sort((a, b) => b.isolated - a.isolated)[0]
  let best: [number, number] | null = null, bestScore = -Infinity
  for (let i = 0; i < 12; i++) {
    const a = nextRandom(s.rng) * 6.283185307179586
    const r = lone ? 36 + 10 * nextRandom(s.rng) : 80 + 30 * nextRandom(s.rng)
    const ox = lone ? lone.x : x, oz = lone ? lone.z : z
    let cx = ox + sinApprox(a) * r, cz = oz + cosApprox(a) * r
    if (!lone) {
      // Away from the nearest person: push the candidate out until it's in the band.
      const near = people.reduce<StalkerWalker | null>((b, p) => (!b || Math.hypot(p.x - cx, p.z - cz) < Math.hypot(b.x - cx, b.z - cz) ? p : b), null)
      if (near) {
        const dx = cx - near.x, dz = cz - near.z, d = Math.hypot(dx, dz) || 1
        if (d < 80) { cx = near.x + (dx / d) * (80 + 30 * nextRandom(s.rng)); cz = near.z + (dz / d) * (80 + 30 * nextRandom(s.rng)) }
      }
    }
    if (!fair(world, people, cx, cz, lone ? 34 : 75)) continue
    // Never a walk that passes near anyone (a jump out of sight goes anywhere).
    if (!far && people.some((p) => segmentDistance(p.x, p.z, x, z, cx, cz) < STALKER_MIN + 8)) continue
    if (walkers.some((w) => lit(world, w, eye(w), cx, cz, scratch))) continue
    let score = -Math.hypot(cx - x, cz - z) * 0.02
    if (lone && trunkBetween(world, lone.x, lone.z, cx, cz, 0.2, scratch)) score += 2
    if (score > bestScore) { bestScore = score; best = [cx, cz] }
  }
  if (best) { s.tx = best[0]; s.tz = best[1] }
  s.pace = PACE.shadow
  return !!best
}

/**
 * Cornered in the dark (someone ran it down against the lake or the edge of the map): it's gone, and somewhere far off
 * out of sight. Never while a beam is on it: nobody sees it go.
 */
function vanish(s: StalkerState, world: WoodsWorld, walkers: readonly StalkerWalker[], people: readonly StalkerWalker[], eye: Eye, scratch: Tree[]): void {
  if (!shadowSpot(s, world, walkers, people, eye, scratch, true)) return
  const m = s.motion
  m.x = s.tx / SPIDER_SIZE; m.z = s.tz / SPIDER_SIZE
  m.vx = m.vz = 0; m.angularVelocity = 0; m.turn = "travel"
  s.jump++
  s.mode = "shadow"
  s.until = 0
}

/** Someone walked up on it: straight away from whoever is near, turning aside from the lake or the edge of the map. */
function retreat(s: StalkerState, world: WoodsWorld, people: readonly StalkerWalker[]): void {
  const x = stalkerX(s), z = stalkerZ(s)
  let ax = 0, az = 0
  for (const p of people) {
    const dx = x - p.x, dz = z - p.z, d = Math.hypot(dx, dz) || 1
    if (d < 50) { ax += dx / (d * d); az += dz / (d * d) }
  }
  const base = Math.atan2(ax, az)
  for (const turn of [0, 0.5, -0.5, 1, -1, 1.5, -1.5]) {
    const a = base + turn, tx = x + sinApprox(a) * 60, tz = z + cosApprox(a) * 60
    if (!fair(world, people, tx, tz, 45) || people.some((p) => segmentDistance(p.x, p.z, x, z, tx, tz) < STALKER_MIN)) continue
    s.tx = tx; s.tz = tz
    return
  }
}

/** A distant walk across someone's view: in front of a light if one is out there, else at the far edge of their beam. */
function planBeat(s: StalkerState, world: WoodsWorld, walkers: readonly StalkerWalker[], feel: CreatureFeel, signalHold: number, scratch: Tree[]): SpiderBeatEvent | null {
  const people = walkers.filter((w) => !w.bot)
  const plan = planCreature(world, walkers, { ...feel, creatureNear: 45, creatureFar: 85, creatureSpeed: 4 }, s.rng, signalHold)
  let cx: number, cz: number, px: number, pz: number, watcher: number
  if (plan) {
    cx = (plan.x0 + plan.x1) / 2; cz = (plan.z0 + plan.z1) / 2
    const l = Math.hypot(plan.x1 - plan.x0, plan.z1 - plan.z0) || 1
    px = (plan.x1 - plan.x0) / l; pz = (plan.z1 - plan.z0) / l
    watcher = plan.watcher
  } else {
    // Someone with their torch up and level: it crosses where their beam fades, so its legs catch the last of it.
    const lit = people.filter((p) => p.light && p.pitch > -0.35 && p.pitch < 0.35)
    if (!lit.length) return null
    const w = lit[Math.floor(nextRandom(s.rng) * lit.length) % lit.length]!
    const fx = -sinApprox(w.yaw), fz = -cosApprox(w.yaw)
    const d = 40 + 6 * nextRandom(s.rng)
    cx = w.x + fx * d; cz = w.z + fz * d
    const side = nextRandom(s.rng) < 0.5 ? -1 : 1
    px = -fz * side; pz = fx * side
    watcher = w.id
    if (trunkBetween(world, w.x, w.z, cx, cz, 0.05, scratch)) return null
  }
  const x0 = cx - px * 6, z0 = cz - pz * 6, x1 = cx + px * 8, z1 = cz + pz * 8
  for (const p of people) if (segmentDistance(p.x, p.z, x0, z0, x1, z1) < 36) return null
  if (!fair(world, people, x0, z0, 36) || !fair(world, people, x1, z1, 36)) return null
  // It appears where nobody is looking or a trunk hides it.
  for (const p of people) {
    const dx = x0 - p.x, dz = z0 - p.z, d = Math.hypot(dx, dz)
    const looking = (dx * -sinApprox(p.yaw) + dz * -cosApprox(p.yaw)) / d > 0.5
    if (looking && p.light && d < GLARE_RANGE + 10 && !trunkBetween(world, p.x, p.z, x0, z0, 0.2, scratch)) return null
  }
  const r = (v: number) => Math.round(v * 100) / 100
  return { kind: "spider-beat", at: 0, x0: r(x0), z0: r(z0), x1: r(x1), z1: r(z1), watcher, seq: 0 }
}

function startBeat(s: StalkerState, beat: SpiderBeatEvent, t: number): SpiderBeatEvent {
  const m = s.motion
  m.x = beat.x0 / SPIDER_SIZE; m.z = beat.z0 / SPIDER_SIZE
  m.vx = m.vz = 0; m.angularVelocity = 0; m.turn = "travel"
  m.heading = Math.atan2(-(beat.z1 - beat.z0), beat.x1 - beat.x0)
  s.jump++
  s.mode = "beat"
  s.tx = beat.x1; s.tz = beat.z1; s.pace = PACE.beat
  s.until = t + 30
  s.nextBeat = t + BEAT_EVERY * (0.7 + 0.6 * nextRandom(s.rng))
  s.tryAt = s.nextBeat
  return { ...beat, at: Math.round(t * 1000) / 1000, seq: s.seq++ }
}

/** The Lab's and automation's walk across now: a beat along (x0, z0) → (x1, z1), starting at once wherever that is. */
export function beatNow(s: StalkerState, x0: number, z0: number, x1: number, z1: number, watcher: number, t: number): SpiderBeatEvent {
  const r = (v: number) => Math.round(v * 100) / 100
  return startBeat(s, { kind: "spider-beat", at: 0, x0: r(x0), z0: r(z0), x1: r(x1), z1: r(z1), watcher, seq: 0 }, t)
}

/** A drum where it stands now (the Lab's and automation's). */
export function drumNow(s: StalkerState, t: number): SpiderDrumEvent {
  return { kind: "spider-drum", at: Math.round(t * 1000) / 1000, x: Math.round(stalkerX(s) * 100) / 100, z: Math.round(stalkerZ(s) * 100) / 100, seed: Math.round(nextRandom(s.rng) * 1000) / 1000, seq: s.seq++ }
}

function flee(s: StalkerState, world: WoodsWorld, walkers: readonly StalkerWalker[], t: number): void {
  const x = stalkerX(s), z = stalkerZ(s)
  // Away from every lit walker in range, weighted by closeness.
  let ax = 0, az = 0
  for (const w of walkers) {
    if (!w.light) continue
    const dx = x - w.x, dz = z - w.z, d = Math.hypot(dx, dz) || 1
    if (d > GLARE_RANGE + 20) continue
    ax += dx / (d * d); az += dz / (d * d)
  }
  const l = Math.hypot(ax, az)
  const ux = l > 0 ? ax / l : Math.cos(s.motion.heading), uz = l > 0 ? az / l : -Math.sin(s.motion.heading)
  const half = world.params.half - 20
  s.tx = Math.max(-half, Math.min(half, x + ux * 90))
  s.tz = Math.max(-half, Math.min(half, z + uz * 90))
  s.mode = "flee"; s.pace = PACE.flee; s.until = t + 30; s.dark = 0
}

/**
 * One tick (`dt` s at sim time `t`). `walkers` are everyone (bots carry beams too); `eye` gives a walker's eye
 * position. Returns what it did that others hear or react to.
 */
export function stepStalker(s: StalkerState, world: WoodsWorld, walkers: readonly StalkerWalker[], t: number, dt: number, feel: CreatureFeel, signalHold: number, eye: Eye): StalkerEvent[] {
  const out: StalkerEvent[] = []
  if (!(dt > 0)) return out
  const scratch: Tree[] = []
  const people = walkers.filter((w) => !w.bot)
  const x = stalkerX(s), z = stalkerZ(s)
  const on = walkers.some((w) => lit(world, w, eye(w), x, z, scratch))
  s.glare = on ? s.glare + dt : Math.max(0, s.glare - dt * 0.5)
  s.dark = on ? 0 : s.dark + dt
  const nearest = nearestPerson(people, x, z)
  const reached = Math.hypot(s.tx - x, s.tz - z) < 3

  if (s.mode !== "flee" && s.glare > GLARE_HOLD) flee(s, world, walkers, t)
  else if (s.mode === "flee") {
    if ((nearest > 70 && s.dark > 3) || t > s.until) { s.mode = "shadow"; s.until = 0 }
    else if (reached) flee(s, world, walkers, t)
  } else if (s.mode === "beat") {
    if (reached || t > s.until || nearest < STALKER_MIN + 12) { s.mode = "shadow"; s.until = 0 }
  }
  if (s.mode === "shadow") {
    if (t >= s.nextBeat && t >= s.tryAt && people.length) {
      s.tryAt = t + 1
      const beat = planBeat(s, world, walkers, feel, signalHold, scratch)
      if (beat) out.push(startBeat(s, beat, t))
    }
  }
  if (s.mode === "shadow") {
    // Someone walked up on it: back off, quicker, straight away from them; run down in the dark, it's gone.
    const crowded = nearest < STALKER_MIN + 12
    if (nearest < STALKER_MIN + 2 && !on) vanish(s, world, walkers, people, eye, scratch)
    else if (crowded) { retreat(s, world, people); s.until = t + 4 }
    else if (t >= s.until || reached) { shadowSpot(s, world, walkers, people, eye, scratch); s.until = t + 20 + 20 * nextRandom(s.rng) }
    s.pace = crowded ? PACE.retreat : PACE.shadow
    // Drumming, now and then, for whoever is near enough to hear it.
    if (t >= s.drumAt && nearest > 22 && nearest < 60) {
      out.push(drumNow(s, t))
      s.drumAt = t + 25 + 25 * nextRandom(s.rng)
    }
  }

  const dx = s.tx - x, dz = s.tz - z, d = Math.hypot(dx, dz)
  const share = d < 2 ? 0 : s.pace * Math.min(1, d / 6)
  let ux = d > 0 ? dx / d : 0, uz = d > 0 ? dz / d : 0
  // Steer round trunks ahead the body won't pass (between two close ones it would wedge).
  if (share > 0) {
    let sx = ux, sz = uz
    for (const tr of treesNear(world, x + ux * 3, z + uz * 3, 4, scratch)) {
      const rx = tr.x - x, rz = tr.z - z, ahead = rx * ux + rz * uz
      if (ahead <= 0 || ahead > 6) continue
      const lat = rx * -uz + rz * ux, clear = tr.radius + 0.12 + BODY_RADIUS + 0.5
      if (Math.abs(lat) > clear) continue
      const k = 1.6 * (1 - Math.abs(lat) / clear) * (1 - ahead / 6), away = lat >= 0 ? -1 : 1
      sx += -uz * away * k; sz += ux * away * k
    }
    const sl = Math.hypot(sx, sz) || 1
    ux = sx / sl; uz = sz / sl
  }
  stepCreatureMotion(s.motion, { dx: ux * share, dz: uz * share, pace: "walk" }, unitDt(dt, SPIDER_SIZE), ground(world))
  // Held up anyway: give up on this spot (a beat ends; elsewhere it picks somewhere new).
  const moved = Math.hypot(stalkerX(s) - x, stalkerZ(s) - z) / dt
  s.stuck = share > 0 && moved < share * 0.8 ? s.stuck + dt : 0
  if (s.stuck > 2.5) {
    s.stuck = 0
    if (s.mode === "beat") s.mode = "shadow"
    s.until = 0
    if (s.mode === "shadow") shadowSpot(s, world, walkers, people, eye, scratch)
    else flee(s, world, walkers, t)
  }
  return out
}

/** The wire row: x, z (cm), heading (mrad), mode, jump counter. */
export const stalkerRow = (s: StalkerState): number[] => [Math.round(stalkerX(s) * 100), Math.round(stalkerZ(s) * 100), Math.round(s.motion.heading * 1000), STALKER_MODES.indexOf(s.mode), s.jump]

/** What a client draws from: the root's place, heading and mode. */
export type StalkerPose = { x: number; z: number; heading: number; mode: StalkerMode; jump: number }
export const stalkerPose = (s: StalkerState): StalkerPose => ({ x: stalkerX(s), z: stalkerZ(s), heading: s.motion.heading, mode: s.mode, jump: s.jump })
export const poseFromRow = (r: readonly number[]): StalkerPose => ({ x: r[0]! / 100, z: r[1]! / 100, heading: r[2]! / 1000, mode: STALKER_MODES[r[3]!] ?? "shadow", jump: r[4]! })

