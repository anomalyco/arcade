import type { OutbreakSim } from "../sim-types"
import { DEFAULT_WEATHER_TUNING, sampleWeather, sampleWeatherCached, type WeatherSample, type WeatherTuning } from "./schedule"

/** The room's weather this tick, refreshed once a sim second or when its inputs change (`sampleWeatherCached`). Plain JSON. */
export type WeatherSimState = { key: number[]; sample: WeatherSample }

export function createWeatherState(): WeatherSimState {
  return { key: [], sample: sampleWeather(0, 0, 12, { ...DEFAULT_WEATHER_TUNING, weatherCycle: 0 }) }
}

/** Samples the weather and hands the crowd its senses for this tick (before the crowd steps). */
export function stepWeather(sim: OutbreakSim, state: WeatherSimState, t: WeatherTuning): void {
  sampleWeatherCached(sim.town.seed, sim.time, sim.hour, t, state.key, state.sample)
  sim.ai.weatherSense.hearing = state.sample.hearing
  sim.ai.weatherSense.sight = state.sample.sight
}
