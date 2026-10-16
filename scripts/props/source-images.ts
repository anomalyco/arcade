#!/usr/bin/env bun
/**
 * Step 1 of the prop pipeline: a clean product shot per catalogue prop from the image model.
 *
 *   bun scripts/props/source-images.ts [--ids a,b] [--force] [--work DIR]
 *
 * Run it under `2password run --env "OPENAI_API_KEY=op://Automation/OpenAI API Key/credential" --`. The API call runs on
 * `pro`; the key goes to it on stdin (never argv or disk). Images land in
 * `<work>/source/<id>.png`, prompts in `<work>/source/generations.jsonl`. Existing images are kept unless --force.
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { PROP_IDS } from "../../packages/kit/props/catalogue"
import { promptFor } from "./sources"
import { arg, workDir } from "./work"

const work = workDir()
const dir = join(work, "source")
mkdirSync(dir, { recursive: true })
const ids = (arg("--ids")?.split(",") ?? PROP_IDS).filter(id => process.argv.includes("--force") || !existsSync(join(dir, `${id}.png`)))
if (!ids.length) {
  console.log("all source images exist")
  process.exit(0)
}
const spec = { model: arg("--model") ?? "gpt-image-2", size: "1024x1024", quality: arg("--quality") ?? "high", parallel: 6, jobs: ids.map(id => ({ id, prompt: promptFor(id) })) }
const script = Buffer.from(readFileSync(new URL("./openai-images.py", import.meta.url))).toString("base64")
const key = process.env.OPENAI_API_KEY
if (!key) throw new Error("OPENAI_API_KEY missing: run under 2password run --env ...")
const remote = `/opt/homebrew/bin/python3 -c 'import sys,base64;exec(base64.b64decode(sys.argv[1]))' ${script}`
console.log(`generating ${ids.length} source images on pro (${spec.model}, ${spec.quality})`)
const t0 = performance.now()
const proc = Bun.spawn(["ssh", "pro", remote], { stdin: new TextEncoder().encode(JSON.stringify({ ...spec, key })), stdout: "pipe", stderr: "inherit" })
let failed = 0
let buf = ""
const decoder = new TextDecoder()
for await (const chunk of proc.stdout) {
  buf += decoder.decode(chunk, { stream: true })
  let nl: number
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line.startsWith("{")) continue
    const r = JSON.parse(line) as { id: string; b64?: string; error?: string }
    if (r.b64) {
      writeFileSync(join(dir, `${r.id}.png`), Buffer.from(r.b64, "base64"))
      const job = spec.jobs.find(j => j.id === r.id)!
      appendFileSync(join(dir, "generations.jsonl"), JSON.stringify({ id: r.id, model: spec.model, size: spec.size, quality: spec.quality, prompt: job.prompt, at: new Date().toISOString() }) + "\n")
      console.log(`  ${r.id} ✓ ${((performance.now() - t0) / 1000).toFixed(0)}s`)
    } else {
      failed++
      console.log(`  ${r.id} ✗ ${r.error}`)
    }
  }
}
const code = await proc.exited
console.log(`done in ${((performance.now() - t0) / 1000).toFixed(0)}s, ${failed} failed, ssh exit ${code}`)
process.exit(failed || code ? 1 : 0)
