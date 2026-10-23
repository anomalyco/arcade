// Small offline DSP for composing the uncanny distant sounds (scripts/audio/uncanny.ts): pitch tracking, time-varying
// time-stretch (WSOLA), resampling, filters and envelopes. Mono Float32Array at 48 kHz throughout; nothing plays.

export const SR = 48000

export const db = (v: number) => 20 * Math.log10(Math.max(1e-9, v))
export const undb = (d: number) => 10 ** (d / 20)
export const cents = (c: number) => 2 ** (c / 1200)

/** YIN fundamental per hop: f0 (Hz, 0 when unvoiced), aperiodicity (0 clean … 1 noise) and RMS (dBFS). */
export function pitchTrack(x: Float32Array, hop = 480, win = 2048, fmin = 70, fmax = 1600): { t: number; f0: number; ap: number; rms: number }[] {
  const out: { t: number; f0: number; ap: number; rms: number }[] = []
  const maxLag = Math.floor(SR / fmin), minLag = Math.floor(SR / fmax)
  const d = new Float32Array(maxLag + 1)
  for (let s = 0; s + win + maxLag < x.length; s += hop) {
    let e = 0
    for (let i = 0; i < win; i++) e += x[s + i]! * x[s + i]!
    const rms = db(Math.sqrt(e / win))
    d[0] = 1
    let run = 0
    for (let lag = 1; lag <= maxLag; lag++) {
      let sum = 0
      for (let i = 0; i < win; i += 2) { const v = x[s + i]! - x[s + i + lag]!; sum += v * v }
      run += sum
      d[lag] = run > 0 ? (sum * lag) / run : 1
    }
    let lag = -1
    for (let l = minLag; l < maxLag; l++) if (d[l]! < 0.15 && d[l]! < d[l + 1]!) { lag = l; break }
    if (lag < 0) { let best = minLag; for (let l = minLag; l < maxLag; l++) if (d[l]! < d[best]!) best = l; lag = best }
    const a = d[lag - 1] ?? d[lag]!, b = d[lag]!, c = d[lag + 1] ?? d[lag]!
    const shift = (a - c) / (2 * (a - 2 * b + c) || 1)
    const ap = Math.min(1, b)
    out.push({ t: s / SR, f0: ap < 0.35 && rms > -60 ? SR / (lag + shift) : 0, ap, rms })
  }
  return out
}

/**
 * WSOLA time-stretch with a time-varying factor: `factor(t)` > 1 is slower (longer) at input time t (s). Keeps pitch.
 * Good on one voice or one animal (howls, calls); 46 ms Hann windows, 50% overlap, ±10 ms search.
 */
export function stretch(x: Float32Array, factor: (t: number) => number, win = 2208, tolerance = 480): Float32Array {
  const hop = win / 2
  const w = new Float32Array(win)
  for (let i = 0; i < win; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / win)
  const outLen = Math.ceil(x.length * 6) + win
  const y = new Float32Array(outLen), norm = new Float32Array(outLen)
  let inPos = 0, outPos = 0, prev = 0
  while (inPos + win + tolerance < x.length && outPos + win < outLen) {
    // The natural continuation of the last grain; find the nearby input grain that matches it best.
    let best = Math.round(inPos), bestScore = -Infinity
    if (outPos > 0) {
      const nat = prev + hop
      for (let k = -tolerance; k <= tolerance; k += 8) {
        const c = Math.round(inPos) + k
        if (c < 0 || c + win >= x.length || nat + win >= x.length) continue
        let s = 0
        for (let i = 0; i < hop; i += 4) s += x[c + i]! * x[nat + i]!
        if (s > bestScore) { bestScore = s; best = c }
      }
    }
    for (let i = 0; i < win; i++) { y[outPos + i]! += x[best + i]! * w[i]!; norm[outPos + i]! += w[i]! }
    prev = best
    outPos += hop
    inPos += hop / Math.max(0.25, factor(inPos / SR))
  }
  const n = outPos + hop
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = norm[i]! > 1e-3 ? y[i]! / norm[i]! : 0
  return out
}

/** Reads x at a time-varying rate (`rate(t)` at output time t, s): rate 1.05 is 5% faster and higher. Cubic. */
export function varispeed(x: Float32Array, rate: (t: number) => number): Float32Array {
  const out: number[] = []
  let p = 0
  while (p < x.length - 3) {
    const i = Math.floor(p), f = p - i
    const a = x[i - 1] ?? x[i]!, b = x[i]!, c = x[i + 1]!, d = x[i + 2]!
    out.push(b + 0.5 * f * (c - a + f * (2 * a - 5 * b + 4 * c - d + f * (3 * (b - c) + d - a))))
    p += rate(out.length / SR)
  }
  return Float32Array.from(out)
}

/** Pitch shift by a time-varying number of cents (at input time), keeping the duration: stretch, then read faster. */
export function bend(x: Float32Array, centsAt: (t: number) => number): Float32Array {
  const s = stretch(x, (t) => cents(centsAt(t)))
  // The result keeps x's duration, so its output time is x's time (close enough for slow bends).
  return varispeed(s, (u) => cents(centsAt(u)))
}

export function biquad(x: Float32Array, type: "lowpass" | "highpass" | "peak", f: number, q = 0.707, gainDb = 0): Float32Array {
  const w = (2 * Math.PI * f) / SR, cw = Math.cos(w), sw = Math.sin(w), alpha = sw / (2 * q), A = undb(gainDb / 2)
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number
  if (type === "lowpass") { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha }
  else if (type === "highpass") { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha }
  else { b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A }
  const y = new Float32Array(x.length)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < x.length; i++) {
    const v = (b0 * x[i]! + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0
    x2 = x1; x1 = x[i]!; y2 = y1; y1 = v; y[i] = v
  }
  return y
}

/** Multiplies by a gain envelope given as (time s, gain) points, linear between them. */
export function envelope(x: Float32Array, points: [number, number][]): Float32Array {
  const y = new Float32Array(x.length)
  let k = 0
  for (let i = 0; i < x.length; i++) {
    const t = i / SR
    while (k < points.length - 2 && t > points[k + 1]![0]) k++
    const [t0, g0] = points[k]!, [t1, g1] = points[Math.min(k + 1, points.length - 1)]!
    const g = t <= t0 ? g0 : t >= t1 ? g1 : g0 + ((g1 - g0) * (t - t0)) / (t1 - t0)
    y[i] = x[i]! * g
  }
  return y
}

/** Cuts at `t` s with a `ms` fade (2 ms: a dead stop, no tail). */
export function cut(x: Float32Array, t: number, ms = 2): Float32Array {
  const n = Math.min(x.length, Math.round(t * SR)), f = Math.max(1, Math.round((ms / 1000) * SR))
  const y = x.slice(0, n)
  for (let i = 0; i < Math.min(f, n); i++) y[n - 1 - i]! *= i / f
  return y
}

export const slice = (x: Float32Array, a: number, b: number) => x.slice(Math.max(0, Math.round(a * SR)), Math.min(x.length, Math.round(b * SR)))
export const silence = (s: number) => new Float32Array(Math.round(s * SR))

/** Mixes parts at offsets (s), each with a gain. */
export function mix(parts: { x: Float32Array; at: number; gain?: number }[]): Float32Array {
  let n = 0
  for (const p of parts) n = Math.max(n, Math.round(p.at * SR) + p.x.length)
  const y = new Float32Array(n)
  for (const p of parts) { const o = Math.round(p.at * SR), g = p.gain ?? 1; for (let i = 0; i < p.x.length; i++) y[o + i]! += p.x[i]! * g }
  return y
}

export function peak(x: Float32Array): number { let p = 0; for (const v of x) p = Math.max(p, Math.abs(v)); return p }
export function rms(x: Float32Array): number { let s = 0; for (const v of x) s += v * v; return Math.sqrt(s / Math.max(1, x.length)) }
export const scale = (x: Float32Array, g: number) => x.map((v) => v * g)
/** Scales so the loudest 100 ms has this RMS (dBFS). */
export function levelTo(x: Float32Array, target: number): Float32Array {
  let max = 0
  for (let s = 0; s + 4800 <= x.length; s += 2400) { let e = 0; for (let i = s; i < s + 4800; i++) e += x[i]! * x[i]!; max = Math.max(max, e / 4800) }
  return scale(x, undb(target) / Math.max(1e-9, Math.sqrt(max)))
}

/** Gentle noise gate under `floorDb` of the take's peak RMS, so stretching doesn't drag out hiss between sounds. */
export function gate(x: Float32Array, belowDb = -42, ms = 20): Float32Array {
  const hop = Math.round((ms / 1000) * SR), n = Math.ceil(x.length / hop)
  const e = new Float32Array(n)
  for (let k = 0; k < n; k++) { let s = 0; for (let i = k * hop; i < Math.min(x.length, (k + 1) * hop); i++) s += x[i]! * x[i]!; e[k] = Math.sqrt(s / hop) }
  const top = Math.max(...e)
  const g = new Float32Array(n)
  for (let k = 0; k < n; k++) g[k] = db(e[k]! / top) > belowDb ? 1 : 0
  // Smooth: open fast, close over ~80 ms.
  let v = 0
  const y = new Float32Array(x.length)
  for (let i = 0; i < x.length; i++) { const tgt = g[Math.floor(i / hop)]!; v += (tgt - v) * (tgt > v ? 0.01 : 0.0003); y[i] = x[i]! * v }
  return y
}
