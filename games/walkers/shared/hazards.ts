// Laser beams and cameras at a moment in time, and what touches them. Deterministic (fmath only).

import { sincos } from "./fmath"
import type { Level } from "./level"
import { segSegDist2, type Body } from "./physics"

export type Beam = {
  x1: number
  y1: number
  x2: number
  y2: number
  active: boolean
  /** 0..1 through a pulsing beam's cycle (0 when it just switched on); -1 for steady beams. */
  phase: number
  /** Seconds until a pulsing beam switches state; Infinity otherwise. */
  flip: number
  kind: "beam" | "sweep" | "grid"
}

export type Cone = { x: number; y: number; dx: number; dy: number; half: number; cosHalf: number; range: number; phase: number }

const sc: [number, number] = [0, 0]
const cs: [number, number] = [0, 0]
const cycle01 = (u: number) => u - Math.floor(u)

/** Every laser of the level at time t, written into out (reused). */
export function beamsAt(level: Level, t: number, platePressed: boolean, out: Beam[]): Beam[] {
  out.length = level.lasers.length
  level.lasers.forEach((l, i) => {
    const b = (out[i] ??= { x1: 0, y1: 0, x2: 0, y2: 0, active: true, phase: -1, flip: Infinity, kind: "beam" })
    if (l.kind === "beam") {
      b.x1 = l.x1; b.y1 = l.y1; b.x2 = l.x2; b.y2 = l.y2
      b.kind = l.grid ? "grid" : "beam"
      b.active = !(l.grid && platePressed)
      b.phase = -1
      b.flip = Infinity
      if (l.on !== undefined && l.off !== undefined) {
        const cycle = l.on + l.off
        const u = t + (l.offset ?? 0)
        const ph = u - cycle * Math.floor(u / cycle)
        b.active = ph < l.on
        b.phase = ph / cycle
        b.flip = b.active ? l.on - ph : cycle - ph
      }
    } else {
      sincos((6.283185307179586 * t) / l.period + l.phase, sc)
      const y = l.y + l.amp * sc[0]
      b.x1 = l.x1; b.y1 = y; b.x2 = l.x2; b.y2 = y
      b.kind = "sweep"
      b.active = true
      b.phase = cycle01(t / l.period)
      b.flip = Infinity
    }
  })
  return out
}

export function conesAt(level: Level, t: number, out: Cone[]): Cone[] {
  out.length = level.cameras.length
  level.cameras.forEach((c, i) => {
    sincos((6.283185307179586 * t) / c.period + c.phase, sc)
    const a = c.angle + c.amp * sc[0]
    const phase = cycle01(t / c.period)
    sincos(a, sc)
    sincos(c.half, cs)
    out[i] = { x: c.x, y: c.y, dx: sc[1], dy: sc[0], half: c.half, cosHalf: cs[1], range: c.range, phase }
  })
  return out
}

/** The core segment of a capsule (or the long axis of a box), for beam tests. */
function core(b: Body, out: number[]): number[] {
  const hl = b.kind === 0 ? b.hl : 0
  out[0] = b.x - b.c * hl
  out[1] = b.y - b.s * hl
  out[2] = b.x + b.c * hl
  out[3] = b.y + b.s * hl
  return out
}
const seg = [0, 0, 0, 0]

export type BeamContact = {
  /** Smallest clearance (m) between any active beam and any of the bodies; negative when touching. */
  clearance: number
  /** Bodies touching an active beam. */
  touching: number
  /** Sum over bodies of how close each is to its nearest active beam: 0 at NEAR or further, 1 touching it. */
  near: number
  /** Bit i set when beam i is touched. */
  mask: number
}

/** Clearance (m) inside which a body starts to count as close to a beam. */
export const NEAR = 0.04

/** How close bodies[0..n) are to the active beams, and which beams they touch. */
export function beamContact(beams: readonly Beam[], bodies: readonly Body[], n: number, out: BeamContact): BeamContact {
  out.clearance = Infinity
  out.touching = 0
  out.near = 0
  out.mask = 0
  for (let k = 0; k < n; k++) {
    const b = bodies[k]!
    core(b, seg)
    let hit = false
    let closest = Infinity
    for (let i = 0; i < beams.length; i++) {
      const bm = beams[i]!
      if (!bm.active) continue
      const d = Math.sqrt(segSegDist2(bm.x1, bm.y1, bm.x2, bm.y2, seg[0]!, seg[1]!, seg[2]!, seg[3]!)) - b.r
      if (d < out.clearance) out.clearance = d
      if (d < closest) closest = d
      if (d < 0) {
        hit = true
        out.mask |= 1 << i
      }
    }
    if (hit) out.touching++
    if (closest < NEAR) out.near += Math.min(1, 1 - closest / NEAR)
  }
  return out
}

/** Whether point (px, py) is inside a camera's cone. */
export function inCone(c: Cone, px: number, py: number): boolean {
  const vx = px - c.x, vy = py - c.y
  const d2 = vx * vx + vy * vy
  if (d2 > c.range * c.range) return false
  const d = Math.sqrt(d2)
  return vx * c.dx + vy * c.dy >= c.cosHalf * d
}
