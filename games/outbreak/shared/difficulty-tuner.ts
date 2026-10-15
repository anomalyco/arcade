import { Rng } from "@arcade/kit/sim/rng"
import { DEFAULT_AI_CONFIG, type AIConfig } from "./ai"
import { runHeadlessBotGame, type BotRunResult } from "./bot-runner"
import { DEFAULT_PROGRESSION_TUNING, type ProgressionTuning } from "./progression"
import { BOT_SKILL_PRESET_ORDER, type BotSkillPresetId } from "./survivor-bot"

export type DifficultyKnobKey =
  | "zombieCount"
  | "initialDensity"
  | "rampTime"
  | "safeRadius"
  | "sightRange"
  | "hearingScale"
  | "noiseSensitivity"
  | "chaseSpeed"
  | "aggression"
  | "nightMultiplier"
  | "maxActiveNearPlayer"
  | "lootRate"

export type DifficultyVector = Record<DifficultyKnobKey, number>

export type KnobSpec = {
  key: DifficultyKnobKey
  label: string
  unit: string
  min: number
  max: number
  step: number
  defaultValue: number
  integer?: boolean
}

export const DIFFICULTY_KNOB_SPECS: readonly KnobSpec[] = [
  { key: "zombieCount", label: "Zombie population", unit: "", min: 16, max: 52, step: 1, defaultValue: DEFAULT_AI_CONFIG.zombieCount, integer: true },
  { key: "initialDensity", label: "Initial density", unit: "×", min: 0.1, max: 0.55, step: 0.05, defaultValue: DEFAULT_AI_CONFIG.initialDensity },
  { key: "rampTime", label: "Ramp time", unit: "s", min: 180, max: 600, step: 15, defaultValue: DEFAULT_AI_CONFIG.rampTime, integer: true },
  { key: "safeRadius", label: "Safe radius", unit: "m", min: 14, max: 30, step: 1, defaultValue: DEFAULT_AI_CONFIG.safeRadius, integer: true },
  { key: "sightRange", label: "Sight range", unit: "m", min: 12, max: 26, step: 1, defaultValue: DEFAULT_AI_CONFIG.sightRange, integer: true },
  { key: "hearingScale", label: "Hearing scale", unit: "×", min: 0.6, max: 1.6, step: 0.05, defaultValue: DEFAULT_AI_CONFIG.hearingScale },
  { key: "noiseSensitivity", label: "Noise sensitivity", unit: "×", min: 0.5, max: 1.8, step: 0.05, defaultValue: DEFAULT_AI_CONFIG.noiseSensitivity },
  { key: "chaseSpeed", label: "Chase speed", unit: "m/s", min: 2.1, max: 3.2, step: 0.05, defaultValue: DEFAULT_AI_CONFIG.chaseSpeed },
  { key: "aggression", label: "Aggression", unit: "×", min: 0.65, max: 1.55, step: 0.05, defaultValue: DEFAULT_AI_CONFIG.aggression },
  { key: "nightMultiplier", label: "Night boost", unit: "×", min: 1.1, max: 1.65, step: 0.05, defaultValue: DEFAULT_AI_CONFIG.nightMultiplier },
  { key: "maxActiveNearPlayer", label: "Max active chasers", unit: "", min: 2, max: 8, step: 1, defaultValue: DEFAULT_AI_CONFIG.maxActiveNearPlayer, integer: true },
  { key: "lootRate", label: "Loot rate", unit: "×", min: 0.65, max: 1.6, step: 0.05, defaultValue: DEFAULT_PROGRESSION_TUNING.lootRate },
] as const

export const DEFAULT_DIFFICULTY_VECTOR: DifficultyVector = {
  zombieCount: DEFAULT_AI_CONFIG.zombieCount,
  initialDensity: DEFAULT_AI_CONFIG.initialDensity,
  rampTime: DEFAULT_AI_CONFIG.rampTime,
  safeRadius: DEFAULT_AI_CONFIG.safeRadius,
  sightRange: DEFAULT_AI_CONFIG.sightRange,
  hearingScale: DEFAULT_AI_CONFIG.hearingScale,
  noiseSensitivity: DEFAULT_AI_CONFIG.noiseSensitivity,
  chaseSpeed: DEFAULT_AI_CONFIG.chaseSpeed,
  aggression: DEFAULT_AI_CONFIG.aggression,
  nightMultiplier: DEFAULT_AI_CONFIG.nightMultiplier,
  maxActiveNearPlayer: DEFAULT_AI_CONFIG.maxActiveNearPlayer,
  lootRate: DEFAULT_PROGRESSION_TUNING.lootRate,
}

export type SkillTargetBand = {
  preset: BotSkillPresetId
  description: string
  targetMedianNights: number
  minMedianNights: number
  maxMedianNights: number
  targetNight1SurvivalRate: number
  maxEarlyEveningDeathRate: number
}

/**
 * Plain target survival curve defined prior to tuning:
 * - Novice survives the first evening (16:00–18:00) and dies during Night 1–2.
 * - Casual usually survives Night 1 and falls during Day 2 / Night 2.
 * - Skilled reaches Night 3–4.
 * - Expert rarely dies early and pushes deep into Night 3–4.
 */
export const TARGET_SURVIVAL_CURVE: Readonly<Record<BotSkillPresetId, SkillTargetBand>> = {
  Novice: {
    preset: "Novice",
    description: "Survives the first evening, dies during Night 1–2",
    targetMedianNights: 0.9,
    minMedianNights: 0.45,
    maxMedianNights: 1.45,
    targetNight1SurvivalRate: 0.35,
    maxEarlyEveningDeathRate: 0.12,
  },
  Casual: {
    preset: "Casual",
    description: "Usually survives Night 1, falls during Night 2",
    targetMedianNights: 1.6,
    minMedianNights: 1.15,
    maxMedianNights: 2.2,
    targetNight1SurvivalRate: 0.72,
    maxEarlyEveningDeathRate: 0.05,
  },
  Skilled: {
    preset: "Skilled",
    description: "Consistently reaches Night 3–4",
    targetMedianNights: 3.1,
    minMedianNights: 2.6,
    maxMedianNights: 3.7,
    targetNight1SurvivalRate: 0.9,
    maxEarlyEveningDeathRate: 0.0,
  },
  Expert: {
    preset: "Expert",
    description: "Rarely dies early; survives into late Night 3–4+",
    targetMedianNights: 3.7,
    minMedianNights: 3.25,
    maxMedianNights: 4.0,
    targetNight1SurvivalRate: 0.96,
    maxEarlyEveningDeathRate: 0.0,
  },
  Perfect: {
    preset: "Perfect",
    description: "Upper-bound reference bot; clears Night 4",
    targetMedianNights: 3.95,
    minMedianNights: 3.5,
    maxMedianNights: 4.0,
    targetNight1SurvivalRate: 1.0,
    maxEarlyEveningDeathRate: 0.0,
  },
}

/**
 * Left 4 Dead AI Director-style fun & pacing target parameters.
 * Exposed in the shared Lab panel (`'Pacing targets'` group), optimized by the difficulty tuner,
 * and included on the Problems board decision (`D-22`).
 */
export type PacingTargetKey =
  | "targetNoviceNights"
  | "targetCasualNights"
  | "targetSkilledNights"
  | "targetExpertNights"
  | "targetPeaksPerNight"
  | "minRelaxWindowSeconds"
  | "maxRelaxWindowSeconds"
  | "targetHighIntensityPct"
  | "targetCloseCallsPerNight"
  | "minDeathWarningSeconds"
  | "minWarnedDeathPct"

export type PacingTargetConfig = Record<PacingTargetKey, number>

export type PacingTargetSpec = {
  key: PacingTargetKey
  label: string
  unit: string
  min: number
  max: number
  step: number
  defaultValue: number
}

export const DEFAULT_PACING_TARGETS: PacingTargetConfig = {
  targetNoviceNights: 0.55,
  targetCasualNights: 1.6,
  targetSkilledNights: 3.1,
  targetExpertNights: 3.7,
  targetPeaksPerNight: 2.2,
  minRelaxWindowSeconds: 18,
  maxRelaxWindowSeconds: 95,
  targetHighIntensityPct: 26,
  targetCloseCallsPerNight: 1.2,
  minDeathWarningSeconds: 3.5,
  minWarnedDeathPct: 88,
}

export const PACING_TARGET_SPECS: readonly PacingTargetSpec[] = [
  { key: "targetNoviceNights", label: "Novice median survival", unit: "nights", min: 0.2, max: 2.0, step: 0.05, defaultValue: DEFAULT_PACING_TARGETS.targetNoviceNights },
  { key: "targetCasualNights", label: "Casual median survival", unit: "nights", min: 0.8, max: 3.0, step: 0.05, defaultValue: DEFAULT_PACING_TARGETS.targetCasualNights },
  { key: "targetSkilledNights", label: "Skilled median survival", unit: "nights", min: 1.5, max: 4.0, step: 0.05, defaultValue: DEFAULT_PACING_TARGETS.targetSkilledNights },
  { key: "targetExpertNights", label: "Expert median survival", unit: "nights", min: 2.5, max: 4.0, step: 0.05, defaultValue: DEFAULT_PACING_TARGETS.targetExpertNights },
  { key: "targetPeaksPerNight", label: "Tension peaks per night", unit: "/night", min: 0.8, max: 4.5, step: 0.1, defaultValue: DEFAULT_PACING_TARGETS.targetPeaksPerNight },
  { key: "minRelaxWindowSeconds", label: "Min relax window", unit: "s", min: 6, max: 45, step: 1, defaultValue: DEFAULT_PACING_TARGETS.minRelaxWindowSeconds },
  { key: "maxRelaxWindowSeconds", label: "Max relax window", unit: "s", min: 40, max: 180, step: 5, defaultValue: DEFAULT_PACING_TARGETS.maxRelaxWindowSeconds },
  { key: "targetHighIntensityPct", label: "High-intensity time", unit: "%", min: 10, max: 50, step: 1, defaultValue: DEFAULT_PACING_TARGETS.targetHighIntensityPct },
  { key: "targetCloseCallsPerNight", label: "Close calls per night", unit: "/night", min: 0.3, max: 3.0, step: 0.1, defaultValue: DEFAULT_PACING_TARGETS.targetCloseCallsPerNight },
  { key: "minDeathWarningSeconds", label: "Min death warning lead", unit: "s", min: 1.0, max: 10.0, step: 0.5, defaultValue: DEFAULT_PACING_TARGETS.minDeathWarningSeconds },
  { key: "minWarnedDeathPct", label: "Fair warned deaths", unit: "%", min: 60, max: 100, step: 1, defaultValue: DEFAULT_PACING_TARGETS.minWarnedDeathPct },
]

export const pacingTargetControls = PACING_TARGET_SPECS.map((s) => ({
  key: s.key,
  label: s.label,
  group: "Pacing targets",
  min: s.min,
  max: s.max,
  step: s.step,
  unit: s.unit,
}))

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export function quantizeDifficultyVector(raw: DifficultyVector): DifficultyVector {
  const out = { ...raw }
  for (const spec of DIFFICULTY_KNOB_SPECS) {
    const clamped = clamp(raw[spec.key], spec.min, spec.max)
    const stepped = Math.round(clamped / spec.step) * spec.step
    out[spec.key] = spec.integer ? Math.round(stepped) : Number(stepped.toFixed(3))
  }
  return out
}

export function difficultyToSimTunings(vec: DifficultyVector): {
  aiConfig: Partial<AIConfig>
  progressionTuning: Partial<ProgressionTuning>
} {
  const q = quantizeDifficultyVector(vec)
  return {
    aiConfig: {
      directorPacing: 1,
      zombieCount: q.zombieCount,
      initialDensity: q.initialDensity,
      rampTime: q.rampTime,
      safeRadius: q.safeRadius,
      sightRange: q.sightRange,
      hearingScale: q.hearingScale,
      noiseSensitivity: q.noiseSensitivity,
      chaseSpeed: q.chaseSpeed,
      aggression: q.aggression,
      nightMultiplier: q.nightMultiplier,
      maxActiveNearPlayer: q.maxActiveNearPlayer,
    },
    progressionTuning: {
      lootRate: q.lootRate,
    },
  }
}

export type PresetSurvivalSummary = {
  preset: BotSkillPresetId
  runs: number
  meanSurvivalTime: number
  medianSurvivalTime: number
  p25SurvivalTime: number
  p75SurvivalTime: number
  meanNights: number
  medianNights: number
  p25Nights: number
  p75Nights: number
  eveningSurvivalRate: number
  night1SurvivalRate: number
  night2SurvivalRate: number
  night3SurvivalRate: number
  night4SurvivalRate: number
  meanKills: number
  meanPeakChasers: number
  meanIntensity: number
  peakIntensity: number
  highIntensityFraction: number
  buildUpFraction: number
  relaxFraction: number
  meanPeaksPerNight: number
  meanMinRelaxWindowSeconds: number
  meanMaxRelaxWindowSeconds: number
  meanCloseCallsPerNight: number
  warnedDeathRate: number
  meanDeathWarningSeconds: number
  unfairSpawns: number
  causesOfDeath: Record<string, number>
}

export type DifficultyLossBreakdown = {
  total: number
  survivalCurveLoss: number
  pacingFunLoss: number
  monotonicityLoss: number
  fairnessLoss: number
}

export type CandidateEvaluation = {
  label: string
  vector: DifficultyVector
  loss: number
  lossBreakdown: DifficultyLossBreakdown
  pacingTargets: PacingTargetConfig
  byPreset: Record<BotSkillPresetId, PresetSurvivalSummary>
  runs: BotRunResult[]
}

const quantile = (xs: readonly number[], q: number): number => {
  if (xs.length === 0) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  const pos = (sorted.length - 1) * clamp(q, 0, 1)
  const base = Math.floor(pos)
  const rest = pos - base
  const next = sorted[Math.min(sorted.length - 1, base + 1)]!
  return Number((sorted[base]! + rest * (next - sorted[base]!)).toFixed(3))
}

const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? 0 : Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3))

export function summarizePresetRuns(
  preset: BotSkillPresetId,
  runs: readonly BotRunResult[],
): PresetSurvivalSummary {
  const times = runs.map((r) => r.survivalTime)
  const nights = runs.map((r) => r.nightsSurvived)
  const n = Math.max(1, runs.length)
  const causes: Record<string, number> = {}
  let unfair = 0
  let warnedCount = 0
  const deathWarnings: number[] = []
  for (const r of runs) {
    causes[r.causeOfDeath] = (causes[r.causeOfDeath] ?? 0) + 1
    unfair += r.unfairSpawns.inView + r.unfairSpawns.behindPlayer
    if (r.pacing?.warnedDeath ?? true) warnedCount++
    if (r.pacing?.deathWarningSeconds !== null && r.pacing?.deathWarningSeconds !== undefined) {
      deathWarnings.push(r.pacing.deathWarningSeconds)
    }
  }
  return {
    preset,
    runs: runs.length,
    meanSurvivalTime: mean(times),
    medianSurvivalTime: quantile(times, 0.5),
    p25SurvivalTime: quantile(times, 0.25),
    p75SurvivalTime: quantile(times, 0.75),
    meanNights: mean(nights),
    medianNights: quantile(nights, 0.5),
    p25Nights: quantile(nights, 0.25),
    p75Nights: quantile(nights, 0.75),
    eveningSurvivalRate: Number((runs.filter((r) => r.nightsSurvived >= 0.15).length / n).toFixed(3)),
    night1SurvivalRate: Number((runs.filter((r) => r.nightsSurvived >= 1.0).length / n).toFixed(3)),
    night2SurvivalRate: Number((runs.filter((r) => r.nightsSurvived >= 2.0).length / n).toFixed(3)),
    night3SurvivalRate: Number((runs.filter((r) => r.nightsSurvived >= 3.0).length / n).toFixed(3)),
    night4SurvivalRate: Number((runs.filter((r) => r.nightsSurvived >= 3.85).length / n).toFixed(3)),
    meanKills: mean(runs.map((r) => r.killsByWeapon.total)),
    meanPeakChasers: mean(runs.map((r) => r.peakSimultaneousChasers)),
    meanIntensity: mean(runs.map((r) => r.pacing?.meanIntensity ?? 0.2)),
    peakIntensity: mean(runs.map((r) => r.pacing?.peakIntensity ?? 0.5)),
    highIntensityFraction: mean(runs.map((r) => r.pacing?.highIntensityFraction ?? 0.2)),
    buildUpFraction: mean(runs.map((r) => r.pacing?.buildUpFraction ?? 0.3)),
    relaxFraction: mean(runs.map((r) => r.pacing?.relaxFraction ?? 0.5)),
    meanPeaksPerNight: mean(runs.map((r) => r.pacing?.peaksPerNight ?? 2.0)),
    meanMinRelaxWindowSeconds: mean(runs.map((r) => r.pacing?.minRelaxWindowSeconds ?? 20)),
    meanMaxRelaxWindowSeconds: mean(runs.map((r) => r.pacing?.maxRelaxWindowSeconds ?? 80)),
    meanCloseCallsPerNight: mean(runs.map((r) => r.pacing?.closeCallsPerNight ?? 1.0)),
    warnedDeathRate: Number((warnedCount / n).toFixed(3)),
    meanDeathWarningSeconds: deathWarnings.length > 0 ? mean(deathWarnings) : 6.0,
    unfairSpawns: unfair,
    causesOfDeath: causes,
  }
}

/**
 * Loss function measuring how well a candidate `DifficultyVector` matches both:
 * 1. The survival curve targets per skill preset (`Novice`..`Expert`)
 * 2. Left 4 Dead-style fun & pacing targets (`peaksPerNight`, `min/maxRelaxWindowSeconds`,
 *    `targetHighIntensityPct`, `targetCloseCallsPerNight`, and fair warning-preceded deaths).
 */
export function computeDifficultyLossBreakdown(
  byPreset: Record<BotSkillPresetId, PresetSurvivalSummary>,
  pacingOverrides?: Partial<PacingTargetConfig>,
): DifficultyLossBreakdown {
  const pt: PacingTargetConfig = { ...DEFAULT_PACING_TARGETS, ...pacingOverrides }
  const customMedianTargets: Record<BotSkillPresetId, number> = {
    Novice: pt.targetNoviceNights,
    Casual: pt.targetCasualNights,
    Skilled: pt.targetSkilledNights,
    Expert: pt.targetExpertNights,
    Perfect: TARGET_SURVIVAL_CURVE.Perfect.targetMedianNights,
  }

  const presets: readonly BotSkillPresetId[] = ["Novice", "Casual", "Skilled", "Expert"]
  let survivalCurveLoss = 0
  let pacingFunLoss = 0
  let monotonicityLoss = 0
  let fairnessLoss = 0

  for (const p of presets) {
    const sum = byPreset[p]
    if (!sum || sum.runs === 0) continue
    const target = TARGET_SURVIVAL_CURVE[p]
    const targetMed = customMedianTargets[p]

    // 1. Squared error on median & mean nights survived
    const medErr = sum.medianNights - targetMed
    const meanErr = sum.meanNights - targetMed
    survivalCurveLoss += medErr * medErr * 14.0 + meanErr * meanErr * 8.0

    // 2. Band violation penalty if outside [minMedianNights, maxMedianNights]
    const minBand = Math.min(target.minMedianNights, targetMed - 0.25)
    const maxBand = Math.max(target.maxMedianNights, targetMed + 0.35)
    if (sum.medianNights < minBand) {
      survivalCurveLoss += Math.pow(minBand - sum.medianNights, 2) * 28.0
    } else if (sum.medianNights > maxBand) {
      survivalCurveLoss += Math.pow(sum.medianNights - maxBand, 2) * 28.0
    }

    // 3. Night 1 survival rate alignment
    const n1Err = sum.night1SurvivalRate - target.targetNight1SurvivalRate
    survivalCurveLoss += n1Err * n1Err * 10.0

    // 4. Early evening death penalty (< 0.15 nights)
    const earlyDeathRate = 1 - sum.eveningSurvivalRate
    if (earlyDeathRate > target.maxEarlyEveningDeathRate) {
      survivalCurveLoss += Math.pow(earlyDeathRate - target.maxEarlyEveningDeathRate, 2) * 35.0
    }

    // 5. Left 4 Dead-style pacing & fun targets (weighted across skill tiers, strongest for Casual & Skilled)
    const tierWeight = p === "Casual" || p === "Skilled" ? 1.0 : 0.6

    // 5a. Tension peaks per night
    const peakRateErr = sum.meanPeaksPerNight - pt.targetPeaksPerNight
    pacingFunLoss += tierWeight * peakRateErr * peakRateErr * 1.8

    // 5b. High-intensity time fraction (avoid flat monotony and avoid exhausting 100% siege)
    const targetHiFrac = pt.targetHighIntensityPct / 100
    const hiFracErr = sum.highIntensityFraction - targetHiFrac
    pacingFunLoss += tierWeight * hiFracErr * hiFracErr * 22.0

    // 5c. Relaxation windows between peaks within [minRelaxWindowSeconds, maxRelaxWindowSeconds]
    if (sum.meanMinRelaxWindowSeconds < pt.minRelaxWindowSeconds) {
      const deficit = (pt.minRelaxWindowSeconds - sum.meanMinRelaxWindowSeconds) / Math.max(5, pt.minRelaxWindowSeconds)
      pacingFunLoss += tierWeight * deficit * deficit * 6.0
    }
    if (sum.meanMaxRelaxWindowSeconds > pt.maxRelaxWindowSeconds) {
      const excess = (sum.meanMaxRelaxWindowSeconds - pt.maxRelaxWindowSeconds) / Math.max(20, pt.maxRelaxWindowSeconds)
      pacingFunLoss += tierWeight * excess * excess * 5.0
    }

    // 5d. Close calls per night (exciting narrow escapes before death)
    const ccErr = sum.meanCloseCallsPerNight - pt.targetCloseCallsPerNight
    pacingFunLoss += tierWeight * ccErr * ccErr * 2.2

    // 6. Fair warning-preceded deaths & zero unfair spawns
    const targetWarnedRate = pt.minWarnedDeathPct / 100
    if (sum.warnedDeathRate < targetWarnedRate) {
      fairnessLoss += Math.pow(targetWarnedRate - sum.warnedDeathRate, 2) * 24.0
    }
    if (sum.meanDeathWarningSeconds < pt.minDeathWarningSeconds) {
      fairnessLoss += Math.pow(pt.minDeathWarningSeconds - sum.meanDeathWarningSeconds, 2) * 0.8
    }
    fairnessLoss += sum.unfairSpawns * 50.0
  }

  // 7. Monotonicity across skill tiers (Novice < Casual < Skilled < Expert)
  for (let i = 0; i < presets.length - 1; i++) {
    const lo = byPreset[presets[i]!]
    const hi = byPreset[presets[i + 1]!]
    if (!lo || !hi) continue
    const minGap = 0.35
    const medDiff = hi.medianNights - lo.medianNights
    if (medDiff < minGap) {
      monotonicityLoss += Math.pow(minGap - medDiff, 2) * 45.0
    }
    const meanDiff = hi.meanNights - lo.meanNights
    if (meanDiff < minGap) {
      monotonicityLoss += Math.pow(minGap - meanDiff, 2) * 35.0
    }
  }

  const total = survivalCurveLoss + pacingFunLoss + monotonicityLoss + fairnessLoss
  return {
    total: Number(total.toFixed(4)),
    survivalCurveLoss: Number(survivalCurveLoss.toFixed(4)),
    pacingFunLoss: Number(pacingFunLoss.toFixed(4)),
    monotonicityLoss: Number(monotonicityLoss.toFixed(4)),
    fairnessLoss: Number(fairnessLoss.toFixed(4)),
  }
}

export function computeDifficultyLoss(
  byPreset: Record<BotSkillPresetId, PresetSurvivalSummary>,
  pacingOverrides?: Partial<PacingTargetConfig>,
): number {
  return computeDifficultyLossBreakdown(byPreset, pacingOverrides).total
}

export type EvaluateCandidateOptions = {
  label: string
  vector: DifficultyVector
  seeds: readonly number[]
  presets?: readonly BotSkillPresetId[]
  maxDurationSeconds?: number
  timeScale?: number
  tickDt?: number
  playerCount?: number
  recordReplayForSeed?: number
  pacingTargets?: Partial<PacingTargetConfig>
}

export function evaluateDifficultyCandidate(options: EvaluateCandidateOptions): CandidateEvaluation {
  const vector = quantizeDifficultyVector(options.vector)
  const { aiConfig, progressionTuning } = difficultyToSimTunings(vector)
  const presets = options.presets ?? BOT_SKILL_PRESET_ORDER
  const runs: BotRunResult[] = []

  for (const preset of presets) {
    for (const seed of options.seeds) {
      const res = runHeadlessBotGame({
        seed,
        preset,
        playerCount: options.playerCount ?? 1,
        maxDurationSeconds: options.maxDurationSeconds ?? 1260,
        timeScale: options.timeScale ?? 240,
        tickDt: options.tickDt,
        aiConfig,
        progressionTuning,
        configLabel: options.label,
        recordReplay: options.recordReplayForSeed === seed,
      })
      runs.push(res)
    }
  }

  const byPreset = {} as Record<BotSkillPresetId, PresetSurvivalSummary>
  for (const preset of BOT_SKILL_PRESET_ORDER) {
    const sub = runs.filter((r) => r.preset === preset)
    byPreset[preset] = summarizePresetRuns(preset, sub)
  }

  const pacingTargets: PacingTargetConfig = { ...DEFAULT_PACING_TARGETS, ...options.pacingTargets }
  const lossBreakdown = computeDifficultyLossBreakdown(byPreset, pacingTargets)
  return {
    label: options.label,
    vector,
    loss: lossBreakdown.total,
    lossBreakdown,
    pacingTargets,
    byPreset,
    runs,
  }
}

export type ParameterSensitivityEntry = {
  key: DifficultyKnobKey
  label: string
  unit: string
  defaultValue: number
  lowValue: number
  highValue: number
  lowMeanNights: number
  highMeanNights: number
  deltaNights: number
  absDeltaNights: number
  deltaSurvivalSeconds: number
  direction: "harder-when-higher" | "easier-when-higher" | "neutral"
}

/**
 * One-at-a-time sensitivity analysis across all 12 difficulty knobs: perturbs each knob by ±25% of its range
 * around `baseVector` and measures how strongly it shifts survival nights and survival seconds.
 */
export function runDifficultySensitivityAnalysis(
  baseVector: DifficultyVector,
  seeds: readonly number[],
  presets: readonly BotSkillPresetId[] = ["Novice", "Casual", "Skilled", "Expert"],
  maxDurationSeconds = 1260,
  timeScale = 240,
): ParameterSensitivityEntry[] {
  const entries: ParameterSensitivityEntry[] = []
  for (const spec of DIFFICULTY_KNOB_SPECS) {
    const span = spec.max - spec.min
    const lowRaw = clamp(baseVector[spec.key] - span * 0.22, spec.min, spec.max)
    const highRaw = clamp(baseVector[spec.key] + span * 0.22, spec.min, spec.max)
    const lowVec = quantizeDifficultyVector({ ...baseVector, [spec.key]: lowRaw })
    const highVec = quantizeDifficultyVector({ ...baseVector, [spec.key]: highRaw })

    const lowEval = evaluateDifficultyCandidate({
      label: `${spec.key}-low`,
      vector: lowVec,
      seeds,
      presets,
      maxDurationSeconds,
      timeScale,
    })
    const highEval = evaluateDifficultyCandidate({
      label: `${spec.key}-high`,
      vector: highVec,
      seeds,
      presets,
      maxDurationSeconds,
      timeScale,
    })

    const lowNights = mean(presets.map((p) => lowEval.byPreset[p].meanNights))
    const highNights = mean(presets.map((p) => highEval.byPreset[p].meanNights))
    const lowSec = mean(presets.map((p) => lowEval.byPreset[p].meanSurvivalTime))
    const highSec = mean(presets.map((p) => highEval.byPreset[p].meanSurvivalTime))
    const deltaNights = Number((highNights - lowNights).toFixed(3))
    const deltaSec = Number((highSec - lowSec).toFixed(1))

    entries.push({
      key: spec.key,
      label: spec.label,
      unit: spec.unit,
      defaultValue: baseVector[spec.key],
      lowValue: lowVec[spec.key],
      highValue: highVec[spec.key],
      lowMeanNights: lowNights,
      highMeanNights: highNights,
      deltaNights,
      absDeltaNights: Number(Math.abs(deltaNights).toFixed(3)),
      deltaSurvivalSeconds: deltaSec,
      direction:
        deltaNights < -0.04
          ? "harder-when-higher"
          : deltaNights > 0.04
            ? "easier-when-higher"
            : "neutral",
    })
  }

  entries.sort((a, b) => b.absDeltaNights - a.absDeltaNights)
  return entries
}

export type CmaEsSearchOptions = {
  generations?: number
  populationSize?: number
  seeds: readonly number[]
  presets?: readonly BotSkillPresetId[]
  maxDurationSeconds?: number
  timeScale?: number
  initialSigma?: number
  rngSeed?: number
  pacingTargets?: Partial<PacingTargetConfig>
}

export type CmaEsSearchResult = {
  baseline: CandidateEvaluation
  best: CandidateEvaluation
  history: { generation: number; bestLoss: number; meanLoss: number; bestVector: DifficultyVector }[]
  allEvaluations: CandidateEvaluation[]
}

function vectorToUnit(vec: DifficultyVector): number[] {
  return DIFFICULTY_KNOB_SPECS.map((s) => clamp((vec[s.key] - s.min) / (s.max - s.min), 0, 1))
}

function unitToVector(u: readonly number[]): DifficultyVector {
  const raw = {} as DifficultyVector
  for (let i = 0; i < DIFFICULTY_KNOB_SPECS.length; i++) {
    const s = DIFFICULTY_KNOB_SPECS[i]!
    const val = s.min + clamp(u[i]!, 0, 1) * (s.max - s.min)
    raw[s.key] = val
  }
  return quantizeDifficultyVector(raw)
}

function sampleGaussian(rng: Rng): number {
  const u1 = Math.max(1e-7, rng.next())
  const u2 = rng.next()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

/**
 * Separable CMA-ES black-box optimizer over the 12-dimensional `DifficultyVector`.
 */
export function runCmaEsDifficultySearch(options: CmaEsSearchOptions): CmaEsSearchResult {
  const dim = DIFFICULTY_KNOB_SPECS.length
  const generations = options.generations ?? 6
  const lambda = options.populationSize ?? 8
  const mu = Math.max(2, Math.floor(lambda / 2))
  const presets = options.presets ?? ["Novice", "Casual", "Skilled", "Expert"]
  const rng = new Rng(options.rngSeed ?? 0x5eedc0de)

  // Recombination weights
  const rawWeights = Array.from({ length: mu }, (_, i) => Math.log(mu + 0.5) - Math.log(i + 1))
  const wSum = rawWeights.reduce((a, b) => a + b, 0)
  const weights = rawWeights.map((w) => w / wSum)
  const muEff = 1 / weights.reduce((acc, w) => acc + w * w, 0)

  // Strategy adaptation rates
  const cs = (muEff + 2) / (dim + muEff + 5)
  const ds = 1 + 2 * Math.max(0, Math.sqrt((muEff - 1) / (dim + 1)) - 1) + cs
  const cc = (4 + muEff / dim) / (dim + 4 + (2 * muEff) / dim)
  const c1 = 2 / (Math.pow(dim + 1.3, 2) + muEff)
  const cmu = Math.min(1 - c1, (2 * (muEff - 2 + 1 / muEff)) / (Math.pow(dim + 2, 2) + muEff))
  const chiN = Math.sqrt(dim) * (1 - 1 / (4 * dim) + 1 / (21 * dim * dim))

  let meanU = vectorToUnit(DEFAULT_DIFFICULTY_VECTOR)
  let sigma = options.initialSigma ?? 0.22
  const pc = new Array<number>(dim).fill(0)
  const ps = new Array<number>(dim).fill(0)
  const diagC = new Array<number>(dim).fill(1.0)

  const baseline = evaluateDifficultyCandidate({
    label: "Today",
    vector: DEFAULT_DIFFICULTY_VECTOR,
    seeds: options.seeds,
    presets,
    maxDurationSeconds: options.maxDurationSeconds,
    timeScale: options.timeScale,
    pacingTargets: options.pacingTargets,
  })

  let best = baseline
  const allEvaluations: CandidateEvaluation[] = [baseline]
  const history: CmaEsSearchResult["history"] = [
    {
      generation: 0,
      bestLoss: baseline.loss,
      meanLoss: baseline.loss,
      bestVector: baseline.vector,
    },
  ]

  for (let gen = 1; gen <= generations; gen++) {
    const pop: { u: number[]; z: number[]; evalRes: CandidateEvaluation }[] = []

    for (let k = 0; k < lambda; k++) {
      const z = Array.from({ length: dim }, () => sampleGaussian(rng))
      const u = meanU.map((m, i) => clamp(m + sigma * Math.sqrt(diagC[i]!) * z[i]!, 0, 1))
      const vec = unitToVector(u)
      const evalRes = evaluateDifficultyCandidate({
        label: `gen${gen}-cand${k + 1}`,
        vector: vec,
        seeds: options.seeds,
        presets,
        maxDurationSeconds: options.maxDurationSeconds,
        timeScale: options.timeScale,
        pacingTargets: options.pacingTargets,
      })
      pop.push({ u, z, evalRes })
      allEvaluations.push(evalRes)
      if (evalRes.loss < best.loss) {
        best = evalRes
      }
    }

    pop.sort((a, b) => a.evalRes.loss - b.evalRes.loss)
    const oldMean = [...meanU]
    meanU = new Array<number>(dim).fill(0)
    const meanZ = new Array<number>(dim).fill(0)

    for (let m = 0; m < mu; m++) {
      const w = weights[m]!
      for (let i = 0; i < dim; i++) {
        meanU[i]! += w * pop[m]!.u[i]!
        meanZ[i]! += w * pop[m]!.z[i]!
      }
    }

    // Update evolution paths and diagonal covariance
    for (let i = 0; i < dim; i++) {
      ps[i] = (1 - cs) * ps[i]! + Math.sqrt(cs * (2 - cs) * muEff) * meanZ[i]!
      const stepNorm = (meanU[i]! - oldMean[i]!) / Math.max(1e-5, sigma)
      pc[i] = (1 - cc) * pc[i]! + Math.sqrt(cc * (2 - cc) * muEff) * stepNorm
      let rankMu = 0
      for (let m = 0; m < mu; m++) {
        const dz = (pop[m]!.u[i]! - oldMean[i]!) / Math.max(1e-5, sigma)
        rankMu += weights[m]! * dz * dz
      }
      diagC[i] = clamp(
        (1 - c1 - cmu) * diagC[i]! + c1 * pc[i]! * pc[i]! + cmu * rankMu,
        0.04,
        4.0,
      )
    }

    const psNorm = Math.hypot(...ps)
    sigma = clamp(sigma * Math.exp((cs / ds) * (psNorm / chiN - 1)), 0.04, 0.45)

    history.push({
      generation: gen,
      bestLoss: best.loss,
      meanLoss: mean(pop.map((p) => p.evalRes.loss)),
      bestVector: best.vector,
    })
    console.error(
      `[cma-es] gen ${gen}/${generations} · bestLoss=${best.loss.toFixed(2)} meanLoss=${history[history.length - 1]!.meanLoss.toFixed(2)}`,
    )
  }

  return {
    baseline,
    best,
    history,
    allEvaluations,
  }
}
