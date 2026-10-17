#!/usr/bin/env bun
/**
 * The prop pipeline, end to end (see scripts/props/README.md):
 *
 *   bun scripts/props/generate.ts [--ids a,b] [--force] [--skip-trellis] [--work DIR] [--worker mini|pro|local]
 *
 * 1. source images: run `source-images.ts` first (it needs the OpenAI key; see its header).
 * 2. TRELLIS.2 on a remote render worker (`mini` default, `pro` fallback; never `studio` unless `ALLOW_STUDIO_TRELLIS=1`,
 *    or `local` on a standalone Apple Silicon Mac), one job at a time via `trellis_worker.py` (5 min idle unload).
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
  throw new Error("Refusing to run heavy TRELLIS/Blender jobs on studio (desk + OpenCode host). Use --worker mini, --worker pro, or --worker local on a standalone Mac.")
}
const repo = new URL("../../", import.meta.url).pathname
const out = join(repo, "packages/kit/props/assets")
const ids = arg("--ids")?.split(",") ?? PROP_IDS
const idCsv = ids.join(",")
const skipTrellis = process.argv.includes("--skip-trellis")
const force = process.argv.includes("--force")
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

const isRemote = worker !== "studio" && worker !== "local"
const remoteWorkRel = process.env.PROPS_REMOTE_WORK ?? "code/home/artifacts/2026-10-16-props"
const remoteWork = `$HOME/${remoteWorkRel}`
const remoteDest = `${worker}:${remoteWorkRel}`
const remotePy = "$HOME/code/experiments/image-to-3d/trellis2-mac/.venv/bin/python"

const execStage = (remoteShellCmd: string, localCmd: string[], label: string) => {
  if (isRemote) {
    return run(["hivemind", "run", "--no-sync", "--kind", "render", "--worker", worker, "--", "sh", "-c", remoteShellCmd], label)
  }
  if (worker === "local") {
    return run(localCmd, label)
  }
  return run(["hivemind", "run", "--kind", "render", "--worker", worker, "--", ...localCmd], label)
}

if (isRemote) {
  await run(["ssh", worker, `mkdir -p ${remoteWork}/source ${remoteWork}/raw ${remoteWork}/assets ${remoteWork}/scripts`], "Prepare remote workdir")
  await run([
    "rsync", "-a",
    specFile,
    join(repo, "scripts/props/trellis-batch.py"),
    join(repo, "scripts/props/blender-cleanup.py"),
    `${remoteDest}/scripts/`,
  ], "Sync scripts and specs.json")

  const srcPngs = ids.map(id => join(work, "source", `${id}.png`)).filter(existsSync)
  if (srcPngs.length) {
    await run(["rsync", "-a", ...srcPngs, `${remoteDest}/source/`], `Sync ${srcPngs.length} source image(s)`)
  }
  const rawSync = [
    ...ids.map(id => join(work, "raw", `${id}-cutout.png`)).filter(existsSync),
    ...(skipTrellis ? ids.map(id => join(work, "raw", `${id}.glb`)).filter(existsSync) : []),
  ]
  if (rawSync.length) {
    await run(["rsync", "-a", ...rawSync, `${remoteDest}/raw/`], `Sync ${rawSync.length} cached raw file(s)`)
  }
}

if (!skipTrellis) {
  const forceFlag = force ? " --force" : ""
  await execStage(
    `${remotePy} "${remoteWork}/scripts/trellis-batch.py" --work "${remoteWork}" --ids "${idCsv}"${forceFlag}`,
    [
      join(trellisHome(), ".venv/bin/python"), "scripts/props/trellis-batch.py",
      "--work", work, "--ids", idCsv, ...(force ? ["--force"] : []),
    ],
    "TRELLIS.2 batch",
  )
}

const blenderS = await execStage(
  `blender -b --factory-startup -P "${remoteWork}/scripts/blender-cleanup.py" -- --work "${remoteWork}" --out "${remoteWork}/assets" --spec "${remoteWork}/scripts/specs.json" --ids "${idCsv}"`,
  [
    "blender", "-b", "--factory-startup", "-P", "scripts/props/blender-cleanup.py", "--",
    "--work", work, "--out", out, "--spec", specFile, "--ids", idCsv,
  ],
  "Blender cleanup",
)

if (isRemote) {
  mkdirSync(join(work, "raw"), { recursive: true })
  await run([
    "rsync", "-a",
    ...ids.map(id => `${remoteDest}/assets/${id}.prop`),
    `${out}/`,
  ], `Fetch ${ids.length} .prop asset(s)`)
  await run([
    "rsync", "-a",
    `${remoteDest}/cleanup-report.json`,
    `${remoteDest}/cleanup-failed.json`,
    `${work}/`,
  ], "Fetch cleanup reports")
  if (!skipTrellis) {
    await run([
      "rsync", "-a",
      `${remoteDest}/raw/timings.jsonl`,
      ...ids.map(id => `${remoteDest}/raw/${id}.glb`),
      `${join(work, "raw")}/`,
    ], "Fetch TRELLIS timings and GLBs")
  }
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
