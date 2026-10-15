// CSS colours as straight RGBA in 0–1, for drawing the same colours on a 2D canvas and on the GPU.
export type Rgba = readonly [number, number, number, number]

const cache = new Map<string, Rgba>()
let probe: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null
const probeCtx = () => {
  if (probe) return probe
  if (typeof OffscreenCanvas !== "undefined")
    probe = new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true })
  else if (typeof document !== "undefined") {
    const c = document.createElement("canvas")
    c.width = c.height = 1
    probe = c.getContext("2d", { willReadFrequently: true })
  }
  return probe
}

/** Any CSS colour (hex, rgb(), oklch(), color-mix(), calc() inside) as RGBA; `fallback` if not one. */
export function parseCssColor(raw: string, fallback: Rgba = [1, 1, 1, 1]): Rgba {
  const s = raw.trim()
  if (!s) return fallback
  const hit = cache.get(s)
  if (hit) return hit
  let out: Rgba | undefined
  const hex = /^#([0-9a-f]{3,8})$/i.exec(s)?.[1]
  if (hex && (hex.length === 3 || hex.length === 6 || hex.length === 8)) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex
    out = [
      parseInt(full.slice(0, 2), 16) / 255,
      parseInt(full.slice(2, 4), 16) / 255,
      parseInt(full.slice(4, 6), 16) / 255,
      full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1,
    ]
  } else {
    const ctx = probeCtx()
    if (ctx) {
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = "#000"
      ctx.fillStyle = s
      ctx.fillRect(0, 0, 1, 1)
      const d = ctx.getImageData(0, 0, 1, 1).data
      // Straight alpha back out of the premultiplied pixel.
      const a = d[3]! / 255
      out = a > 0 ? [d[0]! / 255, d[1]! / 255, d[2]! / 255, a] : [0, 0, 0, 0]
    }
  }
  out ??= fallback
  if (cache.size > 1024) cache.clear()
  cache.set(s, out)
  return out
}

export const withAlpha = (c: Rgba, k: number): Rgba => [
  c[0],
  c[1],
  c[2],
  Math.max(0, Math.min(1, c[3] * k)),
]

export const mixRgba = (a: Rgba, b: Rgba, t: number): Rgba => {
  const u = Math.max(0, Math.min(1, t))
  return [
    a[0] + (b[0] - a[0]) * u,
    a[1] + (b[1] - a[1]) * u,
    a[2] + (b[2] - a[2]) * u,
    a[3] + (b[3] - a[3]) * u,
  ]
}

export const rgbaCss = (c: Rgba) =>
  `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${Math.round(c[3] * 1000) / 1000})`
