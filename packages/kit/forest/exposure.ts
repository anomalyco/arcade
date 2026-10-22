import type { SceneMeter } from "../gpu/meter"
import type { ForestLookSettings } from "./settings"

/** Scene-referred metering: neither the tone curve nor the previous exposure feeds this target. */
export function forestExposureTarget(meter: SceneMeter | null, fallback: number, s: ForestLookSettings, offsetStops = 0): number {
  if (!s.autoExposure) return 0
  const luminance = meter ? (s.exposureModel === "robust" ? meter.logMean : meter.centre) * s.meterGain : fallback
  const key = Math.max(luminance, 1e-6)
  const stops = s.exposureModel === "metered"
    ? -Math.log2(key / 0.09) * 0.55
    : s.nightStops - Math.log2(key / Math.max(s.nightKey, 1e-6)) * s.nightStrength
  return Math.max(-s.adaptRange, Math.min(s.adaptLift, stops + offsetStops))
}

/** Exponential adaptation is independent of frame subdivision for a fixed target. */
export function adaptForestExposure(stops: number, target: number, dt: number, s: ForestLookSettings): number {
  // Centre-meter response belongs to the model, including presets/query/direct assignments without panel callbacks.
  const tau = s.exposureModel === "metered" ? (target < stops ? 0.35 : 1.8) : (target < stops ? s.adaptDarken : s.adaptBrighten)
  return stops + (target - stops) * -Math.expm1(-Math.max(dt, 0) / Math.max(tau, 0.01))
}
