import type { Camera } from "@arcade/kit/client/camera"
import { crowdHearingReach } from "../../shared/ai"
import { shellRadius, type HearingTuning } from "../../shared/hearing"
import { supportHeight } from "../../shared/terrain"
import type { Town } from "../../shared/map"
import type { OutbreakClientFrameContext } from "../feature-registry"
import { jitteredSoundOrigin } from "../fog-of-war"
import {
  cueFrame,
  edgeAnchor,
  SoundCueModel,
  springStep,
  type CueSource,
  type NoiseLike,
  type SoundCue,
} from "./model"
import { SOUND_CUES_MARKS, SOUND_CUES_TODAY, type SoundCueSettings } from "./settings"

type Rgb = readonly [number, number, number]
/** Noir HUD tokens (src/hud/tokens.css): your own noise in ink, the world's in the lamp's amber, danger in red. */
const INK: Rgb = [237, 231, 217]
const ALLY: Rgb = [196, 210, 216]
const WARM: Rgb = [241, 196, 106]
const DANGER: Rgb = [229, 103, 75]
const BONE: Rgb = [182, 174, 159]
const FONT = '500 11px "SF Pro Text", ui-sans-serif, system-ui, -apple-system, sans-serif'
const EDGE_INSET = 34

const rgba = (c: Rgb, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, Math.min(1, a)).toFixed(3)})`

function cueColour(source: CueSource, urgent: boolean): Rgb {
  if (source === "self") return INK
  if (source === "ally") return ALLY
  return urgent || source === "dead" ? DANGER : WARM
}

type Spring = { v: number; dv: number }
type UnseenMark = { x: Spring; y: Spring; alpha: Spring; urgent: boolean; live: boolean; period: number }

/**
 * Sound cues on screen (AR-67): every noise the dead can hear gets a ring the size of their reach, drawn on the
 * ground at its source with a wavefront running out to it, a short label ("Shot · 24 m"), and an arrow at the screen
 * edge when it is off screen. Your own noises are ink, the world's amber, the dead's and danger red. Your footsteps
 * keep a quiet dashed ring at your feet while they carry; inside a shut house the solid ring is what reaches the
 * street. The dead you can hear moving out of sight get a soft sound mark near (never on) them.
 */
export class SoundCueOverlay {
  private canvas: HTMLCanvasElement | null = null
  private g: CanvasRenderingContext2D | null = null
  readonly model = new SoundCueModel()
  private readonly ownReach: Spring = { v: 0, dv: 0 }
  private readonly ownOutside: Spring = { v: 0, dv: 0 }
  private readonly ownAlpha: Spring = { v: 0, dv: 0 }
  private readonly unseen = new Map<number, UnseenMark>()
  private readonly allies = new Set<string>()
  /** Cues drawn last frame, for the harness. */
  drawn = { cues: 0, edges: 0, unseen: 0, ownReach: 0 }

  draw(frame: OutbreakClientFrameContext): void {
    const settings = frame.settings.hud as unknown as SoundCueSettings & { hudReducedMotion: boolean }
    const style = settings.soundCueStyle
    if (style === SOUND_CUES_TODAY) {
      if (this.canvas) this.canvas.hidden = true
      this.model.reset()
      return
    }
    const g = this.surface(frame.w, frame.h)
    if (!g) return
    const { session, cam, w, h, dt, coop } = frame
    const view = session.view
    const { player: p, town, time } = view
    const ai = session.ai
    const k = crowdHearingReach(ai.config, ai.threat)
    const tuning = ai.hearing.tuning as HearingTuning
    const reduced = settings.hudReducedMotion || cam.isReducedMotion()
    const opacity = settings.soundCueOpacity
    const selfId = coop.net?.id || "player"
    this.allies.clear()
    for (const s of session.sim.slots) if (s.id !== selfId) this.allies.add(s.id)

    const outsideOf = (x: number, y: number, radius: number): number | null => {
      if (!(tuning.hearingModel >= 1)) return null
      const b = ai.hearing.buildingAt(x, y)
      if (b < 0) return null
      const open = (ai.hearing.shell(b)?.openings.length ?? 0) > 0
      return shellRadius(radius, open, tuning) * k
    }
    this.model.observe(view.noises as readonly NoiseLike[], selfId, this.allies, time, (n) => ({
      reach: n.radius * k,
      outside: outsideOf(n.x, n.y, n.radius),
    }))

    g.clearRect(0, 0, w, h)
    this.drawn = { cues: 0, edges: 0, unseen: 0, ownReach: 0 }

    // Your footsteps: the bus only carries them from 3.2 m up and while moving, so crouching draws nothing.
    const moving = Math.hypot(p.vx, p.vy) > 0.25 && p.noise >= 3.2
    const ownTarget = settings.soundCueOwnSteps && moving ? p.noise * k : 0
    const ownOutTarget = settings.soundCueOwnSteps && moving ? (outsideOf(p.x, p.y, p.noise) ?? p.noise * k) : 0
    springStep(this.ownReach, ownTarget > 0 ? ownTarget : this.ownReach.v, dt, 0.3)
    springStep(this.ownOutside, ownTarget > 0 ? ownOutTarget : this.ownOutside.v, dt, 0.3)
    springStep(this.ownAlpha, ownTarget > 0 ? 1 : 0, dt, ownTarget > 0 ? 0.3 : 0.45)
    if (this.ownAlpha.v > 0.01 && this.ownReach.v > 0.3) {
      const gy = supportHeight(town, p.x, p.y) + 0.04
      const a = this.ownAlpha.v * opacity * (p.noise > 7 ? 0.5 : 0.3)
      const indoorsMuffled = this.ownOutside.v < this.ownReach.v - 0.2
      this.ring(g, cam, w, h, p.x, p.y, gy, this.ownReach.v, INK, a * (indoorsMuffled ? 0.55 : 1), 1, [2, 5])
      if (indoorsMuffled && this.ownOutside.v > 0.3) this.ring(g, cam, w, h, p.x, p.y, gy, this.ownOutside.v, INK, a, 1.25)
      this.drawn.ownReach = Number(this.ownOutside.v.toFixed(2))
    }

    const listener = { x: p.x, y: p.y }
    for (const cue of this.model.cues) {
      const age = time - cue.born
      const f = cueFrame(age, cue.life, reduced)
      const a = f.alpha * opacity
      if (a <= 0.005) continue
      const col = cueColour(cue.source, cue.urgent)
      const gy = supportHeight(town, cue.x, cue.y) + 0.05
      const ringR = cue.outside ?? cue.reach
      const showReach = style !== SOUND_CUES_MARKS || cue.source === "self"
      const centre = cam.project(cue.x, gy, cue.y, w, h)
      // Off screen: an arrow at the edge, for noises the survivor would hear from here.
      const edge = centre.ok ? edgeAnchor(centre.x, centre.y, w, h, EDGE_INSET) : null
      if (edge || !centre.ok) {
        if (cue.source === "self") continue
        const dist = Math.hypot(cue.x - listener.x, cue.y - listener.y)
        const hears = cue.reach * 1.5 + 8
        if (dist > hears || !edge) continue
        const loud = 0.45 + 0.55 * (1 - dist / hears)
        this.edgeArrow(g, edge.x, edge.y, edge.angle, col, a * loud, settings.soundCueLabels ? cue.label : null, f.lift)
        this.drawn.edges++
        continue
      }
      if (showReach) {
        if (cue.outside !== null && cue.reach > ringR + 0.3) {
          // Made inside a building: the dashed ring is how far it carries indoors, the solid one what gets out.
          this.ring(g, cam, w, h, cue.x, cue.y, gy, cue.reach, col, a * 0.32, 1, [3, 5])
        }
        if (ringR > 0.3) {
          if (f.waveAlpha > 0.01) this.ring(g, cam, w, h, cue.x, cue.y, gy, Math.max(0.2, ringR * f.wave), col, f.waveAlpha * 0.55 * opacity, 2)
          this.ring(g, cam, w, h, cue.x, cue.y, gy, ringR, col, a * (cue.source === "self" ? 0.6 : 0.75), 1.25)
        }
      } else {
        this.pulse(g, centre.x, centre.y, col, a, age, reduced)
      }
      // The source: a small dot, and the label above it.
      g.fillStyle = rgba(col, a * 0.9)
      g.beginPath()
      g.arc(centre.x, centre.y, 2.5, 0, Math.PI * 2)
      g.fill()
      if (settings.soundCueLabels) {
        const metres = cue.outside === 0 ? "muffled" : ringR >= 1 ? `${Math.round(ringR)} m` : ""
        this.chip(g, centre.x, centre.y - 16 - f.lift, cue.label, metres, col, a)
      }
      this.drawn.cues++
    }

    if (settings.soundCueUnseen) this.drawUnseen(frame, g, town, listener, dt, opacity, reduced)
  }

  /** The dead out of sight within earshot: a soft three-arc mark opening towards you, near them and gliding. */
  private drawUnseen(
    frame: OutbreakClientFrameContext,
    g: CanvasRenderingContext2D,
    town: Town,
    listener: { x: number; y: number },
    dt: number,
    opacity: number,
    reduced: boolean,
  ): void {
    const { session, cam, w, h, vision } = frame
    const time = session.view.time
    const picks: { id: number; x: number; y: number; dist: number; urgent: boolean }[] = []
    for (const z of session.view.zombies) {
      if (z.state === "dead") continue
      const dist = Math.hypot(z.x - listener.x, z.y - listener.y)
      const urgent = z.state === "chase" || z.state === "bash" || z.state === "alert"
      const moving = urgent || Math.hypot(z.vx, z.vy) > 0.15 || z.state === "investigate" || z.state === "search"
      if (!moving || dist < 1 || dist > (urgent ? 18 : 12)) continue
      if (vision.actorVisible(z.x, z.y) > 0.05) continue
      picks.push({ id: z.id, x: z.x, y: z.y, dist, urgent })
    }
    picks.sort((a, b) => Number(b.urgent) - Number(a.urgent) || a.dist - b.dist)
    picks.length = Math.min(picks.length, 3)
    for (const m of this.unseen.values()) m.live = false
    for (const z of picks) {
      const bucket = Math.floor(time / 1.4)
      const [jx, jy] = jitteredSoundOrigin(z.id, z.x, z.y, bucket, 0.7 + Math.min(0.65, z.dist * 0.035))
      let m = this.unseen.get(z.id)
      if (!m) {
        m = { x: { v: jx, dv: 0 }, y: { v: jy, dv: 0 }, alpha: { v: 0, dv: 0 }, urgent: z.urgent, live: true, period: 1.6 }
        this.unseen.set(z.id, m)
      }
      m.live = true
      m.urgent = z.urgent
      m.period = z.urgent ? 1.1 : 1.6
      springStep(m.x, jx, dt, 0.45)
      springStep(m.y, jy, dt, 0.45)
    }
    for (const [id, m] of this.unseen) {
      springStep(m.alpha, m.live ? 1 : 0, dt, m.live ? 0.3 : 0.4)
      if (!m.live && m.alpha.v < 0.01) {
        this.unseen.delete(id)
        continue
      }
      const col = m.urgent ? DANGER : BONE
      const a = Math.max(0, Math.min(1, m.alpha.v)) * opacity * (m.urgent ? 0.8 : 0.55)
      const gy = supportHeight(town, m.x.v, m.y.v) + 0.4
      const c = cam.project(m.x.v, gy, m.y.v, w, h)
      if (!c.ok) continue
      const edge = edgeAnchor(c.x, c.y, w, h, EDGE_INSET)
      if (edge) {
        if (m.urgent) this.edgeArrow(g, edge.x, edge.y, edge.angle, col, a * 0.8, null, 0)
        continue
      }
      const me = cam.project(listener.x, gy, listener.y, w, h)
      const toward = Math.atan2(me.y - c.y, me.x - c.x)
      for (let i = 0; i < 3; i++) {
        const phase = reduced ? 1 : 0.5 + 0.5 * Math.sin((time / m.period) * Math.PI * 2 - i * 0.9 + id)
        g.strokeStyle = rgba(col, a * (0.35 + 0.65 * phase) * (1 - i * 0.22))
        g.lineWidth = 1.5
        g.lineCap = "round"
        g.beginPath()
        g.arc(c.x, c.y, 5 + i * 4.5, toward - 0.6, toward + 0.6)
        g.stroke()
      }
      this.drawn.unseen++
    }
  }

  /** A ground circle of `r` metres around (x, y), projected, with a dark halo under the line for the dark scene. */
  private ring(
    g: CanvasRenderingContext2D,
    cam: Camera,
    w: number,
    h: number,
    x: number,
    y: number,
    gy: number,
    r: number,
    col: Rgb,
    a: number,
    width: number,
    dash: number[] = [],
  ): void {
    if (a <= 0.005 || r <= 0.05) return
    const n = Math.max(28, Math.min(80, Math.round(r * 5)))
    g.beginPath()
    let started = false
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * Math.PI * 2
      const q = cam.project(x + Math.cos(t) * r, gy, y + Math.sin(t) * r, w, h)
      if (!q.ok) {
        started = false
        continue
      }
      if (!started) g.moveTo(q.x, q.y)
      else g.lineTo(q.x, q.y)
      started = true
    }
    g.setLineDash(dash)
    g.lineJoin = "round"
    g.strokeStyle = `rgba(0,0,0,${(a * 0.35).toFixed(3)})`
    g.lineWidth = width + 2.5
    g.stroke()
    g.strokeStyle = rgba(col, a)
    g.lineWidth = width
    g.stroke()
    g.setLineDash([])
  }

  /** Source marks style: two small rings pulsing out from the source, once. */
  private pulse(g: CanvasRenderingContext2D, x: number, y: number, col: Rgb, a: number, age: number, reduced: boolean): void {
    for (let i = 0; i < 2; i++) {
      const u = reduced ? 0.6 : Math.max(0, Math.min(1, (age - i * 0.18) / 0.7))
      if (u <= 0) continue
      const r = 4 + 16 * (1 - Math.pow(1 - u, 3))
      g.strokeStyle = rgba(col, a * (reduced ? 0.6 : 1 - u) * 0.9)
      g.lineWidth = 1.5
      g.beginPath()
      g.arc(x, y, r, 0, Math.PI * 2)
      g.stroke()
    }
  }

  /** A label chip on the HUD's dark surface: a coloured tick, the name, then the reach in the secondary ink. */
  private chip(g: CanvasRenderingContext2D, x: number, y: number, label: string, metres: string, col: Rgb, a: number): void {
    g.font = FONT
    const gap = metres ? 5 : 0
    const lw = g.measureText(label).width
    const mw = metres ? g.measureText(metres).width : 0
    const bw = Math.round(8 + 6 + lw + gap + mw + 8)
    const bh = 18
    const bx = Math.round(x - bw / 2)
    const by = Math.round(y - bh / 2)
    g.fillStyle = `rgba(13,12,11,${(0.78 * a).toFixed(3)})`
    g.beginPath()
    g.roundRect(bx, by, bw, bh, 6)
    g.fill()
    g.fillStyle = rgba(col, a)
    g.beginPath()
    g.arc(bx + 8 + 2, by + bh / 2, 2, 0, Math.PI * 2)
    g.fill()
    g.textBaseline = "middle"
    g.textAlign = "left"
    g.fillStyle = rgba(INK, a)
    g.fillText(label, bx + 8 + 6, by + bh / 2 + 0.5)
    if (metres) {
      g.fillStyle = rgba([182, 174, 159], a)
      g.fillText(metres, bx + 8 + 6 + lw + gap, by + bh / 2 + 0.5)
    }
  }

  /** A chevron at the screen edge pointing at an off-screen sound, with its name beside it. */
  private edgeArrow(g: CanvasRenderingContext2D, x: number, y: number, angle: number, col: Rgb, a: number, label: string | null, lift: number): void {
    if (a <= 0.005) return
    g.save()
    g.translate(x, y)
    g.rotate(angle)
    g.beginPath()
    g.moveTo(7, 0)
    g.lineTo(-5, -7)
    g.lineTo(-2, 0)
    g.lineTo(-5, 7)
    g.closePath()
    g.fillStyle = `rgba(0,0,0,${(a * 0.4).toFixed(3)})`
    g.lineWidth = 3
    g.strokeStyle = `rgba(0,0,0,${(a * 0.35).toFixed(3)})`
    g.stroke()
    g.fillStyle = rgba(col, a)
    g.fill()
    g.restore()
    if (label) {
      // The label sits on the inside of the arrow, towards the screen centre.
      const lx = x - Math.cos(angle) * 40
      const ly = y - Math.sin(angle) * 22 - lift
      this.chip(g, lx, ly, label, "", col, a)
    }
  }

  private surface(w: number, h: number): CanvasRenderingContext2D | null {
    if (typeof document === "undefined") return null
    if (!this.canvas) {
      const c = document.createElement("canvas")
      c.id = "sound-cues"
      c.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:4"
      document.body.appendChild(c)
      this.canvas = c
      this.g = c.getContext("2d")
    }
    this.canvas.hidden = false
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const cw = Math.round(w * dpr)
    const ch = Math.round(h * dpr)
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw
      this.canvas.height = ch
    }
    this.g?.setTransform(dpr, 0, 0, dpr, 0, 0)
    return this.g
  }
}

export type { SoundCue }
