import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { changedSnapshot, fullTestReason } from "./test-selection"
import { workspacePackages } from "./check-changed"

test("package checks discover newly added matching workspaces", async () => {
  const root = mkdtempSync(join(tmpdir(), "arcade-workspace-checks-"))
  try {
    await Bun.write(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*", "games/*"] }))
    await Bun.write(join(root, "packages/kit/package.json"), JSON.stringify({ name: "@arcade/kit" }))
    await Bun.write(join(root, "games/demo/package.json"), JSON.stringify({ name: "demo" }))
    await Bun.write(join(root, "standalone/package.json"), JSON.stringify({ name: "@arcade/standalone" }))
    expect(await workspacePackages(root)).toEqual([join(root, "packages/kit")])
    await Bun.write(join(root, "packages/new/package.json"), JSON.stringify({ name: "@arcade/new" }))
    expect(await workspacePackages(root)).toEqual([join(root, "packages/kit"), join(root, "packages/new")])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("outside-graph inputs force full tests", () => {
  for (const file of ["package.json", "bun.lock", "bunfig.toml", "games/lot/tsconfig.json",
    "games/lot/vite.config.ts", "games/lot/tests/setup.ts", "games/lot/tests/preload.ts",
    "games/lot/public/paint.js", "games/lot/tests/fixtures/a.ts", "games/lot/a.json",
    "games/lot/shader.wgsl", "scripts/verify.ts", "games/lot/scripts/build-id.ts",
    "packages/kit/sim/move.ts", "packages/knobs/src/index.ts", "games/lab/src/stations/new.ts", "games/lab/src/styles.ts",
    "games/carrier/art/plane.glb", "unknown.bin"]) expect(fullTestReason([file])).toBeDefined()
  expect(fullTestReason(["games/carrier/shared/gunnery.ts", "games/carrier/tests/gunnery.test.ts", "docs/animation.md"])).toBeUndefined()
})

test("git-less snapshot selects transitive imports and new tests from a game cwd", async () => {
  const root = mkdtempSync(join(tmpdir(), "arcade-selection-test-"))
  const cwd = join(root, "games/demo")
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, "value.ts"), "export const value = 2")
  writeFileSync(join(cwd, "bridge.ts"), 'export { value } from "./value"')
  writeFileSync(join(cwd, "dependent.test.ts"), 'import {test,expect} from "bun:test"; import {value} from "./bridge"; test("dependent",()=>expect(value).toBe(1))')
  writeFileSync(join(cwd, "other.test.ts"), 'import {test} from "bun:test"; test("unrelated",()=>{throw Error("must not run")})')
  writeFileSync(join(cwd, "new.test.ts"), 'import {test} from "bun:test"; test("new",()=>{})')
  try {
    for (const paths of [["games/demo/value.ts", "games/demo/new.test.ts"], []]) {
      using snapshot = await changedSnapshot(root, paths)
      const child = Bun.spawn([process.execPath, "test", `--changed=${snapshot.base}`], {
        cwd, env: snapshot.env, stdout: "pipe", stderr: "pipe",
      })
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      expect(code).toBe(paths.length ? 1 : 0)
      expect(out + err).not.toContain("must not run")
      if (paths.length) {
        expect(out + err).toContain("(fail) dependent")
        expect(out + err).toContain("Ran 2 tests across 2 files")
      } else expect(out + err).toContain("no changed files")
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("the runner honors a worker snapshot and falls back on runtime assets and deletions", async () => {
  const root = mkdtempSync(join(tmpdir(), "arcade-selection-runner-"))
  const cwd = join(root, "games/demo")
  mkdirSync(cwd, { recursive: true })
  try {
    for (const name of ["test-changed.ts", "test-selection.ts", "verify-scope.ts"]) {
      await Bun.write(join(root, "scripts", name), Bun.file(join(import.meta.dir, name)))
    }
    await Bun.write(join(cwd, "value.ts"), "export const value = 1")
    await Bun.write(join(cwd, "value.test.ts"), 'import {test,expect} from "bun:test"; import {value} from "./value"; test("value",()=>expect(value).toBe(1))')
    await Bun.write(join(cwd, "unrelated.test.ts"), 'import {test} from "bun:test"; test("unrelated",()=>{throw Error("full-suite sentinel")})')
    await Bun.write(join(cwd, "public/data.json"), "{}")
    const list = join(root, "changed.txt")
    for (const [path, full] of [["games/demo/value.ts", false], ["games/demo/public/data.json", true], ["games/demo/removed.ts", true]] as const) {
      await Bun.write(list, path)
      const child = Bun.spawn([process.execPath, join(root, "scripts/test-changed.ts")], {
        cwd, env: { ...process.env, ARCADE_VERIFY_CHANGED_FILE: list }, stdout: "pipe", stderr: "pipe",
      })
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      expect(code).toBe(full ? 1 : 0)
      expect(out).toContain(full ? "tests: full" : "tests: changed")
      expect((out + err).includes("full-suite sentinel")).toBe(full)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
