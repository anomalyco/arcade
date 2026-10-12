import { LIT_THRESHOLD } from "../config"
import { type Rect, clearLine } from "../geom"

export type LightKind = "lamp" | "flare"

/** A light source. `power` is the current output (flares ramp up and down); `on` is false when it's dark. */
export type Light = {
  id: number
  kind: LightKind
  x: number
  y: number
  radius: number
  power: number
  color: readonly [number, number, number]
  on: boolean
}

/** Inverse-square-ish falloff used by both the server rules and the GPU lighting. */
export function falloff(d: number, radius: number): number {
  if (d >= radius) return 0
  const k = 1 - d / radius
  return k * k
}

/** Intensity a light delivers to a point, ignoring occlusion. */
export function intensityAt(l: Light, x: number, y: number): number {
  if (!l.on || l.power <= 0) return 0
  return l.power * falloff(Math.hypot(x - l.x, y - l.y), l.radius)
}

/** Strongest light reaching (x, y) through unobstructed line of sight. */
export function lightAt(x: number, y: number, lights: readonly Light[], walls: readonly Rect[]): number {
  let best = 0
  for (const l of lights) {
    const i = intensityAt(l, x, y)
    if (i <= best) continue
    if (clearLine(l.x, l.y, x, y, walls)) best = i
  }
  return best
}

export function isLit(x: number, y: number, lights: readonly Light[], walls: readonly Rect[]): boolean {
  return lightAt(x, y, lights, walls) >= LIT_THRESHOLD
}
