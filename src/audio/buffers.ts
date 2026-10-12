// Procedural sample bank. Everything is rendered once at unlock (~20 ms total) so the game
// ships zero audio bytes. Loops are rendered with circular wrap-around (pulse trains) or an
// end→start crossfade (noise), so they repeat seamlessly.

export interface SoundBank {
  /** 2 s seamless pink noise (−3 dB/oct): roar, wind, whooshes. */
  pink: AudioBuffer
  /** 2 s seamless brown noise (−6 dB/oct): rumble, explosions, afterburner. */
  brown: AudioBuffer
  /** M61 Vulcan: 100 rounds/s buzz-saw pulse train loop. */
  vulcan: AudioBuffer
  /** GAU-8 Avenger: 65 rounds/s (3,900 rpm) heavy saturated growl loop — the BRRRT. */
  gau8: AudioBuffer
  /** Phalanx CIWS: 75 rounds/s (4,500 rpm) tearing buzz — brighter and rippier than the GAU-8. */
  ciws: AudioBuffer
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

/** One-pole lowpass applied cyclically (two passes so the loop seam stays clean). */
function cyclicLowpass(data: Float32Array, sr: number, freq: number): void {
  const a = 1 - Math.exp((-2 * Math.PI * freq) / sr)
  let y = 0
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < data.length; i++) {
      y += a * (data[i] - y)
      if (pass === 1) data[i] = y
    }
  }
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
  jitter = 0.04,
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
    // Timing jitter keeps mechanical loops from sounding synthetic (and from forming a pitched buzz).
    const offset = Math.round((rng() - 0.5) * jitter * period)
    const start = k * period + offset + len
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
      // Dark from the start (no reverb hiss), darker still as it decays, like air absorption.
      const a = 0.3 - 0.25 * (i / n)
      lp += a * ((rng() * 2 - 1) - lp)
      data[i] = lp * env
    }
    // Sparse early reflections off terrain / water, smeared over ~2 ms so they don't click.
    for (let r = 0; r < 10; r++) {
      const at = Math.floor((0.008 + rng() * 0.12) * sr)
      const sign = rng() < 0.5 ? -1 : 1
      const amp = (0.7 - r * 0.05) * 0.15
      for (let j = 0; j < 100 && at + j < n; j++) data[at + j] += sign * amp * Math.sin((Math.PI * j) / 100)
    }
  }
  return buffer
}

export function createSoundBank(ctx: BaseAudioContext): SoundBank {
  const rng = mulberry32(0x5eed)

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

  // Rotary guns: each round is a soft-attack, pitch-dropping thump plus lowpassed (not bright) noise.
  // Heavy timing/amplitude jitter turns the pulse train into a rip instead of a pitched buzz.
  const round = (f0: number, f1: number, thumpDecay: number, noiseCoef: number, noiseDecay: number, noiseAmt: number) =>
    (out: Float32Array, sr: number, _k: number, r: Rng) => {
      const amp = 0.55 + r() * 0.45
      const drop = 0.006
      let lp = 0
      for (let j = 0; j < out.length; j++) {
        const t = j / sr
        const attack = 1 - Math.exp(-t / 0.0012)
        const phase = 2 * Math.PI * (f1 * t + (f0 - f1) * drop * (1 - Math.exp(-t / drop)))
        lp += noiseCoef * ((r() * 2 - 1) - lp)
        out[j] = amp * attack * (Math.sin(phase) * Math.exp(-t / thumpDecay) + noiseAmt * lp * Math.exp(-t / noiseDecay))
      }
    }
  const finishGun = (b: AudioBuffer, lowpass: number, drive: number, peak: number) => {
    const d = b.getChannelData(0)
    cyclicLowpass(d, ctx.sampleRate, lowpass)
    saturate(d, drive)
    normalize(d, peak)
  }
  const vulcan = pulseLoop(ctx, 100, 100, 0.03, rng, round(150, 80, 0.006, 0.25, 0.004, 2.5), 0.18)
  finishGun(vulcan, 1800, 1.2, 0.8)
  const gau8 = pulseLoop(ctx, 65, 98, 0.05, rng, round(130, 50, 0.012, 0.15, 0.005, 3), 0.15)
  finishGun(gau8, 1200, 1.6, 0.85)
  const ciws = pulseLoop(ctx, 75, 90, 0.035, rng, round(170, 70, 0.008, 0.2, 0.005, 2.8), 0.2)
  finishGun(ciws, 1500, 1.4, 0.8)

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
        + 6 * lp * (1 - Math.exp(-t / 0.003)) * Math.exp(-t / 0.022)
      )
    }
  })
  {
    const d = rotor.getChannelData(0)
    saturate(d, 1.3)
    normalize(d, 0.9)
  }

  return { pink, brown, vulcan, gau8, ciws, rotor, impulse: impulse(ctx, rng) }
}
