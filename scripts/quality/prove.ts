/** First-adopter proof: both production adapters, counterfactuals, and fresh-browser timings in one admitted job. */
import { resolve } from "node:path"
import { createServer } from "vite"
import { browserBudget } from "../browser-budget"
import { parseSpec } from "./spec"
import { sweep } from "./sweep"
import "../../games/barbara/scripts/build-id"

const out = resolve("captures/quality-proof")
const servers: Awaited<ReturnType<typeof createServer>>[] = []
try {
  const urls: Record<string, string> = {}
  for (const game of ["barbara", "lab"]) {
    const server = await createServer({ root: resolve(`games/${game}`), configFile: resolve(`games/${game}/vite.config.ts`), server: { host: "127.0.0.1", port: 0 }, logLevel: "warn" })
    servers.push(server); await server.listen()
    const address = server.httpServer!.address()
    if (!address || typeof address === "string") throw new Error("No Vite address")
    urls[game] = `http://127.0.0.1:${address.port}${game === "lab" ? "/spider.html" : "/arcade/barbara/"}?quality=high&qualityGate&lab=looks`
  }
  await using budget = browserBudget()
  const barbara = parseSpec(await Bun.file("scripts/quality/states/barbara.json").json())
  // 6 Looks × 4 views, with torch-on/off states and explicit subject/shift probes from the example.
  barbara.states = barbara.states.flatMap(row => [row, { ...row, id: `${row.id}-right`, state: { ...row.state, camera: "right" } }])
  const results = []
  results.push(await sweep(budget, urls.barbara!, barbara, `${out}/barbara`, 1))
  const spider = parseSpec(await Bun.file("scripts/quality/states/spider.json").json())
  const dark = parseSpec(await Bun.file("scripts/quality/states/spider-dark.json").json())
  spider.states.push(...dark.states)
  results.push(await sweep(budget, urls.lab!, spider, `${out}/spider`, 1))
  await budget.finish()
  await Bun.write(`${out}/summary.json`, JSON.stringify(results.map(r => ({ complete: r.complete, pass: r.pass, states: r.rows.length, bootMs: r.bootMs, totalMs: r.totalMs, cold: r.cold, fatal: r.fatal, errors: r.errors })), null, 2))
  if (results.some(r => !r.complete || r.errors.length)) process.exitCode = 1
} finally { await Promise.all(servers.map(s => s.close())) }
