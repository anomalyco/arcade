// Test-only adapter shared by per-edit verify and CI. Release/nightly use bun test directly.
import { relative, resolve } from "node:path"
import { gitChangedFiles, hasGit } from "./verify-scope"
import { changedSnapshot, fullTestReason } from "./test-selection"

const repo = resolve(import.meta.dir, "..")
let base = process.env.ARCADE_TEST_BASE ?? "origin/main"
if (process.env.GITHUB_EVENT_PATH && !process.env.ARCADE_TEST_BASE) {
  const event = await Bun.file(process.env.GITHUB_EVENT_PATH).json()
  base = event.pull_request?.base?.sha ?? event.before ?? ""
}
const list = process.env.ARCADE_VERIFY_CHANGED_FILE
const git = await hasGit(repo)
const files = list ? (await Bun.file(list).text()).split(/\r?\n/).filter(Boolean)
  : git && base && !/^0+$/.test(base) ? await gitChangedFiles(repo, base) : undefined
const args = process.argv.slice(2)
// Kit's architecture inventory reads game source as text. Getaway/Blackout include kit in their
// test command even when the packages target is absent, so retain that full-suite coverage too.
const includesKit = relative(repo, process.cwd()) === "packages/kit"
  || args.some(arg => relative(repo, resolve(arg)) === "packages/kit")
const reason = files ? fullTestReason(files, repo) ?? (includesKit ? "kit suite reads the runtime architecture inventory" : undefined) : "no usable diff base"
if (reason) console.log(`tests: full (${reason})`)
else console.log(`tests: changed (${files!.length} paths vs ${base})`)
// A supplied list is authoritative, including when HiveMind happens to run locally.
using snapshot = !reason && list ? await changedSnapshot(repo, files!) : undefined
const child = Bun.spawn([process.execPath, "test", ...(!reason ? [`--changed=${snapshot?.base ?? base}`] : []), ...args], {
  cwd: process.cwd(), env: snapshot?.env ?? process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit",
})
process.exitCode = await child.exited
