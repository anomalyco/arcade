import type { AIConfig } from "./ai"
import { TICK_DT } from "./clock"
import { CoopSim, type SurvivorSlot } from "./coop-sim"
import { dayCycle } from "./day-cycle"
import { buildingAt, type ProgressionTuning } from "./progression"
import type { Command } from "./session"
import {
  BOT_SKILL_PRESETS,
  createBotWorldView,
  SurvivorBot,
  type BotIntentKind,
  type BotSkillConfig,
  type BotSkillPresetId,
} from "./survivor-bot"
import type { WorldMode } from "./world"

export type CauseOfDeath =
  | "survived"
  | "cornered-by-horde"
  | "out-of-ammo"
  | "exhausted-overrun"
  | "ambushed-in-dark"
  | "attrition"

export type BotRunTimelineEvent = {
  t: number
  hour: number
  kind:
    | "spawn"
    | "loot"
    | "workbench"
    | "research"
    | "craft"
    | "barricade"
    | "first-contact"
    | "kill"
    | "close-call"
    | "heal"
    | "nightfall"
    | "dawn"
    | "death"
  detail: string
  x: number
  y: number
}

export type BotRunTimeSample = {
  t: number
  hour: number
  nights: number
  threat: number
  ramp: number
  activeChasers: number
  livingZombies: number
  effectiveMaxActive: number
  health: number
  stamina: number
  totalAmmo: number
  kills: number
  intent: BotIntentKind
}

export type ReplayTickFrame = {
  tick: number
  commands: Command[]
}

export type BotReplayLog = {
  version: 1
  seed: number
  houseSeed: number
  terrain: number
  timeScale: number
  tickDt?: number
  playerCount: number
  preset: BotSkillPresetId
  skillOverrides?: Partial<BotSkillConfig>
  aiConfig?: Partial<AIConfig>
  progressionTuning?: Partial<ProgressionTuning>
  worldMode: WorldMode
  totalTicks: number
  frames: ReplayTickFrame[]
}

export type BotRunConfig = {
  seed: number
  houseSeed?: number
  terrain?: number
  preset: BotSkillPresetId
  skillOverrides?: Partial<BotSkillConfig>
  playerCount?: number
  /** Simulated seconds cap (default 1260s = 4 full day/night cycles at timeScale=240). */
  maxDurationSeconds?: number
  /** Game clock speed in simulated seconds per real second (default 240 = 4 game min/s). */
  timeScale?: number
  /** Fixed simulation timestep in seconds (defaults to TICK_DT when recording a 60 Hz replay, or TICK_DT * 3 in batch runs). */
  tickDt?: number
  aiConfig?: Partial<AIConfig>
  progressionTuning?: Partial<ProgressionTuning>
  worldMode?: WorldMode
  recordReplay?: boolean
  configLabel?: string
}

export type BotRunResult = {
  seed: number
  preset: BotSkillPresetId
  playerCount: number
  configLabel: string
  survived: boolean
  survivalTime: number
  nightsSurvived: number
  completedNights: number
  causeOfDeath: CauseOfDeath
  deathPosition: {
    x: number
    y: number
    hour: number
    indoor: boolean
    buildingId: string | null
  } | null
  killsByWeapon: {
    pistol: number
    melee: number
    shove: number
    total: number
  }
  damageTaken: number
  ammoUsed: {
    shotsFired: number
    shotsHit: number
    accuracy: number
    reloads: number
  }
  staminaUsed: {
    totalConsumed: number
    exhaustedCount: number
    exhaustedSeconds: number
  }
  itemsLooted: {
    containersSearched: number
    itemsTaken: number
    byItem: Record<string, number>
  }
  itemsCrafted: {
    recipesResearched: string[]
    itemsCrafted: number
    barricadesBuilt: number
    healsUsed: number
  }
  timeToWorkbench: number | null
  firstContactTime: number | null
  peakSimultaneousChasers: number
  meanSimultaneousChasers: number
  distanceExplored: {
    maxRadiusFromSpawn: number
    totalDistanceWalked: number
    buildingsVisited: number
  }
  closeCalls: number
  unfairSpawns: {
    inView: number
    behindPlayer: number
  }
  timeline: BotRunTimelineEvent[]
  series: BotRunTimeSample[]
  replay?: BotReplayLog
}

/**
 * Converts elapsed game hours (starting from `startHour`, default 16:00) into continuous `nightsSurvived`
 * and integer `completedNights`.
 * - 16:00..18:00 (first 2 hours): 0.00 .. 0.15 (First Evening)
 * - 18:00..06:00 (12 hours of Night 1): 0.15 .. 1.00 (Dawn 1 = 1.0 night survived)
 * - Subsequent 24h cycles: +0.20 across daytime (06:00..18:00) and +0.80 across night (18:00..06:00).
 */
export function computeNightsSurvived(
  elapsedSeconds: number,
  timeScale: number,
  startHour = 16.0,
): { nightsSurvived: number; completedNights: number } {
  const elapsedHours = (elapsedSeconds * timeScale) / 3600
  const eveningSpan = Math.max(0.5, 18.0 - startHour)
  if (elapsedHours <= eveningSpan) {
    return {
      nightsSurvived: Number(((elapsedHours / eveningSpan) * 0.15).toFixed(3)),
      completedNights: 0,
    }
  }
  const afterFirstEvening = elapsedHours - eveningSpan
  // First night is 12 hours (18:00 -> 06:00)
  if (afterFirstEvening < 12) {
    return {
      nightsSurvived: Number((0.15 + (afterFirstEvening / 12) * 0.85).toFixed(3)),
      completedNights: 0,
    }
  }
  const afterNight1 = afterFirstEvening - 12
  const extraFullDays = Math.floor(afterNight1 / 24)
  const remHours = afterNight1 - extraFullDays * 24
  const completedNights = 1 + extraFullDays + (remHours >= 24 ? 1 : 0)
  const subProgress =
    remHours <= 12
      ? (remHours / 12) * 0.2
      : 0.2 + ((remHours - 12) / 12) * 0.8
  return {
    nightsSurvived: Number((1 + extraFullDays + subProgress).toFixed(3)),
    completedNights,
  }
}

/**
 * Runs one deterministic headless Outbreak game with 1–4 `SurvivorBot`s and collects rich gameplay telemetry.
 */
export function runHeadlessBotGame(config: BotRunConfig): BotRunResult {
  const seed = config.seed >>> 0
  const houseSeed = (config.houseSeed ?? seed) >>> 0
  const terrain = config.terrain ?? 0.22
  const playerCount = Math.max(1, Math.min(4, Math.round(config.playerCount ?? 1)))
  const timeScale = config.timeScale ?? 240
  const maxDurationSeconds = config.maxDurationSeconds ?? 1260
  const worldMode: WorldMode = config.worldMode ?? "classic"
  const configLabel = config.configLabel ?? "default"

  const sim = new CoopSim(
    seed,
    houseSeed,
    terrain,
    config.aiConfig,
    config.progressionTuning,
    worldMode,
  )

  const slots: SurvivorSlot[] = []
  const bots: SurvivorBot[] = []
  for (let i = 0; i < playerCount; i++) {
    const actorId = i === 0 ? "player" : `bot-${i}`
    const slot = sim.addSurvivor(actorId, i)
    slots.push(slot)
    bots.push(
      new SurvivorBot(
        actorId,
        i,
        seed + i * 97,
        config.preset,
        config.skillOverrides,
      ),
    )
  }

  // Evaluate initial t = 0 pacing telemetry
  sim.ai.pacing.stepAfterCrowd(
    sim.ai.nav,
    sim.ai.agents,
    slots.map((s) => s.survivor),
    sim.ai.config,
    0,
    false,
  )

  const startHour = sim.hour
  let killsPistol = 0
  let killsMelee = 0
  let killsShove = 0
  const deadZombieIds = new Set<number>()
  let lastShotId = 0

  let shotsFired = 0
  let shotsHit = 0
  let reloads = 0
  const wasReloading = new Array<boolean>(playerCount).fill(false)

  let totalDamageTaken = 0
  const prevHealth = slots.map((s) => s.survivor.health)
  let totalStaminaConsumed = 0
  const prevStamina = slots.map((s) => s.survivor.stamina)
  const wasExhausted = new Array<boolean>(playerCount).fill(false)
  let exhaustedCount = 0
  let exhaustedSeconds = 0

  let containersSearched = 0
  let itemsTaken = 0
  const itemsByKind: Record<string, number> = {}
  const recipesResearched: string[] = []
  let itemsCrafted = 0
  let barricadesBuilt = 0
  let healsUsed = 0
  let timeToWorkbench: number | null = null

  const visitedBuildings = new Set<string>()
  let peakChasers = 0
  let chaserSum = 0
  let chaserSamples = 0
  let closeCalls = 0
  let inDangerSince: number | null = null
  let lastCloseCallTime = -30

  const timeline: BotRunTimelineEvent[] = [
    {
      t: 0,
      hour: Number(sim.hour.toFixed(2)),
      kind: "spawn",
      detail: `Spawned ${playerCount}x ${config.preset} survivor(s)`,
      x: Number(slots[0]!.survivor.x.toFixed(1)),
      y: Number(slots[0]!.survivor.y.toFixed(1)),
    },
  ]
  const series: BotRunTimeSample[] = []
  const replayFrames: ReplayTickFrame[] = []

  // Subscribe to progression ledger events for exact item/recipe/craft/barricade tracking
  sim.progression.ledger.on((ev) => {
    const lead = slots[0]!.survivor
    if (ev.kind === "revealed") {
      containersSearched++
      if (timeline.length < 120) {
        timeline.push({
          t: Number(sim.time.toFixed(1)),
          hour: Number(sim.hour.toFixed(2)),
          kind: "loot",
          detail: `Searched ${ev.store} (${ev.items.length} stacks)`,
          x: Number(lead.x.toFixed(1)),
          y: Number(lead.y.toFixed(1)),
        })
      }
    } else if (ev.kind === "changed" && ev.delta > 0 && ev.actor) {
      if (ev.store.endsWith("/belt") || ev.store.endsWith("/hotbar") || ev.store.endsWith("/pack")) {
        itemsTaken += ev.delta
        itemsByKind[ev.item] = (itemsByKind[ev.item] ?? 0) + ev.delta
      }
    } else if (ev.kind === "changed" && ev.delta > 0 && ev.store.startsWith("bench:")) {
      if (timeToWorkbench === null) {
        timeToWorkbench = Number(sim.time.toFixed(2))
        timeline.push({
          t: timeToWorkbench,
          hour: Number(sim.hour.toFixed(2)),
          kind: "workbench",
          detail: `Reached Workbench (${ev.store})`,
          x: Number(lead.x.toFixed(1)),
          y: Number(lead.y.toFixed(1)),
        })
      }
    } else if (ev.kind === "unlocked" && ev.source === "rule") {
      recipesResearched.push(ev.item.replace(/^learned:/, ""))
      if (timeToWorkbench === null) {
        timeToWorkbench = Number(sim.time.toFixed(2))
      }
      timeline.push({
        t: Number(sim.time.toFixed(1)),
        hour: Number(sim.hour.toFixed(2)),
        kind: "research",
        detail: `Researched ${ev.label}`,
        x: Number(lead.x.toFixed(1)),
        y: Number(lead.y.toFixed(1)),
      })
    } else if (ev.kind === "ran") {
      if (ev.rule.startsWith("craft:")) {
        itemsCrafted++
        timeline.push({
          t: Number(sim.time.toFixed(1)),
          hour: Number(sim.hour.toFixed(2)),
          kind: "craft",
          detail: `Crafted ${ev.rule.replace(/^craft:/, "")}`,
          x: Number(lead.x.toFixed(1)),
          y: Number(lead.y.toFixed(1)),
        })
      } else if (ev.rule.startsWith("barricade")) {
        barricadesBuilt++
        if (barricadesBuilt <= 8) {
          timeline.push({
            t: Number(sim.time.toFixed(1)),
            hour: Number(sim.hour.toFixed(2)),
            kind: "barricade",
            detail: `Boarded ${ev.ref ?? "portal"}`,
            x: Number(lead.x.toFixed(1)),
            y: Number(lead.y.toFixed(1)),
          })
        }
      } else if (ev.rule.startsWith("heal:")) {
        healsUsed++
        timeline.push({
          t: Number(sim.time.toFixed(1)),
          hour: Number(sim.hour.toFixed(2)),
          kind: "heal",
          detail: `Used ${ev.rule.replace(/^heal:/, "")}`,
          x: Number(lead.x.toFixed(1)),
          y: Number(lead.y.toFixed(1)),
        })
      }
    }
  })

  let recordedFirstContact = false
  let prevCompletedNights = 0
  const stepDt = config.tickDt ?? TICK_DT * 3
  const maxTicks = Math.round(maxDurationSeconds / stepDt)
  const sampleIntervalTicks = Math.max(1, Math.round(15 / stepDt))
  let finalTick = 0

  for (let tick = 1; tick <= maxTicks; tick++) {
    finalTick = tick
    const worldView = createBotWorldView(sim)
    const tickCommands: Command[] = []

    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]!
      const bot = bots[i]!
      const cmd = slot.survivor.health > 0 ? bot.step(stepDt, worldView) : { mx: 0, my: 0, aim: slot.survivor.aim, interact: false }
      tickCommands.push(cmd)

      const heldItem = sim.progression.selected(slot.id)?.item ?? "hands"
      const deadBefore = sim.ai.agents.filter((a) => a.state === "dead").length
      sim.stepSurvivor(slot, cmd, stepDt)
      const deadAfter = sim.ai.agents.filter((a) => a.state === "dead").length

      if (deadAfter > deadBefore) {
        // Check if deaths came from pistol shots or melee/shove
        for (const shot of sim.combat.shots) {
          if (shot.id > lastShotId) {
            shotsFired++
            if (shot.hitZombieId !== null) shotsHit++
            if (shot.killed && shot.hitZombieId !== null && !deadZombieIds.has(shot.hitZombieId)) {
              deadZombieIds.add(shot.hitZombieId)
              killsPistol++
            }
            lastShotId = shot.id
          }
        }
        for (const z of sim.ai.agents) {
          if (z.state === "dead" && !deadZombieIds.has(z.id)) {
            deadZombieIds.add(z.id)
            if (heldItem === "crowbar" || heldItem === "spiked-board") {
              killsMelee++
            } else {
              killsShove++
            }
          }
        }
      } else {
        for (const shot of sim.combat.shots) {
          if (shot.id > lastShotId) {
            shotsFired++
            if (shot.hitZombieId !== null) shotsHit++
            lastShotId = shot.id
          }
        }
      }

      if (timeToWorkbench === null && slot.prompt?.kind === "bench") {
        timeToWorkbench = Number(sim.time.toFixed(2))
        timeline.push({
          t: timeToWorkbench,
          hour: Number(sim.hour.toFixed(2)),
          kind: "workbench",
          detail: `Reached ${slot.prompt.id}`,
          x: Number(slot.survivor.x.toFixed(1)),
          y: Number(slot.survivor.y.toFixed(1)),
        })
      }
    }

    if (config.recordReplay) {
      replayFrames.push({ tick, commands: tickCommands })
    }

    sim.stepWorld(stepDt, timeScale)

    // Track per-survivor health, stamina, reload, and visited buildings
    for (let i = 0; i < slots.length; i++) {
      const p = slots[i]!.survivor
      if (p.health < prevHealth[i]!) {
        totalDamageTaken += prevHealth[i]! - p.health
      }
      prevHealth[i] = p.health

      if (p.stamina < prevStamina[i]!) {
        totalStaminaConsumed += prevStamina[i]! - p.stamina
      }
      prevStamina[i] = p.stamina

      if (p.exhausted) {
        exhaustedSeconds += stepDt / playerCount
        if (!wasExhausted[i]) {
          exhaustedCount++
          wasExhausted[i] = true
        }
      } else {
        wasExhausted[i] = false
      }

      const reloadingNow = p.reloadRemaining > 0
      if (reloadingNow && !wasReloading[i]) {
        reloads++
      }
      wasReloading[i] = reloadingNow

      const b = buildingAt(sim.town, p.x, p.y)
      if (b) visitedBuildings.add(b.id)
    }

    const tel = sim.ai.pacing.telemetry
    peakChasers = Math.max(peakChasers, tel.activeChasers)
    chaserSum += tel.activeChasers
    chaserSamples++

    if (!recordedFirstContact && tel.firstContactTime !== null) {
      recordedFirstContact = true
      const lead = slots[0]!.survivor
      timeline.push({
        t: Number(tel.firstContactTime.toFixed(1)),
        hour: Number(sim.hour.toFixed(2)),
        kind: "first-contact",
        detail: `First contact (${tel.activeChasers} chaser(s))`,
        x: Number(lead.x.toFixed(1)),
        y: Number(lead.y.toFixed(1)),
      })
    }

    // Close-call detection: low HP (< 30) or >= 3 zombies within 2.1m, followed by surviving >= 6s
    const lead = slots[0]!.survivor
    const closeZombies = sim.ai.agents.filter(
      (z) => z.state !== "dead" && Math.hypot(z.x - lead.x, z.y - lead.y) <= 2.1,
    ).length
    if ((lead.health > 0 && lead.health < 30 && tel.activeChasers > 0) || closeZombies >= 3) {
      if (inDangerSince === null) inDangerSince = sim.time
    } else if (inDangerSince !== null && lead.health > 0 && sim.time - inDangerSince >= 4.5) {
      if (sim.time - lastCloseCallTime >= 12) {
        closeCalls++
        lastCloseCallTime = sim.time
        timeline.push({
          t: Number(sim.time.toFixed(1)),
          hour: Number(sim.hour.toFixed(2)),
          kind: "close-call",
          detail: `Escaped close call (${Math.round(lead.health)} HP, ${tel.activeChasers} chasers)`,
          x: Number(lead.x.toFixed(1)),
          y: Number(lead.y.toFixed(1)),
        })
      }
      inDangerSince = null
    }

    const nightState = computeNightsSurvived(sim.time, timeScale, startHour)
    if (nightState.completedNights > prevCompletedNights) {
      prevCompletedNights = nightState.completedNights
      timeline.push({
        t: Number(sim.time.toFixed(1)),
        hour: Number(sim.hour.toFixed(2)),
        kind: "dawn",
        detail: `Survived Night ${prevCompletedNights}`,
        x: Number(lead.x.toFixed(1)),
        y: Number(lead.y.toFixed(1)),
      })
    }

    // Sample series every 15 seconds (or on tick 1)
    if (tick === 1 || tick % sampleIntervalTicks === 0) {
      const botTel = bots[0]!.getTelemetry()
      series.push({
        t: Number(sim.time.toFixed(1)),
        hour: Number(sim.hour.toFixed(2)),
        nights: nightState.nightsSurvived,
        threat: Number(tel.threat.toFixed(3)),
        ramp: Number(tel.ramp.toFixed(3)),
        activeChasers: tel.activeChasers,
        livingZombies: tel.livingPopulation,
        effectiveMaxActive: tel.effectiveMaxActive,
        health: Number(lead.health.toFixed(1)),
        stamina: Number(lead.stamina.toFixed(2)),
        totalAmmo: lead.magAmmo + lead.reserveAmmo,
        kills: killsPistol + killsMelee + killsShove,
        intent: botTel.intent,
      })
    }

    // Check termination: in solo, when player dies; in co-op, when all survivors die
    const anyAlive = slots.some((s) => s.survivor.health > 0)
    if (!anyAlive) {
      break
    }
  }

  const lead = slots[0]!.survivor
  const survived = slots.some((s) => s.survivor.health > 0)
  const survivalTime = Number(sim.time.toFixed(2))
  const { nightsSurvived, completedNights } = computeNightsSurvived(survivalTime, timeScale, startHour)
  const tel = sim.ai.pacing.telemetry

  let causeOfDeath: CauseOfDeath = "survived"
  let deathPosition: BotRunResult["deathPosition"] = null

  if (!survived) {
    const b = buildingAt(sim.town, lead.x, lead.y)
    deathPosition = {
      x: Number(lead.x.toFixed(2)),
      y: Number(lead.y.toFixed(2)),
      hour: Number(sim.hour.toFixed(2)),
      indoor: Boolean(b),
      buildingId: b?.id ?? null,
    }
    const totalAmmoLeft = lead.magAmmo + lead.reserveAmmo
    const nearbyAttackers = sim.ai.agents.filter(
      (z) => z.state !== "dead" && Math.hypot(z.x - lead.x, z.y - lead.y) < 4.5,
    ).length
    if ((lead.exhausted || lead.stamina < 0.24) && nearbyAttackers >= 2) {
      causeOfDeath = "exhausted-overrun"
    } else if (nearbyAttackers >= 3 || tel.activeChasers >= 3) {
      causeOfDeath = "cornered-by-horde"
    } else if (dayCycle(sim.hour).darkness > 0.65 && (!lead.flashlightOn || lead.batteryDepleted)) {
      causeOfDeath = "ambushed-in-dark"
    } else if (totalAmmoLeft === 0 && shotsFired >= 6) {
      causeOfDeath = "out-of-ammo"
    } else {
      causeOfDeath = "attrition"
    }

    timeline.push({
      t: survivalTime,
      hour: Number(sim.hour.toFixed(2)),
      kind: "death",
      detail: `Died (${causeOfDeath}) at (${lead.x.toFixed(1)}, ${lead.y.toFixed(1)}) after ${nightsSurvived.toFixed(2)} nights`,
      x: Number(lead.x.toFixed(1)),
      y: Number(lead.y.toFixed(1)),
    })
  }

  const totalKills = killsPistol + killsMelee + killsShove
  return {
    seed,
    preset: config.preset,
    playerCount,
    configLabel,
    survived,
    survivalTime,
    nightsSurvived,
    completedNights,
    causeOfDeath,
    deathPosition,
    killsByWeapon: {
      pistol: killsPistol,
      melee: killsMelee,
      shove: killsShove,
      total: totalKills,
    },
    damageTaken: Number(totalDamageTaken.toFixed(1)),
    ammoUsed: {
      shotsFired,
      shotsHit,
      accuracy: shotsFired > 0 ? Number((shotsHit / shotsFired).toFixed(3)) : 0,
      reloads,
    },
    staminaUsed: {
      totalConsumed: Number(totalStaminaConsumed.toFixed(2)),
      exhaustedCount,
      exhaustedSeconds: Number(exhaustedSeconds.toFixed(2)),
    },
    itemsLooted: {
      containersSearched,
      itemsTaken,
      byItem: itemsByKind,
    },
    itemsCrafted: {
      recipesResearched,
      itemsCrafted,
      barricadesBuilt,
      healsUsed,
    },
    timeToWorkbench,
    firstContactTime: tel.firstContactTime !== null ? Number(tel.firstContactTime.toFixed(2)) : null,
    peakSimultaneousChasers: peakChasers,
    meanSimultaneousChasers: chaserSamples > 0 ? Number((chaserSum / chaserSamples).toFixed(2)) : 0,
    distanceExplored: {
      maxRadiusFromSpawn: Number(tel.maxDistanceExplored.toFixed(1)),
      totalDistanceWalked: Number(tel.cumulativeDistanceWalked.toFixed(1)),
      buildingsVisited: visitedBuildings.size,
    },
    closeCalls,
    unfairSpawns: {
      inView: tel.inViewSpawns,
      behindPlayer: tel.behindSpawns,
    },
    timeline,
    series,
    ...(config.recordReplay
      ? {
          replay: {
            version: 1,
            seed,
            houseSeed,
            terrain,
            timeScale,
            tickDt: stepDt,
            playerCount,
            preset: config.preset,
            skillOverrides: config.skillOverrides,
            aiConfig: config.aiConfig,
            progressionTuning: config.progressionTuning,
            worldMode,
            totalTicks: finalTick,
            frames: replayFrames,
          },
        }
      : {}),
  }
}

/**
 * Replays a recorded `BotReplayLog` deterministically through `CoopSim` and returns the final state
 * so tests and the live renderer can verify bit-identical playback.
 */
export class BotReplayPlayer {
  readonly log: BotReplayLog
  readonly sim: CoopSim
  readonly slots: SurvivorSlot[] = []
  cursor = 0

  constructor(log: BotReplayLog) {
    this.log = log
    this.sim = new CoopSim(
      log.seed,
      log.houseSeed,
      log.terrain,
      log.aiConfig,
      log.progressionTuning,
      log.worldMode,
    )
    for (let i = 0; i < log.playerCount; i++) {
      this.slots.push(this.sim.addSurvivor(i === 0 ? "player" : `bot-${i}`, i))
    }
    this.sim.ai.pacing.stepAfterCrowd(
      this.sim.ai.nav,
      this.sim.ai.agents,
      this.slots.map((s) => s.survivor),
      this.sim.ai.config,
      0,
      false,
    )
  }

  get done(): boolean {
    return this.cursor >= this.log.frames.length
  }

  /** Steps one recorded tick. Returns the primary survivor's command for that tick. */
  stepTick(): Command | null {
    if (this.cursor >= this.log.frames.length) return null
    const frame = this.log.frames[this.cursor++]!
    const stepDt = this.log.tickDt ?? TICK_DT
    for (let i = 0; i < this.slots.length; i++) {
      const cmd = frame.commands[i] ?? { mx: 0, my: 0, aim: 0, interact: false }
      this.sim.stepSurvivor(this.slots[i]!, cmd, stepDt)
    }
    this.sim.stepWorld(stepDt, this.log.timeScale)
    return frame.commands[0] ?? null
  }

  /** Runs the entire replay to completion and returns final survivor coordinates and clock time. */
  runAll(): { time: number; hour: number; x: number; y: number; health: number } {
    while (!this.done) {
      this.stepTick()
    }
    const p = this.slots[0]!.survivor
    return {
      time: Number(this.sim.time.toFixed(2)),
      hour: Number(this.sim.hour.toFixed(2)),
      x: Number(p.x.toFixed(3)),
      y: Number(p.y.toFixed(3)),
      health: Number(p.health.toFixed(1)),
    }
  }
}
