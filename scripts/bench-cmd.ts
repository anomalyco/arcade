// Tiny hyperfine substitute: bun scripts/bench-cmd.ts [--runs N] [--cwd DIR] -- "<cmd>" ["<cmd>" ...]
// Prints median/min/max wall time per command after one warmup run; fails loudly if a command fails.
const argv = process.argv.slice(2)
const sep = argv.indexOf("--")
const opts = argv.slice(0, sep < 0 ? 0 : sep)
const cmds = argv.slice(sep + 1)
const runs = Number(opts[opts.indexOf("--runs") + 1] || 5) || 5
const cwd = opts.includes("--cwd") ? opts[opts.indexOf("--cwd") + 1] : process.cwd()
for (const cmd of cmds) {
  const times: number[] = []
  for (let i = 0; i <= runs; i++) {
    const t = performance.now()
    const r = Bun.spawnSync(["bash", "-c", cmd], { cwd, stdout: "ignore", stderr: "pipe" })
    if (r.exitCode !== 0) throw new Error(`${cmd} failed (${r.exitCode}): ${r.stderr.toString().slice(-2000)}`)
    if (i > 0) times.push(performance.now() - t)
  }
  times.sort((a, b) => a - b)
  console.log(`METRIC ${(times[times.length >> 1]! / 1000).toFixed(2)}s min=${(times[0]! / 1000).toFixed(2)} max=${(times.at(-1)! / 1000).toFixed(2)} n=${runs}  ${cmd}`)
}
