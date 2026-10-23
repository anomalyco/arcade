// The uncanny tier's files, composed offline from curated ingredients (UNCANNY_SOURCE_SPECS, `sounds.ts generate|curate`)
// and the searchers' own takes (public/audio/voice). Silent throughout. Run from games/barbara:
//
//   bun scripts/audio/uncanny.ts analyze [src.id…]   pitch tracks of the curated takes, to pick and cut by
//   bun scripts/audio/uncanny.ts compose            writes $WORK/composed/<id>/<n>.f32 (+ .wav, .json); `sounds.ts build` encodes them
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { decode } from "../../../../scripts/sfx/decode"
import { pitchTrack, SR } from "./dsp"

export const work = process.env.WOODS_SFX_WORK ?? join(process.env.TMPDIR ?? "/tmp", "opencode/woods-sfx")

type Candidate = { name: string; take: number; raw: string; pcm: string; tags?: string; stats: { durationSeconds: number; momentaryMaxLufs: number } }
type Curated = { id: string; candidates: Candidate[]; picked: string[] }

export function curated(id: string): Curated {
  return JSON.parse(readFileSync(join(work, "curated", `${id}.json`), "utf8")) as Curated
}
/** A curated take's trimmed mono PCM (the `t<n>` name), and its raw meta. */
export function take(id: string, n: number): { x: Float32Array; prompt: string; requestId: string | null } {
  const c = curated(id).candidates.find((c) => c.take === n)
  if (!c) throw new Error(`${id} has no take ${n}`)
  const x = new Float32Array(new Uint8Array(readFileSync(c.pcm)).buffer)
  const meta = JSON.parse(readFileSync(c.raw.replace(/\.mp3$/, ".json"), "utf8")) as { prompt: string; traceId: string | null }
  return { x, prompt: meta.prompt, requestId: meta.traceId }
}

function analyze(ids: string[]) {
  for (const id of ids) {
    for (const c of curated(id).candidates) {
      const x = new Float32Array(new Uint8Array(readFileSync(c.pcm)).buffer)
      const tr = pitchTrack(x, 2400)
      const row = tr.map((f) => (f.rms < -55 ? "  .  " : f.f0 ? String(Math.round(f.f0)).padStart(5) : `  ~${Math.round(f.rms + 60).toString().padStart(2)}`)).join("")
      console.log(`${id} ${c.name} ${c.stats.durationSeconds.toFixed(2)}s M ${c.stats.momentaryMaxLufs.toFixed(1)} ${c.tags ?? ""}\n  f0/50ms: ${row}`)
    }
  }
}

/** What a listener model hears in each composed file (ElevenLabs Scribe with audio-event tags), whole and its last 4 s. */
async function check(ids: string[]) {
  const key = process.env.ELEVENLABS_API_KEY
  if (!key) throw new Error("ELEVENLABS_API_KEY is not set")
  const dir = join(work, "composed")
  const hear = async (wav: string) => {
    const form = new FormData()
    form.append("model_id", "scribe_v1")
    form.append("tag_audio_events", "true")
    form.append("file", new Blob([readFileSync(wav)], { type: "audio/wav" }), "take.wav")
    const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": key }, body: form })
    return res.ok ? (((await res.json()) as { text?: string }).text ?? "").trim() || "(nothing)" : `${res.status}`
  }
  for (const id of ids) {
    for (let n = 1; existsSync(join(dir, id, `${n}.wav`)); n++) {
      const wav = join(dir, id, `${n}.wav`)
      const tail = join(dir, id, `${n}.tail.wav`)
      const x = (await decode(wav, 1))[0]!
      const { $ } = await import("bun")
      await $`ffmpeg -v error -y -i ${wav} -ss ${Math.max(0, x.length / SR - 4)} ${tail}`.quiet()
      const [whole, end] = await Promise.all([hear(wav), hear(tail)])
      rmSync(tail)
      const note = JSON.parse(readFileSync(join(dir, id, `${n}.json`), "utf8")) as { checked?: { whole: string; end: string } }
      note.checked = { whole, end }
      writeFileSync(join(dir, id, `${n}.json`), JSON.stringify(note, null, 1))
      console.log(`${id} #${n}: ${whole.slice(0, 120)}  |  last 4 s: ${end.slice(0, 80)}`)
    }
  }
}

const [command, ...args] = process.argv.slice(2)
if (command === "analyze") analyze(args)
else if (command === "check") await check(args)
else if (command === "compose") { const { compose } = await import("./uncanny-compose"); await compose() }
else console.log("usage: uncanny.ts analyze [ids…] | compose")
