import { describe, expect, test } from "bun:test"
import { availableParallelism } from "node:os"
import { runCoopBatch, runRampBatch } from "../scripts/difficulty-ramp-pool"
import { COOP_TIME_SCALE } from "../shared/coop-config"
import { COOP_EARLY_SECONDS, COOP_OPENING_SECONDS, summarizeCoop, type CoopRun, type CoopSummary } from "../shared/coop-ramp"
import { runRampProbe, secondsToDawn, summarizeRamp, type RampPhaseStats, type RampRun } from "../shared/difficulty-ramp"
import type { BotSkillPresetId } from "../shared/survivor-bot"

// Fast difficulty-ramp playtest: four bot skill presets play four fixed seeds to dawn 3 on up to four workers
// (~3 s on an M-series Mac, ~20 s on a CI runner).
// The bands are deliberately loose: they catch a broken director (no ramp, runaway spawns, a cliff), not small tuning
// drift, and they leave room for float differences between machines. When a deliberate tuning change moves a curve
// out of its band, run `bun scripts/difficulty-ramp.ts` for the full picture, then update the band here in the same
// PR and say why (docs/outbreak-difficulty.md).

const SEEDS = [101, 107, 113, 119]
const PRESETS: readonly BotSkillPresetId[] = ["Novice", "Casual", "Skilled", "Expert"]
const NIGHTS = 3
const PHASES = NIGHTS * 2
const [EVENING, NIGHT1, DAY2, NIGHT2, DAY3, NIGHT3] = [0, 1, 2, 3, 4, 5]

/**
 * Fraction of runs alive at dawn 1 and dawn 3, per preset. Values with the D-40 night ramp (Gentle Start, Rising) in
 * comments; Today's (night ramp off) in brackets. AR-65 (zombies no longer wedge in doorways) moved Skilled dawn 3 from
 * 0.5 to 0.25 and Expert's from 1 to 0.75: houses stopped being a free fortress. Bands unchanged.
 */
const SURVIVAL_BANDS: Record<BotSkillPresetId, { dawn1: [number, number]; dawn3: [number, number] }> = {
  Novice: { dawn1: [0, 0.75], dawn3: [0, 0.5] }, // 0, 0 [0, 0]
  Casual: { dawn1: [0.5, 1], dawn3: [0, 0.75] }, // 1, 0 [0.5, 0.25]
  Skilled: { dawn1: [0.75, 1], dawn3: [0.25, 1] }, // 1, 0.25 [1, 0.75]
  Expert: { dawn1: [0.75, 1], dawn3: [0.25, 1] }, // 1, 0.75 [1, 1]
  Perfect: { dawn1: [0, 1], dawn3: [0, 1] },
}

/**
 * Pooled over Casual, Skilled and Expert while alive. Values with the D-40 night ramp in comments, Today's in
 * brackets. The Night 1 hold, Night 2 population, Night 3 over Night 2 and Night 3 chaser bands fail with the night
 * ramp off: they are what D-40 asked for.
 */
const PRESSURE_BANDS = {
  /** Night 1 living zombies over the evening's: the director ramps in. */
  nightOneRampIn: [2.5, 10], // 3.9 [5.5]
  /** Night 1 chasers: the night ramp holds Night 1 to 2. */
  nightOneChasers: [0.3, 2], // 1.10 [2.23]
  /** Night 2 living zombies: above the director's own 16. */
  nightTwoLiving: [17, 26], // 19.0 [16.0]
  /** Living zombies, Night 3 over Night 2: still rising. */
  nightThreeLivingOverTwo: [1.05, 1.6], // 1.16 [1.0]
  /** Aware zombies at night over the day before it: nights are harder than days. */
  nightOverDay2: [1.3, 5], // 2.33 [1.9]
  nightOverDay3: [1.2, 5], // 2.19 [1.51]
  /**
   * Aware zombies, Night 3 over Night 2: rising, without a cliff. AR-71 weather: rain masks noise, and two of the four
   * seeds rain or storm through Night 3 at this clock, so fewer of the dead turn: 1.17 with the weather off, 1.08 on.
   * The lower bound moved from 1.1 to 1.0 for that; living zombies and chasers still rise (the next two bands).
   * AR-91 zombie behaviour (followers, memory and search) puts more of the dead on the hunt from Night 2 (aware
   * 5.8 → 7.2), so the ratio flattens: 1.06 here, 0.95–1.00 on earlier trees, 1.10 Today. The lower bound moved from
   * 1.0 to 0.9 so that flattening is not read as a cliff; living zombies and chasers still rise.
   */
  nightThreeOverTwo: [0.9, 2], // 1.06 (behaviour on; 1.10 Today) [1.03]
  /** Active chasers at night. */
  nightTwoChasers: [1.5, 4], // 2.89 [2.37]
  nightThreeChasers: [3, 5.5], // 3.94 [2.56]
} as const

const within = (name: string, value: number, [lo, hi]: readonly [number, number]) => {
  const ok = value >= lo - 1e-9 && value <= hi + 1e-9
  if (!ok) throw new Error(`${name} = ${value.toFixed(3)} is outside its band [${lo}, ${hi}] (see tests/difficulty-ramp.test.ts)`)
}

describe("difficulty ramp (survivor bots, fixed seeds)", () => {
  let runs: RampRun[] = []
  const phase = (preset: BotSkillPresetId, p: number): RampPhaseStats =>
    summarizeRamp(runs, PHASES).byPreset[preset]!.phases[p]!
  const pooled = (p: number, key: "living" | "aware" | "chasers") => {
    const alive = (["Casual", "Skilled", "Expert"] as const).map((preset) => phase(preset, p)).filter((s) => s.entered > 0)
    return alive.reduce((a, s) => a + s[key], 0) / Math.max(1, alive.length)
  }

  test(
    "plays the batch deterministically",
    async () => {
      const jobs = PRESETS.flatMap((preset) =>
        SEEDS.map((seed) => ({ seed, preset, maxDurationSeconds: secondsToDawn(NIGHTS), timeScale: 240, tickDt: 1 / 15 })),
      )
      const workers = Number(process.env.OUTBREAK_RAMP_WORKERS ?? 4)
      if (!Number.isInteger(workers) || workers < 1) throw new Error("OUTBREAK_RAMP_WORKERS must be a positive integer")
      runs = await runRampBatch(jobs, Math.max(1, Math.min(4, workers, availableParallelism())))
      expect(runs).toHaveLength(PRESETS.length * SEEDS.length)
      const again = runRampProbe({ seed: SEEDS[0]!, preset: "Casual", maxDurationSeconds: 240, timeScale: 240, tickDt: 1 / 15 })
      const first = runs.find((r) => r.preset === "Casual" && r.seed === SEEDS[0])!
      expect(again.hours.slice(0, 8)).toEqual(first.hours.slice(0, 8))
    },
    120_000,
  )

  test("nobody dies in the opening evening", () => {
    for (const preset of PRESETS) expect(phase(preset, EVENING).deathRate).toBe(0)
  })

  test("survival per preset stays inside its bands", () => {
    const summary = summarizeRamp(runs, PHASES)
    for (const preset of PRESETS) {
      const s = summary.byPreset[preset]!
      within(`${preset} alive at dawn 1`, s.phases[NIGHT1]!.aliveAtEnd, SURVIVAL_BANDS[preset].dawn1)
      within(`${preset} alive at dawn 3`, s.phases[NIGHT3]!.aliveAtEnd, SURVIVAL_BANDS[preset].dawn3)
    }
    const nights = (p: BotSkillPresetId) => summary.byPreset[p]!.medianNights
    expect(nights("Novice")).toBeLessThan(nights("Skilled"))
    expect(nights("Novice")).toBeLessThan(nights("Expert"))
    expect(phase("Novice", NIGHT1).damagePerHour).toBeGreaterThan(phase("Skilled", NIGHT1).damagePerHour)
  })

  test("Night 1 holds, then every night rises without a cliff (D-40)", () => {
    within("Night 1 / evening living zombies", pooled(NIGHT1, "living") / pooled(EVENING, "living"), PRESSURE_BANDS.nightOneRampIn)
    within("Night 1 chasers", pooled(NIGHT1, "chasers"), PRESSURE_BANDS.nightOneChasers)
    within("Night 2 living zombies", pooled(NIGHT2, "living"), PRESSURE_BANDS.nightTwoLiving)
    within("Night 3 / Night 2 living zombies", pooled(NIGHT3, "living") / pooled(NIGHT2, "living"), PRESSURE_BANDS.nightThreeLivingOverTwo)
    within("Night 2 / Day 2 aware zombies", pooled(NIGHT2, "aware") / pooled(DAY2, "aware"), PRESSURE_BANDS.nightOverDay2)
    within("Night 3 / Day 3 aware zombies", pooled(NIGHT3, "aware") / pooled(DAY3, "aware"), PRESSURE_BANDS.nightOverDay3)
    within("Night 3 / Night 2 aware zombies", pooled(NIGHT3, "aware") / pooled(NIGHT2, "aware"), PRESSURE_BANDS.nightThreeOverTwo)
    within("Night 2 chasers", pooled(NIGHT2, "chasers"), PRESSURE_BANDS.nightTwoChasers)
    within("Night 3 chasers", pooled(NIGHT3, "chasers"), PRESSURE_BANDS.nightThreeChasers)
  })
})

/**
 * Co-op (AR-92): Skilled bots, 1/2/4/6 survivors, the evening and Night 1 at the co-op clock. Values with the
 * sub-linear co-op curve in comments; Today's (linear) in brackets. Bots never revive, so a down is a loss here.
 */
const COOP_SEEDS = [101, 107, 113, 119]
const COOP_PLAYERS = [1, 2, 4, 6] as const
const COOP_BANDS = {
  /** Share of survivors ever down by dawn 1, per squad size. */
  down: { 2: [0, 0.3], 4: [0, 0.3], 6: [0, 0.3] }, // 0.13, 0.06, 0.04 [0.25, 0.19, 0.21]
  /** Night 1 mean chasers: Gentle Start's hold grows by a chaser or so with the squad, not by 2.8–4×. */
  nightOneChasers: { 2: [0.3, 2.2], 4: [0.8, 3.2], 6: [0.8, 3.2] }, // 1.78, 2.73, 2.94 [2.77, 5.56, 7.83]
  /** Night 1 living zombies over the solo run's: sub-linear in the squad. */
  nightOneLiving: { 2: [1.1, 1.6], 4: [1.3, 2.0], 6: [1.5, 2.4] }, // 1.39, 1.69, 1.99 [1.40, 2.09, 2.88]
} as const

describe("co-op difficulty (survivor bots, the opening at the co-op clock)", () => {
  let runs: CoopRun[] = []
  const summary = (players: number): CoopSummary => summarizeCoop(runs.filter((r) => r.players === players), COOP_EARLY_SECONDS)

  test(
    "plays the co-op batch",
    async () => {
      const jobs = COOP_PLAYERS.flatMap((playerCount) =>
        COOP_SEEDS.map((seed) => ({ seed, preset: "Skilled" as const, playerCount, maxDurationSeconds: COOP_OPENING_SECONDS, timeScale: COOP_TIME_SCALE, tickDt: 1 / 15 })),
      )
      const workers = Number(process.env.OUTBREAK_RAMP_WORKERS ?? 4)
      runs = await runCoopBatch(jobs, Math.max(1, Math.min(4, workers, availableParallelism())))
      expect(runs).toHaveLength(jobs.length)
    },
    120_000,
  )

  /**
   * Survivors down in the first 120 s (the evening and two game hours): 0, 0, 0, 0.04 [0, 0, 0, 0.08]. The one left is
   * a Skilled bot that wandered 20 m from the squad with all three of Night 1's chasers on it.
   */
  test("a squad's opening stays calm", () => {
    for (const n of COOP_PLAYERS) within(`${n} survivors down in the first ${COOP_EARLY_SECONDS} s`, summary(n).earlySurvivorDownRate, [0, 0.05])
  })

  test("each squad size stays inside its bands", () => {
    const solo = summary(1)
    for (const n of [2, 4, 6] as const) {
      const s = summary(n)
      within(`${n} survivors down by dawn 1`, s.downRate, COOP_BANDS.down[n])
      within(`${n} survivors Night 1 chasers`, s.phases[NIGHT1]!.chasers, COOP_BANDS.nightOneChasers[n])
      within(`${n} survivors Night 1 living / solo`, s.phases[NIGHT1]!.living / solo.phases[NIGHT1]!.living, COOP_BANDS.nightOneLiving[n])
      expect(s.phases[NIGHT1]!.peakChasers).toBeLessThanOrEqual(3)
      // No new zombie appears beside a survivor (director spawns keep 22 m; Lurkers wait in dark rooms ≥10 m away).
      // 0, 0, 0 [1.75, 3.25, 2.75 a run]
      expect(s.spawnsWithin20).toBeLessThanOrEqual(0.5)
    }
    // Specials don't multiply with the squad: 0, 0.03, 0.45, 0.6 alive on Night 1 [0, 0.04, 0.92, 0.81].
    within("6 survivors Night 1 specials", summary(6).phases[NIGHT1]!.specials, [0, 0.75])
  })
})
