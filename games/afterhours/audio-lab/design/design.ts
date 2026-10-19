#!/usr/bin/env bun
// Renders designed sounds (recipes.ts) into audio-lab/sfx/<category>/v<N>.mp3, adds them to the manifest under their
// group/subgroup, loudness-normalises them (raw renders kept in sfx-raw/) and runs the listening QA. Approved takes
// are never re-rendered. No ElevenLabs credits (sources come from sources.ts).
//
//   bun audio-lab/design/design.ts                       # render missing takes
//   bun audio-lab/design/design.ts --category wen2-chatter --force
//   bun audio-lab/design/design.ts --weak                # re-render takes the listening QA scored <= 3
import { join } from "node:path"
import { parseArgs } from "node:util"
import { loadManifest, ROOT, saveManifest, type ManifestSound } from "../lib/eleven"
import { normaliseSound } from "../lib/loudness"
import { judge, QA_MODEL } from "../lib/gemini"
import { isApproved } from "../lib/approved"
import { RECIPES } from "./recipes"
import * as D from "./dsp"

const { values: args } = parseArgs({
  options: { category: { type: "string", short: "c" }, force: { type: "boolean", default: false }, weak: { type: "boolean", default: false }, takes: { type: "string", default: "3" } },
})
const only = args.category?.split(",")
const TAKES = Number(args.takes)
const ROUND = "round 2"

const hash = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7)

const m = await loadManifest()
m.designedCategories = RECIPES.map((r) => ({ id: r.id, group: "monsters", subgroup: `${r.subgroup} (${ROUND})`, label: r.label, intent: r.intent, loop: false, designed: true as const }))

for (const r of RECIPES) {
  if (only && !only.includes(r.id)) continue
  for (let k = 0; k < TAKES; k++) {
    const variant = `v${k + 1}`
    const file = `sfx/${r.id}/${variant}.mp3`
    if (isApproved(r.id, variant)) continue
    const cur = m.sounds.find((s) => s.file === file)
    if (cur && !args.force && !(args.weak && (cur.qa?.score ?? 0) <= 3)) continue
    const t0 = performance.now()
    const st = await r.render(k, D.rng(hash(r.id) + k * 101))
    await D.save(join(ROOT, file), st)
    const entry: ManifestSound = {
      category: r.id,
      group: "monsters",
      variant,
      prompt: `Designed: ${r.about[k] ?? r.about[0]}`,
      duration: +(st[0].length / D.SR).toFixed(2),
      influence: 0,
      loop: false,
      file,
      bytes: 0,
      cost: 0,
      generatedAt: new Date().toISOString(),
      designed: true,
      sources: r.sources,
      status: "added",
    }
    await normaliseSound(ROOT, entry)
    const j = await judge(await Bun.file(join(ROOT, file)).arrayBuffer(), r.intent)
    entry.qa = { ...j, intent: r.intent, model: QA_MODEL, at: new Date().toISOString() }
    m.sounds = m.sounds.filter((s) => s.file !== file)
    m.sounds.push(entry)
    await saveManifest(m)
    console.log(`${file}  ${entry.duration}s  QA ${j.score}/5  (${Math.round(performance.now() - t0)} ms)  ${j.description.slice(0, 110)}`)
  }
}
await saveManifest(m)
