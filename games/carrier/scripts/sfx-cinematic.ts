// The cinematic sound bank (src/audio/sfx-slots.ts): transcodes every raw ElevenLabs take into public/sfx/v3/ and
// writes public/sfx/v3/manifest.json (per take: duration, loop length, loudest moment, loudness, true peak).
//
//   bun scripts/sfx-cinematic.ts /tmp/opencode/sfx-v3raw        (raw takes named <slot>-<n>.mp3)
//
// Raw takes: ElevenLabs Sound Effects v2 (eleven_text_to_sound_v2), prompt influence 0.45, the prompt, duration and
// loop flag of each slot in sfx-slots.ts, 3-4 takes per slot. Processing, per take (ffmpeg):
//   - 48 kHz stereo; one-shots: leading silence trimmed (-50 dB), trailing silence trimmed (-62 dB) with a 120 ms fade so
//     natural tails stay; loops: crossfade-looped (an equal-power 0.4 s crossfade of the tail into the head), then the
//     first 0.25 s appended so a decoder's padding never lands inside the loop (the game loops [0, loop) exactly).
//   - Loudness-normalised (EBU R128, integrated): one-shots -16 LUFS, loops and beds -20 LUFS, interface -26 LUFS, each
//     capped so the true peak stays at or under -1 dBTP (takes too short to gate: peak-normalised, -14 / -3 dBTP).
//   - Ogg Opus (WebAudio decodeAudioData: Chrome, Firefox, Safari 18.4+; Safari 26 is the WebGPU floor), 96 kb/s, beds
//     112 kb/s.
// The seam of each loop is checked: the RMS and spectral tilt of the 100 ms either side of the loop point (printed).
import { $ } from "bun"
import { mkdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { SLOTS } from "../src/audio/sfx-slots"

const raw = process.argv[2] ?? "/tmp/opencode/sfx-v3raw"
const only = process.argv[3]?.split(",")
const out = join(import.meta.dir, "../public/sfx/v3")
mkdirSync(out, { recursive: true })
const SR = 48000
const FADE = 0.4
const WRAP = 0.25
const BEDS = new Set(["carrier-bed", "ocean-calm", "ocean-rough", "ocean-storm", "wind-light", "wind-gale", "rain-light", "rain-heavy", "rain-canopy"])

type Take = { dur: number; loop?: number; peak: number; lufs: number; tp: number; seam?: number }
const manifestPath = join(out, "manifest.json")
const manifest: Record<string, Take> = existsSync(manifestPath) ? await Bun.file(manifestPath).json() : {}

const pcm = async (file: string): Promise<[Float32Array, Float32Array]> => {
  const b = new Float32Array(await $`ffmpeg -v error -i ${file} -ac 2 -ar ${SR} -f f32le -`.arrayBuffer())
  const n = b.length / 2
  const l = new Float32Array(n)
  const r = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    l[i] = b[i * 2]!
    r[i] = b[i * 2 + 1]!
  }
  return [l, r]
}
const writeWav = async (file: string, l: Float32Array, r: Float32Array) => {
  const n = l.length
  const buf = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    buf[i * 2] = l[i]!
    buf[i * 2 + 1] = r[i]!
  }
  await Bun.write(`${file}.f32`, buf)
  await $`ffmpeg -v error -y -f f32le -ar ${SR} -ac 2 -i ${file}.f32 ${file}`
  await $`rm -f ${file}.f32`
}
const loudness = async (file: string): Promise<{ i: number; tp: number }> => {
  const r = await $`ffmpeg -hide_banner -nostats -i ${file} -af ebur128=peak=true -f null -`.quiet().nothrow()
  const s = r.stderr.toString()
  const sum = s.slice(s.lastIndexOf("Summary:"))
  const i = Number(/I:\s+(-?[\d.]+|-inf) LUFS/.exec(sum)?.[1] ?? Number.NaN)
  const tp = Number(/Peak:\s+(-?[\d.]+|-inf) dBFS/.exec(sum)?.[1] ?? Number.NaN)
  return { i: Number.isFinite(i) ? i : -70, tp: Number.isFinite(tp) ? tp : -70 }
}
/** RMS (dB) and high/low energy ratio (dB) of a window: for comparing either side of a loop seam. */
const shape = (x: Float32Array, a: number, b: number) => {
  let s = 0
  let d = 0
  for (let i = Math.max(1, a); i < b; i++) {
    s += x[i]! * x[i]!
    d += (x[i]! - x[i - 1]!) ** 2
  }
  return { rms: 10 * Math.log10(s / (b - a) + 1e-12), tilt: 10 * Math.log10((d + 1e-12) / (s + 1e-12)) }
}

let bytes = 0
for (const slot of SLOTS) {
  if (only && !only.includes(slot.id)) continue
  for (let n = 1; n <= slot.count; n++) {
    const name = `${slot.id}-${n}`
    const src = join(raw, `${name}.mp3`)
    if (!existsSync(src)) {
      console.log(`${name.padEnd(20)} MISSING`)
      continue
    }
    let [l, r] = await pcm(src)
    let loopLen: number | undefined
    let seam: number | undefined
    if (slot.loop) {
      const f = Math.min(Math.floor(FADE * SR), Math.floor(l.length / 4))
      const len = l.length - f
      const wrap = Math.floor(WRAP * SR)
      const ol = new Float32Array(len + wrap)
      const or = new Float32Array(len + wrap)
      for (let i = 0; i < len; i++) {
        ol[i] = l[i]!
        or[i] = r[i]!
      }
      for (let i = 0; i < f; i++) {
        const w = (i + 0.5) / f
        const a = Math.sin((w * Math.PI) / 2)
        const b = Math.cos((w * Math.PI) / 2)
        ol[i] = l[i]! * a + l[len + i]! * b
        or[i] = r[i]! * a + r[len + i]! * b
      }
      for (let i = 0; i < wrap; i++) {
        ol[len + i] = ol[i]!
        or[len + i] = or[i]!
      }
      l = ol
      r = or
      loopLen = len / SR
      const w = Math.floor(0.1 * SR)
      const before = shape(l, len - w, len)
      const after = shape(l, 0, w)
      seam = Math.abs(before.rms - after.rms) + Math.abs(before.tilt - after.tilt)
    }
    const tmp = `/tmp/sfx-v3-${name}.wav`
    await writeWav(tmp, l, r)
    const trimmed = `/tmp/sfx-v3-${name}-t.wav`
    if (slot.loop) await $`cp ${tmp} ${trimmed}`
    else {
      const len0 = Number((await $`ffprobe -v error -show_entries format=duration -of csv=p=0 ${tmp}`.text()).trim())
      void len0
      await $`ffmpeg -v error -y -i ${tmp} -af silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-62dB,areverse ${trimmed}`
    }
    const dur = Number((await $`ffprobe -v error -show_entries format=duration -of csv=p=0 ${trimmed}`.text()).trim())
    const target = slot.category === "ui" ? -26 : slot.loop ? -20 : -16
    const m = await loudness(trimmed)
    // Too short for a gated loudness reading: normalise the peak instead (interface -14 dBTP, others -3).
    let gain = m.i <= -69 ? (slot.category === "ui" ? -14 : -3) - m.tp : target - m.i
    if (m.tp + gain > -1) gain = -1 - m.tp
    const fades = slot.loop ? "" : `,afade=t=in:d=0.004,afade=t=out:st=${Math.max(0, dur - 0.12).toFixed(3)}:d=0.12`
    const dst = join(out, `${name}.ogg`)
    const rate = BEDS.has(slot.id) ? "112k" : "96k"
    await $`ffmpeg -v error -y -i ${trimmed} -af volume=${gain.toFixed(2)}dB${fades} -ar ${SR} -ac 2 -c:a libopus -b:a ${rate} -vbr on -application audio ${dst}`
    const after = await loudness(dst)
    // Loudest 100 ms (a flyby's pass, an explosion's hit).
    const [pl] = await pcm(dst)
    let best = 0
    let at = 0
    const w = Math.floor(0.1 * SR)
    for (let i = 0; i + w <= pl.length; i += Math.floor(w / 4)) {
      let s = 0
      for (let j = 0; j < w; j++) s += pl[i + j]! ** 2
      if (s > best) {
        best = s
        at = (i + w / 2) / SR
      }
    }
    const size = Bun.file(dst).size
    bytes += size
    manifest[name] = { dur: Math.round(dur * 1000) / 1000, ...(loopLen ? { loop: Math.round(loopLen * 1e5) / 1e5 } : {}), peak: Math.round(at * 100) / 100, lufs: Math.round(after.i * 10) / 10, tp: Math.round(after.tp * 10) / 10, ...(seam !== undefined ? { seam: Math.round(seam * 10) / 10 } : {}) }
    await $`rm -f ${tmp} ${trimmed}`
    console.log(`${name.padEnd(20)} ${dur.toFixed(2)} s  ${after.i.toFixed(1)} LUFS  tp ${after.tp.toFixed(1)}  peak@${at.toFixed(2)}${seam !== undefined ? `  seam Δ${seam.toFixed(1)} dB` : ""}  ${(size / 1024).toFixed(0)} KB`)
  }
}
await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 1)}\n`)
console.log(`wrote ${(bytes / 1048576).toFixed(2)} MB`)

// First-run defaults for public/sfx/picks.json (never overwrites: the user's SOUNDS-tab picks replace it). A guess
// until someone listens: loops by the smoothest seam, flybys by the most centred pass, hits by the most punch
// (true peak over loudness), everything else take 1.
const picksPath = join(import.meta.dir, "../public/sfx/picks.json")
if (!existsSync(picksPath)) {
  const picks: Record<string, { take: number; trim: number; ratings: number[] }> = {}
  for (const slot of SLOTS) {
    let best = 1
    let score = Number.NEGATIVE_INFINITY
    for (let n = 1; n <= slot.count; n++) {
      const t = manifest[`${slot.id}-${n}`]
      if (!t) continue
      const v = slot.loop ? -(t.seam ?? 0) : slot.category === "flyby" ? -Math.abs(t.peak / t.dur - 0.4) : ["boom", "carrier", "gun", "bomb", "hooks"].includes(slot.category) ? t.tp - t.lufs : -n
      if (v > score) {
        score = v
        best = n
      }
    }
    picks[slot.id] = { take: best, trim: 0, ratings: [] }
  }
  await Bun.write(picksPath, `${JSON.stringify(picks, null, 1)}\n`)
  console.log(`wrote default picks: ${picksPath}`)
}
