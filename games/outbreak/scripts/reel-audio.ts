import { writeFileSync } from "node:fs"
import { fftRadix2 } from "../../../packages/kit/audio/offline"

/** Overlap-add FFT convolution, trimmed to the input duration. */
export function convolve(x: Float32Array, h: Float32Array): Float32Array {
  let size = 1
  while (size < h.length * 2) size <<= 1
  const block = size - h.length
  const hr = new Float32Array(size)
  const hi = new Float32Array(size)
  hr.set(h)
  fftRadix2(hr, hi)
  const y = new Float32Array(x.length + h.length)
  const re = new Float32Array(size)
  const im = new Float32Array(size)
  for (let s = 0; s < x.length; s += block) {
    re.fill(0)
    im.fill(0)
    re.set(x.subarray(s, Math.min(x.length, s + block)))
    fftRadix2(re, im)
    for (let k = 0; k < size; k++) {
      const a = re[k]! * hr[k]! - im[k]! * hi[k]!
      const c = re[k]! * hi[k]! + im[k]! * hr[k]!
      re[k] = a
      im[k] = -c
    }
    fftRadix2(re, im)
    for (let k = 0; k < size && s + k < y.length; k++) y[s + k]! += re[k]! / size
  }
  return y.subarray(0, x.length)
}

/** Stereo 48 kHz PCM with the runtime's -3 dBFS soft-knee limiter. */
export function wav(path: string, L: Float32Array, R: Float32Array): void {
  const SR = 48000
  const n = L.length
  const buf = Buffer.alloc(44 + n * 4)
  buf.write("RIFF", 0)
  buf.writeUInt32LE(36 + n * 4, 4)
  buf.write("WAVEfmt ", 8)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(2, 22)
  buf.writeUInt32LE(SR, 24)
  buf.writeUInt32LE(SR * 4, 28)
  buf.writeUInt16LE(4, 32)
  buf.writeUInt16LE(16, 34)
  buf.write("data", 36)
  buf.writeUInt32LE(n * 4, 40)
  const limit = (v: number) => (Math.abs(v) < 0.6 ? v : Math.sign(v) * (0.6 + 0.108 * Math.tanh((Math.abs(v) - 0.6) / 0.108)))
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, limit(L[i]!))) * 32767), 44 + i * 4)
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, limit(R[i]!))) * 32767), 46 + i * 4)
  }
  writeFileSync(path, buf)
}
