import { SPRITE_FLOATS } from "@arcade/kit/gpu/renderer"
import { LIGHT_FLOATS } from "@arcade/kit/limits"

/** Distance (m) over which the torch's falloff is softened, like the scene's `beamNearSoftening`. */
const NEAR_SOFTENING = 6

/**
 * How strongly the survivors' torches light a point, read from the frame's packed light slots (the local beam and the
 * co-op beams, slots `from..to`). Plan cone with a soft edge, a softened inverse square and a fade over the last
 * quarter of the range; walls are not traced (callers gate on sight, and anything behind a roof is hidden by depth).
 * The life touches use it so a moth, a fly or a pair of eyes is only seen where a torch actually finds it.
 */
export class BeamProbe {
  private lights: Float32Array = new Float32Array(0)
  private from = 0
  private to = 0
  /** Colour of the light at the last `at` call (the strongest beam's tint), for tinting sprites. */
  readonly colour: [number, number, number] = [1, 0.86, 0.68]

  set(lights: Float32Array, from: number, to: number): void {
    this.lights = lights
    this.from = Math.max(0, from)
    this.to = Math.max(this.from, to)
  }

  /** 0..~1.2: torchlight at (x, y, z); y is height, z the plan's second axis. */
  at(x: number, _y: number, z: number): number {
    let best = 0
    let sum = 0
    const L = this.lights
    for (let i = this.from; i < this.to; i++) {
      const k = i * LIGHT_FLOATS
      const power = L[k + 7]!
      const range = L[k + 3]!
      if (power <= 0.001 || range <= 0.1) continue
      const dx = x - L[k]!
      const dz = z - L[k + 2]!
      const d = Math.hypot(dx, dz)
      if (d > range) continue
      const cosA = d < 0.05 ? 1 : (dx * L[k + 8]! + dz * L[k + 9]!) / d
      const cosHalf = L[k + 10]!
      const edge = smoothstep(cosHalf - 0.015, cosHalf + 0.035, cosA)
      if (edge <= 0) continue
      const fall = (1 / (1 + (d / NEAR_SOFTENING) ** 2)) * (1 - smoothstep(range * 0.75, range, d))
      const v = edge * fall * Math.min(1.5, power)
      sum += v
      if (v > best) {
        best = v
        this.colour[0] = L[k + 4]!
        this.colour[1] = L[k + 5]!
        this.colour[2] = L[k + 6]!
      }
    }
    return Math.min(1.2, sum)
  }

  /** 0..1: the glow round a torch's lens within `radius` m (any direction), which lights breath just above it. */
  near(x: number, z: number, radius: number): number {
    let best = 0
    const L = this.lights
    for (let i = this.from; i < this.to; i++) {
      const k = i * LIGHT_FLOATS
      if (L[k + 7]! <= 0.001) continue
      const d = Math.hypot(x - L[k]!, z - L[k + 2]!)
      if (d >= radius) continue
      const v = (1 - d / radius) ** 2 * Math.min(1, L[k + 7]!)
      if (v > best) {
        best = v
        this.colour[0] = L[k + 4]!
        this.colour[1] = L[k + 5]!
        this.colour[2] = L[k + 6]!
      }
    }
    return best
  }
}

export function smoothstep(a: number, b: number, v: number): number {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Writes one renderer sprite (`SPRITE_FLOATS` layout) at index `n`; returns `n + 1`, or `n` when the buffer is full. */
export function putSprite(buf: Float32Array, n: number, x: number, y: number, z: number, size: number, r: number, g: number, b: number, a: number, kind = 0, rot = 0, stretch = 1): number {
  const o = n * SPRITE_FLOATS
  if (o + SPRITE_FLOATS > buf.length || a <= 0.002) return n
  buf[o] = x
  buf[o + 1] = y
  buf[o + 2] = z
  buf[o + 3] = size
  buf[o + 4] = r
  buf[o + 5] = g
  buf[o + 6] = b
  buf[o + 7] = a
  buf[o + 8] = kind
  buf[o + 9] = rot
  buf[o + 10] = stretch
  buf[o + 11] = 0
  return n + 1
}
