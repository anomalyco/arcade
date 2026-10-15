// Headless Metal proof for world-anchored action callouts: one still per callout type from scripted, deterministic
// inputs, plus the per-frame cost of the HUD update. Run from games/outbreak: bun scripts/hud-proof.ts
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium, type Page } from "playwright-core"
import { createServer } from "vite"

const root = resolve(import.meta.dir, "..")
const out = resolve(process.env.HUD_OUT ?? resolve(root, "../../captures/outbreak-hud"))
mkdirSync(out, { recursive: true })

const server = await createServer({
  root,
  logLevel: "warn",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "hud-proof-hooks",
      enforce: "pre",
      transform(code, id) {
        if (id !== resolve(root, "src/main.ts")) return
        return code.replace("const harness = {", "const harness = { hud, renderer, session: () => session,")
      },
    },
  ],
})
await server.listen()
const port = (server.httpServer!.address() as { port: number }).port
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`)
  .find(existsSync)
assert(chrome, "Playwright Chromium binary not found")
const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})

type Shot = { name: string; caption: string; file: string; crop: string; callouts: unknown[] }
const shots: Shot[] = []

async function stage(page: Page, s: { x: number; y: number; aim: number; zoom?: number; hour?: number; look?: string; zombies?: number }) {
  await page.evaluate(async (s) => {
    const h = (window as any).__arcadeHarness
    h.freeze(true)
    h.reset(7)
    h.setLab("timeScale", 0)
    h.setLab("hour", s.hour ?? 19)
    h.setLab("zoom", s.zoom ?? 34)
    h.setLab("zombieCount", s.zombies ?? 0)
    h.setLookPreset(s.look ?? "current")
    h.pose(s.x, s.y, s.aim)
    for (let i = 0; i < 6; i++) await h.step()
  }, s)
}

async function step(page: Page, n = 1, command: Record<string, unknown> = {}) {
  await page.evaluate(
    async ({ n, command }) => {
      const h = (window as any).__arcadeHarness
      const p = h.state().player
      for (let i = 0; i < n; i++) await h.step(1 / 60, { aim: p.aim, ...command })
    },
    { n, command },
  )
}

async function mutate(page: Page, patch: Record<string, unknown>) {
  await page.evaluate((patch) => Object.assign((window as any).__arcadeHarness.state().player, patch), patch)
}

async function snap(page: Page, name: string, caption: string) {
  const callouts = await page.evaluate(() => (window as any).__arcadeHarness.callouts())
  const file = resolve(out, `${name}.png`)
  await page.screenshot({ path: file })
  // Close crop around the survivor at the same scale the player sees it.
  const box = await page.evaluate(() => (window as any).__arcadeHarness.resolveTargetRect({ objectId: "player" }))
  const vw = page.viewportSize()!
  const cx = box ? box.x + box.width / 2 : vw.width / 2
  const cy = box ? box.y + box.height / 2 : vw.height / 2
  const clip = { x: Math.max(0, cx - 260), y: Math.max(0, cy - 230), width: 520, height: 330 }
  const crop = resolve(out, `${name}-crop.png`)
  await page.screenshot({ path: crop, clip })
  shots.push({ name, caption, file, crop, callouts })
}

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text())
  })
  await page.goto(`http://127.0.0.1:${port}/?seed=7&bench`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 120_000 })
  const adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
  assert.match(adapter.architecture, /metal/)

  // Reload in progress.
  await stage(page, { x: 30, y: 41, aim: -Math.PI / 2, zoom: 42, hour: 18 })
  await mutate(page, { magAmmo: 2 })
  await step(page, 1, { reload: true })
  await step(page, 32)
  await snap(page, "reload", "Reload in progress: ring fills over 1.15 s")
  await step(page, 40)
  await snap(page, "reloaded", "Reload finished: the ring turns into the loaded count")

  // Search and loot pops.
  const container = await page.evaluate(() => {
    const st = (window as any).__arcadeHarness.state()
    const c = st.containers.find((x: any) => x.ammo > 0 && x.planks > 0) ?? st.containers.find((x: any) => x.ammo > 0)
    return { x: c.x, y: c.y, label: c.label }
  })
  await stage(page, { x: container.x, y: container.y + 0.75, aim: -Math.PI / 2 })
  await step(page, 1, { interact: true })
  await step(page, 24)
  await snap(page, "search", `Searching the ${container.label}`)
  await step(page, 40)
  await snap(page, "loot", "Loot pops float up and fade")

  // Empty gun: warning plus the noise the shot made.
  await stage(page, { x: 30, y: 41, aim: -Math.PI / 2, zoom: 42, hour: 18 })
  await mutate(page, { magAmmo: 1, reserveAmmo: 0 })
  await step(page, 1, { fire: true })
  await step(page, 20)
  await step(page, 1, { fire: true })
  await step(page, 10)
  await snap(page, "out-of-ammo", "Out of ammo warning, with the gunshot's noise radius")

  // Barricade with the door prompt beside the door.
  await stage(page, { x: 27.7, y: 36.2, aim: -Math.PI / 2 })
  await step(page, 1, { barricade: true })
  await step(page, 22)
  await snap(page, "barricade", "Boarding up the door; the E / Hold E prompt stays on the door")
  await step(page, 30)
  await snap(page, "barricaded", "Barricade result")

  // Door open, then flashlight off and a slot change stacked on top.
  await stage(page, { x: 27.7, y: 36.2, aim: -Math.PI / 2 })
  await step(page, 1, { interact: true })
  await step(page, 12)
  await snap(page, "door", "Door opened")
  await step(page, 1, { flashlight: true })
  await step(page, 8)
  await step(page, 1, { melee: true })
  await step(page, 8)
  await snap(page, "stack", "Three callouts stacked, newest on top")

  // Exhausted from sprinting.
  await stage(page, { x: 30, y: 41, aim: 0, zoom: 42, hour: 18 })
  await mutate(page, { stamina: 0.04 })
  await step(page, 30, { mx: 1, sprint: true })
  await step(page, 6)
  await snap(page, "exhausted", "Stamina ran out while sprinting")

  // Spotted and hurt by a real zombie attack.
  await stage(page, { x: 30, y: 41, aim: 0, zoom: 42, hour: 18 })
  await page.evaluate(() => (window as any).__arcadeHarness.spawnZombie(32.2, 41, "chase", Math.PI))
  let hurt = false
  for (let i = 0; i < 40 && !hurt; i++) {
    await step(page, 6)
    hurt = await page.evaluate(() => (window as any).__arcadeHarness.state().player.health < 100)
  }
  assert(hurt, "zombie did not land a hit")
  await step(page, 4)
  await snap(page, "hurt", "Spotted, then hurt by a zombie")

  // Looks.
  for (const look of ["noir", "sodium_70s"]) {
    await stage(page, { x: container.x, y: container.y + 0.75, aim: -Math.PI / 2, look })
    await step(page, 1, { interact: true })
    await step(page, 58)
    await snap(page, `look-${look}`, `Loot pops under the ${look === "noir" ? "Noir" : "70s sodium"} look`)
  }

  // Bottom-left log fallback.
  await stage(page, { x: 27.7, y: 36.2, aim: -Math.PI / 2 })
  await page.evaluate(() => (window as any).__arcadeHarness.setLab("hudMode", 1))
  await step(page, 1, { barricade: true })
  await step(page, 20)
  await snap(page, "log-mode", "Lab HUD > Action feedback: Bottom-left log restores the old status line")
  await page.evaluate(() => (window as any).__arcadeHarness.setLab("hudMode", 0))

  // Reduced motion: no drift.
  await page.emulateMedia({ reducedMotion: "reduce" })
  await stage(page, { x: 30, y: 41, aim: -Math.PI / 2, zoom: 42, hour: 18 })
  const reduced = await page.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    const c = h.hud.layer.callout("local", "+6 9mm", "result")
    for (let i = 0; i < 30; i++) await h.step()
    return { reducedMotion: h.hud.layer.reducedMotion, drift: h.hud.layer.model.drift(c, h.hud.layer.reducedMotion) }
  })
  assert.equal(reduced.reducedMotion, true)
  assert.equal(reduced.drift, 0)
  await page.emulateMedia({ reducedMotion: "no-preference" })

  // Per-frame cost of hud.update while three callouts are always visible, in real-time play.
  const cost = await page.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    h.freeze(true)
    h.reset(7)
    h.setLab("timeScale", 0)
    h.setLab("zoom", 42)
    h.setLookPreset("current")
    h.pose(30, 41, -Math.PI / 2)
    await h.step()
    const samples: number[] = []
    const orig = h.hud.update.bind(h.hud)
    let n = 0
    h.hud.update = (...args: unknown[]) => {
      if (n++ % 12 === 0) {
        h.hud.layer.callout("local", `+${n % 9} 9mm`, "result")
        h.hud.layer.callout("local", "Reloading", "progress", { key: "reload", progress: (n % 60) / 60, duration: 1 })
      }
      const t0 = performance.now()
      orig(...args)
      samples.push(performance.now() - t0)
    }
    h.freeze(false)
    await new Promise((r) => setTimeout(r, 4000))
    h.freeze(true)
    h.hud.update = orig
    samples.sort((a, b) => a - b)
    const q = (p: number) => samples[Math.min(samples.length - 1, Math.floor(p * (samples.length - 1)))]!
    const meanMs = samples.reduce((a, b) => a + b, 0) / samples.length
    return { frames: samples.length, meanMs, medianMs: q(0.5), p95Ms: q(0.95), p99Ms: q(0.99), maxMs: samples.at(-1)! }
  })
  console.log("hud.update cost", cost)

  // Paired A/B on the same page: live play with callouts constantly visible versus the old bottom-left log, in
  // alternating 3 s blocks. Style and layout time come from Chrome's own counters, which JS timers miss.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Performance.enable")
  const metrics = async () =>
    Object.fromEntries(((await cdp.send("Performance.getMetrics")) as any).metrics.map((m: any) => [m.name, m.value]))
  const ab: Record<string, { styleLayoutMsPerFrame: number[]; scriptMsPerFrame: number[]; frames: number[] }> = {
    callouts: { styleLayoutMsPerFrame: [], scriptMsPerFrame: [], frames: [] },
    log: { styleLayoutMsPerFrame: [], scriptMsPerFrame: [], frames: [] },
  }
  for (const round of [0, 1, 2]) {
    for (const mode of round % 2 ? (["log", "callouts"] as const) : (["callouts", "log"] as const)) {
      await page.evaluate((mode) => {
        const h = (window as any).__arcadeHarness
        h.freeze(true)
        h.setLab("hudMode", mode === "log" ? 1 : 0)
        const w = window as any
        w.__abFrames = 0
        w.__abTimer = setInterval(() => {
          if (mode === "callouts") {
            h.hud.layer.callout("local", `+${(w.__abFrames % 9) + 1} 9mm`, "result")
            h.hud.layer.callout("local", "Reloading", "progress", { key: "reload", progress: 0.5, duration: 1 })
          }
        }, 200)
        const orig = h.renderer.render.bind(h.renderer)
        w.__abRestore = () => (h.renderer.render = orig)
        h.renderer.render = (...args: unknown[]) => {
          w.__abFrames++
          return orig(...args)
        }
        h.freeze(false)
      }, mode)
      const before = await metrics()
      await page.waitForTimeout(3000)
      const after = await metrics()
      const frames = await page.evaluate(() => {
        const w = window as any
        w.__arcadeHarness.freeze(true)
        clearInterval(w.__abTimer)
        w.__abRestore()
        return w.__abFrames as number
      })
      const d = (k: string) => (after[k] - before[k]) * 1000
      ab[mode].frames.push(frames)
      ab[mode].styleLayoutMsPerFrame.push((d("RecalcStyleDuration") + d("LayoutDuration")) / Math.max(1, frames))
      ab[mode].scriptMsPerFrame.push(d("ScriptDuration") / Math.max(1, frames))
    }
  }
  await page.evaluate(() => (window as any).__arcadeHarness.setLab("hudMode", 0))
  console.log("paired A/B per frame", JSON.stringify(ab, null, 1))
  assert(cost.frames > 60, "too few frames sampled")
  assert(cost.p95Ms < 0.5, `hud.update p95 ${cost.p95Ms} ms`)
  assert.deepEqual(errors, [])
  writeFileSync(resolve(out, "summary.json"), JSON.stringify({ adapter, cost, ab, reduced, shots }, null, 2))
  console.log(`wrote ${shots.length} stills to ${out}`)
} finally {
  await browser.close()
  await server.close()
}
