// Offline pipeline for the woods' own sounds (specs in ./specs.ts). Silent throughout: it measures with ffmpeg and
// TypeScript and never plays anything. Run from games/barbara:
//
//   2password run --env "ELEVENLABS_API_KEY=op://…" -- bun scripts/audio/sounds.ts generate [ids…]   raw takes (skips existing)
//   bun scripts/audio/sounds.ts curate [ids…]   trim, loop, measure, score, pick; contact sheets in $WORK/sheets
//   2password run … -- bun scripts/audio/sounds.ts tag [ids…]   ElevenLabs speech-to-text audio-event tags per take
//   bun scripts/audio/sounds.ts build           normalise, encode Ogg Opus into public/audio/, write src/audio/files.ts
//
// Work files: $WOODS_SFX_WORK (default $TMPDIR/opencode/woods-sfx): raw/<id>/<n>.mp3 (+ .json), proc/, curated/, sheets/.
// Picks can be overridden in $WORK/curated/<id>.json ("picked") before `build`.
import { $ } from "bun"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { analyzeSfx, detectOnsets, type SfxStats } from "../../../../packages/kit/audio/sfx-analysis"
import { decode } from "../../../../scripts/sfx/decode"
import { WOODS_SOUND_SPECS, type WoodsSoundSpec } from "./specs"

const SR = 48000
const game = new URL("../../", import.meta.url).pathname
const work = process.env.WOODS_SFX_WORK ?? join(process.env.TMPDIR ?? "/tmp", "opencode/woods-sfx")
const outDir = join(game, "public/audio")
const LICENSE = "ElevenLabs commercial sound-generation license (Anomaly)"
const PEAK_CAP_DB = -1
const LOOP_WRAP = 12000
const FONT = "/System/Library/Fonts/Supplemental/Arial.ttf"

const [command, ...args] = process.argv.slice(2)
const specs = WOODS_SOUND_SPECS.filter((s) => args.length === 0 || args.some((a) => s.id === a || (a.endsWith("*") && s.id.startsWith(a.slice(0, -1)))))

type RawMeta = { id: string; take: number; prompt: string; duration: number; influence: number; loop: boolean; traceId: string | null; cost: number | null; bytes: number }
type Candidate = { name: string; take: number; raw: string; pcm: string; stats: SfxStats; events: number; snr: number; seam?: number; steadiness?: number; tags?: string; score: number; reasons: string[]; picked?: boolean }
type Curated = { id: string; candidates: Candidate[]; picked: string[] }

const key = () => {
  const k = process.env.ELEVENLABS_API_KEY
  if (!k) throw new Error("ELEVENLABS_API_KEY is not set")
  return k
}

// ── generate ────────────────────────────────────────────────────────────────────────────────────────────────────

async function generateOne(spec: WoodsSoundSpec, take: number): Promise<void> {
  const dir = join(work, "raw", spec.id)
  const file = join(dir, `${take}.mp3`)
  if (existsSync(file)) return
  mkdirSync(dir, { recursive: true })
  for (let attempt = 1; ; attempt++) {
    const res = await fetch("https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_192", {
      method: "POST",
      headers: { "xi-api-key": key(), "content-type": "application/json" },
      body: JSON.stringify({ model_id: "eleven_text_to_sound_v2", text: spec.prompt, duration_seconds: spec.duration, prompt_influence: spec.influence, loop: Boolean(spec.loop) }),
    })
    if (res.ok) {
      const bytes = new Uint8Array(await res.arrayBuffer())
      writeFileSync(file, bytes)
      const meta: RawMeta = { id: spec.id, take, prompt: spec.prompt, duration: spec.duration, influence: spec.influence, loop: Boolean(spec.loop), traceId: res.headers.get("x-trace-id") ?? res.headers.get("request-id"), cost: Number(res.headers.get("character-cost")) || null, bytes: bytes.length }
      writeFileSync(join(dir, `${take}.json`), JSON.stringify(meta, null, 1))
      console.log(`  ${spec.id} #${take}: ${(bytes.length / 1024).toFixed(0)} KB, cost ${meta.cost}`)
      return
    }
    const body = await res.text()
    if (attempt >= 4 || (res.status !== 429 && res.status < 500)) throw new Error(`${spec.id} #${take}: ${res.status} ${body.slice(0, 200)}`)
    await Bun.sleep(1500 * attempt)
  }
}

async function generate() {
  const jobs = specs.flatMap((spec) => Array.from({ length: spec.takes }, (_, i) => () => generateOne(spec, i + 1)))
  let next = 0
  await Promise.all(Array.from({ length: 4 }, async () => { while (next < jobs.length) await jobs[next++]!() }))
  const cost = specs.flatMap((spec) => readdirSync(join(work, "raw", spec.id)).filter((f) => f.endsWith(".json")).map((f) => (JSON.parse(readFileSync(join(work, "raw", spec.id, f), "utf8")) as RawMeta).cost ?? 0))
  console.log(`${jobs.length} takes, ${cost.reduce((a, b) => a + b, 0)} credits recorded`)
}

// ── processing ──────────────────────────────────────────────────────────────────────────────────────────────────

const db = (v: number) => 20 * Math.log10(Math.max(1e-9, v))
const slice = (channels: Float32Array[], a: number, b: number) => channels.map((ch) => ch.slice(Math.max(0, a), Math.min(ch.length, b)))
const mono = (channels: Float32Array[]) => { const m = new Float32Array(channels[0]!.length); for (const ch of channels) for (let i = 0; i < m.length; i++) m[i]! += ch[i]! / channels.length; return m }

function envelope(x: Float32Array, win = 48): Float32Array {
  const env = new Float32Array(Math.ceil(x.length / win))
  for (let i = 0; i < x.length; i++) env[(i / win) | 0] = Math.max(env[(i / win) | 0]!, Math.abs(x[i]!))
  return env
}
function removeDc(channels: Float32Array[]) {
  for (const ch of channels) {
    let m = 0
    for (const v of ch) m += v
    m /= ch.length || 1
    for (let i = 0; i < ch.length; i++) ch[i]! -= m
  }
}
function fade(channels: Float32Array[], inSamples: number, outSamples: number) {
  for (const ch of channels) {
    const n = ch.length
    for (let i = 0; i < Math.min(inSamples, n); i++) ch[i]! *= i / inSamples
    for (let i = 0; i < Math.min(outSamples, n); i++) ch[n - 1 - i]! *= (i / outSamples) ** 2
  }
}
/** Trims a one-shot to its audible extent: 3 ms before it rises within 36 dB of peak, 60 ms after it falls 50 dB under (or near the floor). */
function trimOneShot(channels: Float32Array[]): Float32Array[] {
  const env = envelope(mono(channels))
  let peak = 0
  for (const v of env) peak = Math.max(peak, v)
  const first = env.findIndex((v) => v >= peak * 10 ** (-36 / 20))
  const sorted = [...env].sort((a, b) => a - b)
  const floor = sorted[Math.floor(sorted.length * 0.1)] ?? 0
  const end = Math.max(peak * 10 ** (-50 / 20), floor * 2.5)
  let last = env.length - 1
  while (last > first && env[last]! < end) last--
  const out = slice(channels, first * 48 - 144, (last + 1) * 48 + 2880)
  fade(out, 72, Math.min(4800, Math.floor(out[0]!.length * 0.2)))
  return out
}
/** Equal-power crossfade of the tail into the head; the result loops from its last sample to its first. */
function makeLoop(channels: Float32Array[], seconds = 1): Float32Array[] {
  const n = channels[0]!.length
  const l = Math.min(Math.round(seconds * SR), Math.floor(n / 3))
  return channels.map((ch) => {
    const out = ch.slice(0, n - l)
    for (let i = 0; i < l; i++) {
      const t = i / l
      out[i] = ch[i]! * Math.sin((t * Math.PI) / 2) + ch[n - l + i]! * Math.cos((t * Math.PI) / 2)
    }
    return out
  })
}
function seamRatio(channels: Float32Array[]): number {
  const ch = mono(channels)
  let step = 0
  for (let i = 1; i < ch.length; i++) step += Math.abs(ch[i]! - ch[i - 1]!)
  return Math.abs(ch[0]! - ch[ch.length - 1]!) / Math.max(1e-9, step / (ch.length - 1))
}
/** Short-term (3 s) loudness spread in LU. */
function steadiness(channels: Float32Array[]): number {
  const values: number[] = []
  for (let s = 0; s + 3 * SR <= channels[0]!.length; s += SR) values.push(analyzeSfx(slice(channels, s, s + 3 * SR)).lufs)
  const finite = values.filter(Number.isFinite)
  if (finite.length < 2) return 0
  const mean = finite.reduce((a, b) => a + b, 0) / finite.length
  return Math.sqrt(finite.reduce((a, b) => a + (b - mean) ** 2, 0) / finite.length)
}
function writeF32(path: string, channels: Float32Array[]) {
  const n = channels[0]!.length
  const inter = new Float32Array(n * channels.length)
  for (let i = 0; i < n; i++) for (let c = 0; c < channels.length; c++) inter[i * channels.length + c] = channels[c]![i]!
  writeFileSync(path, new Uint8Array(inter.buffer))
}
function readF32(path: string, count: number): Float32Array[] {
  const inter = new Float32Array(new Uint8Array(readFileSync(path)).buffer)
  const n = inter.length / count
  return Array.from({ length: count }, (_, c) => { const ch = new Float32Array(n); for (let i = 0; i < n; i++) ch[i] = inter[i * count + c]!; return ch })
}
/** Peak over the take's noise floor (10th percentile of 10 ms RMS windows), dB. */
function takeSnr(m: Float32Array): number {
  const rms: number[] = []
  let peak = 0
  for (let i = 0; i + 480 <= m.length; i += 480) {
    let s = 0
    for (let k = i; k < i + 480; k++) { s += m[k]! * m[k]!; peak = Math.max(peak, Math.abs(m[k]!)) }
    rms.push(Math.sqrt(s / 480))
  }
  rms.sort((a, b) => a - b)
  return db(peak) - db(rms[Math.floor(rms.length * 0.1)] ?? 1e-9)
}

const loudnessOf = (spec: WoodsSoundSpec, s: SfxStats) => (spec.loop ? s.lufs : s.momentaryMaxLufs)
/** How many separate onsets each event should have (knock: three; steps: several; the rest: few). */
const EXPECT_EVENTS: Record<string, [number, number]> = { "far.knock": [3, 3], "far.steps": [3, 7], "tree.knock": [1, 4], "far.cardoor": [1, 2], "far.screendoor": [1, 3], "far.radio": [1, 3] }

function score(spec: WoodsSoundSpec, list: Omit<Candidate, "score" | "reasons">[]): Candidate[] {
  const centroids = list.map((c) => c.stats.centroidHz).sort((a, b) => a - b)
  const med = centroids[centroids.length >> 1] ?? 1000
  return list.map((c) => {
    const reasons: string[] = []
    let s = 0
    const [lo, hi] = spec.range
    if (c.stats.durationSeconds < lo || c.stats.durationSeconds > hi) { s += 6; reasons.push(`duration ${c.stats.durationSeconds.toFixed(2)} s outside ${lo}–${hi}`) }
    if (!spec.loop && c.stats.momentaryMaxLufs < -40) { s += 10; reasons.push(`near-silent (${c.stats.momentaryMaxLufs.toFixed(1)} LUFS)`) }
    if (spec.loop && c.stats.lufs < -48) { s += 10; reasons.push(`near-silent bed (${c.stats.lufs.toFixed(1)} LUFS)`) }
    const crest = c.stats.peakDb - loudnessOf(spec, c.stats)
    if (crest > PEAK_CAP_DB - spec.target + 3) { s += (crest - (PEAK_CAP_DB - spec.target) - 3) * 0.25; reasons.push(`peaky (crest ${crest.toFixed(1)} dB)`) }
    const spread = Math.abs(Math.log2(c.stats.centroidHz / med))
    s += spread * 1.5
    if (spread > 0.8) reasons.push(`timbre off median (${Math.round(c.stats.centroidHz)} vs ${Math.round(med)} Hz)`)
    if (spec.loop) {
      s += Math.min(5, (c.steadiness ?? 0) * 0.8)
      if ((c.steadiness ?? 0) > 3) reasons.push(`unsteady bed (${c.steadiness!.toFixed(1)} LU)`)
      if ((c.seam ?? 0) > 6) { s += 2; reasons.push(`seam jump ${c.seam!.toFixed(1)}×`) }
    } else {
      if (c.snr < 40) { s += (40 - c.snr) * 0.15; reasons.push(`noisy (${c.snr.toFixed(0)} dB over floor)`) }
      const want = EXPECT_EVENTS[spec.id]
      if (want && (c.events < want[0] || c.events > want[1])) { s += 2 + Math.min(c.events, 6); reasons.push(`${c.events} onsets, expected ${want[0]}–${want[1]}`) }
    }
    return { ...c, score: s, reasons }
  })
}

async function sheet(spec: WoodsSoundSpec, candidates: Candidate[]) {
  const dir = join(work, "sheets")
  mkdirSync(dir, { recursive: true })
  const tiles: string[] = []
  for (const c of candidates) {
    const tile = join(work, "proc", spec.id, `${c.name}.png`)
    const label = `${c.picked ? "PICK " : ""}${c.name}  ${c.stats.durationSeconds.toFixed(2)}s  M ${c.stats.momentaryMaxLufs.toFixed(1)}  I ${c.stats.lufs.toFixed(1)}  ${Math.round(c.stats.centroidHz)}Hz  ev ${c.events}  score ${c.score.toFixed(1)}`
    await $`ffmpeg -v error -y -f f32le -ar ${SR} -ac ${c.stats.channels} -i ${c.pcm} -filter_complex ${`[0:a]aformat=channel_layouts=mono,asplit[a][b];[a]showwavespic=s=640x70:colors=${c.picked ? "0x7fe0a0" : "0x9aa8b4"}:scale=sqrt[w];[b]showspectrumpic=s=640x120:legend=0:scale=log:fscale=log:color=intensity[s];[w][s]vstack,pad=640:214:0:24:color=0x111418`} -frames:v 1 ${tile}`.quiet()
    await $`magick ${tile} -font ${FONT} -pointsize 13 -fill ${c.picked ? "#7fe0a0" : "#d0d8de"} -annotate +6+17 ${label} ${tile}`.quiet()
    tiles.push(tile)
  }
  await $`magick montage ${tiles} -tile 2x -geometry +2+2 -background ${"#111418"} ${join(dir, `${spec.id}.png`)}`.quiet()
}

const curatedPath = (id: string) => join(work, "curated", `${id}.json`)

async function curateOne(spec: WoodsSoundSpec): Promise<Curated> {
  const rawDir = join(work, "raw", spec.id)
  const procDir = join(work, "proc", spec.id)
  rmSync(procDir, { recursive: true, force: true })
  mkdirSync(procDir, { recursive: true })
  const old = existsSync(curatedPath(spec.id)) ? (JSON.parse(readFileSync(curatedPath(spec.id), "utf8")) as Curated) : null
  const list: Omit<Candidate, "score" | "reasons">[] = []
  const takes = existsSync(rawDir) ? readdirSync(rawDir).filter((f) => f.endsWith(".mp3")).map((f) => Number(f.replace(".mp3", ""))).sort((a, b) => a - b) : []
  for (const take of takes) {
    const raw = join(rawDir, `${take}.mp3`)
    const cut = spec.cuts?.[take]
    const channels = cut ? slice(await decode(raw, spec.stereo ? 2 : 1), Math.round(cut[0] * SR), Math.round(cut[1] * SR)) : await decode(raw, spec.stereo ? 2 : 1)
    if (cut) fade(channels, 48, Math.round(0.08 * SR))
    removeDc(channels)
    const snr = takeSnr(mono(channels))
    const piece = spec.loop ? makeLoop(channels) : trimOneShot(channels)
    const name = `t${take}`
    const pcm = join(procDir, `${name}.f32`)
    writeF32(pcm, piece)
    const stats = analyzeSfx(piece)
    const events = detectOnsets(mono(piece), { thresholdDb: -16, minGapSeconds: 0.18 }).length
    const tags = old?.candidates.find((c) => c.name === name)?.tags
    list.push({ name, take, raw, pcm, stats, events, snr, ...(tags ? { tags } : {}), ...(spec.loop ? { seam: seamRatio(piece), steadiness: steadiness(piece) } : {}) })
  }
  const scored = score(spec, list).sort((a, b) => a.score - b.score)
  const picked = spec.picks ? spec.picks.map((t) => scored.find((c) => c.take === t)!) : scored.filter((c) => c.score < 10).slice(0, spec.keep)
  for (const c of picked) c.picked = true
  const curated: Curated = { id: spec.id, candidates: scored, picked: picked.map((c) => c.name) }
  mkdirSync(join(work, "curated"), { recursive: true })
  writeFileSync(curatedPath(spec.id), JSON.stringify(curated, null, 1))
  await sheet(spec, scored)
  return curated
}

async function curate() {
  for (const spec of specs) {
    const c = await curateOne(spec)
    console.log(`${spec.id}: ${c.candidates.length} takes → ${c.candidates.filter((x) => x.picked).map((p) => `${p.name} (${p.score.toFixed(1)})`).join(", ")}`)
    for (const r of c.candidates) if (r.reasons.length || r.tags) console.log(`    ${r.name}: ${[...r.reasons, r.tags ? `heard as ${r.tags}` : ""].filter(Boolean).join("; ")}`)
  }
}

// ── tag: what does a listener model hear? ───────────────────────────────────────────────────────────────────────

/** ElevenLabs Scribe with audio-event tagging: a cheap second opinion on what a take contains ("(owl hooting)"). */
async function tag() {
  for (const spec of specs) {
    if (!existsSync(curatedPath(spec.id))) continue
    const curated = JSON.parse(readFileSync(curatedPath(spec.id), "utf8")) as Curated
    for (const c of curated.candidates) {
      if (c.tags) continue
      const form = new FormData()
      form.append("model_id", "scribe_v1")
      form.append("tag_audio_events", "true")
      form.append("file", new Blob([readFileSync(c.raw)], { type: "audio/mpeg" }), `${spec.id}-${c.name}.mp3`)
      const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": key() }, body: form })
      if (!res.ok) { console.log(`  ${spec.id} ${c.name}: ${res.status} ${(await res.text()).slice(0, 120)}`); continue }
      const body = (await res.json()) as { text?: string }
      c.tags = (body.text ?? "").trim().slice(0, 160) || "(nothing)"
      console.log(`  ${spec.id} ${c.name}: ${c.tags}`)
    }
    writeFileSync(curatedPath(spec.id), JSON.stringify(curated, null, 1))
  }
}

// ── build ───────────────────────────────────────────────────────────────────────────────────────────────────────

const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d

async function encode(spec: WoodsSoundSpec, channels: Float32Array[], file: string, trimDb = 0) {
  const stats = analyzeSfx(channels)
  const gainDb = Math.min(spec.target - loudnessOf(spec, stats), PEAK_CAP_DB - 0.5 - stats.peakDb) - trimDb
  const g = 10 ** (gainDb / 20)
  // Loops carry 0.25 s of their own tail before and head after, so the codec's imperfect first and last frames stay
  // outside the loop region [LOOP_WRAP, LOOP_WRAP + length).
  const scaled = channels.map((ch) => {
    const v = ch.map((x) => x * g)
    if (!spec.loop) return v
    const out = new Float32Array(v.length + 2 * LOOP_WRAP)
    out.set(v.subarray(v.length - LOOP_WRAP), 0)
    out.set(v, LOOP_WRAP)
    out.set(v.subarray(0, LOOP_WRAP), LOOP_WRAP + v.length)
    return out
  })
  const tmp = join(work, "encode.f32")
  writeF32(tmp, scaled)
  const bitrate = spec.stereo ? "64k" : spec.loop ? "40k" : "48k"
  await $`ffmpeg -v error -y -f f32le -ar ${SR} -ac ${channels.length} -i ${tmp} -c:a libopus -b:a ${bitrate} -application audio -frame_duration 20 ${file}`.quiet()
}

type WoodsFile = { file: string; license: string; provenance: string; prompt: string; requestId?: string; seconds: number; loudness: number; peakDb: number; gain: number; bytes: number; loopStart?: number; loopEnd?: number }

async function build() {
  mkdirSync(outDir, { recursive: true })
  const files: Record<string, WoodsFile[]> = {}
  const keep = new Set<string>()
  for (const spec of WOODS_SOUND_SPECS) {
    if (!existsSync(curatedPath(spec.id))) { console.log(`skip ${spec.id}: not curated`); continue }
    const curated = JSON.parse(readFileSync(curatedPath(spec.id), "utf8")) as Curated
    const list: WoodsFile[] = []
    let n = 0
    for (const name of curated.picked) {
      const c = curated.candidates.find((x) => x.name === name)!
      const file = `${spec.id}.${++n}.ogg`
      const out = join(outDir, file)
      const pcm = readF32(c.pcm, c.stats.channels)
      await encode(spec, pcm, out)
      keep.add(file)
      let decoded = await decode(out, c.stats.channels)
      const over = analyzeSfx(decoded).peakDb - (PEAK_CAP_DB + 0.4)
      if (over > 0) { await encode(spec, pcm, out, over + 0.2); decoded = await decode(out, c.stats.channels) }
      const stats = analyzeSfx(spec.loop ? decoded.map((ch) => ch.subarray(LOOP_WRAP, ch.length - LOOP_WRAP)) : decoded)
      const loudness = loudnessOf(spec, stats)
      const meta = JSON.parse(readFileSync(c.raw.replace(/\.mp3$/, ".json"), "utf8")) as RawMeta
      list.push({
        file, license: LICENSE, prompt: meta.prompt,
        provenance: `eleven_text_to_sound_v2, take ${c.take} of ${spec.takes}, ${meta.duration} s requested, prompt influence ${meta.influence}${meta.loop ? ", loop" : ""}; trimmed, ${spec.loop ? "crossfade-looped, " : ""}normalised to ${spec.target} ${spec.loop ? "LUFS" : "LUFS momentary max"}, Ogg Opus`,
        ...(meta.traceId ? { requestId: meta.traceId } : {}),
        seconds: round(stats.durationSeconds, 3), loudness: round(loudness, 1), peakDb: round(stats.peakDb, 1), gain: round(10 ** ((spec.target - loudness) / 20), 3), bytes: statSync(out).size,
        ...(spec.loop ? { loopStart: LOOP_WRAP / SR, loopEnd: round(LOOP_WRAP / SR + c.stats.durationSeconds, 6) } : {}),
      })
    }
    files[spec.id] = list
  }
  for (const f of readdirSync(outDir)) if (f.endsWith(".ogg") && !keep.has(f)) rmSync(join(outDir, f))
  const body = Object.entries(files).map(([id, list]) => `  ${JSON.stringify(id)}: [\n${list.map((f) => `    ${JSON.stringify(f)},`).join("\n")}\n  ],`).join("\n")
  writeFileSync(join(game, "src/audio/files.ts"), `// Generated by scripts/audio/sounds.ts build. Do not edit by hand.

export type WoodsFile = {
  /** Under public/audio/. */
  file: string
  license: string
  provenance: string
  prompt: string
  requestId?: string
  seconds: number
  /** Measured: integrated LUFS for loops, momentary-max LUFS for one-shots. */
  loudness: number
  peakDb: number
  /** Linear gain landing the file on its spec's target. */
  gain: number
  bytes: number
  /** Loops: the seamless region (s); the file pads it with its own tail before and head after. */
  loopStart?: number
  loopEnd?: number
}

export const WOODS_FILES = {
${body}
} as const satisfies Record<string, readonly WoodsFile[]>

export type WoodsSoundId = keyof typeof WOODS_FILES
`)
  const all = Object.values(files).flat()
  console.log(`${Object.keys(files).length} ids, ${all.length} files, ${(all.reduce((s, f) => s + f.bytes, 0) / 1048576).toFixed(2)} MB`)
}

if (command === "generate") await generate()
else if (command === "curate") await curate()
else if (command === "tag") await tag()
else if (command === "build") await build()
else console.log("usage: sounds.ts generate|curate|tag|build [ids…]")
