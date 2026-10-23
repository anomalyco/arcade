import { resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
for (const args of [
  ["test", "--max-concurrency", "4", "packages/kit/rollback.test.ts", "packages/kit/link-sim.test.ts"],
  ["scripts/kit-audio-soak.ts"],
]) {
  const child = Bun.spawn(["bun", ...args], {
    cwd: root,
    env: { ...process.env, ARCADE_TEST_SOAK: "1" },
    stdout: "inherit",
    stderr: "inherit",
  })
  const code = await child.exited
  if (code) process.exit(code)
}
