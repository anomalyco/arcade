import { momentaryMaxLufs } from "@arcade/kit/audio/sfx-analysis"

/** Linear resample to 48 kHz, the rate the BS.1770 meter is built for. */
export function to48k(pcm: Float32Array, sr: number): Float32Array {
  if (sr === 48000) return pcm
  const n = Math.floor((pcm.length * 48000) / sr)
  const out = new Float32Array(n)
  const step = sr / 48000
  for (let i = 0; i < n; i++) {
    const p = i * step
    const k = Math.floor(p)
    const a = pcm[k] ?? 0
    const b = pcm[k + 1] ?? a
    out[i] = a + (b - a) * (p - k)
  }
  return out
}

const CEILING = 0.891
/** Most a transient's peak may be pushed past the ceiling and rounded back by the soft knee (6 dB). */
const MAX_SHAVE = 2

/**
 * Scales a baked take so its loudest 400 ms sits at `target` LUFS (momentary max, the library's rule for one-shots),
 * with its sample peak held at or under -1 dBFS. Sharp transients (a crack, a bone snapping) whose peaks would stop
 * them short of the target have up to 6 dB of their first milliseconds rounded off by a soft knee, the way a mastering
 * limiter would, so they reach it. Every take of a sound then lands at the same level, so round-robin varies the
 * sound and not its loudness.
 */
export function levelTo(pcm: Float32Array, sr: number, target: number): Float32Array {
  const m = momentaryMaxLufs([to48k(pcm, sr)])
  if (!Number.isFinite(m)) return pcm
  let peak = 0
  for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]!))
  if (peak <= 0) return pcm
  const g = Math.min(10 ** ((target - m) / 20), (CEILING * MAX_SHAVE) / peak)
  if (peak * g <= CEILING) {
    for (let i = 0; i < pcm.length; i++) pcm[i]! *= g
    return pcm
  }
  const knee = CEILING * 0.6
  for (let i = 0; i < pcm.length; i++) {
    const x = pcm[i]! * g
    const a = Math.abs(x)
    pcm[i] = a <= knee ? x : Math.sign(x) * (knee + (CEILING - knee) * Math.tanh((a - knee) / (CEILING - knee)))
  }
  // The knee takes a little energy too: settle back under the target, never above it.
  const after = momentaryMaxLufs([to48k(pcm, sr)])
  if (after > target) {
    const k = 10 ** ((target - after) / 20)
    for (let i = 0; i < pcm.length; i++) pcm[i]! *= k
  }
  return pcm
}
