// One-command verification.
//
//   bun run verify              affected checks only, in parallel, with incremental typecheck caches
//   bun run verify --all        every workspace target, same fast path
//   bun run verify:release      clean `git archive` export of HEAD, frozen install, then every workspace target's
//                               check commands with cold caches, smoke and `wrangler deploy --dry-run`
//
// Options: --base <ref> (default origin/main), --no-smoke, --jobs <n>, --list (print the plan only).
//
// "Affected" comes from the CI workflows themselves: a target runs when a changed file (committed since the
// merge-base with --base, staged, unstaged or untracked) matches its workflow's pull_request paths. So packages/**
// and root changes check everything, a games/outbreak change checks Outbreak and the Lab, and docs check nothing.
//
// Both modes split each target's `check` script into its commands and run them in parallel. Test suites run one at
// a time with half the cores and a 20 s per-test timeout, so a loaded Studio doesn't fail them. The fast path adds `tsc --incremental` build info under
// node_modules/.cache/arcade-verify and runs packages/kit's suite once instead of also inside Getaway and Blackout.
// Smoke uses Metal on macOS and SwiftShader elsewhere (scripts/smoke.mjs).
import { $ } from "bun"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { availableParallelism, tmpdir } from "node:os"
import { basename, join, relative, resolve } from "node:path"

const argv = process.argv.slice(2)
const flag = (name: string) => argv.includes(name)
const option = (name: string, fallback: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1]! : fallback)
const release = flag("--release")
const all = flag("--all") || release
const smoke = !flag("--no-smoke")
const base = option("--base", "origin/main")
const jobs = Number(option("--jobs", String(Math.max(3, Math.floor(availableParallelism() / 2)))))
const repo = resolve(import.meta.dir, "..")
const testWorkers = Math.max(2, Math.floor(availableParallelism() / 2))

const WORKSPACE_GAMES = ["getaway", "blackout", "outbreak", "carrier", "lab"]
const INDEPENDENT: Record<string, string> = { landing: "landing", redirects: "redirects", wings: "games/wings" }

type Target = { name: string; dirs: string[]; game?: string; independent?: boolean }

async function workflowTargets(): Promise<{ target: Target; paths: string[] }[]> {
  const out: { target: Target; paths: string[] }[] = []
  for (const name of [...WORKSPACE_GAMES, "packages", ...Object.keys(INDEPENDENT)]) {
    const file = join(repo, ".github/workflows", `${name}.yml`)
    if (!existsSync(file)) continue
    const yaml = Bun.YAML.parse(await Bun.file(file).text()) as any
    const paths: string[] = yaml?.on?.pull_request?.paths ?? []
    const target: Target =
      name === "packages"
        ? { name, dirs: ["packages/kit", "packages/knobs"] }
        : WORKSPACE_GAMES.includes(name)
          ? { name, dirs: [`games/${name}`], game: name }
          : { name, dirs: [INDEPENDENT[name]!], independent: true }
    out.push({ target, paths })
  }
  return out
}

async function changedFiles(): Promise<string[]> {
  const mergeBase = (await $`git merge-base HEAD ${base}`.cwd(repo).quiet().nothrow()).stdout.toString().trim()
  if (!mergeBase) throw new Error(`No merge-base with ${base}; fetch it or pass --base <ref>`)
  const lists = await Promise.all([
    $`git diff --name-only ${mergeBase}`.cwd(repo).quiet().text(),
    $`git ls-files --others --exclude-standard`.cwd(repo).quiet().text(),
  ])
  return [...new Set(lists.join("\n").split("\n").filter(Boolean))]
}

// ---- Steps ---------------------------------------------------------------------------------------------------

type Step = { id: string; cwd: string; cmd: string; deps: string[]; kind: string }

/** Expands a package's `check` script into its `&&`-separated commands, inlining `bun run <script>`. */
function expand(scripts: Record<string, string>, script: string): string[] {
  return scripts[script]!.split("&&").flatMap((part) => {
    const cmd = part.trim()
    const run = cmd.match(/^bun run ([\w:-]+)$/)
    return run && scripts[run[1]!] ? expand(scripts, run[1]!) : [cmd]
  })
}

const cacheDir = join(repo, "node_modules/.cache/arcade-verify")

function targetSteps(target: Target, root: string, { incremental, dedupeKit }: { incremental: boolean; dedupeKit: boolean }): Step[] {
  const steps: Step[] = []
  for (const dir of target.dirs) {
    const cwd = join(root, dir)
    const scripts = require(join(cwd, "package.json")).scripts as Record<string, string>
    const cmds = [...new Set(expand(scripts, "check"))]
    const prep: string[] = []
    const tag = (s: string) => `${target.name}${target.dirs.length > 1 ? `/${basename(dir)}` : ""}:${s}`
    if (target.independent && !existsSync(join(cwd, "node_modules"))) {
      steps.push({ id: tag("install"), cwd, cmd: "bun install --frozen-lockfile", deps: [], kind: "install" })
      prep.push(tag("install"))
    }
    for (const cmd of cmds.filter((c) => c.startsWith("bun scripts/build-id.ts"))) {
      steps.push({ id: tag("build-id"), cwd, cmd, deps: [...prep], kind: "prep" })
      prep.push(tag("build-id"))
    }
    let build: string | undefined
    for (const raw of cmds) {
      if (raw.startsWith("bun scripts/build-id.ts")) continue
      let cmd = raw.replace(/^bun scripts\/build-id\.ts && /, "")
      let kind = "other"
      if (/^tsc\b/.test(cmd)) {
        kind = "typecheck"
        if (incremental) {
          const project = cmd.match(/-p\s+(\S+)/)?.[1] ?? "tsconfig.json"
          const info = join(cacheDir, `${relative(root, cwd).replaceAll("/", "-")}-${basename(project, ".json")}.tsbuildinfo`)
          cmd = `${cmd} --incremental --tsBuildInfoFile ${info}`
        }
      } else if (/^bun test\b/.test(cmd)) {
        kind = "test"
        // Getaway and Blackout also run packages/kit's suite; when the packages target is in the plan it runs once there.
        if (dedupeKit) cmd = cmd.replace(/\s+\.\.\/\.\.\/packages\/kit\b/, "")
        // bun's default is one worker per core, which oversubscribes the shared Studio. Several simulation tests take
        // 1.5-2.5 s idle, so the 5 s default timeout (a hang guard) fails them under load; CI keeps the default.
        cmd = cmd.replace(/--parallel(?=\s|$)/, `--parallel=${testWorkers}`)
        if (!/--timeout\b/.test(cmd)) cmd = cmd.replace(/^bun test\b/, "bun test --timeout=20000")
      } else if (/^vite build\b/.test(cmd)) kind = "build"
      const id = tag(kind === "typecheck" ? `tsc ${cmd.match(/-p\s+tsconfig\.(\w+)\.json/)?.[1] ?? "app"}` : kind)
      steps.push({ id, cwd, cmd, deps: kind === "other" && build ? [...prep, build] : [...prep], kind })
      if (kind === "build") build = id
    }
    if (target.game && build) addGameTail(steps, target.game, cwd, build)
  }
  return steps
}

function addGameTail(steps: Step[], game: string, cwd: string, after: string) {
  if (smoke) steps.push({ id: `${game}:smoke`, cwd, cmd: "bun ../../scripts/smoke.mjs", deps: [after], kind: "smoke" })
  steps.push({ id: `${game}:dry-run`, cwd, cmd: "bunx --no-install wrangler deploy --dry-run", deps: [after], kind: "dry-run" })
}

// ---- Scheduler -----------------------------------------------------------------------------------------------

type Result = { step: Step; ms: number; ok: boolean; output: string }

async function run(steps: Step[], root: string): Promise<Result[]> {
  const results = new Map<string, Result>()
  const pending = new Map(steps.map((s) => [s.id, s]))
  const running = new Set<Promise<void>>()
  const active = new Map<string, string>()
  const env = { ...process.env, PATH: `${join(root, "node_modules/.bin")}:${process.env.PATH}`, FORCE_COLOR: "0" }
  const start = performance.now()
  // Start the long poles first: test suites, then typechecks.
  const weight = (s: Step) => ({ test: 0, typecheck: 1 })[s.kind] ?? 2
  const ready = () =>
    [...pending.values()].filter((s) => s.deps.every((d) => results.get(d)?.ok)).sort((a, b) => weight(a) - weight(b))
  const blocked = () => [...pending.values()].filter((s) => s.deps.some((d) => results.has(d) && !results.get(d)!.ok))
  while (pending.size > 0 || running.size > 0) {
    for (const s of blocked()) {
      pending.delete(s.id)
      results.set(s.id, { step: s, ms: 0, ok: false, output: "skipped: a dependency failed" })
    }
    for (const s of ready()) {
      if (running.size >= jobs) break
      // Each suite already uses every core (bun test --parallel), and some tests carry wall-clock budgets and
      // timeouts that fail under oversubscription: run suites one at a time.
      if (s.kind === "test" && [...active.values()].includes("test")) continue
      pending.delete(s.id)
      active.set(s.id, s.kind)
      const t = performance.now()
      const p = (async () => {
        const local = join(s.cwd, "node_modules/.bin")
        const proc = Bun.spawn(["bash", "-c", s.cmd], {
          cwd: s.cwd,
          env: { ...env, PATH: `${local}:${env.PATH}` },
          stdout: "pipe",
          stderr: "pipe",
        })
        const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
        const r = { step: s, ms: performance.now() - t, ok: code === 0, output: out + err }
        results.set(s.id, r)
        active.delete(s.id)
        const at = ((performance.now() - start) / 1000).toFixed(1).padStart(5)
        console.log(`${at}s ${r.ok ? "ok  " : "FAIL"} ${s.id.padEnd(28)} ${(r.ms / 1000).toFixed(2)}s`)
        if (!r.ok) console.log(indent(r.output.trim().split("\n").slice(-40).join("\n")))
      })()
      running.add(p)
      p.finally(() => running.delete(p))
    }
    if (running.size > 0) await Promise.race(running)
    else if (pending.size > 0 && ready().length === 0 && blocked().length === 0) throw new Error("verify: dependency cycle")
  }
  return [...results.values()]
}

const indent = (s: string) => s.replace(/^/gm, "      ")

// ---- Main ----------------------------------------------------------------------------------------------------

const t0 = performance.now()
const targets = await workflowTargets()
let selected: Target[]
if (all) {
  selected = targets.map((t) => t.target).filter((t) => !t.independent)
  if (release) {
    // Independent projects (own lockfiles) join a release run only when they changed.
    const changed = await changedFiles()
    for (const { target, paths } of targets) {
      if (target.independent && changed.some((f) => paths.some((p) => new Bun.Glob(p).match(f)))) selected.push(target)
    }
  }
} else {
  const changed = await changedFiles()
  selected = targets.filter(({ paths }) => changed.some((f) => paths.some((p) => new Bun.Glob(p).match(f)))).map((t) => t.target)
  console.log(`verify: ${changed.length} changed file(s) vs ${base} -> ${selected.map((t) => t.name).join(", ") || "nothing to check"}`)
}

let root = repo
let exportDir: string | undefined
if (release) {
  const dirty = (await $`git status --porcelain --untracked-files=no`.cwd(repo).quiet().text()).trim()
  if (dirty) console.log("verify:release: uncommitted changes are NOT verified (exporting HEAD)")
  exportDir = mkdtempSync(join(tmpdir(), "arcade-verify-"))
  root = exportDir
  let t = performance.now()
  await $`git archive HEAD | tar -x -C ${exportDir}`.cwd(repo).quiet()
  console.log(`  export ${((performance.now() - t) / 1000).toFixed(2)}s -> ${exportDir}`)
  t = performance.now()
  await $`bun install --frozen-lockfile`.cwd(exportDir).quiet()
  console.log(`  frozen install ${((performance.now() - t) / 1000).toFixed(2)}s`)
}

const withPackages = selected.some((t) => t.name === "packages")
const steps = selected.flatMap((t) => targetSteps(t, root, { incremental: !release, dedupeKit: !release && withPackages }))
if (flag("--list")) {
  for (const s of steps) console.log(`${s.id.padEnd(28)} ${relative(root, s.cwd).padEnd(16)} ${s.cmd}${s.deps.length ? `   (after ${s.deps.join(", ")})` : ""}`)
  process.exit(0)
}
if (!release && steps.some((s) => s.kind === "typecheck")) await $`mkdir -p ${cacheDir}`.quiet()

let results: Result[] = []
try {
  results = await run(steps, root)
} finally {
  if (exportDir) rmSync(exportDir, { recursive: true, force: true })
}
const failed = results.filter((r) => !r.ok)
const wall = performance.now() - t0
const busy = results.reduce((s, r) => s + r.ms, 0)
console.log(
  `verify${release ? ":release" : ""}: ${failed.length ? `FAILED (${failed.map((r) => r.step.id).join(", ")})` : "ok"} ` +
    `- ${results.length} steps, ${(wall / 1000).toFixed(1)}s wall, ${(busy / 1000).toFixed(1)}s of work, jobs=${jobs}`,
)
console.log(`METRIC verify_wall_ms=${wall.toFixed(0)}`)
process.exit(failed.length ? 1 : 0)
