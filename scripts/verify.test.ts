import { afterEach, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gitChangedFiles } from "./verify-scope"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "verify-test-"))
  roots.push(root)
  for (const file of ["verify.ts", "verify-scope.ts", "verify-remote.ts"]) {
    await Bun.write(join(root, "scripts", file), Bun.file(join(import.meta.dir, file)))
  }
  for (const game of ["lot", "brawl"]) {
    await Bun.write(join(root, ".github/workflows", `${game}.yml`), `on:\n  pull_request:\n    paths: ["games/${game}/**"]\n`)
    await Bun.write(join(root, "games", game, "package.json"), JSON.stringify({ scripts: { check: "tsc --noEmit && bun test && vite build" } }))
  }
  return root
}

function run(root: string, args: string[], env: Record<string, string | undefined> = {}) {
  const result = Bun.spawnSync(["bun", "scripts/verify.ts", "--list", ...args], {
    cwd: root,
    env: { ...process.env, ARCADE_VERIFY_CHANGED_FILE: undefined, ARCADE_VERIFY_JOBS: undefined,
      ARCADE_VERIFY_TEST_WORKERS: undefined, HIVEMIND_CPUS: undefined,
      HIVEMIND_JOBS: undefined, HIVEMIND_TEST_WORKERS: undefined, ...env },
    stdout: "pipe", stderr: "pipe",
  })
  return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() }
}

test("git-less workers require scope; explicit all and an empty snapshot are distinct", async () => {
  const root = await fixture()
  expect(run(root, []).code).toBe(1)
  expect(run(root, []).output).toContain("--changed")
  expect(run(root, ["--all"]).output).toContain("brawl:tsc")
  const file = join(root, "changed.txt")
  await Bun.write(file, "")
  const empty = run(root, [], { ARCADE_VERIFY_CHANGED_FILE: file })
  expect(empty.code).toBe(0)
  expect(empty.output).toContain("nothing to check")
  expect(empty.output).not.toContain("brawl:tsc")
})

test("changed file flag overrides env and worker budgets are explicit and bounded", async () => {
  const root = await fixture()
  await Bun.write(join(root, "lot.txt"), "games/lot/src/main.ts\n")
  await Bun.write(join(root, "brawl.txt"), "games/brawl/src/main.ts\n")
  const defaults = run(root, ["--changed", "lot.txt"], { ARCADE_VERIFY_CHANGED_FILE: join(root, "brawl.txt") })
  expect(defaults.code).toBe(0)
  expect(defaults.output).toContain("lot:tsc")
  expect(defaults.output).not.toContain("brawl:tsc")
  expect(defaults.output).toContain("jobs=2, test-workers=2")
  const limited = run(root, ["--all", "--jobs", "4", "--test-workers", "3"], {
    ARCADE_VERIFY_JOBS: "5", ARCADE_VERIFY_TEST_WORKERS: "5", HIVEMIND_CPUS: "2",
  })
  expect(limited.output).toContain("jobs=2, test-workers=2")
  expect(limited.output).toContain("--parallel=2")
  const flags = run(root, ["--all", "--jobs", "3", "--test-workers", "1"], { ARCADE_VERIFY_JOBS: "5" })
  expect(flags.output).toContain("jobs=3, test-workers=1")
  expect(run(root, ["--all"], { ARCADE_VERIFY_JOBS: "0" }).code).toBe(1)
  expect(run(root, ["--all", "--test-workers", "NaN"]).code).toBe(1)
  expect(run(root, ["--all", "--jobs"]).code).toBe(1)
})

test("submitter scope includes both sides of renames plus staged, dirty and untracked files", async () => {
  const root = await fixture()
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  }
  git("init", "-q")
  git("config", "user.email", "test@example.com")
  git("config", "user.name", "Verify test")
  for (const file of ["old.ts", "dirty.ts", "staged.ts"]) await Bun.write(join(root, file), "original\n")
  git("add", ".")
  git("commit", "-qm", "base")
  git("branch", "base")
  git("mv", "old.ts", "renamed.ts")
  git("commit", "-qm", "rename")
  await Bun.write(join(root, "dirty.ts"), "dirty\n")
  await Bun.write(join(root, "staged.ts"), "staged\n")
  git("add", "staged.ts")
  await Bun.write(join(root, "untracked space.ts"), "untracked\n")
  expect((await gitChangedFiles(root, "base")).sort()).toEqual(["dirty.ts", "old.ts", "renamed.ts", "staged.ts", "untracked space.ts"])
})

test("HiveMind budgets are fallbacks and fractional CPU allocations round down with a floor of one", async () => {
  const root = await fixture()
  const env = { HIVEMIND_JOBS: "4", HIVEMIND_TEST_WORKERS: "3", HIVEMIND_CPUS: "3.9" }
  expect(run(root, ["--all"], env).output).toContain("jobs=3, test-workers=3")
  expect(run(root, ["--all"], { ...env, ARCADE_VERIFY_JOBS: "2", ARCADE_VERIFY_TEST_WORKERS: "1" }).output)
    .toContain("jobs=2, test-workers=1")
  for (const cpu of ["0.5", "0", "-0.5"]) {
    const result = run(root, ["--all"], { ...env, HIVEMIND_CPUS: cpu })
    expect(result.code).toBe(0)
    expect(result.output).toContain("jobs=1, test-workers=1")
  }
})

test("remote wrapper delivers a submitter-local snapshot to a git-less worker", async () => {
  const submitter = await fixture()
  const worker = await fixture()
  const changed = join(submitter, "only-on-submitter.txt")
  await Bun.write(changed, "games/lot/src/main.ts\n")
  const hive = join(submitter, "bin/hivemind")
  await Bun.write(hive, '#!/bin/bash\nwhile [[ "$1" != "--" ]]; do shift; done\nshift\ncd "$VERIFY_WORKER"\nexec "$@"\n')
  chmodSync(hive, 0o755)
  const result = Bun.spawnSync(["bun", "scripts/verify-remote.ts", "--", "--changed", changed, "--list"], {
    cwd: submitter,
    env: { ...process.env, PATH: `${join(submitter, "bin")}:${process.env.PATH}`, VERIFY_WORKER: worker,
      ARCADE_VERIFY_JOBS: "1", ARCADE_VERIFY_TEST_WORKERS: "1", HIVEMIND_CPUS: "2" },
    stdout: "pipe", stderr: "pipe",
  })
  const output = result.stdout.toString() + result.stderr.toString()
  if (result.exitCode !== 0) throw new Error(output)
  expect(result.exitCode).toBe(0)
  expect(output).toContain("lot:tsc")
  expect(output).not.toContain("brawl:tsc")
  expect(output).toContain("jobs=1, test-workers=1")
})
