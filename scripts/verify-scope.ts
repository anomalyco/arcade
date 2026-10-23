import { $ } from "bun"
import { realpathSync } from "node:fs"

/** A synced worktree's .git file may point to an unavailable checkout. */
export async function hasGit(repo: string): Promise<boolean> {
  const top = await $`git rev-parse --show-toplevel`.cwd(repo).quiet().nothrow()
  return top.exitCode === 0 && realpathSync(top.stdout.toString().trim()) === realpathSync(repo)
}

/** Includes committed, staged, unstaged, deleted and untracked paths. */
export async function gitChangedFiles(repo: string, base: string): Promise<string[]> {
  const mergeBase = (await $`git merge-base HEAD ${base}`.cwd(repo).quiet().nothrow()).stdout.toString().trim()
  if (!mergeBase) throw new Error(`No merge-base with ${base}; fetch it or pass --base <ref>`)
  const lists = await Promise.all([
    $`git diff --name-only --no-renames -z ${mergeBase}`.cwd(repo).quiet().text(),
    $`git ls-files --others --exclude-standard -z`.cwd(repo).quiet().text(),
  ])
  const files = [...new Set(lists.join("\0").split("\0").filter(Boolean))]
  if (files.some((file) => /[\r\n]/.test(file))) throw new Error("Changed paths cannot contain newlines")
  return files
}
