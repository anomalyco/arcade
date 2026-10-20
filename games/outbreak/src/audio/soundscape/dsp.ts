import { mulberry32 } from "@arcade/kit/sim/rng"

/**
 * Procedural DSP for the soundscape: every sound is synthesized here into mono PCM, deterministically from a seed, so
 * the layer ships no audio files and nothing in it can be anyone's copyrighted recording. Plain loops over typed
 * arrays (no Web Audio), so the game bakes the same buffers the offline reel renders.
 */

export const TAU = Math.PI * 2

/**
 * Two-pole resonator (a single ringing mode): `y = x + 2r cos(w) y1 - r² y2`, bandwidth from the decay time. Scaled by
 * `sin(w)` so an impulse rings at amplitude `gain` whatever the pitch (a raw resonator rings 1/sin(w) louder, which
 * buries every high mode under the low ones).
 */
export class Mode {
  private a1 = 0
  private a2 = 0
  private y1 = 0
  private y2 = 0
  private g = 1
  private norm = 1
  constructor(sr: number, hz: number, decaySeconds: number, gain = 1) {
    this.set(sr, hz, decaySeconds, gain)
  }
  set(sr: number, hz: number, decaySeconds: number, gain = this.g): void {
    const r = Math.exp(-6.9078 / (Math.max(0.002, decaySeconds) * sr))
    const w = (TAU * Math.min(hz, sr * 0.49)) / sr
    this.a1 = 2 * r * Math.cos(w)
    this.a2 = -r * r
    this.g = gain
    this.norm = Math.sin(w)
  }
  tick(x: number): number {
    const y = x + this.a1 * this.y1 + this.a2 * this.y2
    this.y2 = this.y1
    this.y1 = y
    return y * this.g * this.norm
  }
}

export type BiquadKind = "lowpass" | "highpass" | "bandpass"

/** RBJ biquad (transposed direct form II). `set` can be called mid-buffer for swept filters. */
export class Biquad {
  private b0 = 1
  private b1 = 0
  private b2 = 0
  private a1 = 0
  private a2 = 0
  private z1 = 0
  private z2 = 0
  constructor(
    private readonly sr: number,
    private readonly kind: BiquadKind,
    hz: number,
    q = 0.707,
  ) {
    this.set(hz, q)
  }
  set(hz: number, q = 0.707): void {
    const w = (TAU * Math.max(10, Math.min(hz, this.sr * 0.45))) / this.sr
    const cw = Math.cos(w)
    const alpha = Math.sin(w) / (2 * Math.max(0.05, q))
    const a0 = 1 + alpha
    if (this.kind === "lowpass") {
      this.b0 = (1 - cw) / 2 / a0
      this.b1 = (1 - cw) / a0
      this.b2 = this.b0
    } else if (this.kind === "highpass") {
      this.b0 = (1 + cw) / 2 / a0
      this.b1 = -(1 + cw) / a0
      this.b2 = this.b0
    } else {
      this.b0 = alpha / a0
      this.b1 = 0
      this.b2 = -alpha / a0
    }
    this.a1 = (-2 * cw) / a0
    this.a2 = (1 - alpha) / a0
  }
  tick(x: number): number {
    const y = this.b0 * x + this.z1
    this.z1 = this.b1 * x - this.a1 * y + this.z2
    this.z2 = this.b2 * x - this.a2 * y
    return y
  }
}

/** Filters `buf` in place. */
export function filter(buf: Float32Array, f: { tick(x: number): number }): Float32Array {
  for (let i = 0; i < buf.length; i++) buf[i] = f.tick(buf[i]!)
  return buf
}

export const white = (rand: () => number) => rand() * 2 - 1

/** Value noise in 0..1, smooth in `t`: slow drifts for pitch, wind and gust curves. */
export function smoothNoise(t: number, seed: number): number {
  const i = Math.floor(t)
  const f = t - i
  const u = f * f * (3 - 2 * f)
  const h = (n: number) => {
    let x = Math.imul((n + seed * 7919) | 0, 0x2c1b3c6d) ^ 0x297a2d39
    x = Math.imul(x ^ (x >>> 15), 0x85ebca6b)
    x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35)
    return ((x ^ (x >>> 16)) >>> 0) / 4294967296
  }
  return h(i) * (1 - u) + h(i + 1) * u
}

/**
 * Makes a seamless loop from a buffer rendered `xfade` samples longer than the loop: the overrun is crossfaded into
 * the head with equal power, so noise beds do not dip or click at the seam.
 */
export function loopify(src: Float32Array, xfade: number): Float32Array {
  const n = src.length - xfade
  const out = new Float32Array(n)
  out.set(src.subarray(0, n))
  for (let i = 0; i < xfade; i++) {
    const t = i / xfade
    out[i] = src[i]! * Math.sin(t * Math.PI * 0.5) + src[n + i]! * Math.cos(t * Math.PI * 0.5)
  }
  return out
}

/** Scales `buf` so its loudest 50 ms window sits at `rmsDb` dBFS, then caps the peak at -1 dBFS. */
export function normalize(buf: Float32Array, sr: number, rmsDb = -20): Float32Array {
  const win = Math.max(1, Math.round(sr * 0.05))
  let best = 0
  for (let s = 0; s < buf.length; s += win >> 1) {
    let acc = 0
    const e = Math.min(buf.length, s + win)
    for (let i = s; i < e; i++) acc += buf[i]! * buf[i]!
    best = Math.max(best, acc / win)
  }
  let peak = 0
  for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]!))
  if (best <= 0 || peak <= 0) return buf
  const k = Math.min(10 ** (rmsDb / 20) / Math.sqrt(best), 0.89 / peak)
  for (let i = 0; i < buf.length; i++) buf[i]! *= k
  return buf
}

/** Short linear fades at both ends so one-shots never click. */
export function edges(buf: Float32Array, sr: number, inSeconds = 0.002, outSeconds = 0.01): Float32Array {
  const a = Math.min(buf.length, Math.round(inSeconds * sr))
  const b = Math.min(buf.length, Math.round(outSeconds * sr))
  for (let i = 0; i < a; i++) buf[i]! *= i / a
  for (let i = 0; i < b; i++) buf[buf.length - 1 - i]! *= i / b
  return buf
}

/** Adds an impulse-excited bank of modes into `out` at `start` (samples): a struck object. */
export function strike(
  out: Float32Array,
  sr: number,
  start: number,
  modes: readonly (readonly [hz: number, decay: number, gain: number])[],
  amp: number,
  rand: () => number,
  noiseMs = 1.2,
  length = Math.round(sr * Math.max(...modes.map((m) => m[1]))),
): void {
  const bank = modes.map(([hz, decay, gain]) => new Mode(sr, hz, decay, gain))
  const exc = Math.max(1, Math.round((noiseMs / 1000) * sr))
  const end = Math.min(out.length, start + length)
  for (let i = start; i < end; i++) {
    const k = i - start
    const x = k < exc ? white(rand) * (1 - k / exc) * amp : 0
    let y = 0
    for (const m of bank) y += m.tick(x)
    out[i]! += y
  }
}

/** Bubble resonance (a drip landing in water): a decaying sine whose pitch rises as the cavity closes. */
export function bubble(out: Float32Array, sr: number, start: number, hz: number, rise: number, decay: number, amp: number): void {
  const n = Math.min(out.length - start, Math.round(decay * 7 * sr))
  let phase = 0
  for (let k = 0; k < n; k++) {
    const t = k / sr
    const f = hz * (1 + rise * Math.min(1, t / (decay * 2.5)))
    phase += (TAU * f) / sr
    const env = Math.exp(-t / decay) * Math.min(1, k / (0.0006 * sr))
    out[start + k]! += Math.sin(phase) * env * amp
  }
}

const buffer = (sr: number, seconds: number) => new Float32Array(Math.max(1, Math.round(sr * seconds)))
const at = (sr: number, seconds: number) => Math.round(sr * seconds)

// ---------------------------------------------------------------------------------------------------------------
// Interiors
// ---------------------------------------------------------------------------------------------------------------

function escapement(out: Float32Array, sr: number, start: number, scale: number, rand: () => number, amp = 1): void {
  // The pallet hits the escape wheel (a bright click), the wheel recoils a few ms later (a softer one), and the case
  // answers with a short wooden knock underneath.
  const hi: [number, number, number][] = [
    [3150 * scale, 0.018, 1],
    [4890 * scale, 0.012, 0.7],
    [7020 * scale, 0.007, 0.4],
  ]
  strike(out, sr, start, hi, 0.5 * amp, rand, 0.6)
  strike(out, sr, start + at(sr, 0.0062), hi, 0.18 * amp, rand, 0.4)
  strike(out, sr, start, [[640 * scale, 0.025, 1], [1210 * scale, 0.018, 0.6]], 0.3 * amp, rand, 1.5)
}

/** Clock tick-tock, a 2 s loop (tick at 0, tock at 1 s). Playback rate sets the size: 0.6 a long-case clock. */
export function clockTick(sr: number, seed = 1): Float32Array {
  const rand = mulberry32(seed)
  const out = buffer(sr, 2)
  escapement(out, sr, at(sr, 0.004), 1, rand)
  escapement(out, sr, at(sr, 1.004), 0.86, rand, 0.82)
  return normalize(out, sr, -20)
}

/**
 * A clock that limps: a 4 s loop with an uneven beat (tick, a late tock, a skipped beat, a double tick). Nothing in
 * town explains it.
 */
export function clockLimp(sr: number, seed = 2): Float32Array {
  const rand = mulberry32(seed)
  const out = buffer(sr, 4)
  const beats: [number, number, number][] = [
    [0.004, 1, 1],
    [1.18, 0.86, 0.8],
    [2.004, 1, 0.9],
    [3.004, 0.86, 0.75],
    [3.16, 1, 0.45],
  ]
  for (const [t, s, a] of beats) escapement(out, sr, at(sr, t), s, rand, a)
  return normalize(out, sr, -20)
}

/** One strike of a mantel clock's coiled gong: inharmonic rod partials with a slow beat between two close copies. */
export function clockChime(sr: number, seed = 3): Float32Array {
  const rand = mulberry32(seed)
  const out = buffer(sr, 4)
  const f = 311
  strike(
    out,
    sr,
    0,
    [
      [f, 3.4, 1],
      [f * 1.003, 3.2, 0.7],
      [f * 2.76, 1.7, 0.45],
      [f * 5.4, 0.8, 0.22],
      [f * 8.93, 0.35, 0.08],
    ],
    0.8,
    rand,
    2,
  )
  return normalize(edges(out, sr, 0.001, 0.2), sr, -18)
}

/** A drop from a tap into a steel sink: a tick on the steel and a small rising plink. */
export function tapDrip(sr: number, seed = 4): Float32Array {
  const rand = mulberry32(seed)
  const out = buffer(sr, 0.16)
  bubble(out, sr, 0, 1180, 0.55, 0.011, 1)
  strike(out, sr, 0, [[2900, 0.02, 0.4], [4600, 0.012, 0.25]], 0.25, rand, 0.4)
  return normalize(edges(out, sr, 0.0005, 0.02), sr, -18)
}

/** A gutter dripping onto a wet path after rain: a lower plop with a splat. */
export function gutterDrip(sr: number, seed = 5): Float32Array {
  const rand = mulberry32(seed)
  const out = buffer(sr, 0.22)
  bubble(out, sr, 0, 640, 0.4, 0.02, 1)
  const splat = new Biquad(sr, "bandpass", 1800, 0.9)
  for (let i = 0; i < at(sr, 0.03); i++) out[i]! += splat.tick(white(rand)) * Math.exp(-i / (0.006 * sr)) * 0.9
  return normalize(edges(out, sr, 0.0005, 0.03), sr, -18)
}

/** A fridge running: 60 Hz mains hum and its harmonics with the compressor's whir, a seamless 4 s loop. */
export function fridgeHum(sr: number, seed = 6): Float32Array {
  const rand = mulberry32(seed)
  const seconds = 4
  const xf = at(sr, 0.25)
  const src = new Float32Array(at(sr, seconds) + xf)
  const whir = new Biquad(sr, "bandpass", 620, 2.5)
  const rattleBp = new Biquad(sr, "bandpass", 2400, 4)
  // Integer cycles of every partial in 4 s, so the tonal part loops on its own; only the whir needs the crossfade.
  const partials: [number, number][] = [
    [60, 0.15],
    [120, 0.8],
    [180, 0.2],
    [240, 0.5],
    [360, 0.3],
    [480, 0.14],
    [600, 0.06],
  ]
  for (let i = 0; i < src.length; i++) {
    const t = i / sr
    let y = 0
    for (const [hz, a] of partials) y += Math.sin(TAU * hz * t) * a
    const breathe = 0.75 + 0.25 * Math.sin((TAU * t) / seconds)
    y += whir.tick(white(rand)) * 3.2 * breathe
    y += rattleBp.tick(white(rand)) * 0.5 * (0.5 + 0.5 * Math.sin(TAU * 7.5 * t))
    src[i] = y
  }
  return normalize(loopify(src, xf), sr, -22)
}

/** The fridge dying when the power goes: a clunk, the hum sagging down in pitch, and a last rattle of the case. */
export function fridgeOff(sr: number, seed = 7): Float32Array {
  const rand = mulberry32(seed)
  const out = buffer(sr, 1.8)
  let phase = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / sr
    const f = 120 * (0.45 + 0.55 * Math.exp(-t / 0.35))
    phase += (TAU * f) / sr
    const env = Math.exp(-t / 0.4) * Math.min(1, t / 0.004)
    out[i]! += (Math.sin(phase) + 0.35 * Math.sin(2 * phase) + 0.12 * Math.sin(3 * phase)) * env * 0.6
  }
  strike(out, sr, at(sr, 0.02), [[140, 0.1, 0.7], [420, 0.07, 0.9], [1300, 0.03, 0.5]], 1.2, rand, 3)
  for (let k = 0; k < 6; k++) {
    strike(out, sr, at(sr, 0.62 + k * 0.055 + rand() * 0.015), [[1900 + rand() * 600, 0.02, 1], [3300, 0.01, 0.4]], 0.6 * (1 - k / 7), rand, 0.5)
  }
  return normalize(edges(out, sr, 0.001, 0.08), sr, -18)
}

/** Wood under stress (a floorboard or a door frame settling): stick-slip pulses through the board's resonances. */
export function creak(sr: number, seed = 8): Float32Array {
  const rand = mulberry32(seed)
  const len = 0.45 + rand() * 0.7
  const out = buffer(sr, len + 0.1)
  const scale = 0.8 + rand() * 0.45
  const bank = [
    new Mode(sr, 380 * scale, 0.05, 1),
    new Mode(sr, 830 * scale, 0.04, 0.8),
    new Mode(sr, 1470 * scale, 0.03, 0.5),
    new Mode(sr, 2650 * scale, 0.02, 0.25),
  ]
  const base = 70 + rand() * 120
  const nseed = Math.floor(rand() * 1000)
  let phase = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / sr
    const u = t / len
    const env = u >= 1 ? 0 : Math.sin(Math.PI * Math.pow(u, 0.7)) ** 1.5
    const rate = base * (0.55 + 0.9 * smoothNoise(t * 9, nseed))
    phase += rate / sr
    let x = 0
    if (phase >= 1) {
      phase -= 1
      x = (0.5 + rand() * 0.5) * env
    }
    let y = 0
    for (const m of bank) y += m.tick(x)
    out[i] = y
  }
  return normalize(edges(out, sr, 0.004, 0.05), sr, -20)
}

/** A house settling: a dull knock in a beam, sometimes answered by a tick. */
export function settle(sr: number, seed = 9): Float32Array {
  const rand = mulberry32(seed)
  const out = buffer(sr, 0.7)
  strike(out, sr, 0, [[164, 0.16, 1], [392, 0.1, 0.8], [880, 0.05, 0.5], [1730, 0.03, 0.2]], 1, rand, 4)
  if (rand() < 0.7) strike(out, sr, at(sr, 0.25 + rand() * 0.2), [[1450, 0.03, 1], [2900, 0.015, 0.4]], 0.12, rand, 0.6)
  return normalize(edges(out, sr, 0.002, 0.08), sr, -19)
}

/** Water hammer in the wall: three to five knocks on a copper pipe, slowing as the pressure settles. */
export function pipeKnock(sr: number, seed = 10): Float32Array {
  const rand = mulberry32(seed)
  const out = buffer(sr, 1.8)
  const n = 3 + Math.floor(rand() * 3)
  let t = 0.01
  for (let k = 0; k < n; k++) {
    const a = (1 - k / (n + 1)) * (0.7 + rand() * 0.3)
    strike(
      out,
      sr,
      at(sr, t),
      [
        [236, 0.3, 1],
        [598, 0.18, 0.9],
        [1215, 0.09, 0.6],
        [2070, 0.05, 0.3],
      ],
      a,
      rand,
      1.5,
    )
    t += 0.16 + k * 0.05 + rand() * 0.06
  }
  // Heard through plaster.
  filter(out, new Biquad(sr, "lowpass", 2300, 0.6))
  return normalize(edges(out, sr, 0.001, 0.1), sr, -19)
}

/** Wind whistling through a gap in a broken or open window: a narrow, wandering band over a low rush, 6 s loop. */
export function windWhistle(sr: number, seed = 11): Float32Array {
  const rand = mulberry32(seed)
  const seconds = 6
  const xf = at(sr, 0.5)
  const src = new Float32Array(at(sr, seconds) + xf)
  const tone = new Biquad(sr, "bandpass", 900, 22)
  const edge = new Biquad(sr, "bandpass", 1400, 16)
  const rush = new Biquad(sr, "lowpass", 380, 0.6)
  for (let i = 0; i < src.length; i++) {
    const t = i / sr
    if ((i & 31) === 0) {
      const c = 880 + 210 * Math.sin((TAU * t) / seconds) + 70 * Math.sin((TAU * 3 * t) / seconds + 1.3)
      tone.set(c, 22)
      edge.set(c * 1.52, 16)
    }
    const gust = 0.55 + 0.45 * Math.sin((TAU * 2 * t) / seconds + 0.4) ** 2
    const n = white(rand)
    src[i] = tone.tick(n) * 2.2 * gust * gust + edge.tick(n) * 0.7 * gust ** 3 + rush.tick(white(rand)) * 0.5 * gust
  }
  return normalize(loopify(src, xf), sr, -22)
}

/** A curtain lifting in a draught: soft cloth flutter. */
export function curtain(sr: number, seed = 12): Float32Array {
  const rand = mulberry32(seed)
  const len = 0.8 + rand() * 0.6
  const out = buffer(sr, len)
  const bp = new Biquad(sr, "bandpass", 850, 0.6)
  const lp = new Biquad(sr, "lowpass", 2600, 0.7)
  const fseed = Math.floor(rand() * 1000)
  let ph = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / sr
    const u = t / len
    const env = Math.sin(Math.PI * Math.min(1, u)) ** 2
    ph += (TAU * (6 + 6 * smoothNoise(t * 5, fseed))) / sr
    const flap = 0.35 + 0.65 * Math.abs(Math.sin(ph)) ** 3
    out[i] = lp.tick(bp.tick(white(rand))) * env * flap
  }
  return normalize(edges(out, sr, 0.01, 0.05), sr, -22)
}

// An original waltz in A minor for a wind-up music box (MIDI note, beats); the spring runs out mid-phrase.
const MUSIC_BOX_TUNE: readonly (readonly [number, number])[] = [
  [81, 1], [84, 1], [88, 1], [86, 2], [84, 1], [83, 1], [84, 1], [86, 1], [81, 3],
  [79, 1], [81, 1], [83, 1], [84, 2], [83, 1], [79, 1], [80, 1], [83, 1], [76, 3],
  [88, 1], [89, 1], [88, 1], [86, 2], [84, 1], [86, 1], [84, 1], [83, 1], [81, 2], [76, 1],
  [77, 1], [81, 1], [84, 1], [83, 1.5], [81, 0.5], [80, 1], [81, 3],
  [81, 1], [84, 1], [88, 1], [86, 2], [84, 1],
]
const MUSIC_BOX_BASS: readonly number[] = [57, 62, 64, 57, 57, 64, 64, 57, 64, 62, 57, 62, 57, 57]

const midiHz = (m: number) => 440 * 2 ** ((m - 69) / 12)

function tine(out: Float32Array, sr: number, start: number, hz: number, amp: number, rand: () => number): void {
  // A steel comb tine: the cantilever's fundamental with its far-off second mode, a hint of octave from the pin, and
  // a tick as the pin lets go. High notes die faster.
  const decay = Math.max(0.35, 1.5 - (hz - 600) / 2200)
  strike(
    out,
    sr,
    start,
    [
      [hz, decay, 1],
      [hz * 2.0, decay * 0.4, 0.06],
      [hz * 6.27, decay * 0.18, 0.12],
    ],
    amp,
    rand,
    0.8,
    Math.round(sr * decay * 1.6),
  )
}

/** A music box playing an original waltz that slows as the spring unwinds and stops mid-phrase (~17 s). */
export function musicBox(sr: number, seed = 13): Float32Array {
  const rand = mulberry32(seed)
  const out = buffer(sr, 18)
  let beat = 0.34
  let t = 0.05
  let beats = 0
  const total = MUSIC_BOX_TUNE.reduce((a, [, b]) => a + b, 0)
  for (let k = 0; k < MUSIC_BOX_TUNE.length; k++) {
    const [note, len] = MUSIC_BOX_TUNE[k]!
    // The spring: tempo sags over the last third, then the comb stops between notes.
    const sag = Math.max(0, beats / total - 0.62) / 0.38
    beat = 0.34 * (1 + 1.6 * sag * sag)
    if (beats % 3 === 0) {
      const bass = MUSIC_BOX_BASS[Math.floor(beats / 3) % MUSIC_BOX_BASS.length]!
      tine(out, sr, at(sr, t), midiHz(bass + 12), 0.32, rand)
    }
    tine(out, sr, at(sr, t + rand() * 0.006), midiHz(note), 0.55 + rand() * 0.1, rand)
    t += len * beat
    beats += len
    if (t > 17) break
  }
  // A tiny box on a shelf: no lows, a little wooden body.
  filter(out, new Biquad(sr, "highpass", 380, 0.7))
  return normalize(edges(out, sr, 0.001, 0.3), sr, -20)
}

/** One ring of an old bell telephone: the clapper hammering two bells at 20 Hz for 2 s, then ringing out. */
export function phoneRing(sr: number, seed = 14): Float32Array {
  const rand = mulberry32(seed)
  const out = buffer(sr, 2.5)
  const a = [new Mode(sr, 1048, 0.32, 1), new Mode(sr, 2655, 0.14, 0.5), new Mode(sr, 4120, 0.07, 0.25)]
  const b = [new Mode(sr, 1262, 0.3, 1), new Mode(sr, 3049, 0.13, 0.45), new Mode(sr, 4710, 0.06, 0.2)]
  const step = sr / 40
  for (let i = 0; i < out.length; i++) {
    const t = i / sr
    const k = Math.floor(i / step)
    const hit = t < 2 && i - Math.floor(k * step) === 0
    const x = hit ? 0.6 + rand() * 0.2 : 0
    let y = 0
    for (const m of a) y += m.tick(k % 2 === 0 ? x : 0)
    for (const m of b) y += m.tick(k % 2 === 1 ? x : 0)
    out[i] = y
  }
  return normalize(edges(out, sr, 0.001, 0.15), sr, -18)
}

/** A formant voice synthesized from nothing: syllables of vowel formants on a glottal buzz. Never words. */
function babble(out: Float32Array, sr: number, start: number, seconds: number, rand: () => number, f0 = 128): void {
  const vowels: readonly [number, number, number][] = [
    [730, 1090, 2440],
    [530, 1840, 2480],
    [390, 1990, 2550],
    [570, 840, 2410],
    [440, 1020, 2240],
    [660, 1720, 2410],
  ]
  const f = [new Biquad(sr, "bandpass", 700, 6), new Biquad(sr, "bandpass", 1200, 8), new Biquad(sr, "bandpass", 2400, 10)]
  const n = Math.round(seconds * sr)
  let syl = 0
  let sylLen = 1
  let target = vowels[0]!
  let cur: [number, number, number] = [...target]
  let ph = 0
  let word = 1
  for (let k = 0; k < n && start + k < out.length; k++) {
    const t = k / sr
    if (--syl <= 0) {
      sylLen = Math.round((0.09 + rand() * 0.12) * sr)
      syl = sylLen
      target = vowels[Math.floor(rand() * vowels.length)]!
      word = rand() < 0.16 ? 0 : 1
    }
    const u = 1 - syl / sylLen
    const env = word * Math.sin(Math.PI * u) ** 0.8
    if ((k & 15) === 0) {
      for (let j = 0; j < 3; j++) cur[j] = cur[j]! + (target[j]! - cur[j]!) * 0.12
      f[0]!.set(cur[0], 6)
      f[1]!.set(cur[1], 8)
      f[2]!.set(cur[2], 10)
    }
    const pitch = f0 * (1 + 0.12 * Math.sin(t * 1.7) - 0.18 * (t / seconds)) * (1 + 0.04 * Math.sin(t * 5.3))
    ph += pitch / sr
    if (ph >= 1) ph -= 1
    const glottal = (ph < 0.4 ? Math.sin((Math.PI * ph) / 0.4) : 0) - 0.25 + white(rand) * 0.05
    out[start + k]! += (f[0]!.tick(glottal) + f[1]!.tick(glottal) * 0.6 + f[2]!.tick(glottal) * 0.25) * env
  }
}

/**
 * An answering machine taking a call in an empty house: the relay clicks, the tape motor, the beep, and then a
 * caller's voice too small and far away to make out, and the click as it stops.
 */
export function answeringMachine(sr: number, seed = 15): Float32Array {
  const rand = mulberry32(seed)
  const out = buffer(sr, 7.2)
  strike(out, sr, at(sr, 0.02), [[2100, 0.015, 1], [3900, 0.01, 0.5]], 0.5, rand, 0.4)
  const motor = new Biquad(sr, "bandpass", 420, 3)
  for (let i = at(sr, 0.05); i < out.length - at(sr, 0.3); i++) out[i]! += motor.tick(white(rand)) * 0.05
  const b0 = at(sr, 0.7)
  for (let k = 0; k < at(sr, 0.45); k++) {
    const env = Math.min(1, k / (0.004 * sr), (at(sr, 0.45) - k) / (0.004 * sr))
    out[b0 + k]! += Math.sin((TAU * 1000 * k) / sr) * 0.5 * env
  }
  babble(out, sr, at(sr, 1.5), 5.0, rand, 118 + rand() * 30)
  strike(out, sr, out.length - at(sr, 0.25), [[1900, 0.015, 1], [3600, 0.01, 0.5]], 0.45, rand, 0.4)
  // Tape hiss and a two-inch speaker.
  const hiss = new Biquad(sr, "highpass", 3000, 0.7)
  for (let i = at(sr, 0.05); i < out.length - at(sr, 0.3); i++) out[i]! += hiss.tick(white(rand)) * 0.012
  filter(out, new Biquad(sr, "highpass", 340, 0.7))
  filter(out, new Biquad(sr, "lowpass", 3200, 0.8))
  return normalize(edges(out, sr, 0.002, 0.05), sr, -21)
}

// ---------------------------------------------------------------------------------------------------------------
// Exteriors and the distance
// ---------------------------------------------------------------------------------------------------------------

/** Adds discrete street echoes (`[delay s, gain, lowpass Hz]`) of `buf` into itself. */
function echoes(buf: Float32Array, sr: number, taps: readonly (readonly [number, number, number])[]): void {
  const dry = new Float32Array(buf)
  for (const [delay, gain, hz] of taps) {
    const d = at(sr, delay)
    const lp = new Biquad(sr, "lowpass", hz, 0.6)
    for (let i = 0; i + d < buf.length; i++) buf[i + d]! += lp.tick(dry[i]!) * gain
  }
}

/** A police siren far across town: one rise-and-fall wail, 6 s loop, already rounded off by distance. */
export function sirenWail(sr: number, seed = 16): Float32Array {
  const seconds = 6
  const xf = at(sr, 0.4)
  const src = new Float32Array(at(sr, seconds) + xf)
  void seed
  let ph = 0
  for (let i = 0; i < src.length; i++) {
    const t = (i / sr) % seconds
    // Spin up fast, wind down slow, like a motor-driven wail.
    const u = t < 2.4 ? 1 - (1 - t / 2.4) ** 2 : 1 - ((t - 2.4) / 3.6) ** 1.3
    const f = 640 + 760 * Math.max(0, u)
    ph += (TAU * f) / sr
    let y = 0
    for (let h = 1; h <= 6; h++) y += Math.sin(ph * h) / h ** 1.35
    src[i] = y
  }
  filter(src, new Biquad(sr, "lowpass", 2100, 0.7))
  filter(src, new Biquad(sr, "highpass", 300, 0.7))
  echoes(src, sr, [
    [0.19, 0.35, 1400],
    [0.43, 0.22, 1100],
    [0.81, 0.12, 900],
  ])
  return normalize(loopify(src, xf), sr, -20)
}

/** A gunshot blocks away: a dull pop, then the town answering it back from walls and across yards. */
export function gunshotFar(sr: number, seed = 17, kind: "pistol" | "shotgun" | "rifle" = "pistol"): Float32Array {
  const rand = mulberry32(seed)
  const out = buffer(sr, 2.7)
  const cut = kind === "rifle" ? 3200 : kind === "shotgun" ? 900 : 1500
  const lp = new Biquad(sr, "lowpass", cut, 0.7)
  const burst = at(sr, kind === "shotgun" ? 0.012 : 0.006)
  for (let i = 0; i < burst * 4; i++) out[i]! += lp.tick(white(rand)) * Math.exp(-i / burst)
  const thumpHz = kind === "shotgun" ? 52 : 74
  for (let i = 0; i < at(sr, 0.25); i++) {
    const t = i / sr
    out[i]! += Math.sin(TAU * thumpHz * t * (1 - t)) * Math.exp(-t / (kind === "shotgun" ? 0.09 : 0.05)) * 0.12
  }
  // The body of the report as it reaches you: a low-mid boom, not sub.
  const body = new Biquad(sr, "bandpass", kind === "shotgun" ? 260 : 420, 0.9)
  for (let i = 0; i < burst * 6; i++) out[i]! += body.tick(white(rand)) * Math.exp(-i / (burst * 1.5)) * 2.2
  const taps: [number, number, number][] = []
  let d = 0.11 + rand() * 0.08
  for (let k = 0; k < 9; k++) {
    taps.push([d, 0.55 * Math.exp(-k / 3.2) * (0.6 + rand() * 0.4), Math.max(500, cut * Math.exp(-k / 4))])
    d += 0.08 + rand() * 0.22
  }
  echoes(out, sr, taps)
  const tail = new Biquad(sr, "lowpass", 520, 0.6)
  for (let i = 0; i < out.length; i++) out[i]! += tail.tick(white(rand)) * 0.05 * Math.exp(-i / (0.9 * sr)) * Math.min(1, i / (0.05 * sr))
  filter(out, new Biquad(sr, "highpass", 110, 0.7))
  return normalize(edges(out, sr, 0.0005, 0.3), sr, -16)
}

/** A car alarm a few streets over: whoops, hi-lo, a warble and a wail, an 8 s loop through a cheap horn. */
export function carAlarmFar(sr: number, seed = 18): Float32Array {
  const seconds = 8
  const xf = at(sr, 0.05)
  const src = new Float32Array(at(sr, seconds) + xf)
  void seed
  let ph = 0
  for (let i = 0; i < src.length; i++) {
    const t = (i / sr) % seconds
    let f: number
    let am = 1
    if (t < 2) f = 620 + 980 * ((t % 0.5) / 0.5) ** 0.8
    else if (t < 4) f = Math.floor((t - 2) / 0.25) % 2 === 0 ? 1250 : 900
    else if (t < 6) {
      f = 1420
      am = 0.5 + 0.5 * Math.sign(Math.sin(TAU * 11 * t))
    } else f = 900 + 420 * Math.sin((Math.PI * (t - 6)) / 2)
    ph += f / sr
    const sq = (ph % 1) < 0.5 ? 1 : -1
    src[i] = sq * am
  }
  filter(src, new Biquad(sr, "bandpass", 1500, 1.1))
  filter(src, new Biquad(sr, "lowpass", 2300, 0.7))
  echoes(src, sr, [
    [0.23, 0.3, 1300],
    [0.52, 0.16, 1000],
  ])
  return normalize(loopify(src, xf), sr, -20)
}

/** One tube of a wind chime: the free bar's inharmonic partials and a metallic tap. Pitched by playback rate. */
export function chimeTube(sr: number, seed = 19): Float32Array {
  const rand = mulberry32(seed)
  const out = buffer(sr, 3)
  const f = 1046
  strike(
    out,
    sr,
    0,
    [
      [f, 2.6, 1],
      [f * 1.0021, 2.4, 0.5],
      [f * 2.756, 1.4, 0.55],
      [f * 5.404, 0.7, 0.3],
      [f * 8.933, 0.35, 0.12],
    ],
    0.7,
    rand,
    0.5,
  )
  return normalize(edges(out, sr, 0.0005, 0.25), sr, -18)
}

/** Rain on a car: sparse pings off the panels, ticks on the glass and the odd drum of the roof, 4 s loop. */
export function rainMetal(sr: number, seed = 20): Float32Array {
  const rand = mulberry32(seed)
  const seconds = 4
  const xf = at(sr, 0.3)
  const src = new Float32Array(at(sr, seconds) + xf)
  const pings = Math.round(38 * (seconds + 0.3))
  for (let k = 0; k < pings; k++) {
    const s = Math.floor(rand() * (src.length - at(sr, 0.1)))
    const f = 1800 + rand() * 3600
    const a = 0.05 + rand() * rand() * 0.4
    strike(src, sr, s, [[f, 0.02 + rand() * 0.05, 1], [f * 1.58, 0.015, 0.5]], a, rand, 0.3, at(sr, 0.1))
    if (rand() < 0.12) strike(src, sr, s, [[210 + rand() * 160, 0.05, 1]], a * 0.8, rand, 1.5, at(sr, 0.2))
  }
  const hp = new Biquad(sr, "highpass", 5000, 0.7)
  for (let i = 0; i < src.length; i++) src[i]! += hp.tick(white(rand)) * 0.04 * (rand() < 0.03 ? 4 : 1)
  return normalize(loopify(src, xf), sr, -22)
}

/** Rain into puddles: bubble plinks, small splashes and a wet hiss, 4 s loop. */
export function rainPuddle(sr: number, seed = 21): Float32Array {
  const rand = mulberry32(seed)
  const seconds = 4
  const xf = at(sr, 0.3)
  const src = new Float32Array(at(sr, seconds) + xf)
  const drops = Math.round(22 * (seconds + 0.3))
  for (let k = 0; k < drops; k++) {
    const s = Math.floor(rand() * (src.length - at(sr, 0.15)))
    bubble(src, sr, s, 900 + rand() * 1800, 0.25 + rand() * 0.5, 0.006 + rand() * 0.016, 0.1 + rand() * rand() * 0.6)
  }
  const splash = new Biquad(sr, "bandpass", 3200, 1.2)
  const hiss = new Biquad(sr, "lowpass", 4500, 0.7)
  for (let i = 0; i < src.length; i++) {
    src[i]! += splash.tick(rand() < 0.012 ? white(rand) * 6 : 0) * 0.3 + hiss.tick(white(rand)) * 0.03
  }
  return normalize(loopify(src, xf), sr, -22)
}

/** Rain on leaves: a dense, soft patter in the canopy, swelling with the wind, 4 s loop. */
export function rainLeaves(sr: number, seed = 22): Float32Array {
  const rand = mulberry32(seed)
  const seconds = 4
  const xf = at(sr, 0.3)
  const src = new Float32Array(at(sr, seconds) + xf)
  const taps = [new Biquad(sr, "bandpass", 1800, 1.6), new Biquad(sr, "bandpass", 3300, 1.8), new Biquad(sr, "bandpass", 5200, 2)]
  const bed = new Biquad(sr, "highpass", 1500, 0.7)
  let burst = 0
  let amp = 0
  let which = 0
  for (let i = 0; i < src.length; i++) {
    const t = i / sr
    const swell = 0.7 + 0.3 * Math.sin((TAU * t) / seconds) ** 2
    if (burst <= 0 && rand() < 260 / sr) {
      burst = Math.round((0.001 + rand() * 0.002) * sr)
      amp = rand() * rand()
      which = Math.floor(rand() * 3)
    }
    const x = burst-- > 0 ? white(rand) * amp : 0
    let y = 0
    for (let j = 0; j < 3; j++) y += taps[j]!.tick(j === which ? x : 0)
    src[i] = (y + bed.tick(white(rand)) * 0.08) * swell
  }
  return normalize(loopify(src, xf), sr, -22)
}

/** Insects in the trees by day: a cicada's pulsed buzz swelling and dying away, with grasshopper ticks, 6 s loop. */
export function insectsDay(sr: number, seed = 23): Float32Array {
  const rand = mulberry32(seed)
  const seconds = 6
  const xf = at(sr, 0.4)
  const src = new Float32Array(at(sr, seconds) + xf)
  const buzz = new Biquad(sr, "bandpass", 4600, 3.5)
  const buzz2 = new Biquad(sr, "bandpass", 6900, 5)
  const tick = new Biquad(sr, "bandpass", 7600, 4)
  let ticks = 0
  for (let i = 0; i < src.length; i++) {
    const t = i / sr
    const u = (t % seconds) / seconds
    const swell = Math.sin(Math.PI * Math.min(1, u / 0.8)) ** 2 * (u < 0.8 ? 1 : 0)
    const pulse = Math.max(0, Math.sin(TAU * 72 * t)) ** 6
    const n = white(rand)
    let y = (buzz.tick(n) * 1.4 + buzz2.tick(n) * 0.5) * pulse * swell
    if (ticks <= 0 && rand() < 1.6 / sr) ticks = Math.round(sr * 0.35)
    if (ticks > 0) {
      ticks--
      const k = Math.round(sr * 0.35) - ticks
      y += tick.tick(k % Math.round(sr * 0.045) < sr * 0.004 ? white(rand) : 0) * 0.6
    }
    src[i] = y
  }
  return normalize(loopify(src, xf), sr, -22)
}

/** A tawny owl far off in the trees: a long hoot, a pause, then the quavering answer. */
export function owl(sr: number, seed = 24): Float32Array {
  const rand = mulberry32(seed)
  const out = buffer(sr, 4.4)
  const breath = new Biquad(sr, "bandpass", 420, 4)
  const note = (t0: number, len: number, f0: number, glide: number, quaver: number, amp: number) => {
    let ph = 0
    const s = at(sr, t0)
    for (let k = 0; k < at(sr, len) && s + k < out.length; k++) {
      const t = k / sr
      const u = t / len
      const env = Math.min(1, t / 0.07) * Math.min(1, (len - t) / 0.12) * (1 - 0.3 * u)
      const trem = quaver > 0 ? 0.6 + 0.4 * Math.sin(TAU * quaver * t) : 1
      const f = f0 * (1 - glide * u) * (1 + 0.006 * Math.sin(TAU * 5.5 * t))
      ph += (TAU * f) / sr
      out[s + k]! += (Math.sin(ph) + 0.1 * Math.sin(2 * ph) + breath.tick(white(rand)) * 0.6) * env * trem * amp
    }
  }
  note(0.05, 0.75, 430, 0.08, 0, 1)
  note(2.45, 0.14, 455, 0.05, 0, 0.6)
  note(2.75, 1.25, 445, 0.1, 13, 0.85)
  filter(out, new Biquad(sr, "lowpass", 1500, 0.7))
  return normalize(edges(out, sr, 0.005, 0.1), sr, -19)
}

// ---------------------------------------------------------------------------------------------------------------
// Sounds other features ask for (life, the dead's habits, the church)
// ---------------------------------------------------------------------------------------------------------------

/** A television left on in an empty room: a programme's voices and music too muffled to follow, 6 s loop. */
export function tvLeftOn(sr: number, seed = 25): Float32Array {
  const rand = mulberry32(seed)
  const seconds = 6
  const xf = at(sr, 0.4)
  const src = new Float32Array(at(sr, seconds) + xf)
  babble(src, sr, 0, 2.6, rand, 150)
  babble(src, sr, at(sr, 3.0), 3.7, rand, 105)
  // A jingle between the voices: a few soft organ chords.
  const chords = [
    [57, 60, 64],
    [55, 59, 62],
    [53, 57, 60],
  ]
  for (let c = 0; c < chords.length; c++) {
    const s = at(sr, 2.55 + c * 0.16)
    for (const m of chords[c]!) {
      const f = midiHz(m + 12)
      for (let k = 0; k < at(sr, 0.5) && s + k < src.length; k++) src[s + k]! += Math.sin((TAU * f * k) / sr) * 0.08 * Math.exp(-k / (0.25 * sr))
    }
  }
  const hiss = new Biquad(sr, "highpass", 4000, 0.7)
  for (let i = 0; i < src.length; i++) src[i]! += hiss.tick(white(rand)) * 0.01
  // A small cabinet speaker behind a wall.
  filter(src, new Biquad(sr, "highpass", 260, 0.7))
  filter(src, new Biquad(sr, "lowpass", 2600, 0.8))
  return normalize(loopify(src, xf), sr, -22)
}

/** Something small bolting through a shrub (a cat, a raccoon): a sharp rustle of leaves and twigs. */
export function rustle(sr: number, seed = 26): Float32Array {
  const rand = mulberry32(seed)
  const out = buffer(sr, 0.75)
  const leaf = new Biquad(sr, "bandpass", 3600, 0.9)
  for (let i = 0; i < out.length; i++) {
    const t = i / sr
    const env = Math.min(1, t / 0.02) * Math.exp(-t / 0.22)
    const grain = rand() < 0.04 ? 1 : 0.15
    out[i] = leaf.tick(white(rand)) * env * grain
  }
  for (let k = 0; k < 4; k++) strike(out, sr, at(sr, 0.02 + rand() * 0.35), [[1400 + rand() * 1500, 0.012, 1], [3900, 0.008, 0.5]], 0.25, rand, 0.5)
  return normalize(edges(out, sr, 0.002, 0.05), sr, -19)
}

/** A fox scurrying off: a quick patter of paws over leaves. */
export function scurry(sr: number, seed = 27): Float32Array {
  const rand = mulberry32(seed)
  const out = buffer(sr, 0.7)
  const paw = new Biquad(sr, "bandpass", 2300, 1.4)
  let t = 0.01
  let k = 0
  while (t < 0.6) {
    const s = at(sr, t)
    const a = (1 - t / 0.7) * (0.6 + rand() * 0.4)
    for (let i = 0; i < at(sr, 0.018) && s + i < out.length; i++) out[s + i]! += paw.tick(white(rand)) * a * Math.exp(-i / (0.004 * sr))
    t += k++ % 2 === 0 ? 0.035 : 0.075 + rand() * 0.02
  }
  return normalize(edges(out, sr, 0.001, 0.05), sr, -20)
}

/** A deer crashing away through the yards: hooves on turf and brush breaking. */
export function hooves(sr: number, seed = 28): Float32Array {
  const rand = mulberry32(seed)
  const out = buffer(sr, 1.6)
  let t = 0.02
  for (let k = 0; k < 7; k++) {
    strike(out, sr, at(sr, t), [[150 + rand() * 40, 0.06, 1], [420, 0.03, 0.6], [1100, 0.015, 0.3]], 0.9 * (1 - k / 9), rand, 2.5)
    if (k % 2 === 0) strike(out, sr, at(sr, t + 0.06), [[170 + rand() * 30, 0.05, 1], [460, 0.03, 0.5]], 0.6 * (1 - k / 9), rand, 2)
    t += 0.17 + rand() * 0.05
  }
  const brush = new Biquad(sr, "bandpass", 2800, 0.8)
  for (let i = 0; i < at(sr, 0.9); i++) out[i]! += brush.tick(white(rand)) * 0.35 * Math.exp(-i / (0.3 * sr)) * (rand() < 0.08 ? 1 : 0.2)
  return normalize(edges(out, sr, 0.002, 0.1), sr, -18)
}

/** The dead at a door: three slow, heavy blows with the flat of a hand on a panelled door. */
export function knock(sr: number, seed = 29): Float32Array {
  const rand = mulberry32(seed)
  const out = buffer(sr, 2.2)
  const times = [0.02, 0.62 + rand() * 0.1, 1.38 + rand() * 0.2]
  for (let k = 0; k < times.length; k++) {
    strike(
      out,
      sr,
      at(sr, times[k]!),
      [
        [96, 0.12, 1],
        [212, 0.09, 0.8],
        [455, 0.05, 0.55],
        [980, 0.025, 0.25],
      ],
      k === 1 ? 0.75 : 1,
      rand,
      6,
    )
  }
  filter(out, new Biquad(sr, "highpass", 70, 0.7))
  return normalize(edges(out, sr, 0.002, 0.1), sr, -18)
}

/** The dead at a stove: a pan knocked against the hob and something tinny falling over. */
export function pans(sr: number, seed = 30): Float32Array {
  const rand = mulberry32(seed)
  const out = buffer(sr, 1.8)
  strike(out, sr, at(sr, 0.02), [[620, 0.5, 1], [1490, 0.3, 0.7], [2710, 0.18, 0.5], [4130, 0.1, 0.3]], 0.7, rand, 1)
  let t = 0.55 + rand() * 0.2
  for (let k = 0; k < 4; k++) {
    strike(out, sr, at(sr, t), [[1850 + rand() * 900, 0.12, 1], [4300 + rand() * 900, 0.06, 0.5]], 0.35 * (1 - k / 5), rand, 0.6)
    t += 0.09 + rand() * 0.08
  }
  return normalize(edges(out, sr, 0.001, 0.15), sr, -19)
}

/** The dead in a bed: old box springs creaking under a slow weight shift. */
export function bedsprings(sr: number, seed = 31): Float32Array {
  const rand = mulberry32(seed)
  const out = buffer(sr, 1.6)
  for (const [t0, len] of [
    [0.05, 0.42],
    [0.75, 0.5],
  ] as const) {
    const s = at(sr, t0)
    const bank = [new Mode(sr, 880 + rand() * 120, 0.06, 1), new Mode(sr, 1930, 0.04, 0.6), new Mode(sr, 3150, 0.03, 0.3)]
    let ph = 0
    for (let k = 0; k < at(sr, len + 0.1) && s + k < out.length; k++) {
      const u = k / (len * sr)
      const env = u < 1 ? Math.sin(Math.PI * u) : 0
      ph += (140 + 90 * Math.sin(Math.PI * u)) / sr
      let x = 0
      if (ph >= 1) {
        ph -= 1
        x = env * (0.6 + rand() * 0.4)
      }
      let y = 0
      for (const m of bank) y += m.tick(x)
      out[s + k]! += y
    }
  }
  return normalize(edges(out, sr, 0.002, 0.08), sr, -20)
}

/** The dead leaning on a chain-link fence: the mesh jangling against its posts. */
export function fenceRattle(sr: number, seed = 32): Float32Array {
  const rand = mulberry32(seed)
  const out = buffer(sr, 1.3)
  for (let k = 0; k < 26; k++) {
    const t = rand() * rand() * 0.9
    strike(out, sr, at(sr, t), [[2100 + rand() * 2600, 0.04, 1], [5200 + rand() * 1500, 0.02, 0.4]], 0.25 * (1 - t), rand, 0.4)
  }
  strike(out, sr, 0, [[310, 0.15, 1], [740, 0.08, 0.5]], 0.5, rand, 3)
  return normalize(edges(out, sr, 0.001, 0.1), sr, -19)
}

// An original slow waltz for the dead's last dance, on a gramophone horn (MIDI note, beats).
const LAST_DANCE: readonly (readonly [number, number])[] = [
  [67, 2], [71, 1], [74, 2], [72, 1], [71, 2], [69, 1], [67, 3],
  [66, 2], [69, 1], [72, 2], [71, 1], [69, 2], [66, 1], [67, 3],
]

/** A wind-up gramophone outside the church playing a slow waltz, worn and wobbling, crackling: an 11.2 s loop. */
export function lastDance(sr: number, seed = 33): Float32Array {
  const rand = mulberry32(seed)
  const beat = 0.4
  const seconds = LAST_DANCE.reduce((a, [, b]) => a + b, 0) * beat
  const xf = at(sr, 0.3)
  const src = new Float32Array(at(sr, seconds) + xf)
  let t = 0
  let bar = 0
  for (const [note, len] of LAST_DANCE) {
    const s = at(sr, t)
    const n = at(sr, len * beat + 0.3)
    let ph = 0
    for (let k = 0; k < n && s + k < src.length; k++) {
      const tt = k / sr
      // Tape-like wow: the record is warped.
      const f = midiHz(note) * (1 + 0.012 * Math.sin(TAU * 0.55 * (t + tt)))
      ph += (TAU * f) / sr
      const env = Math.min(1, tt / 0.03) * Math.exp(-tt / (len * beat * 0.9))
      src[s + k]! += (Math.sin(ph) + 0.45 * Math.sin(2 * ph) + 0.2 * Math.sin(3 * ph)) * env * 0.5
    }
    // Oom-pah-pah underneath.
    for (let b = 0; b < len; b++) {
      const bs = at(sr, t + b * beat)
      const root = midiHz((bar % 2 === 0 ? 43 : 38) + (b === 0 ? 0 : 12))
      for (let k = 0; k < at(sr, 0.25) && bs + k < src.length; k++) src[bs + k]! += Math.sin((TAU * root * k) / sr) * Math.exp(-k / (0.08 * sr)) * (b === 0 ? 0.4 : 0.18)
    }
    t += len * beat
    bar++
  }
  // The horn: midrange only. Then the crackle and hiss of an old shellac record.
  filter(src, new Biquad(sr, "highpass", 380, 0.8))
  filter(src, new Biquad(sr, "lowpass", 2800, 1.2))
  const crackle = new Biquad(sr, "highpass", 1800, 0.7)
  for (let i = 0; i < src.length; i++) src[i]! += crackle.tick(rand() < 0.0012 ? white(rand) * 5 : white(rand) * 0.02) * 0.4
  return normalize(loopify(src, xf), sr, -21)
}

/** The church bell: a big bronze bell's hum, prime, tierce, quint and nominal, ringing for seconds. */
export function churchBell(sr: number, seed = 34): Float32Array {
  const rand = mulberry32(seed)
  const out = buffer(sr, 5)
  const f = 196
  strike(
    out,
    sr,
    0,
    [
      [f * 0.5, 5.5, 0.6],
      [f, 4.2, 0.8],
      [f * 1.003, 4.0, 0.4],
      [f * 1.19, 3.2, 0.5],
      [f * 1.5, 2.6, 0.3],
      [f * 2.0, 2.2, 0.55],
      [f * 2.52, 1.4, 0.25],
      [f * 3.01, 0.9, 0.18],
      [f * 4.2, 0.5, 0.1],
    ],
    1,
    rand,
    3,
  )
  return normalize(edges(out, sr, 0.001, 0.4), sr, -16)
}

// ---------------------------------------------------------------------------------------------------------------
// Second pass: the town's electrics and the last calls
// ---------------------------------------------------------------------------------------------------------------

/**
 * A police radio in an abandoned cruiser: the squelch opens, a dispatcher calls units that never answer (a voice too
 * crushed to follow), the squelch tail. ~3.6 s.
 */
export function radioCall(sr: number, seed = 35): Float32Array {
  const rand = mulberry32(seed)
  const out = buffer(sr, 3.6)
  const hissBp = new Biquad(sr, "bandpass", 2200, 0.8)
  const open = at(sr, 0.12)
  const close = out.length - at(sr, 0.45)
  for (let i = 0; i < out.length; i++) {
    const on = i < open ? 0 : i < open + at(sr, 0.08) || (i > close && i < close + at(sr, 0.16)) ? 1 : 0.18
    out[i] = i >= open && i < close + at(sr, 0.16) ? hissBp.tick(white(rand)) * on * 0.5 : 0
  }
  babble(out, sr, at(sr, 0.3), 2.6, rand, 172)
  // Crushed through a tiny speaker and a bad link.
  for (let i = 0; i < out.length; i++) out[i] = Math.tanh(out[i]! * 3) * 0.5
  filter(out, new Biquad(sr, "highpass", 420, 0.9))
  filter(out, new Biquad(sr, "lowpass", 2900, 1.1))
  return normalize(edges(out, sr, 0.002, 0.05), sr, -19)
}

/** A neon sign's transformer buzz with the tube's crackle, 3 s loop. Broken signs sputter (played in bursts). */
export function neonBuzz(sr: number, seed = 36): Float32Array {
  const rand = mulberry32(seed)
  const seconds = 3
  const xf = at(sr, 0.1)
  const src = new Float32Array(at(sr, seconds) + xf)
  const crackle = new Biquad(sr, "bandpass", 5200, 1.2)
  for (let i = 0; i < src.length; i++) {
    const t = i / sr
    // Rectified mains: a buzzy 120 Hz with odd harmonics.
    const ph = (120 * t) % 1
    const buzz = (ph < 0.12 ? 1 : 0) - 0.12
    src[i] = buzz * 0.6 + Math.sin(TAU * 120 * t) * 0.25 + Math.sin(TAU * 360 * t) * 0.12 + crackle.tick(rand() < 0.002 ? white(rand) * 4 : white(rand) * 0.05) * 0.3
  }
  filter(src, new Biquad(sr, "lowpass", 4500, 0.7))
  return normalize(loopify(src, xf), sr, -22)
}

/** A sodium street lamp's ballast hum overhead, 2 s loop. */
export function lampBuzz(sr: number, seed = 37): Float32Array {
  const rand = mulberry32(seed)
  const seconds = 2
  const xf = at(sr, 0.1)
  const src = new Float32Array(at(sr, seconds) + xf)
  const whine = new Biquad(sr, "bandpass", 1450, 9)
  for (let i = 0; i < src.length; i++) {
    const t = i / sr
    src[i] = Math.sin(TAU * 120 * t) * 0.5 + Math.sin(TAU * 240 * t) * 0.35 + Math.sin(TAU * 480 * t) * 0.12 + whine.tick(white(rand)) * 0.6
  }
  return normalize(loopify(src, xf), sr, -22)
}

/** A smoke alarm's low-battery chirp. */
export function smokeChirp(sr: number): Float32Array {
  const out = buffer(sr, 0.12)
  for (let i = 0; i < at(sr, 0.055); i++) {
    const env = Math.min(1, i / (0.002 * sr), (at(sr, 0.055) - i) / (0.004 * sr))
    out[i] = (Math.sin((TAU * 3150 * i) / sr) + 0.3 * Math.sin((TAU * 6300 * i) / sr)) * env
  }
  return normalize(out, sr, -18)
}

/** An open door swinging on a dry hinge in the draught: a slow, rising squeal. */
export function doorCreak(sr: number, seed = 38): Float32Array {
  const rand = mulberry32(seed)
  const len = 1.1
  const out = buffer(sr, len + 0.1)
  const bank = [new Mode(sr, 1180, 0.03, 1), new Mode(sr, 2390, 0.02, 0.6), new Mode(sr, 3610, 0.015, 0.3), new Mode(sr, 640, 0.05, 0.5)]
  let ph = 0
  for (let i = 0; i < out.length; i++) {
    const u = i / (len * sr)
    const env = u < 1 ? Math.sin(Math.PI * u) ** 1.2 : 0
    ph += (180 + 260 * u + 40 * Math.sin(u * 23)) / sr
    let x = 0
    if (ph >= 1) {
      ph -= 1
      x = env * (0.7 + rand() * 0.3)
    }
    let y = 0
    for (const m of bank) y += m.tick(x)
    out[i] = y
  }
  return normalize(edges(out, sr, 0.004, 0.05), sr, -20)
}

/** A shop's burglar alarm bell ringing on its battery, 2 s loop: a hammer on a gong at 18 Hz. */
export function alarmBell(sr: number, seed = 39): Float32Array {
  const rand = mulberry32(seed)
  const seconds = 2
  const out = buffer(sr, seconds)
  const bell = [new Mode(sr, 1870, 0.25, 1), new Mode(sr, 4480, 0.12, 0.5), new Mode(sr, 7010, 0.06, 0.25)]
  const step = Math.round(sr / 18)
  // Run two seconds first so the loop starts already ringing (no attack at the seam).
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < out.length; i++) {
      const x = i % step === 0 ? 0.5 + rand() * 0.15 : 0
      let y = 0
      for (const m of bell) y += m.tick(x)
      if (pass === 1) out[i] = y
    }
  }
  filter(out, new Biquad(sr, "lowpass", 5000, 0.7))
  return normalize(out, sr, -20)
}

/** A songbird at first light: a phrase of whistled, swooping notes (three species by seed). */
export function birdSong(sr: number, seed = 40): Float32Array {
  const rand = mulberry32(seed)
  const out = buffer(sr, 2.2)
  const species = seed % 3
  let t = 0.03
  const notes = species === 0 ? 7 : species === 1 ? 4 : 10
  for (let k = 0; k < notes && t < 1.95; k++) {
    const len = species === 2 ? 0.05 + rand() * 0.03 : 0.1 + rand() * 0.16
    const f0 = (species === 1 ? 2400 : 3200) + rand() * 1800
    const f1 = f0 * (species === 0 ? 0.65 + rand() * 0.7 : species === 1 ? 1.25 : 0.85)
    const s = at(sr, t)
    let ph = 0
    for (let i = 0; i < at(sr, len) && s + i < out.length; i++) {
      const u = i / (len * sr)
      const f = f0 + (f1 - f0) * u + (species === 1 ? 180 * Math.sin(TAU * 38 * (i / sr)) : 0)
      ph += (TAU * f) / sr
      out[s + i]! += Math.sin(ph) * Math.sin(Math.PI * u) ** 0.6 * (0.6 + 0.4 * rand())
    }
    t += len + (species === 2 ? 0.03 : 0.06 + rand() * 0.12)
  }
  return normalize(edges(out, sr, 0.002, 0.05), sr, -19)
}

// ---------------------------------------------------------------------------------------------------------------
// Third pass: the life layer's leftovers and the secrets
// ---------------------------------------------------------------------------------------------------------------

/** An impact sprinkler at dawn: the arm's tch-tch-tch stepping round, then the fast ratchet back, 6 s loop. */
export function sprinkler(sr: number, seed = 41): Float32Array {
  const rand = mulberry32(seed)
  const seconds = 6
  const out = buffer(sr, seconds)
  const spray = new Biquad(sr, "bandpass", 3800, 0.8)
  const hiss = new Biquad(sr, "highpass", 2500, 0.7)
  for (let i = 0; i < out.length; i++) out[i] = hiss.tick(white(rand)) * 0.05
  // 4.4 s of steps at ~5 Hz, then the return: 1.2 s of fast ratchet.
  for (let t = 0.05; t < 4.4; t += 0.19 + rand() * 0.02) {
    const s = at(sr, t)
    for (let k = 0; k < at(sr, 0.06) && s + k < out.length; k++) out[s + k]! += spray.tick(white(rand)) * Math.exp(-k / (0.015 * sr)) * 0.9
    strike(out, sr, s, [[2600, 0.01, 1], [5200, 0.006, 0.4]], 0.15, rand, 0.3)
  }
  for (let t = 4.5; t < 5.8; t += 0.045) strike(out, sr, at(sr, t), [[3100 + rand() * 300, 0.008, 1]], 0.12, rand, 0.3)
  return normalize(out, sr, -21)
}

/** A car's door-open chime on a dying battery: a soft electronic ding, 1.6 s loop. */
export function doorChime(sr: number): Float32Array {
  const out = buffer(sr, 1.6)
  for (let k = 0; k < at(sr, 0.5); k++) {
    const t = k / sr
    out[k] = (Math.sin(TAU * 1480 * t) + 0.25 * Math.sin(TAU * 2960 * t)) * Math.exp(-t / 0.12) * Math.min(1, t / 0.002)
  }
  filter(out, new Biquad(sr, "lowpass", 3500, 0.7))
  return normalize(out, sr, -20)
}

/** A sheet on a washing line snapping in a gust. */
export function washingFlap(sr: number, seed = 42): Float32Array {
  const rand = mulberry32(seed)
  const out = buffer(sr, 0.9)
  const bp = new Biquad(sr, "bandpass", 700, 0.7)
  for (let k = 0; k < 3; k++) {
    const s = at(sr, 0.03 + k * (0.18 + rand() * 0.12))
    const a = 1 - k * 0.3
    for (let i = 0; i < at(sr, 0.12) && s + i < out.length; i++) out[s + i]! += bp.tick(white(rand)) * a * Math.exp(-i / (0.02 * sr)) * (i < at(sr, 0.004) ? 3 : 1)
  }
  return normalize(edges(out, sr, 0.001, 0.05), sr, -20)
}

/** A stopped clock's second hand trying for the next mark and falling back: a tick and a fainter tock, one shot. */
export function clockTwitch(sr: number, seed = 43): Float32Array {
  const rand = mulberry32(seed)
  const out = buffer(sr, 0.14)
  const hi: [number, number, number][] = [
    [3400, 0.012, 1],
    [5600, 0.008, 0.6],
  ]
  strike(out, sr, at(sr, 0.004), hi, 0.35, rand, 0.4)
  strike(out, sr, at(sr, 0.05), hi, 0.12, rand, 0.3)
  return normalize(edges(out, sr, 0.001, 0.02), sr, -22)
}

/** A shortwave set between stations: hiss, a heterodyne whistle drifting, the odd crackle, 5 s loop. */
export function radioStatic(sr: number, seed = 44): Float32Array {
  const rand = mulberry32(seed)
  const seconds = 5
  const xf = at(sr, 0.3)
  const src = new Float32Array(at(sr, seconds) + xf)
  const band = new Biquad(sr, "bandpass", 1500, 0.6)
  let ph = 0
  for (let i = 0; i < src.length; i++) {
    const t = i / sr
    const fade = 0.7 + 0.3 * Math.sin((TAU * t) / seconds)
    ph += (TAU * (620 + 90 * Math.sin((TAU * t) / seconds))) / sr
    src[i] = band.tick(white(rand)) * fade + Math.sin(ph) * 0.06 + (rand() < 0.0008 ? white(rand) * 0.8 : 0)
  }
  filter(src, new Biquad(sr, "lowpass", 3000, 0.8))
  return normalize(loopify(src, xf), sr, -22)
}

/**
 * One pulse of the station that is not there, as long as the set's dial stays lit (0.38 s): a pure tone that wavers a
 * little, as if from very far, with no voice in it.
 */
export function radioPip(sr: number): Float32Array {
  const len = at(sr, 0.36)
  const out = buffer(sr, 0.4)
  let ph = 0
  for (let k = 0; k < len; k++) {
    const t = k / sr
    const env = Math.min(1, k / (0.012 * sr), (len - k) / (0.03 * sr))
    ph += (TAU * (880 + 3 * Math.sin(TAU * 5.5 * t))) / sr
    out[k] = Math.sin(ph) * env * (0.85 + 0.15 * Math.sin(TAU * 7 * t))
  }
  filter(out, new Biquad(sr, "bandpass", 900, 1.2))
  return normalize(out, sr, -18)
}

/** One creak of a rocking chair on porch boards (play it at each end of the rock, softer and lower on the way back). */
export function rockingChair(sr: number, seed = 45): Float32Array {
  const rand = mulberry32(seed)
  const len = 0.45
  const out = buffer(sr, len + 0.1)
  const bank = [new Mode(sr, 520, 0.04, 1), new Mode(sr, 1110, 0.03, 0.6), new Mode(sr, 1960, 0.02, 0.3)]
  let ph = 0
  for (let k = 0; k < out.length; k++) {
    const u = k / (len * sr)
    const env = u < 1 ? Math.sin(Math.PI * u) : 0
    ph += (110 * (0.8 + 0.4 * u)) / sr
    let x = 0
    if (ph >= 1) {
      ph -= 1
      x = env * (0.7 + rand() * 0.3)
    }
    let y = 0
    for (const m of bank) y += m.tick(x)
    out[k] = y
  }
  return normalize(edges(out, sr, 0.002, 0.03), sr, -20)
}

/** A padlock's dial turned one notch: a small detent click in brass. */
export function padlockDial(sr: number, seed = 47): Float32Array {
  const rand = mulberry32(seed)
  const out = buffer(sr, 0.09)
  strike(out, sr, 0, [[4200, 0.008, 1], [6900, 0.005, 0.5], [2300, 0.012, 0.35]], 0.4, rand, 0.3)
  strike(out, sr, at(sr, 0.011), [[3100, 0.006, 1], [5200, 0.004, 0.4]], 0.15, rand, 0.3)
  return normalize(edges(out, sr, 0.0005, 0.02), sr, -20)
}

/** The padlock giving: the shackle springs and drops against the hasp, and the iron answers. */
export function padlockOpen(sr: number, seed = 48): Float32Array {
  const rand = mulberry32(seed)
  const out = buffer(sr, 0.9)
  strike(out, sr, 0, [[2600, 0.02, 1], [4100, 0.012, 0.5]], 0.5, rand, 0.4)
  strike(out, sr, at(sr, 0.06), [[380, 0.12, 1], [910, 0.08, 0.7], [1730, 0.05, 0.5], [2950, 0.03, 0.3]], 0.6, rand, 1.5)
  strike(out, sr, at(sr, 0.21), [[960, 0.04, 1], [1810, 0.03, 0.6]], 0.2, rand, 0.6)
  strike(out, sr, at(sr, 0.3), [[1010, 0.03, 1], [1900, 0.02, 0.5]], 0.08, rand, 0.5)
  return normalize(edges(out, sr, 0.0005, 0.08), sr, -18)
}

/** A floor hatch's hinges, slow and low, the lid laid back on the boards at the end. */
export function hatchHinge(sr: number, seed = 49): Float32Array {
  const rand = mulberry32(seed)
  const len = 1.5
  const out = buffer(sr, len + 0.4)
  const bank = [new Mode(sr, 760, 0.04, 1), new Mode(sr, 1530, 0.025, 0.5), new Mode(sr, 410, 0.06, 0.6)]
  let ph = 0
  for (let i = 0; i < at(sr, len); i++) {
    const u = i / (len * sr)
    const env = Math.sin(Math.PI * u) ** 1.4
    ph += (70 + 120 * u + 25 * Math.sin(u * 17)) / sr
    let x = 0
    if (ph >= 1) {
      ph -= 1
      x = env * (0.6 + rand() * 0.4)
    }
    let y = 0
    for (const m of bank) y += m.tick(x)
    out[i] = y
  }
  strike(out, sr, at(sr, len + 0.02), [[140, 0.09, 1], [320, 0.06, 0.6], [710, 0.03, 0.3]], 0.5, rand, 3)
  filter(out, new Biquad(sr, "lowpass", 3600, 0.7))
  return normalize(edges(out, sr, 0.004, 0.1), sr, -20)
}

/** A lamp switched off in another room: the snap of a pull-chain switch. */
export function lampClick(sr: number, seed = 50): Float32Array {
  const rand = mulberry32(seed)
  const out = buffer(sr, 0.12)
  strike(out, sr, 0, [[2900, 0.006, 1], [5100, 0.004, 0.6], [1400, 0.01, 0.3]], 0.45, rand, 0.4)
  strike(out, sr, at(sr, 0.022), [[1800, 0.01, 1], [3600, 0.006, 0.4]], 0.12, rand, 0.4)
  return normalize(edges(out, sr, 0.0005, 0.03), sr, -20)
}

/**
 * The 3 AM call's message when the run has a cellar: the same flat voice, but it only repeats a group of `n`
 * identical syllables with a pause between, over and over. The radio man's number, to anyone who counts.
 */
export function answeringMachineCount(sr: number, n: number, seed = 46): Float32Array {
  const rand = mulberry32(seed)
  const out = buffer(sr, 7.6)
  strike(out, sr, at(sr, 0.02), [[2100, 0.015, 1], [3900, 0.01, 0.5]], 0.5, rand, 0.4)
  const motor = new Biquad(sr, "bandpass", 420, 3)
  for (let i = at(sr, 0.05); i < out.length - at(sr, 0.3); i++) out[i]! += motor.tick(white(rand)) * 0.05
  const b0 = at(sr, 0.7)
  for (let k = 0; k < at(sr, 0.45); k++) {
    const env = Math.min(1, k / (0.004 * sr), (at(sr, 0.45) - k) / (0.004 * sr))
    out[b0 + k]! += Math.sin((TAU * 1000 * k) / sr) * 0.5 * env
  }
  // Flat syllables: one vowel, one pitch.
  const f = [new Biquad(sr, "bandpass", 530, 6), new Biquad(sr, "bandpass", 1840, 8), new Biquad(sr, "bandpass", 2480, 10)]
  let t = 1.5
  const count = Math.max(1, Math.min(9, Math.round(n)))
  while (t < 7.0) {
    for (let k = 0; k < count && t < 7.1; k++) {
      const s = at(sr, t)
      const len = at(sr, 0.16)
      let ph = 0
      for (let i = 0; i < len && s + i < out.length; i++) {
        ph += 112 / sr
        if (ph >= 1) ph -= 1
        const g = (ph < 0.4 ? Math.sin((Math.PI * ph) / 0.4) : 0) - 0.25
        const env = Math.sin((Math.PI * i) / len) ** 0.8
        out[s + i]! += (f[0]!.tick(g) + f[1]!.tick(g) * 0.6 + f[2]!.tick(g) * 0.25) * env
      }
      t += 0.27
    }
    t += 0.9
  }
  strike(out, sr, out.length - at(sr, 0.25), [[1900, 0.015, 1], [3600, 0.01, 0.5]], 0.45, rand, 0.4)
  const hiss = new Biquad(sr, "highpass", 3000, 0.7)
  for (let i = at(sr, 0.05); i < out.length - at(sr, 0.3); i++) out[i]! += hiss.tick(white(rand)) * 0.012
  filter(out, new Biquad(sr, "highpass", 340, 0.7))
  filter(out, new Biquad(sr, "lowpass", 3200, 0.8))
  return normalize(edges(out, sr, 0.002, 0.05), sr, -21)
}
