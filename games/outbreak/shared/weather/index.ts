import { registerOutbreakSharedFeature } from "../feature-registry"
import { createWeatherState, stepWeather, type WeatherSimState } from "./runtime"
import { DEFAULT_WEATHER_TUNING, weatherTuning, type WeatherTuning } from "./schedule"

export const outbreakWeatherSharedFeature = registerOutbreakSharedFeature<WeatherSimState, undefined, WeatherTuning>({
  id: "weather",
  order: 16,
  tuning: { namespace: "weather", defaults: DEFAULT_WEATHER_TUNING },
  createState: () => createWeatherState(),
  stepWorld: ({ sim, resolved, state }) => stepWeather(sim, state, weatherTuning(resolved.features)),
})
