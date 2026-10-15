import type { AbilityDef } from "@arcade/kit/sim/abilities"

/**
 * One fighter: its stats and its four abilities (left mouse, Q, E, Space). Adding a character is one data file here
 * plus a look in `src/looks/roster.ts`; register it in `index.ts`.
 */
export type CharacterDef = {
  id: string
  name: string
  /** What they are, for the select screen. */
  title: string
  tagline: string
  /** Signature colour (sRGB 0..1). */
  color: readonly [number, number, number]
  /** Walk speed (m/s) and acceleration scale. */
  speed: number
  accel: number
  /** Knockback resistance: 1 average, higher flies less. */
  weight: number
  abilities: readonly [AbilityDef, AbilityDef, AbilityDef, AbilityDef]
}

/** Everyone's Space: a short hop with a moment of knockback resistance. */
export const DODGE: AbilityDef = {
  id: "dodge",
  name: "Dodge",
  blurb: "A quick hop that shrugs off some knockback.",
  windup: 0,
  cooldown: 1.7,
  moveScale: 1,
  effects: [
    { kind: "dash", speed: 16.5, time: 0.16 },
    { kind: "status", status: [{ kind: "shield", time: 0.32, amount: 0.55 }] },
  ],
  botRange: 0,
}
