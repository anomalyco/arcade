import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright-core"
import { createServer } from "vite"

/**
 * Live solo play with held keys, the way a player feels it: sprints through the streamed world (new lots compile and
 * the window re-centres), then stands in a house, and records every drawn frame's interval, draw() CPU, the main
 * thread's long tasks and long animation frames (with the scripts that ran), and keydown-to-draw latency.
 * `PLAY_CPU_THROTTLE=2` slows the main thread through CDP to stand in for a slower laptop CPU.
 *
 *   PLAY_CPU_THROTTLE=2 PLAY_SECONDS=30 bun scripts/play-hitches.ts
 */
const root = resolve(import.meta.dir, "..")
const out = resolve(process.env.PLAY_OUT ?? "captures/play-hitches")
const throttle = Number(process.env.PLAY_CPU_THROTTLE ?? 1)
const seconds = Number(process.env.PLAY_SECONDS ?? 30)
const quality = process.env.PLAY_QUALITY ?? "high"
// A larger viewport stands in for a slower GPU: 2592×1420 CSS at 2× draws 2.25× the bench's pixels.
const [vw, vh] = (process.env.PLAY_VIEWPORT ?? "1728x947").split("x").map(Number) as [number, number]
mkdirSync(out, { recursive: true })
const server = await createServer({
  root,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{
    name: "play-hooks",
    enforce: "pre",
    transform(code, id) {
      if (id !== resolve(root, "src/main.ts")) return
      return code.replace("function draw(dt: number) {", "function draw(dt: number) { const __t0 = performance.now(); try { return __draw(dt) } finally { const __t1 = performance.now(); (window as any).__play?.draws.push([__t0, __t1 - __t0, session.view.player.x, session.view.player.y, qualityController.effectivePixelRatio(devicePixelRatio), qualityController.getActiveTier()]) } }\n  function __draw(dt: number) {")
    },
  }],
})
await server.listen()
const port = (server.httpServer!.address() as { port: number }).port
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
  .map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
assert(executablePath)
const browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]! : 0 }
try {
  const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 2 })
  const errors: string[] = []
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
  await page.addInitScript(() => {
    const w = window as any
    w.__play = { draws: [], longTasks: [], loaf: [], keys: [] }
    new PerformanceObserver(l => { for (const e of l.getEntries()) w.__play.longTasks.push([e.startTime, e.duration]) }).observe({ type: "longtask", buffered: true })
    try {
      new PerformanceObserver(l => {
        for (const e of l.getEntries() as any[]) w.__play.loaf.push({ start: e.startTime, duration: e.duration, blocking: e.blockingDuration, scripts: (e.scripts ?? []).map((s: any) => ({ d: Math.round(s.duration), src: `${s.sourceFunctionName || s.invoker || ""} ${String(s.sourceURL || "").split("/").slice(-2).join("/")}:${s.sourceCharPosition ?? ""}` })).filter((s: any) => s.d >= 5) })
      }).observe({ type: "long-animation-frame", buffered: true })
    } catch {}
    addEventListener("keydown", (e: KeyboardEvent) => { if (!e.repeat) w.__play.keys.push([performance.now(), e.code]) }, true)
  })
  const cdp = await page.context().newCDPSession(page)
  await page.goto(`http://127.0.0.1:${port}/?seed=7&quality=${quality}`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready)
  await page.locator("#game").click()
  await page.waitForTimeout(2500)
  if (throttle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle })
  await cdp.send("Performance.enable")
  const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(m => [m.name, m.value]))
  const m0 = await metrics()
  await page.evaluate(() => {
    const w = window as any
    w.__play.mutations = 0
    new MutationObserver(l => { w.__play.mutations += l.length }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
  })
  await page.evaluate(() => { const p = (window as any).__play; p.draws.length = 0; p.longTasks.length = 0; p.loaf.length = 0; p.keys.length = 0; p.t0 = performance.now() })
  // Down to the middle of the street, sprint east out of the origin block into streamed lots, north, west, then stand.
  const legs: [string[], number][] = [[["KeyS"], 0.04], [["KeyD", "ShiftLeft"], 0.55], [["KeyW", "ShiftLeft"], 0.12], [["KeyA", "ShiftLeft"], 0.14], [["KeyS"], 0.05], [[], 0.1]]
  for (const [keys, share] of legs) {
    for (const k of keys) await page.keyboard.down(k)
    await page.waitForTimeout(seconds * share * 1000)
    for (const k of [...keys].reverse()) await page.keyboard.up(k)
  }
  const m1 = await metrics()
  if (throttle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 })
  const raw = await page.evaluate(() => {
    const w = window as any
    const p = w.__play
    const h = w.__arcadeHarness
    return { ...p, t1: performance.now(), pos: [h.session().view.player.x, h.session().view.player.y], quality: h.quality?.() }
  })
  const draws = raw.draws.filter((d: number[]) => d[0] >= raw.t0)
  const gaps = draws.slice(1).map((d: number[], i: number) => d[0] - draws[i][0])
  const cpu = draws.map((d: number[]) => d[1])
  const wall = (raw.t1 - raw.t0) / 1000
  const latency = raw.keys.map(([t]: number[]) => { const d = draws.find((x: number[]) => x[0] >= t); return d ? d[0] + d[1] - t : null }).filter((x: number | null) => x !== null)
  const summary = {
    throttle,
    quality,
    seconds: wall,
    fps: draws.length / wall,
    frameMs: { p50: q(gaps, 0.5), p90: q(gaps, 0.9), p99: q(gaps, 0.99), max: q(gaps, 1) },
    over20ms: gaps.filter((g: number) => g > 20).length,
    over33ms: gaps.filter((g: number) => g > 34).length,
    drawCpuMs: { p50: q(cpu, 0.5), p90: q(cpu, 0.9), p99: q(cpu, 0.99), max: q(cpu, 1) },
    longTasks: { count: raw.longTasks.length, totalMs: raw.longTasks.reduce((n: number, t: number[]) => n + t[1], 0), max: Math.max(0, ...raw.longTasks.map((t: number[]) => t[1])) },
    keydownToDrawMs: latency,
    mainThreadPerSecond: Object.fromEntries(["TaskDuration", "ScriptDuration", "RecalcStyleDuration", "LayoutDuration", "RecalcStyleCount", "LayoutCount"].map(k => [k, Math.round(((m1[k]! - m0[k]!) / wall) * (k.endsWith("Duration") ? 1000 : 1) * 10) / 10])),
    domMutationsPerSecond: Math.round(raw.mutations / wall),
    endPos: raw.pos,
    viewport: [vw, vh],
    autoQuality: raw.quality && { tier: raw.quality.activeTier, pixelRatio: raw.quality.pixelRatio, gpuMs: raw.quality.gpuMs, adaptations: raw.quality.adaptations },
    path: draws.filter((_: unknown, i: number) => i % 120 === 0).map((d: number[]) => [Math.round(d[2]), Math.round(d[3])]),
    slowDraws: draws.filter((d: any[]) => d[1] > 12).map((d: any[]) => ({ at: Math.round(d[0] - raw.t0), ms: Math.round(d[1]), quality: `${d[5]} ${d[4]}` })),
    qualityChanges: draws.filter((d: any[], i: number) => i > 0 && (d[4] !== draws[i - 1][4] || d[5] !== draws[i - 1][5])).map((d: any[]) => ({ at: Math.round(d[0] - raw.t0), quality: `${d[5]} ${d[4]}` })),
    worstLoaf: [...raw.loaf].sort((a: any, b: any) => b.duration - a.duration).slice(0, 6),
  }
  await Bun.write(resolve(out, `play-t${throttle}-${quality}-${vw}x${vh}.json`), JSON.stringify({ summary, raw }, null, 2))
  const { worstLoaf, slowDraws, qualityChanges, ...brief } = summary
  console.log(`PLAY ${JSON.stringify(brief)}`)
  console.log(`QUALITY ${JSON.stringify(qualityChanges)}`)
  console.log(`SLOW DRAWS ${JSON.stringify(slowDraws)}`)
  for (const l of worstLoaf) console.log(`LOAF ${l.duration.toFixed(0)} ms blocking ${l.blocking.toFixed(0)} ${JSON.stringify(l.scripts)}`)
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
  await server.close()
}
