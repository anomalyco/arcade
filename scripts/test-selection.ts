import { $ } from "bun"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Inputs Bun's static import graph cannot safely follow. Keep these explicit.
// Workspace packages are deliberate: 1.4.2 and 1.4.4 skip @arcade/* source imports.
export const FULL_TEST_INPUTS = [
  "**/package.json", "**/bun.lock", "**/bun.lockb", "**/bunfig.toml", "**/tsconfig*",
  "**/*config.*", "**/*setup*", "**/*preload*", ".github/**",
  "scripts/**", "**/scripts/**", "packages/**",
  "**/public/**", "**/assets/**", "**/art/**", "**/fixtures/**", "**/__snapshots__/**",
  "**/*.json", "**/*.wgsl", "**/*.glsl", "**/*.txt", "perf/**",
  // Lab discovers stations with readdir + dynamic import, outside Bun's graph.
  "games/lab/src/stations/**",
]

export function fullTestReason(files: string[]): string | undefined {
  for (const file of files) {
    const pattern = FULL_TEST_INPUTS.find(pattern => new Bun.Glob(pattern).match(file))
    if (pattern) return `${file} (${pattern})`
    // Only source and ordinary documentation are eligible for graph selection.
    if (!/\.(?:[cm]?[jt]sx?|md)$/.test(file)) return `${file} (non-source input)`
  }
}

/** Supply the submitter's changed paths to Bun on a git-less worker without touching its checkout.
 * A private Git index records only these paths as deletions against an empty-blob base tree.
 * Bun still builds and walks the real import graph; no source is copied or modified.
 */
export async function changedSnapshot(repo: string, files: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "arcade-test-diff-"))
  const env = { ...process.env, GIT_DIR: dir, GIT_WORK_TREE: repo, GIT_INDEX_FILE: join(dir, "index") }
  const git = (...args: string[]) => $`git ${args}`.cwd(repo).env(env).quiet().text()
  try {
    await git("init", "--bare", "--quiet", dir)
    await git("config", "core.bare", "false")
    await Bun.write(join(dir, "info/exclude"), "*\n")
    const blob = (await $`git hash-object -w --stdin`.cwd(repo).env(env).stdin("").quiet().text()).trim()
    for (const file of files) {
      if (!file || file.startsWith("/") || file.split("/").includes("..") || /[\r\n\0]/.test(file)) throw new Error(`Invalid changed path: ${file}`)
    }
    await $`git update-index -z --index-info`.cwd(repo).env(env)
      .stdin(files.map(file => `100644 ${blob}\t${file}\0`).join("")).quiet()
    const tree = (await git("write-tree")).trim()
    // --changed accepts a tree, so no commit, author identity or signing is needed.
    await git("read-tree", "--empty")
    return { base: tree, env, [Symbol.dispose]() { rmSync(dir, { recursive: true, force: true }) } }
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
}
