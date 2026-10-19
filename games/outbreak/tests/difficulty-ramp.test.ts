import { describe, expect, test } from "bun:test"
import { availableParallelism } from "node:os"
import { runRampBatch } from "../scripts/difficulty-ramp-pool"
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

/** Fraction of runs alive at dawn 1 and dawn 3, per preset. Values on 2026-10-19 main: see comments. */
const SURVIVAL_BANDS: Record<BotSkillPresetId, { dawn1: [number, number]; dawn3: [number, number] }> = {
  Novice: { dawn1: [0, 0.75], dawn3: [0, 0.5] }, // 0, 0
  Casual: { dawn1: [0.5, 1], dawn3: [0, 0.75] }, // 0.75, 0.25
  Skilled: { dawn1: [0.75, 1], dawn3: [0.25, 1] }, // 1, 0.5
  Expert: { dawn1: [0.75, 1], dawn3: [0.25, 1] }, // 1, 0.75
  Perfect: { dawn1: [0, 1], dawn3: [0, 1] },
}

/** Pooled over Casual, Skilled and Expert while alive. Values on 2026-10-19 main in comments. */
const PRESSURE_BANDS = {
  /** Night 1 living zombies over the evening's (≈ 5×): the director ramps in. */
  nightOneRampIn: [3, 10], // 5.5
  /** Night 2 living zombies (the director's full population is 16 solo). */
  nightTwoLiving: [12, 24], // 16.0
  /** Aware zombies at night over the day before it: nights are harder than days. */
  nightOverDay2: [1.3, 5], // 1.9
  nightOverDay3: [1.2, 5], // 1.51
  /** Aware zombies, Night 3 over Night 2: no cliff either way. Today this is flat (see D-40). */
  nightThreeOverTwo: [0.8, 1.8], // 1.03
  /** Active chasers at night (the director's solo cap is 3). */
  nightChasers: [1, 3.5], // 2.37 (Night 2), 2.56 (Night 3)
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
      runs = await runRampBatch(jobs, Math.max(1, Math.min(4, availableParallelism())))
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

  test("pressure ramps in, nights beat days, and there is no cliff", () => {
    within("Night 1 / evening living zombies", pooled(NIGHT1, "living") / pooled(EVENING, "living"), PRESSURE_BANDS.nightOneRampIn)
    within("Night 2 living zombies", pooled(NIGHT2, "living"), PRESSURE_BANDS.nightTwoLiving)
    within("Night 2 / Day 2 aware zombies", pooled(NIGHT2, "aware") / pooled(DAY2, "aware"), PRESSURE_BANDS.nightOverDay2)
    within("Night 3 / Day 3 aware zombies", pooled(NIGHT3, "aware") / pooled(DAY3, "aware"), PRESSURE_BANDS.nightOverDay3)
    within("Night 3 / Night 2 aware zombies", pooled(NIGHT3, "aware") / pooled(NIGHT2, "aware"), PRESSURE_BANDS.nightThreeOverTwo)
    within("Night 2 chasers", pooled(NIGHT2, "chasers"), PRESSURE_BANDS.nightChasers)
    within("Night 3 chasers", pooled(NIGHT3, "chasers"), PRESSURE_BANDS.nightChasers)
  })
})
