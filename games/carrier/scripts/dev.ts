// Runs the Worker (rooms) and the Vite client together. Vite proxies /ws to the Worker.
// Each process is restarted if it dies: a build or deploy elsewhere deletes dist/, and Wrangler exits when it reloads
// its config without the assets directory.
import { mkdirSync } from "node:fs"
import type { Subprocess } from "bun"

await Bun.spawn(["bun", "scripts/build-id.ts"], { stdio: ["inherit", "inherit", "inherit"] }).exited

const commands = [
  ["bunx", "wrangler", "dev", "--port", "8797"],
  ["bunx", "vite", "--host", "0.0.0.0", "--port", "5197", "--strictPort"],
]
const procs: Subprocess[] = []
let stopping = false

async function supervise(i: number): Promise<void> {
  while (!stopping) {
    // In dev Vite serves the client; Wrangler only needs the directory to exist.
    mkdirSync("dist", { recursive: true })
    const started = Date.now()
    const proc = Bun.spawn(commands[i]!, { stdio: ["inherit", "inherit", "inherit"] })
    procs[i] = proc
    const code = await proc.exited
    if (stopping) return
    console.error(`[dev] ${commands[i]![1]} exited (${code}), restarting`)
    if (Date.now() - started < 3000) await Bun.sleep(2000)
  }
}

function stop(): void {
  if (stopping) return
  stopping = true
  for (const p of procs) p?.kill()
  process.exit(0)
}

process.on("SIGINT", stop)
process.on("SIGTERM", stop)
process.on("exit", () => {
  for (const p of procs) p?.kill()
})
await Promise.all(commands.map((_, i) => supervise(i)))
