import type { LabControl } from "@arcade/kit/lab-panel"
import type { PeekInfo } from "../shared/interact"

/**
 * Peeking through a window or a door's peephole, as the camera and sight see it (AR-67). Smooth: one eased blend
 * carries the camera's lean, the sight's eye, its aim, its cone and the roof cut together, both ways, so nothing
 * snaps; the aim turns to the window instead of jumping. Today: the old linear 0.15 s blend whose aim snapped at once.
 */
export const DEFAULT_PEEK_VIEW = {
  /** 1 Smooth (default), 0 Today. */
  peekStyle: 1,
  /** Seconds to settle into a peek (leaving takes 0.8 of it). */
  peekTime: 0.32,
  /** How far the camera leans towards the opening, in metres. */
  peekLean: 1.45,
}

export type PeekViewSettings = typeof DEFAULT_PEEK_VIEW

export const peekViewControls: LabControl[] = [
  {
    key: "peekStyle",
    label: "Peek",
    group: "Peek",
    options: [
      { label: "Smooth", value: 1 },
      { label: "Today (snap)", value: 0 },
    ],
  },
  { key: "peekTime", label: "Peek ease", group: "Peek", min: 0.1, max: 0.8, step: 0.02, unit: "s" },
  { key: "peekLean", label: "Camera lean", group: "Peek", min: 0, max: 3, step: 0.05, unit: "m" },
]

/** Shortest-way blend between two angles. */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  return a + d * t
}

/** Ease in and out with zero speed at both ends (smootherstep). */
export const peekEase = (t: number) => {
  const u = Math.max(0, Math.min(1, t))
  return u * u * u * (u * (u * 6 - 15) + 10)
}

export type PeekSight = { x: number; y: number; aim: number; cone: number; awareness: number }

/** The peek blend for the frame renderer: progress, the peek it is easing to or from, and where sight looks from. */
export class PeekView {
  /** Linear progress 0..1 (Smooth) or the old linear blend (Today). */
  progress = 0
  /** Eased 0..1 every consumer reads. */
  blend = 0
  private last: PeekInfo | null = null

  reset(): void {
    this.progress = 0
    this.blend = 0
    this.last = null
  }

  step(dt: number, peek: PeekInfo | null, s: PeekViewSettings): PeekInfo | null {
    if (peek) this.last = peek
    if ((s.peekStyle ?? 1) === 0) {
      this.progress = peek ? Math.min(1, this.progress + dt * 6.5) : Math.max(0, this.progress - dt * 5.5)
      this.blend = this.progress
    } else {
      const time = Math.max(0.05, s.peekTime ?? DEFAULT_PEEK_VIEW.peekTime)
      this.progress = peek ? Math.min(1, this.progress + dt / time) : Math.max(0, this.progress - dt / (time * 0.8))
      this.blend = peekEase(this.progress)
    }
    if (!peek && this.blend <= 0.001) this.last = null
    return peek ?? (this.blend > 0.001 ? this.last : null)
  }

  /** Camera lean for the active peek, in plan metres. */
  lean(active: PeekInfo | null, s: PeekViewSettings): { x: number; y: number } {
    if (!active) return { x: 0, y: 0 }
    const scale = (s.peekStyle ?? 1) === 0 ? 1 : (s.peekLean ?? DEFAULT_PEEK_VIEW.peekLean) / 1.45
    return { x: active.camOffsetX * this.blend * scale, y: active.camOffsetY * this.blend * scale }
  }

  /**
   * Where sight looks from this frame: the body, easing to the peek's eye with the aim turning the short way round
   * and the cone and awareness widening. A peephole's eye is past a shut door, so the eye crosses at the midpoint
   * instead of passing through the door.
   */
  sight(
    active: PeekInfo | null,
    current: PeekInfo | null,
    body: { x: number; y: number },
    bodyAim: number,
    base: { cone: number; awareness: number },
    s: PeekViewSettings,
  ): PeekSight {
    if (!active) return { x: body.x, y: body.y, aim: bodyAim, cone: base.cone, awareness: base.awareness }
    const b = this.blend
    const cone = base.cone + (Math.max(base.cone, active.cone) - base.cone) * b
    const awareness = base.awareness + (Math.max(base.awareness, active.awareness) - base.awareness) * b
    if ((s.peekStyle ?? 1) === 0) {
      return {
        x: body.x + (active.eyeX - body.x) * b,
        y: body.y + (active.eyeY - body.y) * b,
        aim: current ? current.aim : bodyAim,
        cone,
        awareness,
      }
    }
    const e = active.peephole ? (b >= 0.5 ? 1 : 0) : b
    return {
      x: body.x + (active.eyeX - body.x) * e,
      y: body.y + (active.eyeY - body.y) * e,
      aim: lerpAngle(bodyAim, active.aim, b),
      cone,
      awareness,
    }
  }
}

/** The sight above as a `PeekInfo` for `Vision.update` (which takes the eye, aim, cone and awareness from it). */
export function sightAsPeek(active: PeekInfo, sight: PeekSight): PeekInfo {
  return { ...active, eyeX: sight.x, eyeY: sight.y, aim: sight.aim, cone: sight.cone, awareness: sight.awareness }
}
