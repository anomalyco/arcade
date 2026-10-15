/**
 * Tileable interior surface masks packed into one square RGBA texture (each channel repeats on its own):
 * R = damask motif coverage, G = regency stripes with sprigs, B = herringbone plank tone, A = herringbone seams
 * and grain. Colour comes from the material at runtime, so one layer serves every colourway.
 * RGB are stored sRGB-encoded so a `*-srgb` texture view decodes them back to the linear mask value.
 */

import { buildRugMips } from "./rug"

/** Herringbone plank length in plank widths; the B/A channels repeat every `2 * HERRINGBONE_N` widths. */
export const HERRINGBONE_N = 4

const LIN_TO_SRGB = new Uint8Array(4096)
for (let i = 0; i < 4096; i++) {
  const c = i / 4095
  LIN_TO_SRGB[i] = Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055))
}
const enc = (v: number) => LIN_TO_SRGB[Math.max(0, Math.min(4095, Math.round(v * 4095)))]!

function hash(x: number, y: number, s: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** Damask: a mirrored fleur with scrolls, leaves and a palmette, on a half-drop repeat. Coverage 0..1 at (u, v) in [0,1). */
function damask(u: number, v: number): number {
  let best = 0
  // Main motif at the centre plus the half-drop motif at the corners.
  for (const [cx, cy] of [[0.5, 0.5], [0, 0], [1, 0], [0, 1], [1, 1]] as const) {
    const x = Math.abs(u - cx) / 0.42, y = (v - cy) / 0.42
    if (Math.abs(x) > 1 || Math.abs(y) > 1) continue
    let d = 1
    const circ = (px: number, py: number, rx: number, ry: number) => Math.hypot((x - px) / rx, (y - py) / ry) - 1
    // Central bud and stem.
    d = Math.min(d, circ(0, -0.18, 0.09, 0.2))
    d = Math.min(d, circ(0, -0.5, 0.06, 0.12))
    if (y > -0.5 && y < 0.35) d = Math.min(d, x / 0.025 - 1)
    // Side scrolls (open rings).
    const ring = Math.abs(Math.hypot(x - 0.3, y + 0.05) - 0.15) / 0.035 - 1
    if (!(x < 0.3 && y < -0.05)) d = Math.min(d, ring)
    d = Math.min(d, circ(0.42, 0.12, 0.05, 0.05))
    // Leaves sweeping out and up.
    {
      const lx = x - 0.24, ly = y + 0.42
      const a = -0.7, ca = Math.cos(a), sa = Math.sin(a)
      const qx = lx * ca - ly * sa, qy = lx * sa + ly * ca
      const t = qx / 0.22
      if (Math.abs(t) < 1) d = Math.min(d, Math.abs(qy) / (0.06 * (1 - t * t) + 1e-4) - 1)
    }
    // Palmette fan at the base.
    {
      const px = x, py = y - 0.42
      const r = Math.hypot(px, py)
      const th = Math.atan2(px, -py)
      const edge = 0.24 * (0.7 + 0.3 * Math.abs(Math.cos(th * 2.5)))
      if (py < 0.08) d = Math.min(d, r / edge - 1)
      d = Math.max(d, -(r / 0.08 - 1))
    }
    // Little diamonds between repeats.
    d = Math.min(d, (Math.abs(x - 0.88) + Math.abs(y - 0.0)) / 0.06 - 1)
    best = Math.max(best, Math.max(0, Math.min(1, 0.5 - d * 6)))
  }
  return best
}

/** Regency stripes: a wide satin stripe, a narrow one and hairlines, with tiny sprigs in the ground band. */
function stripes(u: number, v: number): number {
  const w = u
  if (w < 0.34) return 0.95
  if (w < 0.36 || (w > 0.62 && w < 0.635)) return 0.6
  if (w > 0.66 && w < 0.74) return 0.85
  if (w > 0.765 && w < 0.78) return 0.6
  // Sprigs on a half-drop in the ground band (0.36..0.62 and 0.78..1.0).
  const sx = w < 0.65 ? 0.49 : 0.89
  const sy = w < 0.65 ? 0.25 : 0.75
  for (const oy of [-1, 0, 1]) {
    const dy = v - sy - oy * 1.0 * 0.5 * 2
    const r = Math.hypot((w - sx) / 0.05, dy / 0.07)
    if (r < 1) return r < 0.4 ? 0.7 : 0.4
  }
  return 0
}

/** Herringbone of 1×N planks (cell size 1): returns [plank tone, seam/grain] at unit coordinates. */
function herringbone(px: number, py: number): [number, number] {
  const n = HERRINGBONE_N
  const i = Math.floor(px), j = Math.floor(py)
  const m = (((i - j) % (2 * n)) + 2 * n) % (2 * n)
  let along: number, across: number, key0: number, key1: number
  if (m < n) {
    const i0 = i - m
    along = (px - i0) / n
    across = py - j
    key0 = i0
    key1 = j
  } else {
    const j0 = j - (2 * n - 1 - m)
    along = (py - j0) / n
    across = px - i
    key0 = i + 1000
    key1 = j0
  }
  const period = 2 * n
  const k0 = ((key0 % period) + period) % period, k1 = ((key1 % period) + period) % period
  const tone = 0.25 + 0.6 * hash(k0, k1, 7) + 0.15 * hash(k0, k1, 9)
  const seamAcross = Math.min(across, 1 - across) * 1
  const seamAlong = Math.min(along, 1 - along) * n
  const seam = Math.min(1, Math.min(seamAcross, seamAlong) / 0.06)
  const grain = 0.82 + 0.18 * Math.sin((across * 9 + Math.sin(along * 6.3 + k0) * 0.8) * Math.PI)
  return [tone, Math.max(0.05, seam) * grain]
}

/** Bakes the packed tile masks at `size` (mip 0 first). */
export function bakeInteriorTiles(size = 1024): Uint8Array[] {
  const out = new Uint8Array(size * size * 4)
  const ss = 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sj = 0; sj < ss; sj++) for (let si = 0; si < ss; si++) {
        const u = (x + (si + 0.5) / ss) / size, v = (y + (sj + 0.5) / ss) / size
        r += damask(u, v)
        g += stripes(u, v)
        const [t, s] = herringbone(u * HERRINGBONE_N * 2, v * HERRINGBONE_N * 2)
        b += t
        a += s
      }
      const k = 1 / (ss * ss)
      const o = (y * size + x) * 4
      out[o] = enc(r * k)
      out[o + 1] = enc(g * k)
      out[o + 2] = enc(b * k)
      out[o + 3] = Math.round(a * k * 255)
    }
  }
  return buildRugMips(out, size).map((m, i) => (i === 0 ? out : m))
}
