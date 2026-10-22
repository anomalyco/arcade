import type { SceneMeter, SceneMeterStatus } from "../gpu/meter"
import type { ForestLookSettings } from "./settings"

export type ForestExposureState = { stops: number; pending: boolean; wait: number }

/** A live meter gets at most half a second to warm up after a cut. Failure/timeout retires the one-time snap. */
export function stepForestExposure(state: ForestExposureState, status: SceneMeterStatus, target: number, dt: number, s: ForestLookSettings): void {
  if (status === "off") {
    // Smoke historically follows the fallback target immediately, including later torch/sky changes.
    state.pending = false
    state.stops = target
    return
  }
  if (state.pending) {
    state.wait += Math.max(0, dt)
    if (status === "pending" && state.wait < 0.5) return
    state.pending = false
    if (status === "ready" && state.wait < 0.5) { state.stops = target; return }
  }
  state.stops = adaptForestExposure(state.stops, target, dt, s)
}

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
