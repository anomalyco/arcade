import { PLAYER_RADIUS } from "../../shared/config"
import { COVER, type Cover, type CoverBody, type CoverGeo, cornerOf, facing, findCover } from "../../shared/sim/cover"
import type { Intent } from "../../shared/sim/world"

/** What Space does now: take the surface ahead, hop to another one, or leave the one you're on. */
export type CoverHint = { kind: "take" | "hop" | "leave"; c: Cover; corner: boolean }

export function coverHint(geo: CoverGeo, b: CoverBody, i: Intent): CoverHint | null {
  if (b.cover) {
    if (b.cover.enter > 0) return null
    const next = findCover(geo, b, i.aim, COVER.hop, b.cover)
    const corner = cornerOf(b.cover, b.x, b.y) !== 0
    return next ? { kind: "hop", c: next, corner } : { kind: "leave", c: b.cover, corner }
  }
  const c = findCover(geo, b, facing(i))
  return c ? { kind: "take", c, corner: false } : null
}

/** In cover at a corner, the view slides around it; further while you lean out. */
export function coverLook(b: CoverBody): { x: number; y: number } {
  const c = b.cover
  if (!c) return { x: 0, y: 0 }
  const side = cornerOf(c, b.x, b.y)
  if (!side) return { x: 0, y: 0 }
  const k = c.peek ? 1.6 : 1
  const tx = -c.ny * side
  const ty = c.nx * side
  return { x: (tx * 2.4 - c.nx * 1.4) * k, y: (ty * 2.4 - c.ny * 1.4) * k }
}

type Streak = (x: number, y: number, z: number, size: number, r: number, g: number, b: number, a: number, kind: number, rot: number, stretch: number) => void

/**
 * A faint line along the surface Space would take (pulsing) or the one you're on, and glints at the corners you can
 * lean around.
 */
export function coverMarks(hint: CoverHint | null, b: CoverBody, t: number, put: Streak): void {
  const c = hint?.c
  if (!c) return
  const line = PLAYER_RADIUS + COVER.gap
  const tx = -c.ny
  const ty = c.nx
  const lo = Math.min(c.lo, c.loPeek) - (c.loPeek < c.lo ? 0 : 0.2)
  const hi = Math.max(c.hi, c.hiPeek) + (c.hiPeek > c.hi ? 0 : 0.2)
  const mid = (lo + hi) / 2
  const half = Math.max(0.1, (hi - lo) / 2)
  const fx = c.ox - c.nx * (line - 0.04)
  const fy = c.oy - c.ny * (line - 0.04)
  const z = c.low ? 0.06 : 0.04
  const on = hint.kind === "leave"
  const a = on ? 0.16 : 0.26 + 0.14 * Math.sin(t * 6)
  put(fx + tx * mid, z, fy + ty * mid, half, 0.55, 0.8, 1, a, 4, Math.atan2(ty, tx), 0.035 / half)
  if (!on || !b.cover) return
  const ends: [number, boolean][] = [
    [c.lo - COVER.inset, c.loPeek < c.lo],
    [c.hi + COVER.inset, c.hiPeek > c.hi],
  ]
  for (const [s, corner] of ends) if (corner) put(fx + tx * s, z, fy + ty * s, 0.09, 0.6, 0.85, 1, 0.5, 0, 0, 0)
}
