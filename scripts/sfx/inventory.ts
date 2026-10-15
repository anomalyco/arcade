// Inventory of every sound file in the repository: category, duration, loudness, licence, which game plays it and a
// quality flag. Silent: decodes with ffmpeg and measures, never plays.
//
//   bun scripts/sfx/inventory.ts [out.json]        prints a Markdown table; writes the JSON rows to out.json
import { $ } from "bun"
import { readFileSync, statSync, writeFileSync } from "node:fs"
import { basename, relative } from "node:path"
import { analyzeSfx } from "../../packages/kit/audio/sfx-analysis"
import { SFX_LIBRARY } from "../../packages/kit/audio/library"
import { decode, probe } from "./decode"

const root = new URL("../../", import.meta.url).pathname
const files = (await $`git ls-files -- '*.mp3' '*.ogg' '*.wav' '*.m4a' '*.opus' '*.flac'`.cwd(root).text()).trim().split("\n").filter(Boolean)

const read = (path: string) => { try { return readFileSync(`${root}${path}`, "utf8") } catch { return "" } }
const sources = {
  getaway: (await $`git ls-files games/getaway/src packages/kit/audio/manifest.ts`.cwd(root).text()).trim().split("\n").map(read).join("\n"),
  blackout: (await $`git ls-files games/blackout/src`.cwd(root).text()).trim().split("\n").map(read).join("\n"),
}
const carrierPicks = JSON.parse(read("games/carrier/public/sfx/picks.json") || "{}") as Record<string, { take: number }>
const libraryFiles = new Set(SFX_LIBRARY.flatMap(entry => entry.files.map(v => v.path)))

function category(path: string): string {
  const name = basename(path)
  if (path.includes("/radio/")) return "voice"
  if (path.includes("/stems/")) return name.includes("impact") ? "impact" : "spell"
  if (/gun|shot|ciws|naval|reload|dry-fire|casing/.test(name)) return "weapon"
  if (/boom|bomb|missile|crash|impact|debris|hull-slam|thump|wall|bump|crunch|heavy|spike|pop/.test(name)) return "impact"
  if (/engine|idle|drive|start|rotor|nitro|horn|siren|boat|scooter|jeep|van/.test(name)) return "vehicle"
  if (/skid|tire|tyre|scrub|scrape|screech/.test(name)) return "tyre"
  if (/ocean|wind|rain|ambience|bed|thunder|lightning|creak|sinking/.test(name)) return "ambience"
  if (/radio|chatter|squelch|spotted|tip_|lost_|bust_|heli_/.test(name)) return "voice"
  if (/ui|click|whoosh|tick|sting|kill/.test(name)) return "ui"
  if (/foot|door|window|barricade|rummage|pickup|flashlight/.test(name)) return "foley"
  if (/zombie|body/.test(name)) return "creature"
  return "other"
}

function usedBy(path: string): string {
  const name = basename(path).replace(/\.[a-z0-9]+$/, "")
  if (path.startsWith("packages/kit/audio/sfx/")) {
    const entry = SFX_LIBRARY.find(e => e.files.some(v => v.path === path))
    return entry ? `library ${entry.id} (${entry.usedBy.join(", ") || "Lab"})` : "library (unlisted)"
  }
  if (path.startsWith("games/carrier/")) {
    const m = name.match(/^(.*)-(\d+)$/)
    if (!m) return "carrier"
    const pick = carrierPicks[m[1]!]
    return pick?.take === Number(m[2]) ? "carrier (picked take)" : "carrier (alternate take)"
  }
  if (path.startsWith("games/blackout/")) return sources.blackout.includes(name) ? "blackout" : "blackout (unreferenced)"
  if (path.startsWith("games/getaway/")) {
    const sub = path.replace("games/getaway/public/sfx/", "").replace(/\.mp3$/, "")
    return sources.getaway.includes(name) || sources.getaway.includes(sub) ? "getaway" : "getaway (unreferenced)"
  }
  return "?"
}

function licence(path: string): string {
  if (path.startsWith("packages/kit/audio/sfx/")) return SFX_LIBRARY.flatMap(e => e.files).find(v => v.path === path)?.license ?? "?"
  if (path.startsWith("games/carrier/")) return "ElevenLabs commercial sound-generation license (Anomaly)"
  if (path.includes("/stems/")) return "ElevenLabs commercial sound-generation license (Anomaly)"
  if (path.includes("/radio/")) return "Proprietary project asset (generated radio voice)"
  return "Proprietary project asset"
}

type Row = { path: string; category: string; usedBy: string; licence: string; bytes: number; codec: string; quality: string } & ReturnType<typeof analyzeSfx>
const rows: Row[] = []
for (const path of files) {
  if (!libraryFiles.has(path) && path.startsWith("packages/kit/audio/sfx/")) continue
  const info = await probe(`${root}${path}`)
  const stats = analyzeSfx(await decode(`${root}${path}`))
  const flags: string[] = []
  if (stats.clippedSamples > 0) flags.push(`clips ${stats.clippedSamples}`)
  if (stats.peakDb > -0.3) flags.push("hot peak")
  if (stats.leadingSilence > 0.05) flags.push(`lead ${Math.round(stats.leadingSilence * 1000)} ms`)
  if (Math.abs(stats.dcOffset) > 0.01) flags.push("DC")
  if (stats.momentaryMaxLufs < -32) flags.push("very quiet")
  rows.push({ path, category: category(path), usedBy: usedBy(path), licence: licence(path), bytes: statSync(`${root}${path}`).size, codec: `${info.codec} ${info.channels}ch ${Math.round(info.bitRate / 1000)}k`, quality: flags.join(", ") || "ok", ...stats })
}

const out = process.argv[2]
if (out) writeFileSync(out, JSON.stringify(rows, null, 1))
const f1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : "–")
console.log("| File | Category | Used by | s | LUFS | M-max | Peak dB | Codec | KB | Quality |")
console.log("| --- | --- | --- | --: | --: | --: | --: | --- | --: | --- |")
for (const r of rows) {
  console.log(`| ${relative(root, root + r.path)} | ${r.category} | ${r.usedBy} | ${r.durationSeconds.toFixed(2)} | ${f1(r.lufs)} | ${f1(r.momentaryMaxLufs)} | ${f1(r.peakDb)} | ${r.codec} | ${Math.round(r.bytes / 1024)} | ${r.quality} |`)
}
const total = rows.reduce((s, r) => s + r.bytes, 0)
console.error(`${rows.length} files, ${(total / 1048576).toFixed(2)} MB`)
