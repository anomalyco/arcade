// Isolated fleet fixture; no existing Nexus preview is touched.
import { join } from "node:path"
if (!process.env.ARCADE_BENCH_WORKER) throw new Error("Run through hivemind")
const root = join(import.meta.dir, "../../..")
const historicalRoot = process.argv.find((a) => a.startsWith("--historical-root="))?.slice("--historical-root=".length)
for (const game of ["blackout", "getaway"]) {
  const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = reserve.port!
  reserve.stop(true)
  const base = `http://localhost:${port}`
  const cwd = join(root, "games", game)
  const server = Bun.spawn(["bun", "x", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd, stdout: "ignore", stderr: "inherit" })
  let beforeServer: ReturnType<typeof Bun.spawn> | undefined
  try {
    const deadline = Date.now() + 15000
    while (!await fetch(base).then((r) => r.ok).catch(() => false)) {
      if (Date.now() > deadline || server.exitCode !== null) throw new Error("Vite fixture failed")
      await Bun.sleep(100)
    }
    let historical = process.argv.find((a) => a.startsWith(`--${game}-before=`))?.split("=").slice(1).join("=")
    if (historicalRoot) {
      const slot = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
      const beforePort = slot.port!
      slot.stop(true)
      historical = `http://localhost:${beforePort}`
      beforeServer = Bun.spawn(["bun", "x", "vite", "--host", "127.0.0.1", "--port", String(beforePort), "--strictPort"], { cwd: join(historicalRoot, "games", game), stdout: "ignore", stderr: "inherit" })
      const until = Date.now() + 15000
      while (!await fetch(historical).then((r) => r.ok).catch(() => false)) {
        if (Date.now() > until || beforeServer.exitCode !== null) throw new Error("Historical Vite fixture failed")
        await Bun.sleep(100)
      }
    }
    const job = Bun.spawn(["bun", "games/blackout/scripts/prove-compare.ts", `--game=${game}`, `--base=${base}`, `--before=${historical ?? base + "/?vanilla=1"}`, "--ticks=600", "--lab"], { cwd: root, stdout: "inherit", stderr: "inherit" })
    if (await job.exited) throw new Error(`${game} Lab proof failed`)
  } finally {
    server.kill(); await server.exited
    if (beforeServer) { beforeServer.kill(); await beforeServer.exited }
  }
}
