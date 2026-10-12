import { FLARE_POWER, FLARE_RADIUS, LAMP_FAIL_SECONDS, LIT_THRESHOLD } from "../config"
import { type Rect, clearLine } from "../geom"
import { hash2 } from "../rng"

export type LightKind = "desk" | "panel" | "pendant" | "exit" | "moon" | "vending" | "server" | "flood" | "bulb"

/** A map light. `h` is its height for 3D shading only; the rules work on the floor plan. */
export type LightDef = {
  id: number
  kind: LightKind
  x: number
  y: number
  h: number
  r: number
  power: number
  color: readonly [number, number, number]
  /** Spot lights: floor-plan direction and the cosine of the half-angle. */
  cone?: readonly [number, number, number]
  shootable: boolean
  /** Lights on the same breaker switch together. */
  group?: string
  /** 0 steady, 1 an occasional dip, 2 a bad tube. */
  flicker?: 0 | 1 | 2
}

/** What changes about a map light during a round. */
export type LampState = { broken: boolean; off: boolean; dimUntil: number; failAt: number }

/** A light as the rules see it at one instant. */
export type Light = { x: number; y: number; r: number; power: number; cone?: readonly [number, number, number] }

/** Deterministic flicker shared by the server rules and the client renderer, so a dip hides you on both. */
export function flicker(id: number, level: number, t: number): number {
  if (level === 1) return hash2(id * 31 + 1, Math.floor(t * 8)) < 0.035 ? 0.3 : 1
  if (level === 2) {
    if (hash2(id * 17 + 2, Math.floor(t / 2.5)) >= 0.55) return 1
    return hash2(id * 7 + 3, Math.floor(t * 15)) < 0.4 ? 0.08 : 1
  }
  return 1
}

/** Output of a map light at time t, 0 when dark. Failing lamps stutter for LAMP_FAIL_SECONDS before going out. */
export function lampPower(def: LightDef, s: LampState, t: number): number {
  if (s.broken || s.off || t < s.dimUntil) return 0
  let p = def.power * flicker(def.id, def.flicker ?? 0, t)
  if (s.failAt > 0) {
    const k = 1 - Math.max(0, s.failAt - t) / LAMP_FAIL_SECONDS
    if (hash2(def.id * 3 + 4, Math.floor(t * 20)) < 0.25 + 0.6 * k) p *= 0.05
  }
  return p
}

/** Flares land, flare up over 0.4 s, burn, and fade over their last 2 s. */
export function flarePower(t: number, landAt: number, endAt: number): number {
  if (t < landAt || t >= endAt) return 0
  const up = Math.min(1, (t - landAt) / 0.4)
  const down = Math.min(1, (endAt - t) / 2)
  const sputter = 0.9 + 0.1 * Math.sin(t * 23 + landAt * 7)
  return FLARE_POWER * up * down * sputter
}

export const FLARE_COLOR = [1, 0.22, 0.14] as const
export const flareLight = (x: number, y: number, power: number): Light => ({ x, y, r: FLARE_RADIUS, power })

export function falloff(d: number, r: number): number {
  if (d >= r) return 0
  const k = 1 - d / r
  return k * k
}

export function coneFactor(cone: readonly [number, number, number] | undefined, dx: number, dy: number, d: number): number {
  if (!cone || d < 1e-6) return 1
  const c = (dx * cone[0] + dy * cone[1]) / d
  const t = Math.max(0, Math.min(1, (c - cone[2]) / 0.08))
  return t * t * (3 - 2 * t)
}

/** Light delivered to (x, y) ignoring walls. The shader computes the same expression. */
export function intensityAt(l: Light, x: number, y: number): number {
  if (l.power <= 0) return 0
  const dx = x - l.x
  const dy = y - l.y
  const d = Math.hypot(dx, dy)
  return l.power * falloff(d, l.r) * coneFactor(l.cone, dx, dy, d)
}

/** Strongest light reaching (x, y) through a clear line. */
export function lightAt(x: number, y: number, lights: readonly Light[], occluders: readonly Rect[]): number {
  let best = 0
  for (const l of lights) {
    const i = intensityAt(l, x, y)
    if (i > best && clearLine(l.x, l.y, x, y, occluders)) best = i
  }
  return best
}

export const isLit = (x: number, y: number, lights: readonly Light[], occluders: readonly Rect[]) => lightAt(x, y, lights, occluders) >= LIT_THRESHOLD
