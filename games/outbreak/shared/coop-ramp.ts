import { runHeadlessBotGame, type BotRunConfig } from "./bot-runner"
import type { CoopSim, SurvivorSlot } from "./coop-sim"
import { rampPhaseIndex } from "./difficulty-ramp"
import { dogState, dogStoreId } from "./dogs/dogs"
import { DEFAULT_PACING_TUNING } from "./pacing"
import { SPECIAL_NONE, specialKindOf } from "./specials/kinds"
import type { BotSkillPresetId } from "./survivor-bot"

/**
 * Co-op difficulty probe: 1–6 survivor bots play one fixed seed from the start through Night 1 while a read-only probe
 * records what the squad met (population, chasers, specials, barking dogs, car alarms, how near new zombies appeared)
 * and what happened to each survivor (first down, downs, death, damage, ammo). `tests/difficulty-ramp.test.ts` holds
 * the co-op bands; `scripts/coop-difficulty.ts` prints the table. See docs/outbreak-difficulty.md (Co-op).
 */

/** Sim seconds from the start through Night 1 at the co-op clock (60 s evening, 360 s night) plus a little of Day 2. */
export const COOP_OPENING_SECONDS = 435
/** "Almost immediately": the evening and the first two game hours of Night 1 at the co-op clock. */
export const COOP_EARLY_SECONDS = 120

export type CoopSurvivorRecord = {
  /** Sim seconds of the first down (health 0), null if never down. */
  firstDown: number | null
  downs: number
  dead: boolean
  damage: number
  /** Damage taken while seated in a vehicle. */
  damageInCar: number
  ammoSpent: number
}

export type CoopPhaseRecord = {
  phase: number
  seconds: number
  /** Means over the phase. */
  living: number
  horde: number
  aware: number
  chasers: number
  specials: number
  desired: number
  maxActive: number
  noiseHeat: number
  /** Peaks over the phase. */
  peakChasers: number
  peakSpecials: number
  peakAware: number
}

export type CoopRun = {
  seed: number
  preset: BotSkillPresetId
  players: number
  endSeconds: number
  survivors: CoopSurvivorRecord[]
  /** Sim seconds of the squad's first down, null if nobody went down. */
  firstDown: number | null
  /** Every survivor down at once at some point. */
  wiped: boolean
  phases: CoopPhaseRecord[]
  /** Sim seconds a zombie first chased, a special first walked, a dog first barked, a car alarm first rang. */
  firstChase: number | null
  firstSpecial: number | null
  firstDogBark: number | null
  firstAlarm: number | null
  alarms: number
  /** Zombies that appeared after the start, and the nearest any of them came into the world to a standing survivor. */
  spawns: number
  nearestSpawn: number | null
  spawnsWithin20: number
}

const emptyPhase = (phase: number): CoopPhaseRecord => ({
  phase,
  seconds: 0,
  living: 0,
  horde: 0,
  aware: 0,
  chasers: 0,
  specials: 0,
  desired: 0,
  maxActive: 0,
  noiseHeat: 0,
  peakChasers: 0,
  peakSpecials: 0,
  peakAware: 0,
})

/** Runs one headless co-op bot game with the probe attached. The bot run itself is unchanged by the probe. */
export function runCoopProbe(config: BotRunConfig): CoopRun {
  const players = Math.max(1, Math.round(config.playerCount ?? 1))
  const survivors: CoopSurvivorRecord[] = Array.from({ length: players }, () => ({
    firstDown: null,
    downs: 0,
    dead: false,
    damage: 0,
    damageInCar: 0,
    ammoSpent: 0,
  }))
  const phases: CoopPhaseRecord[] = []
  const prevHealth: number[] = []
  const prevAmmo: number[] = []
  const known = new Set<number>()
  const ringing = new Set<string>()
  const startHour = DEFAULT_PACING_TUNING.startHour
  let first = true
  let wiped = false
  let firstChase: number | null = null
  let firstSpecial: number | null = null
  let firstDogBark: number | null = null
  let firstAlarm: number | null = null
  let alarms = 0
  let spawns = 0
  let nearestSpawn: number | null = null
  let spawnsWithin20 = 0
  let endSeconds = 0

  const observe = (sim: CoopSim, slots: readonly SurvivorSlot[], dt: number) => {
    endSeconds = sim.time
    const t = sim.time
    const index = rampPhaseIndex(sim.elapsedHours, startHour)
    while (phases.length <= index) phases.push(emptyPhase(phases.length))
    const ph = phases[index]!

    let living = 0
    let horde = 0
    let aware = 0
    let specials = 0
    for (const a of sim.ai.agents) {
      if (a.state === "dead") continue
      if (!known.has(a.id)) {
        known.add(a.id)
        if (!first) {
          spawns++
          let near = Infinity
          for (const s of slots) if (s.survivor.health > 0) near = Math.min(near, Math.hypot(a.x - s.survivor.x, a.y - s.survivor.y))
          if (Number.isFinite(near)) {
            nearestSpawn = nearestSpawn === null ? near : Math.min(nearestSpawn, near)
            if (near < 20) spawnsWithin20++
          }
        }
      }
      if (a.hordeId !== undefined) horde++
      else living++
      if (specialKindOf(a.seed) !== SPECIAL_NONE) specials++
      if (a.state === "chase" && firstChase === null) firstChase = t
      if (a.state !== "wander" && a.state !== "stagger" && a.state !== "knockdown" && a.state !== "crawler") aware++
    }
    if (specials > 0 && firstSpecial === null) firstSpecial = t

    const ledger = sim.progression.ledger
    if (firstDogBark === null) {
      for (const st of ledger.stores.values()) {
        if (st.id.startsWith(dogStoreId("")) && dogState(st, t) === "barking") {
          firstDogBark = t
          break
        }
      }
    }
    for (const car of sim.progression.verbs.cars) {
      if (!sim.progression.verbs.alarmRinging(car, t)) continue
      if (!ringing.has(car.key)) {
        ringing.add(car.key)
        alarms++
        if (firstAlarm === null) firstAlarm = t
      }
    }

    const tel = sim.ai.pacing.telemetry
    ph.seconds += dt
    ph.living += living * dt
    ph.horde += horde * dt
    ph.aware += aware * dt
    ph.chasers += tel.activeChasers * dt
    ph.specials += specials * dt
    ph.desired += tel.desiredPopulation * dt
    ph.maxActive += tel.effectiveMaxActive * dt
    ph.noiseHeat += tel.noiseHeat * dt
    ph.peakChasers = Math.max(ph.peakChasers, tel.activeChasers)
    ph.peakSpecials = Math.max(ph.peakSpecials, specials)
    ph.peakAware = Math.max(ph.peakAware, aware)

    let down = 0
    for (let i = 0; i < slots.length; i++) {
      const p = slots[i]!.survivor
      const rec = survivors[i]!
      const ammo = p.magAmmo + p.reserveAmmo
      if (!first) {
        const dh = p.health - prevHealth[i]!
        if (dh < 0) {
          rec.damage -= dh
          if (p.vehicleId) rec.damageInCar -= dh
        }
        if (p.health <= 0 && prevHealth[i]! > 0) {
          rec.downs++
          if (rec.firstDown === null) rec.firstDown = t
        }
        if (ammo < prevAmmo[i]!) rec.ammoSpent += prevAmmo[i]! - ammo
      }
      prevHealth[i] = p.health
      prevAmmo[i] = ammo
      if (p.health <= 0) down++
      const life = sim.getFeatureState<{ records: Record<number, { state: string }> }>("death")?.records[slots[i]!.index]?.state
      if (life === "dead") rec.dead = true
    }
    if (down === slots.length) wiped = true
    first = false
  }

  const run = runHeadlessBotGame({ ...config, observe })
  for (const ph of phases) {
    if (ph.seconds <= 0) continue
    for (const k of ["living", "horde", "aware", "chasers", "specials", "desired", "maxActive", "noiseHeat"] as const) ph[k] /= ph.seconds
  }
  const downs = survivors.map((s) => s.firstDown).filter((v): v is number => v !== null)
  return {
    seed: run.seed,
    preset: run.preset,
    players,
    endSeconds,
    survivors,
    firstDown: downs.length ? Math.min(...downs) : null,
    wiped,
    phases,
    firstChase,
    firstSpecial,
    firstDogBark,
    firstAlarm,
    alarms,
    spawns,
    nearestSpawn,
    spawnsWithin20,
  }
}

export type CoopSummary = {
  players: number
  preset: BotSkillPresetId
  runs: number
  /** Share of survivors (over every run) down at least once, and dead, by the end. */
  downRate: number
  deathRate: number
  /** Share of runs where every survivor was down at once. */
  wipeRate: number
  /** Median squad first down in sim seconds over runs with a down (null if none). */
  medianFirstDown: number | null
  /** Share of runs with a down in the first `early` sim seconds, and share of survivors down by then. */
  earlyDownRate: number
  earlySurvivorDownRate: number
  /** Means per phase (time-weighted over runs). */
  phases: { phase: number; living: number; aware: number; chasers: number; specials: number; peakChasers: number; desired: number; maxActive: number; noiseHeat: number }[]
  ammoSpentPerSurvivor: number
  damagePerSurvivor: number
  damageInCar: number
  alarmsPerRun: number
  medianFirstChase: number | null
  medianFirstSpecial: number | null
  medianFirstDogBark: number | null
  nearestSpawn: number | null
  spawnsWithin20: number
}

const median = (xs: readonly number[]): number | null => {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

const round = (v: number, d = 2) => Number(v.toFixed(d))

/** Folds co-op runs of one player count and preset into rates and per-phase means. `early` is in sim seconds. */
export function summarizeCoop(runs: readonly CoopRun[], early: number): CoopSummary {
  const all = runs.flatMap((r) => r.survivors)
  const n = Math.max(1, all.length)
  const phaseCount = Math.max(0, ...runs.map((r) => r.phases.length))
  const phases: CoopSummary["phases"] = []
  for (let p = 0; p < phaseCount; p++) {
    const ps = runs.map((r) => r.phases[p]).filter((x): x is CoopPhaseRecord => !!x && x.seconds > 0)
    const w = ps.reduce((a, x) => a + x.seconds, 0) || 1
    const mean = (k: keyof CoopPhaseRecord) => round(ps.reduce((a, x) => a + (x[k] as number) * x.seconds, 0) / w)
    phases.push({
      phase: p,
      living: mean("living"),
      aware: mean("aware"),
      chasers: mean("chasers"),
      specials: mean("specials"),
      peakChasers: round(ps.reduce((a, x) => a + x.peakChasers, 0) / Math.max(1, ps.length)),
      desired: mean("desired"),
      maxActive: mean("maxActive"),
      noiseHeat: mean("noiseHeat"),
    })
  }
  const nonNull = (xs: (number | null)[]) => xs.filter((v): v is number => v !== null)
  const near = nonNull(runs.map((r) => r.nearestSpawn))
  return {
    players: runs[0]?.players ?? 0,
    preset: runs[0]?.preset ?? "Skilled",
    runs: runs.length,
    downRate: round(all.filter((s) => s.downs > 0).length / n),
    deathRate: round(all.filter((s) => s.dead).length / n),
    wipeRate: round(runs.filter((r) => r.wiped).length / Math.max(1, runs.length)),
    medianFirstDown: median(nonNull(runs.map((r) => r.firstDown))),
    earlyDownRate: round(runs.filter((r) => r.firstDown !== null && r.firstDown < early).length / Math.max(1, runs.length)),
    earlySurvivorDownRate: round(all.filter((s) => s.firstDown !== null && s.firstDown < early).length / n),
    phases,
    ammoSpentPerSurvivor: round(all.reduce((a, s) => a + s.ammoSpent, 0) / n),
    damagePerSurvivor: round(all.reduce((a, s) => a + s.damage, 0) / n),
    damageInCar: round(all.reduce((a, s) => a + s.damageInCar, 0) / n),
    alarmsPerRun: round(runs.reduce((a, r) => a + r.alarms, 0) / Math.max(1, runs.length)),
    medianFirstChase: median(nonNull(runs.map((r) => r.firstChase))),
    medianFirstSpecial: median(nonNull(runs.map((r) => r.firstSpecial))),
    medianFirstDogBark: median(nonNull(runs.map((r) => r.firstDogBark))),
    nearestSpawn: near.length ? round(Math.min(...near)) : null,
    spawnsWithin20: round(runs.reduce((a, r) => a + r.spawnsWithin20, 0) / Math.max(1, runs.length)),
  }
}
