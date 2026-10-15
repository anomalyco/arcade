import type { Camera } from "@arcade/kit/client/camera"
import { keyLabel } from "@arcade/kit/client/controls"
import { clockText } from "../../shared/day-cycle"
import { PISTOL_RELOAD_TIME } from "../../shared/combat"
import type { SessionView, Survivor } from "../../shared/session"
import { supportHeight } from "../../shared/terrain"
import { vaultLift } from "../../shared/interact"
import { ActorFeedback } from "./actor-feedback"
import { CalloutLayer, type CalloutKind, type CalloutOptions, type ScreenPoint } from "./callouts"
import {
  CALLOUTS_ABOVE,
  CALLOUTS_BESIDE,
  chooseSide,
  SideBlend,
  VITALS_EDGE,
  VITALS_FEET,
  type BodyBox,
  type Side,
} from "./placement"
import { RemoteAdapter, type HudRemote } from "./remote"
import { HUD_MODE_LOG, TEAMMATE_ALL, TEAMMATE_OFF, type HudSettings } from "./settings"
import { ActorVitals, VitalsLayer, type VitalsInput } from "./vitals"
import "./hud.css"

export { ActorFeedback } from "./actor-feedback"
export { CalloutLayer, CalloutModel, type CalloutKind, type CalloutOptions } from "./callouts"
export { DEFAULT_HUD_SETTINGS, hudControls, type HudSettings } from "./settings"
export type { HudRemote, RemoteSurvivorView } from "./remote"

export const LOCAL_ACTOR = "local"

/** Top of the survivor's hair above the ground, in metres. */
const HEAD_TOP = 1.92
/** Shoulder half-width used to keep callouts clear of the body when the camera looks straight down. */
const BODY_RADIUS = 0.34
/** Radius of the feet circle; its screen-lowest point is "below the feet" under the tilted camera. */
const FOOT_RADIUS = 0.2
/** Height of the body's middle, where side-placed rings and callouts centre. */
const BODY_MID = 1.05
/** Extra room above a remote survivor's head for its name tag. */
const NAME_TAG_PX = 16

type Feet = { x: number; y: number; z: number; aim?: number }

type ActorState = {
  callouts: SideBlend
  vitalsSide: SideBlend
  vitals: ActorVitals
  /** Smoothed push that keeps the stack clear of the interaction prompt (local survivor only). */
  push: number
  box: BodyBox | null
  calloutAt: { x: number; y: number } | null
}

type RemoteState = { adapter: RemoteAdapter; feedback: ActorFeedback; seen: boolean }

/**
 * Outbreak's character HUD: action callouts and status rings on the local survivor and on other co-op survivors,
 * plus the compact time and ammo summary. In log mode the callouts stay silent and `main.ts` writes the old status
 * line; the rings follow their own placement setting.
 */
export class OutbreakHud {
  readonly layer: CalloutLayer
  readonly vitals: VitalsLayer
  private readonly feedback: ActorFeedback
  private readonly anchors = new Map<string, () => Feet | null>()
  private readonly actors = new Map<string, ActorState>()
  private readonly remotes = new Map<string, RemoteState>()
  private readonly remoteViews = new Map<string, HudRemote>()
  private cam: Camera | null = null
  private view: SessionView | null = null
  private w = 1
  private h = 1
  private dt = 0
  private lastSummary = ""
  private mode = -1
  private vitalsMode = -1
  private avoidEl: HTMLElement | null = null
  private avoidRect: DOMRect | null = null

  constructor(
    parent: HTMLElement,
    private readonly settings: HudSettings,
  ) {
    this.layer = new CalloutLayer(parent, { durationScale: settings.calloutDuration, maxVisible: settings.calloutMax })
    this.vitals = new VitalsLayer(parent, settings.vitalSize)
    this.feedback = new ActorFeedback((text, kind, options) => this.layer.callout(LOCAL_ACTOR, text, kind, options))
    this.applySettings()
  }

  get logMode(): boolean {
    return this.settings.hudMode === HUD_MODE_LOG
  }

  /** Shows a callout on an actor. Other actors register an anchor with `track` first. */
  callout(actorId: string, text: string, kind: CalloutKind, options?: number | CalloutOptions): void {
    if (!this.logMode) this.layer.callout(actorId, text, kind, options)
  }

  /** Registers where an actor's feet are in world space (x, ground height, plan y, optional aim); null hides it. */
  track(actorId: string, feet: () => Feet | null): void {
    this.anchors.set(actorId, feet)
  }

  /** Keeps the local survivor's callouts clear of an element, such as the floating interaction prompt. */
  avoid(el: HTMLElement | null): void {
    this.avoidEl = el
  }

  untrack(actorId: string): void {
    this.anchors.delete(actorId)
    this.actors.delete(actorId)
    this.layer.clear(actorId)
    this.vitals.drop(actorId)
  }

  reset(): void {
    this.feedback.reset()
    this.layer.clear()
    for (const id of [...this.actors.keys()]) this.vitals.drop(id)
    this.actors.clear()
    for (const id of [...this.remotes.keys()]) this.untrack(id)
    this.remotes.clear()
  }

  applySettings(): void {
    const s = this.settings
    this.layer.model.tuning.durationScale = s.calloutDuration
    this.layer.model.tuning.maxVisible = s.calloutMax
    this.layer.setSize(s.calloutSize)
    this.vitals.setSize(s.vitalSize)
    if (this.mode !== s.hudMode) {
      this.mode = s.hudMode
      document.body.dataset.hud = this.logMode ? "log" : "callouts"
      this.lastSummary = ""
      this.feedback.reset()
      this.layer.clear()
    }
    if (this.vitalsMode !== s.vitalsPlacement) {
      this.vitalsMode = s.vitalsPlacement
      document.body.dataset.vitals = s.vitalsPlacement === VITALS_EDGE ? "edge" : "character"
    }
  }

  /**
   * Call once per drawn frame after the camera update. `noiseSource` is the local survivor's noise id ("player"
   * offline, the seat id in co-op). `remotes` are the other survivors in a co-op room.
   */
  update(
    dt: number,
    view: SessionView,
    cam: Camera,
    w: number,
    h: number,
    lowBattery: number,
    noiseSource = "player",
    remotes: readonly HudRemote[] = [],
  ): void {
    this.cam = cam
    this.w = w
    this.h = h
    this.dt = dt
    const { player: p, town } = view
    if (!this.anchors.has(LOCAL_ACTOR)) {
      this.track(LOCAL_ACTOR, () => {
        const v = this.view
        if (!v) return null
        const q = v.player
        return { x: q.x, y: supportHeight(v.town, q.x, q.y) + vaultLift(q), z: q.y, aim: q.aim }
      })
    }
    this.view = view
    const reduced = this.layer.reducedMotion
    const tuning = { staminaLow: this.settings.staminaLow, batteryLow: lowBattery, healthLow: this.settings.healthLow }
    const showRings = this.settings.vitalsPlacement !== VITALS_EDGE

    this.state(LOCAL_ACTOR).vitals.observe(localVitals(p), tuning, view.time, dt)
    this.syncRemotes(remotes, view, tuning)

    if (!this.logMode) {
      // Read last frame's prompt box before any style writes this frame, so the read never forces a layout.
      const el = this.avoidEl
      this.avoidRect = el && !el.hidden && this.layer.model.items.length ? el.getBoundingClientRect() : null
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
      })
    }

    // Place every tracked actor once: body box, ring side, then callout side.
    for (const [id, feet] of this.anchors) {
      const st = this.state(id)
      const remote = this.remoteViews.get(id)
      const f = remote && !remote.visible ? null : feet()
      st.box = f ? this.body(f) : null
      st.calloutAt = null
      if (!st.box) {
        this.vitals.draw(id, st.vitals, null, reduced)
        continue
      }
      const scale = id === LOCAL_ACTOR ? 1 : this.settings.teammateScale
      const ringsUp = showRings && st.vitals.presence > 0.001
      const ringSide = this.ringSide(st)
      if (showRings) {
        const gap = this.settings.vitalOffset + (ringSide === "up" && id !== LOCAL_ACTOR ? NAME_TAG_PX : 0)
        const at = st.vitalsSide.step(st.box, ringSide, gap, dt, reduced)
        const a = st.vitalsSide.align
        this.vitals.draw(id, st.vitals, { x: at.x, y: at.y, ax: a.ax, ay: a.ay, reverse: ringSide === "left", scale }, reduced)
      } else {
        this.vitals.draw(id, st.vitals, null, reduced)
      }
      if (!this.logMode) {
        const side = this.calloutSide(st)
        let gap = this.settings.calloutOffset + (side === "up" && id !== LOCAL_ACTOR ? NAME_TAG_PX : 0)
        // Share a side with the rings by starting the stack past them.
        if (ringsUp && side === ringSide) {
          const along = side === "up" || side === "down" ? this.vitals.rowSize(scale) : this.vitals.rowWidth(st.vitals, scale)
          gap += along + this.settings.vitalOffset
        }
        st.calloutAt = st.callouts.step(st.box, side, gap, dt, reduced)
      }
    }
    if (!this.logMode) this.layer.render(dt, (id) => this.anchor(id))
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

  /**
   * Shows a sample for judging placement (Lab station, `arcade run hud.demo`): an action in progress, a loot pop and a
   * noise on the local survivor, and half-spent stamina that refills live.
   */
  demo(player: Survivor): ReturnType<OutbreakHud["inspect"]> {
    player.stamina = Math.min(player.stamina, 0.45)
    player.regenCooldown = Math.max(player.regenCooldown, 1.5)
    this.callout(LOCAL_ACTOR, "Reloading", "progress", { key: "reload", progress: 0.55, duration: 8 })
    this.callout(LOCAL_ACTOR, "+6 9mm", "result", { duration: 8 })
    this.callout(LOCAL_ACTOR, "Noise 18 m", "noise", { key: "noise", duration: 8 })
    return this.inspect()
  }

  /** Automation view: each actor's chosen sides and visible rings. */
  inspect(): Record<string, { callouts: Side | null; rings: Side | null; meters: { id: string; state: string; fill: number; alpha: number }[] }> {
    const out: ReturnType<OutbreakHud["inspect"]> = {}
    for (const [id, st] of this.actors) {
      out[id] = {
        callouts: st.callouts.side,
        rings: st.vitalsSide.side,
        meters: st.vitals.meters.filter((m) => m.alpha > 0).map((m) => ({ id: m.id, state: m.state, fill: m.fill, alpha: m.alpha })),
      }
    }
    return out
  }

  private state(id: string): ActorState {
    let st = this.actors.get(id)
    if (!st) {
      st = { callouts: new SideBlend(), vitalsSide: new SideBlend(), vitals: new ActorVitals(), push: 0, box: null, calloutAt: null }
      this.actors.set(id, st)
    }
    return st
  }

  private syncRemotes(list: readonly HudRemote[], view: SessionView, tuning: { staminaLow: number; batteryLow: number; healthLow: number }): void {
    for (const r of this.remotes.values()) r.seen = false
    for (const remote of list) {
      let r = this.remotes.get(remote.id)
      if (!r) {
        const id = remote.id
        const feedback = new ActorFeedback((text, kind, options) => {
          const filter = this.settings.teammateCallouts
          if (this.logMode || filter === TEAMMATE_OFF) return
          if (filter === TEAMMATE_ALL || kind === "progress" || kind === "warning" || kind === "danger") {
            this.layer.callout(id, text, kind, options)
          }
        })
        r = { adapter: new RemoteAdapter(), feedback, seen: true }
        this.remotes.set(id, r)
        this.track(id, () => {
          const v = this.remoteViews.get(id)
          return v ? { x: v.survivor.x, y: v.ground, z: v.survivor.y, aim: v.survivor.aim } : null
        })
      }
      r.seen = true
      this.remoteViews.set(remote.id, remote)
      const s = remote.survivor
      r.adapter.update(s, view.time)
      r.feedback.observe(r.adapter.feedback(s), { time: view.time })
      this.state(remote.id).vitals.observe(r.adapter.vitals(s), tuning, view.time, this.dt)
    }
    for (const [id, r] of this.remotes) {
      if (r.seen) continue
      this.remotes.delete(id)
      this.remoteViews.delete(id)
      this.untrack(id)
    }
  }

  /** Screen box of an actor's body from its feet, accounting for the camera tilt. */
  private body(f: Feet): BodyBox | null {
    const cam = this.cam
    if (!cam) return null
    const { w, h } = this
    const top = f.y + HEAD_TOP
    const head = cam.project(f.x, top, f.z, w, h)
    const headBack = cam.project(f.x, top, f.z - BODY_RADIUS, w, h)
    const headFront = cam.project(f.x, top, f.z + BODY_RADIUS, w, h)
    const toe = cam.project(f.x, f.y, f.z + FOOT_RADIUS, w, h)
    const mid = cam.project(f.x, f.y + BODY_MID, f.z, w, h)
    const side = cam.project(f.x + BODY_RADIUS, f.y + BODY_MID, f.z, w, h)
    if (!head.ok || !toe.ok || !mid.ok) return null
    if (mid.x < -200 || mid.x > w + 200 || mid.y < -200 || mid.y > h + 200) return null
    let aimX = 0
    let aimY = 0
    if (f.aim !== undefined) {
      const ahead = cam.project(f.x + Math.cos(f.aim), f.y + BODY_MID, f.z + Math.sin(f.aim), w, h)
      if (ahead.ok) {
        aimX = ahead.x - mid.x
        aimY = ahead.y - mid.y
      }
    }
    return {
      x: head.x,
      top: Math.min(head.y, headBack.y, headFront.y),
      bottom: Math.max(toe.y, head.y),
      half: Math.max(6, Math.abs(side.x - mid.x)),
      mid: mid.y,
      aimX,
      aimY,
    }
  }

  private ringSide(st: ActorState): Side {
    const box = st.box!
    const preferred: Side = this.settings.vitalsPlacement === VITALS_FEET ? "down" : "right"
    return chooseSide(preferred, { x: box.aimX, y: box.aimY }, st.vitalsSide.side, this.settings.avoidAim)
  }

  private calloutSide(st: ActorState): Side {
    const box = st.box!
    const p = this.settings.calloutPlacement
    const preferred: Side = p === CALLOUTS_ABOVE ? "up" : p === CALLOUTS_BESIDE ? "left" : "down"
    return chooseSide(preferred, { x: box.aimX, y: box.aimY }, st.callouts.side, this.settings.avoidAim)
  }

  /** Smoothed shift along the stack direction that moves it past the avoided element when the two would overlap. */
  private pushClear(st: ActorState, x: number, y: number, sy: number): number {
    const r = this.avoidRect
    const rows = Math.max(1, this.layer.model.forActor(LOCAL_ACTOR).length)
    const stack = rows * Math.round(this.settings.calloutSize * 1.95)
    const half = 9 * this.settings.calloutSize
    let target = 0
    if (r && r.width > 0 && r.left < x + half && r.right > x - half) {
      const lo = sy < 0 ? y - stack : y
      const hi = sy < 0 ? y : y + stack
      if (r.top < hi && r.bottom > lo) target = sy < 0 ? y - r.top + 6 : r.bottom - y + 6
    }
    const k = this.layer.reducedMotion ? 1 : 1 - Math.exp(-this.dt * 14)
    st.push += (target - st.push) * k
    return st.push * (sy < 0 ? -1 : 1)
  }

  private anchor(actorId: string): ScreenPoint | null {
    const st = this.actors.get(actorId)
    if (!st?.box || !st.calloutAt) return null
    const a = st.callouts.align
    const { x } = st.calloutAt
    let { y } = st.calloutAt
    if (actorId === LOCAL_ACTOR) y += this.pushClear(st, x, y, a.sy)
    const scale = actorId === LOCAL_ACTOR ? 1 : this.settings.teammateScale
    return { x, y, ax: a.ax, ay: a.ay, sy: a.sy, scale }
  }
}

/** Ring inputs for the local survivor, whose full state is known. */
function localVitals(p: Survivor): VitalsInput {
  return {
    health: p.health,
    maxHealth: p.maxHealth,
    stamina: p.stamina,
    sprinting: p.sprinting,
    exhausted: p.exhausted,
    reload: p.reloadRemaining > 0 ? 1 - p.reloadRemaining / PISTOL_RELOAD_TIME : null,
    pistol: p.equippedItem === "pistol",
    magAmmo: p.magAmmo,
    reserveAmmo: p.reserveAmmo,
    flashlightOn: p.flashlightOn,
    battery: p.battery,
    batteryDepleted: p.batteryDepleted,
    flashlightOutput: p.flashlightOutput,
  }
}
