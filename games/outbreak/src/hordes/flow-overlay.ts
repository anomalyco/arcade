import { SPRITE_FLOATS } from "@arcade/kit/gpu/renderer"
import { FLOW_UNREACHED, type FlowField } from "@arcade/kit/sim/flow-field"
import type { CoopSim } from "../../shared/coop-sim"

/** The field most recently read by the crowd (what the horde is following right now). */
function busiestField(sim: CoopSim): FlowField | null {
  let best: FlowField | null = null
  for (const f of sim.ai.flow.activeFields()) if (!best || f.lastUsed > best.lastUsed) best = f
  return best
}

const dir = { x: 0, y: 0 }

/**
 * Downhill direction at `(x, y)` from the cost gradient over ±`r` metres (smooth, unlike the octile next-cell step),
 * falling back to the next cell where a neighbour is unreachable. False where the field has no way down.
 */
function flowDirection(field: FlowField, x: number, y: number, r: number): boolean {
  const e = field.costAt(x + r, y)
  const w = field.costAt(x - r, y)
  const s = field.costAt(x, y + r)
  const n = field.costAt(x, y - r)
  if (e !== FLOW_UNREACHED && w !== FLOW_UNREACHED && s !== FLOW_UNREACHED && n !== FLOW_UNREACHED) {
    const gx = w - e
    const gy = n - s
    const len = Math.hypot(gx, gy)
    if (len > 0) {
      dir.x = gx / len
      dir.y = gy / len
      return true
    }
  }
  field.direction(x, y, dir)
  return dir.x !== 0 || dir.y !== 0
}

/**
 * Appends the flow-field overlay for the field the crowd read most recently: an arrow per sample point around
 * `(cx, cy)` pointing downhill, cyan near the goal and violet far from it. Returns the new alpha sprite count.
 */
export function renderFlowOverlay(
  sim: CoopSim,
  cx: number,
  cy: number,
  support: (x: number, z: number) => number,
  sprites: Float32Array,
  start: number,
  budget = 540,
): number {
  const field = busiestField(sim)
  if (!field) return start
  const max = Math.min(Math.floor(sprites.length / SPRITE_FLOATS), start + budget) - 3
  const half = 24
  // Three sprites per arrow: shaft and two barbs.
  const spacing = (2 * half) / Math.sqrt(budget / 3)
  const len = spacing * 0.36
  let count = start
  const line = (x: number, y: number, gy: number, size: number, rot: number, u: number, a: number) => {
    const o = count++ * SPRITE_FLOATS
    sprites[o] = x
    sprites[o + 1] = gy
    sprites[o + 2] = y
    sprites[o + 3] = size
    sprites[o + 4] = 0.3 + 0.45 * u
    sprites[o + 5] = 0.9 - 0.6 * u
    sprites[o + 6] = 1
    sprites[o + 7] = a
    sprites[o + 8] = 4
    sprites[o + 9] = rot
    sprites[o + 10] = 0.12 * (spacing * 0.36) / size
    sprites[o + 11] = 0
  }
  for (let y = cy - half; y <= cy + half && count < max; y += spacing) {
    for (let x = cx - half; x <= cx + half && count < max; x += spacing) {
      const c = field.costAt(x, y)
      if (c === FLOW_UNREACHED || !flowDirection(field, x, y, 1)) continue
      const u = Math.min(1, c / 900)
      const gy = support(x, y) + 0.06
      const ang = Math.atan2(dir.y, dir.x)
      line(x, y, gy, len, ang, u, 0.5)
      const tipX = x + dir.x * len
      const tipY = y + dir.y * len
      for (const side of [2.5, -2.5]) {
        const barb = ang + side
        line(tipX + Math.cos(barb) * len * 0.22, tipY + Math.sin(barb) * len * 0.22, gy, len * 0.22, barb, u, 0.5)
      }
    }
  }
  return count
}
