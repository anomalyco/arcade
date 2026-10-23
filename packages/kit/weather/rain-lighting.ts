import type { LabControl } from "../lab-panel"

export type RainLightingSettings = {
  mode: "today" | "volume"
  /** Effective integration time for camera-relative streak velocity. */
  shutter: number
  /** Screen-space upper bound for close streaks at the actual render resolution. */
  maxPixels: number
  /** Scale of impact rings and crowns relative to the existing weather geometry. */
  splashScale: number
  /** Radiance gain for lit streaks; does not change drop count or the unlit background. */
  streakGain?: number
}

export const RAIN_LIGHTING_DEFAULTS: Readonly<RainLightingSettings> = { mode: "today", shutter: 0.012, maxPixels: 24, splashScale: 0.45, streakGain: 4 }

export function rainLightingControls(group = "Weather", prefix = "rainLight."): LabControl[] {
  return [
    { key: prefix + "mode", field: "mode", label: "Rain lighting", group, type: "select", options: [{ value: "today", label: "Today" }, { value: "volume", label: "Light volumes" }] },
    { key: prefix + "shutter", field: "shutter", label: "Streak exposure", group, min: 0.002, max: 0.05, step: 0.001, unit: "s" },
    { key: prefix + "streakGain", field: "streakGain", label: "Streak brightness", group, min: 0, max: 12, step: 0.1, unit: "×" },
    { key: prefix + "maxPixels", field: "maxPixels", label: "Maximum streak", group, min: 4, max: 64, step: 1, unit: "px" },
    { key: prefix + "splashScale", field: "splashScale", label: "Impact size", group, min: 0.1, max: 1, step: 0.05, unit: "×" },
  ]
}
