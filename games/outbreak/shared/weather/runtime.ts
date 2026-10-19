import type { OutbreakSim } from "../sim-types"
import { DEFAULT_WEATHER_TUNING, sampleWeather, type WeatherSample, type WeatherTuning } from "./schedule"

/** The room's weather this tick, refreshed once a sim second (wetness walks a window of past rain). Plain JSON. */
export type WeatherSimState = { at: number; sample: WeatherSample }

export function createWeatherState(): WeatherSimState {
  return { at: -1, sample: sampleWeather(0, 0, 12, { ...DEFAULT_WEATHER_TUNING, weatherCycle: 0 }) }
}

/** Samples the weather and hands the crowd its senses for this tick (before the crowd steps). */
export function stepWeather(sim: OutbreakSim, state: WeatherSimState, t: WeatherTuning): void {
  const second = Math.floor(sim.time)
  if (second !== state.at || t.weatherOverride >= 0 || !(t.weatherCycle >= 1)) {
    state.at = second
    sampleWeather(sim.town.seed, sim.time, sim.hour, t, state.sample)
  }
  sim.ai.weatherSense.hearing = state.sample.hearing
  sim.ai.weatherSense.sight = state.sample.sight
}
