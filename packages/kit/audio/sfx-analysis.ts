import { fftRadix2 } from "./offline"

/** Measurements of one sound file, from 48 kHz float PCM. Loudness follows ITU-R BS.1770 (K-weighted, gated). */
export type SfxStats = {
  durationSeconds: number
  channels: number
  /** Sample peak in dBFS. */
  peakDb: number
  /** Gated integrated loudness (LUFS); clips shorter than one 400 ms block are measured as a single block. */
  lufs: number
  /** Loudest 400 ms window (momentary max, LUFS): the level one-shots are matched by. */
  momentaryMaxLufs: number
  /** Seconds before the sound first rises within 40 dB of its peak. */
  leadingSilence: number
  /** Seconds after the sound last falls below 50 dB under its peak. */
  trailingSilence: number
  /** Samples at or above 0.999 full scale. */
  clippedSamples: number
  dcOffset: number
  /** Energy-weighted spectral centroid (Hz). */
  centroidHz: number
  /** Share of energy above 4 kHz. */
  highBandRatio: number
}

const SR = 48000

/** BS.1770 K-weighting at 48 kHz: high shelf then high pass, as biquad coefficient sets. */
const K_STAGES = [
  { b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [-1.69065929318241, 0.73248077421585] },
  { b: [1, -2, 1], a: [-1.99004745483398, 0.99007225036621] },
] as const

function kWeight(x: Float32Array): Float32Array {
  let y = x
  for (const { b, a } of K_STAGES) {
    const out = new Float32Array(y.length)
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0
    for (let i = 0; i < y.length; i++) {
      const v = y[i]!
      const o = b[0] * v + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2
      x2 = x1; x1 = v; y2 = y1; y1 = o
      out[i] = o
    }
    y = out
  }
  return y
}

const toLufs = (meanSquare: number) => (meanSquare > 0 ? -0.691 + 10 * Math.log10(meanSquare) : -Infinity)

/** Per-block channel-summed K-weighted mean square, 400 ms blocks with 75% overlap (or one block for short clips). */
function blockPowers(channels: readonly Float32Array[]): number[] {
  const weighted = channels.map(kWeight)
  const n = weighted[0]!.length
  const block = Math.min(n, Math.round(0.4 * SR))
  const hop = Math.max(1, Math.round(block / 4))
  const powers: number[] = []
  if (block === 0) return powers
  for (let start = 0; start + block <= n; start += hop) {
    let sum = 0
    for (const ch of weighted) {
      let s = 0
      for (let i = start; i < start + block; i++) s += ch[i]! * ch[i]!
      sum += s / block
    }
    powers.push(sum)
  }
  return powers
}

/** Gated integrated loudness (absolute gate -70 LUFS, relative gate -10 LU). */
export function integratedLufs(channels: readonly Float32Array[]): number {
  const powers = blockPowers(channels)
  const abs = powers.filter(p => toLufs(p) > -70)
  if (!abs.length) return -Infinity
  const rel = toLufs(abs.reduce((s, p) => s + p, 0) / abs.length) - 10
  const gated = abs.filter(p => toLufs(p) > rel)
  return toLufs(gated.reduce((s, p) => s + p, 0) / gated.length)
}

export function momentaryMaxLufs(channels: readonly Float32Array[]): number {
  return toLufs(Math.max(0, ...blockPowers(channels)))
}

/** Analyses de-interleaved 48 kHz channels. */
export function analyzeSfx(channels: readonly Float32Array[]): SfxStats {
  const n = channels[0]?.length ?? 0
  let peak = 0, clipped = 0, dc = 0
  const mono = new Float32Array(n)
  for (const ch of channels) {
    for (let i = 0; i < n; i++) {
      const v = ch[i]!
      const a = Math.abs(v)
      if (a > peak) peak = a
      if (a >= 0.999) clipped++
      dc += v
      mono[i]! += v / channels.length
    }
  }
  // 1 ms envelope for silence detection.
  const win = 48
  const env: number[] = []
  for (let i = 0; i < n; i += win) {
    let m = 0
    for (let k = i; k < Math.min(n, i + win); k++) m = Math.max(m, Math.abs(mono[k]!))
    env.push(m)
  }
  const envPeak = Math.max(1e-9, ...env)
  const first = env.findIndex(v => v >= envPeak * 0.01)
  let last = env.length - 1
  while (last > 0 && env[last]! < envPeak * 0.00316) last--
  const spectrum = centroid(mono)
  return {
    durationSeconds: n / SR,
    channels: channels.length,
    peakDb: 20 * Math.log10(Math.max(1e-9, peak)),
    lufs: integratedLufs(channels),
    momentaryMaxLufs: momentaryMaxLufs(channels),
    leadingSilence: Math.max(0, first) * win / SR,
    trailingSilence: Math.max(0, n - (last + 1) * win) / SR,
    clippedSamples: clipped,
    dcOffset: n ? dc / (n * channels.length) : 0,
    centroidHz: spectrum.centroid,
    highBandRatio: spectrum.high,
  }
}

function centroid(mono: Float32Array): { centroid: number; high: number } {
  const size = 2048
  const re = new Float32Array(size), im = new Float32Array(size)
  let weighted = 0, total = 0, high = 0
  for (let start = 0; start + size <= Math.max(size, mono.length); start += size / 2) {
    re.fill(0); im.fill(0)
    for (let i = 0; i < size; i++) re[i] = (mono[start + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)))
    fftRadix2(re, im)
    for (let k = 1; k < size / 2; k++) {
      const p = re[k]! * re[k]! + im[k]! * im[k]!
      const hz = (k * SR) / size
      weighted += p * hz
      total += p
      if (hz > 4000) high += p
    }
  }
  return { centroid: total > 0 ? weighted / total : 0, high: total > 0 ? high / total : 0 }
}

/** Splits interleaved float PCM into channels. */
export function deinterleave(pcm: Float32Array, channels: number): Float32Array[] {
  const n = Math.floor(pcm.length / channels)
  const out = Array.from({ length: channels }, () => new Float32Array(n))
  for (let i = 0; i < n; i++) for (let c = 0; c < channels; c++) out[c]![i] = pcm[i * channels + c]!
  return out
}

/** Onsets (seconds) in a recording of repeated events such as footsteps: rises of the 5 ms envelope past a threshold. */
export function detectOnsets(mono: Float32Array, options: { thresholdDb?: number; minGapSeconds?: number } = {}): number[] {
  const win = 240
  const env: number[] = []
  for (let i = 0; i < mono.length; i += win) {
    let s = 0
    for (let k = i; k < Math.min(mono.length, i + win); k++) s += mono[k]! * mono[k]!
    env.push(Math.sqrt(s / win))
  }
  const peak = Math.max(1e-9, ...env)
  const threshold = peak * 10 ** ((options.thresholdDb ?? -24) / 20)
  const gap = Math.round(((options.minGapSeconds ?? 0.25) * SR) / win)
  const onsets: number[] = []
  let lastAt = -Infinity
  for (let i = 1; i < env.length; i++) {
    if (env[i]! >= threshold && env[i - 1]! < threshold && i - lastAt >= gap) {
      onsets.push((i * win) / SR)
      lastAt = i
    }
  }
  return onsets
}
