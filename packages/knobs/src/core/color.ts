/** An OKLCH colour: lightness 0…1, chroma 0…0.37, hue in degrees. */
export interface Oklch {
  readonly l: number
  readonly c: number
  readonly h: number
}

export const CHROMA_MAX = 0.37

const round = (n: number, places: number) => Number(n.toFixed(places))
const clamp01 = (n: number) => Math.min(1, Math.max(0, n))
const gamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)

/** OKLCH → linear-light sRGB (unclamped). */
export function oklchToLinear({ l, c, h }: Oklch): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180)
  const b = c * Math.sin((h * Math.PI) / 180)
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ]
}

const inGamut = (rgb: readonly number[]) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4)

/** The most chroma this lightness and hue can carry inside sRGB. */
export function maxChroma(l: number, h: number): number {
  if (l <= 0 || l >= 1) return 0
  let lo = 0
  let hi = CHROMA_MAX
  if (inGamut(oklchToLinear({ l, c: hi, h }))) return hi
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2
    if (inGamut(oklchToLinear({ l, c: mid, h }))) lo = mid
    else hi = mid
  }
  return lo
}

/** Gamut-mapped sRGB channels 0…1: chroma drops until the colour fits, keeping lightness and hue. */
export function oklchToRgb(color: Oklch): [number, number, number] {
  const c = Math.min(color.c, maxChroma(color.l, color.h))
  const [r, g, b] = oklchToLinear({ ...color, c })
  return [clamp01(gamma(r)), clamp01(gamma(g)), clamp01(gamma(b))]
}

export function rgbToOklch(r: number, g: number, b: number): Oklch {
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)]
  const l_ = Math.cbrt(0.4122214708 * lr + 0.5363377612 * lg + 0.0514459929 * lb)
  const m_ = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s_ = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_
  const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_
  const c = Math.hypot(a, bb)
  const h = c < 1e-4 ? 0 : ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360
  return { l: L, c, h }
}

/** Reads `oklch(L C H)` (L as 0…1 or a percentage), `#rgb` / `#rrggbb`, or `{ l, c, h }`. */
export function parseColor(input: unknown): Oklch | undefined {
  if (typeof input === "object" && input !== null) {
    const { l, c, h } = input as Record<string, unknown>
    return [l, c, h].every((n) => typeof n === "number" && Number.isFinite(n))
      ? { l: l as number, c: c as number, h: h as number }
      : undefined
  }
  if (typeof input !== "string") return undefined
  const s = input.trim().toLowerCase()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s)?.[1]
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((d) => d + d).join("") : hex
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
    return rgbToOklch(r!, g!, b!)
  }
  const m = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*\)$/.exec(s)
  if (!m) return undefined
  const l = Number(m[1]) / (m[2] ? 100 : 1)
  const parts = [l, Number(m[3]), Number(m[4])]
  return parts.every(Number.isFinite) ? { l: parts[0]!, c: parts[1]!, h: parts[2]! } : undefined
}

/** Clamps into range and into sRGB (by chroma), rounded to what the string keeps. */
export function fitColor({ l, c, h }: Oklch): Oklch {
  const L = round(clamp01(l), 4)
  const H = round(((h % 360) + 360) % 360, 2) % 360
  // Colours already inside sRGB (like any hex) keep their chroma, give or take the rounding.
  const max = Math.min(CHROMA_MAX, maxChroma(L, H))
  const C =
    Math.max(0, c) <= max + 5e-4 ? round(Math.max(0, c), 4) : Math.floor(max * 10000) / 10000
  return { l: L, c: C, h: H }
}

export function formatColor({ l, c, h }: Oklch): string {
  return `oklch(${round(l, 4)} ${round(c, 4)} ${round(h, 2)})`
}

/** A colour field's value as `#rrggbb` (sRGB). */
export function colorHex(value: string | Oklch): string {
  const color = parseColor(value)
  if (!color) return "#000000"
  return `#${oklchToRgb(color)
    .map((v) =>
      Math.round(v * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`
}
