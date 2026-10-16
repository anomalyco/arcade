#!/usr/bin/env bun
/**
 * The prop pipeline, end to end (see scripts/props/README.md):
 *
 *   bun scripts/props/generate.ts [--ids a,b] [--force] [--skip-trellis] [--work DIR]
 *
 * 1. source images: run `source-images.ts` first (it needs the OpenAI key; see its header).
 * 2. TRELLIS.2 on the Studio, one job at a time: `hivemind run --kind render --worker studio`.
 * 3. Blender cleanup (headless, one process for all props) into packages/kit/props/assets/<id>.prop.
 * Writes <work>/report.json with per-prop seconds, triangles and bytes, and fixes from `fixups.json`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { PROP_IDS, PROP_SPECS } from "../../packages/kit/props/catalogue"
import { arg, trellisHome, workDir } from "./work"

const work = workDir()
const repo = new URL("../../", import.meta.url).pathname
const out = join(repo, "packages/kit/props/assets")
const ids = arg("--ids")?.split(",") ?? PROP_IDS
mkdirSync(out, { recursive: true })

const run = async (cmd: string[], label: string) => {
  console.log(`▸ ${label}`)
  const t0 = performance.now()
  const p = Bun.spawn(cmd, { cwd: repo, stdout: "inherit", stderr: "inherit" })
  const code = await p.exited
  if (code) throw new Error(`${label} failed (${code})`)
  return (performance.now() - t0) / 1000
}

const missing = ids.filter(id => !existsSync(join(work, "source", `${id}.png`)))
if (missing.length) console.log(`no source image for ${missing.join(", ")}: run scripts/props/source-images.ts first`)

if (!process.argv.includes("--skip-trellis")) {
  await run([
    "hivemind", "run", "--kind", "render", "--worker", "studio", "--",
    join(trellisHome(), ".venv/bin/python"), "scripts/props/trellis-batch.py", "--work", work, "--ids", ids.join(","),
    ...(process.argv.includes("--force") ? ["--force"] : []),
  ], "TRELLIS.2 batch")
}

const specFile = join(work, "specs.json")
const fixups = JSON.parse(readFileSync(new URL("./fixups.json", import.meta.url), "utf8"))
writeFileSync(specFile, JSON.stringify({ props: PROP_SPECS, fixups }))
const blenderS = await run([
  "hivemind", "run", "--kind", "render", "--worker", "studio", "--",
  "blender", "-b", "--factory-startup", "-P", "scripts/props/blender-cleanup.py", "--",
  "--work", work, "--out", out, "--spec", specFile, "--ids", ids.join(","),
], "Blender cleanup")

const timings = new Map<string, Record<string, number>>()
const tf = join(work, "raw", "timings.jsonl")
if (existsSync(tf)) for (const line of readFileSync(tf, "utf8").split("\n")) if (line.trim()) { const r = JSON.parse(line); timings.set(r.id, r) }
const cleanup = JSON.parse(readFileSync(join(work, "cleanup-report.json"), "utf8")) as { id: string; lods: { tris: number }[]; bytes: number; seconds: number }[]
const failed = JSON.parse(readFileSync(join(work, "cleanup-failed.json"), "utf8")) as { id: string; error: string }[]
const rows = cleanup.map(c => ({ ...c, trellis: timings.get(c.id) }))
const totalBytes = rows.reduce((n, r) => n + r.bytes, 0)
const gen = rows.map(r => r.trellis?.total_s).filter((v): v is number => v !== undefined)
const report = {
  at: new Date().toISOString(),
  props: rows.length,
  bytes: totalBytes,
  trellisSecondsPerAsset: gen.length ? Number((gen.reduce((a, b) => a + b, 0) / gen.length).toFixed(1)) : null,
  blenderSeconds: Number(blenderS.toFixed(1)),
  failed,
  rows,
}
writeFileSync(join(work, "report.json"), JSON.stringify(report, null, 1))
console.log(`${rows.length} props, ${(totalBytes / 1024).toFixed(0)} KB, TRELLIS ${report.trellisSecondsPerAsset} s/asset, Blender ${report.blenderSeconds} s total`)
for (const f of failed) console.log(`FAILED ${f.id}: ${f.error}`)
