import { browserBudget } from "../../../scripts/browser-budget"
import { existsSync, mkdirSync, symlinkSync, writeFileSync, copyFileSync } from "node:fs"
import { join } from "node:path"
import { findChromeExecutable, installGpuInstrumentation } from "./compare"

await using budget = browserBudget()
const { chromium } = budget

const root = join(import.meta.dir, "../../..")
const diagnostic = process.argv.find(a => a.startsWith("--shadow="))?.slice(9)
const out = join(root, diagnostic ? `captures/blackout-shadow/${diagnostic}` : "captures/blackout-look")
mkdirSync(out, { recursive: true })
const baseline = process.argv.includes("--baseline")
const bench = process.argv.includes("--bench")
const compare = process.argv.includes("--compare")
let gameRoot = join(root, "games/blackout")
if (baseline) {
  if (!existsSync(join(root, "perf/blackout-main.tar"))) throw new Error("Create perf/blackout-main.tar from the baseline revision first; see perf/blackout-look.md")
  const archiveRoot = join(root, "captures/blackout-main")
  mkdirSync(archiveRoot, { recursive: true })
  const unpack = Bun.spawn(["tar", "-xf", join(root, "perf/blackout-main.tar"), "-C", archiveRoot])
  if (await unpack.exited) throw new Error("Baseline unpack failed")
  const baselineGame = join(archiveRoot, "games/blackout")
  if (!existsSync(join(baselineGame, "node_modules"))) symlinkSync(join(root, "node_modules"), join(baselineGame, "node_modules"))
  copyFileSync(join(gameRoot, "shared/build.gen.ts"), join(baselineGame, "shared/build.gen.ts"))
  writeFileSync(join(baselineGame, "look-vite.config.ts"), `import config from './vite.config.ts'; export default {...config, server: {...config.server, fs: {allow: [${JSON.stringify(root)}]}}, build: {...config.build, rollupOptions: {input: 'index.html'}}}`)
  gameRoot = baselineGame
}
const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
const port = reserve.port!
reserve.stop(true)
const server = Bun.spawn(["bun", "x", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort", ...(baseline ? ["--config", "look-vite.config.ts"] : [])], { cwd: gameRoot, stdout: "ignore", stderr: "inherit" })
const browser = await chromium.launch({ executablePath: findChromeExecutable(), headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const errors: string[] = []
try {
  const base = `http://localhost:${port}`
  const until = Date.now() + 15000
  while (!await fetch(base).then(r => r.ok).catch(() => false)) {
    if (Date.now() > until) throw new Error("Vite failed")
    await Bun.sleep(100)
  }
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.on("pageerror", e => { errors.push(e.message); console.error(e.message) })
  page.on("console", m => { if (m.type() === "error" && !m.location().url.endsWith("favicon.ico")) { errors.push(`${m.text()} ${m.location().url}`); console.error(m.text(), m.location().url) } })
  if (diagnostic && diagnostic !== "before" && diagnostic !== "after") await page.route("**/src/render/shaders.ts*", async route => {
    const response = await route.fetch()
    const source = await response.text()
    const [from, to] = diagnostic === "no-shadow"
      ? ["if (L.extra.y > 0.5) { vis = shadowAt", "if (false) { vis = shadowAt"]
      : ["if (shin > 0.0) {", "if (false) {"]
    if (!source.includes(from)) throw new Error("Missing shadow diagnostic anchor")
    await route.fulfill({ response, body: source.replace(from, to) })
  })
  if (compare) {
    await page.addInitScript(() => {
      if (parent !== window) return
      const state = { pairs: 0, mismatches: 0, last: null as any }
      ;(window as any).__lookCompare = state
      addEventListener("message", event => {
        const panes = [...document.querySelectorAll("iframe")]
        const i = panes.findIndex(p => p.contentWindow === event.source)
        const m = event.data
        if (i === 0 && m?.type === "mux-state") state.last = m
        if (i === 1 && m?.type === "mux-done") {
          state.pairs++
          if (["tick", "x", "y", "vx", "vy", "aim", "tx", "ty"].some(k => m[k] !== state.last?.[k])) state.mismatches++
        }
      })
    })
    await page.goto(`${base}/compare.html?seed=4`, { waitUntil: "networkidle" })
    await page.waitForFunction("window.__lookCompare.pairs >= 120", undefined, { timeout: 45000 })
    const after = page.frames().find(f => f !== page.mainFrame() && f.url().startsWith(base))!
    const panel = after.locator("[data-lab]")
    await panel.locator('button[data-group="Look"]').waitFor()
    if (await panel.locator('input[data-key^="look"]').count() !== 11) throw new Error("Missing Look switches")
    await panel.getByRole("button", { name: "All Off", exact: true }).click()
    if (await panel.locator('input[type="checkbox"]:checked').count()) throw new Error("All Off failed")
    await panel.getByRole("button", { name: "All On", exact: true }).click()
    if (await panel.locator('input[type="checkbox"]:not(:checked)').count()) throw new Error("All On failed")
    await page.waitForFunction("window.__lookCompare.pairs >= 180")
    const result = await page.evaluate(() => ({ ...(window as any).__lookCompare, urls: [...document.querySelectorAll('iframe')].map(f => f.src) }))
    if (result.mismatches || new URL(result.urls[0]).searchParams.has("vanilla")) throw new Error("Invalid production/main comparison")
    await page.screenshot({ path: join(out, "compare.png") })
    writeFileSync(join(out, "compare.json"), JSON.stringify(result, null, 2))
    if (errors.length) throw new Error(errors.join("\n"))
    console.log(JSON.stringify(result))
  } else {
  await installGpuInstrumentation(page)
  const step = (n: number, dt = 1000 / 60) => page.evaluate(async ({ n, dt }) => {
    const w = window as any
    for (let i = 0; i < n; i++) { await w.__stepManualVideo(dt); await w.__gpuDevice.queue.onSubmittedWorkDone(); await w.__gpuDrain() }
  }, { n, dt })
  const keys = ["lookGrade", "lookPractical", "lookWalls", "lookAO", "lookCaps", "lookFloors", "lookCity", "lookGloss", "lookShadows", "lookShadowFilter", "lookMotion"]
  const set = async (key: string) => {
    await page.evaluate(({ keys, key }) => {
      const root = document.querySelector("[data-lab]")!.shadowRoot!
      for (const name of keys) {
        const input = root.querySelector<HTMLInputElement>(`input[data-key="${name}"]`)
        if (!input) throw new Error(`Missing ${name}`)
        input.checked = key === "all" || key === name
        input.dispatchEvent(new Event("change"))
      }
    }, { keys, key })
    await step(4, 0)
  }
  const report: any = { baseline, timestamp: new Date().toISOString(), warmup: 1, measured: 7, samplesPerBlock: 24, views: [] }
  for (const view of diagnostic ? ["office"] : ["office", "downtown", "lot"]) {
    await page.goto(`${base}/?${view === "office" ? "sandbox=1&seed=4" : `practice&map=${view}&seed=4`}&manualVideo=1`, { waitUntil: "networkidle" })
    await page.waitForFunction("window.__gpuDevice && window.__stepManualVideo && document.querySelector('[data-lab]')", undefined, { polling: 100 })
    report.adapter = await page.evaluate(() => (window as any).__gpuAdapterInfo)
    if (report.adapter.vendor !== "apple" || !report.adapter.hasTimestampQuery || report.adapter.isFallbackAdapter) throw new Error("Apple hardware timestamps required")
    if (view !== "office") await page.evaluate(async view => {
      const world = (window as any).practice
      world.botFill = 1
      const modulePath = "/shared/sim/world.ts"
      const { NO_INTENT } = await import(/* @vite-ignore */ modulePath)
      for (const p of world.players.values()) if (p.brain) p.brain = { think: () => ({ ...NO_INTENT, aim: p.aim }) }
      const me = world.players.get("you")
      if (view === "lot") { me.x = 12; me.y = 9 }
      else {
        const road = world.map.roads.find((r: any) => r.rect[0] > 15 && r.rect[1] > 15)
        if (road) { me.x = (road.rect[0] + road.rect[2]) / 2; me.y = (road.rect[1] + road.rect[3]) / 2 }
      }
    }, view)
    await page.mouse.move(640, 400)
    await step(1)
    if (view === "office") {
      await page.keyboard.down("s"); await step(45); await page.keyboard.up("s")
    }
    await step(300)
    if (baseline) {
      await step(4, 0)
      await page.screenshot({ path: join(out, `${view}-main.png`) })
      await page.evaluate(() => (window as any).__clearGpuSamples())
      await step(24, 0)
      report.views.push({ view, samples: await page.evaluate(() => (window as any).__gpuSamples) })
      continue
    }
    const variants = view === "office" ? ["off", "all", ...keys] : ["off", "all"]
    for (const key of variants) {
      await set(key)
      await page.screenshot({ path: join(out, `${view}-${key}.png`) })
    }
    await set("off")
    await page.screenshot({ path: join(out, `${view}-off-repeat.png`) })
    if (!bench) continue
    const measure = async (key: string) => {
      await set(key)
      await page.evaluate(() => (window as any).__clearGpuSamples())
      await step(24, 0)
      return page.evaluate(() => {
        const samples = (window as any).__gpuSamples as { gpuHwMs: number; ranges: number[][] }[]
        if (samples.length !== 24 || samples.some(s => !(s.gpuHwMs > 0) || s.gpuHwMs > 1000 || s.ranges.some(r => r[1]! < r[0]!))) throw new Error("Invalid total GPU timestamps")
        return { ms: samples.reduce((a, s) => a + s.gpuHwMs, 0) / samples.length, samples }
      })
    }
    for (const key of view === "office" ? ["all", ...keys] : ["all"]) {
      const pairs = []
      for (let run = 0; run < 8; run++) {
        const a = await measure(run % 2 ? key : "off")
        const b = await measure(run % 2 ? "off" : key)
        const [off, on] = run % 2 ? [b, a] : [a, b]
        pairs.push({ run, warmup: run === 0, off, on, delta: on.ms - off.ms })
      }
      const sorted = pairs.slice(1).map(p => p.delta).sort((a, b) => a - b)
      const median = sorted[3]!
      const mad = sorted.map(x => Math.abs(x - median)).sort((a, b) => a - b)[3]!
      report.views.push({ view, key, median, mad, min: sorted[0], max: sorted[6], pairs })
      console.log(JSON.stringify({ view, key, median, mad }))
    }
  }
  if (errors.length) throw new Error(errors.join("\n"))
  writeFileSync(join(out, baseline ? "baseline.json" : bench ? "paired.json" : "proof.json"), JSON.stringify(report, null, 2))
  }
} finally {
  await browser.close()
  server.kill(); await server.exited
}
