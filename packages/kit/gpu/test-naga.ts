import { expect } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

const naga = [process.env.NAGA, Bun.which("naga"), join(homedir(), ".cargo/bin/naga"), join(homedir(), ".cache/naga-cli/bin/naga")].find(
  (p): p is string => !!p && existsSync(p),
)

/** Test-only validator; callers keep their named shader cases. */
export function validateWgsl(code: string): void {
  if (!naga) {
    console.log("naga not found, skipping WGSL validation (cargo install naga-cli)")
    return
  }
  const dir = mkdtempSync(join(tmpdir(), "kit-wgsl-"))
  try {
    const file = join(dir, "shader.wgsl")
    writeFileSync(file, code)
    const run = Bun.spawnSync([naga, file])
    if (run.exitCode !== 0) console.log(run.stderr.toString() + run.stdout.toString())
    expect(run.exitCode).toBe(0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
