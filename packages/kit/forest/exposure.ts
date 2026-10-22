import type { SceneMeter } from "../gpu/meter"
import type { ForestLookSettings } from "./settings"

/** Scene-referred metering: neither the tone curve nor the previous exposure feeds this target. */
export function forestExposureTarget(meter: SceneMeter | null, fallback: number, s: ForestLookSettings): number {
  if (!s.autoExposure) return 0
  const luminance = meter ? (s.exposureModel === "robust" ? meter.logMean : meter.centre) * s.meterGain : fallback
  const key = Math.max(luminance, 1e-6)
  const stops = s.exposureModel === "metered"
    ? -Math.log2(key / 0.09) * 0.55
    : s.nightStops - Math.log2(key / Math.max(s.nightKey, 1e-6)) * s.nightStrength
  return Math.max(-s.adaptRange, Math.min(s.adaptLift, stops))
}

/** Exponential adaptation is independent of frame subdivision for a fixed target. */
export function adaptForestExposure(stops: number, target: number, dt: number, s: ForestLookSettings): number {
  const tau = target < stops ? s.adaptDarken : s.adaptBrighten
  return stops + (target - stops) * -Math.expm1(-Math.max(dt, 0) / Math.max(tau, 0.01))
}
