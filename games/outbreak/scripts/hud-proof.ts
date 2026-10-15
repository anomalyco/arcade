// Headless Metal proof for the character HUD: callout placements, stamina/reload/health/battery rings, a teammate's
// HUD and a crowded moment, in Noir and 70s sodium at a street and an interior, plus the per-frame HUD cost.
// Deterministic inputs; no visible window, no audio. Run from games/outbreak: bun scripts/hud-proof.ts
// Then: python3 scripts/hud-sheet.py
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

type Shot = { name: string; caption: string; file: string; crop: string; callouts: unknown[]; hud: unknown }
const shots: Shot[] = []
const LOOKS = { noir: "Noir", sodium_70s: "70s sodium" } as const
type Look = keyof typeof LOOKS
const PLACEMENTS = [
  { value: 0, name: "below", label: "Below" },
  { value: 1, name: "above", label: "Above" },
  { value: 2, name: "beside", label: "Beside" },
] as const

type Stage = { x: number; y: number; aim: number; zoom?: number; hour?: number; look?: string; zombies?: number; hud?: Record<string, number | boolean> }

async function stage(page: Page, s: Stage) {
  await page.evaluate(async (s) => {
    const h = (window as any).__arcadeHarness
    h.freeze(true)
    h.reset(7)
    h.setLab("timeScale", 0)
    h.setLab("hour", s.hour ?? 19)
    h.setLab("zoom", s.zoom ?? 34)
    h.setLab("zombieCount", s.zombies ?? 0)
    h.setLab("calloutPlacement", 0)
    h.setLab("vitalsPlacement", 0)
    h.setLab("avoidAim", true)
    for (const [k, v] of Object.entries(s.hud ?? {})) h.setLab(k, v)
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

/** The same three callouts for every placement: an action in progress, a loot pop and a noise. */
async function stagedStack(page: Page) {
  await page.evaluate(() => {
    const layer = (window as any).__arcadeHarness.hud.layer
    layer.callout("local", "Reloading", "progress", { key: "reload", progress: 0.55, duration: 30 })
    layer.callout("local", "+6 9mm", "result", { duration: 30 })
    layer.callout("local", "Noise 18 m", "noise", { key: "noise", duration: 30 })
  })
}

/** Adds an offline teammate drawn and HUD-wired exactly like a remote co-op survivor. */
async function teammate(page: Page, patch: Record<string, unknown>) {
  await page.evaluate((patch) => {
    const h = (window as any).__arcadeHarness
    const sim = h.session().sim
    const slot = sim.slots.find((s: any) => s.id === "Wren") ?? sim.addSurvivor("Wren", 1)
    Object.assign(slot.survivor, { flashlightOn: true, flashlightOutput: 1 }, patch)
  }, patch)
}

async function snap(page: Page, name: string, caption: string, focus: "player" | { x: number; y: number } = "player") {
  const state = await page.evaluate(() => {
    const h = (window as any).__arcadeHarness
    return { callouts: h.callouts(), hud: h.hudState() }
  })
  const file = resolve(out, `${name}.png`)
  await page.screenshot({ path: file })
  // Close crop around the survivor at the same scale the player sees it.
  const box =
    focus === "player"
      ? await page.evaluate(() => (window as any).__arcadeHarness.resolveTargetRect({ objectId: "player" }))
      : { x: focus.x, y: focus.y, width: 0, height: 0 }
  const vw = page.viewportSize()!
  const cx = box ? box.x + box.width / 2 : vw.width / 2
  const cy = box ? box.y + box.height / 2 : vw.height / 2
  const clip = { x: Math.max(0, Math.min(vw.width - 420, cx - 210)), y: Math.max(0, Math.min(vw.height - 280, cy - 140)), width: 420, height: 280 }
  const crop = resolve(out, `${name}-crop.png`)
  await page.screenshot({ path: crop, clip })
  shots.push({ name, caption, file, crop, ...state })
  return state
}

const hudOf = (state: { hud: any }, id = "local") => state.hud[id] as { callouts: string; rings: string; meters: { id: string; state: string; fill: number }[] }

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

  const container = await page.evaluate(() => {
    const st = (window as any).__arcadeHarness.state()
    const c = st.containers.find((x: any) => x.kind === "dresser")
    return { x: c.x, y: c.y, label: c.label }
  })
  const PLACES = {
    street: { x: 30, y: 41, label: "street" },
    interior: { x: container.x, y: container.y + 0.75, label: "interior" },
  } as const

  // 1. Placement comparison: identical staged callouts and a draining stamina ring, each placement, look and place.
  for (const [place, at] of Object.entries(PLACES)) {
    for (const look of Object.keys(LOOKS) as Look[]) {
      for (const pl of PLACEMENTS) {
        await stage(page, { x: at.x, y: at.y, aim: 0, zoom: 34, hour: 21, look, hud: { calloutPlacement: pl.value } })
        await mutate(page, { stamina: 0.62 })
        await stagedStack(page)
        await step(page, 14, { sprint: true, mx: 0.001 })
        await mutate(page, { x: at.x, y: at.y, vx: 0, vy: 0 })
        await step(page, 2, { sprint: true, mx: 0.001 })
        const st = await snap(page, `place-${pl.name}-${look}-${place}`, `${pl.label} · ${LOOKS[look]} · ${at.label}`)
        assert.equal(hudOf(st).callouts, pl.name === "below" ? "down" : pl.name === "above" ? "up" : "left", `${pl.name} side`)
        assert(hudOf(st).meters.some((m) => m.id === "stamina"), "stamina ring visible while draining")
      }
    }
  }

  // 2. Aiming into the callouts' side moves them to the other side, clear of the beam's near field.
  await stage(page, { x: 30, y: 41, aim: Math.PI / 2, zoom: 34, hour: 21, look: "noir" })
  await stagedStack(page)
  await step(page, 20)
  let st = await snap(page, "aim-down-flip", "Aiming down: callouts move above so the beam's near field stays clear")
  assert.equal(hudOf(st).callouts, "up")
  await page.evaluate(() => (window as any).__arcadeHarness.setLab("avoidAim", false))
  await step(page, 20)
  st = await snap(page, "aim-down-noflip", "Same frame with Keep clear of aim off: callouts sit in the beam")
  assert.equal(hudOf(st).callouts, "down")

  // 3. Stamina states, default placement, both looks, street and interior.
  for (const [place, at] of Object.entries(PLACES)) {
    for (const look of Object.keys(LOOKS) as Look[]) {
      await stage(page, { x: at.x, y: at.y, aim: -Math.PI / 4, zoom: 34, hour: 21, look })
      await step(page, 30)
      st = await snap(page, `stamina-full-${look}-${place}`, `Stamina full: no ring · ${LOOKS[look]} · ${at.label}`)
      assert(!hudOf(st).meters.some((m) => m.id === "stamina"), "no stamina ring when full")
      for (const [name, stamina, caption] of [
        ["draining", 0.7, "Sprinting: ring drains"],
        ["low", 0.2, "Low: ring turns amber"],
      ] as const) {
        await stage(page, { x: at.x, y: at.y, aim: -Math.PI / 4, zoom: 34, hour: 21, look })
        await mutate(page, { stamina })
        await step(page, 14, { sprint: true, mx: 0.001 })
        await mutate(page, { x: at.x, y: at.y, vx: 0, vy: 0 })
        await step(page, 1, { sprint: true })
        st = await snap(page, `stamina-${name}-${look}-${place}`, `${caption} · ${LOOKS[look]} · ${at.label}`)
        const ring = hudOf(st).meters.find((m) => m.id === "stamina")
        assert(ring, `${name} ring`)
        assert.equal(ring.state, name === "low" ? "low" : "ok")
      }
      await stage(page, { x: at.x, y: at.y, aim: -Math.PI / 4, zoom: 34, hour: 21, look })
      await mutate(page, { stamina: 0.03 })
      await step(page, 20, { sprint: true, mx: 0.001 })
      await mutate(page, { x: at.x, y: at.y, vx: 0, vy: 0 })
      await step(page, 4)
      st = await snap(page, `stamina-exhausted-${look}-${place}`, `Exhausted: red, flashing · ${LOOKS[look]} · ${at.label}`)
      assert.equal(hudOf(st).meters.find((m) => m.id === "stamina")?.state, "critical")
    }
  }

  // 4. Reload ring around the magazine count, low battery and health after a hit.
  await stage(page, { x: 30, y: 41, aim: -Math.PI / 4, zoom: 34, hour: 21, look: "noir" })
  await page.evaluate(() => (window as any).__arcadeHarness.stock(2, { ammo: 12 }))
  await step(page, 1, { reload: true })
  await step(page, 34)
  st = await snap(page, "reload-ring", "Reloading: ring around the magazine count")
  assert(hudOf(st).meters.some((m) => m.id === "reload"))
  await stage(page, { x: 30, y: 41, aim: -Math.PI / 4, zoom: 34, hour: 21, look: "noir" })
  await mutate(page, { battery: 0.12, health: 28 })
  await step(page, 20)
  st = await snap(page, "battery-health", "Low battery and low health rings")
  assert.deepEqual(
    hudOf(st)
      .meters.map((m) => m.id)
      .sort(),
    ["battery", "health"],
  )

  // 5. Teammate: a remote-style survivor with its name tag, smaller rings and its important callouts.
  await stage(page, { x: 30, y: 41, aim: 0, zoom: 34, hour: 21, look: "noir" })
  await teammate(page, { x: 32.2, y: 41.2, aim: Math.PI, health: 100 })
  await step(page, 8)
  await teammate(page, { health: 82, reloadRemaining: 0.8, exhausted: true })
  await step(page, 30)
  st = await snap(page, "teammate", "Teammate (Wren): name tag, smaller rings and callouts from replicated state")
  const mate = hudOf(st, "seat:1")
  assert(mate, "teammate tracked")
  assert(mate.meters.some((m) => m.id === "health") && mate.meters.some((m) => m.id === "reload"))
  assert((st.callouts as any[]).some((c) => c.actor === "seat:1"), "teammate callouts")

  // 6. Crowded moment: chasing zombies, a teammate under attack, local reload and exhaustion, a door prompt.
  for (const look of Object.keys(LOOKS) as Look[]) {
    await stage(page, { x: 27.7, y: 37.4, aim: Math.PI / 2, zoom: 34, hour: 21, look })
    await teammate(page, { x: 29.4, y: 37.9, aim: Math.PI / 2, health: 100 })
    await page.evaluate(() => {
      const h = (window as any).__arcadeHarness
      h.spawnZombie(28.4, 40.2, "chase", -Math.PI / 2)
      h.spawnZombie(30.6, 40.6, "chase", -Math.PI / 2)
      h.spawnZombie(26.2, 40.9, "chase", -Math.PI / 2)
    })
    await page.evaluate(() => (window as any).__arcadeHarness.stock(1, { ammo: 12 }))
    await mutate(page, { stamina: 0.04 })
    await step(page, 1, { reload: true })
    await step(page, 10, { sprint: true, mx: 0.001 })
    await mutate(page, { x: 27.7, y: 37.4, vx: 0, vy: 0 })
    await teammate(page, { health: 64, reloadRemaining: 0.6 })
    await step(page, 18)
    st = await snap(page, `crowded-${look}`, `Crowded: three zombies, a hurt teammate, reload and exhaustion · ${LOOKS[look]}`)
    assert(hudOf(st).meters.length >= 2, "local rings in the crowd")
  }

  // 7. Screen-edge fallback and the old log.
  await stage(page, { x: 30, y: 41, aim: 0, zoom: 34, hour: 21, look: "noir", hud: { vitalsPlacement: 2 } })
  await mutate(page, { stamina: 0.4 })
  await step(page, 16, { sprint: true, mx: 0.001 })
  await snap(page, "vitals-edge", "Stamina & status: Bars at screen edge (the previous layout)")
  await stage(page, { x: 27.7, y: 36.2, aim: -Math.PI / 2, hud: { hudMode: 1 } })
  await step(page, 1, { barricade: true })
  await step(page, 20)
  await snap(page, "log-mode", "Action feedback: Bottom-left log restores the old status line")
  await page.evaluate(() => (window as any).__arcadeHarness.setLab("hudMode", 0))

  // 8. Reduced motion: no drift, no slide, no flashing.
  await page.emulateMedia({ reducedMotion: "reduce" })
  await stage(page, { x: 30, y: 41, aim: -Math.PI / 2, zoom: 42, hour: 18 })
  const reduced = await page.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    const c = h.hud.layer.callout("local", "+6 9mm", "result")
    Object.assign(h.state().player, { stamina: 0.02, exhausted: true })
    for (let i = 0; i < 30; i++) await h.step()
    const ring = document.querySelector<HTMLElement>('.vital[data-meter="stamina"] .vital-ring')
    return {
      reducedMotion: h.hud.layer.reducedMotion,
      drift: h.hud.layer.model.drift(c, h.hud.layer.reducedMotion),
      flash: ring ? getComputedStyle(ring).animationName : "missing",
    }
  })
  assert.equal(reduced.reducedMotion, true)
  assert.equal(reduced.drift, 0)
  assert.equal(reduced.flash, "none")
  await page.emulateMedia({ reducedMotion: "no-preference" })

  // 9. Per-frame cost of hud.update with three callouts, three rings and a teammate always visible, in live play.
  const cost = await page.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    h.freeze(true)
    h.reset(7)
    h.setLab("timeScale", 0)
    h.setLab("zoom", 34)
    h.setLookPreset("current")
    h.pose(30, 41, 0)
    const sim = h.session().sim
    const mate = sim.addSurvivor("Wren", 1)
    Object.assign(mate.survivor, { x: 31.8, y: 41.3, aim: Math.PI, health: 70, exhausted: true, reloadRemaining: 0.5 })
    await h.step()
    const samples: number[] = []
    const orig = h.hud.update.bind(h.hud)
    let n = 0
    h.hud.update = (...args: unknown[]) => {
      if (n++ % 12 === 0) {
        h.hud.layer.callout("local", `+${n % 9} 9mm`, "result")
        h.hud.layer.callout("local", "Reloading", "progress", { key: "reload", progress: (n % 60) / 60, duration: 1 })
        Object.assign(h.state().player, { stamina: 0.2 + (n % 60) / 100, health: 40 + (n % 30), battery: 0.1, sprinting: true })
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

  // Paired A/B on the same page: live play with callouts, rings and a teammate visible versus the old bottom-left log
  // with edge bars, in alternating 3 s blocks. Style and layout time come from Chrome's own counters.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Performance.enable")
  const metrics = async () =>
    Object.fromEntries(((await cdp.send("Performance.getMetrics")) as any).metrics.map((m: any) => [m.name, m.value]))
  const ab: Record<string, { styleLayoutMsPerFrame: number[]; scriptMsPerFrame: number[]; frames: number[] }> = {
    character: { styleLayoutMsPerFrame: [], scriptMsPerFrame: [], frames: [] },
    log: { styleLayoutMsPerFrame: [], scriptMsPerFrame: [], frames: [] },
  }
  for (const round of [0, 1, 2, 3, 4, 5, 6]) {
    for (const mode of round % 2 ? (["log", "character"] as const) : (["character", "log"] as const)) {
      await page.evaluate((mode) => {
        const h = (window as any).__arcadeHarness
        h.freeze(true)
        h.setLab("hudMode", mode === "log" ? 1 : 0)
        h.setLab("vitalsPlacement", mode === "log" ? 2 : 0)
        const w = window as any
        w.__abFrames = 0
        w.__abTimer = setInterval(() => {
          Object.assign(h.state().player, { stamina: 0.3 + (w.__abFrames % 50) / 100, sprinting: true })
          if (mode === "character") {
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
      ab[mode]!.frames.push(frames)
      ab[mode]!.styleLayoutMsPerFrame.push((d("RecalcStyleDuration") + d("LayoutDuration")) / Math.max(1, frames))
      ab[mode]!.scriptMsPerFrame.push(d("ScriptDuration") / Math.max(1, frames))
    }
  }
  await page.evaluate(() => {
    const h = (window as any).__arcadeHarness
    h.setLab("hudMode", 0)
    h.setLab("vitalsPlacement", 0)
  })
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
  const pairs = ab.character!.styleLayoutMsPerFrame.map((v, i) => v - ab.log!.styleLayoutMsPerFrame[i]!)
  const scriptPairs = ab.character!.scriptMsPerFrame.map((v, i) => v - ab.log!.scriptMsPerFrame[i]!)
  const abSummary = {
    styleLayoutDeltaMs: { median: median(pairs), min: Math.min(...pairs), max: Math.max(...pairs) },
    scriptDeltaMs: { median: median(scriptPairs), min: Math.min(...scriptPairs), max: Math.max(...scriptPairs) },
  }
  console.log("paired A/B per frame", JSON.stringify({ ab, abSummary }, null, 1))
  assert(cost.frames > 60, "too few frames sampled")
  assert(cost.p95Ms < 0.5, `hud.update p95 ${cost.p95Ms} ms`)
  assert.deepEqual(errors, [])
  writeFileSync(resolve(out, "summary.json"), JSON.stringify({ adapter, cost, ab, abSummary, reduced, shots }, null, 2))
  console.log(`wrote ${shots.length} stills to ${out}`)
} finally {
  await browser.close()
  await server.close()
}
