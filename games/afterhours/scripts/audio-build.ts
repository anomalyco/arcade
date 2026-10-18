// Builds the shipped game sounds from the audio lab's picks (offline; never plays anything).
//
//   bun scripts/audio-build.ts            # all picks → public/sfx/** + src/audio/sfx-manifest.ts
//
// Input: audio-lab/picks-aiden-2026-10-18-round2.json and the loudness-normalised takes in audio-lab/sfx/<cat>/<v>.mp3
// (docs/sfx-library.md: momentary-max LUFS for one-shots, integrated for loops). Per pick:
//  - footstep recordings (several steps each) are sliced into single steps at their onsets: each step runs from just
//    before its transient to just before the next (at most 0.6 s), its tail trimmed where it falls 30 dB under its
//    peak, 2 ms fade in / 25 ms fade out; weak steps (< 35% of the take's median peak) are dropped and the rest are
//    levelled to the median peak (±6 dB), so the runtime's own jitter is the only variation in level;
//  - loops are made seamless by crossfading their last 12% (≤ 1.5 s, equal power) into the head, then padded with
//    0.25 s of their own tail before and head after, with loopStart/loopEnd recorded (Opus decoders soften a stream's
//    first frames; the runtime loops only the inner region);
//  - one-shots are encoded as they are, with the time of their loudest transient (`hit`, s), so a door's latch clack
//    can be lined up with the leaf meeting the frame.
// Output: Ogg Opus (48 kHz; mono 48 kb/s, stereo beds 96 kb/s) in public/sfx/<category>/, and a typed manifest.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"

const ROOT = `${import.meta.dir}/..`
const LAB = `${ROOT}/audio-lab`
const PICKS = `${LAB}/picks-aiden-2026-10-18-round2.json`
const OUT = `${ROOT}/public/sfx`
const MANIFEST = `${ROOT}/src/audio/sfx-manifest.ts`
const RATE = 48000

/** Picks not shipped, with why (the slot stays in the manifest with no files). */
const SKIP: Record<string, string> = {
  "light-sodium-buzz": "not needed (Aiden)",
  "amb-forest-night": "sounds like highway noise (Aiden); slot for a regenerated take",
}
/** Kept stereo (non-positional beds); everything else is mono for positional playback. */
const STEREO = new Set(["amb-rain-asphalt", "amb-rain-thunder", "amb-hvac", "amb-corridor-tone", "amb-thunder", "hor-drone"])

type Pick = { category: string; variant: string; notes?: string }
type LabSound = { category: string; group: string; variant: string; loop: boolean; duration: number }
type Variant = { url: string; duration: number; hit?: number; loopStart?: number; loopEnd?: number; from: string }
type Entry = { group: string; loop: boolean; stereo: boolean; variants: Variant[]; skipped?: string }

const picks = (JSON.parse(readFileSync(PICKS, "utf8")) as { picks: Pick[] }).picks
const lab = JSON.parse(readFileSync(`${LAB}/sfx/manifest.json`, "utf8")) as { sounds: LabSound[] }

async function decode(file: string, channels: number): Promise<Float32Array[]> {
  const p = Bun.spawn(["ffmpeg", "-v", "error", "-i", file, "-f", "f32le", "-ac", String(channels), "-ar", String(RATE), "-"], { stdout: "pipe" })
  const buf = new Float32Array(await new Response(p.stdout).arrayBuffer())
  await p.exited
  const n = buf.length / channels
  return Array.from({ length: channels }, (_, c) => {
    const ch = new Float32Array(n)
    for (let i = 0; i < n; i++) ch[i] = buf[i * channels + c]!
    return ch
  })
}

async function encode(file: string, chans: Float32Array[]) {
  const n = chans[0]!.length
  const inter = new Float32Array(n * chans.length)
  for (let i = 0; i < n; i++) for (let c = 0; c < chans.length; c++) inter[i * chans.length + c] = chans[c]![i]!
  const kbps = chans.length > 1 ? "96k" : "48k"
  const p = Bun.spawn(
    ["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", String(RATE), "-ac", String(chans.length), "-i", "-", "-c:a", "libopus", "-b:a", kbps, "-application", "audio", file],
    { stdin: "pipe" },
  )
  p.stdin.write(new Uint8Array(inter.buffer))
  await p.stdin.end()
  if ((await p.exited) !== 0) throw new Error(`encode failed: ${file}`)
}

/** RMS envelope, 5.3 ms windows, 2.7 ms hop. */
function envelope(x: Float32Array, win = 256, hop = 128) {
  const out = new Float32Array(Math.max(1, Math.floor((x.length - win) / hop)))
  for (let k = 0; k < out.length; k++) {
    let s = 0
    for (let i = 0; i < win; i++) s += x[k * hop + i]! ** 2
    out[k] = Math.sqrt(s / win)
  }
  return { env: out, hop }
}

const mono = (ch: Float32Array[]) => {
  if (ch.length === 1) return ch[0]!
  const m = new Float32Array(ch[0]!.length)
  for (let i = 0; i < m.length; i++) m[i] = (ch[0]![i]! + ch[1]![i]!) / 2
  return m
}

function hitTime(x: Float32Array) {
  const { env, hop } = envelope(x)
  let best = 0
  for (let k = 1; k < env.length; k++) if (env[k]! > env[best]!) best = k
  return (best * hop) / RATE
}

/** Single steps from a multi-step footstep take. */
function sliceSteps(x: Float32Array): Float32Array[] {
  const { env, hop } = envelope(x)
  // Smooth ~16 ms so one heel-toe contact is one bump.
  const sm = new Float32Array(env.length)
  for (let k = 0; k < env.length; k++) {
    let s = 0
    let n = 0
    for (let j = Math.max(0, k - 3); j <= Math.min(env.length - 1, k + 3); j++) {
      s += env[j]!
      n++
    }
    sm[k] = s / n
  }
  const max = Math.max(...sm)
  // Steps (heel and toe together) are at least 0.34 s apart at a walk.
  const minGap = Math.round((0.34 * RATE) / hop)
  const peaks: number[] = []
  for (let k = 1; k < sm.length - 1; k++) {
    if (sm[k]! < 0.16 * max || sm[k]! < sm[k - 1]! || sm[k]! < sm[k + 1]!) continue
    const last = peaks.at(-1)
    if (last !== undefined && k - last < minGap) {
      if (sm[k]! > sm[last]!) peaks[peaks.length - 1] = k
      continue
    }
    peaks.push(k)
  }
  // Onset: back from each peak to where the envelope falls under a quarter of it (or the previous step's tail).
  // (Never more than 60 ms before the peak, so a quiet scuff ahead of the step doesn't start the slice early.)
  const starts = peaks.map((p, i) => {
    let k = p
    const floor = Math.max(i > 0 ? peaks[i - 1]! + Math.round(minGap / 2) : 0, p - Math.round((0.06 * RATE) / hop))
    while (k > floor && sm[k]! > 0.25 * sm[p]!) k--
    return Math.max(0, k * hop - Math.round(0.01 * RATE))
  })
  const out: { s: Float32Array; peak: number }[] = []
  for (let i = 0; i < starts.length; i++) {
    const a = starts[i]!
    let b = Math.min(i + 1 < starts.length ? starts[i + 1]! - Math.round(0.01 * RATE) : x.length, a + Math.round(0.6 * RATE))
    let peak = 0
    for (let j = a; j < b; j++) peak = Math.max(peak, Math.abs(x[j]!))
    // Trim the tail 30 dB under the peak (keeping 60 ms after it falls there).
    const { env: e, hop: h } = envelope(x.subarray(a, b), 256, 128)
    let last = 0
    for (let k = 0; k < e.length; k++) if (e[k]! > peak * 0.0316) last = k
    b = Math.min(b, a + last * h + 256 + Math.round(0.06 * RATE))
    const s = x.slice(a, b)
    const fi = Math.round(0.002 * RATE)
    const fo = Math.min(Math.round(0.025 * RATE), Math.floor(s.length / 3))
    for (let j = 0; j < fi; j++) s[j]! *= j / fi
    for (let j = 0; j < fo; j++) s[s.length - 1 - j]! *= j / fo
    if (s.length > 0.08 * RATE) out.push({ s, peak })
  }
  const med = [...out].map((o) => o.peak).sort((p, q) => p - q)[out.length >> 1] ?? 1
  // A slice whose loudest moment is late started on a scuff: move its start up to 40 ms before the hit. Slivers
  // (< 0.15 s: a heel tick split from its step) are dropped.
  for (const o of out) {
    const h = Math.round(hitTime(o.s) * RATE)
    if (h > 0.15 * RATE) o.s = o.s.slice(h - Math.round(0.04 * RATE))
  }
  return out
    .filter((o) => o.peak >= 0.35 * med && o.s.length >= 0.15 * RATE)
    .map((o) => {
      const g = Math.max(0.5, Math.min(2, med / o.peak))
      return o.s.map((v) => v * g)
    })
}

function makeLoop(ch: Float32Array[]) {
  const n = ch[0]!.length
  const F = Math.min(Math.round(1.5 * RATE), Math.round(n * 0.12))
  const L = n - F
  const P = Math.round(0.25 * RATE)
  const out = ch.map((x) => {
    const loop = x.slice(0, L)
    for (let i = 0; i < F; i++) {
      const u = i / F
      loop[i] = x[i]! * Math.sqrt(u) + x[L + i]! * Math.sqrt(1 - u)
    }
    const padded = new Float32Array(L + 2 * P)
    padded.set(loop.subarray(L - P), 0)
    padded.set(loop, P)
    padded.set(loop.subarray(0, P), P + L)
    return padded
  })
  return { out, loopStart: P / RATE, loopEnd: (P + L) / RATE }
}

const manifest: Record<string, Entry> = {}
rmSync(OUT, { recursive: true, force: true })
for (const pick of picks) {
  const meta = lab.sounds.find((s) => s.category === pick.category && s.variant === pick.variant)
  if (!meta) throw new Error(`no lab sound ${pick.category}/${pick.variant}`)
  const stereo = STEREO.has(pick.category)
  const entry = (manifest[pick.category] ??= { group: meta.group, loop: meta.loop, stereo, variants: [] })
  if (SKIP[pick.category]) {
    entry.skipped = SKIP[pick.category]
    continue
  }
  const src = `${LAB}/sfx/${pick.category}/${pick.variant}.mp3`
  const dir = `${OUT}/${pick.category}`
  mkdirSync(dir, { recursive: true })
  const ch = await decode(src, stereo ? 2 : 1)
  const from = `${pick.category}/${pick.variant}`
  if (meta.group === "footsteps") {
    const steps = sliceSteps(mono(ch))
    for (let i = 0; i < steps.length; i++) {
      const name = `${pick.variant}-${i + 1}.ogg`
      await encode(`${dir}/${name}`, [steps[i]!])
      entry.variants.push({ url: `sfx/${pick.category}/${name}`, duration: +(steps[i]!.length / RATE).toFixed(3), hit: +hitTime(steps[i]!).toFixed(3), from })
    }
    console.log(`${from}: ${steps.length} steps`)
  } else if (meta.loop) {
    const { out, loopStart, loopEnd } = makeLoop(ch)
    const name = `${pick.variant}.ogg`
    await encode(`${dir}/${name}`, out)
    entry.variants.push({ url: `sfx/${pick.category}/${name}`, duration: +(out[0]!.length / RATE).toFixed(3), loopStart: +loopStart.toFixed(4), loopEnd: +loopEnd.toFixed(4), from })
    console.log(`${from}: loop ${(loopEnd - loopStart).toFixed(2)} s`)
  } else {
    const name = `${pick.variant}.ogg`
    await encode(`${dir}/${name}`, ch)
    entry.variants.push({ url: `sfx/${pick.category}/${name}`, duration: +(ch[0]!.length / RATE).toFixed(3), hit: +hitTime(mono(ch)).toFixed(3), from })
    console.log(`${from}: one-shot, hit at ${hitTime(mono(ch)).toFixed(2)} s`)
  }
}

const ids = Object.keys(manifest)
const ts = `// Generated by scripts/audio-build.ts from audio-lab/picks-aiden-2026-10-18-round2.json. Do not edit.
// Files are Ogg Opus under public/sfx/ (URLs are relative to the page). Footstep takes are sliced into single steps;
// loops carry loopStart/loopEnd (s) inside 0.25 s of padding; one-shots carry \`hit\`, the time of their loudest
// transient (s). A category with \`skipped\` ships no files.

export type SfxVariant = { url: string; duration: number; hit?: number; loopStart?: number; loopEnd?: number; from: string }
export type SfxEntry = { group: string; loop: boolean; stereo: boolean; variants: readonly SfxVariant[]; skipped?: string }

export type SfxId = ${ids.map((i) => JSON.stringify(i)).join(" | ")}
export const SFX_IDS: readonly SfxId[] = ${JSON.stringify(ids)}

export const SFX: Record<SfxId, SfxEntry> = ${JSON.stringify(manifest, null, 2)}
`
writeFileSync(MANIFEST, ts)
const bytes = Bun.spawnSync(["du", "-sk", OUT]).stdout.toString().split("\t")[0]
console.log(`${ids.length} categories, ${Object.values(manifest).reduce((n, e) => n + e.variants.length, 0)} files, ${bytes} KB → ${MANIFEST}`)
