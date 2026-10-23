/** CPU-only inspection of archived stills; absent matched probes are explicitly skipped. */
import { mkdir } from "node:fs/promises"
import { basename, resolve } from "node:path"
import { qualityGates } from "../../packages/kit/proof/legibility"
import { decode } from "./sweep"

const out = resolve("captures/quality-history")
const args = process.argv.slice(2), regression = args[0] === "--regression"
if (regression) args.shift()
if (!args.length || regression && args.length !== 2) throw new Error("Usage: history.ts [--regression] old.png repaired.png")
await mkdir(out, { recursive: true })
const rows = []
for (const file of args) {
  const p = Bun.spawn(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", file], { stdout: "pipe", stderr: "inherit" })
  const info = await new Response(p.stdout).json()
  if (await p.exited) throw new Error(`ffprobe failed: ${file}`)
  const { width, height } = info.streams[0]
  const png = "data:image/png;base64," + Buffer.from(await Bun.file(file).arrayBuffer()).toString("base64")
  const frame = await decode({ png, width, height, exposure: 1, time: 0 })
  rows.push({ file, ...qualityGates(frame, {}, { slabBrightness: 0.012, slabMaxCv: 0.3 }, regression ? "fail" : "warn") })
  await Bun.write(`${out}/${rows.length}-${basename(file)}`, Bun.file(file))
}
await Bun.write(`${out}/history.json`, JSON.stringify(rows, null, 2))
console.log(JSON.stringify(rows, null, 2))
if (regression && (!rows[0]!.gates.some(g => g.id === "slab-needs-probe" && g.status === "fail") || !rows[1]!.pass)) throw new Error("Historical slab regression: expected old still rejected and repaired still accepted")
