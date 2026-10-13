import { chromium } from "playwright-core"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { findChromeExecutable } from "./compare"

const opt = (key: string, fallback: string) => process.argv.find((s) => s.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback
const game = opt("game", "blackout")
const ticks = Number(opt("ticks", "300"))
const out = join(import.meta.dir, "../../../captures/preview")
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ executablePath: findChromeExecutable(), headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist"] })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => { if (m.type() === "error" && !m.location().url.endsWith("favicon.ico")) errors.push(m.text()) })
  page.on("response", (r) => { if (r.status() >= 400 && !r.url().endsWith("favicon.ico")) errors.push(`${r.status()} ${r.url()}`) })
  await page.routeWebSocket("**", (socket) => {
    const server = socket.connectToServer()
    server.onMessage((message) => { if (!(typeof message === "string" && /"type":"(?:update|full-reload)"/.test(message))) socket.send(message) })
  })
  await page.addInitScript(({ game }) => {
    if (parent !== window || !location.pathname.endsWith("compare.html")) return
    const w = window as any
    let now = performance.now()
    const raf = window.requestAnimationFrame.bind(window)
    const completed = new MessageChannel()
    completed.port1.onmessage = () => w.__done?.()
    // Advance the actual parent clock and real iframe message handshake, without waiting five wall-clock minutes.
    performance.now = () => now
    window.requestAnimationFrame = (callback) => {
      if (callback.name !== "clock") return raf(callback)
      w.__clock = callback
      return 1
    }
    w.__proof = { ready: [null, null], perf: [null, null], pairs: 0, mismatch: [], last: [null, null] }
    addEventListener("message", (event) => {
      const panes = [...document.querySelectorAll("iframe")]
      const i = panes.findIndex((p) => p.contentWindow === event.source && new URL(p.src).origin === event.origin)
      if (i < 0 || event.data?.run !== new URL(panes[i]!.src).searchParams.get("muxRun")) return
      const p = w.__proof, m = event.data
      if (m.type === "mux-ready") p.ready[i] = m
      if (m.type === "arcade-perf") p.perf[i] = m
      if (m.type === "mux-state" || m.type === "mux-done") p.last[i] = m
      if (m.type === "mux-done") {
        const keys = game === "blackout" ? ["x", "y", "vx", "vy", "aim", "tx", "ty"] : ["x", "y", "vx", "vy", "h"]
        if (p.last[0]?.tick !== p.last[1]?.tick || keys.some((key) => p.last[0]?.[key] !== p.last[1]?.[key])) p.mismatch.push({ before: p.last[0], after: p.last[1] })
        p.pairs++
        // Let the production listener clear its in-flight tick before advancing the clock again.
        completed.port2.postMessage(null)
      }
    })
    w.__advance = async (count: number) => {
      for (let i = 0; i < count; i++) await new Promise<void>((resolve) => {
        w.__done = resolve
        now += 1000 / 60 + 0.001
        w.__clock(now)
      })
      return w.__proof
    }
  }, { game })
  const url = new URL("/compare.html", opt("base", `http://arcade-${game}.localhost:1355`))
  if (opt("before", "")) url.searchParams.set("before", opt("before", ""))
  await page.goto(url.href)
  await page.waitForFunction(() => (window as any).__proof?.ready.every(Boolean), null, { polling: 100, timeout: 30000 })
  console.log(`${game}: both clients ready`)
  const advance = async (count: number) => {
    await page.evaluate(async (n) => {
      await Promise.race([(window as any).__advance(n), new Promise((_, reject) => setTimeout(() => reject(new Error(`Lockstep proof timed out: ${document.querySelector("header")?.textContent} ${JSON.stringify((window as any).__proof.last)}`)), 120000))])
    }, count)
  }
  // Real keyboard events from both child panes and from the parent header.
  const initial = await page.evaluate(() => (window as any).__proof.ready)
  const frames = page.frames().filter((f) => f !== page.mainFrame())
  if (process.argv.includes("--lab")) {
    const after = frames[1]!
    const panel = after.locator("[data-lab]")
    await panel.locator("section").waitFor({ state: "visible" })
    await after.evaluate(async () => {
      const w = window as any
      w.__labProof = { leaked: [] }
      for (const type of ["mousedown", "mouseup", "keydown", "keyup", "wheel"]) window.addEventListener(type, () => w.__labProof.leaked.push(type))
      const rendererPath = "/src/render/renderer.ts"
      const renderer = (await import(/* @vite-ignore */ rendererPath)).Renderer.prototype
      const render = renderer.render
      renderer.render = function (input: any) {
        w.__labProof.uniform = Array.from(input.frame)
        w.__labProof.lightCount = input.lightCount ?? input.frame[42]
        render.call(this, input)
      }
    })
    if (await panel.locator('input:not([type="checkbox"]), textarea, [data-test]').count()) throw new Error("Lab has non-toggle controls")
    const buttons = await panel.locator("section button").allTextContents()
    if (JSON.stringify(buttons) !== JSON.stringify(["All On", "All Off"])) throw new Error(`Unexpected buttons: ${buttons}`)
    await panel.getByRole("button", { name: "All Off", exact: true }).click()
    if (await panel.locator('input[type="checkbox"]:checked').count()) throw new Error("Vanilla left effects enabled")
    await after.waitForFunction((game) => {
      const u = (window as any).__labProof.uniform
      return u && (game === "blackout" ? u[44] === 0 : u[64] === 1 && Math.abs(u[65] - 0.55) < 1e-5)
    }, game)
    await panel.getByRole("button", { name: "All On", exact: true }).click()
    if (await panel.locator('input[type="checkbox"]:not(:checked)').count()) throw new Error("All On left disabled effects")
    await after.waitForFunction((game) => {
      const u = (window as any).__labProof.uniform
      return game === "blackout" ? u[44] === 1 : Math.abs(u[64] - 1.4) < 1e-5 && Math.abs(u[65] - 1.2) < 1e-5
    }, game)
    for (const check of await panel.locator('input[type="checkbox"]').all()) {
      await check.uncheck()
      await check.check()
    }
    // Typing inside the panel must not reach gameplay listeners or mux forwarding.
    await panel.locator('input[type="checkbox"]').first().focus()
    await page.keyboard.press("w")
    const proof = await after.evaluate(() => (window as any).__labProof)
    if (proof.leaked.length) throw new Error(`Lab leaked input: ${proof.leaked}`)
    await page.screenshot({ path: join(out, `${game}-lab.png`) })
    writeFileSync(join(out, `${game}-lab-proof.json`), JSON.stringify({ ...proof, buttons, toggles: await panel.locator('input[type="checkbox"]').count() }, null, 2))
  }
  await frames[1]!.locator("canvas").first().click({ position: { x: 300, y: 380 } })
  await page.keyboard.down("w")
  await advance(Math.min(ticks, 180))
  await page.keyboard.up("w")
  await frames[0]!.locator("canvas").first().click({ position: { x: 300, y: 380 } })
  await page.keyboard.down("d")
  await advance(120)
  await page.keyboard.up("d")
  await page.locator("header").click({ position: { x: 10, y: 8 }, force: true })
  await page.keyboard.down(",")
  await advance(Math.max(1, ticks - Math.min(ticks, 180) - 120))
  await page.keyboard.up(",")
  await advance(10)
  // Blackout's AFTER panel uses shadow DOM; target its host directly.
  const hidden = (i: number) => frames[i]!.evaluate((before) => {
    const el = document.querySelector("[data-lab]")?.shadowRoot?.querySelector<HTMLElement>("section") ?? (before ? document.querySelector<HTMLElement>("#arcade-perf") : null)
    return el?.hidden
  }, i === 0)
  await page.keyboard.press("Backquote")
  await advance(1)
  if (!(await hidden(0)) || !(await hidden(1))) throw new Error("Backquote did not hide both perf panels")
  await page.keyboard.press("Backquote")
  await advance(1)
  if (await hidden(0) || await hidden(1)) throw new Error("Backquote did not show both perf panels")
  await page.waitForFunction(() => (window as any).__proof.perf.every((p: any) => p?.gpuMs > 0 && p.draws > 0 && p.verts > 0 && p.lights > 0), null, { polling: 100, timeout: 15000 })
  const result = await page.evaluate(() => (window as any).__proof)
  if (result.mismatch.length) throw new Error(`State drift: ${JSON.stringify(result.mismatch[0])}`)
  if (result.last.every((s: any, i: number) => s.x === initial[i].x && s.y === initial[i].y)) throw new Error("Controls did not move the players")
  await page.locator("#overlay").click({ force: true })
  await page.locator("#wipe").evaluate((input: HTMLInputElement) => { input.value = "35"; input.dispatchEvent(new Event("input", { bubbles: true })) })
  await advance(10)
  const dimensions = await page.locator("iframe").evaluateAll((panes) => panes.map((p) => [p.clientWidth, p.clientHeight]))
  if (JSON.stringify(dimensions[0]) !== JSON.stringify(dimensions[1])) throw new Error("Wipe projection sizes differ")
  await page.screenshot({ path: join(out, `${game}-compare-wipe.png`) })
  await page.locator("#split").click({ force: true })
  await page.screenshot({ path: join(out, `${game}-compare-split.png`) })
  const oldRun = result.ready[0].run
  await page.locator("#reset").click({ force: true })
  await page.waitForFunction((run) => (window as any).__proof.ready.every((m: any) => m?.run && m.run !== run), oldRun, { polling: 100, timeout: 30000 })
  const reset = await page.evaluate(() => (window as any).__proof.ready)
  if (reset.some((s: any, i: number) => s.x !== initial[i].x || s.y !== initial[i].y || s.map !== initial[i].map)) throw new Error("Reset changed seeded spawn")
  if (errors.length) throw new Error(errors.join("\n"))
  const report = { game, ticks: result.pairs, simulatedSeconds: result.pairs / 60, initial, final: result.last, perf: result.perf, mismatches: result.mismatch.length, wipeDimensions: dimensions, reset }
  writeFileSync(join(out, `${game}-compare-proof.json`), JSON.stringify(report, null, 2) + "\n")
  console.log(JSON.stringify(report))
} finally {
  await browser.close()
}
