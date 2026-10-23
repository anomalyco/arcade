/** bun scripts/quality-gate.ts barbara|lab --states file.json [--out dir] [--benchmark-cold N] [--url url] */
import { resolve } from "node:path"
import { mkdir } from "node:fs/promises"
import { createServer } from "vite"
import { browserBudget } from "./browser-budget"
import { parseSpec } from "./quality/spec"
import { sweep } from "./quality/sweep"

const args = process.argv.slice(2), target = args.shift()
const flags = new Map<string, string>()
while (args.length) {
  const key = args.shift()!, value = args.shift()
  if (!["--states", "--out", "--benchmark-cold", "--url"].includes(key) || !value || flags.has(key)) throw new Error(`Invalid option ${key}`)
  flags.set(key, value)
}
if (!target || !["barbara", "lab"].includes(target) || !flags.has("--states")) throw new Error("Usage: bun scripts/quality-gate.ts barbara|lab --states file.json [--out dir] [--benchmark-cold N] [--url url]")
const spec = parseSpec(await Bun.file(flags.get("--states")!).json())
const cold = Number(flags.get("--benchmark-cold") ?? 0)
if (!Number.isInteger(cold) || cold < 0 || cold > spec.states.length) throw new Error("Invalid cold sample count")
const out = resolve(flags.get("--out") ?? `captures/quality-${target}`)
await mkdir(out, { recursive: true })
await Bun.write(`${out}/scoreboard.json`, JSON.stringify({ version: 1, complete: false, pass: false, state: "starting server" }))
await Bun.write(`${out}/index.html`, "<!doctype html><title>Quality sweep incomplete</title><h1>Incomplete: diagnostic captures only</h1>")
let server: Awaited<ReturnType<typeof createServer>> | undefined
try {
  let url = flags.get("--url")
  if (!url) {
    if (target === "barbara") await import("../games/barbara/scripts/build-id")
    server = await createServer({ root: resolve(`games/${target}`), configFile: resolve(`games/${target}/vite.config.ts`), server: { host: "127.0.0.1", port: 0, strictPort: false }, logLevel: "warn" })
    await server.listen()
    const address = server.httpServer!.address()
    if (!address || typeof address === "string") throw new Error("No Vite address")
    url = `http://127.0.0.1:${address.port}${target === "lab" ? "/spider.html" : "/arcade/barbara/"}?quality=high&qualityGate&lab=looks`
  }
  await using budget = browserBudget()
  const result = await sweep(budget, url, spec, out, cold)
  process.exitCode = result.pass ? 0 : 1
  console.log(`${result.pass ? "PASS" : "FAIL"}: ${out}/scoreboard.json`)
} finally { await server?.close() }
