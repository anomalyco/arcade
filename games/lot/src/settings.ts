import type { LabControl } from "@arcade/kit/lab-panel"

export const PRESETS = {
  sodium: { density: 0.01, falloff: 0.05, sky: 1, lamp: 0.3, wetness: 0.8, exposure: 2 ** -2.2, haze: 0.12 },
  mist: { density: 0.018, falloff: 0.05, sky: 1, lamp: 0.3, wetness: 0.95, exposure: 2 ** -2.2, haze: 0.16 },
  dry: { density: 0.01, falloff: 0.05, sky: 1, lamp: 0.3, wetness: 0, exposure: 2 ** -2.2, haze: 0.12 },
} as const
export type Settings = { preset: keyof typeof PRESETS; reflectionCap:number; specularAA:number } & Record<keyof typeof PRESETS.sodium, number>
export const defaults = (): Settings => ({ preset: "sodium", ...PRESETS.sodium, reflectionCap:2, specularAA:1 })
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
    range("exposure", "Exposure", 0.02, 2.5, 0.005, "×"),
    {key:"reflectionCap",label:"Reflection sample cap",min:0.1,max:8,step:0.1,unit:"HDR",group:"Wet ground"},
    {key:"specularAA",label:"Specular anti-aliasing",min:0,max:2,step:0.05,unit:"×",group:"Wet ground"},
  ]
}
