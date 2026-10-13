import type { LabControl } from "../lab-panel"
import type { LightSettings } from "./lights"

export const lightControls: (LabControl & { key: keyof LightSettings })[] = [
  { key: "style", label: "Style", group: "Lights", options: [
    { value: 0, label: "Reference" }, { value: 1, label: "Recessed" }, { value: 2, label: "Light bar" },
    { value: 3, label: "Cinematic" }, { value: 4, label: "Soft pool" },
  ] },
  { key: "beamLength", label: "Beam length", min: 2, max: 24, step: 0.5, group: "Lights" },
  { key: "beamWidth", label: "Beam width", min: 0.05, max: 1, step: 0.01, group: "Lights" },
  { key: "beamSpread", label: "Beam spread", min: 0, max: 6, step: 0.1, group: "Lights" },
  { key: "beamIntensity", label: "Beam intensity", min: 0, max: 0.5, step: 0.01, group: "Lights" },
  { key: "poolSize", label: "Pool size", min: 0.5, max: 8, step: 0.1, group: "Lights" },
  { key: "poolIntensity", label: "Pool intensity", min: 0, max: 0.5, step: 0.01, group: "Lights" },
  { key: "poolAhead", label: "Pool ahead", min: 1, max: 14, step: 0.25, group: "Lights" },
  { key: "glowSize", label: "Lamp glow size", min: 0.1, max: 0.8, step: 0.01, group: "Lights" },
  { key: "glowIntensity", label: "Lamp glow intensity", min: 0, max: 2, step: 0.05, group: "Lights" },
  { key: "flareStrength", label: "Flare strength", min: 0, max: 0.4, step: 0.01, group: "Lights" },
  { key: "tailGlow", label: "Taillight glow", min: 0, max: 2, step: 0.05, group: "Lights" },
  { key: "brakeIntensity", label: "Brake intensity", min: 0, max: 4, step: 0.1, group: "Lights" },
]
