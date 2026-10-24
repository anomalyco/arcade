/**
 * TIMBER's recorded sounds: CC0 field recordings from Freesound, cut into the game's clips.
 *
 *   bun scripts/sounds.ts fetch   # download each source's HQ preview, check its licence, record its SHA-256
 *   bun scripts/sounds.ts build   # cut, level and encode the clips into public/sfx/ (needs ffmpeg)
 *
 * `fetch` refuses any licence but CC0 or CC BY and fails if a source no longer matches the hash in
 * `public/sfx/sources.json`. Sources are cached in `$TMPDIR/timber-sounds` (never committed).
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

type Source = { id: number; user: string; title: string }
/** Every recording used, by Freesound id. */
const SOURCES: Record<string, Source> = {
  husqIdleRev: { id: 871135, user: "ElSchorscho", title: "Chainsaw idle and revving, Husqvarna 445" },
  husqStartStop: { id: 871136, user: "ElSchorscho", title: "Chainsaw starting, idling, stopping Husqvarna 445" },
  sawCut: { id: 431741, user: "Stefan021", title: "Chainsaw - Start Cut and Idle.wav" },
  falseStarts: { id: 450951, user: "kyles", title: "snowmobile won't start false starts lawnmower pull cord" },
  treeFall: { id: 494071, user: "Kinoton", title: "Big Tree Fall in Forest" },
  treeFall2: { id: 515312, user: "matt_beer", title: "timber tree falling 2" },
  woodCrack: { id: 183450, user: "utsuru", title: "Wood Crack 5" },
  treeCreak: { id: 554651, user: "HMTSCCSound", title: "tree wind creaking.wav" },
  forestRun: { id: 577313, user: "TRP", title: "Running, on path through forest, dirt ground, leaves, footsteps, NOTL, 2011.flac" },
  breathScared: { id: 554307, user: "casiba842", title: "Scared Male Heavy Breathing" },
  heartbeat: { id: 22440, user: "Lunardrive", title: "Single Heartbeat Clean HQ_BeatSmith.wav" },
}

/**
 * One game clip: `from` seconds `[start, start + dur)` of a source, faded, levelled to `rms` dBFS (peaks limited to
 * −1 dBFS) and encoded mono Opus. `loop` clips get a crossfaded seam so they loop without a click. `name.N` clips are
 * takes of one sound.
 */
type Clip = { from: keyof typeof SOURCES; start: number; dur: number; rms: number; loop?: boolean; fade?: number }
export const CLIPS: Record<string, Clip> = {
  // The Husqvarna 445: idle and full throttle, steady stretches of one take.
  "saw-idle": { from: "husqIdleRev", start: 24.5, dur: 8, rms: -20, loop: true },
  "saw-rev": { from: "husqIdleRev", start: 15.5, dur: 4.5, rms: -16, loop: true },
  // Another saw bogged down in a log: engine under load and the chain in the wood.
  "saw-cut": { from: "sawCut", start: 7, dur: 8, rms: -15, loop: true },
  // A pull that catches, the high idle settling; two pulls that don't; the engine dying at idle.
  "saw-start": { from: "husqStartStop", start: 1.85, dur: 5.6, rms: -20, fade: 0.4 },
  "saw-pull.1": { from: "husqStartStop", start: 0.82, dur: 0.95, rms: -21, fade: 0.15 },
  "saw-pull.2": { from: "husqStartStop", start: 1.86, dur: 0.88, rms: -21, fade: 0.15 },
  "saw-flood": { from: "falseStarts", start: 2.75, dur: 1.4, rms: -20, fade: 0.2 },
  "saw-cutout": { from: "husqIdleRev", start: 53.2, dur: 1.9, rms: -21, fade: 0.05 },
  // A felled conifer: creaking and cracking as it goes, then the crash; a second landing.
  "tree-groan": { from: "treeFall", start: 0.2, dur: 4.25, rms: -17, fade: 0.25 },
  "tree-crash.1": { from: "treeFall", start: 4.42, dur: 3.2, rms: -15, fade: 0.8 },
  "tree-crash.2": { from: "treeFall2", start: 2.85, dur: 2.6, rms: -17, fade: 0.8 },
  "tree-crack.1": { from: "woodCrack", start: 0.05, dur: 0.95, rms: -16, fade: 0.2 },
  "tree-crack.2": { from: "woodCrack", start: 1.22, dur: 0.95, rms: -16, fade: 0.3 },
  "tree-creak.1": { from: "treeCreak", start: 1.4, dur: 1.7, rms: -20, fade: 0.25 },
  "tree-creak.2": { from: "treeCreak", start: 19.15, dur: 1.4, rms: -20, fade: 0.25 },
  "tree-creak.3": { from: "treeCreak", start: 22.95, dur: 2.5, rms: -20, fade: 0.3 },
  // Running on a leafy dirt path, one footfall each.
  "foot-run.1": { from: "forestRun", start: 10.77, dur: 0.32, rms: -24, fade: 0.1 },
  "foot-run.2": { from: "forestRun", start: 11.17, dur: 0.32, rms: -24, fade: 0.1 },
  "foot-run.3": { from: "forestRun", start: 11.87, dur: 0.32, rms: -24, fade: 0.1 },
  "foot-run.4": { from: "forestRun", start: 12.27, dur: 0.32, rms: -24, fade: 0.1 },
  "foot-run.5": { from: "forestRun", start: 13.32, dur: 0.32, rms: -24, fade: 0.1 },
  "foot-run.6": { from: "forestRun", start: 14.07, dur: 0.32, rms: -24, fade: 0.1 },
  // A man's scared, ragged breathing, and one heartbeat (the game sets the rate).
  breath: { from: "breathScared", start: 8, dur: 8, rms: -24, loop: true },
  heart: { from: "heartbeat", start: 0, dur: 0.66, rms: -18, fade: 0.08 },
}

const root = resolve(import.meta.dir, "..")
const outDir = resolve(root, "public/sfx")
const cache = resolve(process.env.TMPDIR ?? tmpdir(), "timber-sounds")
const manifestPath = resolve(outDir, "sources.json")
type Manifest = { sources: Record<string, { url: string; author: string; title: string; licence: string; download: string; sha256: string }>; clips: Record<string, Clip & { sha256: string }> }
const manifest: Manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : { sources: {}, clips: {} }
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex")

async function fetchAll() {
  mkdirSync(cache, { recursive: true })
  for (const [key, s] of Object.entries(SOURCES)) {
    const url = `https://freesound.org/people/${s.user}/sounds/${s.id}/`
    const html = await (await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (arcade timber sounds)" } })).text()
    const licence = html.match(/creativecommons\.org\/(publicdomain\/zero\/1\.0|licenses\/by\/[0-9.]+)\//)?.[0]
    if (!licence) throw new Error(`${key}: refusing ${url}, licence is not CC0 or CC BY`)
    const mp3 = html.match(/https:\/\/cdn\.freesound\.org\/previews\/\d+\/\d+_\d+-lq\.mp3/)?.[0]
    if (!mp3) throw new Error(`${key}: no preview on ${url}`)
    const download = mp3.replace("-lq.mp3", "-hq.ogg")
    const bytes = new Uint8Array(await (await fetch(download)).arrayBuffer())
    const hash = sha(bytes)
    const known = manifest.sources[key]?.sha256
    if (known && known !== hash) throw new Error(`${key}: ${download} changed upstream (${known} → ${hash})`)
    writeFileSync(resolve(cache, `${key}.ogg`), bytes)
    manifest.sources[key] = { url, author: s.user, title: s.title, licence: `https://${licence}`, download, sha256: hash }
    console.log(`${key}: ${(bytes.length / 1024).toFixed(0)} KB ${licence}`)
  }
  save()
}

function run(args: string[]) {
  const p = Bun.spawnSync(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", ...args])
  if (p.exitCode) throw new Error(`ffmpeg ${args.join(" ")}\n${p.stderr.toString()}`)
}

function build() {
  mkdirSync(outDir, { recursive: true })
  manifest.clips = {}
  for (const [name, c] of Object.entries(CLIPS)) {
    const src = resolve(cache, `${c.from}.ogg`)
    if (!existsSync(src)) throw new Error(`${name}: run fetch first (${src})`)
    const out = resolve(outDir, `${name}.ogg`)
    const fade = c.fade ?? 0.02
    // A loop overlaps its last `x` seconds onto its start, so the seam is a crossfade.
    const x = c.loop ? Math.min(0.25, c.dur / 4) : 0
    const cut = c.loop
      ? `[0:a]atrim=${c.start}:${c.start + c.dur + x},asetpts=PTS-STARTPTS,pan=mono|c0=0.5*c0+0.5*c1,asplit[a][b];` +
        `[a]atrim=0:${c.dur},asetpts=PTS-STARTPTS,afade=t=in:d=${x}[body];[b]atrim=${c.dur}:${c.dur + x},asetpts=PTS-STARTPTS,afade=t=out:d=${x}[tail];` +
        `[body][tail]amix=inputs=2:duration=first:normalize=0`
      : `[0:a]atrim=${c.start}:${c.start + c.dur},asetpts=PTS-STARTPTS,pan=mono|c0=0.5*c0+0.5*c1,afade=t=in:d=0.008,` +
        `afade=t=out:st=${Math.max(0, c.dur - fade)}:d=${fade}`
    // Measure the cut's RMS, then gain it to the target with a limiter on the peaks.
    const probe = Bun.spawnSync(["ffmpeg", "-hide_banner", "-i", src, "-filter_complex", `${cut},volumedetect[o]`, "-map", "[o]", "-f", "null", "-"])
    const mean = Number(probe.stderr.toString().match(/mean_volume: (-?[0-9.]+) dB/)?.[1])
    if (!Number.isFinite(mean)) throw new Error(`${name}: could not measure`)
    const gain = c.rms - mean
    run(["-i", src, "-filter_complex", `${cut},volume=${gain.toFixed(2)}dB,alimiter=limit=0.89:level=false[o]`, "-map", "[o]", "-ar", "48000", "-c:a", "libopus", "-b:a", "64k", out])
    manifest.clips[name] = { ...c, sha256: sha(readFileSync(out)) }
    console.log(`${name}: ${c.from} ${c.start}–${(c.start + c.dur).toFixed(2)} s, ${gain >= 0 ? "+" : ""}${gain.toFixed(1)} dB`)
  }
  save()
}

function save() {
  mkdirSync(outDir, { recursive: true })
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n")
}

if (import.meta.main) {
  const cmd = process.argv[2]
  if (cmd === "fetch") await fetchAll()
  else if (cmd === "build") build()
  else console.log("usage: bun scripts/sounds.ts fetch|build")
}
