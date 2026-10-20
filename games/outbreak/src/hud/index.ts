import type { Camera } from "@arcade/kit/client/camera"
import { keyLabel } from "@arcade/kit/client/controls"
import { clockText } from "../../shared/day-cycle"
import type { SessionView, Survivor } from "../../shared/session"
import { supportHeight } from "../../shared/terrain"
import { vaultLift } from "../../shared/interact"
import { ActorFeedback } from "./actor-feedback"
import { CharacterHud, LOCAL_ACTOR, type HudActorFrame } from "./character"
import type { CalloutKind, CalloutOptions } from "./callouts"
import type { BodyBox } from "./placement"
import { RemoteAdapter, type HudRemote } from "./remote"
import { TEAMMATE_ALL, TEAMMATE_OFF, type HudSettings } from "./settings"
import { GROUND_SEGMENTS, localVitals } from "./vitals"
import { hudMotion } from "./motion"
import "./tokens.css"
import "./hud.css"
import "./dock.css"
import "./prompt.css"
import "./vehicle-hud.css"

export { ActorFeedback } from "./actor-feedback"
export { CalloutLayer, CalloutModel, type CalloutKind, type CalloutOptions } from "./callouts"
export { DEFAULT_HUD_SETTINGS, hudControls, type HudSettings } from "./settings"
export type { HudRemote, RemoteSurvivorView } from "./remote"
export { LOCAL_ACTOR, localVitals }

/** Top of the survivor's hair above the ground, in metres. */
const HEAD_TOP = 1.92
/** Shoulder half-width used to keep callouts clear of the body when the camera looks straight down. */
const BODY_RADIUS = 0.34
/** Radius of the feet circle; its screen-lowest point is "below the feet" under the tilted camera. */
const FOOT_RADIUS = 0.2
/** Radius of the ground ring drawn around the feet in the Diegetic style, in metres: just outside the feet and shadow. */
const GROUND_RADIUS = 0.62
/** Height of the body's middle, where side-placed rings and callouts centre. */
const BODY_MID = 1.05

type Feet = { x: number; y: number; z: number; aim?: number }
type RemoteState = { adapter: RemoteAdapter; feedback: ActorFeedback; seen: boolean }

/**
 * Outbreak's character HUD in the game: projects the local survivor and co-op teammates to screen boxes, turns their
 * state into callouts (`ActorFeedback`) and meter inputs, and hands both to `CharacterHud`. Also writes the compact
 * time and ammo summary. In log mode the callouts stay silent and `main.ts` writes the old status line.
 */
export class OutbreakHud {
  readonly core: CharacterHud
  private readonly feedback: ActorFeedback
  private readonly anchors = new Map<string, () => Feet | null>()
  private readonly remotes = new Map<string, RemoteState>()
  private readonly remoteViews = new Map<string, HudRemote>()
  private cam: Camera | null = null
  private view: SessionView | null = null
  private w = 1
  private h = 1
  private lastSummary = ""
  private avoidEl: HTMLElement | null = null

  constructor(
    parent: HTMLElement,
    private readonly settings: HudSettings,
  ) {
    this.core = new CharacterHud(parent, settings)
    this.applyMotion()
    this.feedback = new ActorFeedback((text, kind, options) => this.core.callout(LOCAL_ACTOR, text, kind, options))
  }

  get layer() {
    return this.core.layer
  }

  get vitals() {
    return this.core.vitals
  }

  get logMode(): boolean {
    return this.core.logMode
  }

  /** Shows a callout on an actor. Other actors register an anchor with `track` first. */
  callout(actorId: string, text: string, kind: CalloutKind, options?: number | CalloutOptions): void {
    this.core.callout(actorId, text, kind, options)
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
    this.core.forget(actorId)
  }

  reset(): void {
    this.feedback.reset()
    this.core.reset()
    for (const id of [...this.remotes.keys()]) this.untrack(id)
    this.remotes.clear()
    this.remoteViews.clear()
  }

  private applyMotion(): void {
    hudMotion.speed = this.settings.hudMotionSpeed
    hudMotion.forceReduced = this.settings.hudReducedMotion
    if (typeof document !== "undefined") hudMotion.install(document.documentElement)
  }

  applySettings(): void {
    const wasLog = this.core.logMode
    this.applyMotion()
    this.core.applySettings()
    if (wasLog !== this.core.logMode) {
      this.lastSummary = ""
      this.feedback.reset()
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
    const tuning = { staminaLow: this.settings.staminaLow, batteryLow: lowBattery, healthLow: this.settings.healthLow }
    const frames: HudActorFrame[] = []
    this.syncRemotes(remotes, view, frames)

    // Read last frame's prompt box before any style writes this frame, so the read never forces a layout.
    const el = this.avoidEl
    const avoid = !this.logMode && el && !el.hidden && this.layer.model.items.length ? el.getBoundingClientRect() : null
    if (!this.logMode) {
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
        meleeKey: keyLabel("KeyV"),
        notices: view.notices.splice(0),
      })
    }
    const feet = this.anchors.get(LOCAL_ACTOR)!()
    const vitals = localVitals(p)
    if (this.core.style.worldState) {
      vitals.battery = null
      vitals.batteryDepleted = false
    }
    frames.unshift({ id: LOCAL_ACTOR, box: feet ? this.body(feet) : null, vitals })
    this.core.frame(dt, view.time, frames, avoid, tuning)
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

  /** Automation view: each actor's chosen sides and visible meters. */
  inspect() {
    return this.core.inspect()
  }

  /** The local survivor's screen box this frame (for recording the HUD prototype's timeline). */
  localBox(): BodyBox | null {
    const feet = this.anchors.get(LOCAL_ACTOR)?.()
    return feet ? this.body(feet) : null
  }

  /**
   * Shows a sample for judging placement (Lab station, `arcade run hud.demo`): an action in progress and a loot pop on
   * the local survivor (plus a noise tag when Noise callouts is on), half-spent stamina that refills live, and a light
   * hit so health shows too.
   */
  demo(player: Survivor) {
    player.stamina = Math.min(player.stamina, 0.45)
    player.regenCooldown = Math.max(player.regenCooldown, 1.5)
    player.health = Math.min(player.health, Math.max(40, player.health - 18))
    this.callout(LOCAL_ACTOR, "Reloading", "progress", { key: "reload", progress: 0.55, duration: 8 })
    this.callout(LOCAL_ACTOR, "+6 9mm", "result", { duration: 8 })
    this.callout(LOCAL_ACTOR, "Noise 18 m", "noise", { key: "noise", duration: 8 })
    this.callout(LOCAL_ACTOR, "+1 plank", "result", { duration: 8 })
    return this.inspect()
  }

  private syncRemotes(list: readonly HudRemote[], view: SessionView, frames: HudActorFrame[]): void {
    for (const r of this.remotes.values()) r.seen = false
    for (const remote of list) {
      let r = this.remotes.get(remote.id)
      if (!r) {
        const id = remote.id
        const feedback = new ActorFeedback((text, kind, options) => {
          const filter = this.settings.teammateCallouts
          if (filter === TEAMMATE_OFF) return
          if (filter === TEAMMATE_ALL || kind === "progress" || kind === "warning" || kind === "danger") this.core.callout(id, text, kind, options)
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
      const feet = remote.visible ? this.anchors.get(remote.id)!() : null
      frames.push({ id: remote.id, box: feet ? this.body(feet) : null, vitals: r.adapter.vitals(s) })
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
    // The ground circle, projected point by point so the ellipse has the camera's real perspective.
    const ground: number[] = new Array(GROUND_SEGMENTS * 2)
    for (let i = 0; i < GROUND_SEGMENTS; i++) {
      const t = (i / GROUND_SEGMENTS) * Math.PI * 2
      const p = cam.project(f.x + Math.cos(t) * GROUND_RADIUS, f.y + 0.02, f.z + Math.sin(t) * GROUND_RADIUS, w, h)
      ground[i * 2] = p.x
      ground[i * 2 + 1] = p.y
    }
    return {
      x: head.x,
      top: Math.min(head.y, headBack.y, headFront.y),
      bottom: Math.max(toe.y, head.y),
      half: Math.max(6, Math.abs(side.x - mid.x)),
      mid: mid.y,
      aimX,
      aimY,
      ground,
    }
  }
}
