// Separate thread: a synchronous host loop/build must not postpone the wall-clock deadline.
import { workerData } from "node:worker_threads"
import { execFileSync } from "node:child_process"

const { pid, milliseconds } = workerData
setTimeout(() => {
  process.kill(pid, "SIGUSR2")
  setTimeout(() => {
    // The host could not run its signal handler or finish graceful shutdown. Only kill its own
    // descendant processes (Chromium uses detached groups), then the blocked host itself.
    const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" })
      .trim().split("\n").map(row => row.trim().split(/\s+/).map(Number))
    const owned = new Set([pid])
    for (let size = 0; size !== owned.size;) {
      size = owned.size
      for (const [child, parent] of rows) if (owned.has(parent)) owned.add(child)
    }
    console.error("[browser-budget] host unresponsive; killing owned Chromium/child processes")
    for (const child of [...owned].reverse()) {
      if (child === pid) continue
      try { process.kill(child, "SIGKILL") } catch {}
    }
    process.kill(pid, "SIGKILL")
  }, 3_000)
}, milliseconds)
