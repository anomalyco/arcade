/**
 * Compile time and opaque size of streamed chunks: every non-origin chunk in a 15 × 15 area around the origin block,
 * compiled once to warm the template banks and then three times, on this thread. Run before and after a change to
 * the streamed emitter (`bun scripts/bench-chunk-compile.ts`).
 */
import { generateWorldChunk } from "../shared/world"
import { compileSingleWorldChunk, ensurePropTemplates, recycleCompiledChunk } from "../src/world-streamer"
ensurePropTemplates()
const coords: [number, number][] = []
for (let cx = -6; cx < 9; cx++) for (let cy = -6; cy < 9; cy++) if (!(cx >= 0 && cx < 3 && cy >= 0 && cy < 3)) coords.push([cx, cy])
const run = (warm: boolean) => {
  const ms: number[] = [], kb: number[] = []
  for (const [cx, cy] of coords) {
    const wc = generateWorldChunk(7, 7, cx, cy, "streaming")
    const c = compileSingleWorldChunk(wc, 7, 7, 0.22, 1)
    if (!warm) {
      ms.push(c.compileMs)
      kb.push((c.staticOpaqueChunks.reduce((n, s) => n + (s.byteLength ?? s.data.byteLength), 0) + (c.roofChunks ?? []).reduce((n, r) => n + r.data.byteLength, 0)) / 1024)
    }
    recycleCompiledChunk(c)
  }
  return { ms, kb }
}
run(true)
const all: number[] = [], kbs: number[] = []
for (let r = 0; r < 3; r++) { const { ms, kb } = run(false); all.push(...ms); if (r === 0) kbs.push(...kb) }
const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]! }
console.log(JSON.stringify({ chunks: coords.length, compileMs: { median: +q(all, .5).toFixed(2), p95: +q(all, .95).toFixed(2), max: +q(all, 1).toFixed(2) }, kb: { median: Math.round(q(kbs, .5)), p95: Math.round(q(kbs, .95)), max: Math.round(q(kbs, 1)) } }))
