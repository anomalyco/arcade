/** Bounded, silent Metal proof against the three named local integration previews. */
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright-core"
import { instrumentGetaway } from "./compare-video/getaway"

const out = resolve(process.env.OUT ?? "captures/integration")
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--mute-audio"] })
const report: Record<string, unknown> = {}
const base = (game: string) => process.env[game.toUpperCase()] ?? `http://arcade-review-${game}.localhost:1355`
try {
  for (const game of ["getaway", "outbreak", "blackout"] as const) {
    if (process.env.GAME && process.env.GAME !== game) continue
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 1 })
    const errors: string[] = []
    page.on("pageerror", e => errors.push(e.message))
    page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
    await page.route("**/api/stats", r => r.fulfill({ json: { players: 0, games: 0 } }))
    if (game === "getaway") {
      await page.addInitScript(() => { (window as any).__compareVideo = { seed: 7, draw: (_: unknown, draw: () => unknown) => draw() } })
      await page.route(/\/src\/main\.ts(?:\?.*)?$/, async route => {
        const response = await route.fetch()
        const source = instrumentGetaway(await response.text()).replace("let rafActive =", "window.__integration = {scene, renderer, cam:()=>cam, session:()=>session}; let rafActive =")
        await route.fulfill({ response, body: source })
      })
      await page.goto(`${base(game)}/?bench&peaceful=1&seed=7`)
      await page.waitForFunction(() => (window as any).__getawayBench)
      const result = await page.evaluate(async () => {
        const w = window as any, b = w.__getawayBench
        await b.ready; b.reset(true)
        b.emissionStudy("burnout")
        w.__compareVideo.input = { throttle: 1, brake: 1, steer: 0, handbrake: false, boost: true, gadget: null, engine: false }
        let peak = 0
        for (let i = 0; i < 75; i++) { const r = await b.step(i, 1 / 60, true); peak = Math.max(peak, r.smoke.connected) }
        const scene = w.__integration.scene
        return { adapter: b.adapterInfo, peakSmoke: peak, lights: { ...scene.lightSettings }, motion: await import("/src/render/motion.ts").then((m: any) => m.motionBlur) }
      })
      assert.match(result.adapter.architecture, /metal/i)
      assert(result.peakSmoke > 0)
      assert.equal(result.lights.style, 4)
      assert.equal(result.lights.poolSize, 3.4)
      assert.equal(result.lights.poolIntensity, .04)
      assert.equal(result.lights.tailGlow, 2)
      await page.screenshot({ path: resolve(out, "getaway-smoke-lamps.png") })
      const tunnel = await page.evaluate(async () => {
        const w = window as any, b = w.__getawayBench
        b.emissionStudy(null); b.reset()
        const { TUNNEL } = await import("/shared/sim/tunnel.ts")
        const { newBody } = await import("/shared/sim/vehicle.ts")
        const local = w.__integration.session(), body = local.world.robber().body
        Object.assign(body, newBody(TUNNEL.east - 5, TUNNEL.z + 1, Math.PI / 2), { vx: 30 })
        local.prev = local.curr = local.world.view(local.myId)
        w.__integration.cam().snap(body.x, body.z)
        w.__compareVideo.input = { throttle: 1, brake: 0, steer: 0, handbrake: false, boost: false, gadget: null, engine: false }
        for (let i = 0; i < 25; i++) await b.step(i, 1 / 60, true)
        return { tunnels: body.tunnels, x: body.x, z: body.z, speed: Math.hypot(body.vx, body.vz) }
      })
      assert.equal(tunnel.tunnels, 1)
      assert(tunnel.speed > 20)
      await page.screenshot({ path: resolve(out, "getaway-tunnel.png") })
      report.getaway = { ...result, tunnel }
    } else if (game === "outbreak") {
      await page.goto(`${base(game)}/?solo&seed=7&bench`)
      await page.waitForFunction(() => (window as any).__arcadeHarness?.ready)
      const result = await page.evaluate(async () => {
        const h = (window as any).__arcadeHarness
        h.setLab("timeScale", 0); h.setLab("hour", 18); h.setLab("zoom", 38)
        h.pose(27.7, 31, -Math.PI / 2)
        for (let i = 0; i < 5; i++) await h.step()
        const closed = h.fog(27.7, 27)
        await h.step(1 / 60, { interact: true }); await h.step()
        const open = h.fog(27.7, 27)
        return { adapter: h.adapterInfo, closed, open }
      })
      assert.match(result.adapter.architecture, /metal/i)
      assert.equal(result.closed, "unexplored"); assert.equal(result.open, "visible")
      await page.screenshot({ path: resolve(out, "outbreak-door-los.png") })
      await page.keyboard.press("Backquote")
      await page.getByRole("slider", { name: "Time", exact: true }).fill("12")
      assert.equal(await page.evaluate(() => (window as any).__arcadeHarness.state().hour), 12)
      report.outbreak = result
    } else {
      await page.goto(`${base(game)}/?sandbox=1&peaceful=1&seed=1&manual&bench`)
      await page.waitForFunction(() => (window as any).wizardProof?.game?.body)
      const motion = await page.evaluate(async () => {
        const w = window as any, g = w.wizardProof.game
        const defaults = { motion: g.juice.lookMotion, reflections: g.juice.lookGloss, rings: "rings" in g.juice, lamps: "lamps" in g.juice }
        g.juice.lookMotion = true
        g.veh.emissions.trail.spawn(g.body.x, .3, g.body.y, 0, 0)
        await w.advance(100)
        return { defaults, smoke: g.veh.emissions.trail.count }
      })
      assert.deepEqual(motion.defaults, { motion: false, reflections: true, rings: false, lamps: false })
      assert(motion.smoke > 0)
      await page.screenshot({ path: resolve(out, "blackout-office.png") })
      report.blackout = motion
      await page.goto(`${base("lab")}/?bench`)
      await page.waitForFunction(() => (window as any).lab)
      const result = await page.evaluate(async () => {
        const a = await navigator.gpu.requestAdapter()
        const lab = (window as any).lab
        const sections = lab.sections.map((s: any) => s.id)
        for (const id of ["spawn", "fire-water", "splatter"]) {
          if (!sections.includes(id)) throw new Error(`Missing section ${id}`)
          lab.select(id); lab.advance(1 / 30); await lab.render()
        }
        return { adapter: a && { vendor: a.info.vendor, architecture: a.info.architecture }, sections, controls: document.querySelector("[data-lab]")!.shadowRoot!.querySelectorAll("input,select").length }
      })
      assert(result.controls > 4)
      await page.screenshot({ path: resolve(out, "shared-lab.png") })
      report.lab = result
    }
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
    assert.deepEqual(errors, [], `${game} browser/GPU errors`)
    await page.close()
  }
  writeFileSync(resolve(out, "integration-proof.json"), JSON.stringify(report, null, 2) + "\n")
  console.log(JSON.stringify(report, null, 2))
} finally { await browser.close() }
