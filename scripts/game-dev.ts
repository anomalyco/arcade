// Runs a game's Worker (rooms) and Vite client together. Vite proxies /ws and /api to the Worker.
import { mkdirSync } from "node:fs"
import type { Subprocess } from "bun"
import { writeBuildId } from "./build-id"

export type GameDevOptions = {
  root: string
  workerPort: number
  clientPort: number
  buildId?: boolean
  restartOnExit?: boolean
}

export async function runGameDev(opts: GameDevOptions): Promise<void> {
  if (opts.buildId) writeBuildId(opts.root)
  const commands = [
    ["bunx", "wrangler", "dev", "--port", String(opts.workerPort)],
    ["bunx", "vite", "--host", "0.0.0.0", "--port", String(opts.clientPort), "--strictPort"],
  ]
  const procs: Subprocess[] = []
  let stopping = false

  function stop(code = 0): void {
    if (stopping) return
    stopping = true
    for (const p of procs) p?.kill()
    process.exit(code)
  }

  process.on("SIGINT", () => stop(0))
  process.on("SIGTERM", () => stop(0))
  process.on("exit", () => {
    for (const p of procs) p?.kill()
  })

  if (opts.restartOnExit) {
    const supervise = async (i: number): Promise<void> => {
      while (!stopping) {
        mkdirSync("dist", { recursive: true })
        const started = Date.now()
        const proc = Bun.spawn(commands[i]!, { cwd: opts.root, stdio: ["inherit", "inherit", "inherit"] })
        procs[i] = proc
        const code = await proc.exited
        if (stopping) return
        console.error(`[dev] ${commands[i]![1]} exited (${code}), restarting`)
        if (Date.now() - started < 3000) await Bun.sleep(2000)
      }
    }
    await Promise.all(commands.map((_, i) => supervise(i)))
    return
  }

  for (let i = 0; i < commands.length; i++) {
    procs[i] = Bun.spawn(commands[i]!, { cwd: opts.root, stdio: ["inherit", "inherit", "inherit"] })
  }
  await Promise.race(procs.map((p) => p.exited.then((code) => code)))
  stop(1)
}
