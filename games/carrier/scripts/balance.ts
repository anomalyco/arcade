// Headless balance simulator: many full Carrier matches played by match bots (server/bot-match.ts) on the real
// RoomCore, faster than real time, deterministic per seed, in parallel on every core. Prints a summary with 95%
// confidence intervals and writes JSON plus an HTML report to captures/balance/<run>/.
//
//   bun scripts/balance.ts --matches=40 --players=32 --seed=1 --minutes=40
//   bun scripts/balance.ts --set FLEET.bomb=60 --set WEAPONS.missile.maxG=30
//   bun scripts/balance.ts --sweep FLEET.bomb=60,80,120 --matches=30
//   bun scripts/balance.ts --team1.skill=0.9 --team1.accuracy=0.8      (asymmetric skill)
//   bun scripts/balance.ts --overrides=variant.json --assert            (exit 1 on degenerate outcomes)
//
// Options: --matches N, --players N (spread over --ships 2..4 carriers, default 4; each crew is the first N/ships roles
// of MATCH_CREW unless --crew=helm,hornet,...), --seed S (match i plays seed S+i in every variant), --minutes M (time
// cap), --workers N (default: cores - 1), --skill/--aggression/--accuracy 0..1 (every side), --teamN.<knob> (one
// side) and --role.<op>.<knob> (one operation, e.g. --role.gun-5in.accuracy=0.3), --set PATH=V (repeatable), --overrides FILE (JSON: nested objects or dotted keys), --sweep PATH=a,b,c (one
// variant per value; the baseline runs too), --assert (with --assert-dominant, --assert-unfinished,
// --assert-sink-min), --name NAME (run folder), --no-html, --quiet.

import { availableParallelism } from "node:os"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { CREW } from "../shared/crew"
import { MATCH_CREW } from "../shared/bots"
import { isOpId } from "../shared/ops"
import { type MatchSpec, type SideSettings } from "./balance/match"
import { type AssertLimits, type MatchResult, type Summary, ASSERT_DEFAULTS, degenerate, summarize } from "./balance/metrics"
import { compareReport, htmlReport, textReport } from "./balance/report"
import { type Override, overridesOfJson, parseOverride, parseSweep, tunableValue } from "./balance/tunables"

type Args = { flags: Map<string, string[]>; has(k: string): boolean; get(k: string): string | undefined; num(k: string, d: number): number; all(k: string): string[] }

function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string[]>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith("--")) throw new Error(`unexpected argument "${a}"`)
    const eq = a.indexOf("=")
    let key: string
    let value: string
    if (eq > 0) {
      key = a.slice(2, eq)
      value = a.slice(eq + 1)
    } else {
      key = a.slice(2)
      const next = argv[i + 1]
      // "--set FLEET.bomb=60": a value that doesn't look like a flag belongs to it.
      value = next !== undefined && !next.startsWith("--") ? (i++, next) : "true"
    }
    flags.set(key, [...(flags.get(key) ?? []), value])
  }
  return {
    flags,
    has: (k) => flags.has(k),
    get: (k) => flags.get(k)?.at(-1),
    all: (k) => flags.get(k) ?? [],
    num(k, d) {
      const v = flags.get(k)?.at(-1)
      if (v === undefined) return d
      const n = Number(v)
      if (!Number.isFinite(n)) throw new Error(`--${k} needs a number, got "${v}"`)
      return n
    },
  }
}

const KNOBS = ["skill", "aggression", "accuracy"] as const

function sideOf(args: Args, prefix: string): SideSettings {
  const out: SideSettings = {}
  for (const k of KNOBS) {
    const v = args.get(`${prefix}${k}`)
    if (v === undefined) continue
    const n = Number(v)
    if (!(n >= 0 && n <= 1)) throw new Error(`--${prefix}${k} must be 0..1`)
    out[k] = n
  }
  return out
}

type Variant = { name: string; overrides: Override[] }

async function runAll(specs: MatchSpec[], workers: number, progress: (done: number) => void): Promise<MatchResult[]> {
  const results: MatchResult[] = new Array(specs.length)
  let next = 0
  let done = 0
  const pool = Array.from({ length: Math.min(workers, specs.length) }, () => new Worker(new URL("./balance/worker.ts", import.meta.url).href))
  await new Promise<void>((resolve, reject) => {
    const feed = (w: Worker) => {
      if (next >= specs.length) return
      const job = next++
      w.postMessage({ job, spec: specs[job] })
    }
    for (const w of pool) {
      w.onmessage = (ev: MessageEvent<{ job: number; result?: MatchResult; error?: string }>) => {
        const { job, result, error } = ev.data
        if (error || !result) return reject(new Error(`match ${job} (seed ${specs[job]!.seed}, ${specs[job]!.variant}) failed:\n${error}`))
        results[job] = result
        progress(++done)
        if (done === specs.length) resolve()
        else feed(w)
      }
      w.onerror = (e) => reject(new Error(`worker error: ${e.message}`))
      feed(w)
    }
  })
  for (const w of pool) w.terminate()
  return results
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const matches = Math.max(1, Math.floor(args.num("matches", 20)))
  const ships = Math.max(2, Math.min(CREW.ships, Math.floor(args.num("ships", CREW.ships))))
  const players = Math.max(ships, Math.min(CREW.roomMax, Math.floor(args.num("players", CREW.roomMax))))
  const seed = Math.floor(args.num("seed", 1))
  const minutes = args.num("minutes", 40)
  const workers = Math.max(1, Math.floor(args.num("workers", Math.max(1, availableParallelism() - 1))))
  const crewArg = args.get("crew")
  const crew = crewArg ? crewArg.split(",") : MATCH_CREW.slice(0, Math.min(CREW.capacity, Math.floor(players / ships)))
  for (const role of crew) if (!isOpId(role)) throw new Error(`--crew: "${role}" is not an operation (shared/ops.ts)`)
  if (crew.length > CREW.capacity) throw new Error(`--crew: at most ${CREW.capacity} per carrier`)
  const base = sideOf(args, "")
  const sides = Array.from({ length: CREW.ships }, (_, t) => sideOf(args, `team${t}.`))
  const roles: Record<string, SideSettings> = {}
  for (const key of args.flags.keys()) {
    const m = /^role\.([a-z0-9-]+)\.[a-z]+$/.exec(key)
    if (!m) continue
    if (!isOpId(m[1])) throw new Error(`--${key}: "${m[1]}" is not an operation (shared/ops.ts)`)
    roles[m[1]!] = sideOf(args, `role.${m[1]}.`)
  }
  const common: Override[] = []
  for (const file of args.all("overrides")) common.push(...overridesOfJson(JSON.parse(readFileSync(file, "utf8"))))
  for (const s of args.all("set")) common.push(parseOverride(s))
  const sweep = args.get("sweep")
  const variants: Variant[] = [{ name: common.length ? common.map((o) => `${o.path}=${o.value}`).join(" ") : "baseline", overrides: common }]
  if (sweep) {
    const list = parseSweep(sweep)
    variants[0]!.name = `${list[0]!.path}=${tunableValue(list[0]!.path)} (current)`
    for (const o of list) variants.push({ name: `${o.path}=${o.value}`, overrides: [...common, o] })
  }
  // Validate every path here, before the workers start.
  for (const v of variants) for (const o of v.overrides) tunableValue(o.path)
  const specs: MatchSpec[] = variants.flatMap((v) => Array.from({ length: matches }, (_, i) => ({ seed: seed + i, variant: v.name, ships, crew, minutes, base, sides, roles, overrides: v.overrides })))
  const run = args.get("name") ?? `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}-s${seed}`
  const out = join(import.meta.dir, "..", "captures", "balance", run)
  const quiet = args.has("quiet")
  const notes = [
    `run ${run}: ${matches} matches × ${variants.length} variant(s), seeds ${seed}..${seed + matches - 1}, ${ships} carriers × ${crew.length} (${crew.join(", ")}), cap ${minutes} min, ${workers} workers`,
    `bots: ${JSON.stringify(base)}${sides.some((s) => Object.keys(s).length) ? ` per team ${JSON.stringify(sides)}` : ""}${Object.keys(roles).length ? ` per role ${JSON.stringify(roles)}` : ""}`,
  ]
  if (!quiet) console.log(notes.join("\n"))
  const t0 = performance.now()
  const results = await runAll(specs, workers, (done) => {
    if (!quiet && process.stdout.isTTY) process.stdout.write(`\r  ${done}/${specs.length} matches`)
  })
  if (!quiet && process.stdout.isTTY) process.stdout.write("\n")
  const wall = (performance.now() - t0) / 1000
  notes.push(`wall ${wall.toFixed(0)} s`)
  const summaries: Summary[] = variants.map((v) => summarize(v.name, results.filter((r) => r.variant === v.name)))
  const text = summaries.map((s) => textReport(s)).join("\n\n") + (summaries.length > 1 ? `\n\n== comparison ==\n${compareReport(summaries)}` : "")
  const limits: AssertLimits = {
    unfinished: args.num("assert-unfinished", ASSERT_DEFAULTS.unfinished),
    dominant: args.num("assert-dominant", ASSERT_DEFAULTS.dominant),
    minMatches: ASSERT_DEFAULTS.minMatches,
    minSinkLife: args.num("assert-sink-min", ASSERT_DEFAULTS.minSinkLife / 60) * 60,
  }
  const flags = summaries.flatMap((s) => degenerate(s, limits).map((f) => `${s.variant}: ${f}`))
  const flagText = flags.length ? `\nDEGENERATE:\n${flags.map((f) => `  ! ${f}`).join("\n")}` : "\nno degenerate outcomes flagged"
  console.log(`${text}\n${flagText}`)
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, "summary.txt"), `${notes.join("\n")}\n\n${text}\n${flagText}\n`)
  writeFileSync(join(out, "summary.json"), JSON.stringify({ notes, flags, summaries }, null, 1))
  writeFileSync(join(out, "matches.json"), JSON.stringify(results))
  if (!args.has("no-html")) writeFileSync(join(out, "report.html"), htmlReport(summaries, [...notes, ...(flags.length ? flags.map((f) => `! ${f}`) : ["no degenerate outcomes flagged"])]))
  console.log(`\nwrote ${out}`)
  if (args.has("assert") && flags.length) process.exit(1)
}

await main()
