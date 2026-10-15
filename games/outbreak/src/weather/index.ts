import { registerOutbreakClientFeature } from "../feature-registry"
import { DEFAULT_OUTBREAK_WEATHER, toSharedWeatherSettings, applyOutbreakWeatherPreset, randomizeOutbreakWeather, outbreakWeatherControls } from "./settings"

export const outbreakWeatherFeature = registerOutbreakClientFeature({
  id: "weather",
  order: 80,
  settingsGroup: {
    subsystem: "weather",
    defaults: DEFAULT_OUTBREAK_WEATHER,
  },
  labControls: (host) => [
    { key: "weather", label: "Overcast", group: "Day cycle", min: 0, max: 1, step: 0.05 },
    ...outbreakWeatherControls,
    {
      key: "triggerWeatherLightning",
      label: "Trigger lightning strike",
      group: "Weather",
      type: "action",
      run: () => {
        host.weatherController.strikeNow()
      },
    },
    {
      key: "randomizeWeatherTuning",
      label: "Randomize weather",
      group: "Weather",
      type: "action",
      run: () => {
        randomizeOutbreakWeather(host.settings.weather, host.settings.weather.weatherTuningSeed)
        host.lab().refresh()
      },
    },
  ],
  onSettingChanged: (host, rawKey, routed, value) => {
    const key = routed?.field ?? rawKey
    if (key === "weatherPreset") {
      applyOutbreakWeatherPreset(host.settings.weather, String(value ?? host.settings.weather.weatherPreset))
      host.lab().refresh()
      return true
    }
    if (key === "weatherEnabled") {
      if (
        host.settings.weather.weatherEnabled &&
        host.settings.weather.weatherPreset === "clear" &&
        host.settings.weather.weatherIntensity <= 0.001
      ) {
        applyOutbreakWeatherPreset(host.settings.weather, "rain")
      } else if (!host.settings.weather.weatherEnabled) {
        host.settings.weather.weather = 0
      }
      host.lab().refresh()
      return true
    }
    return false
  },
  gameCommands: (host) => [
    {
      id: "weather.preset",
      label: "Set Outbreak Weather Preset",
      shortLabel: "Weather Preset",
      category: "Scene",
      undoable: false,
      args: {
        preset: {
          type: "string",
          required: true,
          description: "Weather preset ID (clear, drizzle, rain, storm, fog, snow)",
        },
      },
      enabled: () => true,
      run: async (_ctx, args) => {
        const applied = applyOutbreakWeatherPreset(host.settings.weather, String(args?.preset ?? "rain"))
        host.lab.refresh()
        host.draw(1 / 60)
        await host.device.queue.onSubmittedWorkDone()
        return {
          preset: host.settings.weather.weatherPreset,
          enabled: host.settings.weather.weatherEnabled,
          settings: applied,
        }
      },
    },
    {
      id: "weather.strike",
      label: "Trigger Outbreak Lightning Strike",
      shortLabel: "Lightning Strike",
      category: "Scene",
      undoable: false,
      enabled: () => true,
      run: async () => {
        const strike = host.weatherController.strikeNow()
        host.draw(1 / 60)
        await host.device.queue.onSubmittedWorkDone()
        return { triggered: true, strike }
      },
    },
  ],
  harnessMethods: (host) => ({
    setWeatherPreset(preset: string) {
      const applied = applyOutbreakWeatherPreset(host.settings.weather, preset)
      host.lab.refresh()
      return applied
    },
    strikeLightning(seed?: number) {
      return host.weatherController.strikeNow(seed)
    },
  }),
  harnessState: (host) => ({
    weather: {
      enabled: host.settings.weather.weatherEnabled,
      preset: host.settings.weather.weatherPreset,
      settings: toSharedWeatherSettings(host.settings.weather),
      state: { ...host.weatherController.sim.state },
    },
  }),
})
