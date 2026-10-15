/**
 * The character HUD renderer: callouts, meters and status icons for any number of actors, given each actor's screen
 * box and meter inputs. It knows nothing about the camera or the simulation, so the game (`OutbreakHud`) and the
 * board prototype (recorded frames) drive the same code.
 */
import { CalloutLayer, type CalloutKind, type CalloutOptions, type ScreenPoint } from "./callouts"
import { chooseSide, SideBlend, VITALS_BESIDE, VITALS_EDGE, VITALS_FEET, VITALS_BARS, VITALS_GROUND, VITALS_ICONS, type BodyBox, type Side } from "./placement"
import { HUD_MODE_LOG, RING_ARC, RING_WHEEL, type HudSettings } from "./settings"
import { onCharacter, resolveStyle, type ResolvedStyle } from "./styles"
import { ActorVitals, StatusIcons, VitalsLayer, type MeterId, type VitalsInput, type VitalsTuning } from "./vitals"

export const LOCAL_ACTOR = "local"

/** Extra room above a remote survivor's head for its name tag. */
const NAME_TAG_PX = 16
/** Seconds the hotbar stays up after a slot change when the style hides it. */
const HOTBAR_WAKE = 2.2

export type HudActorFrame = {
  id: string
  /** Screen box, or null when off screen or out of sight. */
  box: BodyBox | null
  vitals: VitalsInput
}

type ActorState = {
  callouts: SideBlend
  vitalsSide: SideBlend
  vitals: ActorVitals
  push: number
  box: BodyBox | null
  calloutAt: { x: number; y: number } | null
}

export class CharacterHud {
  readonly layer: CalloutLayer
  readonly vitals: VitalsLayer
  readonly status: StatusIcons
  style: ResolvedStyle
  private readonly actors = new Map<string, ActorState>()
  private mode = -1
  private applied = ""
  private avoidRect: DOMRect | null = null
  private dt = 0
  private now = 0
  private hotbarUntil = -Infinity
  private hotbarAwake = ""

  constructor(
    parent: HTMLElement,
    readonly settings: HudSettings,
    private readonly body: HTMLElement = document.body,
  ) {
    this.layer = new CalloutLayer(parent, { durationScale: settings.calloutDuration, maxVisible: settings.calloutMax })
    this.vitals = new VitalsLayer(parent, settings.vitalSize)
    this.status = new StatusIcons(parent)
    this.style = resolveStyle(settings)
    this.applySettings()
  }

  get logMode(): boolean {
    return this.settings.hudMode === HUD_MODE_LOG
  }

  applySettings(): void {
    const s = this.settings
    this.style = resolveStyle(s)
    this.layer.model.tuning.durationScale = s.calloutDuration
    this.layer.model.tuning.maxVisible = s.calloutMax
    this.layer.setSize(s.calloutSize)
    this.vitals.setSize(s.vitalSize)
    if (this.mode !== s.hudMode) {
      this.mode = s.hudMode
      this.body.dataset.hud = this.logMode ? "log" : "callouts"
      this.layer.clear()
    }
    const st = this.style
    const key = `${st.vitals}|${st.chrome}|${st.look}|${st.actionBar}|${s.ringStyle}`
    if (key !== this.applied) {
      this.applied = key
      this.body.dataset.vitals = st.vitals === VITALS_EDGE ? "edge" : "character"
      this.body.dataset.chrome = st.chrome
      this.layer.root.dataset.look = st.look
      this.layer.root.dataset.action = st.actionBar ? "bar" : "label"
      this.vitals.root.dataset.ring = s.ringStyle === RING_WHEEL ? "wheel" : s.ringStyle === RING_ARC ? "arc" : "ring"
    }
  }

  /** Shows a callout on an actor, unless log mode, the noise setting or the style's quiet rule drops it. */
  callout(actorId: string, text: string, kind: CalloutKind, options?: number | CalloutOptions): void {
    if (this.logMode) return
    if (kind === "noise" && !this.settings.noiseCallouts) return
    if (this.style.quiet && kind === "info") return
    this.layer.callout(actorId, text, kind, options)
  }

  /** The hotbar shows for a moment after a slot change in styles that hide it. */
  wakeHotbar(): void {
    this.hotbarUntil = this.now + HOTBAR_WAKE
  }

  get reducedMotion(): boolean {
    return this.layer.reducedMotion
  }

  forget(id: string): void {
    this.actors.delete(id)
    this.layer.clear(id)
    this.vitals.drop(id)
  }

  reset(): void {
    this.layer.clear()
    for (const id of [...this.actors.keys()]) this.vitals.drop(id)
    this.actors.clear()
  }

  /**
   * One drawn frame. `now` is session time in seconds, `avoid` the interaction prompt's box from last frame (the
   * local survivor's callouts keep clear of it). Actors missing from `actors` keep their state but draw nothing.
   */
  frame(dt: number, now: number, actors: readonly HudActorFrame[], avoid: DOMRect | null, tuning: VitalsTuning): void {
    this.dt = dt
    this.now = now
    this.avoidRect = avoid
    const reduced = this.layer.reducedMotion
    const style = this.style
    const hidden = this.settings.healthOnCharacter ? undefined : new Set<MeterId>(["health"])
    const seen = new Set<string>()
    for (const a of actors) {
      seen.add(a.id)
      const st = this.state(a.id)
      st.vitals.observe(a.vitals, tuning, now, dt)
      st.box = a.box
      st.calloutAt = null
      const box = a.box
      const local = a.id === LOCAL_ACTOR
      const scale = local ? 1 : this.settings.teammateScale
      if (!box) {
        this.vitals.draw(a.id, st.vitals, null, reduced)
        continue
      }
      const vitalsMode = style.vitals
      const drawn = onCharacter(vitalsMode)
      let below = 0
      let ringSide: Side | null = null
      if (vitalsMode === VITALS_BESIDE || vitalsMode === VITALS_FEET || vitalsMode === VITALS_GROUND) {
        // Rings: beside the body or in a row under the feet. Ground mode keeps reload and battery as rings beside.
        ringSide = chooseSide(vitalsMode === VITALS_FEET ? "down" : "right", { x: box.aimX, y: box.aimY }, st.vitalsSide.side, style.avoid)
        const gap = this.settings.vitalOffset + (ringSide === "up" && !local ? NAME_TAG_PX : 0)
        const at = st.vitalsSide.step(box, ringSide, gap, dt, reduced)
        const al = st.vitalsSide.align
        const row = { x: at.x, y: at.y, ax: al.ax, ay: al.ay, reverse: ringSide === "left", scale }
        const ground =
          vitalsMode === VITALS_GROUND && box.footW
            ? { x: box.footX!, y: box.footY!, w: box.footW * (local ? 1 : 0.85), h: box.footH! * (local ? 1 : 0.85) }
            : undefined
        this.vitals.draw(a.id, st.vitals, { row, ground }, reduced, hidden)
      } else if (vitalsMode === VITALS_BARS) {
        const y = box.bottom + this.settings.vitalOffset
        this.vitals.draw(a.id, st.vitals, { bars: { x: box.x, y, scale } }, reduced, hidden)
        below = this.vitals.barsHeight(st.vitals, scale, hidden)
      } else {
        this.vitals.draw(a.id, st.vitals, null, reduced)
      }
      if (local) this.status.draw(vitalsMode === VITALS_ICONS ? st.vitals : null)

      if (this.logMode) continue
      const side = chooseSide(style.callouts, { x: box.aimX, y: box.aimY }, st.callouts.side, style.avoid)
      let gap = this.settings.calloutOffset + (side === "up" && !local ? NAME_TAG_PX : 0)
      // Start the stack past whatever meters share its side.
      if (drawn && st.vitals.presence > 0.001) {
        if (side === "down" && below > 0) gap += below + this.settings.vitalOffset
        else if (ringSide && side === ringSide) {
          const along = side === "up" || side === "down" ? this.vitals.rowSize(scale) : this.vitals.rowWidth(st.vitals, scale)
          gap += along + this.settings.vitalOffset
        }
      }
      st.calloutAt = st.callouts.step(box, side, gap, dt, reduced)
    }
    for (const [id, st] of this.actors) {
      if (seen.has(id)) continue
      st.box = null
      st.calloutAt = null
      this.vitals.draw(id, st.vitals, null, reduced)
    }
    const awake = now < this.hotbarUntil ? "true" : ""
    if (awake !== this.hotbarAwake) {
      this.hotbarAwake = awake
      if (awake) this.body.dataset.hotbar = "awake"
      else delete this.body.dataset.hotbar
    }
    if (!this.logMode) this.layer.render(dt, (id) => this.anchor(id))
  }

  /** Automation view: each actor's chosen sides and visible meters. */
  inspect(): Record<string, { callouts: Side | null; rings: Side | null; meters: { id: string; state: string; fill: number; alpha: number }[] }> {
    const out: ReturnType<CharacterHud["inspect"]> = {}
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
