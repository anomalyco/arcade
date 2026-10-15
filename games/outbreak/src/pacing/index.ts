import { wrapHour } from "../../shared/day-cycle"
import { DEFAULT_PACING_TUNING, pacingControls } from "../../shared/pacing"
import { applyOutbreakDayNight } from "../day-night"
import { registerOutbreakClientFeature } from "../feature-registry"
import { PACING_SCENES, stagePacingScene } from "./stage"

export const outbreakPacingFeature = registerOutbreakClientFeature({
  id: "pacing",
  order: 15,
  settingsGroup: {
    subsystem: "ai",
    defaults: DEFAULT_PACING_TUNING,
  },
  labControls: () => pacingControls,
  onSettingChanged: (host, rawKey, routed) => {
    const key = routed?.field ?? rawKey
    const session = host.session()
    const { settings, lookSettings, progressionHost } = host
    const lab = host.lab()
    if (key === "safeRadius" || key === "initialDensity" || key === "directorPacing") {
      Object.assign(session.ai.config, settings.ai)
      if (progressionHost.offline() && session.view.time < 5) {
        session.ai.resetOpeningPopulation(
          session.view.town,
          session.sim.slots.map((s) => s.survivor),
        )
      }
      return true
    }
    if (key === "startHour") {
      settings.dayCycle.hour = wrapHour(settings.ai.startHour)
      session.view.hour = settings.dayCycle.hour
      if (settings.dayCycle.dayNightLook === 1 && settings.dayCycle.lookPreset === "noir") {
        host.setLastDayNightHour(session.view.hour)
        applyOutbreakDayNight(session.view.hour, lookSettings, settings)
        lab.refresh()
      }
      return true
    }
    return false
  },
  gameCommands: (host) => [
    {
      id: "pacing.stage",
      label: "Stage First-Night Pacing Scene",
      shortLabel: "Pacing Scene",
      category: "Scene",
      undoable: false,
      args: {
        scene: {
          type: "string",
          description: `Scene (${PACING_SCENES.join(", ")})`,
        },
      },
      enabled: () => !host.coop.net,
      run: async (_ctx, args) => {
        const out = (host.harness() as any).stagePacing(String(args?.scene ?? "opening-calm"))
        await host.harness().step(1 / 60)
        return out
      },
    },
  ],
  harnessMethods: (host, harness) => ({
    stagePacing(scene: string) {
      return stagePacingScene(host, harness, scene)
    },
  }),
  harnessState: (host) => ({
    pacing: { ...host.session().ai.pacing.telemetry },
  }),
})
