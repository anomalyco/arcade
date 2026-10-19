// Small offline DSP kit for designed sounds (mono Float32 at 48 kHz in, stereo out). Pure TypeScript plus ffmpeg for
// decode/encode. Everything takes an explicit seeded RNG so a recipe renders the same take every time.

import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

export const SR = 48000
export type Mono = Float32Array
export type Stereo = [Float32Array, Float32Array]

export function rng(seed: number) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return (s >>> 0) / 4294967296
  }
}
export type Rng = ReturnType<typeof rng>

export async function load(file: string): Promise<Mono> {
  const p = Bun.spawn(["ffmpeg", "-v", "error", "-i", file, "-f", "f32le", "-ac", "1", "-ar", String(SR), "-"], { stdout: "pipe" })
  const buf = new Float32Array(await new Response(p.stdout).arrayBuffer())
  await p.exited
  if (!buf.length) throw new Error(`empty decode: ${file}`)
  return buf
}

export async function save(file: string, st: Stereo) {
  mkdirSync(dirname(file), { recursive: true })
  const n = st[0].length
  const inter = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    inter[i * 2] = st[0][i]!
    inter[i * 2 + 1] = st[1][i]!
  }
  const p = Bun.spawn(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", String(SR), "-ac", "2", "-i", "-", "-c:a", "libmp3lame", "-b:a", "96k", file], { stdin: "pipe" })
  p.stdin.write(new Uint8Array(inter.buffer))
  await p.stdin.end()
  if ((await p.exited) !== 0) throw new Error(`encode failed: ${file}`)
}

export const sec = (s: number) => Math.round(s * SR)
export const dur = (x: Mono) => x.length / SR

export function silence(s: number): Mono {
  return new Float32Array(sec(s))
}

/** Drops leading and trailing audio quieter than `db` under the peak. */
export function trim(x: Mono, db = 45): Mono {
  let m = 0
  for (const v of x) m = Math.max(m, Math.abs(v))
  const th = m * 10 ** (-db / 20)
  let a = 0
  let b = x.length
  while (a < b && Math.abs(x[a]!) < th) a++
  while (b > a && Math.abs(x[b - 1]!) < th) b--
  return x.slice(Math.max(0, a - sec(0.005)), Math.min(x.length, b + sec(0.02)))
}

export function slice(x: Mono, from: number, to = dur(x)): Mono {
  return x.slice(sec(from), Math.min(x.length, sec(to)))
}

export function gain(x: Mono, g: number): Mono {
  const y = new Float32Array(x.length)
  for (let i = 0; i < x.length; i++) y[i] = x[i]! * g
  return y
}

export function peakNorm(x: Mono, peak = 0.9): Mono {
  let m = 0
  for (const v of x) m = Math.max(m, Math.abs(v))
  return m > 0 ? gain(x, peak / m) : x
}

export function reverse(x: Mono): Mono {
  return x.slice().reverse()
}

export function fade(x: Mono, inS: number, outS: number, curve = 2): Mono {
  const y = x.slice()
  const a = Math.min(y.length, sec(inS))
  const b = Math.min(y.length, sec(outS))
  for (let i = 0; i < a; i++) y[i]! *= (i / a) ** curve
  for (let i = 0; i < b; i++) y[y.length - 1 - i]! *= (i / b) ** curve
  return y
}

/** Multiplies by an envelope given as [time s, level] points (linear). */
export function envelope(x: Mono, pts: [number, number][]): Mono {
  const y = x.slice()
  let k = 0
  for (let i = 0; i < y.length; i++) {
    const t = i / SR
    while (k < pts.length - 2 && t > pts[k + 1]![0]) k++
    const [t0, v0] = pts[k]!
    const [t1, v1] = pts[Math.min(k + 1, pts.length - 1)]!
    const u = t1 > t0 ? Math.max(0, Math.min(1, (t - t0) / (t1 - t0))) : 1
    y[i]! *= v0 + (v1 - v0) * (t < t0 ? 0 : u)
  }
  return y
}

const at = (x: Mono, p: number) => {
  const i = Math.floor(p)
  const f = p - i
  const a = x[i] ?? 0
  const b = x[i + 1] ?? 0
  return a + (b - a) * f
}

/** Varispeed: pitch and formants by `ratio` (or a ratio curve over output time), duration / ratio. */
export function varispeed(x: Mono, ratio: number | ((t: number) => number)): Mono {
  const r = typeof ratio === "number" ? () => ratio : ratio
  const out: number[] = []
  let p = 0
  let i = 0
  while (p < x.length - 1 && i < x.length * 8) {
    out.push(at(x, p))
    p += r(i / SR)
    i++
  }
  return Float32Array.from(out)
}

/** Granular time-stretch (pitch kept): Hann grains, optional position jitter for a smeared, granular texture. */
export function stretch(x: Mono, factor: number, o: { grain?: number; jitter?: number; pitchJitter?: number; rnd?: Rng } = {}): Mono {
  const g = sec(o.grain ?? 0.1)
  const hop = Math.max(1, Math.floor(g / 2))
  const n = Math.floor(x.length * factor)
  const y = new Float32Array(n + g)
  const norm = new Float32Array(n + g)
  const rnd = o.rnd ?? Math.random
  for (let out = 0; out < n; out += hop) {
    const src = out / factor + (rnd() - 0.5) * 2 * (o.jitter ?? 0) * SR
    const pr = 1 + (rnd() - 0.5) * 2 * (o.pitchJitter ?? 0)
    for (let j = 0; j < g; j++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * j) / g)
      y[out + j]! += at(x, Math.max(0, src + j * pr)) * w
      norm[out + j]! += w
    }
  }
  for (let i = 0; i < y.length; i++) y[i] = norm[i]! > 1e-3 ? y[i]! / norm[i]! : 0
  return y.subarray(0, n)
}

/** Pitch shift keeping duration: varispeed then stretch back. */
export function pitch(x: Mono, ratio: number, o: { grain?: number; jitter?: number; rnd?: Rng } = {}): Mono {
  return stretch(varispeed(x, ratio), ratio, o)
}

/** Detuned stack: varispeed copies at cents offsets (no grains, so no comb artefacts) with small delays and a slow
 *  drift each; returns stereo, copies spread across the field. */
export function chorus(x: Mono, cents: number[], o: { delay?: number; rnd?: Rng } = {}): Stereo {
  const rnd = o.rnd ?? Math.random
  const parts = cents.map((c, i) => ({
    x: varispeed(x, ((r0, ph) => (t: number) => r0 * (1 + 0.002 * Math.sin(2 * Math.PI * 0.2 * t + ph)))(2 ** (c / 1200), rnd() * 6)),
    at: rnd() * (o.delay ?? 0.03),
    pan: cents.length > 1 ? -0.9 + (1.8 * i) / (cents.length - 1) : 0,
    gain: 1 / Math.sqrt(cents.length),
  }))
  return mix(parts)
}

export function ringMod(x: Mono, freq: number | ((t: number) => number), amount = 1): Mono {
  const f = typeof freq === "number" ? () => freq : freq
  const y = new Float32Array(x.length)
  let ph = 0
  for (let i = 0; i < x.length; i++) {
    ph += (2 * Math.PI * f(i / SR)) / SR
    y[i] = x[i]! * (1 - amount + amount * Math.sin(ph))
  }
  return y
}

export function bitcrush(x: Mono, bits: number, hold: number, amount = 1): Mono {
  const y = new Float32Array(x.length)
  const q = 2 ** (bits - 1)
  let held = 0
  for (let i = 0; i < x.length; i++) {
    if (i % hold === 0) held = Math.round(x[i]! * q) / q
    y[i] = x[i]! * (1 - amount) + held * amount
  }
  return y
}

/** Soft saturation. */
export function drive(x: Mono, amount: number): Mono {
  const y = new Float32Array(x.length)
  const k = Math.tanh(amount)
  for (let i = 0; i < x.length; i++) y[i] = Math.tanh(x[i]! * amount) / k
  return y
}

type Biquad = "lowpass" | "highpass" | "bandpass" | "peak"
export function filter(x: Mono, type: Biquad, f: number, q = 0.707, dbGain = 0): Mono {
  const w = (2 * Math.PI * f) / SR
  const cs = Math.cos(w)
  const al = Math.sin(w) / (2 * q)
  const A = 10 ** (dbGain / 40)
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number
  if (type === "lowpass") [b0, b1, b2, a0, a1, a2] = [(1 - cs) / 2, 1 - cs, (1 - cs) / 2, 1 + al, -2 * cs, 1 - al]
  else if (type === "highpass") [b0, b1, b2, a0, a1, a2] = [(1 + cs) / 2, -(1 + cs), (1 + cs) / 2, 1 + al, -2 * cs, 1 - al]
  else if (type === "bandpass") [b0, b1, b2, a0, a1, a2] = [al, 0, -al, 1 + al, -2 * cs, 1 - al]
  else [b0, b1, b2, a0, a1, a2] = [1 + al * A, -2 * cs, 1 - al * A, 1 + al / A, -2 * cs, 1 - al / A]
  const y = new Float32Array(x.length)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < x.length; i++) {
    const v = (b0 * x[i]! + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0
    x2 = x1
    x1 = x[i]!
    y2 = y1
    y1 = v
    y[i] = v
  }
  return y
}

/** Sine sweep (Hz over time) with an envelope: sub hits, sub drops, thin rings. */
export function tone(s: number, freq: (t: number) => number, env: [number, number][], harmonics: number[] = [1]): Mono {
  const y = new Float32Array(sec(s))
  let ph = 0
  for (let i = 0; i < y.length; i++) {
    ph += (2 * Math.PI * freq(i / SR)) / SR
    let v = 0
    harmonics.forEach((a, k) => (v += a * Math.sin(ph * (k + 1))))
    y[i] = v
  }
  return envelope(y, env)
}

export function noise(s: number, rnd: Rng): Mono {
  const y = new Float32Array(sec(s))
  for (let i = 0; i < y.length; i++) y[i] = rnd() * 2 - 1
  return y
}

export type Part = { x: Mono | Stereo; at?: number; gain?: number; pan?: number }
/** Mixes parts (mono parts are panned equal-power) into a stereo buffer. */
export function mix(parts: Part[]): Stereo {
  let n = 0
  for (const p of parts) n = Math.max(n, sec(p.at ?? 0) + (Array.isArray(p.x) ? p.x[0].length : p.x.length))
  const L = new Float32Array(n)
  const R = new Float32Array(n)
  for (const p of parts) {
    const o = sec(p.at ?? 0)
    const g = p.gain ?? 1
    if (Array.isArray(p.x)) {
      for (let i = 0; i < p.x[0].length; i++) {
        L[o + i]! += p.x[0][i]! * g
        R[o + i]! += p.x[1][i]! * g
      }
    } else {
      const a = (((p.pan ?? 0) + 1) * Math.PI) / 4
      const gl = Math.cos(a) * g * Math.SQRT2
      const gr = Math.sin(a) * g * Math.SQRT2
      for (let i = 0; i < p.x.length; i++) {
        L[o + i]! += p.x[i]! * gl
        R[o + i]! += p.x[i]! * gr
      }
    }
  }
  return [L, R]
}

export const toMono = (s: Stereo): Mono => {
  const y = new Float32Array(s[0].length)
  for (let i = 0; i < y.length; i++) y[i] = (s[0][i]! + s[1][i]!) / 2
  return y
}

/** Crossfade a into b starting at `t` (s into a) over `len` s; returns a mono buffer. */
export function crossfade(a: Mono, b: Mono, t: number, len: number): Mono {
  const s0 = sec(t)
  const L = sec(len)
  const y = new Float32Array(Math.max(a.length, s0 + b.length))
  for (let i = 0; i < y.length; i++) {
    const u = Math.max(0, Math.min(1, (i - s0) / L))
    y[i] = (a[i] ?? 0) * Math.cos((u * Math.PI) / 2) + (b[i - s0] ?? 0) * Math.sin((u * Math.PI) / 2)
  }
  return y
}

// ---- convolution reverb ----

function fft(re: Float64Array, im: Float64Array, inv: boolean) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j]!, re[i]!]
      ;[im[i], im[j]] = [im[j]!, im[i]!]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inv ? 2 : -2) * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0
      for (let j = 0; j < len / 2; j++) {
        const ar = re[i + j]!, ai = im[i + j]!
        const br = re[i + j + len / 2]! * cr - im[i + j + len / 2]! * ci
        const bi = re[i + j + len / 2]! * ci + im[i + j + len / 2]! * cr
        re[i + j] = ar + br
        im[i + j] = ai + bi
        re[i + j + len / 2] = ar - br
        im[i + j + len / 2] = ai - bi
        const t = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = t
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) (re[i]! /= n), (im[i]! /= n)
}

export function convolve(x: Mono, ir: Mono): Mono {
  const n = x.length + ir.length - 1
  let N = 1
  while (N < n) N <<= 1
  const ar = new Float64Array(N), ai = new Float64Array(N), br = new Float64Array(N), bi = new Float64Array(N)
  ar.set(x)
  br.set(ir)
  fft(ar, ai, false)
  fft(br, bi, false)
  for (let i = 0; i < N; i++) {
    const r = ar[i]! * br[i]! - ai[i]! * bi[i]!
    ai[i] = ar[i]! * bi[i]! + ai[i]! * br[i]!
    ar[i] = r
  }
  fft(ar, ai, true)
  return Float32Array.from(ar.subarray(0, n))
}

export type Space = "stairwell" | "corridor" | "forest" | "cavern" | "room"
/** Synthetic impulse responses: decaying filtered noise plus early reflections, per channel (decorrelated). */
export function impulse(space: Space, rnd: Rng): Stereo {
  const spec = {
    stairwell: { rt: 2.6, lp: 6000, early: [0.011, 0.019, 0.027, 0.041, 0.055], flutter: 0 },
    corridor: { rt: 1.4, lp: 5000, early: [0.008, 0.016], flutter: 0.022 },
    forest: { rt: 1.8, lp: 2800, early: [0.09, 0.17, 0.31, 0.46], flutter: 0 },
    cavern: { rt: 5.5, lp: 2500, early: [0.05, 0.12, 0.2], flutter: 0 },
    room: { rt: 0.5, lp: 7000, early: [0.004, 0.009], flutter: 0 },
  }[space]
  const ch = (): Mono => {
    const n = sec(spec.rt * 1.2)
    let y: Mono = new Float32Array(n)
    const k = Math.log(1000) / spec.rt
    for (let i = 0; i < n; i++) y[i] = (rnd() * 2 - 1) * Math.exp((-k * i) / SR) * Math.min(1, i / sec(0.01))
    y = filter(y, "lowpass", spec.lp, 0.5)
    for (const e of spec.early) {
      const i = sec(e * (0.9 + rnd() * 0.2))
      if (i < n) y[i]! += 0.6 * Math.exp(-k * e) * (rnd() < 0.5 ? -1 : 1)
    }
    if (spec.flutter) for (let t = spec.flutter, a = 0.5; t < spec.rt; t += spec.flutter, a *= 0.82) y[sec(t)]! += a
    let e2 = 0
    for (const v of y) e2 += v * v
    return gain(y, 1 / Math.sqrt(e2))
  }
  return [ch(), ch()]
}

/** Wet/dry convolution reverb into stereo. */
export function reverb(x: Mono | Stereo, space: Space, wet: number, rnd: Rng, dry = 1): Stereo {
  const ir = impulse(space, rnd)
  const m = Array.isArray(x) ? x : ([x, x] as Stereo)
  const l = convolve(m[0], ir[0])
  const r = convolve(m[1], ir[1])
  const n = l.length
  const L = new Float32Array(n)
  const R = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    L[i] = (m[0][i] ?? 0) * dry + l[i]! * wet
    R[i] = (m[1][i] ?? 0) * dry + r[i]! * wet
  }
  return [L, R]
}

/** Reverse-reverb swell: the reverb tail arrives before the sound. */
export function reverseSwell(x: Mono, space: Space, rnd: Rng): Mono {
  return reverse(toMono(reverb(reverse(x), space, 1, rnd, 0)))
}

export function stereoGain(s: Stereo, g: number): Stereo {
  return [gain(s[0], g), gain(s[1], g)]
}

/** Trims trailing near-silence and peak-normalises a stereo mix. */
export function finish(s: Stereo, o: { tail?: number; peak?: number } = {}): Stereo {
  let m = 0
  for (const c of s) for (const v of c) m = Math.max(m, Math.abs(v))
  const th = m * 10 ** (-(o.tail ?? 60) / 20)
  let end = s[0].length
  while (end > 1 && Math.abs(s[0][end - 1]!) < th && Math.abs(s[1][end - 1]!) < th) end--
  const g = m > 0 ? (o.peak ?? 0.89) / m : 1
  const out: Stereo = [s[0].slice(0, end), s[1].slice(0, end)]
  const f = Math.min(end, sec(0.05))
  for (const c of out) {
    for (let i = 0; i < c.length; i++) c[i]! *= g
    for (let i = 0; i < f; i++) c[c.length - 1 - i]! *= i / f
  }
  return out
}
