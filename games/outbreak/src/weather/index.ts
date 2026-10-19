import type { LabCommand } from "@arcade/kit/lab/commands"
import { registerOutbreakClientFeature } from "../feature-registry"
import {
  DEFAULT_OUTBREAK_WEATHER,
  applyOutbreakWeatherPreset,
  outbreakAllWeatherControls,
  randomizeOutbreakWeather,
  setOutbreakWeatherState,
} from "./settings"

/**
 * Weather (AR-71), client half: the Lab's Weather group (Backquote › Weather; "Weather: Today" keeps it clear), the
 * `weather.set` / `weather.flash` commands and harness telemetry. The cycle lives in `shared/weather/`; the frame's
 * rain, wet ground, lightning and thunder in `controller.ts` and `audio.ts`.
 */
export const outbreakWeatherFeature = registerOutbreakClientFeature({
  id: "weather",
  order: 80,
  settingsGroup: {
    subsystem: "weather",
    defaults: DEFAULT_OUTBREAK_WEATHER,
  },
  labControls: (host) => [
    { key: "weather", label: "Overcast", group: "Day cycle", min: 0, max: 1, step: 0.05 },
    ...outbreakAllWeatherControls,
    {
      key: "triggerWeatherLightning",
      label: "Lightning now (near)",
      group: "Weather",
      type: "action",
      run: () => {
        host.weatherController.flashNow({ near: true })
      },
    },
    {
      key: "triggerWeatherLightningFar",
      label: "Lightning now (far)",
      group: "Weather",
      type: "action",
      run: () => {
        host.weatherController.flashNow({ near: false })
      },
    },
    {
      key: "randomizeWeatherTuning",
      label: "Randomize manual look",
      group: "Weather · Manual look",
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
      if (host.settings.weather.weatherEnabled && host.settings.weather.weatherIntensity <= 0.001) {
        applyOutbreakWeatherPreset(host.settings.weather, "fog")
      }
      host.lab().refresh()
      return true
    }
    return false
  },
  gameCommands: (host): LabCommand[] => {
    const settle = async () => {
      host.lab.refresh()
      host.draw(1 / 60)
      await host.device.queue.onSubmittedWorkDone()
    }
    const state = () => ({
      cycle: host.settings.weather.weatherCycle,
      override: host.settings.weather.weatherOverride,
      manual: host.settings.weather.weatherEnabled,
      sample: { ...host.weatherController.sample },
    })
    return [
      {
        id: "weather.set",
        label: "Set Outbreak Weather",
        shortLabel: "Weather",
        category: "Scene",
        undoable: false,
        args: {
          state: {
            type: "string",
            required: true,
            description: "clear, drizzle, rain or storm holds the weather there; cycle lets the seeded cycle run",
          },
        },
        enabled: () => true,
        run: async (_ctx, args) => {
          const value = setOutbreakWeatherState(host.settings.weather, String(args?.state ?? "cycle"))
          if (value === null) throw new Error(`Unknown weather state "${String(args?.state)}" (clear, drizzle, rain, storm, cycle)`)
          await settle()
          return state()
        },
      },
      {
        id: "weather.flash",
        label: "Outbreak Lightning Strike",
        shortLabel: "Lightning",
        category: "Scene",
        undoable: false,
        args: {
          near: { type: "boolean", description: "Within 100 m, hitting a pole or tree (default true)" },
        },
        enabled: () => true,
        run: async (_ctx, args) => {
          const strike = host.weatherController.flashNow({ near: args?.near === undefined ? true : Boolean(args.near) })
          host.draw(1 / 60)
          await host.device.queue.onSubmittedWorkDone()
          return { strike }
        },
      },
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
            description: "clear, drizzle, rain or storm (the cycle's states), or fog or snow (the manual look)",
          },
        },
        enabled: () => true,
        run: async (_ctx, args) => {
          const applied = applyOutbreakWeatherPreset(host.settings.weather, String(args?.preset ?? "rain"))
          await settle()
          return { preset: host.settings.weather.weatherPreset, ...state(), settings: applied }
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
          const strike = host.weatherController.flashNow()
          host.draw(1 / 60)
          await host.device.queue.onSubmittedWorkDone()
          return { triggered: true, strike }
        },
      },
    ]
  },
  harnessMethods: (host) => ({
    setWeatherPreset(preset: string) {
      const applied = applyOutbreakWeatherPreset(host.settings.weather, preset)
      host.lab.refresh()
      return applied
    },
    setWeatherState(state: string) {
      const value = setOutbreakWeatherState(host.settings.weather, state)
      host.lab.refresh()
      return value
    },
    flashLightning(near = true) {
      return host.weatherController.flashNow({ near })
    },
    strikeLightning(seed?: number) {
      return host.weatherController.flashNow({ seed })
    },
  }),
  harnessState: (host) => {
    const w = host.weatherController
    return {
      weather: {
        cycle: host.settings.weather.weatherCycle,
        override: host.settings.weather.weatherOverride,
        manual: host.settings.weather.weatherEnabled,
        preset: host.settings.weather.weatherPreset,
        sample: { ...w.sample },
        surface: { ...w.surface },
        flash: w.flash,
        marks: w.marks.length,
        settings: { ...w.shared },
      },
    }
  },
})
