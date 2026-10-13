import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"
import ts from "typescript"

// Run sequentially against the named Nexus preview, with no visible window or audio.
const label = process.argv[2] ?? "after"
const out = resolve(process.env.PROOF_OUT ?? "../../captures/getaway-fixes")
mkdirSync(out, { recursive: true })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache).filter(n => /^chromium-\d+$/.test(n)).reverse().map(n => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)!
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const results: unknown[] = []
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 720 }, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
  // Preserve Vite's resolved imports while serving the exact original module bodies.
  if (label === "before") for (const [file, anchor] of [
    ["src/game/scene.ts", "const MAX_SPRITES_PER_LIST"],
    ["src/render/shaders.ts", "export const MAX_LIGHTS"],
    ["shared/sim/bots.ts", "const TAU"],
    ["shared/sim/world.ts", "export const SURVIVAL"],
  ]) await page.route(`**/${file}*`, async route => {
    const response = await route.fetch(), current = await response.text()
    const source = execFileSync("git", ["show", `b0a9446:games/getaway/${file}`], { encoding: "utf8" })
    const original = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText
    if (!current.includes(anchor!) || !original.includes(anchor!)) throw new Error(`Baseline anchor missing: ${file}`)
    await route.fulfill({ response, body: current.slice(0, current.indexOf(anchor!)) + original.slice(original.indexOf(anchor!)) })
  })
  // Vite's symlinked dependencies can serve CSS but reject font URLs outside its root.
  const fontRoot = dirname(fileURLToPath(import.meta.resolve("@fontsource/barlow-condensed/package.json")))
  await page.route("**/barlow-condensed-*.woff*", route => route.fulfill({ path: join(fontRoot, "files", basename(new URL(route.request().url()).pathname)) }))
  if (process.env.NO_BEAM) await page.route("**/src/game/scene.ts*", async route => {
    const response = await route.fetch()
    await route.fulfill({ response, body: (await response.text()).replace("this.renderer.setBeams(this.beamBuf, beams.count)", "this.renderer.setBeams(this.beamBuf, 0)") })
  })
  await page.route("**/src/main.ts*", async route => {
    const response = await route.fetch()
    let body = await response.text()
    const anchor = "let last = null"
    if (!body.includes(anchor)) throw new Error("Proof anchor missing")
    body = body.replace(anchor, `
      let fixFrame;
      const fixRender = renderer.render.bind(renderer);
      renderer.render = options => { fixFrame = options; return fixRender(options); };
      window.__fixProof = {
        get world() { return activeSession.world; },
        reset() { window.__getawayBench.reset(); scene.resetBench(); cam = new Camera(); },
        drive(input, poolAhead) { scene.input = input; scene.lightSettings.poolAhead = poolAhead; },
        async draw(distance = 45, cx, cz) {
          const world = activeSession.world;
          const view = world.view();
          const focus = view.cars.find(c => c.ownerId === "me");
          cam.snap(cx ?? focus.x, cz ?? focus.z); cam.dist = distance;
          scene.draw(view, cam, canvas.width, canvas.height, 1/30, focus);
          await device.queue.onSubmittedWorkDone();
          const shadows = Array.from({ length: fixFrame.sprites.alphaCount }, (_, i) => Array.from(fixFrame.sprites.alpha.slice(i*12, i*12+12))).filter(s => s[8] === 9);
          const additive = Array.from({ length: fixFrame.sprites.addCount }, (_, i) => Array.from(fixFrame.sprites.add.slice(i*12, i*12+12)));
          const heads = additive.filter(s => s[8] === 15 && s[5] > 0.5);
          const pools = additive.filter(s => s[8] === 19);
          const poolDistances = pools.map((s, i) => Math.hypot(s[0] - heads[i][0], s[2] - heads[i][2]));
          return { cars: view.cars, shadows, poolDistances, pitch: scene.vis.get(focus.id)?.chassis.pitch.x ?? 0, spot: Array.from(fixFrame.frame.slice(48, 56)), heli: view.heli, pool: cam.project(view.heli.sx, 0, view.heli.sz, canvas.width, canvas.height) };
        }
      };
      ${anchor}`)
    await route.fulfill({ response, body })
  })
  await page.goto(`${process.env.PROOF_URL ?? "http://getaway-fixes.localhost:1355"}?solo&seed=7&bench&nohud`)
  await page.waitForFunction(() => Boolean((window as any).__fixProof))
  const adapter = await page.evaluate(async () => { const b = (window as any).__getawayBench; await b.ready; return b.adapterInfo })
  if (!/metal/i.test(JSON.stringify(adapter)) || /swiftshader/i.test(JSON.stringify(adapter))) throw new Error(`Expected Metal: ${JSON.stringify(adapter)}`)
  await page.addStyleTag({ content: "[data-lab], .lab-toggle {display:none!important}" })
  for (const scenario of ["spotlight", "ground", "jump", "chase"]) {
    const result = await page.evaluate(async scenario => {
      const p = (window as any).__fixProof
      let minimumSpacing = Infinity, impacts = 0
      p.reset()
      const w = p.world, r = w.carOf("me")
      const path = "/shared/sim/vehicle.ts"
      const { newBody } = await import(path)
      w.phase = "waiting"; w.phaseT = 0; w.t = 45
      w.heli.active = scenario === "spotlight"
      w.cars = scenario === "chase" ? [r, ...w.cops().slice(0, 4)] : [r]
      r.role = "robber"; r.human = true; w.robberId = "me"
      Object.assign(r.body, newBody(228, 152, 0.4))
      if (scenario === "spotlight") {
        Object.assign(r.body, newBody(228, 152, 0.4))
        Object.assign(w.heli, { active: true, x: 247, y: 24, z: 133, h: 2.6, sx: 228, sz: 152 })
      }
      if (scenario === "jump") {
        const ramp = w.city.ramps.find((r: any) => r.kind === "plate")
        const fx = Math.sin(ramp.h), fz = Math.cos(ramp.h)
        Object.assign(r.body, newBody(ramp.x - fx * 22, ramp.z - fz * 22, ramp.h), { vx: fx * 32, vz: fz * 32 })
        w.setInput("me", { throttle: 1, brake: 0, steer: 0, handbrake: false, boost: false })
        let peak = { ...r.body }
        for (let i = 0; i < 75; i++) { w.step(1/30); if (r.body.y > peak.y) peak = { ...r.body } }
        Object.assign(r.body, peak)
      }
      if (scenario === "chase") {
        w.phase = "chase"; w.phaseT = 30
        Object.assign(r.body, newBody(228, 200, 0), { vz: 22 })
        w.cops().forEach((c: any, i: number) => {
          Object.assign(c.body, newBody(226 + (i % 2) * 4, 181 - Math.floor(i / 2) * 6, 0), { vz: 22 })
          for (const g of c.gadgets) g.charges = 0
        })
        w.setInput("me", { throttle: 1, brake: 0, steer: 0, handbrake: false, boost: false })
        for (let i = 0; i < 100; i++) {
          w.step(1/30)
          const cops = w.cops()
          for (let j = 0; j < cops.length; j++) for (let k = j + 1; k < cops.length; k++) minimumSpacing = Math.min(minimumSpacing, Math.hypot(cops[j].body.x - cops[k].body.x, cops[j].body.z - cops[k].body.z))
          impacts += cops.filter((c: any) => c.impact > 0).length
        }
      }
      // A real, vertical helicopter light makes the footprint readable on matte asphalt.
      if (scenario === "ground" || scenario === "jump") Object.assign(w.heli, { active: true, x: r.body.x, y: 30, z: r.body.z - 1.7, h: 0, sx: r.body.x, sz: r.body.z })
      const cops = w.cops()
      const cz = scenario === "chase" ? (r.body.z + Math.min(...cops.map((c: any) => c.body.z))) / 2 : undefined
      return { ...await p.draw(scenario === "spotlight" ? 55 : scenario === "chase" ? 85 : 30, undefined, cz), minimumSpacing, impacts }
    }, scenario)
    await page.screenshot({ path: join(out, `${label}-${scenario}.png`) })
    if (scenario === "spotlight") await page.screenshot({ path: join(out, `${label}-spotlight-crop.png`), clip: { x: 280, y: 190, width: 400, height: 340 } })
    results.push({ scenario, ...result })
    if (scenario === "jump" && result.cars[0].y < 2.5) throw new Error("Jump did not reach apex")
    if (label === "after" && scenario === "chase" && (result.minimumSpacing < 2 || result.impacts)) throw new Error(`Chase spacing/impact failure: ${JSON.stringify(result)}`)
  }
  if (label === "after") for (const poolAhead of [5, 12]) {
    const acceleration = await page.evaluate(async poolAhead => {
      const p = (window as any).__fixProof
      p.reset()
      const w = p.world, car = w.carOf("me")
      const path = "/shared/sim/vehicle.ts"
      const { newBody } = await import(path)
      w.phase = "waiting"; w.robberId = "me"; w.cars = [car]; w.heli.active = false
      car.role = "robber"; car.human = true
      Object.assign(car.body, newBody(228, 152, 0))
      const input = { throttle: 1, brake: 0, steer: 0, handbrake: false, boost: false }
      w.setInput("me", input); p.drive(input, poolAhead)
      const samples = []
      for (let frame = 0; frame < 90; frame++) {
        w.step(1 / 30)
        const result = await p.draw(45)
        if (result.poolDistances.length !== 2 || result.poolDistances.some((d: number) => !Number.isFinite(d) || d < poolAhead * 0.85 - 0.0001 || d > poolAhead * 1.15 + 0.0001)) throw new Error(`Pool jumped ahead: ${JSON.stringify(result.poolDistances)}`)
        samples.push({ speed: car.body.vz, pitch: result.pitch, distances: result.poolDistances })
      }
      if (samples.at(-1)!.speed < 15 || Math.max(...samples.map(s => Math.abs(s.pitch))) < 0.02) throw new Error("Acceleration fixture did not exercise body pitch")
      return { poolAhead, samples, minimum: Math.min(...samples.flatMap(s => s.distances)), maximum: Math.max(...samples.flatMap(s => s.distances)) }
    }, poolAhead)
    await page.screenshot({ path: join(out, `after-acceleration-${poolAhead}.png`) })
    results.push({ scenario: "acceleration", ...acceleration })
  }
  if (errors.length) throw new Error(errors.join("\n"))
  writeFileSync(join(out, `${label}.json`), JSON.stringify({ adapter, results }, null, 2))
  console.log(JSON.stringify({ label, adapter, out }))
} finally { await browser.close() }
