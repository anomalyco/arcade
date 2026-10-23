// bun run verify:remote [hivemind options] -- [verify options]
// Snapshot scope before HiveMind sync; only the worker runs checks.
import { resolve } from "node:path"
import { gitChangedFiles } from "./verify-scope"

const repo = resolve(import.meta.dir, "..")
const args = process.argv.slice(2)
const separator = args.indexOf("--")
// Bun consumes a leading `--`, so without a separator these are verify options.
const hiveArgs = separator < 0 ? [] : args.slice(0, separator)
const verifyArgs = separator < 0 ? args : args.slice(separator + 1)
const option = (name: string, fallback?: string) => {
  const at = verifyArgs.indexOf(name)
  if (at < 0) return fallback
  const value = verifyArgs[at + 1]
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`)
  return value
}
const changedFile = option("--changed", process.env.ARCADE_VERIFY_CHANGED_FILE)
const paths = changedFile !== undefined
  ? await Bun.file(resolve(changedFile)).text()
  : (verifyArgs.includes("--all") || verifyArgs.includes("--smoke")) && !verifyArgs.includes("--release")
    ? undefined
    : (await gitChangedFiles(repo, option("--base", "origin/main")!)).join("\n")
// --changed is replaced by the worker-local snapshot, never a submitter's absolute path.
const at = verifyArgs.indexOf("--changed")
if (at >= 0) verifyArgs.splice(at, 2)
const env = Object.fromEntries(["ARCADE_VERIFY_JOBS", "ARCADE_VERIFY_TEST_WORKERS"]
  .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]!]))
const payload = JSON.stringify({ paths, args: verifyArgs, env })
// Send the list as job data, rather than relying on rsync to include an ignored temp file.
// A fresh worker-local file avoids stale scope and concurrent submissions overwriting each other.
const bootstrap = `
  const { mkdtempSync, rmSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const input = JSON.parse(process.argv[1]);
  const dir = mkdtempSync(join(tmpdir(), "arcade-verify-scope-"));
  try {
    const env = { ...process.env, ...input.env };
    delete env.ARCADE_VERIFY_CHANGED_FILE;
    if (input.paths !== undefined) {
      env.ARCADE_VERIFY_CHANGED_FILE = join(dir, "changed.txt");
      await Bun.write(env.ARCADE_VERIFY_CHANGED_FILE, input.paths);
    }
    const child = Bun.spawnSync(["bun", "scripts/verify.ts", ...input.args],
      { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    process.exitCode = child.exitCode;
  } finally { rmSync(dir, { recursive: true, force: true }); }
`
const kind = hiveArgs.some((arg) => arg === "--kind" || arg.startsWith("--kind="))
  ? [] : ["--kind", verifyArgs.includes("--release") || verifyArgs.includes("--smoke") ? "browser" : "cargo"]
const child = Bun.spawn(["hivemind", "run", ...kind, ...hiveArgs, "--", "bun", "-e", bootstrap, payload], {
  cwd: repo, stdin: "inherit", stdout: "inherit", stderr: "inherit",
})
process.exit(await child.exited)
