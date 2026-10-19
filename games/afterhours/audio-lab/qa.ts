#!/usr/bin/env bun
// Listening QA: Gemini describes every clip and scores it 1–5 against its category intent (prompts.ts).
// Results go into manifest.json (sound.qa) and show on the audition page.
//
//   bun audio-lab/qa.ts                    # judge clips without a current QA result
//   bun audio-lab/qa.ts --all              # re-judge everything
//   bun audio-lab/qa.ts --category light-breaker
import { join } from "node:path"
import { parseArgs } from "node:util"
import { judge, QA_MODEL } from "./lib/gemini"
import { intentFor } from "./prompts"
import { categoryById, loadManifest, ROOT, saveManifest, type ManifestSound } from "./lib/eleven"


export async function qaSound(s: ManifestSound): Promise<void> {
  const intent = intentFor(s.category, s.variant) || s.prompt
  const j = await judge(await Bun.file(join(ROOT, s.file)).arrayBuffer(), intent)
  s.qa = { ...j, intent, model: QA_MODEL, at: new Date().toISOString() }
}

if (import.meta.main) {
  const { values: args } = parseArgs({
    options: {
      category: { type: "string", short: "c" },
      all: { type: "boolean", default: false },
      concurrency: { type: "string", default: "4" },
    },
  })
  const manifest = await loadManifest()
  const cats = args.category?.split(",")
  const todo = manifest.sounds.filter(
    (s) =>
      !s.designed &&
      (!cats || cats.includes(s.category)) &&
      (args.all || !s.qa || s.qa.intent !== intentFor(s.category, s.variant)),
  )
  console.log(`QA ${todo.length} clips with ${QA_MODEL}…`)
  let i = 0
  let n = 0
  await Promise.all(
    Array.from({ length: Number(args.concurrency) }, async () => {
      while (i < todo.length) {
        const s = todo[i++]
        try {
          await qaSound(s)
          saveManifest(manifest)
          console.log(`[${++n}/${todo.length}] ${s.file} ${s.qa!.score}/5  ${s.qa!.description}`)
        } catch (e) {
          console.error(`[${++n}/${todo.length}] FAILED ${s.file}: ${(e as Error).message}`)
        }
      }
    }),
  )
  await saveManifest(manifest)
}
