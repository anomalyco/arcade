// One ElevenLabs music generation for the trailer score (dark ambient, ~26 s), with the credit cost measured from the
// subscription's character count before and after. The key is read by name from ~/development/.env, never printed.
//
//   bun scripts/trailer/music.ts [--v2] [--out captures/trailer/audio/score.mp3]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

const args = process.argv.slice(2)
const out = args.includes("--out") ? args[args.indexOf("--out") + 1]! : `${import.meta.dir}/../../captures/trailer/audio/score.mp3`
const env = readFileSync(`${process.env.HOME}/development/.env`, "utf8")
const key = env
  .split("\n")
  .find((l) => l.startsWith("ELEVEN_LABS_API_KEY="))
  ?.slice("ELEVEN_LABS_API_KEY=".length)
  .trim()
  .replace(/^["']|["']$/g, "")
if (!key) throw new Error("ELEVEN_LABS_API_KEY missing")
const H = { "xi-api-key": key }

const used = async () => {
  const r = await fetch("https://api.elevenlabs.io/v1/user/subscription", { headers: H })
  if (!r.ok) return null
  const j = (await r.json()) as { character_count: number; character_limit: number }
  return j
}
const before = await used()

const NEG = ["vocals", "singing", "choir words", "drums kit", "upbeat", "major key", "melody hooks", "electronic dance"]
const plan = {
  positive_global_styles: ["dark ambient horror film score", "cinematic trailer", "brooding low drone", "analog synth", "1980s horror", "sparse", "ominous", "instrumental", "great production quality"],
  negative_global_styles: NEG,
  sections: [
    { section_name: "Fog", positive_local_styles: ["deep sustained sub drone", "distant wind-like pads", "very sparse", "quiet", "uneasy"], negative_local_styles: ["percussion"], duration_ms: 9000, lines: [] },
    { section_name: "Station", positive_local_styles: ["slow low heartbeat pulses", "single low piano note every few seconds", "dissonant strings creeping in", "tension building slowly"], negative_local_styles: [], duration_ms: 9000, lines: [] },
    { section_name: "Rise", positive_local_styles: ["rising string cluster crescendo", "accelerating sub pulses", "metallic scrapes", "unbearable tension", "loud swell ending abruptly"], negative_local_styles: ["resolution", "fade out"], duration_ms: 7000, lines: [] },
  ],
}
// v2 (`--v2`): darker and sparser, no hits; a slow rise that stops dead (the scream plays over black after it).
const planV2 = {
  positive_global_styles: ["dark ambient", "horror film score", "very sparse", "minimal", "deep sub-bass drone", "cold", "ominous", "instrumental", "lots of silence", "great production quality"],
  negative_global_styles: [...NEG, "drums", "percussion hits", "impacts", "braams", "melody", "piano melody"],
  sections: [
    { section_name: "Night", positive_local_styles: ["near silence", "faint deep sub drone", "distant airy texture", "barely audible"], negative_local_styles: ["percussion", "strings"], duration_ms: 8000, lines: [] },
    { section_name: "Inside", positive_local_styles: ["low drone thickens slightly", "occasional faint metallic resonance", "cold dissonant sustained tone", "still very sparse"], negative_local_styles: ["percussion", "pulse"], duration_ms: 8000, lines: [] },
    { section_name: "Dread", positive_local_styles: ["slow dissonant string cluster rising very gradually", "growing low drone", "tension", "cuts off abruptly at the end"], negative_local_styles: ["hits", "drums", "resolution", "fade out"], duration_ms: 7000, lines: [] },
  ],
}
const r = await fetch("https://api.elevenlabs.io/v1/music?output_format=mp3_44100_192", {
  method: "POST",
  headers: { ...H, "Content-Type": "application/json" },
  body: JSON.stringify({ composition_plan: args.includes("--v2") ? planV2 : plan, model_id: "music_v1" }),
})
if (!r.ok) {
  console.error("music failed", r.status, (await r.text()).slice(0, 400))
  process.exit(1)
}
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, Buffer.from(await r.arrayBuffer()))
const after = await used()
console.log(JSON.stringify({ out, songId: r.headers.get("song-id"), credits: before && after ? after.character_count - before.character_count : "unknown", remaining: after ? after.character_limit - after.character_count : null }))
