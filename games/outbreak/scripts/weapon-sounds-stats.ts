// Bakes every layered weapon sound (AR-102) offline and prints each one's length, bake time, sample peak and loudness
// (BS.1770 at 48 kHz). Never plays audio.
//
//   bun scripts/weapon-sounds-stats.ts [--filter <id prefix>] [--json <path>]
import { writeFileSync } from "node:fs"
import { integratedLufs, momentaryMaxLufs } from "../../../packages/kit/audio/sfx-analysis"
import { WEAPON_SAMPLE_RATE, WEAPON_SOUNDS } from "../src/audio/weapons/catalog"

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const prefix = arg("filter") ?? ""

/** Linear resample to 48 kHz for the loudness meter. */
export function to48k(pcm: Float32Array, sr = WEAPON_SAMPLE_RATE): Float32Array {
  const n = Math.floor((pcm.length * 48000) / sr)
  const out = new Float32Array(n)
  const step = sr / 48000
  for (let i = 0; i < n; i++) {
    const p = i * step
    const k = Math.floor(p)
    const a = pcm[k] ?? 0
    const b = pcm[k + 1] ?? a
    out[i] = a + (b - a) * (p - k)
  }
  return out
}

const rows: Record<string, unknown>[] = []
let totalBytes = 0
let totalMs = 0
for (const def of WEAPON_SOUNDS) {
  if (!def.id.startsWith(prefix)) continue
  for (let v = 0; v < def.variants; v++) {
    const t0 = performance.now()
    const pcm = def.bake(WEAPON_SAMPLE_RATE, v)
    const ms = performance.now() - t0
    totalMs += ms
    totalBytes += pcm.byteLength
    let peak = 0
    let bad = 0
    for (const x of pcm) {
      if (!Number.isFinite(x)) bad++
      else peak = Math.max(peak, Math.abs(x))
    }
    const at48 = to48k(pcm)
    const row = {
      id: def.id,
      v,
      seconds: Number((pcm.length / WEAPON_SAMPLE_RATE).toFixed(2)),
      bakeMs: Number(ms.toFixed(1)),
      peakDb: Number((20 * Math.log10(peak)).toFixed(1)),
      lufsMax: Number(momentaryMaxLufs([at48]).toFixed(1)),
      lufsI: Number(integratedLufs([at48]).toFixed(1)),
      nonFinite: bad,
    }
    rows.push(row)
    if (v === 0 || bad) console.log(`${def.id.padEnd(26)} v${v} ${String(row.seconds).padStart(5)}s bake ${String(row.bakeMs).padStart(6)}ms peak ${String(row.peakDb).padStart(6)} dBFS  M max ${String(row.lufsMax).padStart(6)}  I ${String(row.lufsI).padStart(6)}${bad ? `  NON-FINITE ${bad}` : ""}`)
  }
}
console.log(`${rows.length} takes, ${(totalBytes / 1e6).toFixed(1)} MB of PCM if all baked, ${totalMs.toFixed(0)} ms to bake them all`)
const out = arg("json")
if (out) writeFileSync(out, JSON.stringify(rows, null, 2))
