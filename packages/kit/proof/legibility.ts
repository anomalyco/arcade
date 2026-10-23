/** CPU-only gates over opaque, display-sRGB RGBA8 frames. Luminance/Weber are linear-light. */
export type Frame = { width: number; height: number; data: ArrayLike<number> }
export type Region = { x: number; y: number; width: number; height: number }
export type Gate = { id: string; status: "pass" | "fail" | "skip"; value: number | null; limit: number | null; note?: string }
export type Limits = {
  minP99?: number; minStddev?: number; maxClipped?: number; maxWhite?: number
  maxFlatShare?: number; flatContrast?: number; washFloor?: number
  minChangedPixels?: number; minWeber?: number; changeThreshold?: number
  slabMinShare?: number; slabBrightness?: number; slabMaxCv?: number; slabMinMotion?: number
}
export const DEFAULT_LIMITS = {
  minP99: 0.002, minStddev: 0.0005, maxClipped: 0.02, maxWhite: 0.02,
  maxFlatShare: 0.85, flatContrast: 0.08, washFloor: 0.04,
  minChangedPixels: 300, minWeber: 0.2, changeThreshold: 4 / 255,
  slabMinShare: 0.002, slabBrightness: 0.65, slabMaxCv: 0.12, slabMinMotion: 0.01,
} satisfies Required<Limits>

const linear = Array.from({ length: 256 }, (_, i) => {
  const c = i / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
})
export function luminance(frame: Frame): Float32Array {
  const { width: w, height: h, data } = frame
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || data.length !== w * h * 4) throw new Error("Invalid RGBA8 frame dimensions")
  const out = new Float32Array(w * h)
  for (let i = 0; i < out.length; i++) {
    const k = i * 4
    for (let c = 0; c < 4; c++) if (!Number.isInteger(data[k + c]) || data[k + c]! < 0 || data[k + c]! > 255) throw new Error("Frame is not RGBA8")
    if (data[k + 3] !== 255) throw new Error("Frame must be opaque (transparent captures are not proof)")
    out[i] = 0.2126 * linear[data[k]!]! + 0.7152 * linear[data[k + 1]!]! + 0.0722 * linear[data[k + 2]!]!
  }
  return out
}
function sameSize(a: Frame, b: Frame) {
  if (a.width !== b.width || a.height !== b.height) throw new Error("Probe dimensions differ")
}
function bounds(f: Frame, r?: Region): Region {
  const b = r ?? { x: 0, y: 0, width: f.width, height: f.height }
  if (Object.values(b).some(v => !Number.isInteger(v)) || b.x < 0 || b.y < 0 || b.width < 1 || b.height < 1 || b.x + b.width > f.width || b.y + b.height > f.height) throw new Error("Invalid probe region")
  return b
}
export function frameMetrics(frame: Frame, limits: Limits = {}) {
  const l = { ...DEFAULT_LIMITS, ...limits }, lum = luminance(frame), n = lum.length
  const sorted = lum.slice().sort(), percentile = (p: number) => sorted[Math.floor((n - 1) * p)]!
  let sum = 0, sum2 = 0, dark = 0, white = 0, clipped = 0
  for (let i = 0; i < n; i++) {
    const v = lum[i]!, k = i * 4, rgb = [frame.data[k]!, frame.data[k + 1]!, frame.data[k + 2]!]
    sum += v; sum2 += v * v
    if (v < 0.02) dark++
    if (Math.min(...rgb) >= 250) white++
    if (Math.max(...rgb) >= 254) clipped++
  }
  // Tile coefficient of variation catches a lifted, locally featureless veil without declaring a dark sky milky.
  const tile = Math.max(8, Math.round(Math.min(frame.width, frame.height) / 24))
  let flat = 0, localContrast = 0, tiles = 0
  for (let y = 0; y < frame.height; y += tile) for (let x = 0; x < frame.width; x += tile) {
    let s = 0, s2 = 0, count = 0
    for (let yy = y; yy < Math.min(y + tile, frame.height); yy++) for (let xx = x; xx < Math.min(x + tile, frame.width); xx++) {
      const v = lum[yy * frame.width + xx]!; s += v; s2 += v * v; count++
    }
    const mean = s / count, cv = Math.sqrt(Math.max(0, s2 / count - mean * mean)) / Math.max(mean, 0.005)
    localContrast += cv; tiles++
    if (mean >= l.washFloor && cv < l.flatContrast) flat += count
  }
  const mean = sum / n
  return { mean, stddev: Math.sqrt(Math.max(0, sum2 / n - mean * mean)), p5: percentile(0.05), p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), darkShare: dark / n, whiteShare: white / n, clippedShare: clipped / n, flatShare: flat / n, localContrast: localContrast / tiles }
}

/** On/off must share pose, clock, random seed and exposure; ROI comes from geometry, not the difference itself. */
export function counterfactual(on: Frame, off: Frame, region?: Region, limits: Limits = {}) {
  sameSize(on, off)
  const a = luminance(on), b = luminance(off), r = bounds(on, region), l = { ...DEFAULT_LIMITS, ...limits }
  let changedPixels = 0, sa = 0, sb = 0, absoluteDelta = 0
  for (let y = r.y; y < r.y + r.height; y++) for (let x = r.x; x < r.x + r.width; x++) {
    const i = y * on.width + x, k = i * 4
    const delta = Math.max(...[0, 1, 2].map(c => Math.abs(on.data[k + c]! - off.data[k + c]!))) / 255
    if (delta < l.changeThreshold) continue
    changedPixels++; sa += a[i]!; sb += b[i]!; absoluteDelta += Math.abs(a[i]! - b[i]!)
  }
  const meanOn = changedPixels ? sa / changedPixels : 0, meanOff = changedPixels ? sb / changedPixels : 0
  // A floor prevents a handful of near-black quantisation steps claiming infinite visibility.
  return { changedPixels, changedShare: changedPixels / (r.width * r.height), meanOn, meanOff, weber: (meanOn - meanOff) / Math.max(meanOff, 0.005), absoluteWeber: changedPixels ? absoluteDelta / changedPixels / Math.max(meanOff, 0.005) : 0, region: r }
}

type Component = { pixels: number; cx: number; cy: number; cv: number; fill: number; box: Region }
/** Bright connected components; a box-fill requirement suppresses branches, stars and rain streaks. */
function components(frame: Frame, l: Required<Limits>): Component[] {
  const lum = luminance(frame), seen = new Uint8Array(lum.length), queue = new Int32Array(lum.length), result: Component[] = []
  const w = frame.width, h = frame.height
  for (let start = 0; start < lum.length; start++) {
    if (seen[start] || lum[start]! < l.slabBrightness) continue
    let head = 0, tail = 1, sx = 0, sy = 0, sum = 0, sum2 = 0, x0 = w, x1 = 0, y0 = h, y1 = 0
    queue[0] = start; seen[start] = 1
    while (head < tail) {
      const i = queue[head++]!, x = i % w, y = Math.floor(i / w), v = lum[i]!
      sx += x; sy += y; sum += v; sum2 += v * v
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y)
      const add = (j: number) => { if (!seen[j] && lum[j]! >= l.slabBrightness) { seen[j] = 1; queue[tail++] = j } }
      if (x) add(i - 1); if (x + 1 < w) add(i + 1); if (y) add(i - w); if (y + 1 < h) add(i + w)
    }
    if (tail < Math.max(16, lum.length * l.slabMinShare)) continue
    const mean = sum / tail, cv = Math.sqrt(Math.max(0, sum2 / tail - mean * mean)) / mean
    const box = { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }, fill = tail / (box.width * box.height)
    if (cv <= l.slabMaxCv && fill >= 0.7) result.push({ pixels: tail, cx: sx / tail, cy: sy / tail, cv, fill, box })
  }
  return result
}

/** Small camera translation only, no rotation/time change. This is a slab heuristic, not a depth reconstruction. */
export function slabMetrics(frame: Frame, shifted?: Frame, limits: Limits = {}) {
  const l = { ...DEFAULT_LIMITS, ...limits }, candidates = components(frame, l)
  if (!shifted) return { candidates, moving: [], tested: false }
  sameSize(frame, shifted)
  const other = components(shifted, l), lum = luminance(shifted)
  const moving = candidates.filter(c => {
    // Require both displacement and change at the original footprint, avoiding a second similar distant light.
    let bright = 0
    for (let y = c.box.y; y < c.box.y + c.box.height; y++) for (let x = c.box.x; x < c.box.x + c.box.width; x++) if (lum[y * frame.width + x]! >= l.slabBrightness) bright++
    const lost = 1 - bright / c.pixels
    const match = other.filter(o => o.pixels / c.pixels > 0.5 && o.pixels / c.pixels < 2)
      .sort((a, b) => Math.hypot(a.cx - c.cx, a.cy - c.cy) - Math.hypot(b.cx - c.cx, b.cy - c.cy))[0]
    return lost > 0.25 && (!match || Math.hypot(match.cx - c.cx, match.cy - c.cy) / frame.width >= l.slabMinMotion)
  })
  return { candidates, moving, tested: true }
}

/** Raw, unlit sRGB base-colour debug view only. Mask excludes sky, emissives, metals and deliberately black materials. */
export function albedoMetrics(frame: Frame, mask: ArrayLike<number>, range: readonly [number, number] = [0.03, 0.89]) {
  const lum = luminance(frame)
  if (mask.length !== lum.length || !(range[0] >= 0 && range[1] <= 1 && range[0] < range[1])) throw new Error("Invalid albedo mask/range")
  let samples = 0, outside = 0
  for (let i = 0; i < lum.length; i++) if (mask[i]) { samples++; if (lum[i]! < range[0] || lum[i]! > range[1]) outside++ }
  return { samples, outsideShare: samples ? outside / samples : null }
}

export function qualityGates(frame: Frame, probes: { without?: Frame; region?: Region; shifted?: Frame; albedo?: { frame: Frame; mask: ArrayLike<number> } } = {}, limits: Limits = {}) {
  const l = { ...DEFAULT_LIMITS, ...limits }
  for (const [key, value] of Object.entries(l)) if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid gate threshold ${key}`)
  const metrics = frameMetrics(frame, l), gates: Gate[] = []
  const gate = (id: string, value: number, limit: number, pass: boolean) => gates.push({ id, value, limit, status: pass ? "pass" : "fail" })
  gate("near-black", metrics.p99, l.minP99, metrics.p99 >= l.minP99)
  gate("blank", metrics.stddev, l.minStddev, metrics.stddev >= l.minStddev)
  gate("clipping", metrics.clippedShare, l.maxClipped, metrics.clippedShare <= l.maxClipped)
  gate("washout", metrics.whiteShare, l.maxWhite, metrics.whiteShare <= l.maxWhite)
  gate("milky-wash", metrics.flatShare, l.maxFlatShare, metrics.flatShare <= l.maxFlatShare)
  const subject = probes.without ? counterfactual(frame, probes.without, probes.region, l) : null
  if (subject) {
    gate("subject-area", subject.changedPixels, l.minChangedPixels, subject.changedPixels >= l.minChangedPixels)
    gate("subject-weber", Math.abs(subject.weber), l.minWeber, Math.abs(subject.weber) >= l.minWeber)
  } else gates.push({ id: "subject", status: "skip", value: null, limit: null, note: "No counterfactual pair requested" })
  const slabs = slabMetrics(frame, probes.shifted, l)
  if (slabs.tested) gate("near-camera-slab", slabs.moving.length, 0, !slabs.moving.length)
  else if (slabs.candidates.length) gates.push({ id: "slab-needs-probe", status: "fail", value: slabs.candidates.length, limit: 0, note: "Flat bright region requires a matched camera-shift probe" })
  else gates.push({ id: "near-camera-slab", status: "skip", value: null, limit: null, note: "Camera-shift probe not supplied" })
  const albedo = probes.albedo ? albedoMetrics(probes.albedo.frame, probes.albedo.mask) : null
  if (albedo) {
    gate("albedo-samples", albedo.samples, 1, albedo.samples > 0)
    if (albedo.outsideShare !== null) gate("albedo", albedo.outsideShare, 0.01, albedo.outsideShare <= 0.01)
  }
  else gates.push({ id: "albedo", status: "skip", value: null, limit: null, note: "No masked, unlit material debug view" })
  return { pass: gates.every(g => g.status !== "fail"), gates, metrics, subject, slabs, albedo }
}
