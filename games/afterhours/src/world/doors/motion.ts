import type { DoorSound } from "./audio"

// Door motion: heavy, eased travel instead of a spring. Every command plans a quintic Hermite curve from the leaf's
// current position and velocity to the target, with zero acceleration at both ends, so a door at rest eases in
// (after a short hesitation while the latch or a gate's chain releases), travels slowly, and decelerates into the open
// stop without any bounce. Closing ends at a low, non-zero "latch speed" instead of zero: the leaf slows near the
// frame like a door closer, then the latch catches. Pressing E mid-swing re-plans from the current velocity, so the
// leaf brakes and turns round smoothly. Roll-up doors add a ratchet: travel lags and then catches once per tooth.

export type MotionKind = "swing" | "gate" | "rollup" | "slide"

export type Profile = {
  kind: MotionKind
  /** Seconds for a full 0 → 1 travel at speed 1 (excluding the hesitation). */
  duration: number
  /** Pause before a door at rest starts moving (latch release / chain coming off), seconds. */
  hesitate: number
  /** Closing arrival speed at the frame, as a fraction of the average full-travel speed. */
  latchSpeed: number
  /** Ratchet teeth over the full travel (0: smooth). */
  teeth: number
}

/** Typical full-travel times by leaf material: veneer and glass light, steel fire doors heavy, gates very heavy. */
const BASE: Record<DoorSound, number> = { wood: 1.55, glass: 1.5, steel: 1.95, gate: 3.6 }

export function profileFor(sound: DoorSound, slide: { axis: readonly [number, number, number] } | undefined, mass = 1, duration?: number): Profile {
  const rollup = !!slide && Math.abs(slide.axis[1]) > 0.7
  const kind: MotionKind = rollup ? "rollup" : slide ? "slide" : sound === "gate" ? "gate" : "swing"
  const base = rollup ? 3.0 : slide ? Math.max(2.0, BASE[sound]) : BASE[sound]
  return {
    kind,
    duration: duration ?? base * Math.sqrt(Math.max(0.1, mass)),
    hesitate: kind === "gate" ? 0.38 : kind === "rollup" ? 0.3 : 0.15,
    latchSpeed: kind === "gate" ? 0.3 : kind === "rollup" ? 0.4 : 0.45,
    teeth: rollup ? 16 : 0,
  }
}

type Plan = { from: number; to: number; m0: number; m1: number; T: number; e: number }
export type MotionState = { t: number; v: number; hold: number; plan: Plan | null }

/** Quintic Hermite with zero end accelerations; `m0`, `m1` are end slopes per unit `u`. */
function hermite(p: Plan, u: number) {
  const u3 = u * u * u
  const u4 = u3 * u
  const u5 = u4 * u
  return (
    p.from * (1 - 10 * u3 + 15 * u4 - 6 * u5) +
    p.m0 * (u - 6 * u3 + 8 * u4 - 3 * u5) +
    p.m1 * (-4 * u3 + 7 * u4 - 3 * u5) +
    p.to * (10 * u3 - 15 * u4 + 6 * u5)
  )
}

/** Ratchet: progress lags through most of each tooth, then catches up quickly. Monotonic. */
function ratchet(c: number, teeth: number) {
  const f = (((c * teeth) % 1) + 1) % 1
  const g = f < 0.8 ? f / 0.8 : 1 - (f - 0.8) / 0.2
  return c - (0.6 * g) / teeth
}

/**
 * Advances `h` seconds towards `target` at global `speed`; returns the new open fraction (exactly `target` on
 * arrival) and updates `s.v`. Doesn't commit `s.t`: the caller may veto the move (leaf hitting the player) and then
 * clears `s.plan` so it re-plans from rest.
 */
export function stepMotion(s: MotionState, p: Profile, target: number, speed: number, h: number): number {
  if (s.hold > 0) {
    s.hold -= h
    s.v = 0
    return s.t
  }
  let plan = s.plan
  if (!plan || plan.to !== target) {
    const dist = Math.abs(target - s.t)
    if (dist < 1e-5) {
      s.v = 0
      s.plan = null
      return target
    }
    const T = p.duration * (0.3 + 0.7 * Math.sqrt(dist))
    const closing = target < s.t
    const v1 = closing && target <= 0 ? -p.latchSpeed / p.duration : 0
    plan = s.plan = { from: s.t, to: target, m0: s.v * T, m1: v1 * T, T, e: 0 }
  }
  plan.e += h * Math.max(0.05, speed)
  const u = Math.min(1, plan.e / plan.T)
  let t = hermite(plan, u)
  if (p.teeth) t = ratchet(t, p.teeth)
  t = Math.max(0, Math.min(1, t))
  if (u >= 1) {
    t = target
    // Keep the arrival velocity for the latch sound; the caller zeroes it.
    s.v = plan.m1 / plan.T
    s.plan = null
    return t
  }
  s.v = (t - s.t) / h
  return t
}
