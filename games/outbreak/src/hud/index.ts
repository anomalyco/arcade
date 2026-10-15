import type { Camera } from "@arcade/kit/client/camera"
import { keyLabel } from "@arcade/kit/client/controls"
import { clockText } from "../../shared/day-cycle"
import type { SessionView } from "../../shared/session"
import { supportHeight } from "../../shared/terrain"
import { vaultLift } from "../../shared/interact"
import { ActorFeedback } from "./actor-feedback"
import { CalloutLayer, type CalloutKind, type CalloutOptions, type ScreenPoint } from "./callouts"
import { HUD_MODE_LOG, type HudSettings } from "./settings"
import "./hud.css"

export { ActorFeedback } from "./actor-feedback"
export { CalloutLayer, CalloutModel, type CalloutKind, type CalloutOptions } from "./callouts"
export { DEFAULT_HUD_SETTINGS, hudControls, type HudSettings } from "./settings"

export const LOCAL_ACTOR = "local"

/** Top of the survivor's hair above the ground, in metres. */
const HEAD_TOP = 1.92
/** Shoulder half-width used to keep callouts clear of the body when the camera looks straight down. */
const BODY_RADIUS = 0.34

/**
 * Outbreak's action feedback: callouts above the local survivor (and any other actor registered with an anchor),
 * plus the compact time and ammo summary. In log mode it stays silent and `main.ts` writes the old status line.
 */
export class OutbreakHud {
  readonly layer: CalloutLayer
  private readonly feedback: ActorFeedback
  private readonly anchors = new Map<string, () => { x: number; y: number; z: number } | null>()
  private cam: Camera | null = null
  private view: SessionView | null = null
  private w = 1
  private h = 1
  private lastSummary = ""
  private mode = -1
  private avoidEl: HTMLElement | null = null
  private avoidRect: DOMRect | null = null
  private lift = 0
  private liftDt = 0

  constructor(
    parent: HTMLElement,
    private readonly settings: HudSettings,
  ) {
    this.layer = new CalloutLayer(parent, { durationScale: settings.calloutDuration, maxVisible: settings.calloutMax })
    this.feedback = new ActorFeedback((text, kind, options) => this.layer.callout(LOCAL_ACTOR, text, kind, options))
    this.applySettings()
  }

  get logMode(): boolean {
    return this.settings.hudMode === HUD_MODE_LOG
  }

  /** Shows a callout above an actor. Co-op peers register an anchor with `track` first. */
  callout(actorId: string, text: string, kind: CalloutKind, options?: number | CalloutOptions): void {
    if (!this.logMode) this.layer.callout(actorId, text, kind, options)
  }

  /** Registers where an actor's feet are in world space (x, ground height, plan y); null hides its callouts. */
  track(actorId: string, feet: () => { x: number; y: number; z: number } | null): void {
    this.anchors.set(actorId, feet)
  }

  /** Keeps the local survivor's callouts clear of an element, such as the floating interaction prompt. */
  avoid(el: HTMLElement | null): void {
    this.avoidEl = el
  }

  untrack(actorId: string): void {
    this.anchors.delete(actorId)
    this.layer.clear(actorId)
  }

  reset(): void {
    this.feedback.reset()
    this.layer.clear()
  }

  applySettings(): void {
    const s = this.settings
    this.layer.model.tuning.durationScale = s.calloutDuration
    this.layer.model.tuning.maxVisible = s.calloutMax
    this.layer.setSize(s.calloutSize)
    if (this.mode !== s.hudMode) {
      this.mode = s.hudMode
      document.body.dataset.hud = this.logMode ? "log" : "callouts"
      this.lastSummary = ""
      this.feedback.reset()
      this.layer.clear()
    }
  }

  /**
   * Call once per drawn frame after the camera update. `noiseSource` is the local survivor's noise id ("player"
   * offline, the seat id in co-op).
   */
  update(dt: number, view: SessionView, cam: Camera, w: number, h: number, lowBattery: number, noiseSource = "player"): void {
    this.cam = cam
    this.w = w
    this.h = h
    const { player: p, town } = view
    if (!this.anchors.has(LOCAL_ACTOR)) {
      this.track(LOCAL_ACTOR, () => {
        const v = this.view
        if (!v) return null
        const q = v.player
        return { x: q.x, y: supportHeight(v.town, q.x, q.y) + vaultLift(q), z: q.y }
      })
    }
    this.view = view
    if (this.logMode) return
    // Read last frame's prompt box before any style writes this frame, so the read never forces a layout.
    const el = this.avoidEl
    this.avoidRect = el && !el.hidden && this.layer.model.items.length ? el.getBoundingClientRect() : null
    this.liftDt = dt
    const pursuing = view.zombies.reduce((n, z) => n + (z.state === "chase" || z.state === "alert" || z.state === "bash" ? 1 : 0), 0)
    this.feedback.observe(p, {
      time: view.time,
      town,
      prompt: view.prompt,
      inventory: view.inventory,
      noises: view.noises,
      noiseSource,
      pursuing,
      lowBattery,
      reloadKey: keyLabel("KeyR"),
      notices: view.notices.splice(0),
    })
    this.layer.render(dt, (id) => this.anchor(id))
  }

  /** Compact top-left summary for callout mode, with an optional weather label. Returns null when unchanged. */
  summary(view: SessionView, weather = ""): string | null {
    const p = view.player
    const parts = [clockText(view.hour)]
    if (weather) parts.push(weather)
    if (p.equippedItem === "pistol") parts.push(`9mm ${p.magAmmo}/${p.magCapacity} +${p.reserveAmmo}`)
    if (p.planks > 0) parts.push(`${p.planks} plank${p.planks > 1 ? "s" : ""}`)
    const alerted = view.zombies.reduce((n, z) => n + (z.state === "chase" || z.state === "alert" || z.state === "bash" ? 1 : 0), 0)
    if (alerted > 0) parts.push(`${alerted} pursuing`)
    const text = parts.join(" · ")
    if (text === this.lastSummary) return null
    this.lastSummary = text
    return text
  }

  /** Smoothed upward shift that moves the stack above the avoided element when the two would overlap. */
  private liftAbove(x: number, y: number): number {
    const r = this.avoidRect
    const stack = Math.max(1, this.layer.model.forActor(LOCAL_ACTOR).length) * Math.round(this.settings.calloutSize * 1.95)
    const half = 9 * this.settings.calloutSize
    const target = r && r.width > 0 && r.left < x + half && r.right > x - half && r.top < y && r.bottom > y - stack ? y - r.top + 6 : 0
    const k = this.layer.reducedMotion ? 1 : 1 - Math.exp(-this.liftDt * 14)
    this.lift += (target - this.lift) * k
    return this.lift
  }

  private anchor(actorId: string): ScreenPoint | null {
    const cam = this.cam
    const feet = this.anchors.get(actorId)?.()
    if (!cam || !feet) return null
    const { w, h } = this
    const top = feet.y + HEAD_TOP
    let minY = Infinity
    let x = 0
    for (const [dx, dy, dz] of [
      [0, 0, 0],
      [0, top - feet.y, 0],
      [0, top - feet.y, -BODY_RADIUS],
      [0, top - feet.y, BODY_RADIUS],
    ] as const) {
      const s = cam.project(feet.x + dx, feet.y + dy, feet.z + dz, w, h)
      if (!s.ok) return null
      if (dy > 0 && dz === 0) x = s.x
      minY = Math.min(minY, s.y)
    }
    let y = minY - this.settings.calloutOffset
    if (actorId === LOCAL_ACTOR) y -= this.liftAbove(x, y)
    if (x < -200 || x > w + 200 || y < -200 || y > h + 200) return null
    return { x, y }
  }
}
