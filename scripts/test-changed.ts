// Test-only adapter shared by per-edit verify and CI. Release/nightly use bun test directly.
import { resolve } from "node:path"
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
const reason = files ? fullTestReason(files) : "no usable diff base"
if (reason) console.log(`tests: full (${reason})`)
else console.log(`tests: changed (${files!.length} paths vs ${base})`)
// A supplied list is authoritative, including when HiveMind happens to run locally.
using snapshot = !reason && list ? await changedSnapshot(repo, files!) : undefined
const child = Bun.spawn([process.execPath, "test", ...(!reason ? [`--changed=${snapshot?.base ?? base}`] : []), ...process.argv.slice(2)], {
  cwd: process.cwd(), env: snapshot?.env ?? process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit",
})
process.exitCode = await child.exited
