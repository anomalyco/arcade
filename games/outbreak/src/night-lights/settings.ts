import type { LabControl } from "@arcade/kit/lab-panel"

/**
 * Lab settings for Outbreak's coloured night practicals (Backquote › Night lights): car alarms flashing amber and
 * red, abandoned police cars with a live light bar, a red alarm beacon sweeping a shop front, broken neon signs and
 * dying sodium street lamps. Presentation only; placement is seeded from the town, so co-op clients match.
 */
export type OutbreakNightLightSettings = {
  /** Every coloured night practical on or off. */
  nightLights: boolean
  /** A wailing car alarm throws its flashing light on the street (amber nose, red tail). */
  nlAlarmCars: boolean
  /** Cars with an armed alarm blink a small red light on the dash. */
  nlArmedLeds: boolean
  /** Share of abandoned cars that are police cars with a light bar still flashing red and blue. */
  nlCruisers: number
  /** Share of shops with a red alarm beacon sweeping their front. */
  nlBeacons: number
  /** Share of shops with a neon sign (some of them broken and stuttering). */
  nlNeon: number
  /** Share of street lamps that stutter like a dying sodium tube. */
  nlSodiumFlicker: number
  /** Brightness of every coloured light. */
  nlPower: number
  /** Speed of the strobes and beacons. */
  nlStrobeRate: number
  /** Most coloured lights cast at once (nearest the camera win). */
  nlMaxLights: number
  /** Reroll which cars, shops and lamps get a light (separate from the town seed). */
  nlSeed: number
}

export const DEFAULT_NIGHT_LIGHT_SETTINGS: OutbreakNightLightSettings = {
  nightLights: true,
  nlAlarmCars: true,
  nlArmedLeds: true,
  nlCruisers: 0.25,
  nlBeacons: 0.35,
  nlNeon: 0.5,
  nlSodiumFlicker: 0.18,
  nlPower: 1,
  nlStrobeRate: 1,
  nlMaxLights: 8,
  nlSeed: 0,
}

const GROUP = "Night lights"

export const nightLightControls: LabControl[] = [
  { key: "nightLights", label: "Coloured night lights", group: GROUP, type: "toggle" },
  { key: "nlAlarmCars", label: "Car alarms flash on the street", group: GROUP, type: "toggle" },
  { key: "nlArmedLeds", label: "Armed alarm dash lights", group: GROUP, type: "toggle" },
  { key: "nlCruisers", label: "Police cars with a live bar", group: GROUP, min: 0, max: 1, step: 0.05, unit: "" },
  { key: "nlBeacons", label: "Shop alarm beacons", group: GROUP, min: 0, max: 1, step: 0.05, unit: "" },
  { key: "nlNeon", label: "Neon signs", group: GROUP, min: 0, max: 1, step: 0.05, unit: "" },
  { key: "nlSodiumFlicker", label: "Dying street lamps", group: GROUP, min: 0, max: 1, step: 0.05, unit: "" },
  { key: "nlPower", label: "Brightness", group: GROUP, min: 0, max: 3, step: 0.05, unit: "×" },
  { key: "nlStrobeRate", label: "Strobe speed", group: GROUP, min: 0.25, max: 3, step: 0.05, unit: "×" },
  { key: "nlMaxLights", label: "Most lights at once", group: GROUP, min: 0, max: 16, step: 1, unit: "" },
  { key: "nlSeed", label: "Reroll", group: GROUP, min: 0, max: 99, step: 1, unit: "" },
]
