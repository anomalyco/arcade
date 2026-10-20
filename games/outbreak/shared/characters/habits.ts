import { zombieTraitsFromSeed, type AIAgent } from "../ai"
import type { OutbreakSim } from "../sim-types"
import { specialKindOf, SPECIAL_NONE } from "../specials/kinds"
import type { SpecialsState } from "../specials/specials"
import { seedForCalling } from "./callings"
import { habitSites, siteActive, siteCalling, type HabitSite } from "./sites"

/**
 * Habit loops, the rules (AR-88). A zombie that has just appeared, still wandering and unaware, may be given to a
 * nearby habit site nobody is watching: it moves there, becomes the person the place implies (its seed is re-picked so
 * its calling matches, traits re-rolled from the new seed as specials do) and stands still doing its habit. It keeps
 * full senses; the moment it stops wandering (it heard, saw or was hit) it lets go for good and hunts at its own pace.
 * Each site is used once per run: when its zombie dies the stove stays cold.
 *
 * Nothing new is on the wire: clients find the habit from the site under a still, wandering zombie (`sites.ts`).
 */
export type CharactersTuning = {
  /** 0 = Today (no characters), 1 = Who they were. */
  chStyle: number
  /** Habit loops on (1) or off (0). */
  chHabits: number
  /** How many habit sites are in use, 0..1 (0.5 = each kind's own chance). */
  chHabitShare: number
  /** How well a zombie lost in its habit sees and hears, relative to its own senses (0..1). */
  chHabitSenses: number
  /** Seconds it takes to let go of its habit once it notices something (it turns, but does not move). */
  chHabitLetGo: number
}

export const DEFAULT_CHARACTERS_TUNING: CharactersTuning = { chStyle: 1, chHabits: 1, chHabitShare: 0.5, chHabitSenses: 0.55, chHabitLetGo: 1 }

/** How far a new zombie may be moved to a site, and how far every survivor must be from it, in metres. */
export const HABIT_PICK_RADIUS = 40
export const HABIT_UNSEEN_RADIUS = 16

export type HabitRuntime = {
  key: string
  seed: number
  /** Its own speed and senses, given back when it lets go. */
  speed: number
  perception: number
  /** When it noticed something (sim time), -1 while still in its habit. */
  noticed: number
}

export type CharactersState = {
  /** Sites in the active chunks (rebuilt on chunk sync). */
  sites: HabitSite[]
  dirty: boolean
  /** Sites that have been used this run. */
  used: Record<string, 1>
  /** Zombies doing a habit now, by id. */
  live: Record<number, HabitRuntime>
  /** Seed each zombie id was last seen with (a new id or seed is a new zombie). */
  seen: Record<number, number>
  tuning: CharactersTuning
}

export function createCharactersState(): CharactersState {
  return { sites: [], dirty: true, used: {}, live: {}, seen: {}, tuning: DEFAULT_CHARACTERS_TUNING }
}

export function charactersTuning(features: Readonly<Record<string, Record<string, unknown>>> | undefined): CharactersTuning {
  return { ...DEFAULT_CHARACTERS_TUNING, ...(features?.characters as Partial<CharactersTuning> | undefined) }
}

export const habitsOn = (t: CharactersTuning) => t.chStyle >= 1 && t.chHabits >= 1

function nearestSurvivorDist(sim: OutbreakSim, x: number, y: number): number {
  let best = Infinity
  for (const s of sim.slots) best = Math.min(best, Math.hypot(s.survivor.x - x, s.survivor.y - y))
  return best
}

function setSeed(sim: OutbreakSim, a: AIAgent, seed: number): void {
  a.seed = seed >>> 0
  const traits = zombieTraitsFromSeed(a.seed)
  a.hitReaction = traits.hitReaction
  a.deathVariant = traits.deathVariant
  a.toughness = traits.toughness
  // The specials feature rolls every new seed; this one is ours and stays ordinary.
  const sp = sim.getFeatureState<SpecialsState>("specials")
  if (sp) sp.seen[a.id] = a.seed
}

function hold(a: AIAgent, s: HabitSite): void {
  a.x = a.homeX = a.wanderX = s.x
  a.y = a.homeY = a.wanderY = s.y
  a.vx = a.vy = 0
  a.aim = s.aim
  a.path = []
}

function release(a: AIAgent | undefined, rt: HabitRuntime): void {
  if (!a || a.seed !== rt.seed) return
  a.speedScale = rt.speed
  a.perceptionScale = rt.perception
}

/** Puts zombie `a` at site `s` (Lab staging and the rules below). */
export function startHabit(sim: OutbreakSim, st: CharactersState, a: AIAgent, s: HabitSite): void {
  const old = st.live[a.id]
  if (old) release(a, old)
  for (const [id, rt] of Object.entries(st.live)) if (rt.key === s.key && Number(id) !== a.id) delete st.live[Number(id)]
  setSeed(sim, a, seedForCalling(a.seed, a.id, siteCalling(s)))
  st.live[a.id] = { key: s.key, seed: a.seed, speed: a.speedScale, perception: a.perceptionScale, noticed: -1 }
  st.seen[a.id] = a.seed
  st.used[s.key] = 1
  a.state = "wander"
  a.awareness = 0
  a.hordeId = undefined
  a.speedScale = 0
  a.perceptionScale = st.live[a.id]!.perception * clamp01(st.tuning.chHabitSenses)
  hold(a, s)
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

function eligible(a: AIAgent): boolean {
  return a.state === "wander" && a.awareness === 0 && a.hordeId === undefined && specialKindOf(a.seed) === SPECIAL_NONE && a.detachedLimbs.length === 0
}

/** Runs after the crowd steps: holds habit zombies on their spot, lets go of those that noticed, fills free sites. */
export function stepHabits(sim: OutbreakSim, st: CharactersState): void {
  const on = habitsOn(st.tuning)
  const byId = new Map<number, AIAgent>()
  for (const a of sim.ai.agents) byId.set(a.id, a)
  const siteByKey = new Map(st.sites.map((s) => [s.key, s]))
  for (const [idKey, rt] of Object.entries(st.live)) {
    const id = Number(idKey)
    const a = byId.get(id)
    const s = siteByKey.get(rt.key)
    if (!on || !a || a.seed !== rt.seed || !s || a.state === "dead") {
      release(a, rt)
      delete st.live[id]
      continue
    }
    if (a.state !== "wander" && rt.noticed < 0) {
      // It noticed: full senses at once, but a beat to turn from the door or the stove before it comes.
      rt.noticed = sim.time
      a.perceptionScale = rt.perception
    }
    if (rt.noticed >= 0) {
      if (sim.time - rt.noticed >= st.tuning.chHabitLetGo || a.state === "stagger" || a.state === "knockdown") {
        release(a, rt)
        delete st.live[id]
      }
      continue
    }
    hold(a, s)
  }
  if (!on) {
    for (const a of sim.ai.agents) st.seen[a.id] = a.seed
    return
  }
  if (st.dirty) {
    st.sites = habitSites(sim.town)
    st.dirty = false
  }
  const free = st.sites.filter((s) => !st.used[s.key] && siteActive(s, st.tuning.chHabitShare))
  for (const a of sim.ai.agents) {
    if (st.seen[a.id] === a.seed) continue
    st.seen[a.id] = a.seed
    if (!free.length || !eligible(a) || st.live[a.id]) continue
    const fromSurvivors = nearestSurvivorDist(sim, a.x, a.y)
    if (fromSurvivors < HABIT_UNSEEN_RADIUS) continue
    let best = -1
    let bestD = HABIT_PICK_RADIUS
    for (let i = 0; i < free.length; i++) {
      const s = free[i]!
      const d = Math.hypot(s.x - a.x, s.y - a.y)
      if (d >= bestD) continue
      // Never closer to anyone than it already was: a habit is a place the dead are, not an ambush brought to you.
      if (nearestSurvivorDist(sim, s.x, s.y) < Math.max(HABIT_UNSEEN_RADIUS, fromSurvivors)) continue
      if (!sim.ai.nav.walkable({ x: s.x, y: s.y })) continue
      best = i
      bestD = d
    }
    if (best < 0) continue
    const s = free[best]!
    free.splice(best, 1)
    startHabit(sim, st, a, s)
  }
  if (sim.ai.agents.length < Object.keys(st.seen).length) {
    for (const k of Object.keys(st.seen)) if (!byId.has(Number(k))) delete st.seen[Number(k)]
  }
}
