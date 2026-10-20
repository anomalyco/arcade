import type { Stack } from "@arcade/kit/sim/ledger"
import type { DirectorEscalation } from "../pacing"
import { mix32, type SpecialsTuning } from "../specials/kinds"
import { DEFAULT_COOP_SCALING, type CoopScalingTuning } from "./coop"

/**
 * Night ramp (D-40 pick 3, Gentle Start, Rising): Night 1 holds the director to fewer chasers so a new player usually
 * sees dawn, then every later night raises the population and chaser caps a step, up to a ceiling, instead of the
 * director's own ramp levelling off by Night 2. Later nights also make special zombies likelier, and from a set
 * night some of the dead you put down carry a few rounds. `nightRampMode: 0` is the game as it was before (Today).
 * The same namespace carries how the director scales with the squad (`./coop.ts`, Lab › Co-op scaling).
 */
export type NightRampTuning = CoopScalingTuning & {
  /** 1: Gentle Start, Rising. 0: Today (the director's own ramp only). */
  nightRampMode: number
  /** Solo chaser ceiling during Night 1 (0 = no hold). */
  nightOneChasers: number
  /** Multiplies the solo population target during Night 1. */
  nightOnePopulation: number
  /** Zombies added to the solo population for every night after the first. */
  nightPopulationStep: number
  /** The solo population never rises past this. */
  nightPopulationCeiling: number
  /** Chasers added to the solo cap for every night after the first. */
  nightChaserStep: number
  /** The solo chaser cap never rises past this. */
  nightChaserCeiling: number
  /** Special-zombie chance added per night after the first (replaces the Specials group's own step). */
  nightSpecialStep: number
  /** Special-zombie chance cap (replaces the Specials group's own cap). */
  nightSpecialCap: number
  /** From this night on, some of the dead carry rounds (0 = never). */
  lateAmmoFromNight: number
  /** Share of the dead that carry rounds. */
  lateAmmoChance: number
  /** Rounds a carrier drops (and a dawn cache holds), from min to max. */
  lateAmmoMin: number
  lateAmmoMax: number
  /** Each dawn from the day after `lateAmmoFromNight`, this many searched, emptied containers hold a few rounds again. */
  dawnAmmoCaches: number
}

export const DEFAULT_NIGHT_RAMP_TUNING: NightRampTuning = {
  ...DEFAULT_COOP_SCALING,
  nightRampMode: 1,
  nightOneChasers: 2,
  nightOnePopulation: 0.65,
  nightPopulationStep: 3,
  nightPopulationCeiling: 30,
  nightChaserStep: 0.5,
  nightChaserCeiling: 6,
  nightSpecialStep: 0.03,
  nightSpecialCap: 0.2,
  lateAmmoFromNight: 2,
  lateAmmoChance: 0.5,
  lateAmmoMin: 2,
  lateAmmoMax: 5,
  dawnAmmoCaches: 2,
}

/** Lab controls (Backquote › Night ramp). Every value is live; the population and caps apply from the next tick. */
export const nightRampControls = [
  {
    key: "nightRamp.nightRampMode",
    field: "nightRampMode",
    label: "Night ramp",
    group: "Night ramp",
    options: [
      { label: "Today", value: 0 },
      { label: "Gentle start, rising", value: 1 },
    ],
  },
  { key: "nightRamp.nightOneChasers", field: "nightOneChasers", label: "Night 1 chasers", group: "Night ramp", min: 0, max: 6, step: 1, unit: "" },
  { key: "nightRamp.nightOnePopulation", field: "nightOnePopulation", label: "Night 1 population", group: "Night ramp", min: 0.3, max: 1.5, step: 0.05, unit: "×" },
  { key: "nightRamp.nightPopulationStep", field: "nightPopulationStep", label: "Zombies added per night", group: "Night ramp", min: 0, max: 16, step: 1, unit: "" },
  { key: "nightRamp.nightPopulationCeiling", field: "nightPopulationCeiling", label: "Population ceiling", group: "Night ramp", min: 8, max: 100, step: 1, unit: "" },
  { key: "nightRamp.nightChaserStep", field: "nightChaserStep", label: "Chasers added per night", group: "Night ramp", min: 0, max: 3, step: 0.25, unit: "" },
  { key: "nightRamp.nightChaserCeiling", field: "nightChaserCeiling", label: "Chaser ceiling", group: "Night ramp", min: 1, max: 12, step: 1, unit: "" },
  { key: "nightRamp.nightSpecialStep", field: "nightSpecialStep", label: "Special chance per night", group: "Night ramp", min: 0, max: 0.1, step: 0.005, unit: "" },
  { key: "nightRamp.nightSpecialCap", field: "nightSpecialCap", label: "Special chance cap", group: "Night ramp", min: 0, max: 0.5, step: 0.01, unit: "" },
  { key: "nightRamp.lateAmmoFromNight", field: "lateAmmoFromNight", label: "Dead carry rounds from night", group: "Night ramp", min: 0, max: 6, step: 1, unit: "" },
  { key: "nightRamp.lateAmmoChance", field: "lateAmmoChance", label: "Dead carrying rounds", group: "Night ramp", min: 0, max: 1, step: 0.05, unit: "×" },
  { key: "nightRamp.lateAmmoMin", field: "lateAmmoMin", label: "Rounds carried (min)", group: "Night ramp", min: 1, max: 12, step: 1, unit: "" },
  { key: "nightRamp.lateAmmoMax", field: "lateAmmoMax", label: "Rounds carried (max)", group: "Night ramp", min: 1, max: 12, step: 1, unit: "" },
  { key: "nightRamp.dawnAmmoCaches", field: "dawnAmmoCaches", label: "Rounds left at dawn", group: "Night ramp", min: 0, max: 8, step: 1, unit: "caches" },
] as const

export function nightRampTuning(features: Readonly<Record<string, Record<string, unknown>>> | undefined): NightRampTuning {
  const src = features?.nightRamp as Partial<NightRampTuning> | undefined
  return src ? { ...DEFAULT_NIGHT_RAMP_TUNING, ...src } : DEFAULT_NIGHT_RAMP_TUNING
}

/** Which night it is: 1 from the first dusk, 2 from the next, and so on; `dark` while it is night. */
export type NightClock = { night: number; dark: boolean }

/** What the director gets on top of its own ramp, for the night and the base population and chaser cap. */
export function nightEscalation(
  t: NightRampTuning,
  clock: NightClock,
  base: { zombieCount: number; maxActiveNearPlayer: number },
): DirectorEscalation {
  if (t.nightRampMode <= 0) return { populationScale: 1, populationBonus: 0, chaserBonus: 0, chaserCap: 0 }
  if (clock.night <= 1) {
    // Night 1 (and the evening before it); Day 2 goes back to the director's own caps.
    const holding = clock.night === 0 || clock.dark
    return {
      populationScale: holding ? t.nightOnePopulation : 1,
      populationBonus: 0,
      chaserBonus: 0,
      chaserCap: holding ? t.nightOneChasers : 0,
    }
  }
  const nights = clock.night - 1
  return {
    populationScale: 1,
    populationBonus: Math.max(0, Math.min(t.nightPopulationStep * nights, t.nightPopulationCeiling - base.zombieCount)),
    chaserBonus: Math.max(0, Math.min(Math.floor(t.nightChaserStep * nights), t.nightChaserCeiling - base.maxActiveNearPlayer)),
    chaserCap: 0,
  }
}

/** The Specials group's tuning with the night ramp's per-night step and cap in place of its own. */
export function withNightRampSpecials(specials: SpecialsTuning, t: NightRampTuning): SpecialsTuning {
  if (t.nightRampMode <= 0) return specials
  return { ...specials, specialRampPerNight: t.nightSpecialStep, specialMaxChance: t.nightSpecialCap }
}

/** Rounds a zombie that just died leaves behind, fixed by the town seed and its id (empty for most). */
export function lateAmmoDrop(t: NightRampTuning, night: number, townSeed: number, zombieId: number): Stack[] {
  if (!lateAmmoActive(t, night)) return []
  const a = mix32((townSeed ^ Math.imul(zombieId + 0x2f, 0x9e3779b1) ^ 0x6c8e9cf5) >>> 0)
  if (a / 4294967296 >= t.lateAmmoChance) return []
  return [{ item: "ammo", count: lateAmmoCount(t, mix32((a ^ 0x2545f491) >>> 0)) }]
}

/** Whether late rounds are on for this night (the night count rises at dusk, so night 2 covers Night 2 and Day 3). */
export const lateAmmoActive = (t: NightRampTuning, night: number): boolean =>
  t.nightRampMode > 0 && t.lateAmmoFromNight > 0 && night >= t.lateAmmoFromNight

/** A round count from `lateAmmoMin..lateAmmoMax` picked by `roll`. */
export function lateAmmoCount(t: NightRampTuning, roll: number): number {
  const lo = Math.max(1, Math.round(Math.min(t.lateAmmoMin, t.lateAmmoMax)))
  const hi = Math.max(lo, Math.round(Math.max(t.lateAmmoMin, t.lateAmmoMax)))
  return lo + ((roll >>> 0) % (hi - lo + 1))
}

/** Deterministic order key for picking dawn caches: town seed, night and the store's id. */
export function cacheRoll(townSeed: number, night: number, storeId: string): number {
  let h = (townSeed ^ Math.imul(night + 0x11, 0x85ebca6b)) >>> 0
  for (let i = 0; i < storeId.length; i++) h = Math.imul(h ^ storeId.charCodeAt(i), 16777619)
  return mix32(h >>> 0)
}

export const lateAmmoDropId = (zombieId: number) => `drop:rounds:${zombieId}`
