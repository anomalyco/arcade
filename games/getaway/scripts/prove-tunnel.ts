import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { createServer } from "vite"
import { TUNNEL } from "../shared/sim/tunnel"

// Isolated, silent fixture. Run with hivemind --kind browser; no visible browser or live services.
const out = process.env.PROOF_OUT ?? resolve("../../captures/getaway-tunnel")
const verify = process.argv.includes("--verify")
mkdirSync(join(out, "frames"), { recursive: true })
const fixture = process.env.PROOF_URL ? null : await createServer({ server: { host: "127.0.0.1", port: 0 }, configFile: "vite.config.ts" })
await fixture?.listen()
const host = process.env.PROOF_URL ?? fixture!.resolvedUrls!.local[0]!
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache).filter(n => /^chromium-\d+$/.test(n)).reverse().map(n => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)!
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const results: any[] = []
let frame = 0
try {
  for (const scenario of verify ? ["jump-after", "tunnel"] : ["jump-before", "jump-after", "tunnel"]) {
    const page = await browser.newPage({ viewport: { width: 720, height: 1080 }, deviceScaleFactor: 1 })
    const errors: string[] = []
    page.on("pageerror", e => errors.push(e.message))
    page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
    await page.route("**/src/main.ts*", async route => {
      const response = await route.fetch()
      let body = await response.text()
      const anchor = "let last = null"
      if (!body.includes(anchor)) throw new Error("Proof hook anchor missing")
      body = body.replace(anchor, `
        let proofFrame;
        const proofRender = renderer.render.bind(renderer);
        renderer.render = options => { proofFrame = options; return proofRender(options); };
        window.__tunnelProof = {
          world: activeSession.world,
          reset() { scene.resetBench(); cam = new Camera(); snapped = false; },
          async draw(dt) {
            const world = activeSession.world;
            const view = world.view();
            const focus = view.cars.find(c => c.ownerId === "me");
            if (!snapped) { cam.snap(focus.x, focus.z); snapped = true; }
            const other = view.cars.find(c => c.ownerId !== "me");
            const cx = other && other.tunnels === focus.tunnels ? (focus.x + other.x) / 2 : focus.x;
            cam.update(cx, focus.z, other ? 0 : focus.vx, other ? 0 : focus.vz, dt);
            if (view.cars.length > 1) cam.dist = 100;
            scene.input = { throttle: 1, brake: 0, steer: 0, boost: false, handbrake: false };
            scene.draw(view, cam, canvas.width, canvas.height, dt, focus);
            await device.queue.onSubmittedWorkDone();
            const shadows = Array.from({ length: proofFrame.sprites.alphaCount }, (_, i) => Array.from(proofFrame.sprites.alpha.slice(i * 12, i * 12 + 12)));
            const shadow = shadows.find(s => s[8] === 9 && Math.abs(s[0] - focus.x) < 0.001 && Math.abs(s[2] - focus.z) < 0.001);
            return { cars: view.cars, shadow, seen: world.seen, camera: { x: cam.fx, z: cam.fz } };
          }
        };
        ${anchor}`)
      await route.fulfill({ response, body })
    })
    if (scenario === "jump-before") {
      // Restore the pre-change shadow, retaining the integrated lamps and identical simulation/camera frames.
      await page.route("**/src/game/scene.ts*", async route => {
        const response = await route.fetch()
        let body = await response.text()
        const restore = (pattern: RegExp, original: string) => {
          if (!pattern.test(body)) throw new Error(`Baseline anchor missing: ${pattern}`)
          body = body.replace(pattern, original)
        }
        restore(/sprite\("a", c\.x, shadowGround[^;]+;/, 'sprite("a", c.x, v.ground + 0.018, c.z, spec.width * 0.85 / (1 + altitude * 0.06), 0, 0, 0, 0.7 / (1 + altitude * 0.45), 9, c.h, spec.length / spec.width * 0.85, altitude);')
        await route.fulfill({ response, body })
      })
      await page.route("**/src/render/shaders.ts*", async route => {
        const response = await route.fetch()
        const body = (await response.text()).replace('mix(0.58, 0.12, lift)', '0.48').replace('mix(0.68, 0.18, lift)', '0.58').replace('body * 0.88 + wheel * 0.55 * (1.0 - lift)', 'body * 0.78 + wheel * 0.55')
        await route.fulfill({ response, body })
      })
    }
    await page.goto(`${host}?solo&seed=7&bench&nohud`)
    await page.waitForFunction(() => Boolean((window as any).__tunnelProof))
    const adapter = await page.evaluate(async () => {
      const b = (window as any).__getawayBench
      await b.ready
      return b.adapterInfo
    })
    if (!/metal/i.test(JSON.stringify(adapter)) || /swiftshader/i.test(JSON.stringify(adapter))) throw new Error(`Expected Metal: ${JSON.stringify(adapter)}`)
    await page.addStyleTag({ content: '[data-lab], .lab-toggle {display:none!important} #proof-caption {position:fixed;left:24px;top:24px;color:#f0e2c8;font:600 24px sans-serif;text-shadow:0 2px 8px #000;pointer-events:none}' })
    await page.evaluate(async scenario => {
      const win = window as any, p = win.__tunnelProof, w = p.world
      const vehicleModule = "/shared/sim/vehicle.ts", tunnelModule = "/shared/sim/tunnel.ts"
      const { newBody } = await import(vehicleModule)
      const { TUNNEL } = await import(tunnelModule)
      const r = w.carOf("me"), cop = w.cars.find((c: any) => c.ownerId !== "me")
      w.cars = scenario === "tunnel" ? [r, cop] : [r]
      r.role = "robber"; r.human = true
      w.robberId = "me"; w.phase = scenario === "tunnel" ? "chase" : "waiting"; w.phaseT = 0; w.t = 0
      w.heli.active = false; w.lastSeen = null; w.seen = false
      if (scenario === "tunnel") {
        Object.assign(r.body, newBody(TUNNEL.eastMouth - 38, TUNNEL.z, Math.PI / 2), { vx: 28 })
        cop.role = "cop"; cop.human = false
        Object.assign(cop.body, newBody(TUNNEL.eastMouth - 55, TUNNEL.z, Math.PI / 2), { vx: 28 })
      } else {
        const ramp = w.city.ramps.find((r: any) => r.kind === "plate")
        const fx = Math.sin(ramp.h), fz = Math.cos(ramp.h)
        Object.assign(r.body, newBody(ramp.x - fx * 22, ramp.z - fz * 22, ramp.h), { vx: fx * 32, vz: fz * 32 })
      }
      w.setInput("me", { throttle: 1, brake: 0, steer: 0, handbrake: false, boost: false })
      p.reset()
      const caption = document.createElement("div"); caption.id = "proof-caption"
      caption.textContent = scenario === "tunnel" ? "East → West · cop follows" : scenario === "jump-before" ? "Jump · before" : "Jump · after"
      document.body.appendChild(caption)
    }, scenario)
    const samples: any[] = []
    let highest = 0
    for (let i = 0; i < (scenario === "tunnel" ? 145 : 90); i++) {
      const sample = await page.evaluate(async () => {
        const p = (window as any).__tunnelProof
        p.world.step(1 / 30)
        return p.draw(1 / 30)
      })
      samples.push(sample)
      const r = sample.cars.find((c: any) => c.ownerId === "me")
      if (!verify) await page.screenshot({ path: join(out, "frames", `${String(frame++).padStart(4, "0")}.jpg`), type: "jpeg", quality: 85 })
      if (scenario !== "tunnel" && r.y > highest) {
        highest = r.y
        await page.screenshot({ path: join(out, `${scenario}-apex.png`) })
      }
      if (scenario === "tunnel" && [28, 52, 86, 112].includes(i)) await page.screenshot({ path: join(out, `tunnel-${i}.png`) })
    }
    if (errors.length) throw new Error(errors.join("\n"))
    if (scenario === "tunnel") {
      if (!samples.some(s => s.cars.every((c: any) => c.tunnels === 1))) throw new Error("Cop did not follow")
      if (!samples.some((s, i) => i > 0 && samples[i - 1].cars[0].x > TUNNEL.eastMouth && s.cars[0].x < TUNNEL.westMouth)) throw new Error("No east-to-west transfer")
      if (!samples.some(s => !s.seen && s.cars[0].x > TUNNEL.eastMouth)) throw new Error("No sight break")
    } else if (highest < 2.5) throw new Error(`Jump too low: ${highest}`)
    if (scenario === "jump-after" && !samples.some(s => s.cars[0].airborne && s.cars[0].y > 2.5 && s.shadow?.[11] > 2 && s.shadow[7] > 0.3 && s.shadow[7] < 0.82)) throw new Error("Missing faded airborne contact shadow")
    results.push({ scenario, adapter, highest, samples })
    await page.close()
  }
  if (!verify) {
    const a = results[0].samples.map((s: any) => s.cars[0]), b = results[1].samples.map((s: any) => s.cars[0])
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error("Before/after simulation mismatch")
  }
  writeFileSync(join(out, "proof.json"), JSON.stringify(results, null, 2))
  console.log(JSON.stringify(results.map(({ scenario, adapter, highest, samples }) => ({ scenario, adapter, highest, frames: samples.length }))))
} finally {
  await browser.close()
  await fixture?.close()
}
