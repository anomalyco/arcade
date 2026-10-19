import { inRect, type Rect } from "@arcade/kit/sim/geom"
import { samplePointLightLevel, STARTING_SAFEHOUSE_RECT, zombieTraitsFromSeed, type AIAgent } from "../ai"
import type { ZombieHit, ZombieHitOutcome } from "../combat"
import { dayCycle } from "../day-cycle"
import { flashlightAwarenessAt, type FlashlightTuning } from "../flashlight"
import { inBuildingFootprint, sightRects } from "../map"
import type { OutbreakSim } from "../sim-types"
import {
  DEFAULT_SPECIALS_TUNING,
  encodeSpecialSeed,
  hitFromFront,
  mix32,
  ordinarySeed,
  pickSpecialKind,
  specialAllowed,
  specialChance,
  specialKindOf,
  specialRolls,
  specialWeight,
  SPECIAL_BLOATER,
  SPECIAL_BRUTE,
  SPECIAL_LURKER,
  SPECIAL_NONE,
  SPECIAL_RIOT,
  SPECIAL_RUNNER,
  SPECIAL_SCREAMER,
  type SpecialKind,
  type SpecialPhase,
  type SpecialsTuning,
} from "./kinds"

/**
 * Special zombies in the simulation: which zombies become special as they appear, and what each kind does. Every
 * zombie is rolled once, the tick it appears (`classifySpecials`, run before and after the crowd steps so director
 * spawns are rolled before the snapshot that first carries them). All state is plain JSON in the feature state.
 */

/** What the sim remembers about one living special. */
export type SpecialRuntime = {
  kind: SpecialKind
  /** The seed it was made with; an agent with this id and another seed is a different zombie. */
  seed: number
  /** Its own speed and perception before its kind changed them. */
  baseSpeed: number
  basePerception: number
  /** Lurker: still asleep. */
  dormant: boolean
  /** Screamer: when the shriek in progress lands (0 when not shrieking), and when it may shriek again. */
  shriekUntil: number
  shriekReadyAt: number
  /** Bloater: its gas has been released. */
  burst: boolean
}

export type GasCloud = { id: number; x: number; y: number; born: number; until: number; radius: number }

export type SpecialsState = {
  /** Seed each zombie id was rolled with. */
  seen: Record<number, number>
  live: Record<number, SpecialRuntime>
  clouds: GasCloud[]
  nextCloud: number
  /** Nights begun so far (1 during the first night), and whether it was dark last tick. */
  night: number
  wasDark: boolean
  /** Tuning as of the last step, for the hit rule. */
  tuning: SpecialsTuning
  /** Shrieks that landed and clouds released (harness and tests). */
  shrieks: number
  bursts: number
  lastPrune: number
}

export function createSpecialsState(hour = 17.5): SpecialsState {
  const dark = dayCycle(hour).darkness >= 0.5
  return {
    seen: {},
    live: {},
    clouds: [],
    nextCloud: 1,
    night: dark ? 1 : 0,
    wasDark: dark,
    tuning: DEFAULT_SPECIALS_TUNING,
    shrieks: 0,
    bursts: 0,
    lastPrune: 0,
  }
}

export function specialsOf(sim: OutbreakSim): SpecialsState {
  let st = sim.getFeatureState<SpecialsState>("specials")
  if (!st) {
    st = createSpecialsState(sim.hour)
    sim.featureStates.set("specials", st)
  }
  return st
}

export function specialPhase(sim: OutbreakSim, st: SpecialsState): SpecialPhase {
  return { darkness: dayCycle(sim.hour).darkness, night: st.night }
}

function trackNights(sim: OutbreakSim, st: SpecialsState): void {
  const dark = dayCycle(sim.hour).darkness >= 0.5
  if (dark && !st.wasDark) st.night++
  st.wasDark = dark
}

/** Police stations and cruisers: where riot cops come from. */
function nearPolice(sim: OutbreakSim, x: number, y: number, radius: number): boolean {
  const r2 = radius * radius
  for (const b of sim.town.buildings) {
    if (b.archetype !== "police") continue
    const cx = Math.max(b.rect[0], Math.min(b.rect[2], x))
    const cy = Math.max(b.rect[1], Math.min(b.rect[3], y))
    if ((cx - x) ** 2 + (cy - y) ** 2 <= r2) return true
  }
  for (const v of sim.vehicles.list) {
    if (v.kind === "cruiser" && (v.x - x) ** 2 + (v.y - y) ** 2 <= r2) return true
  }
  return false
}

function nearestSurvivorDist(sim: OutbreakSim, x: number, y: number): number {
  let best = Infinity
  for (const s of sim.slots) best = Math.min(best, Math.hypot(s.survivor.x - x, s.survivor.y - y))
  return best
}

/**
 * An unlit spot inside a building near `(x, y)`, out of every survivor's reach, for a Lurker to wait in; `null` when
 * there is none. Never the starting safehouse.
 */
export function darkRoomSpot(sim: OutbreakSim, x: number, y: number, t: SpecialsTuning, salt: number): { x: number; y: number } | null {
  const near = sim.town.buildings
    .map((b) => {
      const cx = Math.max(b.rect[0], Math.min(b.rect[2], x))
      const cy = Math.max(b.rect[1], Math.min(b.rect[3], y))
      return { b, d: Math.hypot(cx - x, cy - y) }
    })
    .filter((e) => e.d <= 40)
    .sort((a, b) => a.d - b.d || (a.b.id < b.b.id ? -1 : 1))
    .slice(0, 4)
  let h = salt >>> 0
  for (const { b } of near) {
    const [x0, y0, x1, y1] = b.rect
    for (let k = 0; k < 12; k++) {
      h = mix32((h + 0x9e3779b9) >>> 0)
      const px = x0 + 0.8 + ((h & 0xffff) / 65536) * Math.max(0, x1 - x0 - 1.6)
      const py = y0 + 0.8 + ((h >>> 16) / 65536) * Math.max(0, y1 - y0 - 1.6)
      if (!inBuildingFootprint(b, px, py) || inRect(px, py, STARTING_SAFEHOUSE_RECT)) continue
      if (!sim.ai.nav.walkable({ x: px, y: py })) continue
      if (nearestSurvivorDist(sim, px, py) < 10) continue
      if (samplePointLightLevel(sim.town, sim.hour, px, py) >= t.lurkerDark) continue
      return { x: px, y: py }
    }
  }
  return null
}

function setSeed(a: AIAgent, seed: number): void {
  a.seed = seed >>> 0
  const traits = zombieTraitsFromSeed(a.seed)
  a.hitReaction = traits.hitReaction
  a.deathVariant = traits.deathVariant
  a.toughness = traits.toughness
}

function kindHp(t: SpecialsTuning, kind: SpecialKind): number {
  switch (kind) {
    case SPECIAL_RUNNER:
      return t.runnerHp
    case SPECIAL_BRUTE:
      return t.bruteHp
    case SPECIAL_SCREAMER:
      return t.screamerHp
    case SPECIAL_BLOATER:
      return t.bloaterHp
    case SPECIAL_RIOT:
      return t.riotHp
    case SPECIAL_LURKER:
      return t.lurkerHp
    default:
      return 100
  }
}

function kindSpeed(t: SpecialsTuning, kind: SpecialKind): number {
  switch (kind) {
    case SPECIAL_BRUTE:
      return t.bruteSpeed
    case SPECIAL_BLOATER:
      return t.bloaterSpeed
    case SPECIAL_SCREAMER:
      return 0.9
    case SPECIAL_RIOT:
      return 0.9
    default:
      return 1
  }
}

/** Turns `a` into a special of `kind` (its seed carries the kind from now on) and starts tracking it. */
export function makeSpecial(st: SpecialsState, a: AIAgent, kind: Exclude<SpecialKind, 0>, t: SpecialsTuning): SpecialRuntime {
  setSeed(a, encodeSpecialSeed(a.seed, kind))
  a.toughness = 1
  a.hp = a.maxHp = kindHp(t, kind)
  const rt: SpecialRuntime = {
    kind,
    seed: a.seed,
    baseSpeed: a.speedScale,
    basePerception: a.perceptionScale,
    dormant: kind === SPECIAL_LURKER,
    shriekUntil: 0,
    shriekReadyAt: 0,
    burst: false,
  }
  a.speedScale = rt.baseSpeed * kindSpeed(t, kind)
  if (kind === SPECIAL_SCREAMER) a.perceptionScale = rt.basePerception * 1.3
  if (kind === SPECIAL_RUNNER) a.perceptionScale = rt.basePerception * 1.15
  if (kind === SPECIAL_BRUTE) a.aggression *= 1.15
  if (kind === SPECIAL_LURKER) {
    a.state = "wander"
    a.awareness = 0
    a.speedScale = 0
    a.perceptionScale = 0
  }
  st.live[a.id] = rt
  st.seen[a.id] = a.seed
  return rt
}

/** Rolls one zombie that has just appeared: special or not, and which kind. */
function classify(sim: OutbreakSim, st: SpecialsState, a: AIAgent, t: SpecialsTuning, phase: SpecialPhase, chance: number): void {
  const own = st.live[a.id]
  if (own && own.seed === a.seed) {
    st.seen[a.id] = a.seed
    return
  }
  if (own) delete st.live[a.id]
  const [u, v] = specialRolls(sim.town.seed, a.id, a.seed)
  let kind: SpecialKind = SPECIAL_NONE
  if (a.state !== "dead" && a.state !== "crawler" && u < chance) {
    const weights = [0, 0, 0, 0, 0, 0]
    for (let k = SPECIAL_RUNNER; k <= SPECIAL_LURKER; k++) {
      if (!specialAllowed(k as SpecialKind, phase)) continue
      let w = specialWeight(t, k as SpecialKind)
      if (k === SPECIAL_RIOT && !nearPolice(sim, a.x, a.y, t.riotPoliceRadius)) w *= t.riotStray
      weights[k - 1] = w
    }
    kind = pickSpecialKind(weights, v)
    if (kind === SPECIAL_LURKER) {
      const spot = darkRoomSpot(sim, a.x, a.y, t, a.seed ^ a.id)
      if (spot) {
        a.x = a.homeX = a.wanderX = spot.x
        a.y = a.homeY = a.wanderY = spot.y
        a.vx = a.vy = 0
        a.path = []
        a.hordeId = undefined
      } else {
        weights[SPECIAL_LURKER - 1] = 0
        kind = pickSpecialKind(weights, v)
      }
    }
  }
  if (kind !== SPECIAL_NONE) makeSpecial(st, a, kind, t)
  else {
    if (specialKindOf(a.seed) !== SPECIAL_NONE) setSeed(a, ordinarySeed(a.seed))
    st.seen[a.id] = a.seed
  }
}

/** Rolls every zombie not yet rolled. */
export function classifySpecials(sim: OutbreakSim, st: SpecialsState, t: SpecialsTuning): void {
  const phase = specialPhase(sim, st)
  const chance = specialChance(t, phase)
  for (const a of sim.ai.agents) {
    if (st.seen[a.id] !== a.seed) classify(sim, st, a, t, phase, chance)
  }
}

function prune(sim: OutbreakSim, st: SpecialsState): void {
  const ids = new Set<number>()
  for (const a of sim.ai.agents) ids.add(a.id)
  for (const k of Object.keys(st.seen)) if (!ids.has(Number(k))) delete st.seen[Number(k)]
  for (const k of Object.keys(st.live)) if (!ids.has(Number(k))) delete st.live[Number(k)]
}

function wakeLurker(a: AIAgent, rt: SpecialRuntime, t: SpecialsTuning, x: number, y: number): void {
  rt.dormant = false
  a.speedScale = rt.baseSpeed * t.lurkerSpeed
  a.perceptionScale = rt.basePerception * 1.2
  a.aggression *= 1.25
  a.awareness = 1
  a.targetX = x
  a.targetY = y
  a.targetKind = "sight"
  if (a.state === "wander" || a.state === "investigate" || a.state === "search") {
    a.state = "alert"
    a.stateTime = 0
    a.timer = 0.22
  }
}

/** The survivor whose light or nearness wakes a sleeping Lurker at `a`, if any. */
function lurkerWaker(
  sim: OutbreakSim,
  a: AIAgent,
  t: SpecialsTuning,
  blockers: readonly Rect[],
  flashlight: FlashlightTuning,
): { x: number; y: number } | null {
  for (const s of sim.slots) {
    const p = s.survivor
    if (Math.hypot(p.x - a.x, p.y - a.y) <= t.lurkerWakeNear) return p
    if (flashlightAwarenessAt(p, a.x, a.y, blockers, flashlight) > 0.05) return p
  }
  return null
}

function inCloud(c: GasCloud, x: number, y: number): boolean {
  return (x - c.x) ** 2 + (y - c.y) ** 2 <= c.radius * c.radius
}

function release(sim: OutbreakSim, st: SpecialsState, a: AIAgent, rt: SpecialRuntime, t: SpecialsTuning): void {
  rt.burst = true
  st.bursts++
  st.clouds.push({ id: st.nextCloud++, x: a.x, y: a.y, born: sim.time, until: sim.time + t.gasTime, radius: t.gasRadius })
  sim.ai.emitNoise(a.x, a.y, 9, "bloater", sim.time, `bloater-${a.id}`, 0.8)
}

/** Before the crowd steps: night count, rolls, Runners' sprint, Brutes' bashing, Lurkers waking, gas. */
export function stepSpecials(sim: OutbreakSim, st: SpecialsState, t: SpecialsTuning, dt: number, flashlight: FlashlightTuning): void {
  st.tuning = t
  trackNights(sim, st)
  if (sim.time - st.lastPrune > 2) {
    st.lastPrune = sim.time
    prune(sim, st)
  }
  classifySpecials(sim, st, t)
  const dark = dayCycle(sim.hour).darkness >= 0.5
  const aggr = sim.ai.config.aggression
  let blockers: Rect[] | null = null
  for (const a of sim.ai.agents) {
    const rt = st.live[a.id]
    if (!rt || rt.seed !== a.seed) continue
    switch (rt.kind) {
      case SPECIAL_RUNNER: {
        const hunting = a.state === "chase" || a.state === "alert"
        a.speedScale = rt.baseSpeed * (hunting && dark ? t.runnerSprint : t.runnerDaySpeed)
        break
      }
      case SPECIAL_BRUTE:
        if (a.state === "bash") a.timer -= dt * a.aggression * aggr * Math.max(0, t.bruteBash - 1)
        break
      case SPECIAL_SCREAMER:
        if (rt.shriekUntil > 0) {
          if (a.state !== "alert") {
            // Staggered, knocked down or killed mid-shriek: it never lands, and it needs a moment to try again.
            rt.shriekUntil = 0
            rt.shriekReadyAt = sim.time + 2.5
          } else if (sim.time >= rt.shriekUntil) {
            rt.shriekUntil = 0
            rt.shriekReadyAt = sim.time + t.shriekCooldown
            st.shrieks++
            sim.ai.emitNoise(a.x, a.y, t.shriekRadius, "shriek", sim.time, `shriek-${a.id}`, 2.4)
            a.timer = 0
          } else {
            a.timer = Math.max(a.timer, rt.shriekUntil - sim.time + dt)
          }
        }
        break
      case SPECIAL_BLOATER:
        if (a.state === "dead" && !rt.burst) release(sim, st, a, rt, t)
        break
      case SPECIAL_LURKER:
        if (rt.dormant) {
          blockers ??= sightRects(sim.town)
          const by = a.state === "wander" ? lurkerWaker(sim, a, t, blockers, flashlight) : { x: a.targetX, y: a.targetY }
          if (by) wakeLurker(a, rt, t, by.x, by.y)
          else {
            a.speedScale = 0
            a.perceptionScale = 0
            a.awareness = 0
            a.vx = a.vy = 0
          }
        }
        break
    }
  }
  stepGas(sim, st, t, dt)
}

function stepGas(sim: OutbreakSim, st: SpecialsState, t: SpecialsTuning, dt: number): void {
  if (st.clouds.length === 0) return
  st.clouds = st.clouds.filter((c) => c.until > sim.time)
  for (const c of st.clouds) {
    for (const s of sim.slots) {
      const p = s.survivor
      if (p.vehicleId || !inCloud(c, p.x, p.y)) continue
      p.health = Math.max(0, p.health - t.gasDamage * dt)
      p.stamina = Math.max(0, p.stamina - t.gasStamina * dt)
      p.regenCooldown = Math.max(p.regenCooldown, 0.5)
    }
    for (const a of sim.ai.agents) {
      if (a.state === "dead" || !inCloud(c, a.x, a.y)) continue
      a.hp = Math.max(0, a.hp - t.gasZombieDamage * dt)
      if (a.hp <= 0) {
        a.state = "dead"
        a.stateTime = 0
        a.lastHitBy = "gas"
      }
    }
  }
}

/** After the crowd steps: roll director spawns, start shrieks, keep gas slowing zombies, burst bloaters. */
export function stepSpecialsLate(sim: OutbreakSim, st: SpecialsState, t: SpecialsTuning, dt: number): void {
  classifySpecials(sim, st, t)
  for (const a of sim.ai.agents) {
    const rt = st.live[a.id]
    if (rt && rt.seed === a.seed) {
      if (rt.kind === SPECIAL_SCREAMER && rt.shriekUntil === 0 && (a.state === "alert" || a.state === "chase")) {
        if (a.seesTarget && sim.time >= rt.shriekReadyAt) startShriek(sim, a, rt, t)
        else if (a.state === "alert") {
          // On the wire a Screamer's alert always means a shriek, so it skips the ordinary snarl.
          a.state = "chase"
          a.stateTime = 0
          a.repathAt = 0
        }
      } else if (rt.kind === SPECIAL_BLOATER && a.state === "dead" && !rt.burst) release(sim, st, a, rt, t)
      else if (rt.kind === SPECIAL_LURKER && rt.dormant && a.state !== "wander") wakeLurker(a, rt, t, a.targetX, a.targetY)
    }
    if (st.clouds.length > 0 && a.state !== "dead") {
      for (const c of st.clouds) {
        if (!inCloud(c, a.x, a.y)) continue
        const keep = Math.max(0, Math.min(1, t.gasSlow))
        a.x -= a.vx * dt * (1 - keep)
        a.y -= a.vy * dt * (1 - keep)
        break
      }
    }
  }
}

function startShriek(sim: OutbreakSim, a: AIAgent, rt: SpecialRuntime, t: SpecialsTuning): void {
  rt.shriekUntil = sim.time + t.shriekTime
  a.state = "alert"
  a.stateTime = 0
  a.timer = t.shriekTime + 0.05
  a.vx = a.vy = 0
}

/**
 * How a hit lands on a special: a Riot cop's shield soaks the front and stops shoves; a Brute shrugs off shoves, light
 * swings and bullets (it still takes the damage); a sleeping Lurker wakes. Reads the kind from the seed, so co-op
 * prediction agrees with the room.
 */
export function specialHitOutcome(sim: OutbreakSim, z: AIAgent, hit: ZombieHit): ZombieHitOutcome | null {
  const kind = specialKindOf(z.seed)
  if (kind === SPECIAL_NONE) return null
  const st = sim.getFeatureState<SpecialsState>("specials")
  const t = st?.tuning ?? DEFAULT_SPECIALS_TUNING
  if (kind === SPECIAL_BRUTE) {
    if (hit.kind === "shove" || (hit.kind === "melee" && !hit.heavy) || hit.kind === "shot") return { damage: hit.damage, react: false }
    return null
  }
  if (kind === SPECIAL_RIOT) {
    if (!hitFromFront(z.x, z.y, z.aim, hit.fromX, hit.fromY, t.riotArc)) return null
    if (hit.kind === "shove") return { damage: 0, react: false }
    return { damage: hit.damage * Math.max(0, t.riotFront), react: false }
  }
  if (kind === SPECIAL_LURKER) {
    const rt = st?.live[z.id]
    if (rt && rt.seed === z.seed && rt.dormant) wakeLurker(z, rt, t, hit.fromX, hit.fromY)
  }
  return null
}

/** Ids the Lab spawns specials with: above every chunk's id range and below the hordes'. */
const LAB_ID_BASE = 60240
const LAB_ID_END = 60410

/** Lab: a special of `kind` at `(x, y)` facing `aim`, or `null` when there is no room for one. */
export function spawnSpecial(sim: OutbreakSim, kind: Exclude<SpecialKind, 0>, x: number, y: number, aim = 0): AIAgent | null {
  const st = specialsOf(sim)
  const used = new Set(sim.ai.agents.map((a) => a.id))
  let id = -1
  for (let k = LAB_ID_BASE; k <= LAB_ID_END; k++) {
    if (!used.has(k)) {
      id = k
      break
    }
  }
  if (id < 0) return null
  const a = sim.ai.spawnZombie(sim.town, x, y, "wander", aim)
  a.id = id
  makeSpecial(st, a, kind, st.tuning)
  return a
}

/** Counts of living specials by kind (harness). */
export function specialCounts(sim: OutbreakSim): Record<string, number> {
  const out: Record<string, number> = {}
  for (const a of sim.ai.agents) {
    if (a.state === "dead") continue
    const k = specialKindOf(a.seed)
    if (k !== SPECIAL_NONE) out[k] = (out[k] ?? 0) + 1
  }
  return out
}
