// Offline pipeline for the searchers' voices (lines in ./voice-specs.ts, story in STORY.md). Silent throughout: it
// measures with ffmpeg and TypeScript and never plays anything. Run from games/woods:
//
//   2password run --env "ELEVENLABS_API_KEY=op://…" -- bun scripts/audio/voices.ts generate [ids…]   Eleven v4 takes (skips existing)
//   bun scripts/audio/voices.ts measure [ids…]   trim; loudness, pitch and brightness per line; shouts against the same voice's talk
//   2password run … -- bun scripts/audio/voices.ts stt [ids…]   speech-to-text: the words came out and no direction was spoken
//   2password run … -- bun scripts/audio/voices.ts brush   text-to-sound takes of a searcher moving through brush
//   bun scripts/audio/voices.ts build            normalise by loudness class, encode Ogg Opus into public/audio/voice/,
//                                                write shared/lines.gen.ts and src/audio/voice-files.ts
//
// Work files: $WOODS_VOICE_WORK (default $TMPDIR/opencode/woods-voice): raw/<id>.mp3 (+ .json), pcm/, report.json.
import { $ } from "bun"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { momentaryMaxLufs } from "../../../../packages/kit/audio/sfx-analysis"
import { decode } from "../../../../scripts/sfx/decode"
import { VOICE_CAST, VOICE_LINES, type VoiceLineSpec } from "./voice-specs"
import type { Loudness } from "../../shared/voices"

const SR = 48000
const MODEL = "eleven_v4"
const SETTINGS = { stability: 0.45, similarity_boost: 0.75 }
const game = new URL("../../", import.meta.url).pathname
const work = process.env.WOODS_VOICE_WORK ?? join(process.env.TMPDIR ?? "/tmp", "opencode/woods-voice")
const outDir = join(game, "public/audio/voice")
const LICENSE = "ElevenLabs commercial text-to-speech license (Anomaly)"
/** Momentary-max loudness each class lands on, so a shout arrives ~12 dB over talk as it would out there. */
export const TARGET: Record<Loudness, number> = { shout: -14, call: -18, talk: -26, quiet: -32 }

/** Someone out there moving: played quietly under some lines from searchers in the woods (`VoiceBus`). */
const BRUSH = [
  { id: "brush.1", seconds: 3, prompt: "A person walking quickly through dry forest underbrush at night, twigs snapping, leaves and ferns brushing against jeans, footsteps on soft forest floor, close, no voice" },
  { id: "brush.2", seconds: 3, prompt: "Someone pushing through thick bushes and low branches in a pine forest, branches swishing back, a few heavy footsteps on needles and dry leaves, no voice" },
  { id: "brush.3", seconds: 3, prompt: "Footsteps crunching through dead leaves and snapping small sticks in a quiet forest, a jacket rustling, a person stepping over a log, no voice" },
] as const
const BRUSH_LUFS = -24

const [command, ...args] = process.argv.slice(2)
const pick = VOICE_LINES.filter((l) => args.length === 0 || args.some((a) => l.id === a || (a.endsWith("*") && l.id.startsWith(a.slice(0, -1)))))
const key = () => process.env.ELEVENLABS_API_KEY ?? (() => { throw new Error("ELEVENLABS_API_KEY is not set") })()
for (const d of ["raw", "pcm"]) mkdirSync(join(work, d), { recursive: true })

type RawMeta = { id: string; voice: string; model: string; direct: string; requestId: string | null; chars: number; bytes: number; at: string }
type Measure = { id: string; seconds: number; lufs: number; peakDb: number; f0: number; bright: number; trim: [number, number]; repeat?: boolean; cut?: number }

async function generate(l: VoiceLineSpec) {
  const raw = join(work, "raw", `${l.id}.mp3`)
  if (existsSync(raw)) return
  const cast = VOICE_CAST.find((c) => c.id === l.cast)!
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${cast.voiceId}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": key(), "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ model_id: MODEL, text: l.direct, voice_settings: SETTINGS }),
    })
    if (res.ok) {
      const bytes = new Uint8Array(await res.arrayBuffer())
      writeFileSync(raw, bytes)
      const meta: RawMeta = { id: l.id, voice: cast.voice, model: MODEL, direct: l.direct, requestId: res.headers.get("request-id"), chars: l.direct.length, bytes: bytes.length, at: new Date().toISOString() }
      writeFileSync(raw.replace(/\.mp3$/, ".json"), JSON.stringify(meta, null, 1))
      console.log(`generated ${l.id} (${bytes.length} B)`)
      return
    }
    const body = await res.text()
    console.warn(`${l.id}: ${res.status} ${body.slice(0, 200)}`)
    if (res.status === 429 || res.status >= 500) await Bun.sleep(4000 * (attempt + 1))
    else throw new Error(`${l.id}: ${res.status}`)
  }
}

/** Fundamental frequency (Hz, median over voiced 40 ms frames) by normalised autocorrelation, 70–600 Hz. */
function pitch(x: Float32Array): number {
  const win = 1920, hop = 960, out: number[] = []
  for (let s = 0; s + win < x.length; s += hop) {
    let e = 0
    for (let i = 0; i < win; i++) e += x[s + i]! * x[s + i]!
    if (e / win < 1e-4) continue
    let best = 0, lag = 0
    for (let k = Math.floor(SR / 600); k <= Math.floor(SR / 70); k++) {
      let c = 0, n1 = 0, n2 = 0
      for (let i = 0; i < win - k; i += 2) { c += x[s + i]! * x[s + i + k]!; n1 += x[s + i]! * x[s + i]!; n2 += x[s + i + k]! * x[s + i + k]! }
      const r = c / Math.sqrt(n1 * n2 + 1e-12)
      if (r > best) { best = r; lag = k }
    }
    if (best > 0.55) out.push(SR / lag)
  }
  out.sort((a, b) => a - b)
  return out.length ? out[Math.floor(out.length / 2)]! : 0
}

/** Share of energy above ~1 kHz (one-pole high-pass): a shout's spectrum is flatter than talk's. */
function brightness(x: Float32Array): number {
  const a = Math.exp((-2 * Math.PI * 1000) / SR)
  let prev = 0, hp = 0, eh = 0, et = 0
  for (let i = 0; i < x.length; i++) { hp = a * (hp + x[i]! - prev); prev = x[i]!; eh += hp * hp; et += x[i]! * x[i]! }
  return et > 0 ? eh / et : 0
}

/** Leading and trailing silence (below −45 dBFS in 10 ms windows), kept with 60 ms of room either side. */
function trimRange(x: Float32Array): [number, number] {
  const win = 480, thr = 10 ** (-45 / 20)
  let first = -1, last = -1
  for (let s = 0; s < x.length; s += win) {
    let p = 0
    for (let i = s; i < Math.min(x.length, s + win); i++) p = Math.max(p, Math.abs(x[i]!))
    if (p > thr) { if (first < 0) first = s; last = s + win }
  }
  if (first < 0) return [0, x.length]
  return [Math.max(0, first - 2880), Math.min(x.length, last + 2880)]
}

async function measure(l: VoiceLineSpec): Promise<Measure | null> {
  const raw = join(work, "raw", `${l.id}.mp3`)
  if (!existsSync(raw)) return null
  const [whole] = await decode(raw, 1)
  // A take that said the line over again keeps only its first reading (`stt` found where that ends).
  const cut = report()[l.id]?.cut
  const mono = cut ? whole!.slice(0, Math.min(whole!.length, Math.round((cut + 0.3) * SR))) : whole!
  const [a, b] = trimRange(mono)
  const x = mono.slice(a, b)
  writeFileSync(join(work, "pcm", `${l.id}.f32`), new Uint8Array(x.buffer))
  let peak = 0
  for (const v of x) peak = Math.max(peak, Math.abs(v))
  return { id: l.id, seconds: +(x.length / SR).toFixed(2), lufs: +momentaryMaxLufs([x]).toFixed(1), peakDb: +(20 * Math.log10(peak + 1e-9)).toFixed(1), f0: Math.round(pitch(x)), bright: +brightness(x).toFixed(3), trim: [+(a / SR).toFixed(2), +(b / SR).toFixed(2)] }
}

const reportFile = join(work, "report.json")
const report = (): Record<string, Measure & { stt?: string; match?: number; leak?: string[] }> => existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, "utf8")) : {}
const words = (s: string) => s.toLowerCase().replace(/[^a-z' ]+/g, " ").split(/\s+/).filter(Boolean)
const collapse = (w: string) => w.replace(/(.)\1+/g, "$1")

if (command === "generate") {
  // Four at a time, in order, so a failure stops early.
  for (let i = 0; i < pick.length; i += 4) await Promise.all(pick.slice(i, i + 4).map(generate))
} else if (command === "measure") {
  const r = report()
  for (const l of pick) { const m = await measure(l); if (m) r[l.id] = { ...r[l.id], ...m } }
  writeFileSync(reportFile, JSON.stringify(r, null, 1))
  // Shout against talk, per voice: medians of pitch and brightness.
  const med = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : 0 }
  for (const c of VOICE_CAST) {
    const of = (loud: Loudness) => VOICE_LINES.filter((l) => l.cast === c.id && l.loud === loud).map((l) => r[l.id]).filter(Boolean) as Measure[]
    const sh = of("shout"), tk = of("talk")
    if (!sh.length || !tk.length) continue
    console.log(`${c.id.padEnd(6)} shout f0 ${med(sh.map((m) => m.f0))} Hz bright ${med(sh.map((m) => m.bright)).toFixed(3)} | talk f0 ${med(tk.map((m) => m.f0))} Hz bright ${med(tk.map((m) => m.bright)).toFixed(3)} | shout/talk pitch ×${(med(sh.map((m) => m.f0)) / Math.max(1, med(tk.map((m) => m.f0)))).toFixed(2)}`)
  }
} else if (command === "stt") {
  const r = report()
  const tagWords = new Set(["shouting", "forest", "hands", "cupped", "whisper", "quietly", "muttering", "flashlight", "breath", "talking", "calling"])
  for (const l of pick) {
    const raw = join(work, "raw", `${l.id}.mp3`)
    if (!existsSync(raw)) continue
    const form = new FormData()
    form.append("model_id", "scribe_v1")
    form.append("file", new Blob([readFileSync(raw)], { type: "audio/mpeg" }), `${l.id}.mp3`)
    const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": key() }, body: form })
    if (!res.ok) { console.warn(`${l.id}: stt ${res.status}`); continue }
    const json = (await res.json()) as { text: string; words?: { text: string; type: string; start: number; end: number }[] }
    const text = json.text
    const want = words(l.text).map(collapse), got = new Set(words(text).map(collapse))
    const match = want.filter((w) => got.has(w)).length / Math.max(1, want.length)
    const leak = words(text).filter((w) => tagWords.has(w) && !words(l.text).includes(w))
    // v4 sometimes says a short line two or three times over.
    const repeat = words(text).length > Math.max(want.length * 1.5, want.length + 2)
    const spoken = (json.words ?? []).filter((w) => w.type === "word")
    // The first reading ends where the line's last word is first said, at or after its length in words.
    const lastWord = want[want.length - 1]
    const end = spoken.findIndex((w, i) => i >= want.length - 1 && words(w.text).map(collapse).includes(lastWord!))
    const cut = repeat && !leak.length && end >= 0 && end < spoken.length - 1 ? spoken[end]!.end : undefined
    r[l.id] = { ...r[l.id]!, stt: text, match: +match.toFixed(2), leak, repeat, cut }
    console.log(`${l.id.padEnd(22)} ${match < 0.7 || leak.length || repeat ? "CHECK" : "ok   "} ${text}`)
  }
  writeFileSync(reportFile, JSON.stringify(r, null, 1))
} else if (command === "brush") {
  for (const b of BRUSH) {
    const raw = join(work, "raw", `${b.id}.mp3`)
    if (existsSync(raw)) continue
    const res = await fetch("https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128", {
      method: "POST",
      headers: { "xi-api-key": key(), "content-type": "application/json" },
      body: JSON.stringify({ text: b.prompt, duration_seconds: b.seconds, prompt_influence: 0.45, model_id: "eleven_text_to_sound_v2" }),
    })
    if (!res.ok) { console.warn(`${b.id}: ${res.status} ${(await res.text()).slice(0, 200)}`); continue }
    const bytes = new Uint8Array(await res.arrayBuffer())
    writeFileSync(raw, bytes)
    writeFileSync(raw.replace(/\.mp3$/, ".json"), JSON.stringify({ id: b.id, voice: "sound", model: "eleven_text_to_sound_v2", direct: b.prompt, requestId: res.headers.get("request-id"), chars: b.prompt.length, bytes: bytes.length, at: new Date().toISOString() } satisfies RawMeta, null, 1))
    console.log(`generated ${b.id} (${bytes.length} B)`)
  }
} else if (command === "failed") {
  // Lines whose take didn't pass: too few of the words, a spoken direction, or the line said over again.
  const r = report()
  console.log(pick.filter((l) => { const m = r[l.id]; return m && ((m.match ?? 1) < 0.7 || (m.leak?.length ?? 0) > 0 || (m.repeat && !m.cut)) }).map((l) => l.id).join(" "))
} else if (command === "build") {
  const r = report()
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const lines: string[] = [], files: string[] = []
  for (const l of VOICE_LINES) {
    const m = r[l.id]
    const pcm = join(work, "pcm", `${l.id}.f32`)
    if (!m || !existsSync(pcm)) { console.warn(`skip ${l.id}: not measured`); continue }
    // Land on the class's loudness without passing −1 dBFS.
    const gainDb = Math.min(TARGET[l.loud] - m.lufs, -1 - m.peakDb)
    const file = `${l.id}.ogg`
    await $`ffmpeg -v error -y -f f32le -ar ${SR} -ac 1 -i ${pcm} -af volume=${gainDb.toFixed(2)}dB,afade=t=in:d=0.02,areverse,afade=t=in:d=0.08,areverse -c:a libopus -b:a 48k ${join(outDir, file)}`
    const bytes = Bun.file(join(outDir, file)).size
    const meta = JSON.parse(readFileSync(join(work, "raw", `${l.id}.json`), "utf8")) as RawMeta
    lines.push(`  ${JSON.stringify({ id: l.id, cast: l.cast, pool: l.pool, loud: l.loud, seconds: m.seconds, text: l.text })},`)
    files.push(`  ${JSON.stringify(l.id)}: ${JSON.stringify({ file, license: LICENSE, provenance: `${meta.model}, ${meta.voice} (premade), stability ${SETTINGS.stability}, similarity ${SETTINGS.similarity_boost}; trimmed, normalised to ${TARGET[l.loud]} LUFS momentary max (${l.loud}), Ogg Opus 48 kb/s`, direct: meta.direct, requestId: meta.requestId ?? undefined, loudness: TARGET[l.loud], bytes })},`)
  }
  for (const b of BRUSH) {
    const raw = join(work, "raw", `${b.id}.mp3`)
    if (!existsSync(raw)) { console.warn(`skip ${b.id}: not generated`); continue }
    const [x] = await decode(raw, 1)
    let peak = 0
    for (const v of x!) peak = Math.max(peak, Math.abs(v))
    const gainDb = Math.min(BRUSH_LUFS - momentaryMaxLufs([x!]), -3 - 20 * Math.log10(peak + 1e-9))
    const file = `${b.id}.ogg`
    await $`ffmpeg -v error -y -i ${raw} -ac 1 -ar ${SR} -af volume=${gainDb.toFixed(2)}dB,afade=t=in:d=0.05,areverse,afade=t=in:d=0.4,areverse -c:a libopus -b:a 40k ${join(outDir, file)}`
    const meta = JSON.parse(readFileSync(raw.replace(/\.mp3$/, ".json"), "utf8")) as RawMeta
    files.push(`  ${JSON.stringify(b.id)}: ${JSON.stringify({ file, license: LICENSE.replace("text-to-speech", "sound-generation"), provenance: `${meta.model}; normalised to ${BRUSH_LUFS} LUFS momentary max, Ogg Opus 40 kb/s`, direct: meta.direct, requestId: meta.requestId ?? undefined, loudness: BRUSH_LUFS, bytes: Bun.file(join(outDir, file)).size })},`)
  }
  writeFileSync(join(game, "shared/lines.gen.ts"), `// Generated by scripts/audio/voices.ts build. Do not edit by hand.\nimport type { CastId, Loudness, Pool } from "./voices"\n\nexport type VoiceLine = { id: string; cast: CastId; pool: Pool; loud: Loudness; seconds: number; text: string }\n\nexport const VOICE_LINES: readonly VoiceLine[] = [\n${lines.join("\n")}\n]\n`)
  writeFileSync(join(game, "src/audio/voice-files.ts"), `// Generated by scripts/audio/voices.ts build. Do not edit by hand.\n\nexport type VoiceFile = { file: string; license: string; provenance: string; direct: string; requestId?: string; loudness: number; bytes: number }\n\nexport const VOICE_FILES: Record<string, VoiceFile> = {\n${files.join("\n")}\n}\n`)
  console.log(`built ${lines.length} lines, ${(files.length && [...new Bun.Glob("*.ogg").scanSync(outDir)].reduce((s, f) => s + Bun.file(join(outDir, f)).size, 0) / 1024).toFixed(0)} KB`)
} else {
  console.log("usage: voices.ts generate|measure|stt|build [ids…]")
}
