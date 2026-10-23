// Offline thunder proof: a near, a mid and a far strike rendered through BARBARA's own audio chain (WoodsMix → the
// soundscape's outdoor bus and forest reverb → the limiter) in an OfflineAudioContext, never to the speakers. Measures
// when each one starts against its real travel time (slant distance / 343 m/s) and writes the renders as WAVs.
//   NWA=<dir>/node_modules/node-web-audio-api bun scripts/thunder-proof.ts [--out <dir>]
// Needs `node-web-audio-api` (install it in a scratch dir; it isn't a workspace dependency) and ffmpeg to decode the
// library's Opus files to WAV, as `Soundscape.load`'s fetcher.
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { SFX_BY_ID } from "@arcade/kit/audio/library"
import { SPEED_OF_SOUND, type ThunderEvent } from "@arcade/kit/weather/storm"
import { makeWorld } from "../shared/world"
import { WoodsMix } from "../src/audio/index"
import { SOUND } from "../src/audio/settings"
import { STORM_SFX } from "../src/sfx"

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1]! : fallback }
const out = resolve(arg("--out", "captures/barbara-looks/thunder"))
mkdirSync(out, { recursive: true })
const nwa = (await import(process.env.NWA ?? "node-web-audio-api")) as { OfflineAudioContext: new (channels: number, length: number, rate: number) => OfflineAudioContext }

const repo = resolve(import.meta.dir, "../../..")
const files = new Map<string, string>()
for (const id of STORM_SFX) for (const f of SFX_BY_ID.get(id)?.files ?? []) files.set(f.file, resolve(repo, f.path))
const fetcher = async (url: string): Promise<ArrayBuffer> => {
  const hit = [...files].find(([file]) => url.endsWith(file))
  if (!hit) throw new Error(`no file for ${url}`)
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", hit[1], "-f", "wav", "-ar", "48000", "-ac", "2", "-"], { maxBuffer: 1 << 28 })
  if (r.status !== 0) throw new Error(`ffmpeg ${hit[1]}: ${r.stderr}`)
  const b = r.stdout as Buffer
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

function wav(buf: AudioBuffer): Uint8Array {
  const n = buf.length, ch = buf.numberOfChannels, data = new DataView(new ArrayBuffer(44 + n * ch * 2))
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)) }
  str(0, "RIFF"); data.setUint32(4, 36 + n * ch * 2, true); str(8, "WAVE"); str(12, "fmt "); data.setUint32(16, 16, true)
  data.setUint16(20, 1, true); data.setUint16(22, ch, true); data.setUint32(24, buf.sampleRate, true); data.setUint32(28, buf.sampleRate * ch * 2, true)
  data.setUint16(32, ch * 2, true); data.setUint16(34, 16, true); str(36, "data"); data.setUint32(40, n * ch * 2, true)
  const chans = Array.from({ length: ch }, (_, c) => buf.getChannelData(c))
  for (let i = 0, o = 44; i < n; i++) for (let c = 0; c < ch; c++, o += 2) data.setInt16(o, Math.max(-1, Math.min(1, chans[c]![i]!)) * 32767, true)
  return new Uint8Array(data.buffer)
}

/** First time the 10 ms RMS (both channels) rises within 30 dB of its peak. */
function onset(buf: AudioBuffer): { at: number; peakDb: number } {
  const sr = buf.sampleRate, win = Math.round(sr * 0.01), l = buf.getChannelData(0), r = buf.getChannelData(1)
  const rms: number[] = []
  for (let i = 0; i + win <= buf.length; i += win) { let s = 0; for (let j = i; j < i + win; j++) s += l[j]! * l[j]! + r[j]! * r[j]!; rms.push(Math.sqrt(s / (2 * win))) }
  const peak = Math.max(...rms), k = rms.findIndex((v) => v >= peak * 10 ** (-30 / 20))
  return { at: (k * win) / sr, peakDb: 20 * Math.log10(peak) }
}

const world = makeWorld()
const listener = { x: 0, y: 1.7, z: 0, yaw: 0 }
const rows: { kind: string; distance: number; expected: number; measured: number; error: number; peakDb: number; sample: string }[] = []
for (const [name, ground] of [["near", 400], ["mid", 1200], ["far", 3000]] as const) {
  const slant = Math.hypot(ground, 60)
  const e: ThunderEvent = { id: 1, kind: "ground", distance: slant, bearing: 0.5, position: [Math.sin(0.5) * ground, 60, -Math.cos(0.5) * ground], emitted: 0, arrives: slant / SPEED_OF_SOUND, power: 1 }
  const seconds = Math.ceil(e.arrives + 12), sr = 48000
  const ctx = new nwa.OfflineAudioContext(2, seconds * sr, sr)
  const mix = new WoodsMix(ctx, { ...SOUND }, "/arcade/barbara/audio/", () => world, undefined, fetcher)
  mix.scapeOut.gain.value = 0.8
  await mix.scape.storm.load(fetcher)
  mix.scape.storm.thunder(e, listener, 0)
  const buf = await ctx.startRendering()
  const o = onset(buf), heard = mix.scape.storm.heard[0]!
  writeFileSync(`${out}/thunder-${name}.wav`, wav(buf))
  rows.push({ kind: name, distance: Math.round(slant), expected: +e.arrives.toFixed(3), measured: +o.at.toFixed(3), error: +(o.at - e.arrives).toFixed(3), peakDb: +o.peakDb.toFixed(1), sample: heard.sample })
  console.log(name, JSON.stringify(rows.at(-1)))
}
writeFileSync(`${out}/thunder.json`, JSON.stringify({ speedOfSound: SPEED_OF_SOUND, threshold: "10 ms RMS within 30 dB of peak", rows }, null, 2))
const worst = Math.max(...rows.map((r) => Math.abs(r.error)))
console.log(`worst onset error ${worst.toFixed(3)} s`)
if (worst > 0.25) process.exit(1)
