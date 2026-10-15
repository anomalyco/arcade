import { wrapHour } from "../../shared/day-cycle"
import { DEFAULT_PACING_TUNING, outbreakPacingSharedFeature, pacingControls } from "../../shared/pacing/index"
import { applyOutbreakDayNight } from "../day-night"
import { registerOutbreakClientFeature } from "../feature-registry"
import type { OutbreakHarness, OutbreakHarnessHost } from "../harness"
import { stageProgression } from "../progression-lab"

export { outbreakPacingSharedFeature }
export * from "../../shared/pacing/index"

export const PACING_SCENES = [
  "opening-calm",
  "safehouse-workbench",
  "first-contact",
  "late-night-horde",
  "legacy-rush",
] as const

export type PacingScene = (typeof PACING_SCENES)[number]

export function stagePacingScene(host: OutbreakHarnessHost, harness: OutbreakHarness, scene: string) {
  const { settings, lookSettings, lab, hud, progressionHost } = host
  const session = host.session()
  session.ai.noiseBus.reset()
  session.view.notices.length = 0
  hud.reset()
  if (scene === "legacy-rush") {
    settings.ai.directorPacing = 0
    settings.ai.safeRadius = 3.5
    settings.ai.initialDensity = 1.0
    settings.ai.startHour = 18.0
    settings.dayCycle.hour = 18.0
    session.view.hour = 18.0
    Object.assign(session.ai.config, settings.ai)
    session.ai.resetOpeningPopulation(
      session.view.town,
      session.sim.slots.map((s) => s.survivor),
    )
    harness.pose(27.7, 41, -Math.PI / 2)
  } else if (scene === "safehouse-workbench") {
    settings.ai.directorPacing = 1
    settings.ai.safeRadius = 20
    settings.ai.initialDensity = 0.25
    settings.ai.startHour = 16.0
    settings.dayCycle.hour = 16.8
    session.view.hour = 16.8
    Object.assign(session.ai.config, settings.ai)
    session.ai.resetOpeningPopulation(
      session.view.town,
      session.sim.slots.map((s) => s.survivor),
    )
    stageProgression(progressionHost, "bench")
    settings.dayCycle.hour = 16.8
    session.view.hour = 16.8
  } else if (scene === "first-contact") {
    settings.ai.directorPacing = 1
    settings.ai.safeRadius = 20
    settings.ai.initialDensity = 0.25
    settings.dayCycle.hour = 17.85
    session.view.hour = 17.85
    Object.assign(session.ai.config, settings.ai)
    session.ai.resetOpeningPopulation(
      session.view.town,
      session.sim.slots.map((s) => s.survivor),
    )
    harness.pose(29.5, 41.2, 0)
    const s1 = session.ai.spawnZombie(session.view.town, 37.8, 41.8, "investigate", Math.PI)
    const s2 = session.ai.spawnZombie(session.view.town, 39.2, 43.4, "investigate", Math.PI - 0.15)
    s1.targetX = 31.0
    s1.targetY = 41.2
    s2.targetX = 31.5
    s2.targetY = 42.0
    session.ai.pacing.firstEncounterStage = "staged"
  } else if (scene === "late-night-horde") {
    settings.ai.directorPacing = 1
    settings.ai.safeRadius = 20
    settings.ai.initialDensity = 0.25
    settings.ai.maxActiveNearPlayer = 4
    settings.dayCycle.hour = 22.5
    session.view.hour = 22.5
    session.view.time = 420
    Object.assign(session.ai.config, settings.ai)
    session.ai.syncPopulation(session.view.town, 44, 44)
    harness.pose(41.5, 43.5, 0)
    session.ai.emitNoise(41.5, 43.5, 34, "gunshot", session.view.time, "player", 2.0)
    for (const [zx, zy] of [
      [48.2, 42.6],
      [49.4, 44.5],
      [47.5, 45.8],
      [51.0, 43.2],
    ] as const) {
      const z = session.ai.spawnZombie(session.view.town, zx, zy, "chase", Math.PI)
      z.targetX = 41.5
      z.targetY = 43.5
    }
  } else {
    settings.ai.directorPacing = 1
    settings.ai.safeRadius = 20
    settings.ai.initialDensity = 0.25
    settings.ai.startHour = 16.0
    settings.dayCycle.hour = 16.0
    session.view.hour = 16.0
    Object.assign(session.ai.config, settings.ai)
    session.ai.resetOpeningPopulation(
      session.view.town,
      session.sim.slots.map((s) => s.survivor),
    )
    harness.pose(27.7, 41, -Math.PI / 2)
  }
  if (settings.dayCycle.dayNightLook === 1 && settings.dayCycle.lookPreset === "noir") {
    host.setLastDayNightHour(session.view.hour)
    applyOutbreakDayNight(session.view.hour, lookSettings, settings)
  }
  lab.refresh()
  return { scene, pacing: { ...session.ai.pacing.telemetry }, hour: session.view.hour }
}

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
