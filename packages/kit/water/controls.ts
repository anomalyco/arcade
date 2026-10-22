import type { LabControl } from "../lab-panel"

/** All values are live uniforms; none changes simulation time, geometry or interaction state. */
export const WATER_CONTROLS: LabControl[] = [
  { key: "mode", label: "Water", group: "Water", type: "select", options: [{ label: "Today", value: "today" }, { label: "Continuous", value: "continuous" }] },
  { key: "normalStrength", label: "Wave normals", group: "Water", min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "detailStrength", label: "Short chop", group: "Water", min: 0, max: 0.25, step: 0.005, unit: "slope" },
  { key: "detailScale", label: "Chop scale", group: "Water", min: 0.1, max: 4, step: 0.1, unit: "×" },
  { key: "roughness", label: "Roughness", group: "Water", min: 0.04, max: 0.6, step: 0.01, unit: "" },
  { key: "reflection", label: "Sky reflection", group: "Water", min: 0, max: 1.5, step: 0.05, unit: "×" },
  { key: "sunGlints", label: "Sun glints", group: "Water", min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "haze", label: "Horizon haze", group: "Water", min: 0, max: 4, step: 0.1, unit: "×" },
  { key: "colour", label: "Body tint", group: "Water", type: "select", options: [
    { value: "#ffffff", label: "Neutral" }, { value: "#bededb", label: "Ocean teal" },
    { value: "#9bb7ac", label: "Forest green" }, { value: "#b1c4df", label: "Deep blue" },
  ] },
  { key: "foam", label: "Crest foam", group: "Water", min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "wake", label: "Wake foam", group: "Water", min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "kelvin", label: "Kelvin waves", group: "Water", min: 0, max: 2, step: 0.05, unit: "×" },
]
