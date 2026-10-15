// Copies knobs' source from Kit's knobs repo into packages/knobs/src. Run from anywhere:
//   bun packages/knobs/scripts/sync.ts [--from ~/code/open-source/knobs] [--ref HEAD]
// It copies a committed tree (HEAD by default), so work in progress in the knobs checkout stays there. The React and
// Solid adapters (knobs/ui's wrappers too), tests and examples stay behind. The source is copied as is.
import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }
const from = resolve((arg("--from") ?? join(homedir(), "code/open-source/knobs")).replace(/^~/, homedir()))
const pkg = resolve(import.meta.dir, "..")
const src = join(pkg, "src")
const ref = arg("--ref") ?? "HEAD"
if (!existsSync(join(from, "src/core/store.ts"))) throw new Error(`No knobs checkout at ${from}`)
const git = (...args: string[]) => execFileSync("git", ["-C", from, ...args], { encoding: "utf8" }).trim()

const tree = mkdtempSync(join(tmpdir(), "knobs-"))
execFileSync("sh", ["-c", `git -C "${from}" archive "${ref}" src | tar -x -C "${tree}"`])
rmSync(src, { recursive: true, force: true })
mkdirSync(src, { recursive: true })
for (const part of ["core", "panel", "themes", "ui", "index.ts"]) cpSync(join(tree, "src", part), join(src, part), { recursive: true })
// knobs/ui's React and Solid wrappers stay behind with the other adapters.
for (const adapter of ["ui/react.tsx", "ui/solid.ts"]) rmSync(join(src, adapter), { force: true })
rmSync(tree, { recursive: true, force: true })

const version = JSON.parse(git("show", `${ref}:package.json`)).version as string
const commit = git("rev-parse", ref)
writeFileSync(join(pkg, "VENDORED.json"), `${JSON.stringify({ source: "github.com/kitlangton/knobs", version, commit, committed: git("log", "-1", "--format=%cI", commit) }, null, 2)}\n`)
console.log(`Synced knobs ${version} @ ${commit.slice(0, 7)} into ${src}`)
