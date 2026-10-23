// Real Chromium lifecycle proof; no game, server, GPU or audio required.
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"

const modes = process.argv.slice(2)
for (const mode of modes.length ? modes : ["success", "throw", "persistent", "hang-page", "hang-work", "blocked-host", "phases"]) {
  const started = performance.now()
  const child = spawn(process.execPath, ["scripts/browser-budget-fixture.ts", mode], {
    env: { ...process.env, ARCADE_BROWSER_BUDGET_S: mode === "phases" ? "10" : mode.startsWith("hang") || mode === "blocked-host" ? "3" : "30" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  child.stdout.on("data", data => { output += data })
  child.stderr.on("data", data => { output += data })
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code, signal) => resolve([code, signal]))
  })
  const seconds = (performance.now() - started) / 1000
  if (mode === "blocked-host") assert.equal(signal, "SIGKILL", output)
  else {
    assert.equal(code, mode.startsWith("hang") ? 124 : mode === "throw" ? 1 : 0, output)
    assert.match(output, /BROWSER_CLOSED/, output)
  }
  const pids: number[] = JSON.parse(output.match(/BROWSER_PIDS (\[.*\])/)?.[1] ?? "[]")
  assert(pids.length > 0, output)
  for (const pid of pids) {
    let alive = false
    try { process.kill(pid, 0); alive = true } catch {}
    // A killed orphan may remain in the process table briefly until init reaps it.
    if (alive) assert.match(execFileSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" }), /^Z/, `Chromium process ${pid} survived ${mode}`)
  }
  if (mode.startsWith("hang")) assert(seconds >= 3 && seconds < 7, output)
  if (mode === "blocked-host") assert(seconds >= 6 && seconds < 10, output)
  if (mode === "phases") assert.match(output, /NON_BROWSER_PHASES_FINISHED/, output)
  console.log(`${mode}: exit=${signal ?? code}, ${seconds.toFixed(3)}s, ${pids.length} Chromium processes stopped`)
}
