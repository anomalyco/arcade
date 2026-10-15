import type { LabControl } from "../lab-panel"
import { SKID_DEFAULTS, SkidMarks } from "../fx/skids"
import { SLIP_DEFAULTS, type SlipSettings } from "./slip"

/** The Lab's Driving FX group: tyre marks, smoke and how slip is read from the car's motion. */
export type DrivingFxSettings = {
  skidMarks: boolean
  tyreSmoke: boolean
  markLife: number
  markFade: number
  markStrength: number
  markWidth: number
  slideThreshold: number
  slideRange: number
  brakeLock: number
  brakeLockSpeed: number
}

export const DRIVING_FX_DEFAULTS: DrivingFxSettings = {
  skidMarks: true,
  tyreSmoke: true,
  markLife: SKID_DEFAULTS.life,
  markFade: SKID_DEFAULTS.fade,
  markStrength: SKID_DEFAULTS.strength,
  markWidth: SKID_DEFAULTS.width,
  slideThreshold: SLIP_DEFAULTS.slideThreshold,
  slideRange: SLIP_DEFAULTS.slideRange,
  brakeLock: SLIP_DEFAULTS.brakeLock,
  brakeLockSpeed: SLIP_DEFAULTS.brakeLockSpeed,
}

type Key = keyof DrivingFxSettings
const GROUP = "Driving FX"
const MARKS: (LabControl & { key: Key })[] = [
  { key: "skidMarks", label: "Skid marks", group: GROUP },
  { key: "tyreSmoke", label: "Tyre smoke and dust", group: GROUP },
  { key: "markLife", label: "Mark life (new marks)", group: GROUP, min: 5, max: 600, step: 5, unit: "s" },
  { key: "markFade", label: "Mark fade (new marks)", group: GROUP, min: 1, max: 120, step: 1, unit: "s" },
  { key: "markStrength", label: "Mark darkness (new marks)", group: GROUP, min: 0.1, max: 1, step: 0.05 },
  { key: "markWidth", label: "Tread width (new marks)", group: GROUP, min: 0.05, max: 0.4, step: 0.01, unit: "m" },
]
const SLIP: (LabControl & { key: Key })[] = [
  { key: "slideThreshold", label: "Slide before marking", group: GROUP, min: 0.2, max: 6, step: 0.1, unit: "m/s" },
  { key: "slideRange", label: "Slide to full slip", group: GROUP, min: 0.5, max: 12, step: 0.25, unit: "m/s" },
  { key: "brakeLock", label: "Hard-stop wheel lock (0 = ABS)", group: GROUP, min: 0, max: 1, step: 0.05 },
  { key: "brakeLockSpeed", label: "Lock above", group: GROUP, min: 2, max: 20, step: 0.5, unit: "m/s" },
]

/**
 * Controls for the shared group. `keys` limits it to what a game's path uses (Getaway's proxy slip has no slide
 * or lock settings); bind them with `LabPanel.addControls(settings, controls, defaults)`.
 */
export function drivingFxControls(keys?: readonly Key[]): (LabControl & { key: Key })[] {
  const all = [...MARKS, ...SLIP]
  return keys ? all.filter(c => keys.includes(c.key)) : all
}

/** Settings, the mark buffer and the slip rules they drive, kept in step by `apply()` once per frame. */
export class DrivingFx {
  readonly settings: DrivingFxSettings
  readonly slip: SlipSettings = { ...SLIP_DEFAULTS }
  constructor(readonly marks = new SkidMarks(), settings: Partial<DrivingFxSettings> = {}) {
    this.settings = { ...DRIVING_FX_DEFAULTS, ...settings }
    this.apply()
  }
  apply() {
    const s = this.settings, m = this.marks.settings, slip = this.slip
    m.life = s.markLife; m.fade = s.markFade; m.strength = s.markStrength; m.width = s.markWidth
    slip.slideThreshold = s.slideThreshold; slip.slideRange = s.slideRange
    slip.brakeLock = s.brakeLock; slip.brakeLockSpeed = s.brakeLockSpeed
  }
}
