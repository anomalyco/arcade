import type { LabPanel } from "../lab-panel"
import type { VoiceSpatialSettings } from "./spatial"
import { VOICE_SPATIAL } from "./spatial"

export function bindVoiceLab(panel: Pick<LabPanel, "addControls">, settings: VoiceSpatialSettings): void {
  panel.addControls(settings, [
    { key: "distance", label: "Hearing distance", group: "Voice chat", min: 10, max: 60, step: 1, unit: "m" },
    { key: "reference", label: "Full-volume distance", group: "Voice chat", min: 0.5, max: 5, step: 0.5, unit: "m" },
    { key: "rolloff", label: "Distance falloff", group: "Voice chat", min: 0.3, max: 2, step: 0.05, unit: "×" },
    { key: "occludedHz", label: "Blocked low-pass", group: "Voice chat", min: 200, max: 3000, step: 50, unit: "Hz" },
    { key: "reverb", label: "Forest reverb send", group: "Voice chat", min: 0, max: 0.5, step: 0.01, unit: "×" },
    { key: "radioDistance", label: "Full-static distance", group: "Voice chat", min: 50, max: 1000, step: 10, unit: "m" },
    { key: "resetVoice", label: "Reset voice sound", group: "Voice chat", type: "action", run: () => { Object.assign(settings, VOICE_SPATIAL) } },
  ])
}
