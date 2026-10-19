import { runHeadlessBotGame, type BotRunConfig, type CauseOfDeath } from "./bot-runner"
import type { CoopSim, SurvivorSlot } from "./coop-sim"
import { DEFAULT_PACING_TUNING } from "./pacing"
import { buildingAt } from "./progression/loot"
import { BOT_SKILL_PRESET_ORDER, type BotSkillPresetId } from "./survivor-bot"

/**
 * Difficulty-ramp playtest: survivor bots play fixed seeds while a read-only probe buckets what happened per elapsed
 * game hour, then `summarizeRamp` folds runs into per-phase curves (Evening, Night 1, Day 2, …) per skill preset.
 * `tests/difficulty-ramp.test.ts` holds the curves inside tolerance bands; `scripts/difficulty-ramp.ts` runs the full
 * batch and writes the report. See docs/outbreak-difficulty.md.
 */

export const RAMP_PHASE_LABELS = [
  "Evening",
  "Night 1",
  "Day 2",
  "Night 2",
  "Day 3",
  "Night 3",
  "Day 4",
  "Night 4",
  "Day 5",
  "Night 5",
] as const

/** Phase index from elapsed game hours: 0 is the evening before the first 18:00, then nights are odd, days even. */
export function rampPhaseIndex(elapsedHours: number, startHour = DEFAULT_PACING_TUNING.startHour): number {
  const evening = Math.max(0, 18 - startHour)
  if (elapsedHours < evening) return 0
  return 1 + Math.floor((elapsedHours - evening) / 12)
}

export const isNightPhase = (phase: number): boolean => phase % 2 === 1

/** Hour bucket from elapsed game hours, aligned to phase boundaries: 0 is the evening, then one per game hour. */
export function rampHourIndex(elapsedHours: number, startHour = DEFAULT_PACING_TUNING.startHour): number {
  const evening = Math.max(0, 18 - startHour)
  if (elapsedHours < evening) return 0
  return 1 + Math.floor(elapsedHours - evening)
}

/** Phase of an hour bucket. */
export const rampPhaseOfHour = (hour: number): number => (hour === 0 ? 0 : 1 + Math.floor((hour - 1) / 12))

/** Clock hour (0..24) at the start of an hour bucket. */
export const rampClockOfHour = (hour: number, startHour = DEFAULT_PACING_TUNING.startHour): number =>
  hour === 0 ? startHour : (18 + hour - 1) % 24

/**
 * Sim seconds a solo run needs to reach the dawn that ends night `n` at the default clock (17:30 start, 30 s evening
 * at the opening clock, 15 s per game hour after), plus a few seconds of the next day.
 */
export const secondsToDawn = (n: number): number => 30 + 180 * (2 * n - 1) + 5

export type RampHour = {
  /** Hour bucket (`rampHourIndex`): 0 is the evening, 1 is 18:00–19:00 of Night 1, and so on. */
  hour: number
  phase: number
  /** Sim seconds the lead survivor was alive in this hour. */
  seconds: number
  /** Mean living zombies. */
  living: number
  /** Mean zombies aware of a survivor (investigating, alerted, chasing, bashing or searching). */
  aware: number
  /** Mean director-counted active chasers. */
  chasers: number
  /** Fraction of the time the lead survivor was inside a building, and hidden in a closet. */
  indoors: number
  hidden: number
  /** Separate damage events on the lead survivor (ticks with damage after a tick without). */
  hits: number
  damage: number
  healed: number
  kills: number
  /** Levels at the end of the hour. */
  ammo: number
  meds: number
  battery: number
  spareBatteries: number
  planks: number
  ammoFound: number
  ammoSpent: number
  medsFound: number
  medsUsed: number
  batteriesFound: number
  batteriesUsed: number
}

export type RampRun = {
  seed: number
  preset: BotSkillPresetId
  survived: boolean
  survivalSeconds: number
  nightsSurvived: number
  causeOfDeath: CauseOfDeath
  /** Elapsed game hours at death, null when the bot lived to the end. */
  deathHours: number | null
  deathPhase: number | null
  endHours: number
  hours: RampHour[]
}

const emptyHour = (hour: number, phase: number): RampHour => ({
  hour,
  phase,
  seconds: 0,
  living: 0,
  aware: 0,
  chasers: 0,
  indoors: 0,
  hidden: 0,
  hits: 0,
  damage: 0,
  healed: 0,
  kills: 0,
  ammo: 0,
  meds: 0,
  battery: 0,
  spareBatteries: 0,
  planks: 0,
  ammoFound: 0,
  ammoSpent: 0,
  medsFound: 0,
  medsUsed: 0,
  batteriesFound: 0,
  batteriesUsed: 0,
})

/** Runs one headless bot game with the ramp probe attached. The bot run itself is unchanged by the probe. */
export function runRampProbe(config: BotRunConfig): RampRun {
  const hours: RampHour[] = []
  const startHour = DEFAULT_PACING_TUNING.startHour
  let prev: { health: number; ammo: number; meds: number; spare: number } | null = null
  let wasHit = false
  let deathHours: number | null = null
  let lastElapsed = 0
  const dead = new Set<number>()
  const observe = (sim: CoopSim, slots: readonly SurvivorSlot[], dt: number) => {
    const slot = slots[0]!
    const p = slot.survivor
    lastElapsed = sim.elapsedHours
    if (deathHours !== null) return
    const index = rampHourIndex(sim.elapsedHours, startHour)
    while (hours.length <= index) hours.push(emptyHour(hours.length, rampPhaseOfHour(hours.length)))
    const h = hours[index]!
    let living = 0
    let aware = 0
    for (const a of sim.ai.agents) {
      if (a.state === "dead") {
        if (!dead.has(a.id)) {
          dead.add(a.id)
          h.kills++
        }
        continue
      }
      living++
      if (a.state !== "wander" && a.state !== "stagger" && a.state !== "knockdown" && a.state !== "crawler") aware++
    }
    const ledger = sim.progression.ledger
    const ammo = p.magAmmo + p.reserveAmmo
    const meds = ledger.count(slot.id, "medkit") + ledger.count(slot.id, "bandage")
    const spare = ledger.count(slot.id, "battery")
    h.seconds += dt
    h.living += living * dt
    h.aware += aware * dt
    h.chasers += sim.ai.pacing.telemetry.activeChasers * dt
    if (buildingAt(sim.town, p.x, p.y)) h.indoors += dt
    if (sim.progression.verbs.hiddenIn(slot.id)) h.hidden += dt
    if (prev) {
      const dHealth = p.health - prev.health
      if (dHealth < 0) {
        h.damage -= dHealth
        if (!wasHit) h.hits++
      } else if (dHealth > 0) h.healed += dHealth
      wasHit = dHealth < 0
      const dAmmo = ammo - prev.ammo
      if (dAmmo > 0) h.ammoFound += dAmmo
      else h.ammoSpent -= dAmmo
      const dMeds = meds - prev.meds
      if (dMeds > 0) h.medsFound += dMeds
      else h.medsUsed -= dMeds
      const dSpare = spare - prev.spare
      if (dSpare > 0) h.batteriesFound += dSpare
      else h.batteriesUsed -= dSpare
    }
    prev = { health: p.health, ammo, meds, spare }
    h.ammo = ammo
    h.meds = meds
    h.battery = p.battery
    h.spareBatteries = spare
    h.planks = p.planks
    if (p.health <= 0) deathHours = sim.elapsedHours
  }
  const run = runHeadlessBotGame({ ...config, observe })
  for (const h of hours) {
    if (h.seconds <= 0) continue
    h.living /= h.seconds
    h.aware /= h.seconds
    h.chasers /= h.seconds
    h.indoors /= h.seconds
    h.hidden /= h.seconds
  }
  return {
    seed: run.seed,
    preset: run.preset,
    survived: run.survived,
    survivalSeconds: run.survivalTime,
    nightsSurvived: run.nightsSurvived,
    causeOfDeath: run.causeOfDeath,
    deathHours,
    deathPhase: deathHours === null ? null : rampPhaseIndex(deathHours, startHour),
    endHours: lastElapsed,
    hours: hours.filter((h) => h.seconds > 0),
  }
}

export type RampPhaseStats = {
  phase: number
  label: string
  night: boolean
  /** Runs alive when the phase began. */
  entered: number
  /** Fraction of all runs alive at the end of the phase (survival curve). */
  aliveAtEnd: number
  /** Deaths during the phase, as a fraction of runs that entered it. */
  deathRate: number
  /** Means over runs alive in the phase, weighted by time alive. */
  living: number
  aware: number
  chasers: number
  indoors: number
  hidden: number
  hitsPerMin: number
  damagePerHour: number
  killsPerHour: number
  /** Mean levels at the end of the phase among runs still alive. */
  ammo: number
  meds: number
  battery: number
  spareBatteries: number
  /** Totals per entered run over the phase. */
  ammoFound: number
  ammoSpent: number
  medsFound: number
  medsUsed: number
  batteriesFound: number
  batteriesUsed: number
}

export type RampPresetSummary = {
  preset: BotSkillPresetId
  runs: number
  survivedAll: number
  medianNights: number
  /** Median elapsed game hours at death over runs that died (null if none died). */
  medianDeathHours: number | null
  deathsByPhase: number[]
  causes: Record<string, number>
  phases: RampPhaseStats[]
}

export type RampSummary = {
  phases: number
  byPreset: Partial<Record<BotSkillPresetId, RampPresetSummary>>
}

const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

const round = (v: number, d = 3) => Number(v.toFixed(d))

/** Phase end in elapsed game hours. */
const phaseEndHours = (phase: number, startHour = DEFAULT_PACING_TUNING.startHour) =>
  Math.max(0, 18 - startHour) + 12 * phase

/** Folds runs into per-phase curves per preset. Phases a run never reached (time cap) count as neither alive nor dead. */
export function summarizeRamp(runs: readonly RampRun[], phases: number): RampSummary {
  const byPreset: RampSummary["byPreset"] = {}
  for (const preset of BOT_SKILL_PRESET_ORDER) {
    const mine = runs.filter((r) => r.preset === preset)
    if (mine.length === 0) continue
    const deathsByPhase = new Array<number>(phases).fill(0)
    const causes: Record<string, number> = {}
    for (const r of mine) {
      causes[r.causeOfDeath] = (causes[r.causeOfDeath] ?? 0) + 1
      if (r.deathPhase !== null && r.deathPhase < phases) deathsByPhase[r.deathPhase]!++
    }
    const stats: RampPhaseStats[] = []
    for (let phase = 0; phase < phases; phase++) {
      const entered = mine.filter((r) => r.deathPhase === null || r.deathPhase >= phase)
      const aliveAtEnd = mine.filter((r) =>
        r.deathPhase === null ? r.endHours >= phaseEndHours(phase) - 0.01 : r.deathPhase > phase,
      )
      let seconds = 0
      const acc = emptyHour(0, phase)
      for (const r of entered) {
        for (const h of r.hours) {
          if (h.phase !== phase) continue
          seconds += h.seconds
          acc.living += h.living * h.seconds
          acc.aware += h.aware * h.seconds
          acc.chasers += h.chasers * h.seconds
          acc.indoors += h.indoors * h.seconds
          acc.hidden += h.hidden * h.seconds
          acc.hits += h.hits
          acc.damage += h.damage
          acc.kills += h.kills
          acc.ammoFound += h.ammoFound
          acc.ammoSpent += h.ammoSpent
          acc.medsFound += h.medsFound
          acc.medsUsed += h.medsUsed
          acc.batteriesFound += h.batteriesFound
          acc.batteriesUsed += h.batteriesUsed
        }
      }
      const ends = aliveAtEnd
        .map((r) => [...r.hours].reverse().find((h) => h.phase === phase))
        .filter((h): h is RampHour => h !== undefined)
      const endMean = (key: "ammo" | "meds" | "battery" | "spareBatteries") =>
        ends.length ? round(ends.reduce((a, h) => a + h[key], 0) / ends.length, 2) : 0
      const n = Math.max(1, entered.length)
      const gameHours = seconds / 15
      stats.push({
        phase,
        label: RAMP_PHASE_LABELS[phase] ?? `Phase ${phase}`,
        night: isNightPhase(phase),
        entered: entered.length,
        aliveAtEnd: round(aliveAtEnd.length / mine.length),
        deathRate: entered.length ? round(deathsByPhase[phase]! / entered.length) : 0,
        living: seconds ? round(acc.living / seconds, 2) : 0,
        aware: seconds ? round(acc.aware / seconds, 2) : 0,
        chasers: seconds ? round(acc.chasers / seconds, 2) : 0,
        indoors: seconds ? round(acc.indoors / seconds, 2) : 0,
        hidden: seconds ? round(acc.hidden / seconds, 2) : 0,
        hitsPerMin: seconds ? round((acc.hits / seconds) * 60, 2) : 0,
        damagePerHour: gameHours ? round(acc.damage / gameHours, 2) : 0,
        killsPerHour: gameHours ? round(acc.kills / gameHours, 2) : 0,
        ammo: endMean("ammo"),
        meds: endMean("meds"),
        battery: endMean("battery"),
        spareBatteries: endMean("spareBatteries"),
        ammoFound: round(acc.ammoFound / n, 2),
        ammoSpent: round(acc.ammoSpent / n, 2),
        medsFound: round(acc.medsFound / n, 2),
        medsUsed: round(acc.medsUsed / n, 2),
        batteriesFound: round(acc.batteriesFound / n, 2),
        batteriesUsed: round(acc.batteriesUsed / n, 2),
      })
    }
    const deathHours = mine.filter((r) => r.deathHours !== null).map((r) => r.deathHours!)
    byPreset[preset] = {
      preset,
      runs: mine.length,
      survivedAll: mine.filter((r) => r.survived).length,
      medianNights: round(median(mine.map((r) => r.nightsSurvived))),
      medianDeathHours: deathHours.length ? round(median(deathHours), 2) : null,
      deathsByPhase,
      causes,
      phases: stats,
    }
  }
  return { phases, byPreset }
}

export type RampHourCurve = {
  hour: number
  phase: number
  clock: number
  /** Fraction of runs alive (and not yet capped) in this hour. */
  alive: number
  living: number
  aware: number
  chasers: number
  indoors: number
  hidden: number
  hitsPerMin: number
  damage: number
  ammo: number
  meds: number
  battery: number
}

/** Mean per-hour curves for one preset over the runs alive in each hour. */
export function rampHourCurves(runs: readonly RampRun[], preset: BotSkillPresetId, hours: number): RampHourCurve[] {
  const mine = runs.filter((r) => r.preset === preset)
  const out: RampHourCurve[] = []
  for (let hour = 0; hour < hours; hour++) {
    const present = mine.map((r) => r.hours.find((h) => h.hour === hour)).filter((h): h is RampHour => h !== undefined)
    const mean = (f: (h: RampHour) => number, d = 2) =>
      present.length ? round(present.reduce((a, h) => a + f(h), 0) / present.length, d) : 0
    out.push({
      hour,
      phase: rampPhaseOfHour(hour),
      clock: rampClockOfHour(hour),
      alive: mine.length ? round(present.length / mine.length) : 0,
      living: mean((h) => h.living),
      aware: mean((h) => h.aware),
      chasers: mean((h) => h.chasers),
      indoors: mean((h) => h.indoors),
      hidden: mean((h) => h.hidden),
      hitsPerMin: mean((h) => (h.seconds ? (h.hits / h.seconds) * 60 : 0)),
      damage: mean((h) => h.damage),
      ammo: mean((h) => h.ammo),
      meds: mean((h) => h.meds),
      battery: mean((h) => h.battery),
    })
  }
  return out
}
