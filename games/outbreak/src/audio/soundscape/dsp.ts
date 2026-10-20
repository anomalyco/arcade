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
  const out = buffer(sr, 3.2)
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
