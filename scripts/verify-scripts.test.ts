import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")

async function plan(changed: string, release = false) {
  const dir = mkdtempSync(join(tmpdir(), "arcade-verify-scripts-"))
  try {
    const file = join(dir, "changed.txt")
    writeFileSync(file, `${changed}\n`)
    const child = Bun.spawn([
      process.execPath, "scripts/verify.ts", "--list", "--changed", file,
      ...(release ? ["--release"] : []),
    ], { cwd: root, stdout: "pipe", stderr: "pipe" })
    const [output, errors, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    expect({ code, errors }).toEqual({ code: 0, errors: "" })
    return output.split("\n").filter(line => line.startsWith("scripts:"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

for (const changed of [
  "scripts/motion-check.ts",
  "games/getaway/shared/config.ts",
  "packages/kit/motion-check.ts",
  ".github/workflows/scripts.yml",
]) test(`root script checks follow workflow paths: ${changed}`, async () => {
  const steps = await plan(changed)
  expect(steps).toHaveLength(4)
  expect(steps[0]).toContain("bun games/blackout/scripts/build-id.ts")
  expect(steps[1]).toContain("bun games/outbreak/scripts/build-id.ts")
  const check = steps.find(line => line.includes("bun scripts/typecheck.ts -p scripts/tsconfig.json"))!
  expect(check).not.toContain("--incremental")
  expect(check).toContain("(after scripts:build-id, scripts:build-id-1)")
  const testStep = steps.find(line => line.startsWith("scripts:test"))!
  expect(testStep).toContain("--max-concurrency 4 scripts/verify-scripts.test.ts")
})

test("docs-only changes do not select root script checks", async () => {
  expect(await plan("docs/animation.md")).toEqual([])
})

test("release plans include root script checks even for docs-only changes", async () => {
  const steps = await plan("docs/animation.md", true)
  expect(steps).toHaveLength(4)
  expect(steps.some(line => line.includes("bun scripts/typecheck.ts -p scripts/tsconfig.json"))).toBe(true)
  expect(steps.join("\n")).not.toContain("--incremental")
})
