/// <reference types="@webgpu/types" />
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// A bounded, silent Metal proof. All fixtures are client-side view/body copies.
const lamps = process.argv.includes("--lamps")
const out = process.env.CHASSIS_OUT ?? join(import.meta.dir, lamps ? "../../../captures/getaway-chassis-lamps" : "../../../captures/getaway-chassis")
mkdirSync(out, { recursive: true })
const fixture = process.argv.includes("--fixture") ? await (await import("vite")).createServer({ server: { host: "127.0.0.1", port: 0 }, configFile: join(import.meta.dir, "../vite.config.ts") }) : null
await fixture?.listen()
const address = fixture?.httpServer?.address()
const host = typeof address === "object" && address ? `http://localhost:${address.port}` : process.env.CHASSIS_URL ?? "http://getaway-chassis.localhost:1355"
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache).filter(n => /^chromium-\d+$/.test(n)).reverse().map(n => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)!
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const mode = process.argv[2] ?? "stills"
const scenarios = lamps ? ["braking", "kerb"] : ["launch", "braking", "corner", "kerb", "landing", "countersteer"]
const errors: string[] = []
try {
  const page = await browser.newPage({ viewport: { width: 720, height: 600 }, deviceScaleFactor: 1 })
  page.on("pageerror", e => { errors.push(e.message); console.error(e.message) })
  page.on("console", m => { if (m.type() === "error" && !m.text().includes("404")) { errors.push(m.text()); console.error(m.text()) } })
  await page.goto(`${host}/?solo&peaceful=1&seed=7&bench&nohud`)
  await page.waitForFunction(() => (window as any).__getawayBench, null, { timeout: 30000 })
  const adapter = await page.evaluate(async () => { await (window as any).__getawayBench.ready; return (window as any).__getawayBench.adapterInfo })
  if (adapter.vendor !== "apple" || !adapter.architecture.includes("metal") || /swiftshader/i.test(JSON.stringify(adapter))) throw new Error(`Not Metal: ${JSON.stringify(adapter)}`)
  console.log("adapter", adapter)
  await page.addStyleTag({ content: "body > :not(canvas) { display:none !important } canvas { display:block }" })
  await page.evaluate(async (lamps) => {
    const load = (path: string) => import(/* @vite-ignore */ (performance.getEntriesByType("resource").find(e => new URL(e.name).pathname === path)?.name ?? path))
    const [{ Scene }, { Camera }, { juice }, sim, config] = await Promise.all([load("/src/game/scene.ts"), load("/src/game/camera.ts"), load("/src/ui/debug-overlay.ts"), load("/shared/sim/vehicle.ts"), load("/shared/config.ts")])
    const original = Scene.prototype.draw
    Scene.prototype.draw = function(view: any, cam: any, ...rest: any[]) {
      Object.assign(window, { __chassisProof: { scene: this, view, cam, juice, sim, config, Camera } })
      return original.call(this, view, cam, ...rest)
    }
    await (window as any).__getawayBench.step(0, 0, true)
    Scene.prototype.draw = original
    const p = (window as any).__chassisProof
    p.base = structuredClone(p.view.cars.find((c: any) => c.human))
    p.view = structuredClone(p.view)
    p.view.heli.active = false
    p.cam = new Camera()
    Object.assign(p.cam, { pitch: 0.6, dist: lamps ? 16 : 20, fov: 0.6 })
    p.device = p.scene.renderer.device
    const { bodyPoint } = await load("/src/game/car-pose.ts")
    const { lampMounts } = await load("/src/render/car-lights.ts")
    if (lamps) {
      const render = p.scene.renderer.render.bind(p.scene.renderer)
      p.scene.renderer.render = (frame: any) => { p.renderFrame = frame; return render(frame) }
    }
    p.reset = (scenario: string, enabled: boolean, vehicle = "muscle") => {
      Object.assign(p.juice, { suspension: enabled, wheelContact: enabled, visibleWheels: enabled, vehicleFeel: enabled, trauma: false, rush: false })
      p.scene.resetBench()
      let seed = 7
      Math.random = () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 4294967296 }
      p.scenario = scenario
      p.frame = 0
      p.body = sim.newBody(76, 95, 0)
      if (scenario === "braking") p.body.vz = 27
      if (scenario === "corner" || scenario === "countersteer") { p.body.x = 304; p.body.z = scenario === "corner" ? 266 : 282; p.body.vz = 23 }
      if (scenario === "kerb") Object.assign(p.body, { x: config.ROAD_HALF - 1.3, z: 27, h: 0.28, vx: 0.6, vz: 2 })
      if (scenario === "landing") Object.assign(p.body, { x: 322, z: 456, h: Math.PI / 2, vx: 30 })
      p.spec = config.VEHICLE_BY_ID.get(vehicle)
      p.view.cars = [{ ...p.base, vehicle, role: p.spec.role }]
      p.tick(0)
    }
    p.tick = (dt = 1 / 30) => {
      const i = p.frame++, s = p.scenario, b = p.body
      const input = { ...sim.NO_INPUT }
      if (s === "launch") { input.throttle = i > 8 ? 1 : 0; input.boost = i > 8 }
      if (s === "braking") input.brake = i > 8 ? 1 : 0
      if (s === "corner") { input.throttle = 0.5; input.steer = i > 8 && i < 38 ? 0.8 : 0 }
      if (s === "countersteer") { input.throttle = 1; input.handbrake = i > 8 && i < 25; input.steer = i < 25 ? 0.8 : i < 48 ? -0.8 : 0 }
      if (s === "kerb") input.throttle = 0.17
      if (s === "landing") input.throttle = 1
      // Collision-free peaceful fixture isolates chassis response; ramps use the real height integrator.
      sim.stepAndCollide(b, input, p.spec, dt, [], undefined, p.scene.city.ramps)
      const c = p.view.cars[0]
      Object.assign(c, { x: b.x, z: b.z, h: b.h, vx: b.vx, vz: b.vz, y: b.y, vy: b.vy, airborne: b.airborne, landing: b.landing, landings: b.landings, yaw: b.yaw, speed: Math.hypot(b.vx, b.vz), drift: Math.abs(b.vx * Math.cos(b.h) - b.vz * Math.sin(b.h)), impact: 0, boost: 1, braking: input.brake > 0 || input.handbrake, boosting: input.boost, engineOff: false })
      p.view.t += dt
      p.cam.snap(c.x, c.z)
      p.scene.input = input
      p.scene.draw(p.view, p.cam, 720, 600, dt, c)
      const ch = p.scene.vis.get(c.id).chassis
      let lampError = 0
      if (lamps) {
        const models = p.juice.visibleWheels ? p.scene.chassisModels.get(c.vehicle).bodies : p.scene.variants.get(c.vehicle)
        const instance = p.scene.batchMap.get(models[c.id % models.length]).data
        const pose = { height: instance[1], roll: instance[4], pitch: instance[5] }
        const car = { x: instance[0], z: instance[2], h: instance[3] }
        const point = (offset: [number, number, number]): [number, number, number] => bodyPoint(car, pose, offset)
        const half = p.spec.length / 2, hw = p.spec.width / 2 - 0.25
        const check = (actual: number[], expected: number[]) => { lampError = Math.max(lampError, Math.hypot(...expected.map((n, i) => n - actual[i]))) }
        const lights = Array.from({ length: p.scene.lightCount }, (_, i) => [...p.renderFrame.lights.slice(i * 12, i * 12 + 12)])
        const reference = p.scene.lightStyle === 0, mount = lampMounts(p.spec)
        const head = lights.find(l => l[3] === (reference ? 36 : p.scene.lightStyle === 3 ? 22 : 18))!
        const from = point(reference ? [0, 1.3, half + 0.5] : [0, mount.frontY, half + 0.08])
        check(head, from)
        const to = point(reference ? [0, 1, half + 1.45] : [0, mount.frontY - 0.28, half + 1.08])
        const direction = to.map((n, i) => n - from[i]), length = Math.hypot(...direction)
        check(head.slice(8, 11), direction.map(n => n / length))
        check(lights.find(l => l[3] === (reference ? 7 : 4) && Math.abs(l[5] - (reference ? 0.1 : 0.055)) < 1e-5)!, point(reference ? [0, 0.9, -(half + 0.6)] : [0, mount.rearY, -half - 0.28]))
        const sprites = Array.from({ length: p.renderFrame.sprites.addCount }, (_, i) => [...p.renderFrame.sprites.add.slice(i * 12, i * 12 + 12)])
        for (const front of [true, false]) {
          const green = front ? (reference ? 0.95 : p.scene.lightStyle === 2 ? 0.94 : 0.84) : reference ? 0.12 : 0.055
          const glows = sprites.filter(l => l[8] === (reference ? 0 : 15) && Math.abs(l[5] - green) < 1e-5)
          if (glows.length !== 2) throw new Error(`Missing ${front ? "head" : "tail"} glows`)
          glows.forEach((g, j) => check(g, point(reference
            ? [hw * (j ? 1 : -1), 0.75, front ? half + 0.1 : -(half + 0.05)]
            : [(front ? mount.frontX : mount.rearX) * (j ? 1 : -1), (front ? mount.frontY : mount.rearY) + 0.02, front ? half + 0.065 : -half - 0.075])))
        }
        if (c.role === "cop") {
          const y = c.vehicle === "swat" ? 2.9 : 1.9
          check(lights.find(l => l[3] === 14 && l[4] === 1)!, point([-2.2, y - 1.2, 0]))
          check(lights.find(l => l[3] === 14 && l[6] === 1)!, point([2.2, y - 1.2, 0]))
          const sirens = sprites.filter(l => l[8] === 0 && Math.abs(l[5] - 0.1) < 1e-5 || l[8] === 0 && Math.abs(l[5] - 0.35) < 1e-5)
          if (!sirens.length) throw new Error("Missing siren glows")
          for (const glow of sirens) check(glow, point([glow[4] === 1 ? -0.45 : 0.45, y, 0]))
        }
        if (lampError > 0.0001) throw new Error(`Lamp attachment error: ${lampError}`)
      }
      return { scenario: s, frame: i, car: { ...c }, roll: ch.roll.x, pitch: ch.pitch.x, lift: ch.lift.x, steer: ch.steer, contacts: structuredClone(ch.contacts), lampError }
    }
  }, lamps)
  const reports: any[] = []
  if (mode === "probe") {
    await page.evaluate(() => { const p = (window as any).__chassisProof; p.reset("launch", true); p.tick() })
    await page.screenshot({ path: join(out, "preview.jpg"), type: "jpeg", quality: 85 })
  }
  if (!mode.startsWith("perf") && mode !== "probe") for (const scenario of scenarios) for (const enabled of [false, true]) {
    const name = `${scenario}-${enabled ? "on" : "off"}`
    await page.evaluate(({ scenario, enabled }) => (window as any).__chassisProof.reset(scenario, enabled), { scenario, enabled })
    const states: any[] = []
    for (let i = 0; i < 72; i++) {
      states.push(await page.evaluate(() => (window as any).__chassisProof.tick()))
      if (mode === "clip" || [17, 29, 44, 60, 71].includes(i)) await page.screenshot({ path: join(out, `${name}-${String(i).padStart(3, "0")}.jpg`), type: "jpeg", quality: 90 })
    }
    reports.push({ scenario, enabled, states })
    console.log(name, "maxY", Math.max(...states.map(s => s.car.y)), "landings", states.at(-1).car.landings)
  }
  if (lamps) for (const vehicle of ["cruiser", "swat"]) {
    const check = await page.evaluate((vehicle) => {
      const p = (window as any).__chassisProof
      p.reset("kerb", true, vehicle)
      let maxError = 0
      for (let frame = 0; frame < 40; frame++) maxError = Math.max(maxError, p.tick().lampError)
      return { vehicle, maxError }
    }, vehicle)
    reports.push({ sirenCheck: check })
    console.log("siren", check)
  }
  if (mode.startsWith("perf")) {
    const result = await page.evaluate(async (wheelsOnly) => {
      const p = (window as any).__chassisProof
      p.reset("corner", true)
      const cars = Array.from({ length: 28 }, (_, i) => ({ ...p.view.cars[0], id: 100 + i, x: 218 + (i % 4) * 5, z: 140 + Math.floor(i / 4) * 7, vehicle: ["muscle", "compact", "van", "swat", "bike", "cruiser", "interceptor"][i % 7] }))
      p.view.cars = cars
      p.cam.snap(226, 161)
      Object.assign(p.cam, { dist: 105, pitch: 0.93 })
      const device: GPUDevice = p.scene.renderer.device
      if (!device) throw new Error("No renderer device")
      // One first-to-last hardware interval, never a sum of overlapping render pass intervals.
      const queries = device.createQuerySet({ type: "timestamp", count: 64 })
      const resolve = device.createBuffer({ size: 512, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC })
      const read = device.createBuffer({ size: 512, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
      let slots = 0, draws = 0, instances = 0
      device.createCommandEncoder = (desc) => {
        const enc = GPUDevice.prototype.createCommandEncoder.call(device, desc)
        const render = enc.beginRenderPass.bind(enc), compute = enc.beginComputePass.bind(enc), finish = enc.finish.bind(enc)
        enc.beginRenderPass = (d) => {
          const pass = render({ ...d, timestampWrites: { querySet: queries, beginningOfPassWriteIndex: slots++, endOfPassWriteIndex: slots++ } })
          const draw = pass.draw.bind(pass)
          pass.draw = (n, count = 1, first = 0, firstInst = 0) => { draws++; instances += count; draw(n, count, first, firstInst) }
          return pass
        }
        enc.beginComputePass = (d) => compute({ ...d, timestampWrites: { querySet: queries, beginningOfPassWriteIndex: slots++, endOfPassWriteIndex: slots++ } })
        enc.finish = (d) => { enc.resolveQuerySet(queries, 0, slots, resolve, 0); enc.copyBufferToBuffer(resolve, 0, read, 0, slots * 8); return finish(d) }
        return enc
      }
      const runs = []
      for (let pair = 0; pair < 8; pair++) for (const enabled of pair % 2 ? [true, false] : [false, true]) {
        Object.assign(p.juice, { suspension: wheelsOnly || enabled, wheelContact: wheelsOnly || enabled, visibleWheels: enabled, vehicleFeel: wheelsOnly || enabled })
        let cpu = 0, gpu = 0, animation = 0, carInstances = 0
        for (let f = 0; f < 20; f++) {
          slots = draws = instances = 0
          const start = performance.now()
          p.scene.draw(p.view, p.cam, 720, 600, 1 / 60, cars[0])
          cpu += performance.now() - start
          carInstances = [...p.scene.batchMap.values()].reduce((n: number, s: any) => n + s.count, 0)
          await read.mapAsync(GPUMapMode.READ)
          const times = new BigUint64Array(read.getMappedRange(0, slots * 8))
          gpu += Number(times[slots - 1] - times[0]) / 1e6
          read.unmap()
        }
        // Isolate client chassis update cost for 28 cars, one warmup + seven measured pairs.
        const start = performance.now()
        for (let frame = 0; frame < 1000; frame++) for (const c of cars) p.scene.vis.get(c.id).chassis.update(c, p.config.VEHICLE_BY_ID.get(c.vehicle), p.scene.city, 1 / 60, p.juice, null)
        animation = (performance.now() - start) / 1000
        runs.push({ pair, enabled, cpuMs: cpu / 20, gpuMs: gpu / 20, chassisMs: animation, draws, instances, modelInstances: carInstances, cars: cars.length })
      }
      return runs
    }, mode === "perf-wheels")
    reports.push(...result)
    console.log(JSON.stringify(result))
  }
  writeFileSync(join(out, `${mode}.json`), JSON.stringify({ adapter, errors, reports }, null, 2))
  if (errors.length) throw new Error(errors.join("\n"))
} finally { await browser.close(); await fixture?.close() }
