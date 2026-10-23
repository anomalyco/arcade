import type { MixCategory } from "./types"

/**
 * A game-defined mix for `AudioRuntime` (`new AudioRuntime({ mix })`): named buses instead of the fixed categories,
 * some of them behind one shared muffle low-pass (a cockpit canopy, a helmet, a wall) and some with their own duck
 * gain, named sends (a convolution reverb from any impulse, or a filtered slapback echo that can feed another send),
 * and the output chain (glue compressor, peak limiter, trim, master, soft clip). `route` says where the runtime's cue
 * categories land, so library cues and procedural voices share the one mix.
 *
 *   bus ─ [duck] ─┬─ (muffled) ─► muffle low-pass ─┐
 *                 └──────────────────────────────── sum ─► glue ─► limiter ─► trim ─► master ─► soft clip ─► out
 *   send ─ convolver | delay + low-pass ─ return ─┘ (into the muffle or the sum; optionally feeding another send)
 */
export type CompressorSpec = { threshold: number; knee: number; ratio: number; attack: number; release: number }

export type MixBusSpec = {
  /** Behind the shared muffle low-pass (`AudioRuntime.setMuffle`). */
  muffled?: boolean
  /** Has its own duck gain, dipped by `AudioRuntime.duckBuses` (and `duck`). */
  ducked?: boolean
}

export type MixSendSpec = {
  /** A convolution reverb on this impulse (used as is: `normalize` off). */
  impulse?: (ctx: BaseAudioContext) => AudioBuffer
  /** Or a slapback: this many seconds of delay, then a low-pass at `lowpassHz`. */
  delay?: number
  lowpassHz?: number
  /** Return level into the mix. */
  wet: number
  /** The return goes behind the muffle low-pass. */
  muffled?: boolean
  /** The processed signal also feeds another send at this gain (an echo into the reverb). */
  feed?: { send: string; gain: number }
}

export type MixSpec<Bus extends string = string, Send extends string = string> = {
  buses: Record<Bus, MixBusSpec>
  sends: Record<Send, MixSendSpec>
  /** The muffle low-pass: open at 20 kHz, fully closed at `closedHz`. */
  muffle?: { closedHz: number; q?: number; tau?: number }
  glue?: CompressorSpec
  limiter: CompressorSpec
  /** Output trim after the compressors (which add makeup gain). */
  trim: number
  /** Soft clip after the master gain: unity below the knee (0..1), then a tanh knee into ±1. */
  softClipKnee?: number
  analyserFftSize?: number
  /** The bus each cue category plays into. */
  route: Record<MixCategory, Bus>
  /** The send cue reverb (`wet`) and the kit's synth voices use. */
  reverb: Send
}

export type MixGraph = {
  /** Every bus by name (its level gain). */
  buses: Record<string, GainNode>
  /** Duck gains of ducked buses, by bus name. */
  ducks: Record<string, GainNode>
  /** Each send's input and return gain. */
  sends: Record<string, { input: GainNode; output: GainNode }>
  muffle: BiquadFilterNode | null
  /** Where everything sums before the output chain. */
  sum: GainNode
  master: GainNode
  analyser: AnalyserNode | null
}

const compressor = (ctx: BaseAudioContext, s: CompressorSpec) => {
  const c = ctx.createDynamicsCompressor()
  c.threshold.value = s.threshold
  c.knee.value = s.knee
  c.ratio.value = s.ratio
  c.attack.value = s.attack
  c.release.value = s.release
  return c
}

/** Builds `spec` on `ctx`, connected to its destination. `master` is the master gain's starting value. */
export function buildMixGraph(ctx: BaseAudioContext, spec: MixSpec, master: number): MixGraph {
  const gain = (v: number, to?: AudioNode) => {
    const g = ctx.createGain()
    g.gain.value = v
    if (to) g.connect(to)
    return g
  }
  const limiter = compressor(ctx, spec.limiter)
  const trim = gain(spec.trim)
  const masterGain = gain(master)
  let tail: AudioNode = masterGain
  if (spec.softClipKnee !== undefined) {
    const clip = ctx.createWaveShaper()
    clip.curve = softClipCurve(spec.softClipKnee)
    clip.oversample = "2x"
    masterGain.connect(clip)
    tail = clip
  }
  let head: AudioNode = limiter
  if (spec.glue) {
    const glue = compressor(ctx, spec.glue)
    glue.connect(limiter)
    head = glue
  }
  limiter.connect(trim).connect(masterGain)
  tail.connect(ctx.destination)
  let analyser: AnalyserNode | null = null
  if (spec.analyserFftSize && typeof ctx.createAnalyser === "function") {
    analyser = ctx.createAnalyser()
    analyser.fftSize = spec.analyserFftSize
    tail.connect(analyser)
  }
  const sum = gain(1, head)

  let muffle: BiquadFilterNode | null = null
  if (spec.muffle) {
    muffle = ctx.createBiquadFilter()
    muffle.type = "lowpass"
    muffle.frequency.value = 20000
    muffle.Q.value = spec.muffle.q ?? 0.707
    muffle.connect(sum)
  }
  const target = (muffled: boolean | undefined) => (muffled && muffle ? muffle : sum)

  const ducks: Record<string, GainNode> = {}
  for (const [name, b] of Object.entries(spec.buses)) if (b.ducked) ducks[name] = gain(1, target(b.muffled))
  const buses: Record<string, GainNode> = {}
  for (const [name, b] of Object.entries(spec.buses)) buses[name] = gain(1, ducks[name] ?? target(b.muffled))

  const sends: MixGraph["sends"] = {}
  const feeds: [AudioNode, MixSendSpec["feed"] & {}][] = []
  for (const [name, s] of Object.entries(spec.sends)) {
    const input = gain(1)
    const output = gain(s.wet, target(s.muffled))
    if (s.impulse) {
      const conv = ctx.createConvolver()
      conv.normalize = false
      conv.buffer = s.impulse(ctx)
      input.connect(conv).connect(output)
      if (s.feed) feeds.push([conv, s.feed])
    } else {
      const delay = ctx.createDelay(Math.max(1, s.delay ?? 0))
      delay.delayTime.value = s.delay ?? 0
      const lp = ctx.createBiquadFilter()
      lp.type = "lowpass"
      lp.frequency.value = s.lowpassHz ?? 20000
      input.connect(delay).connect(lp).connect(output)
      if (s.feed) feeds.push([lp, s.feed])
    }
    sends[name] = { input, output }
  }
  for (const [from, f] of feeds) {
    const to = sends[f.send]
    if (to) from.connect(gain(f.gain, to.input))
  }
  return { buses, ducks, sends, muffle, sum, master: masterGain, analyser }
}

/** Unity below `knee`, then a smooth tanh knee into ±1: catches what a limiter's attack lets through. */
export function softClipCurve(knee = 0.85, n = 2048): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1
    const a = Math.abs(x)
    const y = a <= knee ? a : knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee))
    curve[i] = Math.sign(x) * y
  }
  return curve
}

/**
 * A synthesized stereo impulse response: `preDelay` seconds of silence, a few early reflections (open: the bounce off
 * the ground or water; closed: a small hard room), then decorrelated noise decaying to -60 dB over `rt60` seconds and
 * darkening as it decays (a one-pole low-pass whose cutoff falls from `brightHz`). Energy-normalised, so a send level
 * means the same for any length. Carrier's ocean (3.4 s, open) and cockpit (0.35 s, closed) reverbs.
 */
export function impulseResponse(ctx: BaseAudioContext, o: { rt60: number; preDelay: number; brightHz: number; open: boolean }): AudioBuffer {
  const { rt60, preDelay: pre, brightHz: bright, open: outdoor } = o
  const rate = ctx.sampleRate
  const len = Math.floor(rate * (pre + rt60))
  const buf = ctx.createBuffer(2, len, rate)
  let seed = outdoor ? 0x1234567 : 0x7654321
  const rnd = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) / 4294967296
  }
  const p0 = Math.floor(pre * rate)
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c)
    let lp = 0
    for (let i = p0; i < len; i++) {
      const t = (i - p0) / rate
      const env = Math.exp((-6.9 * t) / rt60)
      // Slow attack into the diffuse tail (a soft, not a sudden, reverb).
      const swell = outdoor ? Math.min(1, t / 0.06) : Math.min(1, t / 0.004)
      const fc = bright * Math.exp(-t * (outdoor ? 0.9 : 3)) + 300
      const a = 1 - Math.exp((-2 * Math.PI * fc) / rate)
      lp += a * (rnd() * 2 - 1 - lp)
      d[i] = lp * env * swell
    }
    const taps = outdoor ? [0.018, 0.031, 0.047, 0.071, 0.093] : [0.003, 0.006, 0.009, 0.013]
    taps.forEach((tt, k) => {
      const at = p0 + Math.floor((tt + (c ? 0.0021 * (k + 1) : 0)) * rate)
      if (at < len) d[at] = (d[at] ?? 0) + (outdoor ? 0.45 : 0.3) * Math.pow(0.72, k) * (k % 2 ? -1 : 1)
    })
  }
  let e = 0
  for (let c = 0; c < 2; c++) for (const v of buf.getChannelData(c)) e += v * v
  const k = 1 / Math.sqrt(e / 2 || 1)
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c)
    for (let i = 0; i < len; i++) d[i] = d[i]! * k
  }
  return buf
}

/** Seamless ~4 s noise loops, RMS-normalised to `NOISE_RMS`: white, pink (-3 dB/oct), brown (-6 dB/oct) and crackle
 *  (sparse decaying impulses of random size, e.g. afterburner pops). Raw material for procedural voices. */
export type NoiseBank = { white: AudioBuffer; pink: AudioBuffer; brown: AudioBuffer; crackle: AudioBuffer }
export const NOISE_RMS = 0.3

const noiseBanks = new WeakMap<BaseAudioContext, NoiseBank>()

/** The noise bank for `ctx` (rendered once per context, deterministic). */
export function noiseBank(ctx: BaseAudioContext): NoiseBank {
  let bank = noiseBanks.get(ctx)
  if (!bank) noiseBanks.set(ctx, (bank = renderNoiseBank(ctx)))
  return bank
}

function renderNoiseBank(ctx: BaseAudioContext): NoiseBank {
  const rate = ctx.sampleRate
  const len = Math.floor(rate * 4)
  const fade = Math.floor(rate * 0.05)
  let seed = 0x9e3779b9
  const rnd = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) / 4294967296
  }
  const make = (fill: (a: Float32Array) => void): AudioBuffer => {
    const a = new Float32Array(len + fade)
    fill(a)
    // Remove DC, normalise RMS, crossfade the tail into the head.
    let mean = 0
    for (let i = 0; i < a.length; i++) mean += a[i]!
    mean /= a.length
    let s = 0
    for (let i = 0; i < a.length; i++) {
      a[i] = a[i]! - mean
      s += a[i]! * a[i]!
    }
    const k = NOISE_RMS / Math.sqrt(s / a.length || 1)
    const buf = ctx.createBuffer(1, len, rate)
    const b = buf.getChannelData(0)
    for (let i = 0; i < len; i++) b[i] = Math.max(-1, Math.min(1, a[i]! * k))
    for (let i = 0; i < fade; i++) {
      const w = (i + 0.5) / fade
      b[i] = Math.max(-1, Math.min(1, (a[i]! * Math.sin((w * Math.PI) / 2) + a[len + i]! * Math.cos((w * Math.PI) / 2)) * k))
    }
    return buf
  }
  const white = make((a) => {
    for (let i = 0; i < a.length; i++) a[i] = rnd() * 2 - 1
  })
  const pink = make((a) => {
    // Paul Kellet's refined pink filter.
    let b0 = 0
    let b1 = 0
    let b2 = 0
    let b3 = 0
    let b4 = 0
    let b5 = 0
    let b6 = 0
    for (let i = 0; i < a.length; i++) {
      const w = rnd() * 2 - 1
      b0 = 0.99886 * b0 + w * 0.0555179
      b1 = 0.99332 * b1 + w * 0.0750759
      b2 = 0.969 * b2 + w * 0.153852
      b3 = 0.8665 * b3 + w * 0.3104856
      b4 = 0.55 * b4 + w * 0.5329522
      b5 = -0.7616 * b5 - w * 0.016898
      a[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362
      b6 = w * 0.115926
    }
  })
  const brown = make((a) => {
    let last = 0
    for (let i = 0; i < a.length; i++) {
      last = (last + 0.02 * (rnd() * 2 - 1)) / 1.02
      a[i] = last
    }
  })
  const crackle = make((a) => {
    // Poisson pops, ~110 a second, sizes power-law distributed, each a short decaying burst of random polarity.
    let t = 0
    while (t < a.length) {
      t += Math.floor((-Math.log(1 - rnd()) / 110) * rate)
      const size = Math.pow(rnd(), 3.2)
      const decay = (0.0004 + 0.0035 * rnd()) * rate
      const sign = rnd() < 0.5 ? -1 : 1
      const n = Math.min(a.length - t, Math.floor(decay * 6))
      for (let j = 0; j < n; j++) a[t + j] = a[t + j]! + sign * size * Math.exp(-j / decay) * (0.6 + 0.4 * (rnd() * 2 - 1))
    }
  })
  return { white, pink, brown, crackle }
}
