/**
 * Where character-anchored HUD sits relative to a survivor on screen, and how it steps out of the way of the aim.
 *
 * A placement is a screen direction from the survivor's body. When the survivor aims into that direction (and so
 * lights it with the flashlight's near field), the HUD swaps to the opposite side, with hysteresis so a mouse held
 * near the boundary does not flicker it. Alignment is blended continuously so a swap slides instead of popping.
 */

export type Side = "up" | "down" | "left" | "right"

/** Lab values for `calloutPlacement`. */
export const CALLOUTS_STYLE = -1
export const CALLOUTS_BELOW = 0
export const CALLOUTS_ABOVE = 1
export const CALLOUTS_BESIDE = 2

/** Lab values for `vitalsPlacement`: how stamina, reload, health and battery are drawn. */
export const VITALS_STYLE = -1
export const VITALS_BESIDE = 0
export const VITALS_FEET = 1
export const VITALS_EDGE = 2
export const VITALS_BARS = 3
export const VITALS_GROUND = 4
export const VITALS_ICONS = 5

export const OPPOSITE: Record<Side, Side> = { up: "down", down: "up", left: "right", right: "left" }
const VECTOR: Record<Side, readonly [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }

/** Degrees between the aim and a side at which the HUD leaves that side, and the angle at which it may return. */
export const AVOID_ENTER = 55
export const AVOID_EXIT = 68

/**
 * Picks the side to use this frame. `aim` is the survivor's aim as a screen-space vector (any length; zero means
 * unknown). `current` is last frame's choice, used for hysteresis.
 */
export function chooseSide(preferred: Side, aim: { x: number; y: number }, current: Side | null, avoid = true): Side {
  if (!avoid) return preferred
  const len = Math.hypot(aim.x, aim.y)
  if (len < 1e-6) return current ?? preferred
  const [px, py] = VECTOR[preferred]
  const cos = (aim.x * px + aim.y * py) / len
  const flipped = current === OPPOSITE[preferred]
  const limit = Math.cos(((flipped ? AVOID_EXIT : AVOID_ENTER) * Math.PI) / 180)
  return cos > limit ? OPPOSITE[preferred] : preferred
}

/**
 * Continuous alignment for a side: `ax`/`ay` are the element's own-size translate fractions (0 = anchor at its
 * left/top edge, -1 = right/bottom edge) and `sy` the direction a callout stack grows in rows. Stacks beside the
 * body grow downward from shoulder height.
 */
export type Align = { ax: number; ay: number; sy: number }

export function alignFor(side: Side): Align {
  switch (side) {
    case "up":
      return { ax: -0.5, ay: -1, sy: -1 }
    case "down":
      return { ax: -0.5, ay: 0, sy: 1 }
    case "right":
      return { ax: 0, ay: -0.5, sy: 1 }
    case "left":
      return { ax: -1, ay: -0.5, sy: 1 }
  }
}

/**
 * Per-actor smoothed side: the alignment and the anchor's offset from the body centre both ease toward the chosen
 * side, so a swap slides around the survivor instead of jumping.
 */
export class SideBlend {
  side: Side | null = null
  readonly align: Align = { ax: -0.5, ay: -1, sy: -1 }
  private ox = 0
  private oy = 0
  private ready = false

  /** Eases toward `side` and returns the anchor point. `rate` is per second; reduced motion snaps. */
  step(box: BodyBox, side: Side, gap: number, dt: number, reducedMotion: boolean, rate = 14): { x: number; y: number } {
    this.side = side
    const target = alignFor(side)
    const edge = edgePoint(box, side, gap)
    const k = !this.ready || reducedMotion ? 1 : 1 - Math.exp(-Math.max(0, dt) * rate)
    this.ready = true
    const a = this.align
    a.ax += (target.ax - a.ax) * k
    a.ay += (target.ay - a.ay) * k
    a.sy += (target.sy - a.sy) * k
    this.ox += (edge.x - box.x - this.ox) * k
    this.oy += (edge.y - box.mid - this.oy) * k
    return { x: box.x + this.ox, y: box.mid + this.oy }
  }
}

/** Screen-space footprint of a survivor: the edges of its body box and its aim, in CSS pixels. */
export type BodyBox = {
  /** Centre x of the body. */
  x: number
  /** Screen y of the top of the head. */
  top: number
  /** Screen y of the lowest point of the feet circle (screen-below the feet under the tilted camera). */
  bottom: number
  /** Body half-width on screen. */
  half: number
  /** Screen y of the body's middle. */
  mid: number
  /** Aim as a screen vector (unnormalised). */
  aimX: number
  aimY: number
  /** Screen centre and size of a ~0.5 m circle on the ground around the feet, for ground-drawn meters. */
  footX?: number
  footY?: number
  footW?: number
  footH?: number
}

/** The point on the body box edge facing `side`, pushed out by `gap` pixels. */
export function edgePoint(box: BodyBox, side: Side, gap: number): { x: number; y: number } {
  switch (side) {
    case "up":
      return { x: box.x, y: box.top - gap }
    case "down":
      return { x: box.x, y: box.bottom + gap }
    case "right":
      return { x: box.x + box.half + gap, y: box.mid }
    case "left":
      return { x: box.x - box.half - gap, y: box.mid }
  }
}
