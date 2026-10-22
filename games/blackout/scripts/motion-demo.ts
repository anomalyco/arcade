import { browserBudget } from "../../../scripts/browser-budget"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { findChromeExecutable, installGpuInstrumentation } from "./compare"

await using budget = browserBudget()
const { chromium } = budget

// Actual simulation + presentation, deterministic input. Only fixture placement/camera framing is scripted.
const root = join(import.meta.dir, "../../.."), out = join(root, "captures/blackout-motion-demo")
const stills = process.argv.includes("--stills")
mkdirSync(out, { recursive: true })
const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
const port = reserve.port!
reserve.stop(true)
const server = Bun.spawn(["bun", "x", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: join(root, "games/blackout"), stdout: "ignore", stderr: "inherit" })
const browser = await chromium.launch({ executablePath: findChromeExecutable(), headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const errors: string[] = [], proof: Record<string, any[]> = {}
try {
  const base = `http://localhost:${port}`, until = Date.now() + 15000
  while (!await fetch(base).then(r => r.ok).catch(() => false)) {
    if (Date.now() > until) throw new Error("Vite failed")
    await Bun.sleep(100)
  }
  for (const scene of ["vehicle", "shotgun"]) for (const on of [false, true]) {
    const name = `${scene}-${on ? "on" : "off"}`, dir = join(out, name)
    mkdirSync(dir, { recursive: true })
    const page = await browser.newPage({ viewport: { width: 540, height: 600 } })
    page.on("pageerror", e => errors.push(e.message))
    page.on("console", m => { if (m.type() === "error" && !m.location().url.endsWith("favicon.ico")) errors.push(m.text()) })
    await installGpuInstrumentation(page)
    await page.addInitScript(() => localStorage.setItem("blackout.gun", "shotgun"))
    await page.goto(`${base}/?practice&map=lot&seed=4&manualVideo=1`, { waitUntil: "networkidle" })
    await page.waitForFunction("window.__gpuDevice && window.__stepManualVideo && window.practice")
    await page.evaluate(async ({ scene, on }) => {
      const w = window as any
      const gamePath = "/src/game/game.ts", worldPath = "/shared/sim/world.ts"
      const { Game } = await import(/* @vite-ignore */ gamePath), { NO_INTENT } = await import(/* @vite-ignore */ worldPath)
      const build = Game.prototype.build
      Game.prototype.build = function(cam: any, ...args: any[]) { w.__game = this; w.__cam = cam; return build.call(this, cam, ...args) }
      await w.__stepManualVideo(1000 / 60); await w.__gpuDevice.queue.onSubmittedWorkDone()
      const g = w.__game, cam = w.__cam, world = w.practice
      world.botFill = 2; world.fill()
      const me = world.players.get("you"), bot = [...world.players.values()].find((p: any) => !p.human) as any
      Object.assign(me, { x: 44, y: 11, vx: 0, vy: 0, aim: 0 })
      Object.assign(g.body, { x: 44, y: 11, vx: 0, vy: 0 }); g.drawn.reset(g.body)
      bot.brain = { think: () => ({ ...NO_INTENT, aim: Math.PI }) }
      Object.assign(bot, { x: 47, y: 11, vx: 0, vy: 0, aim: Math.PI })
      for (const v of world.vehicles) { v.x = 75; v.y = 40 + v.id * 3 }
      const car = world.vehicles[0]
      if (scene === "vehicle") {
        Object.assign(car, { x: 34, y: 8, h: 0, vx: 0, vy: 0, w: 0 })
        car.seats[0] = bot.id; bot.veh = car.id; bot.seat = 0
      }
      cam.snap(44.8, scene === "vehicle" ? 9 : 10.5); cam.dist = 14; cam.zoomOffset = -10
      if (scene === "vehicle") cam.follow = () => {} // stationary observer; car motion comes from driveStep
      const controls = document.querySelector("[data-lab]")!.shadowRoot!
      if (controls.querySelector('[data-key="rings"], [data-key="lamps"]')) throw new Error("Retired controls remain")
      if (!controls.querySelector<HTMLInputElement>('[data-key="lookGloss"]')!.checked) throw new Error("Tile reflections must default on")
      const motion = controls.querySelector<HTMLInputElement>('[data-key="lookMotion"]')!
      if (motion.checked) throw new Error("Motion must default off")
      motion.checked = on; motion.dispatchEvent(new Event("change"))
      const host = document.querySelector<HTMLElement>("[data-lab]")!
      host.style.visibility = "hidden"
      // No page-level audio; screenshots become a silent proof video.
      const label = document.createElement("div")
      label.textContent = `${on ? "ON" : "OFF"} · ${scene === "vehicle" ? "VEHICLE · 1×" : "SHOTGUN · 0.25×"}`
      label.style.cssText = "position:fixed;top:0;left:0;right:0;height:28px;padding:5px 12px;background:#10161a;color:#fff;font:13px monospace;z-index:9999"
      document.body.append(label)
      w.__driver = bot; w.__car = car; w.__drive = false
      if (scene === "vehicle") bot.brain = { think: () => ({ ...NO_INTENT, my: w.__drive ? -1 : 0, aim: 0 }) }
    }, { scene, on })
    const aim = await page.evaluate(() => (window as any).__cam.project(47, 1.18, 11, 540, 600))
    await page.mouse.move(Math.min(530, aim.x), aim.y)
    await page.evaluate(async () => {
      const w = window as any
      for (let i = 0; i < 240; i++) { await w.__stepManualVideo(1000 / 60); await w.__gpuDevice.queue.onSubmittedWorkDone(); await w.__gpuDrain() }
    })
    await page.screenshot({ path: join(dir, "settled.png") })
    const states: any[] = [], count = scene === "vehicle" ? 120 : 90
    for (let frame = 0; frame < count; frame++) {
      if (scene === "shotgun") {
        const target = await page.evaluate(() => (window as any).__cam.project(47, 1.18, 11, 540, 600))
        await page.mouse.move(target.x, target.y)
      }
      if (scene === "vehicle" && frame === 0) await page.evaluate(() => { const w = window as any; w.__drive = true; w.__car.vx = 15 })
      if (scene === "shotgun" && frame === 24) await page.mouse.down()
      if (scene === "shotgun" && frame === 27) await page.mouse.up()
      if (scene === "shotgun" && frame === 54) await page.keyboard.press("g")
      states.push(await page.evaluate(async () => {
        const w = window as any
        await w.__stepManualVideo(1000 / 60); await w.__gpuDevice.queue.onSubmittedWorkDone(); await w.__gpuDrain()
        const g = w.__game
        return { car: [w.__car.x, w.__car.y, w.__car.vx], player: [g.body.x, g.body.y], camera: [...w.__cam.viewProj], tracers: g.tracers.length, flashes: g.flashFx.length, grenades: g.grenades.size, debris: g.debris.length, bodies: g.corpses.length }
      }))
      if (!stills || [24, 25, 26, 48, 64, 76].includes(frame)) await page.screenshot({ path: join(dir, `${String(frame).padStart(4, "0")}.png`) })
    }
    proof[name] = states
    writeFileSync(join(dir, "states.json"), JSON.stringify(states))
    if (scene === "shotgun" && (!states.some(s => s.flashes && s.tracers) || !states.some(s => s.debris) || !states.some(s => s.grenades) || !states.some(s => s.bodies))) throw new Error(`Shotgun fixture missed required fast effects: ${JSON.stringify(Object.fromEntries(["flashes", "tracers", "debris", "grenades", "bodies"].map(k => [k, Math.max(...states.map(s => s[k]))])))}`)
    await page.close()
  }
  for (const scene of ["vehicle", "shotgun"]) if (JSON.stringify(proof[`${scene}-off`]) !== JSON.stringify(proof[`${scene}-on`])) throw new Error(`${scene} input/state mismatch`)
  if (errors.length) throw new Error(errors.join("\n"))
  writeFileSync(join(out, "proof.json"), JSON.stringify({ identicalSimulation: true, viewport: [540, 600], states: proof }, null, 2))
  if (!stills) {
    const run = async (args: string[]) => { const p = Bun.spawn(args, { stdout: "ignore", stderr: "inherit" }); if (await p.exited) throw new Error(args[0]) }
    for (const scene of ["vehicle", "shotgun"]) {
      const fps = scene === "vehicle" ? "60" : "15"
      await run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-framerate", fps, "-i", join(out, `${scene}-off/%04d.png`), "-framerate", fps, "-i", join(out, `${scene}-on/%04d.png`), "-filter_complex", "[0:v][1:v]hstack=inputs=2,fps=60[v]", "-map", "[v]", "-an", "-c:v", "h264_videotoolbox", "-profile:v", "high", "-q:v", "75", "-pix_fmt", "yuv420p", join(out, `${scene}.mp4`)])
    }
    writeFileSync(join(out, "clips.txt"), "file 'vehicle.mp4'\nfile 'shotgun.mp4'\n")
    await run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", join(out, "clips.txt"), "-c", "copy", "-movflags", "+faststart", join(out, "blackout-motion-blur.mp4")])
  }
  console.log(JSON.stringify({ identicalSimulation: true, scenes: Object.keys(proof), output: out, stills }))
} finally { await browser.close(); server.kill(); await server.exited }
