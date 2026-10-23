// Before/after comparison of two scripts/audio-render.ts output folders (same scenes, same seeded demo):
//
//   bun scripts/audio-compare.ts <before-dir> <after-dir> [--mp3=<dir>] [--md=<file>]
//
// Per scene: integrated loudness (kit `integratedLufs`), the largest change of any 2 s section's loudness, peak,
// spectral centroid and high-band share (kit `analyzeAudioBuffer`), and the null test: the after render minus the before
// render, its RMS and its largest sample in dBFS (16-bit WAVs: -90 dBFS is one step). --mp3 writes an MP3 pair per scene.
import { $ } from "bun"
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { analyzeAudioBuffer } from "@arcade/kit/audio/offline"
import { integratedLufs } from "@arcade/kit/audio/sfx-analysis"

const [beforeDir, afterDir] = process.argv.slice(2).filter((a) => !a.startsWith("--"))
const opt = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3)
if (!beforeDir || !afterDir) throw new Error("usage: audio-compare.ts <before-dir> <after-dir> [--mp3=<dir>] [--md=<file>]")

const RATE = 48000
function readWav(path: string): Float32Array[] {
  const b = readFileSync(path)
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  let o = 12
  while (o < b.length - 8 && String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!) !== "data") o += 8 + v.getUint32(o + 4, true)
  const n = v.getUint32(o + 4, true) / 4
  const l = new Float32Array(n)
  const r = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    l[i] = v.getInt16(o + 8 + i * 4, true) / 32768
    r[i] = v.getInt16(o + 10 + i * 4, true) / 32768
  }
  return [l, r]
}
const asBuffer = (ch: Float32Array[]) =>
  ({ length: ch[0]!.length, sampleRate: RATE, numberOfChannels: 2, duration: ch[0]!.length / RATE, getChannelData: (c: number) => ch[c]! }) as unknown as AudioBuffer
const db = (x: number) => 20 * Math.log10(x + 1e-12)
const fmt = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "-inf")

const rows: string[] = []
const mp3 = opt("mp3")
if (mp3) mkdirSync(mp3, { recursive: true })
for (const file of readdirSync(beforeDir).filter((f) => f.endsWith(".wav")).sort()) {
  const scene = file.slice(0, -4)
  const a = readWav(join(beforeDir, file))
  const b = readWav(join(afterDir, file))
  const n = Math.min(a[0]!.length, b[0]!.length)
  let diff = 0
  let maxDiff = 0
  for (let c = 0; c < 2; c++)
    for (let i = 0; i < n; i++) {
      const d = b[c]![i]! - a[c]![i]!
      diff += d * d
      maxDiff = Math.max(maxDiff, Math.abs(d))
    }
  let section = 0
  for (let s = 0; s + 2 * RATE <= n; s += 2 * RATE) {
    const la = integratedLufs(a.map((ch) => ch.subarray(s, s + 2 * RATE)))
    const lb = integratedLufs(b.map((ch) => ch.subarray(s, s + 2 * RATE)))
    if (Number.isFinite(la) && Number.isFinite(lb)) section = Math.max(section, Math.abs(lb - la))
  }
  const sa = analyzeAudioBuffer(asBuffer(a))
  const sb = analyzeAudioBuffer(asBuffer(b))
  rows.push(
    `| ${scene} | ${fmt(integratedLufs(a))} | ${fmt(integratedLufs(b))} | ${fmt(section, 2)} | ${fmt(sa.peakDb)} / ${fmt(sb.peakDb)} | ${Math.round(sa.spectralCentroidHz)} / ${Math.round(sb.spectralCentroidHz)} | ${fmt(sa.highBandRatio * 100)} / ${fmt(sb.highBandRatio * 100)} | ${fmt(db(Math.sqrt(diff / (2 * n))))} | ${fmt(db(maxDiff))} |`,
  )
  if (mp3) {
    await $`ffmpeg -v error -y -i ${join(beforeDir, file)} -codec:a libmp3lame -q:a 2 ${join(mp3, `${scene}-before.mp3`)}`
    await $`ffmpeg -v error -y -i ${join(afterDir, file)} -codec:a libmp3lame -q:a 2 ${join(mp3, `${scene}-after.mp3`)}`
  }
}
const table = [
  "| Scene | LUFS before | LUFS after | Max 2 s section Δ (LU) | Peak dBFS before / after | Centroid Hz before / after | >4 kHz % before / after | Null RMS dBFS | Null max dBFS |",
  "| --- | --: | --: | --: | --: | --: | --: | --: | --: |",
  ...rows,
].join("\n")
console.log(table)
const md = opt("md")
if (md) writeFileSync(md, `${table}\n`)
