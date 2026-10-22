/**
 * The Attaché Case opening and closing (AR-94, after Kit's "this doesn't transition in and out"). One progress value
 * `p` (0 shut, 1 open) on a zero-bounce spring drives everything, so Tab spam just retargets it and keeps its
 * position and velocity:
 *
 * - open, .28 s: the case winds up (dips 2.5 px and compresses 2% over 80 ms), then rises 14 px out of the dock while it
 *   grows from .95; the lid swings up on its hinge from edge-on, a beat behind; the world dims; the pieces (quick slots,
 *   then the case in reading order, then the crate) fade and lift 6 px in, staggered by `--d`.
 * - close, .15 s: the same values back down, quicker; the pieces leave last-in first-out.
 * - reduced motion: a .16 s fade, no travel, no lid, no stagger.
 *
 * Springs follow Kit's palette: ω = 2π / duration, ζ = 1 − bounce (0). `tests/inventory-motion.test.ts` traces
 * every frame for jumps.
 */

export const CASE_OPEN_S = 0.28
export const CASE_CLOSE_S = 0.15
export const CASE_REDUCED_S = 0.16
/** The wind-up before the case rises. */
export const CASE_WINDUP_S = 0.08
/** Progress a piece needs, past its delay, to be fully in. */
export const PIECE_SPAN = 0.4

export type CaseMotion = {
  /** Progress, 0 shut to 1 open. */
  p: number
  /** Its velocity, per second. */
  v: number
  target: 0 | 1
  /** Seconds since an open began from shut (drives the wind-up); large otherwise. */
  sinceOpen: number
}

export type CaseStyle = {
  /** How dark the world behind gets, 0..1. */
  dim: number
  opacity: number
  scale: number
  /** Vertical squash during the wind-up (multiplies `scale` on y). */
  squash: number
  /** Pixels below its resting place. */
  y: number
  /** The lid's swing about its hinge, degrees (0 open, −80 edge-on). */
  lid: number
  /** What the pieces' stagger reads (`--inv-p`). */
  pieces: number
}

export const SHUT: CaseMotion = { p: 0, v: 0, target: 0, sinceOpen: 99 }

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

/** Advances the case's motion by `dt` toward `target`, exactly (a critically damped spring has a closed form). */
export function stepCaseMotion(m: CaseMotion, target: 0 | 1, dt: number, reduced: boolean): CaseMotion {
  const opening = target === 1 && m.target === 0 && m.p < 0.05
  const sinceOpen = (opening ? 0 : m.sinceOpen) + dt
  if (reduced) {
    const step = dt / CASE_REDUCED_S
    const p = target > m.p ? Math.min(target, m.p + step) : Math.max(target, m.p - step)
    return { p, v: 0, target, sinceOpen }
  }
  const w = (2 * Math.PI) / (target === 1 ? CASE_OPEN_S : CASE_CLOSE_S)
  const e0 = m.p - target
  const k = Math.exp(-w * dt)
  const b = m.v + w * e0
  let e = (e0 + b * dt) * k
  let v = (m.v - w * b * dt) * k
  if (Math.abs(e) < 5e-4 && Math.abs(v) < 5e-3) {
    e = 0
    v = 0
  }
  return { p: target + e, v, target, sinceOpen }
}

/** Whether the case is all the way shut and still (it can leave the page). */
export const caseShut = (m: CaseMotion) => m.target === 0 && m.p <= 1e-3

/** What the progress looks like this frame. */
export function caseStyle(m: CaseMotion, reduced: boolean): CaseStyle {
  const p = clamp01(m.p)
  if (reduced) return { dim: p, opacity: p, scale: 1, squash: 1, y: 0, lid: 0, pieces: 1 }
  // The wind-up always plays out its 80 ms (a Tab back mid-way doesn't cut it off in one frame).
  const windup = m.sinceOpen < CASE_WINDUP_S ? Math.sin((Math.PI * m.sinceOpen) / CASE_WINDUP_S) : 0
  const lid = clamp01((p - 0.1) / 0.9)
  return {
    dim: p,
    opacity: clamp01(p / 0.7),
    scale: 0.95 + 0.05 * p,
    squash: 1 - 0.02 * windup,
    y: (1 - p) * 14 + 2.5 * windup,
    lid: lid >= 1 ? 0 : -80 * (1 - lid),
    pieces: p,
  }
}

/** How far in a piece with delay `d` is (the CSS in `inventory.css` computes the same from `--inv-p`). */
export const pieceAt = (pieces: number, d: number) => clamp01((pieces - d) / PIECE_SPAN)
