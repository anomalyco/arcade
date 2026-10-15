import { createAIAgent, type AIAgent, type NoiseEvent } from "@arcade/kit/sim/ai"
import type { Rect } from "@arcade/kit/sim/geom"
import type { CoopSim } from "../coop-sim"
import { registerOutbreakSharedFeature } from "../feature-registry"

/**
 * Roaming hordes. A horde is either abstract (a point, a goal and a head count, moving through chunks nobody has
 * loaded) or live (members in `ai.agents`, tagged with `hordeId`). It hears loud noises from much farther than one
 * zombie does, ignoring walls, and walks toward them; once a survivor is near, it materializes inside the active
 * window and its members follow the shared flow fields like any other zombie. When every member is far from every
 * survivor and none is engaged, the horde folds back into a point. All state is plain JSON in the feature state.
 */
export type HordeTuning = {
  /** Hordes placed around the start, 70–120 m out (0 = off). */
  hordeCount: number
  /** Members in each of those hordes. */
  hordeSize: number
  /** A horde hears a noise from its radius times this (and the AI hearing scale), through walls. */
  hordeHearing: number
  /** Walking speed of an abstract horde toward its goal, m/s. */
  hordeSpeed: number
  /** A horde materializes once its centre is this close to a survivor, m. */
  hordeMaterialize: number
  /** A quiet live horde folds back into a point once every member is this far from every survivor, m. */
  hordeAbsorb: number
  /** 1: an idle horde drifts to a new spot every minute or so. */
  hordeRoam: number
}

export const DEFAULT_HORDE_TUNING: HordeTuning = {
  hordeCount: 0,
  hordeSize: 300,
  hordeHearing: 2.5,
  hordeSpeed: 0.9,
  hordeMaterialize: 46,
  hordeAbsorb: 64,
  hordeRoam: 1,
}

export const hordeControls = [
  { key: "hordes.hordeCount", field: "hordeCount", label: "Roaming hordes", group: "Hordes", min: 0, max: 6, step: 1, unit: "" },
  { key: "hordes.hordeSize", field: "hordeSize", label: "Horde size", group: "Hordes", min: 20, max: 1000, step: 10, unit: "" },
  { key: "hordes.hordeHearing", field: "hordeHearing", label: "Horde hearing", group: "Hordes", min: 1, max: 5, step: 0.1, unit: "×" },
  { key: "hordes.hordeSpeed", field: "hordeSpeed", label: "Migration speed", group: "Hordes", min: 0.3, max: 2.5, step: 0.05, unit: "m/s" },
  { key: "hordes.hordeMaterialize", field: "hordeMaterialize", label: "Materialize within", group: "Hordes", min: 20, max: 60, step: 1, unit: "m" },
  { key: "hordes.hordeAbsorb", field: "hordeAbsorb", label: "Absorb beyond", group: "Hordes", min: 30, max: 90, step: 1, unit: "m" },
  {
    key: "hordes.hordeRoam",
    field: "hordeRoam",
    label: "Idle roaming",
    group: "Hordes",
    options: [
      { label: "Off", value: 0 },
      { label: "On", value: 1 },
    ],
  },
] as const

export const HORDE_GOAL_NONE = 0
export const HORDE_GOAL_NOISE = 1
export const HORDE_GOAL_ROAM = 2

export type Horde = {
  id: number
  /** Centre: the members' centroid while live, the abstract position otherwise. */
  x: number
  y: number
  goal: 0 | 1 | 2
  goalX: number
  goalY: number
  goalTime: number
  /**
   * Where live members are sent: the goal itself once it is close, otherwise a point ~30 m along the way. Flow fields
   * cover a 112 m window around their goal, so a far goal is walked in legs instead of falling back to per-agent A*.
   */
  legX: number
  legY: number
  /** An idle horde picks a roam goal after this time. */
  idleUntil: number
  /** Members not in the world. */
  pending: number
  /** Living members in `ai.agents` after the last step. */
  live: number
  /** Last time a member was folded back (no materializing for a few seconds after, so edges don't flicker). */
  absorbedAt: number
  /** Placed by `hordeCount` (removed again when it drops) rather than staged. */
  seeded: boolean
}

export type HordesState = {
  hordes: Horde[]
  nextHorde: number
  /** Next member id to try, inside `[HORDE_ID_BASE, HORDE_ID_END]`. */
  nextMember: number
  /** Noise bus id already heard. */
  lastNoise: number
  /** Hordes placed from `hordeCount` so far. */
  seeded: number
  rng: number
}

/** Member ids sit above every chunk's id range (`chunkZombieIdBase` tops out near 60 200) and fit the wire's u16. */
export const HORDE_ID_BASE = 60416
export const HORDE_ID_END = 65535
/** Members materialized per tick, so a 1,000-strong horde arrives over a second instead of one frame. */
const MATERIALIZE_PER_TICK = 64
/** Members are placed this far inside the active window, and a horde must be this deep in it to materialize. */
const EDGE_INSET = 8
const NO_SPAWN_NEAR_SURVIVOR = 10
/** A member this close to the window's edge has walked out of it and folds back into its horde. */
const STRAY_INSET = 0.5
/** Members are never placed closer than this to the window's edge. */
const PLACE_INSET = 3
const REMATERIALIZE_DELAY = 8
const GOAL_TTL = 150
/** Noises quieter than this radius (footsteps, searching, shoves) never reach a horde. */
const HEARD_MIN_RADIUS = 12
const UNHEARD = new Set(["footstep", "sprint", "groan", "search", "shove"])
const ENGAGED = new Set(["chase", "alert", "bash"])
const DIRECTABLE = new Set(["wander", "search", "investigate"])
const GOLDEN = 2.399963229728653

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export function createHordesState(seed = 1): HordesState {
  return { hordes: [], nextHorde: 1, nextMember: HORDE_ID_BASE, lastNoise: 0, seeded: 0, rng: (seed ^ 0x6a09e667) >>> 0 || 1 }
}

/** Mulberry32 step on the state's own stream, so hordes never shift the simulation's main RNG. */
function rand(state: HordesState): number {
  state.rng = (state.rng + 0x6d2b79f5) >>> 0
  let t = state.rng
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

export function hordeTuning(resolved?: { features?: Readonly<Record<string, Record<string, unknown>>> }): HordeTuning {
  const src = resolved?.features?.hordes as Partial<HordeTuning> | undefined
  return src ? { ...DEFAULT_HORDE_TUNING, ...src } : DEFAULT_HORDE_TUNING
}

export function hordesOf(sim: CoopSim): HordesState {
  let st = sim.getFeatureState<HordesState>("hordes")
  if (!st) {
    st = createHordesState(sim.seed)
    sim.featureStates.set("hordes", st)
  }
  return st
}

function bounds(sim: CoopSim): Rect {
  return sim.town.worldBounds ?? [0, 0, 96, 96]
}

function insideBounds(b: Rect, x: number, y: number, inset: number): boolean {
  return x >= b[0] + inset && x <= b[2] - inset && y >= b[1] + inset && y <= b[3] - inset
}

function nearestSurvivor(sim: CoopSim, x: number, y: number): number {
  let best = Infinity
  for (const s of sim.slots) best = Math.min(best, Math.hypot(s.survivor.x - x, s.survivor.y - y))
  return best
}

function insideBuilding(sim: CoopSim, x: number, y: number): boolean {
  for (const b of sim.town.buildings) {
    const r = b.rect
    if (x >= r[0] - 0.4 && x <= r[2] + 0.4 && y >= r[1] - 0.4 && y <= r[3] + 0.4) return true
  }
  return false
}

/** Adds a horde of `size` members at `(x, y)`; it stays abstract until the next step decides otherwise. */
export function addHorde(
  sim: CoopSim,
  x: number,
  y: number,
  size: number,
  goal?: { x: number; y: number; kind?: 1 | 2 },
  seeded = false,
): Horde {
  const st = hordesOf(sim)
  const h: Horde = {
    id: st.nextHorde++,
    x,
    y,
    goal: goal ? (goal.kind ?? HORDE_GOAL_NOISE) : HORDE_GOAL_NONE,
    goalX: goal?.x ?? x,
    goalY: goal?.y ?? y,
    goalTime: sim.time,
    legX: goal?.x ?? x,
    legY: goal?.y ?? y,
    idleUntil: sim.time + 30 + rand(st) * 40,
    pending: Math.max(0, Math.round(size)),
    live: 0,
    absorbedAt: -1e9,
    seeded,
  }
  st.hordes.push(h)
  return h
}

/** Materializes every pending member of `horde` now, wherever it is (Lab staging and tests). */
export function materializeHorde(sim: CoopSim, horde: Horde): number {
  const st = hordesOf(sim)
  if (horde.goal !== HORDE_GOAL_NONE) updateLeg(sim, horde)
  let n = 0
  while (horde.pending > 0) {
    const made = materialize(sim, st, horde, horde.pending, 0)
    if (made === 0) break
    n += made
  }
  return n
}

/** Points `horde` at `(x, y)` as if it had heard something there. */
export function directHorde(sim: CoopSim, horde: Horde, x: number, y: number, kind: 1 | 2 = HORDE_GOAL_NOISE): void {
  horde.goal = kind
  horde.goalX = x
  horde.goalY = y
  horde.goalTime = sim.time
  horde.legX = x
  horde.legY = y
}

/** Goals closer than this are walked straight at; farther ones in legs of `LEG` metres. */
const LEG_REACH = 36
const LEG = 30

function updateLeg(sim: CoopSim, h: Horde): void {
  const d = Math.hypot(h.goalX - h.x, h.goalY - h.y)
  if (d <= LEG_REACH) {
    h.legX = h.goalX
    h.legY = h.goalY
    return
  }
  const lead = Math.hypot(h.legX - h.x, h.legY - h.y)
  if (lead >= 16 && lead <= LEG + 10) return
  const b = bounds(sim)
  const heading = Math.atan2(h.goalY - h.y, h.goalX - h.x)
  // Straight ahead if that is open ground, else the nearest open spot fanning out to the sides (never indoors, or the
  // whole horde would file through a front door to cut a corner).
  for (const turn of LEG_TURNS) {
    for (const len of LEG_LENGTHS) {
      const p = sim.ai.nav.nearest({
        x: clamp(h.x + Math.cos(heading + turn) * len, b[0] + 2, b[2] - 2),
        y: clamp(h.y + Math.sin(heading + turn) * len, b[1] + 2, b[3] - 2),
      })
      if (insideBuilding(sim, p.x, p.y)) continue
      h.legX = p.x
      h.legY = p.y
      return
    }
  }
  h.legX = h.goalX
  h.legY = h.goalY
}

const LEG_TURNS = [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05]
const LEG_LENGTHS = [LEG, LEG * 0.7, LEG * 1.3, LEG * 0.45]

/** Removes `horde` and all its members from the world. */
export function disbandHorde(sim: CoopSim, horde: Horde): void {
  const st = hordesOf(sim)
  removeMembers(sim, (a) => a.hordeId === horde.id)
  st.hordes = st.hordes.filter((h) => h !== horde)
}

function removeMembers(sim: CoopSim, drop: (a: AIAgent) => boolean): number {
  const agents = sim.ai.agents
  let w = 0
  for (let r = 0; r < agents.length; r++) {
    const a = agents[r]!
    if (!drop(a)) agents[w++] = a
  }
  const removed = agents.length - w
  agents.length = w
  return removed
}

function allocMemberId(st: HordesState, used: Set<number>): number {
  const span = HORDE_ID_END - HORDE_ID_BASE + 1
  for (let k = 0; k < span; k++) {
    const id = st.nextMember
    st.nextMember = id >= HORDE_ID_END ? HORDE_ID_BASE : id + 1
    if (!used.has(id)) {
      used.add(id)
      return id
    }
  }
  return -1
}

function materialize(sim: CoopSim, st: HordesState, h: Horde, count: number, inset: number): number {
  const b = bounds(sim)
  const nav = sim.ai.nav
  const used = new Set<number>()
  for (const a of sim.ai.agents) used.add(a.id)
  const total = h.live + h.pending
  const spacing = 0.78
  const radius = spacing * Math.sqrt(total) + 1
  const townSeed = sim.town.seed >>> 0
  let made = 0
  for (let k = 0; k < count && h.pending > 0; k++) {
    let px = 0
    let py = 0
    let ok = false
    for (let attempt = 0; attempt < 12 && !ok; attempt++) {
      const r = radius * Math.sqrt(rand(st))
      const ang = (h.live + made + attempt) * GOLDEN + rand(st) * 0.6
      const cx = h.x + Math.cos(ang) * r
      const cy = h.y + Math.sin(ang) * r
      if (!insideBounds(b, cx, cy, PLACE_INSET + inset)) continue
      if (insideBuilding(sim, cx, cy) || nearestSurvivor(sim, cx, cy) < NO_SPAWN_NEAR_SURVIVOR) continue
      const p = nav.nearest({ x: cx, y: cy })
      if (!nav.walkable(p) || insideBuilding(sim, p.x, p.y)) continue
      px = p.x
      py = p.y
      ok = true
    }
    if (!ok) continue
    const id = allocMemberId(st, used)
    if (id < 0) break
    const seed = (townSeed ^ Math.imul(id + 17, 0x85ebca6b)) >>> 0
    const aim = h.goal ? Math.atan2(h.legY - py, h.legX - px) : rand(st) * Math.PI * 2 - Math.PI
    const agent = createAIAgent(id, seed, px, py, aim)
    agent.hordeId = h.id
    agent.homeX = h.goal ? h.legX : h.x
    agent.homeY = h.goal ? h.legY : h.y
    if (h.goal) direct(agent, h)
    sim.ai.agents.push(agent)
    h.pending--
    h.live++
    made++
  }
  return made
}

function direct(a: AIAgent, h: Horde): void {
  if (a.state !== "investigate") {
    a.state = "investigate"
    a.stateTime = 0
    a.repathAt = 0
  }
  a.targetX = h.legX
  a.targetY = h.legY
  a.targetKind = "noise"
  a.awareness = Math.max(a.awareness, 0.4)
  a.homeX = h.legX
  a.homeY = h.legY
}

/** A horde has reached its goal once its members are this close to it (a crowd needs room to stand). */
function arriveRadius(size: number): number {
  return 3 + 0.25 * Math.sqrt(size)
}

function hears(h: Horde, ev: NoiseEvent, hearing: number): number {
  if (ev.radius < HEARD_MIN_RADIUS || UNHEARD.has(ev.kind) || ev.sourceId.startsWith("zombie-")) return -1
  const reach = ev.radius * hearing
  const d = Math.hypot(ev.x - h.x, ev.y - h.y)
  return d <= reach ? reach - d : -1
}

/** One horde-layer tick: membership, hearing, goals, abstract movement, materializing, absorbing and directives. */
export function stepHordes(sim: CoopSim, dt: number, tuning: HordeTuning): void {
  const st = hordesOf(sim)
  if (st.hordes.length === 0 && Math.round(tuning.hordeCount) === st.seeded) {
    st.lastNoise = Math.max(st.lastNoise, lastNoiseId(sim))
    return
  }
  syncSeeded(sim, st, tuning)
  const time = sim.time
  const b = bounds(sim)
  const byId = new Map<number, number>()
  const n = st.hordes.length
  const live = new Int32Array(n)
  const sx = new Float64Array(n)
  const sy = new Float64Array(n)
  const nearest = new Float64Array(n).fill(Infinity)
  const engaged = new Uint8Array(n)
  // Members already within the arrival radius of their horde's goal.
  const arrived = new Int32Array(n)
  const arriveR = st.hordes.map((h) => arriveRadius(h.live + h.pending))
  st.hordes.forEach((h, i) => byId.set(h.id, i))

  // 1. Membership. Members that walked out of the active window fold back into their horde.
  let strays = 0
  for (const a of sim.ai.agents) {
    if (a.hordeId === undefined || a.state === "dead") continue
    const i = byId.get(a.hordeId)
    if (i === undefined) continue
    if (!insideBounds(b, a.x, a.y, STRAY_INSET)) {
      strays++
      continue
    }
    live[i]!++
    sx[i]! += a.x
    sy[i]! += a.y
    if (ENGAGED.has(a.state)) engaged[i] = 1
    const h = st.hordes[i]!
    if (h.goal !== HORDE_GOAL_NONE && Math.hypot(a.x - h.goalX, a.y - h.goalY) <= arriveR[i]!) arrived[i]!++
    const d = nearestSurvivor(sim, a.x, a.y)
    if (d < nearest[i]!) nearest[i] = d
  }
  if (strays > 0) {
    removeMembers(sim, (a) => {
      if (a.hordeId === undefined || a.state === "dead" || insideBounds(b, a.x, a.y, STRAY_INSET)) return false
      const i = byId.get(a.hordeId)
      if (i === undefined) return false
      const h = st.hordes[i]!
      h.pending++
      h.absorbedAt = time
      return true
    })
  }

  // 2. Hearing: loud noises since the last step, through walls, from far away.
  const hearing = Math.max(0, tuning.hordeHearing) * Math.max(0.05, sim.ai.config.hearingScale)
  const events = sim.ai.noiseBus.events
  let maxId = st.lastNoise
  for (let k = 0; k < n; k++) {
    const h = st.hordes[k]!
    h.live = live[k]!
    if (h.live > 0) {
      h.x = sx[k]! / h.live
      h.y = sy[k]! / h.live
    }
    let best = -1
    let heard: NoiseEvent | null = null
    for (const ev of events) {
      if (ev.id <= st.lastNoise) continue
      const s = hears(h, ev, hearing)
      if (s > best) {
        best = s
        heard = ev
      }
    }
    if (heard) directHorde(sim, h, heard.x, heard.y, HORDE_GOAL_NOISE)
  }
  for (const ev of events) maxId = Math.max(maxId, ev.id)
  st.lastNoise = maxId

  for (let k = 0; k < n; k++) {
    const h = st.hordes[k]!
    const size = h.live + h.pending
    // 3. Goals: arrive, expire, or (idle) drift somewhere new. A horde in a fight stays put.
    if (engaged[k]) h.idleUntil = Math.max(h.idleUntil, time + 20)
    if (h.goal !== HORDE_GOAL_NONE) {
      // Live: half the members are there. Abstract: the point is.
      const there =
        h.live > 0 ? arrived[k]! * 2 >= h.live : Math.hypot(h.goalX - h.x, h.goalY - h.y) <= arriveRadius(size)
      if (there || time - h.goalTime > GOAL_TTL) {
        h.goal = HORDE_GOAL_NONE
        h.idleUntil = time + 45 + rand(st) * 45
      }
    } else if (tuning.hordeRoam > 0 && time >= h.idleUntil) {
      const ang = rand(st) * Math.PI * 2
      const dist = 30 + rand(st) * 30
      directHorde(sim, h, h.x + Math.cos(ang) * dist, h.y + Math.sin(ang) * dist, HORDE_GOAL_ROAM)
    }

    // 4. Abstract movement.
    if (h.live === 0 && h.goal !== HORDE_GOAL_NONE) {
      const dx = h.goalX - h.x
      const dy = h.goalY - h.y
      const d = Math.hypot(dx, dy)
      const step = Math.min(d, Math.max(0, tuning.hordeSpeed) * dt)
      if (d > 1e-6) {
        h.x += (dx / d) * step
        h.y += (dy / d) * step
      }
    }

    // 5. Materialize near survivors, inside the active window.
    const arriving =
      h.pending > 0 &&
      time - h.absorbedAt >= REMATERIALIZE_DELAY &&
      insideBounds(b, h.x, h.y, EDGE_INSET) &&
      nearestSurvivor(sim, h.x, h.y) <= tuning.hordeMaterialize
    if (h.goal !== HORDE_GOAL_NONE && (h.live > 0 || arriving)) updateLeg(sim, h)
    if (arriving) materialize(sim, st, h, Math.min(h.pending, MATERIALIZE_PER_TICK), 1)

    // 6. Absorb a quiet horde nobody is near.
    if (live[k]! > 0 && !engaged[k] && nearest[k]! > tuning.hordeAbsorb) {
      const id = h.id
      const removed = removeMembers(sim, (a) => a.hordeId === id && a.state !== "dead")
      h.pending += removed
      h.live = 0
      h.absorbedAt = time
    }
  }

  // 7. Directives: live members that are not busy keep heading for their horde's goal.
  const tick = sim.ai.tick
  for (const a of sim.ai.agents) {
    if (a.hordeId === undefined || (a.id + tick) % 30 !== 0) continue
    const i = byId.get(a.hordeId)
    if (i === undefined) continue
    const h = st.hordes[i]!
    if (h.goal === HORDE_GOAL_NONE || a.clamberWindowId) continue
    if (a.state === "crawler") {
      if (!a.seesTarget) {
        a.targetX = h.legX
        a.targetY = h.legY
      }
      continue
    }
    if (!DIRECTABLE.has(a.state)) continue
    if (Math.hypot(h.legX - a.x, h.legY - a.y) < 3) continue
    direct(a, h)
  }

  st.hordes = st.hordes.filter((h) => h.live + h.pending > 0 || hasLiveMember(sim, h.id))
}

function hasLiveMember(sim: CoopSim, id: number): boolean {
  for (const a of sim.ai.agents) if (a.hordeId === id && a.state !== "dead") return true
  return false
}

function lastNoiseId(sim: CoopSim): number {
  let m = 0
  for (const ev of sim.ai.noiseBus.events) m = Math.max(m, ev.id)
  return m
}

function syncSeeded(sim: CoopSim, st: HordesState, tuning: HordeTuning): void {
  const want = Math.max(0, Math.round(tuning.hordeCount))
  if (want === st.seeded) return
  if (want < st.seeded) {
    const seeded = st.hordes.filter((h) => h.seeded)
    for (const h of seeded.slice(Math.max(0, seeded.length - (st.seeded - want)))) disbandHorde(sim, h)
    st.seeded = want
    return
  }
  const ref = sim.slots[0]?.survivor ?? { x: 27.7, y: 41 }
  while (st.seeded < want) {
    const ang = (st.seeded * GOLDEN + rand(st) * 0.8) % (Math.PI * 2)
    const dist = 70 + rand(st) * 50
    addHorde(sim, ref.x + Math.cos(ang) * dist, ref.y + Math.sin(ang) * dist, tuning.hordeSize, undefined, true)
    st.seeded++
  }
}

export const outbreakHordesSharedFeature = registerOutbreakSharedFeature<HordesState, undefined, HordeTuning>({
  id: "hordes",
  // After pacing (15), before the crowd steps in `stepWorld`.
  order: 16,
  tuning: { namespace: "hordes", defaults: DEFAULT_HORDE_TUNING },
  createState: (sim) => createHordesState(sim.seed),
  cloneState: (state) => structuredClone(state),
  stepWorld: ({ sim, dt, resolved }) => {
    stepHordes(sim, dt, hordeTuning(resolved))
  },
})
