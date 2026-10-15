import type { Camera } from "@arcade/kit/client/camera"
import type { LabControl } from "@arcade/kit/lab-panel"
import type { BotReplayLog } from "../shared/bot-runner"
import { LocalSession, type Command } from "../shared/session"
import {
  BOT_SKILL_PRESETS,
  botControls,
  createBotWorldView,
  resolveBotSkillPreset,
  SurvivorBot,
  type BotSkillConfig,
  type BotSkillPresetId,
  type BotTelemetrySnapshot,
} from "../shared/survivor-bot"
import type { OutbreakSettings } from "./settings"

const INTENT_COLORS: Readonly<Record<string, string>> = {
  heal: "#4ade80",
  "fight-melee": "#fb923c",
  "kite-shoot": "#38bdf8",
  "flee-horde": "#f43f5e",
  "reload-cover": "#facc15",
  barricade: "#a78bfa",
  "retreat-safehouse": "#818cf8",
  workbench: "#2dd4bf",
  craft: "#34d399",
  loot: "#f59e0b",
  "assist-ally": "#ec4899",
  explore: "#94a3b8",
}

export class BotsLabController {
  private readonly bots = new Map<string, SurvivorBot>()
  private lastPresetIndex = -1
  private lastSessionRef: LocalSession | null = null
  private activeReplay: { log: BotReplayLog; cursor: number } | null = null
  private overlayCanvas: HTMLCanvasElement | null = null
  private overlayCtx: CanvasRenderingContext2D | null = null

  constructor(private readonly settings: OutbreakSettings) {
    this.lastPresetIndex = Math.round(settings.bots.botSkillPreset)
  }

  /** Extra Lab action controls for the `Bots` group. */
  controls(getSession: () => LocalSession | null, resetSession: (seed: number) => void): LabControl[] {
    return [
      ...botControls,
      {
        key: "botResetSeed",
        label: "Restart bot run",
        group: "Bots",
        type: "action",
        run: () => {
          const s = getSession()
          const seed = s ? s.view.town.seed : 7
          this.activeReplay = null
          this.bots.clear()
          resetSession(seed)
        },
      },
    ]
  }

  reset(): void {
    this.bots.clear()
    this.activeReplay = null
  }

  loadReplay(log: BotReplayLog, resetSession: (seed: number) => void): void {
    this.settings.bots.botCount = log.playerCount
    this.settings.bots.botEnabled = 1
    resetSession(log.seed)
    this.activeReplay = { log, cursor: 0 }
  }

  private syncSkillFromSettings(): { preset: BotSkillPresetId; skill: BotSkillConfig } {
    const b = this.settings.bots
    const presetIdx = Math.round(b.botSkillPreset)
    const preset = resolveBotSkillPreset(presetIdx)
    if (presetIdx !== this.lastPresetIndex) {
      this.lastPresetIndex = presetIdx
      const p = BOT_SKILL_PRESETS[preset]
      b.botReactionTime = p.reactionTime
      b.botAimError = p.aimError
      b.botAimTrackingLag = p.aimTrackingLag
      b.botDecisionNoise = p.decisionNoise
      b.botAwarenessRadius = p.awarenessRadius
      b.botPanicUnderPressure = p.panicUnderPressure
      b.botStaminaDiscipline = p.staminaDiscipline
      b.botAmmoDiscipline = p.ammoDiscipline
      b.botMapKnowledge = p.mapKnowledge
    }
    return {
      preset,
      skill: {
        reactionTime: b.botReactionTime,
        aimError: b.botAimError,
        aimTrackingLag: b.botAimTrackingLag,
        decisionNoise: b.botDecisionNoise,
        awarenessRadius: b.botAwarenessRadius,
        panicUnderPressure: b.botPanicUnderPressure,
        staminaDiscipline: b.botStaminaDiscipline,
        ammoDiscipline: b.botAmmoDiscipline,
        mapKnowledge: b.botMapKnowledge,
      },
    }
  }

  private ensureSquadSlots(session: LocalSession): void {
    if (this.lastSessionRef !== session) {
      this.lastSessionRef = session
      this.bots.clear()
    }
    const desiredCount = Math.max(1, Math.min(4, Math.round(this.settings.bots.botCount)))
    // Add missing companion slots
    for (let i = 1; i < desiredCount; i++) {
      const id = `bot-${i}`
      if (!session.sim.slot(id)) {
        session.sim.addSurvivor(id, i)
      }
    }
    // Remove excess companion slots
    for (let i = 3; i >= desiredCount; i--) {
      const id = `bot-${i}`
      if (session.sim.slot(id)) {
        session.sim.removeSurvivor(id, true)
        this.bots.delete(id)
      }
    }
  }

  private getOrCreateBot(
    actorId: string,
    slotIndex: number,
    seed: number,
    preset: BotSkillPresetId,
    skill: BotSkillConfig,
  ): SurvivorBot {
    let bot = this.bots.get(actorId)
    if (!bot) {
      bot = new SurvivorBot(actorId, slotIndex, seed, preset, skill)
      this.bots.set(actorId, bot)
    } else {
      bot.setSkill(preset, skill)
    }
    return bot
  }

  /**
   * Called before `session.update(dt, command, ...)` each simulation substep.
   * Steps any companion bots (`bot-1..3`) on `session.sim`, and if `botEnabled` (or a replay) is active,
   * returns the `Command` for the primary survivor (`"player"`).
   */
  stepBeforeSessionUpdate(dt: number, session: LocalSession, humanCommand: Command): Command {
    this.ensureSquadSlots(session)
    const { preset, skill } = this.syncSkillFromSettings()

    if (this.activeReplay) {
      const frame = this.activeReplay.log.frames[this.activeReplay.cursor++]
      if (!frame) {
        this.activeReplay = null
      } else {
        for (let i = 1; i < session.sim.slots.length; i++) {
          const slot = session.sim.slots[i]!
          const cmd = frame.commands[i] ?? { mx: 0, my: 0, aim: slot.survivor.aim, interact: false }
          session.sim.stepSurvivor(slot, cmd, dt, this.settings)
        }
        return frame.commands[0] ?? humanCommand
      }
    }

    const worldView = createBotWorldView(session.sim)
    const seed = session.view.town.seed

    // Step companion bots (slots 1..3)
    for (let i = 1; i < session.sim.slots.length; i++) {
      const slot = session.sim.slots[i]!
      const bot = this.getOrCreateBot(slot.id, slot.index, seed + i * 97, preset, skill)
      const cmd =
        slot.survivor.health > 0
          ? bot.step(dt, worldView)
          : { mx: 0, my: 0, aim: slot.survivor.aim, interact: false }
      session.sim.stepSurvivor(slot, cmd, dt, this.settings)
    }

    // Step primary player bot if autopilot is enabled (or keep perception warm when overlay is open)
    if (this.settings.bots.botEnabled > 0) {
      const leadBot = this.getOrCreateBot(session.slot.id, 0, seed, preset, skill)
      return leadBot.step(dt, worldView)
    } else if (this.settings.bots.botDebugOverlay) {
      const leadBot = this.getOrCreateBot(session.slot.id, 0, seed, preset, skill)
      leadBot.step(dt, worldView)
    }

    return humanCommand
  }

  getSnapshots(session: LocalSession): BotTelemetrySnapshot[] {
    const out: BotTelemetrySnapshot[] = []
    for (const slot of session.sim.slots) {
      const bot = this.bots.get(slot.id)
      if (bot) out.push(bot.getTelemetry())
    }
    return out
  }

  private ensureOverlayCanvas(): CanvasRenderingContext2D | null {
    if (typeof document === "undefined") return null
    if (!this.overlayCanvas) {
      const canvas = document.createElement("canvas")
      canvas.id = "bot-debug-overlay"
      canvas.style.cssText =
        "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:18;"
      document.body.appendChild(canvas)
      this.overlayCanvas = canvas
      this.overlayCtx = canvas.getContext("2d")
    }
    return this.overlayCtx
  }

  /** Renders the 2D perception & intent overlay over the 3D scene when `botDebugOverlay` is on. */
  renderOverlay(
    session: LocalSession,
    cam: Camera,
    supportHeight: (x: number, z: number) => number,
    width: number,
    height: number,
  ): void {
    const show = Boolean(this.settings.bots.botDebugOverlay)
    if (!show) {
      if (this.overlayCanvas && !this.overlayCanvas.hidden) {
        this.overlayCanvas.hidden = true
      }
      return
    }
    const ctx = this.ensureOverlayCanvas()
    if (!ctx || !this.overlayCanvas) return
    this.overlayCanvas.hidden = false
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const cw = Math.round(width * dpr)
    const ch = Math.round(height * dpr)
    if (this.overlayCanvas.width !== cw || this.overlayCanvas.height !== ch) {
      this.overlayCanvas.width = cw
      this.overlayCanvas.height = ch
    }
    ctx.save()
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, width, height)

    const snapshots = this.getSnapshots(session)
    if (snapshots.length === 0) {
      ctx.restore()
      return
    }

    // 1. Draw world-space perception cones, awareness rings, paths, and perceived threats for each bot
    for (let bIdx = 0; bIdx < snapshots.length; bIdx++) {
      const snap = snapshots[bIdx]!
      const slot = session.sim.slot(snap.actorId)
      if (!slot) continue
      const p = slot.survivor
      const py = supportHeight(p.x, p.y) + 0.08
      const pScreen = cam.project(p.x, py, p.y, width, height)
      if (!pScreen.ok) continue

      const intentColor = INTENT_COLORS[snap.intent] ?? "#38bdf8"

      // Draw awareness radius ring on the ground
      ctx.beginPath()
      const ringSteps = 28
      for (let i = 0; i <= ringSteps; i++) {
        const a = (i / ringSteps) * Math.PI * 2
        const wx = p.x + Math.cos(a) * snap.skill.awarenessRadius
        const wz = p.y + Math.sin(a) * snap.skill.awarenessRadius
        const pt = cam.project(wx, py, wz, width, height)
        if (!pt.ok) continue
        if (i === 0) ctx.moveTo(pt.x, pt.y)
        else ctx.lineTo(pt.x, pt.y)
      }
      ctx.strokeStyle = "rgba(56, 189, 248, 0.38)"
      ctx.lineWidth = 1.5
      ctx.setLineDash([4, 4])
      ctx.stroke()
      ctx.setLineDash([])

      // Draw sight cone edges (110 deg, 16m visual indicator)
      const halfCone = (110 * Math.PI) / 360
      const coneLen = 14
      const leftPt = cam.project(
        p.x + Math.cos(p.aim - halfCone) * coneLen,
        py,
        p.y + Math.sin(p.aim - halfCone) * coneLen,
        width,
        height,
      )
      const rightPt = cam.project(
        p.x + Math.cos(p.aim + halfCone) * coneLen,
        py,
        p.y + Math.sin(p.aim + halfCone) * coneLen,
        width,
        height,
      )
      if (leftPt.ok && rightPt.ok) {
        ctx.beginPath()
        ctx.moveTo(leftPt.x, leftPt.y)
        ctx.lineTo(pScreen.x, pScreen.y)
        ctx.lineTo(rightPt.x, rightPt.y)
        ctx.strokeStyle = "rgba(250, 204, 21, 0.35)"
        ctx.lineWidth = 1.25
        ctx.stroke()
      }

      // Draw navigation path polyline and goal target
      if (snap.path.length > 0) {
        ctx.beginPath()
        ctx.moveTo(pScreen.x, pScreen.y)
        for (const wp of snap.path) {
          const wpy = supportHeight(wp.x, wp.y) + 0.08
          const spt = cam.project(wp.x, wpy, wp.y, width, height)
          if (spt.ok) ctx.lineTo(spt.x, spt.y)
        }
        ctx.strokeStyle = intentColor
        ctx.globalAlpha = 0.65
        ctx.lineWidth = 2
        ctx.stroke()
        ctx.globalAlpha = 1
      }

      const gy = supportHeight(snap.goalX, snap.goalY) + 0.15
      const goalScreen = cam.project(snap.goalX, gy, snap.goalY, width, height)
      if (goalScreen.ok) {
        ctx.save()
        ctx.translate(goalScreen.x, goalScreen.y)
        ctx.rotate(Math.PI / 4)
        ctx.strokeStyle = intentColor
        ctx.fillStyle = "rgba(15, 23, 42, 0.75)"
        ctx.lineWidth = 2
        ctx.fillRect(-5, -5, 10, 10)
        ctx.strokeRect(-5, -5, 10, 10)
        ctx.restore()

        ctx.font = "600 11px ui-monospace, SFMono-Regular, Menlo, monospace"
        ctx.fillStyle = intentColor
        ctx.fillText(snap.goalLabel, goalScreen.x + 9, goalScreen.y + 4)
      }

      // Draw perceived threats (sight vs sound vs memory, plus reaction-time gate)
      if (bIdx === 0) {
        for (const t of snap.perceivedThreats) {
          const ty = supportHeight(t.x, t.y) + 0.9
          const ts = cam.project(t.x, ty, t.y, width, height)
          if (!ts.ok) continue
          const col = !t.actionable
            ? "#f59e0b"
            : t.source === "sight"
              ? "#ef4444"
              : t.source === "sound"
                ? "#a855f7"
                : "#94a3b8"
          ctx.save()
          ctx.globalAlpha = Math.max(0.35, t.confidence)
          ctx.strokeStyle = col
          ctx.lineWidth = 1.8
          if (t.source !== "sight") ctx.setLineDash([3, 3])
          ctx.beginPath()
          ctx.arc(ts.x, ts.y, 14, 0, Math.PI * 2)
          ctx.stroke()
          ctx.setLineDash([])

          ctx.font = "600 10px ui-monospace, SFMono-Regular, Menlo, monospace"
          ctx.fillStyle = col
          const tag = !t.actionable
            ? "REACTING"
            : `${t.source.toUpperCase()} ${t.distance.toFixed(1)}m`
          ctx.fillText(tag, ts.x + 17, ts.y + 3)
          ctx.restore()
        }
      }

      // Draw overhead intent badge above the bot
      const headScreen = cam.project(p.x, py + 1.85, p.y, width, height)
      if (headScreen.ok) {
        const badge = `${snap.actorId.toUpperCase()} · ${snap.intent.toUpperCase()}`
        ctx.font = "700 11px ui-monospace, SFMono-Regular, Menlo, monospace"
        const tw = ctx.measureText(badge).width
        const bx = headScreen.x - tw / 2 - 6
        const by = headScreen.y - 22
        ctx.fillStyle = "rgba(9, 13, 22, 0.84)"
        ctx.strokeStyle = intentColor
        ctx.lineWidth = 1.2
        ctx.beginPath()
        ctx.roundRect(bx, by, tw + 12, 18, 4)
        ctx.fill()
        ctx.stroke()
        ctx.fillStyle = intentColor
        ctx.fillText(badge, bx + 6, by + 13)
      }
    }

    // 2. Draw HUD Telemetry Panel in top-left for primary bot + squad summary
    const lead = snapshots[0]!
    const panelX = 16
    const panelY = 64
    const panelW = 304
    const topScores = lead.utilityScores.slice(0, 4)
    const panelH = 142 + topScores.length * 18 + (snapshots.length > 1 ? (snapshots.length - 1) * 20 + 10 : 0)

    ctx.fillStyle = "rgba(10, 14, 23, 0.86)"
    ctx.strokeStyle = "rgba(148, 163, 184, 0.28)"
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.roundRect(panelX, panelY, panelW, panelH, 8)
    ctx.fill()
    ctx.stroke()

    let cy = panelY + 20
    ctx.font = "700 12px ui-monospace, SFMono-Regular, Menlo, monospace"
    ctx.fillStyle = "#f8fafc"
    ctx.fillText(
      `SURVIVOR BOT · ${lead.preset.toUpperCase()} (${snapshots.length}P)`,
      panelX + 12,
      cy,
    )

    cy += 18
    const leadColor = INTENT_COLORS[lead.intent] ?? "#38bdf8"
    ctx.font = "700 11px ui-monospace, SFMono-Regular, Menlo, monospace"
    ctx.fillStyle = leadColor
    ctx.fillText(`INTENT: ${lead.intent.toUpperCase()}`, panelX + 12, cy)

    cy += 15
    ctx.font = "400 11px ui-monospace, SFMono-Regular, Menlo, monospace"
    ctx.fillStyle = "#cbd5e1"
    ctx.fillText(lead.intentReason.slice(0, 40), panelX + 12, cy)

    cy += 18
    const sightCount = lead.perceivedThreats.filter((t) => t.source === "sight").length
    const soundCount = lead.perceivedThreats.filter((t) => t.source === "sound").length
    const memCount = lead.perceivedThreats.filter((t) => t.source === "memory").length
    ctx.fillStyle = "#94a3b8"
    ctx.fillText(
      `PERCEPTION: ${sightCount} sight · ${soundCount} sound · ${memCount} mem`,
      panelX + 12,
      cy,
    )

    cy += 15
    ctx.fillText(
      `MEMORY: ${lead.searchedContainers}/${lead.discoveredContainers} loot · ${lead.discoveredBenches.length} bench · P=${Math.round(lead.pressure * 100)}%`,
      panelX + 12,
      cy,
    )

    cy += 18
    ctx.font = "600 10px ui-monospace, SFMono-Regular, Menlo, monospace"
    ctx.fillStyle = "#64748b"
    ctx.fillText("UTILITY SCORES", panelX + 12, cy)

    for (const u of topScores) {
      cy += 16
      const barW = Math.max(4, Math.min(120, (u.score / 100) * 120))
      const uCol = INTENT_COLORS[u.intent] ?? "#38bdf8"
      ctx.fillStyle = "rgba(30, 41, 59, 0.9)"
      ctx.fillRect(panelX + 120, cy - 9, 124, 10)
      ctx.fillStyle = uCol
      ctx.fillRect(panelX + 120, cy - 9, barW, 10)
      ctx.fillStyle = "#e2e8f0"
      ctx.fillText(u.intent, panelX + 12, cy)
      ctx.fillStyle = "#94a3b8"
      ctx.fillText(u.score.toFixed(0), panelX + 252, cy)
    }

    if (snapshots.length > 1) {
      cy += 18
      ctx.fillStyle = "#64748b"
      ctx.fillText("CO-OP SQUADMATES", panelX + 12, cy)
      for (let i = 1; i < snapshots.length; i++) {
        const ally = snapshots[i]!
        cy += 16
        ctx.fillStyle = INTENT_COLORS[ally.intent] ?? "#38bdf8"
        ctx.fillText(
          `${ally.actorId}: ${ally.intent.toUpperCase()} (${ally.goalLabel.slice(0, 18)})`,
          panelX + 12,
          cy,
        )
      }
    }

    ctx.restore()
  }
}
