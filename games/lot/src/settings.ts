import type { LabControl } from "@arcade/kit/lab-panel"

export const PRESETS = {
  sodium: { density: 0.014, falloff: 0.036, sky: 1, lamp: 1.1, wetness: 0.8, exposure: 1.15, haze: 0.1 },
  mist: { density: 0.028, falloff: 0.06, sky: 0.8, lamp: 1.15, wetness: 0.95, exposure: 1.2, haze: 0.16 },
  dry: { density: 0.008, falloff: 0.036, sky: 1, lamp: 1.1, wetness: 0, exposure: 1.15, haze: 0.05 },
} as const
export type Settings = { preset: keyof typeof PRESETS } & Record<keyof typeof PRESETS.sodium, number>
export const defaults = (): Settings => ({ preset: "sodium", ...PRESETS.sodium })
export function controls(settings: Settings): LabControl[] {
  const range = (key: keyof typeof PRESETS.sodium, label: string, min: number, max: number, step: number, unit: string): LabControl => ({ key, label, min, max, step, unit, group: "Night" })
  return [
    { key: "preset", label: "Preset", type: "select", group: "Night", options: [{ value: "sodium", label: "Sodium" }, { value: "mist", label: "Low mist" }, { value: "dry", label: "Dry pavement" }], change: value => Object.assign(settings, PRESETS[value as keyof typeof PRESETS]) },
    range("lamp", "Sodium lamp", 0, 3, 0.05, "×"),
    range("sky", "Sky glow", 0, 3, 0.05, "×"),
    range("density", "Fog density", 0, 0.06, 0.001, "m⁻¹"),
    range("falloff", "Height falloff", 0, 0.2, 0.002, "m⁻¹"),
    range("haze", "Lamp haze", 0, 0.3, 0.005, "×"),
    range("wetness", "Wetness", 0, 1, 0.01, "×"),
    range("exposure", "Exposure", 0.2, 2.5, 0.02, "×"),
  ]
}
