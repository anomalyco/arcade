/// <reference types="@webgpu/types" />
// Radial menu latency benchmark (headless Chrome, Metal WebGPU, Getaway Lab with a live render loop).
// bun packages/kit/lab/bench-radial.ts --label before [--runs 7] [--out dir] [--shots]
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { chromium, type Page } from "playwright-core"
import { createServer } from "vite"

const { values: flags } = parseArgs({
  options: {
    label: { type: "string", default: "run" },
    runs: { type: "string", default: "7" },
    out: { type: "string", default: resolve(import.meta.dir, "../../../captures/radial-bench") },
    shots: { type: "boolean", default: false },
    // Scene loop on matches the live Lab; off isolates the menu from headless WebGPU presentation cost.
    loop: { type: "string", default: "on" },
  },
})
const runs = Number(flags.runs)
const out = resolve(flags.out!)
mkdirSync(out, { recursive: true })

const root = resolve(import.meta.dir, "../../..")
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
// headless-shell paces frames near display rate; full headless Chrome on a display-less Mac paces at ~13 fps.
const newest = (re: RegExp) => readdirSync(cache).filter(n => re.test(n)).sort((a, b) => Number(b.split("-").pop()) - Number(a.split("-").pop()))
const executablePath =
  newest(/^chromium_headless_shell-\d+$/).map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync) ??
  newest(/^chromium-\d+$/).map(n => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})
const dir = resolve(root, "games/lab")
const server = await createServer({ root: dir, configFile: resolve(dir, "vite.config.ts"), server: { host: "127.0.0.1", port: 0 } })
await server.listen()
const addr = server.httpServer!.address()
if (!addr || typeof addr === "string") throw new Error("No port")

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)]! : NaN
}
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))]! : NaN
}

async function instrument(page: Page) {
  await page.evaluate(() => {
    const w = window as any
    const r: any = (w.__rb = { pending: null, samples: [], handler: [], frames: [], loop: true })
    // Live render loop equivalent to the non-bench Lab tick.
    let last = 0
    r.frameNo = 0
    const tick = async (now: number) => {
      r.frameNo++
      r.lastFrameTs = now
      if (last) r.frames.push(now - last)
      last = now
      if (r.loop) {
        w.lab.advance(1 / 60)
        await w.lab.render()
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    const mc = new MessageChannel()
    let onPaint: (() => void) | null = null
    mc.port1.onmessage = () => onPaint?.()
    const root = () => document.querySelector<HTMLElement>("[data-lab-radial]")!
    // Input time: the latest event seen at window capture (pointerover still reaches window when a
    // handler detaches the hit-tested node before the matching pointermove is dispatched).
    for (const type of ["pointerdown", "pointerup", "pointermove", "pointerover", "keydown"]) {
      window.addEventListener(type, (e: Event) => { r.start = performance.now(); r.ts = e.timeStamp; r.inputFrame = r.frameNo }, { capture: true })
    }
    // Pointermoves dispatched while open vs those that bubbled to window (a handler that detaches the
    // hit-tested node drops the event before the viewport listener sees it).
    r.dispatched = 0
    window.addEventListener("pointermove", () => { if (!root().hidden) r.dispatched++ }, { capture: true })
    window.addEventListener("pointermove", () => {
      if (!root().hidden) r.handler.push(performance.now() - r.start)
    })
    // Visual state: checked at the microtask checkpoint right after the mutating handler.
    new MutationObserver(() => {
      const p = r.pending
      if (!p || !p.check()) return
      r.pending = null
      const ts = r.ts
      const inputFrame = r.inputFrame
      const handlerMs = performance.now() - r.start
      requestAnimationFrame(now => {
        const frames = (now === r.lastFrameTs ? r.frameNo : r.frameNo + 1) - inputFrame
        const rafStart = performance.now()
        onPaint = () => {
          onPaint = null
          const t = performance.now()
          r.samples.push({ kind: p.kind, latency: t - ts, handlerMs, frames, renderMs: t - rafStart })
        }
        mc.port2.postMessage(0)
      })
    }).observe(root(), { attributes: true, childList: true, subtree: true })
    w.__expect = (kind: string, types: string[], check: string) => {
      r.pending = { kind, types, check: new Function(`return (${check})`) }
      if (r.pending.check()) throw new Error(`expectation already true: ${kind}`)
    }
  })
}

const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors: string[] = []
page.on("pageerror", e => errors.push(e.message))
await page.addInitScript(() => {
  window.AudioContext = class {
    constructor() {
      throw new Error("audio disabled")
    }
  } as any
})
await page.goto(`http://127.0.0.1:${addr.port}/?bench`)
await page.waitForFunction(() => !!(window as any).lab, undefined, { timeout: 45000 })
const cdp = await page.context().newCDPSession(page)
await cdp.send("Performance.enable")
const metrics = async () => {
  const { metrics: m } = await cdp.send("Performance.getMetrics")
  const get = (k: string) => (m.find(x => x.name === k)?.value ?? 0) * 1000
  return { task: get("TaskDuration"), script: get("ScriptDuration"), layout: get("LayoutDuration"), style: get("RecalcStyleDuration") }
}
const adapter = await page.evaluate(() => (window as any).lab.adapter.architecture)
await page.getByRole("button", { name: "Category Effects", exact: true }).click()
await page.locator('[data-catalog-id="fixture:car-cones"]').click()
await page.locator("canvas").focus()
await page.keyboard.press("Escape")
// Centre the cone row so object taps land on the canvas, clear of the viewport HUD.
await page.evaluate(async () => {
  const lab = (window as any).lab
  lab.context.stage.frameTarget(0, 0.4, -1, 16)
  for (let i = 0; i < 150; i++) {
    lab.advance(1 / 60)
    await lab.render()
  }
})
await instrument(page)
await page.evaluate(on => ((window as any).__rb.loop = on), flags.loop === "on")
await page.waitForTimeout(500)

const locate = () => page.evaluate(() => {
  const st = (window as any).lab.context.stage
  const vp = document.querySelector("canvas")!.getBoundingClientRect()
  const objs = (window as any).lab.workbench.state().objects as any[]
  const cone = objs.find(o => o.label === "Cone #2") ?? objs.find(o => o.category === "prop")
  const p = st.projectWorld(cone.x, cone.y + 0.35, cone.z)
  return {
    cone: { x: vp.left + p.u * vp.width, y: vp.top + p.v * vp.height },
    ground: { x: vp.left + vp.width * 0.3, y: vp.top + vp.height * 0.72 },
    vp: { left: vp.left, top: vp.top, width: vp.width, height: vp.height },
  }
})

const PIPELINE = ["EventDispatch", "UpdateLayoutTree", "Layout", "PrePaint", "Paint", "Layerize", "RasterTask", "CompositeLayers"]

async function waitSample(n: number) {
  try {
    await page.waitForFunction(k => (window as any).__rb.samples.length >= k, n, { timeout: 5000 })
  } catch (e) {
    console.error(await page.evaluate(() => {
      const w = window as any
      const s = w.lab.workbench.radial.state
      return { ctx: s.ringContext, pending: w.__rb.pending?.kind, n: w.__rb.samples.length, phase: s.phase, slot: s.activeSlot, zone: s.zone, vx: s.visualX, vy: s.visualY, active: [...document.querySelectorAll("[data-lab-radial] [data-active=true]")].map(e => (e as HTMLElement).dataset.sector) }
    }))
    throw e
  }
}
const radialHidden = () => page.evaluate(() => document.querySelector<HTMLElement>("[data-lab-radial]")!.hidden)
const radialCenter = () =>
  page.evaluate(() => {
    const s = (window as any).lab.workbench.radial.state
    const vp = document.querySelector("[data-lab-viewport]")!.getBoundingClientRect()
    return { x: vp.left + s.visualX, y: vp.top + s.visualY }
  })

async function closeMenu() {
  if (!(await radialHidden())) await page.keyboard.press("Escape")
  await page.waitForTimeout(60)
}

let points = await locate()
async function measureRun(record: boolean) {
  points = await locate()
  const before = await page.evaluate(() => (window as any).__rb.samples.length)
  let n = before
  // Ground RMB tap: opens on pointerup.
  await page.mouse.move(points.ground.x, points.ground.y)
  await page.waitForTimeout(40)
  await page.evaluate(() => (window as any).__expect("open-ground", ["pointerup"], `!document.querySelector("[data-lab-radial]").hidden`))
  await page.mouse.down({ button: "right" })
  await page.mouse.up({ button: "right" })
  await waitSample(++n)
  // Hover sector changes, 8 directions at 70 px.
  const c = await radialCenter()
  for (let i = 0; i < 8; i++) {
    const slot = (i + 2) % 8
    const a = (slot * Math.PI) / 4
    await page.evaluate(
      s => (window as any).__expect("hover", ["pointermove"], `document.querySelector('[data-lab-radial] [data-sector="${s}"]').dataset.active === "true"`),
      slot,
    )
    await page.mouse.move(c.x + Math.sin(a) * 70, c.y - Math.cos(a) * 70)
    await waitSample(++n)
  }
  // Sweep: continuous circular motion while open (frame drop + handler cost).
  await page.evaluate(() => {
    const r = (window as any).__rb
    r.frames.length = 0
    r.handler.length = 0
    r.dispatched = 0
  })
  await browser.startTracing(page, { categories: ["devtools.timeline", "disabled-by-default-devtools.timeline"] })
  const m0 = await metrics()
  const t0 = Date.now()
  let k = 0
  while (Date.now() - t0 < 1000) {
    const a = k++ * 0.09
    await page.mouse.move(c.x + Math.sin(a) * 75, c.y - Math.cos(a) * 75)
    await page.waitForTimeout(8)
  }
  const m1 = await metrics()
  const trace = JSON.parse((await browser.stopTracing()).toString()) as { traceEvents: { name: string; dur?: number; ph: string }[] }
  const pipeline: Record<string, number> = {}
  for (const e of trace.traceEvents) {
    if (e.ph === "X" && e.dur && PIPELINE.includes(e.name)) pipeline[e.name] = (pipeline[e.name] ?? 0) + e.dur / 1000
  }
  const sweep = await page.evaluate(() => {
    const r = (window as any).__rb
    return { frames: [...r.frames], handler: [...r.handler], dispatched: r.dispatched }
  })
  const moves = Math.max(1, k)
  const cost = {
    taskPerMove: (m1.task - m0.task) / moves,
    scriptPerMove: (m1.script - m0.script) / moves,
    layoutPerMove: (m1.layout - m0.layout) / moves,
    stylePerMove: (m1.style - m0.style) / moves,
    ...Object.fromEntries(PIPELINE.map(n => [`${n}PerMove`, (pipeline[n] ?? 0) / moves])),
  }
  await closeMenu()
  // Object RMB tap.
  points = await locate()
  await page.mouse.move(points.cone.x, points.cone.y)
  await page.waitForTimeout(40)
  points = await locate()
  await page.mouse.move(points.cone.x, points.cone.y)
  await page.evaluate(() => (window as any).__expect("open-object", ["pointerup"], `!document.querySelector("[data-lab-radial]").hidden && document.querySelector("[data-lab-radial]").dataset.context === "object"`))
  await page.mouse.down({ button: "right" })
  await page.mouse.up({ button: "right" })
  await waitSample(++n)
  await closeMenu()
  // Keyboard menu key (M is mute).
  await page.locator("canvas").focus()
  await page.evaluate(() => (window as any).__expect("open-key", ["keydown"], `!document.querySelector("[data-lab-radial]").hidden`))
  await page.keyboard.press("ContextMenu")
  await waitSample(++n)
  await closeMenu()
  const samples = await page.evaluate(k => (window as any).__rb.samples.slice(k), before)
  return record ? { samples, sweep, cost } : null
}

await measureRun(false)
const all: { samples: any[]; sweep: { frames: number[]; handler: number[]; dispatched: number }; cost: Record<string, number> }[] = []
for (let i = 0; i < runs; i++) all.push((await measureRun(true))!)

const byKind = (kind: string, key: "latency" | "handlerMs" | "renderMs") => all.flatMap(r => r.samples.filter(s => s.kind === kind).map(s => s[key]))
const kinds = ["open-ground", "open-object", "open-key", "hover"]
const frames = all.flatMap(r => r.sweep.frames)
const handler = all.flatMap(r => r.sweep.handler)
const summary = {
  label: flags.label,
  loop: flags.loop,
  browser: executablePath?.split("/").pop(),
  adapter,
  runs,
  viewport: "1280x800",
  latencyMs: Object.fromEntries(
    kinds.map(k => {
      const xs = byKind(k, "latency")
      const fr = all.flatMap(r => r.samples.filter(s => s.kind === k).map(s => s.frames))
      return [k, { median: +median(xs).toFixed(2), min: +Math.min(...xs).toFixed(2), max: +Math.max(...xs).toFixed(2), n: xs.length, framesMedian: median(fr), framesMax: Math.max(...fr) }]
    }),
  ),
  handlerMs: Object.fromEntries(
    kinds.map(k => {
      const xs = byKind(k, "handlerMs")
      return [k, { median: +median(xs).toFixed(3), max: +Math.max(...xs).toFixed(3) }]
    }),
  ),
  // rAF of the first frame showing the change -> after that frame's style/layout/paint (main thread).
  frameRenderMs: Object.fromEntries(
    kinds.map(k => {
      const xs = byKind(k, "renderMs")
      return [k, { median: +median(xs).toFixed(3), max: +Math.max(...xs).toFixed(3) }]
    }),
  ),
  openSweep: {
    pointermoves: handler.length,
    pointermovesDispatched: all.reduce((a, r) => a + r.sweep.dispatched, 0),
    handlerMedianMs: +median(handler).toFixed(3),
    handlerP95Ms: +pct(handler, 0.95).toFixed(3),
    frameMedianMs: +median(frames).toFixed(2),
    frameP95Ms: +pct(frames, 0.95).toFixed(2),
    framesOver25ms: frames.filter(f => f > 25).length,
    frames: frames.length,
    mainThreadPerMoveMs: Object.fromEntries(
      ["taskPerMove", "scriptPerMove", "layoutPerMove", "stylePerMove", ...PIPELINE.map(n => `${n}PerMove`)].map(key => [key, +median(all.map(r => r.cost[key]!)).toFixed(3)]),
    ),
  },
  errors,
  raw: all.map(r => r.samples),
}
writeFileSync(resolve(out, `bench-${flags.label}-loop-${flags.loop}.json`), JSON.stringify(summary, null, 2))
console.log(JSON.stringify({ ...summary, raw: undefined }, null, 2))

if (flags.shots) {
  await page.evaluate(() => ((window as any).__rb.loop = true))
  const shot = async (name: string) => {
    await page.waitForTimeout(250)
    const c = await radialCenter()
    const x = Math.max(0, Math.round(c.x - 200))
    const y = Math.max(0, Math.round(c.y - 170))
    await page.screenshot({ path: resolve(out, `${flags.label}-${name}.png`), clip: { x, y, width: 400, height: 340 } })
  }
  // Ground context, latched, active sector E.
  points = await locate()
  await page.mouse.move(points.ground.x, points.ground.y)
  await page.mouse.down({ button: "right" })
  await page.mouse.up({ button: "right" })
  let c = await radialCenter()
  await page.mouse.move(c.x + 70, c.y)
  await shot("ground-active")
  await closeMenu()
  // Object context (cone): latched, hover the disabled Possess slot (NE).
  points = await locate()
  await page.mouse.move(points.cone.x, points.cone.y)
  points = await locate()
  await page.mouse.move(points.cone.x, points.cone.y)
  await page.mouse.down({ button: "right" })
  await page.mouse.up({ button: "right" })
  c = await radialCenter()
  await page.mouse.move(c.x + 3, c.y + 3)
  await shot("object-open")
  await page.mouse.move(c.x + 50, c.y - 50)
  await shot("object-disabled")
  await page.mouse.move(c.x - 70, c.y)
  await shot("object-active")
  await closeMenu()
  await page.screenshot({ path: resolve(out, `${flags.label}-full.png`) })
}

await browser.close()
await server.close()
