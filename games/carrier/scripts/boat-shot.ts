// Boat captures on a real GPU. Runs ON hailmary (Mac Studio): Chrome with WebGPU on Metal loads the live dev server's
// boat harness (boat.html) and plays scripted scenes, capturing the frame through the game's own device under the DOM
// HUD (as scripts/weapons-shot.ts).
//
//   scp scripts/boat-shot.ts hailmary:/tmp/carrier-ocean/ && ssh hailmary 'cd /tmp/carrier-ocean && ~/.bun/bin/bun boat-shot.ts --out=/tmp/carrier-boat/out'
//
// Options: --base=URL  --size=1536x1024  --only=launch,drive,storm,gun,night,recover,hero
import { chromium, type Page } from "playwright-core"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

const args = process.argv.slice(2)
const opt = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const base = opt("base", "https://carrier.lwoyjcaeyxv6.opentunnel.xyz/")
const out = opt("out", "/tmp/carrier-boat/out")
const only = opt("only", "launch,drive,storm,gun,night,recover,hero").split(",")
const [vw, vh] = opt("size", "1536x1024").split("x").map(Number) as [number, number]
mkdirSync(out, { recursive: true })

const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--enable-features=WebGPU", "--ignore-gpu-blocklist"],
})
const logs: string[] = []
let failures = 0
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`)
  if (!ok) failures++
}

async function open(query: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 })
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") logs.push(`${m.type()}: ${m.text()}`)
  })
  page.on("pageerror", (e) => {
    logs.push(`pageerror: ${e.message}`)
    console.log(`pageerror: ${e.message}`)
  })
  await page.addInitScript(() => {
    const Real = WebSocket
    const Fake = function (this: unknown, url: string | URL, protocols?: string | string[]) {
      const p = Array.isArray(protocols) ? protocols : protocols ? [protocols] : []
      if (p.some((x) => x.startsWith("vite"))) return Object.assign(new EventTarget(), { readyState: 0, send() {}, close() {} })
      return new Real(url, protocols)
    } as unknown as typeof WebSocket
    Object.assign(Fake, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3, prototype: Real.prototype })
    globalThis.WebSocket = Fake
  })
  for (let i = 0; ; i++) {
    try {
      await page.goto(`${base}boat.html?seed=7&${query}`, { waitUntil: "load" })
      break
    } catch (e) {
      if (i >= 3) throw e
      await page.waitForTimeout(1500)
    }
  }
  await page.waitForFunction(() => !!(globalThis as unknown as { carrier?: { driver?: unknown } }).carrier?.driver, null, { timeout: 90_000 })
  await page.waitForTimeout(1500)
  return page
}

type S = { y: number; phase: string; phaseT: number; kn: number; heave: number; wy: number; pitch: number; roll: number; air: number; clear: number; slams: number; hp: number; heat: number; yaw: number; gun: number; rounds: number; enemies: number[]; drones: number[] }
const state = (p: Page): Promise<S> =>
  p.evaluate(() => {
    type C = {
      driver: { shown: { heave: number }; phase: string; phaseT: number; hp: number; boat: { u: number; heave: number; wy: number; pitch: number; roll: number; air: number; clear: number; slams: number }; turret: { heat: number; yaw: number; pitch: number }; rounds: { live: number } }
      boats: { hp(id: number): number }
      enemies: { id: number }[]
      combat: { hp(id: number): number }
      drones: { list: { id: number }[] }
    }
    const c = (globalThis as unknown as { carrier: C }).carrier
    const d = c.driver
    const b = d.boat
    return {
      y: d.shown.heave,
      phase: d.phase,
      phaseT: d.phaseT,
      kn: b.u / 0.514444,
      heave: b.heave,
      wy: b.wy,
      pitch: (b.pitch * 180) / Math.PI,
      roll: (b.roll * 180) / Math.PI,
      air: b.air,
      clear: b.clear,
      slams: b.slams,
      hp: d.hp,
      heat: d.turret.heat,
      yaw: (d.turret.yaw * 180) / Math.PI,
      gun: (d.turret.pitch * 180) / Math.PI,
      rounds: d.rounds.live,
      enemies: c.enemies.map((e) => c.boats.hp(e.id)),
      drones: c.drones.list.map((q) => c.combat.hp(q.id)),
    }
  })
const fmt = (s: S) =>
  `${s.phase} t=${s.phaseT.toFixed(1)} ${s.kn.toFixed(0)}kn pitch=${s.pitch.toFixed(1)}° roll=${s.roll.toFixed(1)}° air=${s.air.toFixed(2)} clear=${s.clear.toFixed(1)} slams=${s.slams} hp=${s.hp} heat=${s.heat.toFixed(2)} turret=${s.yaw.toFixed(0)}/${s.gun.toFixed(0)} rounds=${s.rounds} enemies=${s.enemies.map((h) => h.toFixed(0)).join(",")} drones=${s.drones.map((h) => h.toFixed(0)).join(",")}`

async function until(p: Page, ok: (s: S) => boolean, ms = 15_000): Promise<S> {
  const end = Date.now() + ms
  let s = await state(p)
  while (!ok(s) && Date.now() < end) {
    await p.waitForTimeout(40)
    s = await state(p)
  }
  return s
}

const run = (p: Page, js: string) => p.evaluate(js)

async function frame(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const c = (globalThis as unknown as { carrier: { renderer: { context: { device: GPUDevice } } } }).carrier
    const device = c.renderer.context.device
    const ctx = (c.renderer as unknown as { canvas: GPUCanvasContext }).canvas
    const format = navigator.gpu.getPreferredCanvasFormat()
    ctx.configure({ device, format, alphaMode: "opaque", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
    const w = (ctx.canvas as HTMLCanvasElement).width
    const h = (ctx.canvas as HTMLCanvasElement).height
    const row = Math.ceil((w * 4) / 256) * 256
    const buf = device.createBuffer({ size: row * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    await new Promise<void>((resolve) => {
      const get = ctx.getCurrentTexture.bind(ctx)
      const submit = device.queue.submit.bind(device.queue)
      let tex: GPUTexture | null = null
      ctx.getCurrentTexture = () => {
        tex = get()
        ctx.getCurrentTexture = get
        return tex
      }
      device.queue.submit = (cbs: Iterable<GPUCommandBuffer>) => {
        submit(cbs)
        if (!tex) return
        device.queue.submit = submit
        const enc = device.createCommandEncoder()
        enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: row }, [w, h])
        submit([enc.finish()])
        resolve()
      }
    })
    await buf.mapAsync(GPUMapMode.READ)
    const src = new Uint8Array(buf.getMappedRange())
    const img = new ImageData(w, h)
    const bgra = format === "bgra8unorm"
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const s = y * row + x * 4
        const d = (y * w + x) * 4
        img.data[d] = src[s + (bgra ? 2 : 0)]!
        img.data[d + 1] = src[s + 1]!
        img.data[d + 2] = src[s + (bgra ? 0 : 2)]!
        img.data[d + 3] = 255
      }
    buf.unmap()
    const cv = document.createElement("canvas")
    cv.width = w
    cv.height = h
    cv.getContext("2d")!.putImageData(img, 0, 0)
    return cv.toDataURL("image/png")
  })
}

async function shot(page: Page, name: string): Promise<void> {
  const url = await frame(page)
  await page.evaluate((src) => {
    const img = document.createElement("img")
    img.id = "shot-bg"
    img.src = src
    Object.assign(img.style, { position: "fixed", inset: "0", width: "100%", height: "100%", zIndex: "0" })
    const canvas = document.getElementById("view")!
    canvas.style.visibility = "hidden"
    canvas.after(img)
    return new Promise((r) => (img.complete ? r(null) : (img.onload = () => r(null))))
  }, url)
  await page.screenshot({ path: join(out, `${name}.png`) })
  await page.evaluate(() => {
    document.getElementById("shot-bg")?.remove()
    document.getElementById("view")!.style.visibility = ""
  })
  console.log(`${name}: ${fmt(await state(page))}`)
}

const helm = (p: Page, o: { throttle?: number; steer?: number; boost?: boolean } | null) => p.evaluate((o) => ((globalThis as unknown as { carrier: { driver: { input: { override: unknown } } } }).carrier.driver.input.override = o), o)

async function launch(): Promise<void> {
  const p = await open("ship=0.35")
  // From the port beam, a little aft: the boat on the elevator with the carrier behind it.
  await run(p, "carrier.relaunch(); carrier.shipCam = { eye: [140, 22, -40], at: [52, 12, 18] }")
  let s = await until(p, (s) => s.phase === "launch" && s.phaseT > 0.25)
  await run(p, "carrier.paused = true")
  await shot(p, "launch-1-elevator")
  await run(p, "carrier.paused = false")
  s = await until(p, (s) => s.phase === "launch" && s.phaseT > 1.0)
  await run(p, "carrier.paused = true")
  await shot(p, "launch-2-swung-out")
  await run(p, "carrier.paused = false")
  s = await until(p, (s) => s.phase === "launch" && s.phaseT > 2.0)
  await run(p, "carrier.paused = true")
  await shot(p, "launch-3-lowering")
  await run(p, "carrier.paused = false")
  s = await until(p, (s) => s.phase === "drive" && s.phaseT > 0.15)
  await run(p, "carrier.paused = true")
  await shot(p, "launch-4-splash")
  check(s.phase === "drive", "the crane released the boat into the sim")
  check(s.kn > 3, `released moving with the carrier (${s.kn.toFixed(1)} kn)`)
  await run(p, "carrier.paused = false; carrier.shipCam = null")
  await helm(p, { throttle: 1, steer: 0.25 })
  await p.waitForTimeout(3500)
  await shot(p, "launch-5-away")
  await p.close()
}

async function drive(): Promise<void> {
  const p = await open("water&targets=0&drone=0")
  await helm(p, { throttle: 1, steer: 0 })
  let s = await until(p, (s) => s.kn > 40, 12_000)
  check(s.kn > 40, `top speed reached (${s.kn.toFixed(1)} kn)`)
  await p.waitForTimeout(1500)
  await shot(p, "drive-1-chase")
  await run(p, "carrier.inspect = { yaw: 2.2, pitch: 0.12, dist: 34, y: 1.5 }")
  await p.waitForTimeout(400)
  await shot(p, "drive-2-planing-side")
  await run(p, "carrier.inspect = { yaw: 2.75, pitch: 0.22, dist: 42, y: 1 }")
  await p.waitForTimeout(400)
  await shot(p, "drive-3-spray-front")
  await run(p, "carrier.inspect = { yaw: 0.35, pitch: 0.45, dist: 70, y: 0 }")
  await helm(p, { throttle: 1, steer: 1 })
  await p.waitForTimeout(2600)
  await shot(p, "drive-4-turn-wake")
  await run(p, "carrier.inspect = null")
  await helm(p, { throttle: 1, steer: 1, boost: true })
  await p.waitForTimeout(1200)
  await shot(p, "drive-5-boost-turn")
  await helm(p, { throttle: 0, steer: 0 })
  await p.waitForTimeout(5000)
  s = await state(p)
  await run(p, "carrier.inspect = { yaw: 2.2, pitch: 0.12, dist: 34, y: 1.5 }")
  await p.waitForTimeout(300)
  await shot(p, "drive-6-settled-slow")
  await p.close()
}

async function storm(): Promise<void> {
  const p = await open("water&weather=heavy&targets=0&drone=0")
  await helm(p, { throttle: 1, steer: 0 })
  await p.waitForTimeout(3000)
  // Wait for a real jump, then freeze mid-air.
  let best = 0
  for (let i = 0; i < 3; i++) {
    const s = await until(p, (s) => s.air > 0.35 && s.clear > 1.2, 25_000)
    if (s.air > 0.35) {
      await run(p, "carrier.paused = true")
      await run(p, `carrier.inspect = { yaw: ${i === 0 ? 1.6 : 2.4}, pitch: 0.06, dist: 40, y: 1 }`)
      await p.waitForTimeout(250)
      await shot(p, `storm-${i + 1}-airborne`)
      best = Math.max(best, s.clear)
      await run(p, "carrier.inspect = null; carrier.paused = false")
      await p.waitForTimeout(800)
    }
  }
  check(best > 1, `airborne off a storm crest (clear ${best.toFixed(1)} m)`)
  const before = (await state(p)).slams
  await p.waitForTimeout(6000)
  const after = await state(p)
  check(after.slams > before, `slams back down (${after.slams - before} in 6 s)`)
  await shot(p, "storm-4-chase")
  await p.close()
}

async function gun(): Promise<void> {
  const p = await open("water&targets=1&drone=2")
  await helm(p, { throttle: 0.6, steer: 0 })
  await p.waitForTimeout(800)
  // A drone first: the turret leads it and fires.
  await run(p, "carrier.aimDrone(carrier.drones.list[0].id)")
  await p.waitForTimeout(1500)
  await run(p, "carrier.driver.input.trigger = true")
  await p.waitForTimeout(900)
  await run(p, "carrier.inspect = { yaw: 3.0, pitch: 0.1, dist: 26, y: 2.5 }")
  await p.waitForTimeout(300)
  await shot(p, "gun-1-drone-burst")
  await run(p, "carrier.inspect = null")
  await p.waitForTimeout(600)
  await shot(p, "gun-2-drone-chase")
  await run(p, "carrier.driver.input.trigger = false")
  // The enemy boat.
  await run(p, "carrier.aimDrone(carrier.enemies[0].id)")
  await p.waitForTimeout(1500)
  await run(p, "carrier.driver.input.trigger = true")
  let s = await until(p, (s) => s.enemies[0]! < 120, 15_000)
  await shot(p, "gun-3-boat-hits")
  check(s.enemies[0]! < 200, `rounds damage the enemy boat (${s.enemies[0]!.toFixed(0)} hp)`)
  s = await until(p, (s) => s.enemies[0]! <= 0, 20_000)
  await run(p, "carrier.driver.input.trigger = false")
  await p.waitForTimeout(500)
  await shot(p, "gun-4-boat-kill")
  check(s.enemies[0]! <= 0, "the enemy boat is destroyed")
  // Our own damage states.
  await run(p, "carrier.boatHp(70); carrier.aimDrone(null)")
  await helm(p, { throttle: 0.8, steer: 0.3 })
  await p.waitForTimeout(2500)
  await shot(p, "gun-5-smoking")
  await run(p, "carrier.boatHp(30)")
  await p.waitForTimeout(2500)
  await shot(p, "gun-6-burning")
  await p.close()
}

async function night(): Promise<void> {
  const p = await open("water&tod=22.5&targets=1&drone=0")
  await helm(p, { throttle: 0.7, steer: 0.15 })
  await p.waitForTimeout(3000)
  await run(p, "carrier.inspect = { yaw: 2.4, pitch: 0.12, dist: 40, y: 2 }")
  await p.waitForTimeout(400)
  await shot(p, "night-1-port")
  await run(p, "carrier.inspect = { yaw: -2.4, pitch: 0.12, dist: 40, y: 2 }")
  await p.waitForTimeout(400)
  await shot(p, "night-2-starboard")
  await run(p, "carrier.inspect = null")
  await p.waitForTimeout(800)
  await shot(p, "night-3-chase")
  await p.close()
}

async function recover(): Promise<void> {
  const p = await open("ship=0.3&targets=0&drone=0")
  await run(p, "carrier.autoRelaunch = false")
  // Alongside the port beam, a bit behind the crane, matching the carrier's speed.
  await run(p, "carrier.place(-10, -90, carrier.ship.u / 0.514444 + 2)")
  await helm(p, { throttle: 0.3, steer: -0.15 })
  let s = await until(p, (s) => s.phase === "recover", 20_000)
  check(s.phase === "recover", "the crane picks the boat up when it comes alongside slowly")
  await run(p, "carrier.shipCam = { eye: [140, 22, -40], at: [52, 12, 18] }")
  s = await until(p, (s) => s.phase === "recover" && s.phaseT > 1.0)
  await run(p, "carrier.paused = true")
  await shot(p, "recover-1-alongside")
  await run(p, "carrier.paused = false")
  s = await until(p, (s) => s.phase !== "recover" || s.y > 14)
  await run(p, "carrier.paused = true")
  await shot(p, "recover-2-hoisted")
  await run(p, "carrier.paused = false")
  s = await until(p, (s) => s.phase === "idle", 10_000)
  check(s.phase === "idle", "recovered: the boat is struck below")
  await shot(p, "recover-3-aboard")
  await p.close()
}

async function hero(): Promise<void> {
  const p = await open("water&targets=1&drone=0&ship=0.4")
  await run(p, "carrier.place(160, -110, 30)")
  await helm(p, { throttle: 1, steer: 0.08 })
  await p.waitForTimeout(4000)
  await run(p, "carrier.inspect = { yaw: 2.6, pitch: 0.28, dist: 48, y: 1 }")
  await p.waitForTimeout(300)
  await shot(p, "hero-1")
  await p.close()
}

const scenes: Record<string, () => Promise<void>> = { launch, drive, storm, gun, night, recover, hero }
for (const name of only) {
  const f = scenes[name]
  if (!f) continue
  try {
    await f()
  } catch (e) {
    failures++
    console.log(`FAIL ${name}: ${(e as Error).message}`)
  }
}
await browser.close()
if (logs.length) console.log(`\n${[...new Set(logs)].slice(0, 30).join("\n")}`)
console.log(failures ? `\n${failures} FAILED` : "\nall ok")
process.exit(failures ? 1 : 0)
