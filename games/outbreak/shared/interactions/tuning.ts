/**
 * World interactions' rules (AR-96), one Lab group (Backquote › Interactions): every toggle on by default, each
 * interaction's "off" is Today.
 */
export type InteractionsTuning = {
  // ── Throwables (`throwables.ts`) ──
  /** 1 on; 0 is Today: the old fixed-range bottle and none of the new things in the world. */
  throwables: number
  /** Seconds of holding the button to reach a full throw. */
  throwWindup: number
  /** Share of full range a tap throws. */
  throwTap: number
  /** Scales every throw's range. */
  throwRange: number
  /** Scales every throw's damage. */
  throwDamage: number
  /** Scales how far every landing carries to the dead. */
  throwNoise: number
  /** Chance a house has a throwable lying about (in the yard, on the porch or on a floor). */
  throwYard: number
}

export const DEFAULT_INTERACTIONS_TUNING: InteractionsTuning = {
  throwables: 1,
  throwWindup: 0.75,
  throwTap: 0.3,
  throwRange: 1,
  throwDamage: 1,
  throwNoise: 1,
  throwYard: 0.7,
}

const TODAY_ON = [
  { label: "Today (off)", value: 0 },
  { label: "On", value: 1 },
] as const
const T = "Interactions · Throwables"

export const interactionsControls = [
  { key: "interactions.throwables", field: "throwables", label: "Throwables", group: T, options: TODAY_ON },
  { key: "interactions.throwWindup", field: "throwWindup", label: "Full wind-up", group: T, min: 0.2, max: 2, step: 0.05, unit: "s" },
  { key: "interactions.throwTap", field: "throwTap", label: "Tap throw", group: T, min: 0.1, max: 1, step: 0.05, unit: "× range" },
  { key: "interactions.throwRange", field: "throwRange", label: "Range", group: T, min: 0.3, max: 2, step: 0.05, unit: "×" },
  { key: "interactions.throwDamage", field: "throwDamage", label: "Damage", group: T, min: 0, max: 4, step: 0.1, unit: "×" },
  { key: "interactions.throwNoise", field: "throwNoise", label: "Landing noise", group: T, min: 0, max: 3, step: 0.1, unit: "×" },
  { key: "interactions.throwYard", field: "throwYard", label: "Houses with one lying about", group: T, min: 0, max: 1, step: 0.05, unit: "" },
] as const

export function interactionsTuning(features: Readonly<Record<string, Record<string, unknown>>> | undefined): InteractionsTuning {
  return { ...DEFAULT_INTERACTIONS_TUNING, ...(features?.interactions as Partial<InteractionsTuning> | undefined) }
}
