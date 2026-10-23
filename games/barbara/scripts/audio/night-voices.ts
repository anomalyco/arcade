// Offline pipeline for the night's lines (./night-voice-specs.ts, NIGHT.md): clue reactions, dawn and Barbara's
// cassette. Same model, settings and loudness classes as `voices.ts`; kept apart so building one never touches the
// other's files. Silent throughout: it measures with ffmpeg and TypeScript and never plays anything. From games/barbara:
//
//   2password run --env "ELEVENLABS_API_KEY=op://…" -- bun scripts/audio/night-voices.ts generate [ids…]
//   2password run … -- bun scripts/audio/night-voices.ts stt [ids…]   the words came out, no direction spoken, no repeats
//   bun scripts/audio/night-voices.ts build   trim (cut repeats), level by class, the cassette's tape treatment, Ogg Opus
//                                             into public/audio/night/, shared/night-lines.gen.ts, src/audio/night-voice-files.ts
//
// Work files: $BARBARA_NIGHT_WORK (default $TMPDIR/opencode/barbara-night-voice): raw/<id>.mp3 (+ .json), report.json.
import { $ } from "bun"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { NIGHT_LINES, voiceIdOf, type NightLineSpec } from "./night-voice-specs"

const SR = 48000
const MODEL = "eleven_v4"
const SETTINGS = { stability: 0.45, similarity_boost: 0.75 }
const game = new URL("../../", import.meta.url).pathname
const work = process.env.BARBARA_NIGHT_WORK ?? join(process.env.TMPDIR ?? "/tmp", "opencode/barbara-night-voice")
const outDir = join(game, "public/audio/night")
const LICENSE = "ElevenLabs commercial text-to-speech license (Anomaly)"
/** The same classes as the searchers' lines (`voices.ts` TARGET). */
const TARGET = { shout: -14, call: -18, talk: -26, quiet: -32 } as const
/** The cassette played back on a pocket recorder: narrow band, a little saturation, wow and flutter, hiss under it. */
const TAPE_FILTER = "highpass=f=320,lowpass=f=3400,acompressor=threshold=-20dB:ratio=3:attack=5:release=80,vibrato=f=0.9:d=0.025,vibrato=f=11:d=0.006"

const [command, ...args] = process.argv.slice(2)
const pick = NIGHT_LINES.filter((l) => args.length === 0 || args.some((a) => l.id === a || (a.endsWith("*") && l.id.startsWith(a.slice(0, -1)))))
const key = () => process.env.ELEVENLABS_API_KEY ?? (() => { throw new Error("ELEVENLABS_API_KEY is not set") })()
mkdirSync(join(work, "raw"), { recursive: true })

type RawMeta = { id: string; voiceId: string; model: string; direct: string; requestId: string | null; bytes: number; at: string }
type Report = Record<string, { stt?: string; match?: number; leak?: string[]; repeat?: boolean; cut?: number; restart?: boolean }>
const reportFile = join(work, "report.json")
const report = (): Report => (existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, "utf8")) : {})
const words = (s: string) => s.toLowerCase().replace(/[^a-z' ]+/g, " ").split(/\s+/).filter(Boolean)
const collapse = (w: string) => w.replace(/(.)\1+/g, "$1")

async function generate(l: NightLineSpec) {
  const raw = join(work, "raw", `${l.id}.mp3`)
  if (existsSync(raw)) return
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceIdOf(l.cast)}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": key(), "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ model_id: MODEL, text: l.direct, voice_settings: SETTINGS }),
    })
    if (res.ok) {
      const bytes = new Uint8Array(await res.arrayBuffer())
      writeFileSync(raw, bytes)
      const meta: RawMeta = { id: l.id, voiceId: voiceIdOf(l.cast), model: MODEL, direct: l.direct, requestId: res.headers.get("request-id"), bytes: bytes.length, at: new Date().toISOString() }
      writeFileSync(raw.replace(/\.mp3$/, ".json"), JSON.stringify(meta, null, 1))
      console.log(`generated ${l.id} (${bytes.length} B)`)
      return
    }
    console.warn(`${l.id}: ${res.status} ${(await res.text()).slice(0, 200)}`)
    if (res.status === 429 || res.status >= 500) await Bun.sleep(4000 * (attempt + 1))
    else throw new Error(`${l.id}: ${res.status}`)
  }
}

/** Momentary-max loudness (400 ms windows, K-weighting skipped: a level match within one voice class, as near as needed). */
async function measure(file: string, filter: string): Promise<{ lufs: number; peak: number; seconds: number }> {
  const out = await $`ffmpeg -v info -nostats -i ${file} -af ${filter ? `${filter},` : ""}ebur128=peak=true -f null -`.quiet().nothrow()
  const log = out.stderr.toString()
  const m = [...log.matchAll(/M:\s*(-?[\d.]+)/g)].map((x) => Number(x[1])).filter(Number.isFinite)
  const peak = Number(/Peak:\s*(-?[\d.]+)/.exec(log.slice(log.lastIndexOf("True peak")))?.[1] ?? -1)
  const dur = /Duration: (\d+):(\d+):([\d.]+)/.exec(log)
  return { lufs: m.length ? Math.max(...m) : -70, peak, seconds: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0 }
}

if (command === "generate") {
  for (let i = 0; i < pick.length; i += 4) await Promise.all(pick.slice(i, i + 4).map(generate))
} else if (command === "stt") {
  const r = report()
  const tagWords = new Set(["shouting", "forest", "whisper", "quietly", "muttering", "recorder", "microcassette", "breath", "calling", "urgently"])
  for (const l of pick) {
    const raw = join(work, "raw", `${l.id}.mp3`)
    if (!existsSync(raw)) continue
    const form = new FormData()
    form.append("model_id", "scribe_v1")
    form.append("file", new Blob([readFileSync(raw)], { type: "audio/mpeg" }), `${l.id}.mp3`)
    const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": key() }, body: form })
    if (!res.ok) { console.warn(`${l.id}: stt ${res.status}`); continue }
    const json = (await res.json()) as { text: string; words?: { text: string; type: string; start: number; end: number }[] }
    const want = words(l.text).map(collapse), got = new Set(words(json.text).map(collapse))
    const match = want.filter((w) => got.has(w)).length / Math.max(1, want.length)
    const leak = words(json.text).filter((w) => tagWords.has(w) && !words(l.text).includes(w))
    const repeat = words(json.text).length > want.length + 2
    // Said again from its start: the opening words come round twice, which a cut at the end can't remove.
    const said = words(json.text).map(collapse), head = want.slice(0, 3).join(" ")
    const at = (list: string[]) => list.map((_, i) => list.slice(i, i + 3).join(" ")).flatMap((h, i) => (h === head ? [i] : []))
    const again = at(said)[at(want).length]
    const restart = again !== undefined && again < want.length * 0.7
    const spoken = (json.words ?? []).filter((w) => w.type === "word")
    const last = want[want.length - 1]
    const end = spoken.findIndex((w, i) => i >= want.length - 1 && words(w.text).map(collapse).includes(last!))
    const cut = repeat && !leak.length && end >= 0 && end < spoken.length - 1 ? spoken[end]!.end : undefined
    r[l.id] = { stt: json.text, match: +match.toFixed(2), leak, repeat, cut, restart }
    console.log(`${l.id.padEnd(30)} ${match < 0.85 || leak.length || restart || (repeat && !cut) ? "CHECK" : "ok   "} ${json.text}`)
  }
  writeFileSync(reportFile, JSON.stringify(r, null, 1))
} else if (command === "failed") {
  // Takes to generate again: too few of the words, a spoken direction, or the line said over from its start (a repeat
  // after the first reading is cut at its last word instead).
  const r = report()
  console.log(pick.filter((l) => { const m = r[l.id]; return !m || (m.match ?? 0) < 0.85 || (m.leak?.length ?? 0) > 0 || m.restart || (m.repeat && !m.cut) }).map((l) => l.id).join(" "))
} else if (command === "build") {
  const r = report()
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const lines: string[] = [], files: string[] = []
  for (const l of NIGHT_LINES) {
    const raw = join(work, "raw", `${l.id}.mp3`)
    if (!existsSync(raw)) { console.warn(`skip ${l.id}: not generated`); continue }
    const tape = l.cast === "barbara"
    // Trim the silence either side (and a take that said the line over again after its first reading).
    const cut = r[l.id]?.cut
    const trim = `${cut ? `atrim=end=${(cut + 0.3).toFixed(2)},` : ""}silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.06,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.06,areverse`
    const color = tape ? `,${TAPE_FILTER}` : ""
    const m = await measure(raw, `${trim}${color}`)
    const gainDb = Math.min(TARGET[l.loud] - m.lufs, -1 - m.peak)
    const file = `${l.id}.ogg`
    // The tape's hiss goes in after levelling, so it sits under the words; it starts with the play button and stops dead.
    const chain = `${trim}${color},volume=${gainDb.toFixed(2)}dB,afade=t=in:d=0.02,areverse,afade=t=in:d=0.08,areverse`
    if (tape) {
      await $`ffmpeg -v error -y -i ${raw} -f lavfi -i ${`anoisesrc=color=pink:amplitude=0.012:sample_rate=${SR}`} -filter_complex ${`[0:a]aresample=${SR},${chain},apad=pad_dur=0.6,adelay=450|450[v];[1:a]highpass=f=900,lowpass=f=7000,afade=t=in:d=0.03[h];[v][h]amix=inputs=2:duration=first:normalize=0`} -ac 1 -c:a libopus -b:a 48k ${join(outDir, file)}`
    } else {
      await $`ffmpeg -v error -y -i ${raw} -ac 1 -ar ${SR} -af ${chain} -c:a libopus -b:a 48k ${join(outDir, file)}`
    }
    const built = await measure(join(outDir, file), "")
    const meta = JSON.parse(readFileSync(raw.replace(/\.mp3$/, ".json"), "utf8")) as RawMeta
    lines.push(`  ${JSON.stringify({ id: l.id, cast: l.cast, pool: l.pool, loud: l.loud, seconds: +built.seconds.toFixed(2), text: l.text })},`)
    files.push(`  ${JSON.stringify(l.id)}: ${JSON.stringify({ file, license: LICENSE, provenance: `${meta.model}, voice ${meta.voiceId} (premade), stability ${SETTINGS.stability}, similarity ${SETTINGS.similarity_boost}; trimmed, levelled to ${TARGET[l.loud]} LUFS momentary max (${l.loud})${tape ? ", pocket-recorder playback (band-limited, wow and flutter, hiss)" : ""}, Ogg Opus 48 kb/s`, direct: meta.direct, requestId: meta.requestId ?? undefined, loudness: TARGET[l.loud], bytes: Bun.file(join(outDir, file)).size })},`)
    console.log(`${l.id.padEnd(30)} ${built.seconds.toFixed(2)} s  ${built.lufs.toFixed(1)} LUFS`)
  }
  writeFileSync(join(game, "shared/night-lines.gen.ts"), `// Generated by scripts/audio/night-voices.ts build. Do not edit by hand.\nimport type { VoiceLine } from "./lines.gen"\nimport type { Voice } from "./voices"\n\nexport type NightLine = Omit<VoiceLine, "cast"> & { cast: Voice }\n\nexport const NIGHT_LINES: readonly NightLine[] = [\n${lines.join("\n")}\n]\n`)
  writeFileSync(join(game, "src/audio/night-voice-files.ts"), `// Generated by scripts/audio/night-voices.ts build. Do not edit by hand.\nimport type { VoiceFile } from "./voice-files"\n\nexport const NIGHT_VOICE_FILES: Record<string, VoiceFile> = {\n${files.join("\n")}\n}\n`)
  console.log(`built ${lines.length} lines`)
} else {
  console.log("usage: night-voices.ts generate|stt|failed|build [ids…]")
}
