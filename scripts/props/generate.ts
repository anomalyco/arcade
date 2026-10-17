#!/usr/bin/env bun
/**
 * The prop pipeline, end to end (see scripts/props/README.md):
 *
 *   bun scripts/props/generate.ts [--ids a,b] [--force] [--skip-trellis] [--work DIR] [--worker mini|pro]
 *
 * 1. source images: run `source-images.ts` first (it needs the OpenAI key; see its header).
 * 2. TRELLIS.2 on a remote render worker (mini preferred, pro fallback; never studio), one job at a time:
 *    `hivemind run --kind render --worker <worker>`. Uses the resident worker (`trellis_worker.py`, 5 min idle unload).
 * 3. Blender cleanup (headless, one process for all props) into packages/kit/props/assets/<id>.prop.
 * Writes <work>/report.json with per-prop seconds, triangles and bytes, and fixes from `fixups.json`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { PROP_IDS, PROP_SPECS } from "../../packages/kit/props/catalogue"
import { arg, trellisHome, workDir } from "./work"

const work = workDir()
const worker = arg("--worker") ?? process.env.PROPS_WORKER ?? "mini"
if (worker === "studio" && process.env.ALLOW_STUDIO_TRELLIS !== "1") {
  throw new Error("Refusing to run heavy TRELLIS/Blender jobs on studio (desk + OpenCode host). Use --worker mini or --worker pro.")
}
const repo = new URL("../../", import.meta.url).pathname
const out = join(repo, "packages/kit/props/assets")
const ids = arg("--ids")?.split(",") ?? PROP_IDS
mkdirSync(out, { recursive: true })

const run = async (cmd: string[], label: string) => {
  console.log(`▸ ${label} (worker=${worker})`)
  const t0 = performance.now()
  const p = Bun.spawn(cmd, { cwd: repo, stdout: "inherit", stderr: "inherit" })
  const code = await p.exited
  if (code) throw new Error(`${label} failed (${code})`)
  return (performance.now() - t0) / 1000
}

const missing = ids.filter(id => !existsSync(join(work, "source", `${id}.png`)))
if (missing.length) console.log(`no source image for ${missing.join(", ")}: run scripts/props/source-images.ts first`)

const specFile = join(work, "specs.json")
const fixups = JSON.parse(readFileSync(new URL("./fixups.json", import.meta.url), "utf8"))
writeFileSync(specFile, JSON.stringify({ props: PROP_SPECS, fixups }))

const isRemote = worker !== "studio"
const remoteWorkExpr = "$HOME/code/home/artifacts/2026-10-16-props"
const remotePyExpr = "$HOME/code/experiments/image-to-3d/trellis2-mac/.venv/bin/python"

if (isRemote) {
  await run(["ssh", worker, `mkdir -p ${remoteWorkExpr}/source ${remoteWorkExpr}/raw ${remoteWorkExpr}/assets ${remoteWorkExpr}/scripts`], "Prepare remote workdir")
  await run([
    "rsync", "-a",
    specFile,
    join(repo, "scripts/props/trellis-batch.py"),
    join(repo, "scripts/props/blender-cleanup.py"),
    `${worker}:code/home/artifacts/2026-10-16-props/scripts/`,
  ], "Sync scripts and specs.json")
  for (const id of ids) {
    const srcPng = join(work, "source", `${id}.png`)
    if (existsSync(srcPng)) {
      await run(["rsync", "-a", srcPng, `${worker}:code/home/artifacts/2026-10-16-props/source/${id}.png`], `Sync source ${id}.png`)
    }
    const cutPng = join(work, "raw", `${id}-cutout.png`)
    if (existsSync(cutPng)) {
      await run(["rsync", "-a", cutPng, `${worker}:code/home/artifacts/2026-10-16-props/raw/${id}-cutout.png`], `Sync cutout ${id}-cutout.png`)
    }
  }
}

if (!process.argv.includes("--skip-trellis")) {
  const forceFlag = process.argv.includes("--force") ? " --force" : ""
  if (isRemote) {
    await run([
      "hivemind", "run", "--no-sync", "--kind", "render", "--worker", worker, "--",
      "sh", "-c", `${remotePyExpr} "${remoteWorkExpr}/scripts/trellis-batch.py" --work "${remoteWorkExpr}" --ids "${ids.join(",")}"${forceFlag}`,
    ], "TRELLIS.2 batch")
  } else {
    await run([
      "hivemind", "run", "--kind", "render", "--worker", worker, "--",
      join(trellisHome(), ".venv/bin/python"), "scripts/props/trellis-batch.py", "--work", work, "--ids", ids.join(","),
      ...(process.argv.includes("--force") ? ["--force"] : []),
    ], "TRELLIS.2 batch")
  }
}

const blenderS = await run(
  isRemote
    ? [
        "hivemind", "run", "--no-sync", "--kind", "render", "--worker", worker, "--",
        "sh", "-c", `blender -b --factory-startup -P "${remoteWorkExpr}/scripts/blender-cleanup.py" -- --work "${remoteWorkExpr}" --out "${remoteWorkExpr}/assets" --spec "${remoteWorkExpr}/scripts/specs.json" --ids "${ids.join(",")}"`,
      ]
    : [
        "hivemind", "run", "--kind", "render", "--worker", worker, "--",
        "blender", "-b", "--factory-startup", "-P", "scripts/props/blender-cleanup.py", "--",
        "--work", work, "--out", out, "--spec", specFile, "--ids", ids.join(","),
      ],
  "Blender cleanup",
)

if (isRemote) {
  mkdirSync(join(work, "raw"), { recursive: true })
  for (const id of ids) {
    await run(["rsync", "-a", `${worker}:code/home/artifacts/2026-10-16-props/assets/${id}.prop`, join(out, `${id}.prop`)], `Fetch ${id}.prop`)
  }
  await run([
    "rsync", "-a",
    `${worker}:code/home/artifacts/2026-10-16-props/cleanup-report.json`,
    `${worker}:code/home/artifacts/2026-10-16-props/cleanup-failed.json`,
    work + "/",
  ], "Fetch cleanup reports")
  const rawFiles = [`${worker}:code/home/artifacts/2026-10-16-props/raw/timings.jsonl`]
  for (const id of ids) {
    rawFiles.push(`${worker}:code/home/artifacts/2026-10-16-props/raw/${id}.glb`)
  }
  await run(["rsync", "-a", ...rawFiles, join(work, "raw") + "/"], "Fetch TRELLIS timings and GLBs")
}

const timings = new Map<string, Record<string, number>>()
const tf = join(work, "raw", "timings.jsonl")
if (existsSync(tf)) for (const line of readFileSync(tf, "utf8").split("\n")) if (line.trim()) { const r = JSON.parse(line); timings.set(r.id, r) }
const cleanup = JSON.parse(readFileSync(join(work, "cleanup-report.json"), "utf8")) as { id: string; lods: { tris: number }[]; bytes: number; seconds: number }[]
const failed = JSON.parse(readFileSync(join(work, "cleanup-failed.json"), "utf8")) as { id: string; error: string }[]
const prevReportPath = join(work, "report.json")
const rowMap = new Map<string, { id: string; lods: { tris: number }[]; bytes: number; seconds: number; trellis?: Record<string, number> }>()
if (existsSync(prevReportPath)) {
  try {
    const prev = JSON.parse(readFileSync(prevReportPath, "utf8"))
    for (const r of prev.rows ?? []) rowMap.set(r.id, r)
  } catch {}
}
for (const c of cleanup) rowMap.set(c.id, { ...c, trellis: timings.get(c.id) })
const rows = Array.from(rowMap.values())
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
