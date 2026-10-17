// Boot timeline profiler: headless Chrome on Metal, cold HTTP cache per run, median of N runs.
//
//   bun scripts/boot-profile.ts                    # dev server (:5196), 3 runs
//   bun scripts/boot-profile.ts --prod             # vite build + its own vite preview (:5198), 3 runs
//   bun scripts/boot-profile.ts --runs 1 --view gate --q "only=terrain"
//   bun scripts/boot-profile.ts --json out.json    # also dump every run's raw timeline
//   bun scripts/boot-profile.ts --cpu 4 --dpr 2    # loaded-laptop repro: 4× CPU throttling, Retina pixel ratio
//   bun scripts/boot-profile.ts --chrome           # installed Google Chrome in new headless mode (real compositor and
//                                                  # GPU back-pressure; headless-shell lets GPU work queue up unthrottled)
//
// Reads the `performance.mark`s main.ts and src/boot/ place (boot:*, gpu:*, materials:*, mod:<name>:*, frame:*),
// resource timings (JS modules, textures), long tasks and every rAF interval, and prints one row per metric in ms
// from navigation start. "complete" is when main.ts reports every module streamed in (`__afterhours.complete`).
import { chromium, type Browser } from "playwright-core"
import { existsSync, readdirSync, writeFileSync } from "node:fs"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  if (i < 0) return undefined
  const v = args[i + 1]
  args.splice(i, 2)
  return v
}
const has = (name: string) => {
  const i = args.indexOf(`--${name}`)
  if (i >= 0) args.splice(i, 1)
  return i >= 0
}
const prod = has("prod")
const runs = Number(flag("runs") ?? 3)
const view = flag("view") ?? "road"
const extra = flag("q") ?? ""
const jsonOut = flag("json")
const profileOut = flag("profile")
const useChrome = has("chrome")
const cpuRate = Number(flag("cpu") ?? 1)
const dpr = Number(flag("dpr") ?? 1)
const timeoutMs = Number(flag("timeout") ?? 180_000)
const settleMs = Number(flag("settle") ?? 3000)
const [w, h] = (flag("size") ?? "1536x1024").split("x").map(Number) as [number, number]
const root = `${import.meta.dir}/..`

let port = 5196
let server: ReturnType<typeof Bun.spawn> | null = null
const up = (base: string) =>
  fetch(base)
    .then((r) => r.ok)
    .catch(() => false)

if (prod) {
  port = 5198
  const t = performance.now()
  const build = Bun.spawnSync(["bunx", "vite", "build", "--logLevel", "warn"], { cwd: root, stdout: "inherit", stderr: "inherit" })
  if (build.exitCode !== 0) process.exit(1)
  console.log(`vite build: ${((performance.now() - t) / 1000).toFixed(1)} s`)
  server = Bun.spawn(["bunx", "vite", "preview", "--port", String(port), "--strictPort"], { cwd: root, stdout: "ignore", stderr: "ignore" })
  for (let i = 0; i < 80 && !(await up(`http://localhost:${port}/`)); i++) await Bun.sleep(250)
} else if (!(await up(`http://localhost:${port}/`))) {
  console.error("dev server not answering on :5196 (bun run dev)")
  process.exit(1)
}
const base = prod ? `http://localhost:${port}/` : `http://localhost:${port}/`

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)

type Run = {
  marks: Record<string, number>
  measures: Record<string, { start: number; dur: number }>
  nav: { responseEnd: number; domContentLoaded: number; load: number }
  js: { count: number; bytes: number; lastEnd: number }
  tex: { count: number; bytes: number; lastEnd: number }
  longTasks: { start: number; dur: number }[]
  frames: number[]
  complete: number | null
  gpuMs: number | null
  errors: string[]
}

type CpuProfile = {
  nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }[]
  samples: number[]
  timeDeltas: number[]
}
/** Self and total time per function name across the whole profile (top 30), to see what the boot spends time on. */
function summariseProfile(p: CpuProfile) {
  const byId = new Map(p.nodes.map((n) => [n.id, n]))
  const parent = new Map<number, number>()
  for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
  const self = new Map<string, number>()
  const total = new Map<string, number>()
  const name = (id: number) => {
    const f = byId.get(id)!.callFrame
    return `${f.functionName || "(anon)"} ${f.url.split("/").pop()?.split("?")[0] ?? ""}`
  }
  for (let i = 0; i < p.samples.length; i++) {
    const dt = (p.timeDeltas[i + 1] ?? 0) / 1000
    let id: number | undefined = p.samples[i]!
    self.set(name(id), (self.get(name(id)) ?? 0) + dt)
    const seen = new Set<string>()
    while (id !== undefined) {
      const k = name(id)
      if (!seen.has(k)) total.set(k, (total.get(k) ?? 0) + dt)
      seen.add(k)
      id = parent.get(id)
    }
  }
  // Whole-boot buckets by what each sample's stack is doing (first match wins).
  const BUCKETS: [string, RegExp][] = [
    ["texture upload/decode", /copyExternalImageToTexture|_copyImageToTexture|writeTexture|generateMipmaps/],
    ["GLB load/parse", /GLTFLoader|GLTFParser|meshopt|MeshoptDecoder|loadModel|parse three_addons_loaders/],
    ["frame loop (render + updates)", /^tick main|frame warmup/],
    ["module CPU build (generators)", /buildModule main/],
    ["shader node build + pipelines", /buildAsync|getForRender|compileAsync|_createObjectPipeline|createRenderPipeline|getNodeBuilderState|buildCode/],
  ]
  const buckets = new Map<string, number>()
  for (let i = 0; i < p.samples.length; i++) {
    const dt = (p.timeDeltas[i + 1] ?? 0) / 1000
    const names: string[] = []
    for (let id: number | undefined = p.samples[i]!; id !== undefined; id = parent.get(id)) names.push(name(id))
    const leaf = names[0] ?? ""
    let b = leaf.startsWith("(idle)") ? "idle" : leaf.startsWith("(garbage") ? "GC" : leaf.startsWith("(program)") ? "browser (program)" : "other JS"
    if (b === "other JS") for (const [label, re] of BUCKETS) if (names.some((n) => re.test(n))) { b = label; break }
    buckets.set(b, (buckets.get(b) ?? 0) + dt)
  }
  console.log("\nCPU by activity (ms, whole run)")
  for (const [k, v] of [...buckets].sort((a, b) => b[1] - a[1])) console.log(`${v.toFixed(0).padStart(7)}  ${k}`)
  const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).slice(0, 30)
  console.log("\nCPU self ms (top 30)")
  for (const [k, v] of top(self)) console.log(`${v.toFixed(0).padStart(7)}  ${k}`)
  console.log("\nCPU total ms (top 30)")
  for (const [k, v] of top(total)) console.log(`${v.toFixed(0).padStart(7)}  ${k}`)
}

async function once(browser: Browser): Promise<Run> {
  const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr })
  const page = await context.newPage()
  if (cpuRate > 1) {
    const throttle = await context.newCDPSession(page)
    await throttle.send("Emulation.setCPUThrottlingRate", { rate: cpuRate })
  }
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.stack ?? e.message))
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
  await page.addInitScript(() => {
    const g = globalThis as unknown as { __boot: { long: { start: number; dur: number }[]; frames: number[] } }
    g.__boot = { long: [], frames: [] }
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) g.__boot.long.push({ start: e.startTime, dur: e.duration })
    }).observe({ type: "longtask", buffered: true })
    const tick = (t: number) => {
      g.__boot.frames.push(t)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  const cdp = profileOut && !all.length ? await context.newCDPSession(page) : null
  if (cdp) {
    await cdp.send("Profiler.enable")
    await cdp.send("Profiler.setSamplingInterval", { interval: 500 })
    await cdp.send("Profiler.start")
  }
  await page.goto(`${base}?shot=1&perf=1&view=${view}${extra ? `&${extra}` : ""}`)
  await page
    .waitForFunction(
      () => {
        const s = (globalThis as { __afterhours?: { complete?: boolean; frames: number; errors: string[] } }).__afterhours
        // Older main.ts had no `complete`; there the world is in once frames start.
        return !!s && (s.complete ?? s.frames > 0)
      },
      undefined,
      { timeout: timeoutMs, polling: 50 },
    )
    .catch((e: Error) => errors.push(e.message))
  await page.waitForTimeout(settleMs)
  if (cdp) {
    const { profile } = (await cdp.send("Profiler.stop")) as { profile: CpuProfile }
    writeFileSync(profileOut!, JSON.stringify(profile))
    summariseProfile(profile)
  }
  const run = await page.evaluate(() => {
    const marks: Record<string, number> = {}
    for (const m of performance.getEntriesByType("mark")) marks[m.name] ??= m.startTime
    const measures: Record<string, { start: number; dur: number }> = {}
    for (const m of performance.getEntriesByType("measure")) measures[m.name] ??= { start: m.startTime, dur: m.duration }
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming
    const res = performance.getEntriesByType("resource") as PerformanceResourceTiming[]
    const sum = (list: PerformanceResourceTiming[]) => ({
      count: list.length,
      bytes: list.reduce((a, r) => a + (r.encodedBodySize || r.transferSize), 0),
      lastEnd: list.reduce((a, r) => Math.max(a, r.responseEnd), 0),
    })
    const isJs = (r: PerformanceResourceTiming) => /\.(m?[jt]s|tsx?)(\?|$)/.test(new URL(r.name).pathname) || r.initiatorType === "script"
    const isTex = (r: PerformanceResourceTiming) => /\.(jpe?g|png|webp|ktx2|avif)(\?|$)/.test(r.name)
    const g = globalThis as unknown as {
      __boot: { long: { start: number; dur: number }[]; frames: number[] }
      __afterhours?: { completeAt?: number; gpuMs?: number | null }
    }
    return {
      marks,
      measures,
      nav: { responseEnd: nav.responseEnd, domContentLoaded: nav.domContentLoadedEventEnd, load: nav.loadEventEnd },
      js: sum(res.filter(isJs)),
      tex: sum(res.filter(isTex)),
      longTasks: g.__boot.long,
      frames: g.__boot.frames,
      complete: g.__afterhours?.completeAt ?? null,
      gpuMs: g.__afterhours?.gpuMs ?? null,
    }
  })
  await context.close()
  return { ...run, errors }
}

const browser = await chromium.launch({
  executablePath: useChrome ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : chrome,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist", "--enable-features=Vulkan"],
})
const all: Run[] = []
for (let i = 0; i < runs; i++) {
  const r = await once(browser)
  all.push(r)
  if (r.errors.length) console.error(`run ${i + 1} errors:`, r.errors.slice(0, 5))
}
await browser.close()
server?.kill()

// ---------------------------------------------------------------------------------------------- summarise
const median = (xs: number[]) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  return v.length ? v[v.length >> 1]! : NaN
}
type Row = [string, number[], string?]
const rows: Row[] = []
const at = (label: string, f: (r: Run) => number | undefined, note?: string) => rows.push([label, all.map((r) => f(r) ?? NaN), note])

at("html responseEnd", (r) => r.nav.responseEnd)
at("main.ts evaluated (boot:main)", (r) => r.marks["boot:main"])
at("JS modules loaded (last response)", (r) => r.js.lastEnd, `${median(all.map((r) => r.js.count))} files, ${(median(all.map((r) => r.js.bytes)) / 1e6).toFixed(1)} MB`)
at("WebGPU init", (r) => r.marks["gpu:init:end"], "ms from nav")
at("  init duration", (r) => r.marks["gpu:init:end"]! - r.marks["gpu:init:start"]!)
at("materials ready", (r) => r.marks["materials:end"])
at("  materials duration", (r) => r.marks["materials:end"]! - r.marks["materials:start"]!)
at("textures loaded (last response)", (r) => r.tex.lastEnd, `${median(all.map((r) => r.tex.count))} files, ${(median(all.map((r) => r.tex.bytes)) / 1e6).toFixed(1)} MB`)

const modNames = [...new Set(all.flatMap((r) => Object.keys(r.marks).flatMap((k) => /^mod:([^:]+):/.exec(k)?.[1] ?? [])))]
for (const m of modNames) {
  at(`mod ${m}: import`, (r) => r.marks[`mod:${m}:build:start`]! - r.marks[`mod:${m}:import:start`]!)
  at(`mod ${m}: build`, (r) => r.marks[`mod:${m}:build:end`]! - r.marks[`mod:${m}:build:start`]!)
  if (all.some((r) => r.marks[`mod:${m}:compile:end`] !== undefined))
    at(`mod ${m}: compileAsync`, (r) => r.marks[`mod:${m}:compile:end`]! - r.marks[`mod:${m}:compile:start`]!)
  if (all.some((r) => r.marks[`mod:${m}:shown`] !== undefined)) at(`mod ${m}: shown at`, (r) => r.marks[`mod:${m}:shown`])
}
for (const m of ["rig", "first:compile"]) {
  if (all.some((r) => r.marks[`${m}:end`] !== undefined)) at(`${m} duration`, (r) => r.marks[`${m}:end`]! - r.marks[`${m}:start`]!)
}
at("first frame submitted", (r) => r.measures["frame:1"] && r.measures["frame:1"].start + r.measures["frame:1"].dur)
// The GPU-done callback needs a free main thread; the next rAF after frame 1 is the other bound on its presentation.
at("first frame visible", (r) => {
  const end = r.measures["frame:1"] ? r.measures["frame:1"].start + r.measures["frame:1"].dur : NaN
  const nextTick = r.frames.find((t) => t > end) ?? Infinity
  return Math.min(r.marks["frame:1:gpu"] ?? Infinity, nextTick)
})
at("third frame GPU done", (r) => r.marks["frame:3:gpu"])
at("  frame 1 CPU (pipelines+upload)", (r) => r.measures["frame:1"]?.dur)
at("  frame 2 CPU", (r) => r.measures["frame:2"]?.dur)
at("everything in (complete)", (r) => r.complete ?? r.measures["frame:1"]?.start)
const firstFrame = (r: Run) => r.measures["frame:1"]?.start ?? Infinity
at("long tasks before first frame (sum)", (r) => r.longTasks.filter((t) => t.start < firstFrame(r)).reduce((a, t) => a + t.dur, 0))
at("longest task", (r) => Math.max(0, ...r.longTasks.map((t) => t.dur)))
at("rAF gaps >50 ms after first frame", (r) => {
  let n = 0
  for (let i = 1; i < r.frames.length; i++) if (r.frames[i]! > firstFrame(r) && r.frames[i]! - r.frames[i - 1]! > 50) n++
  return n
})
at("worst rAF gap after first frame", (r) => {
  let worst = 0
  for (let i = 1; i < r.frames.length; i++) if (r.frames[i - 1]! >= firstFrame(r)) worst = Math.max(worst, r.frames[i]! - r.frames[i - 1]!)
  return worst
})
at("GPU ms per frame (timestamp query)", (r) => r.gpuMs ?? NaN)
at("steady median frame (last 60)", (r) => {
  const d = r.frames.slice(-61).map((t, i, a) => (i ? t - a[i - 1]! : NaN)).slice(1)
  return median(d)
})

if (has("gaps") || runs === 1) {
  const r = all[0]!
  const ev: [number, string][] = Object.entries(r.marks).map(([k, v]) => [v, k])
  for (let i = 1; i < r.frames.length; i++) {
    const g = r.frames[i]! - r.frames[i - 1]!
    if (g > 50) ev.push([r.frames[i - 1]!, `  rAF gap ${g.toFixed(0)} ms`])
  }
  for (const t of r.longTasks) ev.push([t.start, `  long task ${t.dur.toFixed(0)} ms`])
  ev.sort((a, b) => a[0] - b[0])
  console.log("\ntimeline (run 1)")
  for (const [t, k] of ev) console.log(`${t.toFixed(0).padStart(7)}  ${k}`)
}

const fmt = (x: number) => (Number.isFinite(x) ? x.toFixed(0).padStart(7) : "      -")
console.log(`\n${prod ? "PROD (vite preview)" : "DEV (vite)"} · view=${view}${extra ? ` · ${extra}` : ""} · ${w}×${h}@${dpr}x · cpu ${cpuRate}× · ${useChrome ? "chrome · " : ""}${runs} runs, ms`)
console.log(`${"metric".padEnd(40)} ${"median".padStart(7)}   runs`)
for (const [label, xs, note] of rows) console.log(`${label.padEnd(40)} ${fmt(median(xs))}   ${xs.map(fmt).join("")}${note ? `   ${note}` : ""}`)
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(all, null, 1))
process.exit(0)
