// Bundles bench/pages into $TMP/benchpage and runs it in one headless Chromium (Metal, muted).
//
//   bun bench/wasm/build.ts && bun bench/browser-bench.ts [--only gen,worker,draws] [--frames 200] [--ns 250,500,1000,2000]
import { mkdirSync } from "node:fs"
import { arg, launch, serve, TMP } from "./lib"

const args = process.argv.slice(2)
const only = (arg(args, "only", "cold,worker,compile,gen,draws")!).split(",")
const k = Number(arg(args, "k", "40"))
const frames = Number(arg(args, "frames", "200"))
const ns = arg(args, "ns", "250,500,1000,2000")!.split(",").map(Number)
const modes = arg(args, "modes", "three-mesh,three-bundle,three-instanced,three-batched,raw,raw-bundle")!.split(",")
const out = `${TMP}/benchpage`
mkdirSync(out, { recursive: true })
const built = await Bun.build({
  entrypoints: [`${import.meta.dir}/pages/bench.ts`, `${import.meta.dir}/pages/gen-worker.ts`],
  outdir: out,
  target: "browser",
  format: "esm",
  minify: true,
})
if (!built.success) {
  console.error(built.logs)
  process.exit(1)
}
await Bun.write(`${out}/index.html`, `<!doctype html><canvas></canvas><script type="module" src="bench.js"></script>`)
for (const f of ["terrain.wasm", "terrain-simd.wasm"]) await Bun.write(`${out}/${f}`, Bun.file(`${TMP}/${f}`))

const server = serve(out, 5223)
const browser = await launch()
const page = await browser.newPage({ viewport: { width: 1536, height: 1024 } })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
await page.goto("http://localhost:5223/")
await page.waitForFunction(() => (globalThis as any).__bench?.ready, undefined, { timeout: 30_000 })
const result: Record<string, unknown> = {}
if (only.includes("cold")) result.cold = await page.evaluate(() => (globalThis as any).__bench.cold())
if (only.includes("compile"))
  result.compile = await page.evaluate((k) => (globalThis as any).__bench.compile({ k, variants: ["geom-instanced", "instanced", "instanced-1025", "instanced-storage", "merged-mesh", "merged-mesh-cloned-mats", "instanced-cloned-mats"] }), k)
if (only.includes("gen")) result.gen = await page.evaluate(() => (globalThis as any).__bench.gen())
if (only.includes("worker")) result.worker = await page.evaluate(() => (globalThis as any).__bench.worker())
if (only.includes("draws")) result.draws = await page.evaluate((cfg) => (globalThis as any).__bench.draws(cfg), { modes, ns, frames })
console.log(JSON.stringify({ ...result, errors: errors.slice(0, 5) }, null, 1))
await browser.close()
server.stop(true)
process.exit(0)
