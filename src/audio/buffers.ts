// Procedural sample bank. Everything is rendered once at unlock (~10 ms total) so the game
// ships zero audio bytes. Loops are rendered with circular wrap-around (pulse trains) or an
// end→start crossfade (noise), so they repeat seamlessly.

export interface SoundBank {
  /** 2 s seamless white noise. */
  white: AudioBuffer
  /** 2 s seamless pink noise (−3 dB/oct): roar, wind, whooshes. */
  pink: AudioBuffer
  /** 2 s seamless brown noise (−6 dB/oct): rumble, explosions, afterburner. */
  brown: AudioBuffer
  /** 2 s sparse random pops: afterburner / rocket-motor crackle. */
  crackle: AudioBuffer
  /** M61 Vulcan: 100 rounds/s buzz-saw pulse train loop. */
  vulcan: AudioBuffer
  /** GAU-8 Avenger: 65 rounds/s (3,900 rpm) heavy saturated growl loop — the BRRRT. */
  gau8: AudioBuffer
  /** AH-64 main rotor: 4-blade chop at 19.2 Hz blade-pass, slightly uneven blades. */
  rotor: AudioBuffer
  /** Stereo reverb impulse ("big sky over canyons"). */
  impulse: AudioBuffer
}

type Rng = () => number

function mulberry32(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function normalize(data: Float32Array, peak: number): void {
  let max = 0
  for (let i = 0; i < data.length; i++) {
    const v = Math.abs(data[i])
    if (v > max) max = v
  }
  if (max <= 0) return
  const k = peak / max
  for (let i = 0; i < data.length; i++) data[i] *= k
}

/** Render `seconds + fade` of material, then crossfade the tail into the head for a seamless loop. */
function loopNoise(ctx: BaseAudioContext, seconds: number, rng: Rng, next: (white: number) => number, peak: number): AudioBuffer {
  const sr = ctx.sampleRate
  const n = Math.floor(seconds * sr)
  const fade = Math.floor(0.05 * sr)
  const raw = new Float32Array(n + fade)
  for (let i = 0; i < raw.length; i++) raw[i] = next(rng() * 2 - 1)
  const buffer = ctx.createBuffer(1, n, sr)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < n; i++) data[i] = raw[i]
  for (let i = 0; i < fade; i++) {
    const x = i / fade
    // Equal-power crossfade: head fades in while the overflow tail fades out.
    data[i] = raw[i] * Math.sin(x * Math.PI * 0.5) + raw[n + i] * Math.cos(x * Math.PI * 0.5)
  }
  normalize(data, peak)
  return buffer
}

/** Two-pole resonant filter applied cyclically (two passes so the state wraps cleanly). */
function cyclicBandpass(data: Float32Array, sr: number, freq: number, q: number, wet: number): void {
  const w = (2 * Math.PI * freq) / sr
  const alpha = Math.sin(w) / (2 * q)
  const a0 = 1 + alpha
  const b0 = alpha / a0, b2 = -alpha / a0
  const a1 = (-2 * Math.cos(w)) / a0, a2 = (1 - alpha) / a0
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  const out = new Float32Array(data.length)
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < data.length; i++) {
      const x = data[i]
      const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2
      x2 = x1; x1 = x; y2 = y1; y1 = y
      if (pass === 1) out[i] = y
    }
  }
  for (let i = 0; i < data.length; i++) data[i] = data[i] * (1 - wet) + out[i] * wet * 2
}

function saturate(data: Float32Array, drive: number): void {
  const k = Math.tanh(drive)
  for (let i = 0; i < data.length; i++) data[i] = Math.tanh(data[i] * drive) / k
}

/**
 * Periodic pulse-train loop. `render` writes one pulse into `out` (may be longer than the
 * period; overlap wraps around the loop end so the seam is invisible).
 */
function pulseLoop(
  ctx: BaseAudioContext, rate: number, cycles: number, pulseSeconds: number, rng: Rng,
  render: (out: Float32Array, sr: number, index: number, rng: Rng) => void,
): AudioBuffer {
  const sr = ctx.sampleRate
  const period = Math.round(sr / rate)
  const len = period * cycles
  const buffer = ctx.createBuffer(1, len, sr)
  const data = buffer.getChannelData(0)
  const pulse = new Float32Array(Math.ceil(pulseSeconds * sr))
  for (let k = 0; k < cycles; k++) {
    pulse.fill(0)
    render(pulse, sr, k, rng)
    // Tiny timing jitter (±2% of the period) keeps mechanical loops from sounding synthetic.
    const jitter = Math.round((rng() - 0.5) * 0.04 * period)
    const start = k * period + jitter + len
    for (let j = 0; j < pulse.length; j++) data[(start + j) % len] += pulse[j]
  }
  return buffer
}

function impulse(ctx: BaseAudioContext, rng: Rng): AudioBuffer {
  const sr = ctx.sampleRate
  const seconds = 2.8
  const n = Math.floor(seconds * sr)
  const buffer = ctx.createBuffer(2, n, sr)
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch)
    let lp = 0
    for (let i = 0; i < n; i++) {
      const t = i / sr
      const env = Math.exp(-t / 0.62) * (1 - Math.exp(-t / 0.012))
      // Progressive damping: the tail gets darker as it decays, like air absorption.
      const a = 0.85 - 0.75 * (i / n)
      lp += a * ((rng() * 2 - 1) - lp)
      data[i] = lp * env
    }
    // Sparse early reflections off terrain / canyon walls.
    for (let r = 0; r < 10; r++) {
      const at = Math.floor((0.008 + rng() * 0.12) * sr)
      data[at] += (rng() < 0.5 ? -1 : 1) * (0.7 - r * 0.05)
    }
  }
  return buffer
}

export function createSoundBank(ctx: BaseAudioContext): SoundBank {
  const rng = mulberry32(0x5eed)
  const white = loopNoise(ctx, 2, rng, (w) => w, 0.9)

  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0
  const pink = loopNoise(ctx, 2, rng, (w) => {
    // Paul Kellet's refined pink filter.
    b0 = 0.99886 * b0 + w * 0.0555179
    b1 = 0.99332 * b1 + w * 0.0750759
    b2 = 0.969 * b2 + w * 0.153852
    b3 = 0.8665 * b3 + w * 0.3104856
    b4 = 0.55 * b4 + w * 0.5329522
    b5 = -0.7616 * b5 - w * 0.016898
    const out = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362
    b6 = w * 0.115926
    return out
  }, 0.9)

  let last = 0
  const brown = loopNoise(ctx, 2, rng, (w) => {
    last = (last + 0.02 * w) / 1.02
    return last
  }, 0.95)

  let pop = 0, popDecay = 0
  const crackle = loopNoise(ctx, 2, rng, (w) => {
    if (rng() < 0.0009) {
      pop = (rng() < 0.5 ? -1 : 1) * (0.3 + rng() * 0.7)
      popDecay = 0.9 + rng() * 0.08
    }
    pop *= popDecay
    return pop * (0.6 + 0.4 * w)
  }, 0.9)

  const vulcan = pulseLoop(ctx, 100, 50, 0.012, rng, (out, sr, k, r) => {
    const amp = 0.8 + r() * 0.2
    for (let j = 0; j < out.length; j++) {
      const t = j / sr
      const n = r() * 2 - 1
      out[j] = amp * (
        n * Math.exp(-t / 0.0012)
        + 0.6 * Math.sin(2 * Math.PI * 520 * t) * Math.exp(-t / 0.004)
        + 0.5 * Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t / 0.006)
      )
    }
  })
  {
    const d = vulcan.getChannelData(0)
    cyclicBandpass(d, ctx.sampleRate, 1600, 2, 0.5)
    saturate(d, 1.8)
    normalize(d, 0.85)
  }

  const gau8 = pulseLoop(ctx, 65, 65, 0.045, rng, (out, sr, k, r) => {
    const amp = 0.85 + r() * 0.15
    let lp = 0
    for (let j = 0; j < out.length; j++) {
      const t = j / sr
      // Pitch-dropping thump: 165 Hz → 55 Hz per round, the low "B" in BRRRT.
      const phase = 2 * Math.PI * (55 * t + 110 * 0.006 * (1 - Math.exp(-t / 0.006)))
      const n = r() * 2 - 1
      lp += 0.35 * (n - lp)
      out[j] = amp * (
        Math.sin(phase) * Math.exp(-t / 0.013)
        + 0.8 * lp * Math.exp(-t / 0.0022)
        + 0.18 * n * Math.exp(-t / 0.01)
      )
    }
  })
  {
    const d = gau8.getChannelData(0)
    cyclicBandpass(d, ctx.sampleRate, 700, 1.2, 0.35)
    saturate(d, 3)
    normalize(d, 0.9)
  }

  const blades = [1, 0.82, 0.93, 0.78]
  const rotor = pulseLoop(ctx, 19.2, 16, 0.07, rng, (out, sr, k, r) => {
    const amp = blades[k % 4] * (0.92 + r() * 0.08)
    let lp = 0
    for (let j = 0; j < out.length; j++) {
      const t = j / sr
      const n = r() * 2 - 1
      lp += 0.06 * (n - lp)
      const env = (1 - Math.exp(-t / 0.004)) * Math.exp(-t / 0.03)
      out[j] = amp * (
        Math.sin(2 * Math.PI * (58 * t + 40 * 0.01 * (1 - Math.exp(-t / 0.01)))) * env
        + 6 * lp * (1 - Math.exp(-t / 0.002)) * Math.exp(-t / 0.022)
        + 0.15 * n * Math.exp(-t / 0.003)
      )
    }
  })
  {
    const d = rotor.getChannelData(0)
    saturate(d, 1.3)
    normalize(d, 0.9)
  }

  return { white, pink, brown, crackle, vulcan, gau8, rotor, impulse: impulse(ctx, rng) }
}
