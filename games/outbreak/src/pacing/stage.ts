import { DEFAULT_PACING_TUNING } from "../../shared/pacing"
import { applyOutbreakDayNight } from "../day-night"
import type { OutbreakHarness, OutbreakHarnessHost } from "../harness"
import { stageProgression } from "../progression/lab"

export const PACING_SCENES = [
  "opening-calm",
  "safehouse-workbench",
  "first-contact",
  "late-night-horde",
  "legacy-rush",
] as const

export type PacingScene = (typeof PACING_SCENES)[number]

/** Clock when the solo route reaches the Ash workbench (about 35 s in at the default opening clock). */
const WORKBENCH_HOUR = 17.8

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
    settings.ai.startHour = DEFAULT_PACING_TUNING.startHour
    settings.dayCycle.hour = WORKBENCH_HOUR
    session.view.hour = WORKBENCH_HOUR
    Object.assign(session.ai.config, settings.ai)
    session.ai.resetOpeningPopulation(
      session.view.town,
      session.sim.slots.map((s) => s.survivor),
    )
    stageProgression(progressionHost, "bench")
    settings.dayCycle.hour = WORKBENCH_HOUR
    session.view.hour = WORKBENCH_HOUR
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
    settings.ai.startHour = DEFAULT_PACING_TUNING.startHour
    settings.dayCycle.hour = DEFAULT_PACING_TUNING.startHour
    session.view.hour = DEFAULT_PACING_TUNING.startHour
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
