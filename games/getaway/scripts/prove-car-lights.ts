import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { createServer } from "vite"

const v2 = process.argv.includes("--v2")
const out = resolve(`../../captures/preview/lights${v2 ? "-v2" : ""}`)
mkdirSync(out, { recursive: true })
const server = await createServer({ server: { host: "127.0.0.1", port: 0 }, configFile: false })
await server.listen()
const host = server.resolvedUrls!.local[0]!
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const exe = readdirSync(cache).filter(n => /^chromium-\d+$/.test(n)).reverse().map(n => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)!
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const errors: string[] = []
const results: unknown[] = []
try {
  for (const style of v2 ? [0, 1, 4] : [0, 1, 2, 3]) {
    const page = await browser.newPage({ viewport: { width: 960, height: 600 }, deviceScaleFactor: 1 })
    page.on("pageerror", e => errors.push(e.message))
    page.on("console", m => { if (m.type() === "error" && !m.text().includes("404")) errors.push(m.text()) })
    // Reuse the exact renderer/scene with a fixed clock and camera. No app RAF or audio.
    await page.route("**/src/main.ts", route => route.fulfill({ contentType: "application/javascript", body: "export {}" }))
    await page.goto(`${host}?solo&peaceful=1&seed=7&nohud&lights=${style}`)
    await page.evaluate(async style => {
      const load = (path: string) => import(/* @vite-ignore */ path)
      const css = document.createElement("style")
      css.textContent = "body{margin:0;background:#101620}canvas{display:block;position:fixed;inset:0}#overlay,#hud{display:none}"
      document.head.append(css)
      const [{ Renderer }, { Scene }, { Camera }, { World }, { VEHICLE_BY_ID }, { paintAtlas }] = await Promise.all([
        load("/src/render/renderer.ts"), load("/src/game/scene.ts"), load("/src/game/camera.ts"), load("/shared/sim/world.ts"), load("/shared/config.ts"), load("/src/render/atlas.ts"),
      ])
      const w = window as any, adapter = await (navigator as any).gpu.requestAdapter()
      if (!adapter.info.architecture.includes("metal")) throw new Error("Expected Metal")
      const device = await adapter.requestDevice()
      device.addEventListener("uncapturederror", (e: any) => console.error(e.error.message))
      const canvas = document.querySelector<HTMLCanvasElement>("#view")!
      const context = canvas.getContext("webgpu") as any
      const format = (navigator as any).gpu.getPreferredCanvasFormat()
      context.configure({ device, format, alphaMode: "opaque" })
      const renderer = new Renderer(device, context, format)
      renderer.setAtlas(await paintAtlas())
      const world = new World(7, [{ id: "me", name: "Dax", human: true, picks: { robber: "muscle", cop: "cruiser" } }])
      world.phase = "waiting"; world.robberId = "me"; world.heli.active = false
      const car = world.carOf("me")
      car.role = "robber"; car.vehicle = VEHICLE_BY_ID.get("muscle")
      Object.assign(car.body, { x: 152, z: 180, h: 0 })
      const scene = new Scene(renderer, world.city, style)
      const camera = new Camera()
      camera.snap(car.body.x, car.body.z)
      w.__lights = { world, car, scene, camera, renderer, canvas, device, adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture } }
      w.__drawLights = async (distance: number, dt = 0, brake = false, drive = false) => {
        const input = { throttle: drive ? 1 : 0, brake: brake ? 1 : 0, handbrake: false, boost: false, steer: 0 }
        world.setInput("me", input)
        if (dt > 0) world.step(dt)
        const view = world.view("me"), focus = view.cars.find((c: any) => c.ownerId === "me")
        camera.snap(focus.x, focus.z); camera.dist = distance; camera.pitch = distance < 40 ? 0.68 : 0.93
        canvas.width = innerWidth; canvas.height = innerHeight; renderer.resize(innerWidth, innerHeight)
        scene.input = input
        scene.draw(view, camera, canvas.width, canvas.height, dt, focus)
        await device.queue.onSubmittedWorkDone()
        return { lights: scene.lightCount, stats: renderer.stats, x: focus.x, z: focus.z, adapter: w.__lights.adapter }
      }
      document.querySelector<HTMLElement>("#hud")!.style.display = "none"
    }, style)
    for (const [name, distance, brake, heading] of [["close", 24, false, 3.5], ["rear", 24, true, 0], ["game", 72, false, 0]] as const) {
      const result = await page.evaluate(async ({ distance, brake, heading }) => {
        const w = window as any
        w.__lights.car.body.h = heading
        w.__lights.scene.resetBench()
        return await w.__drawLights(distance, 0, brake)
      }, { distance, brake, heading })
      await page.screenshot({ path: join(out, `${style}-${name}.png`) })
      results.push({ style, name, ...result })
    }
    if (v2) {
      const drive = await page.evaluate(async () => {
        const w = window as any
        Object.assign(w.__lights.car.body, { x: 152, z: 180, h: 0, vx: 0, vz: 0, yaw: 0 })
        w.__lights.scene.resetBench()
        const samples = []
        for (let frame = 0; frame < 180; frame++) samples.push(await w.__drawLights(72, 1 / 60, false, true))
        if (samples[179].z - samples[0].z < 10 || Math.abs(samples[179].x - samples[0].x) > 0.1) throw new Error("Straight drive did not advance")
        return { start: samples[0], end: samples[179], frames: samples.length }
      })
      results.push({ style, name: "straight-drive", ...drive })
      await page.screenshot({ path: join(out, `${style}-drive.png`) })
    }
    // Portrait, simulated at 30Hz: near framing, rear/brake view, then driving framing.
    if (process.argv.includes("--video")) {
      await page.setViewportSize({ width: 720, height: 1280 })
      await page.evaluate(style => {
        const w = window as any
        w.__lights.car.body.h = 0
        w.__lights.scene.resetBench()
        const label = document.createElement("div")
        label.textContent = ["0 · Current", "1 · Recessed", "2 · Light bar", "3 · Cinematic"][style]!
        label.style.cssText = "position:fixed;top:36px;left:32px;color:#fff;font:500 28px system-ui;background:#101620c0;padding:10px 16px;border-radius:8px"
        document.body.append(label)
      }, style)
      for (let frame = 0; frame < 180; frame++) {
        await page.evaluate(async frame => {
          const w = window as any
          if (frame < 60) w.__lights.car.body.h = 3.5 - frame / 60 * 3.5
          if (frame === 90) Object.assign(w.__lights.car.body, { x: 152, z: 180, h: 0, vx: 0, vz: 0, yaw: 0 })
          await w.__drawLights(frame < 90 ? 30 : 72, frame < 90 ? 0 : 1 / 30, frame >= 60 && frame < 90 || frame >= 165, frame >= 90 && frame < 165)
        }, frame)
        await page.screenshot({ path: join(out, `phone-${String(style * 180 + frame).padStart(4, "0")}.png`) })
      }
    }
    if (process.argv.includes("--pose")) {
      for (const [name, height, roll, pitch] of [["lift", 0.8, 0, 0], ["roll", 0.4, 0.22, 0], ["brake", 0.3, 0, 0.16], ["combined", 0.9, -0.2, -0.18]] as const) {
        const result = await page.evaluate(async ({ style, height, roll, pitch }) => {
          const load = (path: string) => import(/* @vite-ignore */ path)
          const { bodyPoint } = await load("/src/game/car-pose.ts")
          const { lampMounts } = await load("/src/render/car-lights.ts")
          const w = window as any, { car, scene, renderer, world } = w.__lights
          Object.assign(car.body, { x: 152, z: 180, h: 3.5, vx: 0, vz: 0, y: 0, vy: 0, wheels: 0 })
          scene.resetBench()
          Object.assign(scene.visOf(world.view("me").cars[0]), { height, roll, pitch })
          const render = renderer.render.bind(renderer)
          let checked = false
          renderer.render = (options: any) => {
            // Use the actual instance pose sent to the body shader, not the injected input.
            const instance = options.batches[0].data
            const c = { x: instance[0], z: instance[2], h: instance[3] }
            const pose = { height: instance[1], roll: instance[4], pitch: instance[5] }
            const near = (a: number[], b: number[], label: string) => {
              if (a.some((v, i) => Math.abs(v - b[i]!) > 0.00003)) throw new Error(`${label}: ${a} != ${b}`)
            }
            near([pose.height, pose.roll, pose.pitch], [height, roll, pitch], "body pose")
            const mount = lampMounts(car.vehicle), half = car.vehicle.length / 2
            const source = style === 0 ? [0, 1.3, half + 0.5] : [0, mount.frontY, half + 0.08]
            const target = style === 0 ? [0, 1, half + 1.45] : [0, mount.frontY - (style === 4 ? mount.frontY / scene.lightSettings.poolAhead : 0.28), half + 1.08]
            const head = bodyPoint(c, pose, source), aim = bodyPoint(c, pose, target)
            near(Array.from(options.lights.slice(0, 3)), head, "headlight source")
            const dir = aim.map((v: number, i: number) => v - head[i])
            const length = Math.hypot(...dir)
            near(Array.from(options.lights.slice(8, 11)), dir.map((v: number) => v / length), "headlight aim")
            const sources = style === 0 ? [[0, 0.9, -half - 0.6]] : [[0, mount.rearY, -half - 0.28], [0, mount.frontY + 0.5, half + 0.16], [0, mount.rearY + 0.4, -half - 0.14]]
            sources.forEach((local, i) => near(Array.from(options.lights.slice((i + 1) * 12, (i + 1) * 12 + 3)), bodyPoint(c, pose, local), "tail/body light"))
            const hw = car.vehicle.width / 2 - 0.25
            const lens = style === 0 ? [-hw, 0.75, half + 0.1] : [-mount.frontX, mount.frontY + 0.02, half + 0.065]
            const tail = style === 0 ? [-hw, 0.75, -half - 0.05] : [-mount.rearX, mount.rearY + 0.02, -half - 0.075]
            near(Array.from(options.sprites.add.slice(0, 3)), bodyPoint(c, pose, lens), "head glow")
            near(Array.from(options.sprites.add.slice(12, 15)), bodyPoint(c, pose, tail), "tail glow")
            if (style !== 0) {
              const head = bodyPoint(c, pose, lens)
              near([options.sprites.add[24], options.sprites.add[26]], [head[0], head[2]], "beam footprint origin")
              if (options.sprites.add[8] !== 11 || options.sprites.add[20] !== 11) throw new Error("Round glow returned")
            }
            checked = true
            render(options)
          }
          try { await w.__drawLights(24, 0, true) } finally { renderer.render = render }
          if (!checked) throw new Error("Missing posed render")
          return { style, height, roll, pitch, passed: true }
        }, { style, height, roll, pitch })
        results.push({ name: `pose-${name}`, ...result })
        await page.screenshot({ path: join(out, `${style}-pose-${name}.png`) })
      }
    }
    if (style === 4) {
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
      const controls = await page.evaluate(async () => {
        const load = (path: string) => import(/* @vite-ignore */ path)
        const { DebugOverlay } = await load("/src/ui/debug-overlay.ts")
        const { LIGHT_DEFAULTS } = await load("/src/render/car-lights.ts")
        const w = window as any, { scene, car, renderer } = w.__lights
        Object.assign(car.body, { x: 152, z: 180, h: 3.5, vx: 0, vz: 0, yaw: 0 })
        scene.resetBench()
        let releases = 0, leaked = 0
        const panel = new DebugOverlay(new URLSearchParams("lab=1"), () => releases++, scene.lightSettings)
        const root = panel.host.shadowRoot
        const inputs = [...root.querySelectorAll('input[type="range"]')] as HTMLInputElement[]
        if (inputs.length !== 12 || !root.querySelector("nav").hidden) throw new Error("Incorrect lights controls")
        const onKey = () => leaked++
        window.addEventListener("keydown", onKey)
        const original = renderer.render.bind(renderer)
        let submitted = ""
        renderer.render = (options: any) => {
          const values = [...options.lights.slice(0, 48), ...options.sprites.add.slice(0, 192)]
          if (!values.every(Number.isFinite)) throw new Error("Non-finite tuned light")
          submitted = JSON.stringify(values)
          original(options)
        }
        try {
          for (const input of inputs) {
            const key = input.dataset.key!
            await w.__drawLights(24, 0, key === "brakeIntensity")
            const before = submitted
            input.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }))
            input.dispatchEvent(new KeyboardEvent("keydown", { code: "ArrowRight", bubbles: true, composed: true }))
            input.value = input.max
            input.dispatchEvent(new Event("input", { bubbles: true, composed: true }))
            await w.__drawLights(24, 0, key === "brakeIntensity")
            if (before === submitted || scene.lightSettings[key] !== Number(input.max)) throw new Error(`Ineffective slider ${key}`)
            input.value = input.min
            input.dispatchEvent(new Event("input", { bubbles: true }))
            await w.__drawLights(24, 0, key === "brakeIntensity")
            input.value = String(LIGHT_DEFAULTS[key])
            input.dispatchEvent(new Event("input", { bubbles: true }))
          }
        } finally { renderer.render = original; window.removeEventListener("keydown", onKey) }
        if (leaked || releases !== 12) throw new Error("Lab input isolation failed")
        await w.__drawLights(24)
        return { count: inputs.length, releases, leaked, settings: scene.lightSettings }
      })
      await page.getByRole("button", { name: "Copy Lights JSON" }).click()
      await page.getByRole("button", { name: "Copy Lights JSON" }).filter({ hasText: "Copied" }).waitFor()
      const copied = await page.evaluate(() => navigator.clipboard.readText())
      if (JSON.stringify(JSON.parse(copied)) !== JSON.stringify(controls.settings)) throw new Error("Clipboard settings differ")
      await page.screenshot({ path: join(out, "4-lab.png") })
      results.push({ style, name: "lab", ...controls, clipboard: true })
    }
    await page.close()
    const live = await browser.newPage({ viewport: { width: 640, height: 480 } })
    live.on("pageerror", e => errors.push(e.message))
    await live.goto(`${host}?solo&peaceful=1&seed=7&nohud${style === 4 ? "&lab=1" : `&lights=${style}`}`)
    await live.waitForFunction(() => (window as any).__view)
    if (style === 4 && await live.locator('input[type="range"]').count() !== 12) throw new Error("Default app has no Lights controls")
    await live.screenshot({ path: join(out, `${style}-live.png`) })
    await live.close()
  }
  writeFileSync(join(out, "proof.json"), JSON.stringify({ errors, results }, null, 2))
  if (errors.length) throw new Error(errors.join("\n"))
  if (process.argv.includes("--video")) {
    const encode = Bun.spawn(["ffmpeg", "-y", "-framerate", "30", "-i", join(out, "phone-%04d.png"), "-c:v", "h264_videotoolbox", "-profile:v", "main", "-b:v", "2200k", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(out, "getaway-car-lights-phone.mp4")], { stdout: "ignore", stderr: "ignore" })
    if (await encode.exited !== 0) throw new Error("Phone encode failed")
  }
  console.log("Car-light Metal proof passed", results)
} finally {
  await browser.close()
  await server.close()
}
