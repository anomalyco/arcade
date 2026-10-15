import { describe, expect, test } from "bun:test"
import {
  canSpawnZombieAt,
  coopChaserScale,
  coopPopulationScale,
  DEFAULT_AI_CONFIG,
  DEFAULT_PACING_TUNING,
  initialSpawnCount,
  isInsideSafeZone,
  isSpawnBehindPlayer,
  isSpawnInView,
  pacingControls,
  STARTING_SAFEHOUSE_RECT,
} from "../shared/ai"
import { TICK_DT } from "../shared/clock"
import { CoopSim, SPAWN_POINTS } from "../shared/coop-sim"
import { sightRects } from "../shared/map"
import { LocalSession } from "../shared/session"
import { createOutbreakSettings, setOutbreakSetting } from "../src/settings"

describe("Outbreak first-night opening pacing & spawn rules", () => {
  test("Pacing group Lab controls cover all PacingTuning keys with explicit ranges, steps, units and defaults", () => {
    expect(pacingControls.map((c) => String(c.key)).sort()).toEqual(Object.keys(DEFAULT_PACING_TUNING).sort())
    for (const control of pacingControls) {
      expect(control.group).toBe("Pacing")
      const def = DEFAULT_PACING_TUNING[control.key as keyof typeof DEFAULT_PACING_TUNING]
      expect(def).toBeGreaterThanOrEqual(control.min)
      expect(def).toBeLessThanOrEqual(control.max)
      expect(typeof control.unit).toBe("string")
    }

    const settings = createOutbreakSettings()
    expect(settings.ai.startHour).toBe(16.0)
    expect(settings.dayCycle.hour).toBe(16.0)
    expect(settings.ai.safeRadius).toBe(20)
    expect(settings.ai.initialDensity).toBe(0.25)
    expect(settings.ai.rampTime).toBe(360)
    expect(settings.ai.noiseSensitivity).toBe(1.0)
    expect(settings.ai.maxActiveNearPlayer).toBe(4)

    setOutbreakSetting(settings, "safeRadius", 26)
    setOutbreakSetting(settings, "pacing.maxActiveNearPlayer", 6)
    expect(settings.ai.safeRadius).toBe(26)
    expect(settings.ai.maxActiveNearPlayer).toBe(6)
  })

  test("starting at 16:00 late afternoon gives sufficient natural light (>= 0.35) to research at the Ash workbench without a flashlight", () => {
    const session = new LocalSession(7)
    expect(session.view.hour).toBe(16.0)
    const benchLightAtStart = session.sim.progression.benchLight("bench:ash", session.view.hour, [])
    expect(benchLightAtStart).toBeGreaterThan(0.35)
    // Even 32 s into the session (17:04, after searching 3 containers), natural bench light is still > 0.35
    const benchLightAt32s = session.sim.progression.benchLight("bench:ash", 17.07, [])
    expect(benchLightAt32s).toBeGreaterThan(0.35)

    // At 18:00 (old start hour) with flashlight off, the workbench was already too dark (< 0.35)
    const benchLightAt18 = session.sim.progression.benchLight("bench:ash", 18.0, [])
    expect(benchLightAt18).toBeLessThan(0.35)
  })

  test("opening spawn clears safeRadius around spawn and Ash House, spaces out sparse shamblers, and never spawns in view or behind player", () => {
    const session = new LocalSession(7)
    const p = session.view.player
    const town = session.view.town
    const blockers = sightRects(town)
    const zombies = session.view.zombies

    // 25% of 28 = 7 initial wandering shamblers
    expect(zombies.length).toBe(initialSpawnCount(DEFAULT_AI_CONFIG.zombieCount, DEFAULT_AI_CONFIG.initialDensity, 1, 1))
    expect(zombies.length).toBe(7)

    const [sx0, sy0, sx1, sy1] = STARTING_SAFEHOUSE_RECT
    for (const z of zombies) {
      expect(z.state).toBe("wander")
      expect(z.awareness).toBe(0)
      const dist = Math.hypot(z.x - p.x, z.y - p.y)
      expect(dist).toBeGreaterThanOrEqual(DEFAULT_AI_CONFIG.safeRadius)
      // Never inside Ash House
      const inAsh = z.x >= sx0 && z.x <= sx1 && z.y >= sy0 && z.y <= sy1
      expect(inAsh).toBe(false)
      // Never in initial sight cone or flashlight beam
      expect(isSpawnInView(z.x, z.y, [p], blockers)).toBe(false)
    }

    // Check pairwise spacing of initial zombies (spaced out, not clumped)
    for (let i = 0; i < zombies.length; i++) {
      for (let j = i + 1; j < zombies.length; j++) {
        const d = Math.hypot(zombies[i]!.x - zombies[j]!.x, zombies[i]!.y - zombies[j]!.y)
        expect(d).toBeGreaterThanOrEqual(8.0)
      }
    }
  })

  test("canSpawnZombieAt enforces safeRadius, sight cone, close awareness, flashlight cone, and rear-hemisphere exclusions", () => {
    const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 })
    const town = session.view.town
    const nav = session.ai.nav
    const blockers = sightRects(town)
    const survivor = { x: 44, y: 44, aim: 0, flashlightOn: true, flashlightOutput: 1 } // At crossroads facing East (0)

    // 1. Inside safeRadius (10 m < 20 m) -> rejected
    expect(
      canSpawnZombieAt(54, 44, town, nav, [survivor], blockers, { safeRadius: 20 }),
    ).toBe(false)

    // 2. Outside safeRadius (24 m East) but directly in unobstructed sight cone -> rejected
    expect(isSpawnInView(68, 44, [survivor], blockers)).toBe(true)
    expect(
      canSpawnZombieAt(68, 44, town, nav, [survivor], blockers, { safeRadius: 20, forbidInView: true }),
    ).toBe(false)

    // 3. Right behind player (15 m West along street, aim = 0) -> rejected by behind-player rule even if safeRadius is smaller
    expect(isSpawnBehindPlayer(29, 44, [survivor], 20)).toBe(true)
    expect(
      canSpawnZombieAt(29, 44, town, nav, [survivor], blockers, { safeRadius: 10, forbidBehind: true, behindDist: 20 }),
    ).toBe(false)

    // 4. Inside starting safehouse (Ash House [22..37, 24..35.5]) -> rejected
    expect(isInsideSafeZone(28, 30, [survivor], 20)).toBe(true)

    // 5. Valid backstage point (26 m North-East behind Hardware Store wall at (64, 20), occluded from (44, 44) and outside rear arc) -> accepted
    expect(isSpawnInView(64, 20, [survivor], blockers)).toBe(false)
    expect(isSpawnBehindPlayer(64, 20, [survivor], 20)).toBe(false)
    expect(
      canSpawnZombieAt(64, 20, town, nav, [survivor], blockers, { safeRadius: 20, forbidInView: true, forbidBehind: true }),
    ).toBe(true)
  })

  test("director stages a 1–3 zombie first encounter after exploration, ramps with time/noise/distance/threat, and caps simultaneous chasers", () => {
    const session = new LocalSession(7)
    const p = session.view.player

    // First 30 s: player explores inside Ash House and searches containers; 0 chasers
    Object.assign(p, { x: 27.7, y: 31.5, aim: -Math.PI / 2 })
    for (let i = 0; i < 30 * 60; i++) {
      const angle = (i / 60) * 0.5
      session.update(TICK_DT, { mx: Math.cos(angle) * 0.5, my: Math.sin(angle) * 0.5, aim: angle, interact: false }, 120)
    }
    expect(session.ai.pacing.telemetry.activeChasers).toBe(0)
    expect(session.ai.pacing.firstEncounterStage).toBe("grace")

    // Advance past 45 s so first encounter triggers (1–3 investigating scouts)
    Object.assign(p, { x: 29.5, y: 41.0, aim: 0 })
    for (let i = 0; i < 20 * 60; i++) {
      session.update(TICK_DT, { mx: 0.2, my: 0, aim: 0, interact: false }, 120)
    }
    expect(["staged", "completed"]).toContain(session.ai.pacing.firstEncounterStage)
    const engagedEarly = session.view.zombies.filter(
      (z) => z.state === "investigate" || z.state === "alert" || z.state === "chase",
    )
    expect(engagedEarly.length).toBeGreaterThanOrEqual(1)
    expect(engagedEarly.length).toBeLessThanOrEqual(3)

    // Even if 12 zombies are alerted at once by loud noise, active chasers never exceed effectiveMaxActive
    for (const z of session.view.zombies) {
      z.state = "chase"
      z.awareness = 1
      z.targetX = p.x
      z.targetY = p.y
    }
    session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false }, 120)
    const chasersAfterCap = session.view.zombies.filter(
      (z) => z.state === "chase" || z.state === "alert" || z.state === "bash",
    ).length
    expect(chasersAfterCap).toBeLessThanOrEqual(session.ai.pacing.telemetry.effectiveMaxActive)
    expect(chasersAfterCap).toBeLessThanOrEqual(DEFAULT_AI_CONFIG.maxActiveNearPlayer)
  })

  test("co-op scales opening count, target population, and active chaser cap by survivor count (1 vs 4 players)", () => {
    const soloSim = new CoopSim(7)
    const soloSlot = soloSim.addSurvivor("p0", 0)
    soloSim.stepSurvivor(soloSlot, { mx: 0, my: 0, aim: -Math.PI / 2, interact: false }, TICK_DT)
    soloSim.stepWorld(TICK_DT, 120)

    const coopSim = new CoopSim(7)
    const coopSlots = SPAWN_POINTS.map((_, idx) => coopSim.addSurvivor(`p${idx}`, idx))
    for (const slot of coopSlots) {
      coopSim.stepSurvivor(slot, { mx: 0, my: 0, aim: -Math.PI / 2, interact: false }, TICK_DT)
    }
    coopSim.stepWorld(TICK_DT, 120)

    expect(coopPopulationScale(4)).toBeCloseTo(2.05, 4)
    expect(coopChaserScale(4)).toBeCloseTo(2.8, 4)
    expect(coopSim.ai.agents.length).toBeGreaterThan(soloSim.ai.agents.length)
    expect(coopSim.ai.pacing.telemetry.desiredPopulation).toBeGreaterThan(soloSim.ai.pacing.telemetry.desiredPopulation)

    // Advance both to late night (t = 400 s, hour = 23) and compare effectiveMaxActive and desiredPopulation
    soloSim.time = 400
    soloSim.hour = 23
    soloSim.stepWorld(TICK_DT, 120)

    coopSim.time = 400
    coopSim.hour = 23
    coopSim.stepWorld(TICK_DT, 120)

    expect(coopSim.ai.pacing.telemetry.desiredPopulation).toBeGreaterThan(soloSim.ai.pacing.telemetry.desiredPopulation)
    expect(coopSim.ai.pacing.telemetry.effectiveMaxActive).toBeGreaterThan(
      soloSim.ai.pacing.telemetry.effectiveMaxActive * 2,
    )
  })
})
