import { rng, type Rand } from "../../sim/rng"

export { rng, type Rand }

export interface RGB {
  r: number
  g: number
  b: number
}

const rgbCache = new Map<string, RGB>()

export function hexRgb(hex: string): RGB {
  const hit = rgbCache.get(hex)
  if (hit) return hit
  const h = hex.replace("#", "")
  const n = parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16)
  const out = { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
  rgbCache.set(hex, out)
  return out
}

export function rgba(hex: string, a: number): string {
  const c = hexRgb(hex)
  return `rgba(${c.r},${c.g},${c.b},${a < 0 ? 0 : a > 1 ? 1 : a.toFixed(3)})`
}

export function mixHex(a: string, b: string, t: number): string {
  const x = hexRgb(a)
  const y = hexRgb(b)
  const m = (p: number, q: number) => Math.round(p + (q - p) * t)
  return `#${((1 << 24) | (m(x.r, y.r) << 16) | (m(x.g, y.g) << 8) | m(x.b, y.b)).toString(16).slice(1)}`
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export function smooth(t: number): number {
  const c = clamp(t, 0, 1)
  return c * c * (3 - 2 * c)
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1442695041)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

// smooth 1D value noise in [-1, 1]
export function noise1(seed: number): (x: number) => number {
  const r = rng(seed)
  const n = 256
  const tab = new Float32Array(n)
  for (let i = 0; i < n; i++) tab[i] = r() * 2 - 1
  return (x: number) => {
    const i = Math.floor(x)
    const f = x - i
    const a = tab[i & (n - 1)]!
    const b = tab[(i + 1) & (n - 1)]!
    return a + (b - a) * f * f * (3 - 2 * f)
  }
}

// smooth 2D value noise in [0, 1]
export function noise2(seed: number): (x: number, y: number) => number {
  return (x: number, y: number) => {
    const ix = Math.floor(x)
    const iy = Math.floor(y)
    const fx = x - ix
    const fy = y - iy
    const sx = fx * fx * (3 - 2 * fx)
    const sy = fy * fy * (3 - 2 * fy)
    const a = hash2(ix, iy, seed)
    const b = hash2(ix + 1, iy, seed)
    const c = hash2(ix, iy + 1, seed)
    const d = hash2(ix + 1, iy + 1, seed)
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
  }
}

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas")
  c.width = Math.max(1, Math.ceil(w))
  c.height = Math.max(1, Math.ceil(h))
  return c
}

export function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const g = c.getContext("2d")
  if (!g) throw new Error("2d context unavailable")
  return g
}

// soft radial glow sprite (white core falling off to transparent), tinted per color and cached
const glowCache = new Map<string, HTMLCanvasElement>()

export function glowSprite(color: string, hard = 0): HTMLCanvasElement {
  const key = `${color}|${hard}`
  const hit = glowCache.get(key)
  if (hit) return hit
  const size = 64
  const c = makeCanvas(size, size)
  const g = ctx2d(c)
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  const col = hexRgb(color)
  const s = `${col.r},${col.g},${col.b}`
  if (hard > 0) {
    grad.addColorStop(0, `rgba(255,255,255,1)`)
    grad.addColorStop(0.18 * hard, `rgba(${s},0.95)`)
    grad.addColorStop(0.45, `rgba(${s},0.35)`)
    grad.addColorStop(1, `rgba(${s},0)`)
  } else {
    grad.addColorStop(0, `rgba(${s},1)`)
    grad.addColorStop(0.25, `rgba(${s},0.55)`)
    grad.addColorStop(0.6, `rgba(${s},0.14)`)
    grad.addColorStop(1, `rgba(${s},0)`)
  }
  g.fillStyle = grad
  g.fillRect(0, 0, size, size)
  glowCache.set(key, c)
  return c
}

const smokeCache = new Map<string, HTMLCanvasElement>()

export function smokeSprite(color: string): HTMLCanvasElement {
  const hit = smokeCache.get(color)
  if (hit) return hit
  const c = makeCanvas(64, 64)
  const g = ctx2d(c)
  const col = hexRgb(color)
  const r = rng(color.length * 7919 + col.r * 31 + col.g)
  for (let i = 0; i < 9; i++) {
    const x = 32 + (r() - 0.5) * 22
    const y = 32 + (r() - 0.5) * 22
    const rad = 10 + r() * 12
    const grad = g.createRadialGradient(x, y, 0, x, y, rad)
    grad.addColorStop(0, `rgba(${col.r},${col.g},${col.b},0.32)`)
    grad.addColorStop(1, `rgba(${col.r},${col.g},${col.b},0)`)
    g.fillStyle = grad
    g.fillRect(0, 0, 64, 64)
  }
  smokeCache.set(color, c)
  return c
}
