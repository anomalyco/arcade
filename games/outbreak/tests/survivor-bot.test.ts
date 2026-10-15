import { describe, expect, test } from "bun:test"
import { TICK_DT } from "../shared/clock"
import { CoopSim } from "../shared/coop-sim"
import {
  BotReplayPlayer,
  computeNightsSurvived,
  runHeadlessBotGame,
} from "../shared/bot-runner"
import {
  computeDifficultyLoss,
  DEFAULT_DIFFICULTY_VECTOR,
  evaluateDifficultyCandidate,
  quantizeDifficultyVector,
} from "../shared/difficulty-tuner"
import {
  BOT_SKILL_PRESETS,
  createBotWorldView,
  SurvivorBot,
} from "../shared/survivor-bot"

describe("SurvivorBot perception, input-only contract, determinism, and tuning", () => {
  test("never mutates simulation state during step() and acts strictly via Command", () => {
    const sim = new CoopSim(7, 7, 0.22, undefined, undefined, "classic")
    const slot = sim.addSurvivor("player", 0)
    const bot = new SurvivorBot("player", 0, 7, "Skilled")

    for (let i = 0; i < 30; i++) {
      const pBefore = JSON.stringify(slot.survivor)
      const revBefore = sim.progression.ledger.rev
      const doorsBefore = sim.town.doors.map((d) => `${d.id}:${d.open}:${d.locked}`).join(",")
      const agentsBefore = sim.ai.agents.map((a) => `${a.id}:${a.x}:${a.y}:${a.hp}:${a.state}`).join(",")

      const cmd = bot.step(TICK_DT, createBotWorldView(sim))

      // Verify bot.step() itself did not mutate survivor, ledger, doors, or zombies
      expect(JSON.stringify(slot.survivor)).toBe(pBefore)
      expect(sim.progression.ledger.rev).toBe(revBefore)
      expect(sim.town.doors.map((d) => `${d.id}:${d.open}:${d.locked}`).join(",")).toBe(doorsBefore)
      expect(sim.ai.agents.map((a) => `${a.id}:${a.x}:${a.y}:${a.hp}:${a.state}`).join(",")).toBe(agentsBefore)

      // Verify returned Command only contains valid player input fields
      expect(typeof cmd.mx).toBe("number")
      expect(typeof cmd.my).toBe("number")
      expect(typeof cmd.aim).toBe("number")
      expect(typeof cmd.interact).toBe("boolean")

      sim.stepSurvivor(slot, cmd, TICK_DT)
      sim.stepWorld(TICK_DT, 120)
    }
  })

  test("enforces player-bounded perception: camera footprint, wall occlusion, darkness, flashlight, and reaction time", () => {
    const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0, directorPacing: 0 }, undefined, "classic")
    const slot = sim.addSurvivor("player", 0)
    const p = slot.survivor
    // Place survivor on open street facing East (aim = 0)
    p.x = 44.0
    p.y = 44.0
    p.aim = 0
    sim.rebuildCollision()

    const bot = new SurvivorBot("player", 0, 7, "Casual")

    // 1. Zombie far outside camera footprint (35m away) -> never perceived
    const farZ = sim.ai.spawnZombie(sim.town, 79.0, 44.0, "wander", Math.PI)
    bot.step(0.05, createBotWorldView(sim))
    expect(bot.getTelemetry().perceivedThreats.some((t) => t.id === farZ.id)).toBe(false)

    // 2. Zombie behind solid house wall (inside Ash House while player is at x=27.7, y=41 with door closed)
    sim.ai.agents.length = 0
    p.x = 27.7
    p.y = 41.0
    p.aim = -Math.PI / 2
    for (const d of sim.town.doors) d.open = false
    sim.rebuildCollision()
    const occludedZ = sim.ai.spawnZombie(sim.town, 27.7, 28.0, "wander", Math.PI / 2)
    bot.step(0.05, createBotWorldView(sim))
    expect(
      bot.getTelemetry().perceivedThreats.some((t) => t.id === occludedZ.id && t.source === "sight"),
    ).toBe(false)

    // 3. Darkness vs Flashlight cone at midnight (hour = 23.5) away from streetlamps
    sim.ai.agents.length = 0
    sim.hour = 23.5
    p.x = 12.0
    p.y = 12.0
    p.aim = 0
    p.flashlightOn = false
    p.flashlightOutput = 0
    sim.rebuildCollision()

    // Place idle zombie 9m ahead in the dark (outside awarenessRadius=2.5m, unlit)
    const darkZ = sim.ai.spawnZombie(sim.town, 21.0, 12.0, "wander", Math.PI)
    const botDark = new SurvivorBot("player", 0, 11, "Casual")
    botDark.step(0.05, createBotWorldView(sim))
    expect(
      botDark.getTelemetry().perceivedThreats.some((t) => t.id === darkZ.id && t.source === "sight"),
    ).toBe(false)

    // Turn flashlight ON pointing at the zombie -> immediately seen via sight, gated by reactionTime!
    p.flashlightOn = true
    p.flashlightOutput = 1.0
    botDark.step(0.05, createBotWorldView(sim))
    const seenInitial = botDark.getTelemetry().perceivedThreats.find((t) => t.id === darkZ.id)
    expect(seenInitial).toBeDefined()
    expect(seenInitial?.source).toBe("sight")
    // At t = 0, reactionTime (0.34s for Casual) has not elapsed yet!
    expect(seenInitial?.actionable).toBe(false)

    // Advance sim.time past reactionTime (0.40s) -> threat becomes actionable
    sim.time += 0.4
    botDark.step(0.05, createBotWorldView(sim))
    const seenAfterReaction = botDark.getTelemetry().perceivedThreats.find((t) => t.id === darkZ.id)
    expect(seenAfterReaction?.actionable).toBe(true)
  })

  test("deterministic headless runs and bit-identical replay playback", () => {
    const runA = runHeadlessBotGame({
      seed: 7,
      preset: "Skilled",
      maxDurationSeconds: 90,
      timeScale: 240,
      recordReplay: true,
    })
    const runB = runHeadlessBotGame({
      seed: 7,
      preset: "Skilled",
      maxDurationSeconds: 90,
      timeScale: 240,
      recordReplay: false,
    })

    expect(runA.survivalTime).toBe(runB.survivalTime)
    expect(runA.nightsSurvived).toBe(runB.nightsSurvived)
    expect(runA.killsByWeapon).toEqual(runB.killsByWeapon)
    expect(runA.damageTaken).toBe(runB.damageTaken)
    expect(runA.ammoUsed).toEqual(runB.ammoUsed)
    expect(runA.staminaUsed).toEqual(runB.staminaUsed)
    expect(runA.itemsLooted).toEqual(runB.itemsLooted)
    expect(runA.unfairSpawns).toEqual({ inView: 0, behindPlayer: 0 })

    // Verify replay reproduces the exact run
    expect(runA.replay).toBeDefined()
    const player = new BotReplayPlayer(runA.replay!)
    const replayed = player.runAll()
    expect(replayed.time).toBe(runA.survivalTime)
  })

  test("supports 4-player co-op bot squads and searches containers", () => {
    const coopRun = runHeadlessBotGame({
      seed: 7,
      preset: "Skilled",
      playerCount: 4,
      maxDurationSeconds: 60,
      timeScale: 180,
    })
    expect(coopRun.playerCount).toBe(4)
    expect(coopRun.itemsLooted.containersSearched).toBeGreaterThan(0)
    expect(coopRun.distanceExplored.totalDistanceWalked).toBeGreaterThan(15)
    expect(coopRun.unfairSpawns).toEqual({ inView: 0, behindPlayer: 0 })
  })

  test("difficulty tuner quantizes vectors, computes nights, and evaluates multi-preset batches", () => {
    const n0 = computeNightsSurvived(20, 240, 16.0)
    expect(n0.completedNights).toBe(0)
    expect(n0.nightsSurvived).toBeGreaterThan(0)
    expect(n0.nightsSurvived).toBeLessThan(0.15)

    const n1 = computeNightsSurvived(210, 240, 16.0)
    expect(n1.completedNights).toBe(1)
    expect(n1.nightsSurvived).toBeCloseTo(1.0, 2)

    const q = quantizeDifficultyVector(DEFAULT_DIFFICULTY_VECTOR)
    expect(q.zombieCount).toBe(DEFAULT_DIFFICULTY_VECTOR.zombieCount)

    const evalRes = evaluateDifficultyCandidate({
      label: "test-eval",
      vector: DEFAULT_DIFFICULTY_VECTOR,
      seeds: [7],
      presets: ["Novice", "Expert"],
      maxDurationSeconds: 60,
      timeScale: 240,
    })
    expect(evalRes.runs.length).toBe(2)
    expect(Number.isFinite(computeDifficultyLoss(evalRes.byPreset))).toBe(true)
    expect(BOT_SKILL_PRESETS.Expert.reactionTime).toBeLessThan(BOT_SKILL_PRESETS.Novice.reactionTime)
  })
})
