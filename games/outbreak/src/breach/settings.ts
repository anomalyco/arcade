import type { LabControl } from "@arcade/kit/lab-panel"
import { breachControls, DEFAULT_BREACH_TUNING } from "../../shared/breach/rules"

/**
 * Doors & barricades (AR-97): the sim's rules (`shared/breach/rules.ts`, `breachMode` 0 is Today and switches the
 * presentation off too) plus how damage and breaches look and sound here. Presentation values never reach the sim.
 */
export const DEFAULT_BREACH_SETTINGS = {
  ...DEFAULT_BREACH_TUNING,
  /** × how far each hit jolts the door in its frame (and pushes it ajar against the latch). */
  breachJolt: 1,
  /** × splinters, chunks, glass and boards thrown by hits and breaches. */
  breachDebris: 1,
  /** Seconds broken pieces lie before sinking away (the door slab stays as long as the sim keeps it). */
  breachDebrisLife: 45,
  /** × dust puffs from hits, cracks and breaches. */
  breachDust: 1,
  /** × light through the gaps (from the dead's side when it is lit) and shadows of feet under the door. */
  breachLight: 1,
  /** × the extra thuds, groans, scratching, cracks and breaks (the director still plays each bash). */
  breachAudio: 1,
  /** × camera shake from breaches and from bracing a door as it is hit. */
  breachShake: 1,
}

export type OutbreakBreachSettings = typeof DEFAULT_BREACH_SETTINGS

const GROUP = "Doors & barricades"

export const breachLookControls: readonly LabControl[] = [
  { key: "breachJolt", label: "Jolt per hit", group: GROUP, min: 0, max: 2.5, step: 0.05, unit: "×" },
  { key: "breachDebris", label: "Debris", group: GROUP, min: 0, max: 2.5, step: 0.05, unit: "×" },
  { key: "breachDebrisLife", label: "Debris lies for", group: GROUP, min: 2, max: 240, step: 1, unit: "s" },
  { key: "breachDust", label: "Dust", group: GROUP, min: 0, max: 2.5, step: 0.05, unit: "×" },
  { key: "breachLight", label: "Light through gaps", group: GROUP, min: 0, max: 2.5, step: 0.05, unit: "×" },
  { key: "breachAudio", label: "Breach sounds", group: GROUP, min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "breachShake", label: "Breach shake", group: GROUP, min: 0, max: 2.5, step: 0.05, unit: "×" },
]

export const breachLabControls: readonly LabControl[] = [...(breachControls as readonly LabControl[]), ...breachLookControls]
