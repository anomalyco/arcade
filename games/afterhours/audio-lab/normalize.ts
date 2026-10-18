#!/usr/bin/env bun
// Loudness-normalise audio-lab clips in place (targets and method in lib/loudness.ts). Untouched takes are kept in
// sfx-raw/<category>/<variant>.mp3 and every run renders from them, so it is safe to re-run after changing targets.
//
//   bun audio-lab/normalize.ts                     # new/changed takes only
//   bun audio-lab/normalize.ts --all               # redo everything from sfx-raw/
//   bun audio-lab/normalize.ts --category hor-knock
import { parseArgs } from "node:util"
import { loadManifest, ROOT, saveManifest } from "./lib/eleven"
import { normaliseSound, targetFor } from "./lib/loudness"

const { values: args } = parseArgs({
  options: {
    category: { type: "string", short: "c" },
    all: { type: "boolean", default: false },
    concurrency: { type: "string", default: "6" },
  },
})

const manifest = await loadManifest()
const cats = args.category?.split(",")
const todo = manifest.sounds.filter((s) => {
  if (cats && !cats.includes(s.category)) return false
  if (args.all) return true
  const t = targetFor(s)
  return !s.loudness || s.loudness.take !== s.generatedAt || s.loudness.target !== t.target || s.loudness.metric !== t.metric
})
console.log(`Normalising ${todo.length} clips…`)
let i = 0
let n = 0
await Promise.all(
  Array.from({ length: Number(args.concurrency) }, async () => {
    while (i < todo.length) {
      const s = todo[i++]
      try {
        const l = await normaliseSound(ROOT, s)
        const lvl = (x: typeof l.out) => (l.metric === "integrated" ? x.integrated : x.momentaryMax)
        console.log(
          `[${++n}/${todo.length}] ${s.file}  ${lvl(l.raw).toFixed(1)} -> ${lvl(l.out).toFixed(1)} (target ${l.target}, ${l.metric})  gain ${l.gainDb >= 0 ? "+" : ""}${l.gainDb} dB${l.limitedDb ? `, limited ${l.limitedDb} dB` : ""}  TP ${l.out.truePeak.toFixed(1)}`,
        )
        saveManifest(manifest)
      } catch (e) {
        console.error(`[${++n}/${todo.length}] FAILED ${s.file}: ${(e as Error).message}`)
      }
    }
  }),
)
await saveManifest(manifest)
