// Run via hivemind: this isolated worker-only Vite exits with the benchmark.
import { join } from "node:path"

if (!process.env.ARCADE_BENCH_WORKER) throw new Error("Run this through hivemind with ARCADE_BENCH_WORKER=1")
const game = process.argv.find((a) => a.startsWith("--game="))?.slice(7) ?? "blackout"
if (!["blackout", "getaway"].includes(game)) throw new Error("Unknown game")
const sourceRoot = process.argv.find((a) => a.startsWith("--source-root="))?.slice(14)
const cwd = join(sourceRoot ?? join(import.meta.dir, "../../.."), "games", game)
const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
const port = reserve.port!
reserve.stop(true)
const base = `http://localhost:${port}`
const server = Bun.spawn(["bun", "x", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd, stdout: "ignore", stderr: "inherit" })
try {
  const deadline = Date.now() + 15000
  for (;;) {
    if (await fetch(`${base}/`).then((r) => r.ok).catch(() => false)) break
    if (Date.now() > deadline || server.exitCode !== null) throw new Error("Worker Vite did not become ready")
    await Bun.sleep(100)
  }
  const script = process.argv.includes("--capture") ? join(import.meta.dir, "../../", game, "scripts/compare.ts") : join(import.meta.dir, process.argv.includes("--getaway-paired") ? "bench-getaway-paired.ts" : process.argv.includes("--monitor-cost") ? "bench-monitor-cost.ts" : "bench-render.ts")
  const job = Bun.spawn(["bun", script, `--base=${base}`, `--port=${port}`, ...process.argv.slice(2)], { cwd, stdout: "inherit", stderr: "inherit" })
  process.exitCode = await job.exited
} finally {
  server.kill()
  await server.exited
}
