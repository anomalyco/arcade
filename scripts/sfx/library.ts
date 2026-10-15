// Offline pipeline for the shared sound library (`packages/kit/audio/library.ts`). Silent throughout: it measures with
// ffmpeg and TypeScript, never plays anything.
//
//   bun --env-file=<file with ELEVENLABS_API_KEY> scripts/sfx/library.ts generate [ids…]   raw candidates (skips existing)
//   bun scripts/sfx/library.ts curate [ids…]     process, measure, score and pick variants; writes contact sheets
//   bun scripts/sfx/library.ts build             normalise, encode Ogg Opus into packages/kit/audio/sfx/, write library-files.ts
//
// Work files live in $SFX_WORK (default $TMPDIR/opencode/sfx): raw/<id>/<n>.mp3 (+ .json request metadata),
// proc/<id>/<candidate>.f32, curated/<id>.json and sheets/<id>.png.
import { $ } from "bun"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { SFX_SPECS, type SfxSpec } from "../../packages/kit/audio/library"
import { LIBRARY_FILES, type LibraryFile } from "../../packages/kit/audio/library-files"
import { analyzeSfx, detectOnsets, type SfxStats } from "../../packages/kit/audio/sfx-analysis"
import { decode } from "./decode"

const SR = 48000
const root = new URL("../../", import.meta.url).pathname
const work = process.env.SFX_WORK ?? join(process.env.TMPDIR ?? "/tmp", "opencode/sfx")
const outDir = join(root, "packages/kit/audio/sfx")
const LICENSE = "ElevenLabs commercial sound-generation license (Anomaly)"
const PEAK_CAP_DB = -1
const LOOP_WRAP = 12000
const FONT = "/System/Library/Fonts/Supplemental/Arial.ttf"

const [command, ...args] = process.argv.slice(2)
const specs = SFX_SPECS.filter(s => s.generate && (args.length === 0 || args.some(a => s.id === a || (a.endsWith("*") && s.id.startsWith(a.slice(0, -1))))))

type RawMeta = { id: string; take: number; prompt: string; duration: number; influence: number; loop: boolean; traceId: string | null; cost: number | null; bytes: number }
type Candidate = { name: string; take: number; raw: string; pcm: string; stats: SfxStats; events: number; snr: number; flatRuns: number; decayDb: number; seam?: number; steadiness?: number; score: number; reasons: string[]; picked?: boolean }
type Curated = { id: string; candidates: Candidate[]; picked: string[] }

// ── generate ────────────────────────────────────────────────────────────────────────────────────────────────────

async function generateOne(spec: SfxSpec, take: number): Promise<void> {
  const gen = spec.generate!
  const dir = join(work, "raw", spec.id)
  const file = join(dir, `${take}.mp3`)
  if (existsSync(file)) return
  mkdirSync(dir, { recursive: true })
  const key = process.env.ELEVENLABS_API_KEY
  if (!key) throw new Error("ELEVENLABS_API_KEY is not set")
  for (let attempt = 1; ; attempt++) {
    const res = await fetch("https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_192", {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ model_id: "eleven_text_to_sound_v2", text: gen.prompt, duration_seconds: gen.duration, prompt_influence: gen.influence ?? 0.45, loop: Boolean(gen.loop) }),
    })
    if (res.ok) {
      const bytes = new Uint8Array(await res.arrayBuffer())
      writeFileSync(file, bytes)
      const meta: RawMeta = { id: spec.id, take, prompt: gen.prompt, duration: gen.duration, influence: gen.influence ?? 0.45, loop: Boolean(gen.loop), traceId: res.headers.get("x-trace-id"), cost: Number(res.headers.get("character-cost")) || null, bytes: bytes.length }
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
  const jobs = specs.flatMap(spec => Array.from({ length: spec.generate!.candidates }, (_, i) => () => generateOne(spec, i + 1)))
  let next = 0
  await Promise.all(Array.from({ length: 4 }, async () => { while (next < jobs.length) await jobs[next++]!() }))
  const cost = specs.flatMap(spec => readdirSync(join(work, "raw", spec.id)).filter(f => f.endsWith(".json")).map(f => (JSON.parse(readFileSync(join(work, "raw", spec.id, f), "utf8")) as RawMeta).cost ?? 0))
  console.log(`${jobs.length} candidates, ${cost.reduce((a, b) => a + b, 0)} credits recorded`)
}

// ── processing ──────────────────────────────────────────────────────────────────────────────────────────────────

const db = (v: number) => 20 * Math.log10(Math.max(1e-9, v))

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

const slice = (channels: Float32Array[], a: number, b: number) => channels.map(ch => ch.slice(Math.max(0, a), Math.min(ch.length, b)))
const mono = (channels: Float32Array[]) => { const m = new Float32Array(channels[0]!.length); for (const ch of channels) for (let i = 0; i < m.length; i++) m[i]! += ch[i]! / channels.length; return m }

/** Trims a one-shot to its audible extent: 3 ms before it rises within 36 dB of peak, 40 ms after it falls 54 dB under. */
function trimOneShot(channels: Float32Array[]): Float32Array[] {
  const env = envelope(mono(channels))
  const peak = Math.max(...env)
  const first = env.findIndex(v => v >= peak * 10 ** (-36 / 20))
  const sorted = [...env].sort((a, b) => a - b)
  const floor = sorted[Math.floor(sorted.length * 0.1)] ?? 0
  const end = Math.max(peak * 10 ** (-54 / 20), floor * 2.5)
  let last = env.length - 1
  while (last > first && env[last]! < end) last--
  const out = slice(channels, first * 48 - 144, (last + 1) * 48 + 1920)
  fade(out, 72, Math.min(1440, Math.floor(out[0]!.length * 0.15)))
  return out
}

/** Equal-power crossfade of the tail into the head; the result loops seamlessly from its last sample to its first. */
function makeLoop(channels: Float32Array[], seconds = 0.6): Float32Array[] {
  const n = channels[0]!.length
  const l = Math.min(Math.round(seconds * SR), Math.floor(n / 3))
  return channels.map(ch => {
    const out = ch.slice(0, n - l)
    for (let i = 0; i < l; i++) {
      const t = i / l
      out[i] = ch[i]! * Math.sin((t * Math.PI) / 2) + ch[n - l + i]! * Math.cos((t * Math.PI) / 2)
    }
    return out
  })
}

/** Loop seam: RMS of the jump across the seam relative to the bed's typical sample-to-sample step. */
function seamRatio(channels: Float32Array[]): number {
  const ch = mono(channels)
  const n = ch.length
  let step = 0
  for (let i = 1; i < n; i++) step += Math.abs(ch[i]! - ch[i - 1]!)
  step /= n - 1
  return Math.abs(ch[0]! - ch[n - 1]!) / Math.max(1e-9, step)
}

/** Short-term (3 s) loudness spread in LU: how steady a bed is. */
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

/** Peak over noise floor (10th percentile of 10 ms RMS windows) of a whole take, dB. */
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

/** RMS drop from the first 50 ms to 200–400 ms: how quickly a transient dies away (a gunshot, not a burst of noise). */
function decayOf(m: Float32Array): number {
  const rms = (a: number, b: number) => { let s = 0; const e = Math.min(m.length, b); for (let i = a; i < e; i++) s += m[i]! * m[i]!; return Math.sqrt(s / Math.max(1, e - a)) }
  return db(rms(0, 2400)) - db(rms(9600, 19200))
}

/** Continuous sounds (moans, rummaging) fill their take, so a noise floor can't be measured against them. */
const DISCRETE = (spec: SfxSpec) => spec.bus !== "voice" && spec.id !== "search.rummage"

/** Runs of three or more consecutive samples pinned near full scale: clipping baked into the take (not recoverable overs). */
function flatRuns(channels: Float32Array[]): number {
  let runs = 0
  for (const ch of channels) {
    let run = 0
    for (let i = 1; i < ch.length; i++) {
      const pinned = Math.abs(ch[i]!) >= 0.98 && Math.abs(ch[i]! - ch[i - 1]!) < 0.002
      run = pinned ? run + 1 : 0
      if (run === 2) runs++
    }
  }
  return runs
}

/** Single-event sounds: more than one strong onset means the generator made a burst or a sequence. */
const SINGLE = new Set([
  "gun.pistol.shot", "gun.dry-fire", "flashlight.click", "zombie.hit", "body.hurt", "door.bash",
  // A magazine seating (scrape, click) and glass (crack, falling shards) are several onsets by nature.
  "gun.pistol.mag-release", "item.drop",
  ...["wood", "plaster", "concrete", "metal"].map(s => `impact.bullet.${s}`),
])

/** Ambience beds are stereo; positional loops (crafting, generator, horde) are mono like every other emitter. */
const STEREO = (spec: SfxSpec) => Boolean(spec.loop) && spec.bus === "ambience"

const loudnessOf = (spec: SfxSpec, s: SfxStats) => (spec.loop ? s.lufs : s.momentaryMaxLufs)

function scoreCandidates(spec: SfxSpec, list: Omit<Candidate, "score" | "reasons">[]): Candidate[] {
  const centroids = list.map(c => c.stats.centroidHz).sort((a, b) => a - b)
  const medCentroid = centroids[centroids.length >> 1] ?? 1000
  const louds = list.map(c => loudnessOf(spec, c.stats)).sort((a, b) => a - b)
  const medLoud = louds[louds.length >> 1] ?? -20
  return list.map(c => {
    const reasons: string[] = []
    let score = 0
    const [lo, hi] = spec.durationRange
    if (c.stats.durationSeconds < lo || c.stats.durationSeconds > hi) { score += 10; reasons.push(`duration ${c.stats.durationSeconds.toFixed(2)} s outside ${lo}–${hi}`) }
    if (!spec.loop && !spec.generate?.slice && c.stats.momentaryMaxLufs < -38) { score += 10; reasons.push(`near-silent take (${c.stats.momentaryMaxLufs.toFixed(1)} LUFS)`) }
    if (c.flatRuns > 0) { score += Math.min(4, 1 + c.flatRuns / 10); reasons.push(`${c.flatRuns} flat-topped runs (hard clipping in the take)`) }
    const crest = c.stats.peakDb - loudnessOf(spec, c.stats)
    const headroom = PEAK_CAP_DB - spec.target
    if (crest > headroom + 3) { score += (crest - headroom - 3) * 0.25; reasons.push(`peaky: reaches only ${(PEAK_CAP_DB - crest).toFixed(1)} of ${spec.target}`) }
    const spread = Math.abs(Math.log2(c.stats.centroidHz / medCentroid))
    score += spread * 1.5
    if (spread > 0.8) reasons.push(`timbre off median (${Math.round(c.stats.centroidHz)} vs ${Math.round(medCentroid)} Hz)`)
    if (spec.generate?.slice) {
      score += Math.abs(loudnessOf(spec, c.stats) - medLoud) * 0.3
    }
    if (SINGLE.has(spec.id) && c.events !== 1) { score += c.events ? 2 * (c.events - 1) : 3; reasons.push(`${c.events} events, expected one`) }
    if (SINGLE.has(spec.id) && spec.bus !== "voice" && c.decayDb < 12) { score += (12 - c.decayDb) * 0.3; reasons.push(`slow decay (${c.decayDb.toFixed(1)} dB by 0.2 s)`) }
    if (spec.loop && c.stats.lufs < -45) { score += 10; reasons.push(`near-silent bed (${c.stats.lufs.toFixed(1)} LUFS)`) }
    if (spec.loop) {
      score += Math.min(5, (c.steadiness ?? 0) * 0.8)
      if ((c.steadiness ?? 0) > 3) reasons.push(`unsteady bed (${c.steadiness!.toFixed(1)} LU)`)
      if ((c.seam ?? 0) > 6) { score += 2; reasons.push(`seam jump ${c.seam!.toFixed(1)}× typical step`) }
    }
    if (!spec.loop && DISCRETE(spec) && c.snr < 45) { score += (45 - c.snr) * 0.2; reasons.push(`noisy take (${c.snr.toFixed(0)} dB over floor)`) }
    if (c.stats.leadingSilence > 0.02) reasons.push(`onset ${Math.round(c.stats.leadingSilence * 1000)} ms`)
    return { ...c, score, reasons }
  })
}

async function sheet(spec: SfxSpec, candidates: Candidate[]) {
  const dir = join(work, "sheets")
  mkdirSync(dir, { recursive: true })
  const tiles: string[] = []
  for (const c of candidates) {
    const tile = join(work, "proc", spec.id, `${c.name}.png`)
    const label = `${c.picked ? "PICK " : ""}${c.name}  ${c.stats.durationSeconds.toFixed(2)}s  M ${c.stats.momentaryMaxLufs.toFixed(1)}  I ${c.stats.lufs.toFixed(1)}  pk ${c.stats.peakDb.toFixed(1)}  ${Math.round(c.stats.centroidHz)}Hz  score ${c.score.toFixed(1)}`
    const ch = c.stats.channels
    await $`ffmpeg -v error -y -f f32le -ar ${SR} -ac ${ch} -i ${c.pcm} -filter_complex ${`[0:a]aformat=channel_layouts=mono,asplit[a][b];[a]showwavespic=s=640x70:colors=${c.picked ? "0x7fe0a0" : "0x9aa8b4"}:scale=sqrt[w];[b]showspectrumpic=s=640x120:legend=0:scale=log:fscale=log:color=intensity[s];[w][s]vstack,pad=640:214:0:24:color=0x111418`} -frames:v 1 ${tile}`.quiet()
    await $`magick ${tile} -font ${FONT} -pointsize 13 -fill ${c.picked ? "#7fe0a0" : "#d0d8de"} -annotate +6+17 ${label} ${tile}`.quiet()
    tiles.push(tile)
  }
  await $`magick montage ${tiles} -tile 2x -geometry +2+2 -background ${"#111418"} ${join(dir, `${spec.id}.png`)}`.quiet()
}

async function curateOne(spec: SfxSpec): Promise<Curated> {
  const gen = spec.generate!
  const rawDir = join(work, "raw", spec.id)
  const procDir = join(work, "proc", spec.id)
  rmSync(procDir, { recursive: true, force: true })
  mkdirSync(procDir, { recursive: true })
  const list: Omit<Candidate, "score" | "reasons">[] = []
  const takes = existsSync(rawDir) ? readdirSync(rawDir).filter(f => f.endsWith(".mp3")).map(f => Number(f.replace(".mp3", ""))).sort((a, b) => a - b) : []
  for (const take of takes) {
    const raw = join(rawDir, `${take}.mp3`)
    const channels = await decode(raw, STEREO(spec) ? 2 : 1)
    removeDc(channels)
    const snr = takeSnr(mono(channels))
    const runs = flatRuns(channels)
    const pieces: { name: string; channels: Float32Array[] }[] = []
    if (gen.slice) {
      const m = mono(channels)
      const onsets = detectOnsets(m, { thresholdDb: -22, minGapSeconds: gen.slice.minGapSeconds })
      onsets.forEach((t, k) => {
        const a = Math.round(t * SR) - 240
        const next = onsets[k + 1] !== undefined ? Math.round(onsets[k + 1]! * SR) - 480 : m.length
        const b = Math.min(next, a + Math.round(gen.slice!.maxSeconds * SR))
        // Re-trim each step to its own transient so the sound lands on the foot contact.
        const trimmed = trimOneShot(slice(channels, a, b))
        const piece = slice(trimmed, 0, Math.round(gen.slice!.maxSeconds * SR))
        fade(piece, 48, Math.min(1920, Math.floor(piece[0]!.length * 0.3)))
        pieces.push({ name: `t${take}s${k + 1}`, channels: piece })
      })
    } else if (spec.loop) {
      pieces.push({ name: `t${take}`, channels: makeLoop(channels) })
    } else {
      pieces.push({ name: `t${take}`, channels: trimOneShot(channels) })
    }
    for (const piece of pieces) {
      if (piece.channels[0]!.length < 480) continue
      const pcm = join(procDir, `${piece.name}.f32`)
      writeF32(pcm, piece.channels)
      const stats = analyzeSfx(piece.channels)
      const events = detectOnsets(mono(piece.channels), { thresholdDb: -14, minGapSeconds: 0.12 }).length
      list.push({ name: piece.name, take, raw, pcm, stats, events, snr, decayDb: decayOf(mono(piece.channels)), flatRuns: gen.slice ? flatRuns(piece.channels) : runs, ...(spec.loop ? { seam: seamRatio(piece.channels), steadiness: steadiness(piece.channels) } : {}) })
    }
  }
  const scored = scoreCandidates(spec, list).sort((a, b) => a.score - b.score)
  // Footstep slices: at most two per take so variants come from different recordings where possible.
  const perTake = new Map<number, number>()
  const picked: Candidate[] = []
  for (const c of scored) {
    if (picked.length >= spec.variants) break
    if (c.score >= 10) continue
    const limit = gen.slice ? Math.ceil(spec.variants / Math.max(1, takes.length)) : 1
    if ((perTake.get(c.take) ?? 0) >= limit) continue
    perTake.set(c.take, (perTake.get(c.take) ?? 0) + 1)
    picked.push(c)
  }
  for (const c of scored) if (picked.length < spec.variants && !picked.includes(c) && c.score < 10) picked.push(c)
  for (const c of picked) c.picked = true
  const curated: Curated = { id: spec.id, candidates: scored, picked: picked.map(c => c.name) }
  mkdirSync(join(work, "curated"), { recursive: true })
  writeFileSync(join(work, "curated", `${spec.id}.json`), JSON.stringify(curated, null, 1))
  await sheet(spec, gen.slice ? scored.slice(0, 12) : scored)
  return curated
}

async function curate() {
  for (const spec of specs) {
    const c = await curateOne(spec)
    const picks = c.candidates.filter(x => x.picked)
    console.log(`${spec.id}: ${c.candidates.length} candidates → ${picks.map(p => `${p.name} (${p.score.toFixed(1)})`).join(", ")}`)
    for (const r of c.candidates.filter(x => !x.picked && x.reasons.length)) console.log(`    ${r.name}: ${r.reasons.join("; ")}`)
    if (picks.length < spec.variants) console.log(`  ! only ${picks.length} of ${spec.variants} variants usable`)
  }
}

// ── build ───────────────────────────────────────────────────────────────────────────────────────────────────────

const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d

async function encode(spec: SfxSpec, channels: Float32Array[], file: string, trimDb = 0) {
  const stats = analyzeSfx(channels)
  const measured = loudnessOf(spec, stats)
  const gainDb = Math.min(spec.target - measured, PEAK_CAP_DB - 0.5 - stats.peakDb) - trimDb
  const g = 10 ** (gainDb / 20)
  // Loops are wrapped in 0.25 s of their own tail before and head after, so the codec's first and last frames (which
  // decode imperfectly) stay outside the loop region [LOOP_WRAP, LOOP_WRAP + length).
  const scaled = channels.map(ch => {
    const v = ch.map(x => x * g)
    if (!spec.loop) return v
    const out = new Float32Array(v.length + 2 * LOOP_WRAP)
    out.set(v.subarray(v.length - LOOP_WRAP), 0)
    out.set(v, LOOP_WRAP)
    out.set(v.subarray(0, LOOP_WRAP), LOOP_WRAP + v.length)
    return out
  })
  const tmp = join(work, "encode.f32")
  writeF32(tmp, scaled)
  const bitrate = STEREO(spec) ? "96k" : spec.bus === "weapon" || spec.bus === "impact" ? "64k" : "48k"
  await $`ffmpeg -v error -y -f f32le -ar ${SR} -ac ${channels.length} -i ${tmp} -c:a libopus -b:a ${bitrate} -application audio -frame_duration 10 ${file}`.quiet()
}

async function build() {
  mkdirSync(outDir, { recursive: true })
  const files: Record<string, LibraryFile[]> = {}
  const keep = new Set<string>()
  for (const spec of SFX_SPECS) {
    const list: LibraryFile[] = []
    if (spec.reuse) {
      for (const reuse of spec.reuse) {
        const path = join(root, reuse.path)
        const stats = analyzeSfx(await decode(path))
        const loudness = loudnessOf(spec, stats)
        list.push({ file: reuse.path.split("/").pop()!, path: reuse.path, source: reuse.license.startsWith("ElevenLabs") ? "elevenlabs-sound-v2" : "project", license: reuse.license, provenance: reuse.provenance, durationSeconds: round(stats.durationSeconds, 3), loudness: round(loudness, 1), peakDb: round(stats.peakDb, 1), gain: round(10 ** ((spec.target - loudness) / 20), 3), bytes: statSync(path).size })
      }
    } else if (spec.generate) {
      const curatedPath = join(work, "curated", `${spec.id}.json`)
      if (!existsSync(curatedPath)) {
        const existing = LIBRARY_FILES[spec.id] ?? []
        console.log(`keep ${spec.id}: not curated here, ${existing.length} existing files`)
        for (const f of existing) { keep.add(f.file); list.push(f) }
        if (list.length) files[spec.id] = list
        continue
      }
      const curated = JSON.parse(readFileSync(curatedPath, "utf8")) as Curated
      let n = 0
      for (const name of curated.picked) {
        const c = curated.candidates.find(x => x.name === name)!
        const file = `${spec.id}.${++n}.ogg`
        const out = join(outDir, file)
        const pcm = readF32(c.pcm, c.stats.channels)
        await encode(spec, pcm, out)
        keep.add(file)
        let decoded = await decode(out, c.stats.channels)
        // Opus can overshoot a peak-capped take on decode; encode it again a little quieter.
        const over = analyzeSfx(decoded).peakDb - (PEAK_CAP_DB + 0.4)
        if (over > 0) {
          await encode(spec, pcm, out, over + 0.2)
          decoded = await decode(out, c.stats.channels)
        }
        const stats = analyzeSfx(spec.loop ? decoded.map(ch => ch.subarray(LOOP_WRAP, ch.length - LOOP_WRAP)) : decoded)
        const loop = spec.loop ? { loopStart: LOOP_WRAP / SR, loopEnd: round(LOOP_WRAP / SR + c.stats.durationSeconds, 6) } : undefined
        const loudness = loudnessOf(spec, stats)
        const meta = JSON.parse(readFileSync(c.raw.replace(/\.mp3$/, ".json"), "utf8")) as RawMeta
        const how = spec.generate.slice ? `step ${name.split("s").pop()} sliced from take ${c.take}` : `take ${c.take}`
        list.push({
          file, path: `packages/kit/audio/sfx/${file}`, source: "elevenlabs-sound-v2", license: LICENSE,
          provenance: `eleven_text_to_sound_v2, ${how} of ${spec.generate.candidates}, ${meta.duration} s requested, prompt influence ${meta.influence}${meta.loop ? ", loop" : ""}; trimmed, ${spec.loop ? "crossfade-looped, " : ""}normalised to ${spec.target} ${spec.loop ? "LUFS" : "LUFS momentary max"}, Ogg Opus`,
          requestId: meta.traceId ?? undefined,
          durationSeconds: round(stats.durationSeconds, 3), loudness: round(loudness, 1), peakDb: round(stats.peakDb, 1), gain: round(10 ** ((spec.target - loudness) / 20), 3), bytes: statSync(out).size,
          ...(loop ?? {}),
        })
      }
    }
    if (list.length) files[spec.id] = list
  }
  for (const f of readdirSync(outDir)) if (f.endsWith(".ogg") && !keep.has(f)) rmSync(join(outDir, f))
  const body = Object.entries(files).map(([id, list]) => `  ${JSON.stringify(id)}: [\n${list.map(f => `    ${JSON.stringify(f)},`).join("\n")}\n  ],`).join("\n")
  const path = join(root, "packages/kit/audio/library-files.ts")
  const head = readFileSync(path, "utf8").split("export const LIBRARY_FILES")[0]!
  writeFileSync(path, `${head}export const LIBRARY_FILES: Record<string, readonly LibraryFile[]> = {\n${body}\n}\n`)
  const total = Object.values(files).flat().filter(f => f.path.startsWith("packages/")).reduce((s, f) => s + f.bytes, 0)
  console.log(`${Object.keys(files).length} ids, ${Object.values(files).flat().length} files, library-owned ${(total / 1048576).toFixed(2)} MB`)
}

if (command === "generate") await generate()
else if (command === "curate") await curate()
else if (command === "build") await build()
else console.log("usage: library.ts generate|curate|build [ids…]")
