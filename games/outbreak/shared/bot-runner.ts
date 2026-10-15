import type { AIConfig } from "./ai"
import { TICK_DT } from "./clock"
import { isMeleeWeapon } from "./combat"
import { cloneSimState, CoopSim, forkSimState, hashSimState, type SimState, type SurvivorSlot } from "./coop-sim"
import { dayCycle } from "./day-cycle"
import { DEFAULT_PACING_TUNING } from "./pacing"
import { buildingAt, type ProgressionTuning } from "./progression"
import type { Command } from "./session"
import {
  BOT_SKILL_PRESET_ORDER,
  BOT_SKILL_PRESETS,
  createBotWorldView,
  SurvivorBot,
  type BotIntentKind,
  type BotSkillConfig,
  type BotSkillPresetId,
  type BotStateSnapshot,
} from "./survivor-bot"
import type { WorldMode } from "./world"

export type CauseOfDeath =
  | "survived"
  | "cornered-by-horde"
  | "out-of-ammo"
  | "exhausted-overrun"
  | "ambushed-in-dark"
  | "attrition"

export type PacingPhase = "relax" | "build-up" | "peak"

export type RunPacingMetrics = {
  /** Mean perceived tension / intensity (0..1) over the run. */
  meanIntensity: number
  /** Peak perceived tension / intensity (0..1) reached during the run. */
  peakIntensity: number
  /** Fraction of run time (0..1) spent in the high-intensity "peak" phase. */
  highIntensityFraction: number
  /** Fraction of run time (0..1) spent in the rising/moderate "build-up" phase. */
  buildUpFraction: number
  /** Fraction of run time (0..1) spent in the low-tension "relax" phase. */
  relaxFraction: number
  /** Number of distinct high-intensity peak episodes. */
  peakCount: number
  /** Tension peaks normalized per night survived. */
  peaksPerNight: number
  /** Shortest relaxation window between peaks (s). */
  minRelaxWindowSeconds: number
  /** Longest relaxation window between peaks (s). */
  maxRelaxWindowSeconds: number
  /** Mean relaxation window between peaks (s). */
  meanRelaxWindowSeconds: number
  /** Individual relaxation window durations (s). */
  relaxWindows: number[]
  /** Close calls normalized per night survived. */
  closeCallsPerNight: number
  /** Continuous warning lead time (s) of elevated tension/perceived threat immediately preceding death (null if survived). */
  deathWarningSeconds: number | null
  /** True when the run survived or death was preceded by clear warning (>= minWarningSeconds) with zero unfair spawns. */
  warnedDeath: boolean
}

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
  intensity: number
  phase: PacingPhase
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

export type ForkSnapshotCheckpoint = {
  t: number
  hour: number
  nights: number
  tick: number
  stateHash: string
  simState: SimState
  botStates: BotStateSnapshot[]
  summary: {
    health: number
    stamina: number
    totalAmmo: number
    planks: number
    activeChasers: number
    intensity: number
    phase: PacingPhase
    intent: BotIntentKind
    x: number
    y: number
  }
}

export type ForkRolloutOutcome = {
  rolloutSeed: number
  preset: BotSkillPresetId
  survived: boolean
  survivalTime: number
  additionalSeconds: number
  nightsSurvived: number
  causeOfDeath: CauseOfDeath
  finalHealth: number
  killsDelta: number
  trace: { t: number; health: number; chasers: number; intensity: number; x: number; y: number }[]
}

export type ForkMomentAnalysis = {
  t: number
  hour: number
  nights: number
  tick: number
  stateHash: string
  summary: ForkSnapshotCheckpoint["summary"]
  rolloutCount: number
  survivalProbability: number
  survivalBySkill: Record<BotSkillPresetId, number>
  medianRemainingSeconds: number
  p25RemainingSeconds: number
  p75RemainingSeconds: number
  causesOfDeath: Record<string, number>
  branches: ForkRolloutOutcome[]
}

export type DecisiveMomentAnalysis = {
  fromT: number
  toT: number
  fromHour: number
  toHour: number
  fromSurvivalProbability: number
  toSurvivalProbability: number
  dropAmount: number
  eventsInWindow: BotRunTimelineEvent[]
  whySummary: string
  stateHighlights: string[]
}

export type RunBranchingAnalysis = {
  seed: number
  preset: BotSkillPresetId
  configLabel: string
  survived: boolean
  survivalTime: number
  nightsSurvived: number
  causeOfDeath: CauseOfDeath
  horizonSeconds: number
  checkpoints: ForkMomentAnalysis[]
  decisiveMoment: DecisiveMomentAnalysis | null
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
  /** Optional interval (s) at which to capture full `ForkSnapshotCheckpoint`s during the run. */
  captureCheckpointsEverySeconds?: number
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
  /** Left 4 Dead AI Director-style tension, build-up/peak/relax window, and death-warning telemetry. */
  pacing: RunPacingMetrics
  timeline: BotRunTimelineEvent[]
  series: BotRunTimeSample[]
  replay?: BotReplayLog
  checkpoints?: ForkSnapshotCheckpoint[]
}

/**
 * Converts elapsed game hours (`CoopSim.elapsedHours`, starting from `startHour`, default 17:30) into continuous
 * `nightsSurvived` and integer `completedNights`. Game hours rather than seconds, because the opening clock runs slower.
 * - startHour..18:00: 0.00 .. 0.15 (First Evening)
 * - 18:00..06:00 (12 hours of Night 1): 0.15 .. 1.00 (Dawn 1 = 1.0 night survived)
 * - Subsequent 24h cycles: +0.20 across daytime (06:00..18:00) and +0.80 across night (18:00..06:00).
 */
export function computeNightsSurvived(
  elapsedHours: number,
  startHour = DEFAULT_PACING_TUNING.startHour,
): { nightsSurvived: number; completedNights: number } {
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

  // Left 4 Dead AI Director tension / intensity & phase state
  let smoothedIntensity = 0
  let damageImpulse = 0
  let peakIntensity = 0
  let intensitySum = 0
  let intensitySamples = 0
  let highIntensitySeconds = 0
  let buildUpSeconds = 0
  let relaxSeconds = 0
  let peakCount = 0
  let inPeakSince: number | null = null
  let currentRelaxDuration = 0
  const relaxWindows: number[] = []
  let warningStartedAt: number | null = null

  const checkpoints: ForkSnapshotCheckpoint[] = []
  const checkpointIntervalTicks =
    config.captureCheckpointsEverySeconds && config.captureCheckpointsEverySeconds > 0
      ? Math.max(1, Math.round(config.captureCheckpointsEverySeconds / (config.tickDt ?? TICK_DT * 3)))
      : 0

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
            if (isMeleeWeapon(heldItem)) {
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
    let damageThisTick = 0
    for (let i = 0; i < slots.length; i++) {
      const p = slots[i]!.survivor
      if (p.health < prevHealth[i]!) {
        const dmg = prevHealth[i]! - p.health
        totalDamageTaken += dmg
        if (i === 0) damageThisTick += dmg
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
    let closeZombies = 0
    let within4mZombies = 0
    for (let zIdx = 0; zIdx < sim.ai.agents.length; zIdx++) {
      const z = sim.ai.agents[zIdx]!
      if (z.state === "dead") continue
      const d = Math.hypot(z.x - lead.x, z.y - lead.y)
      if (d <= 2.1) closeZombies++
      if (d <= 4.2) within4mZombies++
    }
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

    // Evaluate Left 4 Dead AI Director tension / intensity curve and phase
    if (damageThisTick > 0) {
      damageImpulse = Math.min(0.45, damageImpulse + damageThisTick * 0.014)
    } else {
      damageImpulse = Math.max(0, damageImpulse - stepDt * 0.07)
    }
    const totalAmmoNow = lead.magAmmo + lead.reserveAmmo
    const chaserTension = Math.min(0.48, tel.activeChasers * 0.14 + within4mZombies * 0.1)
    const scarcityTension = Math.min(
      0.34,
      Math.max(0, (100 - lead.health) / 100) * 0.22 +
        (totalAmmoNow <= 4 ? (4 - totalAmmoNow) * 0.03 : 0) +
        (lead.exhausted || lead.stamina < 0.25 ? 0.07 : 0),
    )
    const ambientTension = tel.threat * 0.06
    const rawIntensity = Math.max(0, Math.min(1, chaserTension + damageImpulse + scarcityTension + ambientTension))
    if (rawIntensity >= smoothedIntensity) {
      smoothedIntensity = Math.min(1, smoothedIntensity + (rawIntensity - smoothedIntensity) * Math.min(1, stepDt * 2.2))
    } else {
      smoothedIntensity = Math.max(0, smoothedIntensity - (smoothedIntensity - rawIntensity) * Math.min(1, stepDt * 0.24))
    }
    peakIntensity = Math.max(peakIntensity, smoothedIntensity)
    intensitySum += smoothedIntensity
    intensitySamples++

    const phase: PacingPhase =
      smoothedIntensity >= 0.5 || (tel.activeChasers >= 2 && smoothedIntensity >= 0.42)
        ? "peak"
        : smoothedIntensity <= 0.24 && tel.activeChasers === 0
          ? "relax"
          : "build-up"

    if (phase === "peak") {
      highIntensitySeconds += stepDt
      if (currentRelaxDuration >= 4.0) {
        relaxWindows.push(Number(currentRelaxDuration.toFixed(1)))
      }
      currentRelaxDuration = 0
      if (inPeakSince === null) {
        inPeakSince = sim.time
        peakCount++
      }
    } else if (phase === "relax") {
      relaxSeconds += stepDt
      currentRelaxDuration += stepDt
      if (inPeakSince !== null && sim.time - inPeakSince >= 2.0) {
        inPeakSince = null
      }
    } else {
      buildUpSeconds += stepDt
      if (inPeakSince !== null && smoothedIntensity < 0.38) {
        inPeakSince = null
      }
    }

    const hasWarningNow = smoothedIntensity >= 0.26 || tel.activeChasers > 0 || within4mZombies > 0
    if (hasWarningNow) {
      if (warningStartedAt === null) warningStartedAt = sim.time
    } else if (smoothedIntensity < 0.16 && tel.activeChasers === 0) {
      warningStartedAt = null
    }

    const nightState = computeNightsSurvived(sim.elapsedHours, startHour)
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
        intensity: Number(smoothedIntensity.toFixed(3)),
        phase,
      })
    }

    if (
      checkpointIntervalTicks > 0 &&
      (tick === 1 || tick % checkpointIntervalTicks === 0) &&
      slots.some((s) => s.survivor.health > 0)
    ) {
      const simSnap = sim.toSnapshot()
      checkpoints.push({
        t: Number(sim.time.toFixed(1)),
        hour: Number(sim.hour.toFixed(2)),
        nights: nightState.nightsSurvived,
        tick,
        stateHash: hashSimState(simSnap),
        simState: simSnap,
        botStates: bots.map((b) => b.toSnapshot()),
        summary: {
          health: Number(lead.health.toFixed(1)),
          stamina: Number(lead.stamina.toFixed(2)),
          totalAmmo: lead.magAmmo + lead.reserveAmmo,
          planks: lead.planks,
          activeChasers: tel.activeChasers,
          intensity: Number(smoothedIntensity.toFixed(3)),
          phase,
          intent: bots[0]!.getTelemetry().intent,
          x: Number(lead.x.toFixed(1)),
          y: Number(lead.y.toFixed(1)),
        },
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
  const { nightsSurvived, completedNights } = computeNightsSurvived(sim.elapsedHours, startHour)
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

  if (currentRelaxDuration >= 4.0) {
    relaxWindows.push(Number(currentRelaxDuration.toFixed(1)))
  }

  const effectiveNightsForRate = Math.max(0.25, nightsSurvived)
  const totalPhaseSeconds = Math.max(stepDt, highIntensitySeconds + buildUpSeconds + relaxSeconds)
  const minRelaxWindowSeconds = relaxWindows.length > 0 ? Math.min(...relaxWindows) : Number(relaxSeconds.toFixed(1))
  const maxRelaxWindowSeconds = relaxWindows.length > 0 ? Math.max(...relaxWindows) : Number(relaxSeconds.toFixed(1))
  const meanRelaxWindowSeconds =
    relaxWindows.length > 0
      ? Number((relaxWindows.reduce((a, b) => a + b, 0) / relaxWindows.length).toFixed(1))
      : Number(relaxSeconds.toFixed(1))
  const deathWarningSeconds = !survived
    ? Number(Math.max(0, warningStartedAt !== null ? survivalTime - warningStartedAt : 0).toFixed(2))
    : null
  const warnedDeath =
    survived ||
    ((deathWarningSeconds ?? 0) >= 3.0 && tel.inViewSpawns === 0 && tel.behindSpawns === 0)

  const pacing: RunPacingMetrics = {
    meanIntensity: intensitySamples > 0 ? Number((intensitySum / intensitySamples).toFixed(3)) : 0,
    peakIntensity: Number(peakIntensity.toFixed(3)),
    highIntensityFraction: Number((highIntensitySeconds / totalPhaseSeconds).toFixed(3)),
    buildUpFraction: Number((buildUpSeconds / totalPhaseSeconds).toFixed(3)),
    relaxFraction: Number((relaxSeconds / totalPhaseSeconds).toFixed(3)),
    peakCount,
    peaksPerNight: Number((peakCount / effectiveNightsForRate).toFixed(2)),
    minRelaxWindowSeconds: Number(minRelaxWindowSeconds.toFixed(1)),
    maxRelaxWindowSeconds: Number(maxRelaxWindowSeconds.toFixed(1)),
    meanRelaxWindowSeconds,
    relaxWindows,
    closeCallsPerNight: Number((closeCalls / effectiveNightsForRate).toFixed(2)),
    deathWarningSeconds,
    warnedDeath,
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
    pacing,
    timeline,
    series,
    ...(checkpointIntervalTicks > 0 ? { checkpoints } : {}),
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

  /** Fast-forwards the replay deterministically to `targetSeconds` (sim time). */
  stepUntilTime(targetSeconds: number): { time: number; hour: number; x: number; y: number; health: number } {
    while (!this.done && this.sim.time + 1e-6 < targetSeconds) {
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

/**
 * Clones a `ForkSnapshotCheckpoint` and rolls out one parallel simulation branch from that exact moment
 * with a fresh `rolloutSeed` and optional `presetOverride` / `skillOverrides`.
 *
 * When `rolloutSeed === undefined` and `presetOverride === undefined`, the rollout is bit-identical to the
 * original run continuation from that checkpoint.
 */
export function runSingleForkRollout(
  checkpoint: ForkSnapshotCheckpoint,
  options: {
    rolloutSeed?: number
    presetOverride?: BotSkillPresetId
    skillOverrides?: Partial<BotSkillConfig>
    horizonSeconds?: number
    maxAbsoluteSeconds?: number
    timeScale?: number
    tickDt?: number
  } = {},
): ForkRolloutOutcome {
  const timeScale = options.timeScale ?? 240
  const stepDt = options.tickDt ?? TICK_DT * 3
  const horizonSeconds = options.horizonSeconds ?? 315
  const maxEndSeconds =
    options.maxAbsoluteSeconds !== undefined
      ? Math.min(options.maxAbsoluteSeconds, checkpoint.t + horizonSeconds)
      : checkpoint.t + horizonSeconds

  const forkedSimState =
    options.rolloutSeed !== undefined
      ? forkSimState(checkpoint.simState, { rolloutSeed: options.rolloutSeed })
      : cloneSimState(checkpoint.simState)
  const sim = CoopSim.fromSnapshot(forkedSimState)
  const slots = sim.slots

  const bots: SurvivorBot[] = checkpoint.botStates.map((bs, idx) => {
    const bot = SurvivorBot.fromSnapshot(bs)
    if (options.presetOverride) {
      bot.setSkill(options.presetOverride, options.skillOverrides)
    } else if (options.skillOverrides) {
      bot.setSkill(bot.preset, options.skillOverrides)
    }
    if (options.rolloutSeed !== undefined) {
      const perturbed = ((bs.rngState ^ Math.imul((options.rolloutSeed + idx * 31 + 1) >>> 0, 0x9e3779b9)) >>> 0) || 1
      bot.rng.setState(perturbed)
    }
    return bot
  })

  const startHour = sim.ai.config.startHour
  const initialDeadCount = sim.ai.agents.filter((a) => a.state === "dead").length
  const maxSteps = Math.max(1, Math.ceil((maxEndSeconds - sim.time) / stepDt))
  const traceIntervalSteps = Math.max(1, Math.round(15 / stepDt))
  const trace: ForkRolloutOutcome["trace"] = [
    {
      t: Number(sim.time.toFixed(1)),
      health: Number((slots[0]?.survivor.health ?? 0).toFixed(1)),
      chasers: sim.ai.pacing.telemetry.activeChasers,
      intensity: checkpoint.summary.intensity,
      x: Number((slots[0]?.survivor.x ?? 0).toFixed(1)),
      y: Number((slots[0]?.survivor.y ?? 0).toFixed(1)),
    },
  ]

  let smoothedIntensity = checkpoint.summary.intensity
  let prevHp = slots[0]?.survivor.health ?? 100
  let damageImpulse = 0

  for (let step = 1; step <= maxSteps; step++) {
    const worldView = createBotWorldView(sim)
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]!
      if (slot.survivor.health <= 0) continue
      const bot = bots[i]!
      const cmd = bot.step(stepDt, worldView)
      sim.stepSurvivor(slot, cmd, stepDt)
    }
    sim.stepWorld(stepDt, timeScale)

    const lead = slots[0]!.survivor
    const dmg = Math.max(0, prevHp - lead.health)
    prevHp = lead.health
    damageImpulse = dmg > 0 ? Math.min(0.45, damageImpulse + dmg * 0.014) : Math.max(0, damageImpulse - stepDt * 0.07)
    const tel = sim.ai.pacing.telemetry
    const rawI = Math.min(
      1,
      Math.min(0.48, tel.activeChasers * 0.16) +
        damageImpulse +
        Math.max(0, (100 - lead.health) / 100) * 0.22 +
        tel.threat * 0.06,
    )
    smoothedIntensity =
      rawI >= smoothedIntensity
        ? smoothedIntensity + (rawI - smoothedIntensity) * Math.min(1, stepDt * 2.2)
        : smoothedIntensity - (smoothedIntensity - rawI) * Math.min(1, stepDt * 0.24)

    if (step % traceIntervalSteps === 0 || !slots.some((s) => s.survivor.health > 0)) {
      trace.push({
        t: Number(sim.time.toFixed(1)),
        health: Number(lead.health.toFixed(1)),
        chasers: tel.activeChasers,
        intensity: Number(smoothedIntensity.toFixed(3)),
        x: Number(lead.x.toFixed(1)),
        y: Number(lead.y.toFixed(1)),
      })
    }

    if (!slots.some((s) => s.survivor.health > 0)) break
  }

  const lead = slots[0]!.survivor
  const survived = slots.some((s) => s.survivor.health > 0)
  const survivalTime = Number(sim.time.toFixed(2))
  const additionalSeconds = Number(Math.max(0, survivalTime - checkpoint.t).toFixed(2))
  const { nightsSurvived } = computeNightsSurvived(sim.elapsedHours, startHour)
  const finalDeadCount = sim.ai.agents.filter((a) => a.state === "dead").length
  const killsDelta = Math.max(0, finalDeadCount - initialDeadCount)

  let causeOfDeath: CauseOfDeath = "survived"
  if (!survived) {
    const tel = sim.ai.pacing.telemetry
    const nearbyAttackers = sim.ai.agents.filter(
      (z) => z.state !== "dead" && Math.hypot(z.x - lead.x, z.y - lead.y) < 4.5,
    ).length
    if ((lead.exhausted || lead.stamina < 0.24) && nearbyAttackers >= 2) {
      causeOfDeath = "exhausted-overrun"
    } else if (nearbyAttackers >= 3 || tel.activeChasers >= 3) {
      causeOfDeath = "cornered-by-horde"
    } else if (dayCycle(sim.hour).darkness > 0.65 && (!lead.flashlightOn || lead.batteryDepleted)) {
      causeOfDeath = "ambushed-in-dark"
    } else if (lead.magAmmo + lead.reserveAmmo === 0) {
      causeOfDeath = "out-of-ammo"
    } else {
      causeOfDeath = "attrition"
    }
  }

  return {
    rolloutSeed: options.rolloutSeed ?? 0,
    preset: options.presetOverride ?? checkpoint.botStates[0]?.preset ?? "Casual",
    survived,
    survivalTime,
    additionalSeconds,
    nightsSurvived,
    causeOfDeath,
    finalHealth: Number(lead.health.toFixed(1)),
    killsDelta,
    trace,
  }
}

/**
 * Evaluates a distribution of `N` parallel rollouts from a single `ForkSnapshotCheckpoint`
 * across different rollout seeds and/or bot skill presets ("from here, will they survive or die, and how often?").
 */
export function evaluateCheckpointRollouts(
  checkpoint: ForkSnapshotCheckpoint,
  options: {
    rolloutSeeds?: readonly number[]
    presets?: readonly BotSkillPresetId[]
    horizonSeconds?: number
    maxAbsoluteSeconds?: number
    timeScale?: number
    tickDt?: number
  } = {},
): ForkMomentAnalysis {
  const rolloutSeeds = options.rolloutSeeds ?? [101, 202, 303, 404]
  const presets = options.presets ?? [checkpoint.botStates[0]?.preset ?? "Casual"]
  const branches: ForkRolloutOutcome[] = []

  const survivalCountBySkill: Record<BotSkillPresetId, { survived: number; total: number }> = {
    Novice: { survived: 0, total: 0 },
    Casual: { survived: 0, total: 0 },
    Skilled: { survived: 0, total: 0 },
    Expert: { survived: 0, total: 0 },
    Perfect: { survived: 0, total: 0 },
  }

  for (const preset of presets) {
    for (const rSeed of rolloutSeeds) {
      const outcome = runSingleForkRollout(checkpoint, {
        rolloutSeed: rSeed,
        presetOverride: preset,
        horizonSeconds: options.horizonSeconds,
        maxAbsoluteSeconds: options.maxAbsoluteSeconds,
        timeScale: options.timeScale,
        tickDt: options.tickDt,
      })
      branches.push(outcome)
      survivalCountBySkill[preset].total++
      if (outcome.survived) survivalCountBySkill[preset].survived++
    }
  }

  const totalRollouts = Math.max(1, branches.length)
  const survivedCount = branches.filter((b) => b.survived).length
  const survivalProbability = Number((survivedCount / totalRollouts).toFixed(3))

  const basePreset = checkpoint.botStates[0]?.preset ?? "Casual"
  const survivalBySkill: Record<BotSkillPresetId, number> = {
    Novice: 0,
    Casual: 0,
    Skilled: 0,
    Expert: 0,
    Perfect: 0,
  }
  for (const p of BOT_SKILL_PRESET_ORDER) {
    const entry = survivalCountBySkill[p]
    if (entry.total > 0) {
      survivalBySkill[p] = Number((entry.survived / entry.total).toFixed(3))
    } else {
      survivalBySkill[p] = p === basePreset ? survivalProbability : 0
    }
  }

  const remainingSorted = branches.map((b) => b.additionalSeconds).sort((a, b) => a - b)
  const pickQuantile = (q: number): number => {
    if (remainingSorted.length === 0) return 0
    const idx = Math.min(remainingSorted.length - 1, Math.max(0, Math.floor(q * (remainingSorted.length - 1))))
    return Number(remainingSorted[idx]!.toFixed(1))
  }

  const causesOfDeath: Record<string, number> = {}
  for (const b of branches) {
    causesOfDeath[b.causeOfDeath] = (causesOfDeath[b.causeOfDeath] ?? 0) + 1
  }

  return {
    t: checkpoint.t,
    hour: checkpoint.hour,
    nights: checkpoint.nights,
    tick: checkpoint.tick,
    stateHash: checkpoint.stateHash,
    summary: { ...checkpoint.summary },
    rolloutCount: branches.length,
    survivalProbability,
    survivalBySkill,
    medianRemainingSeconds: pickQuantile(0.5),
    p25RemainingSeconds: pickQuantile(0.25),
    p75RemainingSeconds: pickQuantile(0.75),
    causesOfDeath,
    branches,
  }
}

/**
 * Runs a complete branching timeline analysis over a run's checkpoints:
 * evaluates N rollouts at each checkpoint along the run, builds the survival-probability curve over time,
 * and pinpoints the decisive moment ("why did this run die? what happened in the 30s before?").
 */
export function analyzeRunBranchingTimeline(
  run: BotRunResult,
  options: {
    rolloutSeeds?: readonly number[]
    presets?: readonly BotSkillPresetId[]
    horizonSeconds?: number
    maxAbsoluteSeconds?: number
    timeScale?: number
    tickDt?: number
  } = {},
): RunBranchingAnalysis {
  const checkpoints = run.checkpoints ?? []
  const horizonSeconds = options.horizonSeconds ?? 315
  const evaluated = checkpoints.map((cp) =>
    evaluateCheckpointRollouts(cp, {
      rolloutSeeds: options.rolloutSeeds,
      presets: options.presets,
      horizonSeconds,
      maxAbsoluteSeconds: options.maxAbsoluteSeconds,
      timeScale: options.timeScale,
      tickDt: options.tickDt,
    }),
  )

  let decisiveMoment: DecisiveMomentAnalysis | null = null
  let bestDrop = 0.08
  for (let i = 1; i < evaluated.length; i++) {
    const prev = evaluated[i - 1]!
    const cur = evaluated[i]!
    const drop = prev.survivalProbability - cur.survivalProbability
    if (drop > bestDrop) {
      bestDrop = drop
      const windowStart = Math.max(0, cur.t - 35)
      const eventsInWindow = run.timeline.filter((ev) => ev.t >= windowStart && ev.t <= cur.t + 15)
      const stateHighlights: string[] = []
      if (cur.summary.health < prev.summary.health) {
        stateHighlights.push(`HP dropped ${Math.round(prev.summary.health)} → ${Math.round(cur.summary.health)}`)
      }
      if (cur.summary.activeChasers > prev.summary.activeChasers) {
        stateHighlights.push(`Chasers surged ${prev.summary.activeChasers} → ${cur.summary.activeChasers}`)
      }
      if (cur.summary.totalAmmo < prev.summary.totalAmmo) {
        stateHighlights.push(`Ammo spent ${prev.summary.totalAmmo} → ${cur.summary.totalAmmo}`)
      }
      if (cur.summary.stamina < 0.35) {
        stateHighlights.push(`Stamina low (${Math.round(cur.summary.stamina * 100)}%)`)
      }
      const whySummary =
        stateHighlights.length > 0
          ? `Survival probability plunged from ${Math.round(prev.survivalProbability * 100)}% to ${Math.round(cur.survivalProbability * 100)}% between t=${prev.t}s and t=${cur.t}s (${stateHighlights.join(", ")}).`
          : `Survival probability dropped from ${Math.round(prev.survivalProbability * 100)}% to ${Math.round(cur.survivalProbability * 100)}% between t=${prev.t}s and t=${cur.t}s as nocturnal pressure peaked.`

      decisiveMoment = {
        fromT: prev.t,
        toT: cur.t,
        fromHour: prev.hour,
        toHour: cur.hour,
        fromSurvivalProbability: prev.survivalProbability,
        toSurvivalProbability: cur.survivalProbability,
        dropAmount: Number(drop.toFixed(3)),
        eventsInWindow,
        whySummary,
        stateHighlights,
      }
    }
  }

  return {
    seed: run.seed,
    preset: run.preset,
    configLabel: run.configLabel,
    survived: run.survived,
    survivalTime: run.survivalTime,
    nightsSurvived: run.nightsSurvived,
    causeOfDeath: run.causeOfDeath,
    horizonSeconds,
    checkpoints: evaluated,
    decisiveMoment,
  }
}
