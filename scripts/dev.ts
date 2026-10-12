// Runs the Worker (rooms) and the Vite client together. Vite proxies /ws and /api to the Worker.
const procs = [
  Bun.spawn(["bunx", "wrangler", "dev", "--port", "8788"], { stdio: ["inherit", "inherit", "inherit"] }),
  Bun.spawn(["bunx", "vite", "--host", "0.0.0.0", "--port", "5191", "--strictPort"], { stdio: ["inherit", "inherit", "inherit"] }),
]

let stopping = false
function stop(code = 0) {
  if (stopping) return
  stopping = true
  for (const p of procs) p.kill()
  process.exit(code)
}

process.on("SIGINT", () => stop(0))
process.on("SIGTERM", () => stop(0))
process.on("exit", () => {
  for (const p of procs) p.kill()
})
await Promise.race(procs.map((p) => p.exited.then((code) => code)))
stop(1)
