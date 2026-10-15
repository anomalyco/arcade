// Boat captures on a real GPU. Runs ON hailmary (Mac Studio): Chrome with WebGPU on Metal loads the live dev server's
// boat harness (boat.html) and plays scripted scenes, capturing the frame through the game's own device under the DOM
// HUD (as scripts/weapons-shot.ts).
//
//   scp scripts/boat-shot.ts hailmary:/tmp/carrier-ocean/ && ssh hailmary 'cd /tmp/carrier-ocean && ~/.bun/bin/bun boat-shot.ts --out=/tmp/carrier-boat/out'
//
// Options: --base=URL  --size=1536x1024  --only=launch,drive,storm,gun,night,recover,hero,mp
//   mp: the real game, two pages in one fresh room on opposite teams: A launches the boat from DEPLOY (B
//   watches the crane), drives at B's carrier and strafes it (B's hull drops, B sees the boat and its tracers, Tab lists
//   A as BOAT), then B's Hornet strafes the boat until it sinks; A is back at the helm and the boat recharges.
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
  const harness = await page.evaluate(() => !!(globalThis as unknown as { carrier: { driver?: unknown } }).carrier.driver)
  console.log(`${name}: ${harness ? fmt(await state(page)) : mfmt(await mstate(page))}`)
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
  await run(p, "carrier.boatHp(40); carrier.aimDrone(null)")
  await helm(p, { throttle: 0.8, steer: 0.3 })
  await p.waitForTimeout(2500)
  await shot(p, "gun-5-smoking")
  await run(p, "carrier.boatHp(18)")
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

// ---- the real game, two pages -------------------------------------------------------------------------------------

async function openGame(query: string, name: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 })
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") logs.push(`${m.type()}: ${m.text()}`)
  })
  page.on("pageerror", (e) => {
    logs.push(`pageerror: ${e.message}`)
    console.log(`pageerror: ${e.message}\n${e.stack ?? ""}`)
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
  await page.addInitScript((n) => localStorage.setItem("carrier.name", n), name)
  await page.goto(`${base}?${query}`, { waitUntil: "load" })
  await page.waitForFunction(() => !!(globalThis as unknown as { carrier?: { boat?: unknown } }).carrier?.boat, null, { timeout: 60_000 })
  await page.waitForTimeout(1500)
  return page
}

type M = { online: string; id: number; team: number; ship: number; role: string; boat: { phase: string; knots: number; hp: number; x: number; z: number; remote: number }; hulls: Record<number, number>; feed: string; seat: string; kd: string; remoteFiring: boolean }
const mstate = (p: Page): Promise<M> =>
  p.evaluate(() => {
    type C = {
      net: { state: string; id: number; crew: { players: { id: number; team: number; ship: number }[] } | null; hulls: Map<number, { hp: number }>; stats: Map<number, { kills: number; deaths: number }> }
      game: { state: { role: string } }
      boat: { status: { phase: string; knots: number; hp: number; x: number; z: number; remote: number }; remotes: { boats: Map<number, { net: { firing: boolean } }> } }
    }
    const c = (globalThis as unknown as { carrier: C }).carrier
    const me = c.net.crew?.players.find((x) => x.id === c.net.id)
    const txt = (s: string) => ((document.querySelector(s) as HTMLElement | null)?.innerText ?? "").replace(/\s+/g, " ").trim()
    return {
      online: c.net.state,
      id: c.net.id,
      team: me?.team ?? -1,
      ship: me?.ship ?? -1,
      role: c.game.state.role,
      boat: c.boat.status,
      hulls: Object.fromEntries([...c.net.hulls].map(([id, h]) => [id, Math.round(h.hp)])),
      feed: txt("#wp .feed"),
      seat: txt("#hud .seat") || txt("#hud"),
      kd: [...c.net.stats].map(([id, v]) => `${id}:${v.kills}/${v.deaths}`).join(" "),
      remoteFiring: [...c.boat.remotes.boats.values()].some((r) => r.net.firing),
    }
  })
const mfmt = (m: M) => `${m.online} id ${m.id} team ${m.team} ship ${m.ship} ${m.role} boat ${m.boat.phase} ${m.boat.knots.toFixed(0)}kn hp ${m.boat.hp.toFixed(0)} remote ${m.boat.remote} hulls ${JSON.stringify(m.hulls)} kd "${m.kd}" feed "${m.feed}"`
async function muntil(p: Page, ok: (m: M) => boolean, ms = 15_000): Promise<M> {
  const end = Date.now() + ms
  let m = await mstate(p)
  while (!ok(m) && Date.now() < end) {
    await p.waitForTimeout(80)
    m = await mstate(p)
  }
  return m
}

/** Page `p` runs a free camera that follows `what()` (a JS expression giving {x, y, z, heading}) from a fixed offset. */
async function follow(p: Page, what: string, yawOff: number, pitch: number, dist: number): Promise<void> {
  await p.evaluate(
    ([what, yawOff, pitch, dist]) => {
      const c = (globalThis as unknown as { carrier: { game: { state: { free: boolean } }; camera: { set(v: object): void; y: number } } }).carrier
      const w = globalThis as unknown as { follow?: number }
      if (w.follow) clearInterval(w.follow)
      c.game.state.free = true
      const get = new Function("carrier", `return ${what}`) as (c: unknown) => { x: number; y: number; z: number; heading: number } | null
      w.follow = setInterval(() => {
        const t = get(c)
        if (!t) return
        c.camera.set({ x: t.x, z: t.z, yaw: t.heading + (yawOff as number), pitch, dist })
        c.camera.y = t.y
      }, 16) as unknown as number
    },
    [what, yawOff, pitch, dist] as const,
  )
}
const unfollow = (p: Page) =>
  p.evaluate(() => {
    const w = globalThis as unknown as { follow?: number; carrier: { game: { state: { free: boolean } } } }
    if (w.follow) clearInterval(w.follow)
    w.follow = undefined
    w.carrier.game.state.free = false
  })

async function mp(): Promise<void> {
  const room = `boat${Math.floor(Math.random() * 1e6)}`
  const a = await openGame(`room=${room}`, "ADA")
  let ma = await muntil(a, (m) => m.online === "online" && m.role !== "none", 20_000)
  const b = await openGame(`room=${room}`, "BO")
  let mb = await muntil(b, (m) => m.online === "online" && m.role !== "none", 20_000)
  check(ma.team !== mb.team, `opposite teams: A ${mfmt(ma)} | B ${mfmt(mb)}`)
  // A opens DEPLOY: LAUNCH BOAT is there.
  await a.keyboard.press("KeyE")
  await a.waitForTimeout(400)
  await shot(a, "mp-00-a-ops-menu")
  const row = await a.evaluate(() => (document.querySelector(".om") as HTMLElement | null)?.innerText ?? "")
  check(/LAUNCH BOAT/.test(row), "DEPLOY lists LAUNCH BOAT")
  await run(a, "carrier.ops.close()")
  // B watches A's carrier's port elevator from abeam.
  const aShip = ma.ship
  const shipExpr = (id: number, lx: number, ly: number, lz: number) =>
    `(() => { const s = carrier.flight.carriers.find((q) => q.id === ${id}); if (!s) return null; const a = Math.PI - s.heading; return { x: s.x + ${lx} * Math.cos(a) + ${lz} * Math.sin(a), y: s.heave + ${ly}, z: s.z - ${lx} * Math.sin(a) + ${lz} * Math.cos(a), heading: s.heading } })()`
  await follow(b, shipExpr(aShip, 50, 8, 18), -Math.PI / 2 - 0.5, 0.18, 150)
  await run(a, 'carrier.net.op("boat")')
  ma = await muntil(a, (m) => m.boat.phase === "launch" && m.boat.remote >= 0, 5000)
  check(ma.boat.phase === "launch", `A's boat on the crane: ${mfmt(ma)}`)
  await a.waitForTimeout(900)
  await shot(b, "mp-01-b-sees-crane")
  await shot(a, "mp-02-a-launching")
  ma = await muntil(a, (m) => m.boat.phase === "drive", 8000)
  check(ma.boat.phase === "drive", `A drives: ${mfmt(ma)}`)
  await a.waitForTimeout(300)
  await shot(b, "mp-03-b-sees-splash")
  await unfollow(b)

  // The fleets start ~9.6 km apart across the archipelago (shared/spawn.ts), so B comes to the boat: A drives out, B's
  // Hornet makes low passes across the boat's bow and A's turret leads it and fires.
  await a.evaluate(() => {
    const c = (globalThis as unknown as { carrier: { boat: { driver: { input: { override: unknown } } } } }).carrier
    c.boat.driver.input.override = { throttle: 1, steer: 0.12, boost: false }
  })
  await a.waitForTimeout(4000)
  await shot(a, "mp-04-a-driving")
  await run(b, 'carrier.net.op("hornet")')
  await b.waitForFunction(() => (globalThis as unknown as { carrier: { flight: { flight: { phase: string } } } }).carrier.flight.flight.phase === "flying", null, { timeout: 25_000 })
  const aId = ma.id
  const bId = mb.id
  // B's jet: a flight path re-aimed every frame (the stick held level): `pass` crosses 120 m ahead of the boat at 60 m,
  // `dive` comes down on it from 1.1 km astern with the nose on the lead point.
  await b.evaluate((id) => {
    type P = Record<string, number | string>
    type R = { shown: { x: number; z: number; heave: number; heading: number }; boat: { u: number } }
    const c = (globalThis as unknown as { carrier: { boat: { remotes: { boats: Map<number, R> } }; flight: { flight: { plane: P; prev: P; cam: { reset(): void } }; input: { override: unknown } } } }).carrier
    const w = globalThis as unknown as { glue?: number; pass?: () => void; dive?: () => void; mode?: string; goal?: number[] }
    const f = c.flight.flight
    const aimAt = (x: number, y: number, z: number, sp: number) => {
      const p = f.plane as Record<string, number>
      const dx = x - p.x!
      const dy = y - p.y!
      const dz = z - p.z!
      const h = Math.atan2(dx, -dz)
      const el = Math.atan2(dy, Math.hypot(dx, dz))
      const wa = Math.cos((Math.PI - h) / 2)
      const ya = Math.sin((Math.PI - h) / 2)
      const xb = Math.sin(-el / 2)
      const wb = Math.cos(-el / 2)
      Object.assign(p, { qx: wa * xb, qy: ya * wb, qz: -ya * xb, qw: wa * wb, vx: sp * Math.cos(el) * Math.sin(h), vy: sp * Math.sin(el), vz: -sp * Math.cos(el) * Math.cos(h), p: 0, r: 0, w: 0 })
    }
    const start = (x: number, y: number, z: number) => {
      Object.assign(f.plane, { x, y, z, throttle: 0.6, blend: 1, stall: 0, outside: 0 })
      Object.assign(f.prev, f.plane)
      f.cam.reset()
      c.flight.input.override = { pitch: 0, roll: 0, yaw: 0 }
    }
    w.pass = () => {
      const r = c.boat.remotes.boats.get(id)
      if (!r) return
      const s = r.shown
      const fx = Math.sin(s.heading)
      const fz = -Math.cos(s.heading)
      // From 1 km off the boat's starboard bow to the same off its port bow, 300 m ahead of it, 60 m up.
      const cx = s.x + fx * 300
      const cz = s.z + fz * 300
      start(cx - fz * 1000, 60, cz + fx * 1000)
      w.goal = [cx + fz * 1000, 60, cz - fx * 1000]
      w.mode = "pass"
    }
    w.dive = () => {
      const r = c.boat.remotes.boats.get(id)
      if (!r) return
      const s = r.shown
      start(s.x - Math.sin(s.heading) * 1100, 170, s.z + Math.cos(s.heading) * 1100)
      w.mode = "dive"
    }
    w.glue = setInterval(() => {
      const p = f.plane as Record<string, number>
      const sp = Math.hypot(p.vx!, p.vy!, p.vz!) || 140
      if (w.mode === "pass" && w.goal) return aimAt(w.goal[0]!, w.goal[1]!, w.goal[2]!, Math.max(120, sp))
      const r = c.boat.remotes.boats.get(id)
      if (!r || w.mode !== "dive") return
      const s = r.shown
      const t = Math.hypot(s.x - p.x!, s.heave - p.y!, s.z - p.z!) / 1190
      aimAt(s.x + Math.sin(s.heading) * r.boat.u * t, s.heave + 1.5 + 4.9 * t * t, s.z - Math.cos(s.heading) * r.boat.u * t, sp)
    }, 16) as unknown as number
  }, aId)
  // A's turret leads B's jet (the gun's own ballistics) while it fires.
  await a.evaluate((bid) => {
    type V = { x: number; y: number; z: number; vx: number; vy: number; vz: number; alive: boolean }
    const c = (globalThis as unknown as { carrier: { flight: { weapons: { jets: Map<number, V> } }; boat: { driver: { boat: { x: number; z: number; heave: number }; aimAt: number[] | null } } } }).carrier
    const w = globalThis as unknown as { track?: number }
    w.track = setInterval(() => {
      const j = c.flight.weapons.jets.get(bid)
      const b = c.boat.driver.boat
      if (!j || !j.alive) return
      const t = Math.hypot(j.x - b.x, j.y - b.heave - 2.5, j.z - b.z) / 1100
      c.boat.driver.aimAt = [j.x + j.vx * t, j.y + j.vy * t + 4.9 * t * t, j.z + j.vz * t]
    }, 16) as unknown as number
  }, bId)
  const jetHp = () => b.evaluate(() => (globalThis as unknown as { carrier: { flight: { weaponStatus: { hp: number } } } }).carrier.flight.weaponStatus.hp)
  const hp0 = await jetHp()
  let hp1 = hp0
  for (let i = 0; i < 4 && hp1 >= hp0; i++) {
    await run(b, "globalThis.pass()")
    await b.waitForTimeout(3600)
    await run(a, "carrier.boat.driver.input.trigger = true")
    await b.waitForTimeout(1300)
    if (i === 0) {
      await shot(a, "mp-05-a-shoots-jet")
      // B sees A's boat and its tracers, from beside it.
      await follow(b, `(() => { const r = [...carrier.boat.remotes.boats.values()][0]; return r ? { x: r.shown.x, y: r.shown.heave + 2, z: r.shown.z, heading: r.shown.heading } : null })()`, 2.5, 0.12, 55)
      await b.waitForTimeout(250)
      mb = await mstate(b)
      check(mb.boat.remote === 1 && mb.remoteFiring, `B sees A's boat firing: ${mfmt(mb)}`)
      await shot(b, "mp-06-b-sees-boat-firing")
      await unfollow(b)
    }
    await b.waitForTimeout(2500)
    await run(a, "carrier.boat.driver.input.trigger = false")
    hp1 = await jetHp()
    console.log(`flyby ${i + 1}: B's jet hp ${hp0} -> ${hp1}`)
  }
  check(hp1 < hp0, `A's 25 mm hits B's Hornet: ${hp0} -> ${hp1}`)
  await a.evaluate(() => clearInterval((globalThis as unknown as { track?: number }).track))
  await run(a, "carrier.boat.driver.aimAt = null")

  // Tab on B lists A as BOAT.
  await b.keyboard.down("Tab")
  await b.waitForTimeout(400)
  const tab = await b.evaluate(() => (document.querySelector(".tm") as HTMLElement | null)?.innerText ?? document.body.innerText)
  await shot(b, "mp-08-b-tab")
  await b.keyboard.up("Tab")
  check(/BOAT/.test(tab), "B's Tab lists A's boat")

  // B's Hornet (another one if it was shot down) dives on the boat and strafes it until it sinks.
  const flying = () => b.evaluate(() => (globalThis as unknown as { carrier: { flight: { flight: { phase: string } } } }).carrier.flight.flight.phase === "flying")
  if (!(await flying())) {
    await b.waitForTimeout(4000)
    await run(b, 'carrier.net.op("hornet")')
  }
  await b.waitForFunction(() => (globalThis as unknown as { carrier: { flight: { flight: { phase: string } } } }).carrier.flight.flight.phase === "flying", null, { timeout: 25_000 })
  await a.evaluate(() => {
    const c = (globalThis as unknown as { carrier: { boat: { driver: { input: { override: unknown } } } } }).carrier
    c.boat.driver.input.override = { throttle: 0.4, steer: 0.15, boost: false }
  })
  let passes = 0
  let hpBefore = (await mstate(a)).boat.hp
  while (passes < 8 && (await mstate(a)).boat.hp > 0 && (await mstate(a)).boat.phase === "drive") {
    passes++
    await run(b, "globalThis.dive()")
    await b.waitForTimeout(2600)
    await run(b, "carrier.flight.weapons.input.trigger = true")
    await b.waitForTimeout(900)
    if (passes === 1) {
      await shot(b, "mp-09-b-jet-strafes-boat")
      await shot(a, "mp-10-a-under-fire")
    }
    await b.waitForTimeout(1300)
    await run(b, "carrier.flight.weapons.input.trigger = false")
    const m = await mstate(a)
    console.log(`pass ${passes}: ${mfmt(m)}`)
    if (passes === 1) check(m.boat.hp < hpBefore, `B's gun hurts A's boat: ${hpBefore.toFixed(0)} -> ${m.boat.hp.toFixed(0)}`)
    hpBefore = m.boat.hp
  }
  await b.evaluate(() => clearInterval((globalThis as unknown as { glue?: number }).glue))
  ma = await muntil(a, (m) => m.boat.phase === "sunk" || m.boat.phase === "idle", 3000)
  check(ma.boat.phase === "sunk" || ma.role !== "pilot", `A's boat destroyed: ${mfmt(ma)}`)
  await a.waitForTimeout(1200)
  await shot(a, "mp-11-a-boat-lost")
  ma = await muntil(a, (m) => m.role === "helm", 12_000)
  check(ma.role === "helm", `A back at the helm after the sinking: ${mfmt(ma)}`)
  await a.keyboard.press("KeyE")
  await a.waitForTimeout(400)
  const ops2 = await a.evaluate(() => (document.querySelector(".om") as HTMLElement | null)?.innerText ?? "")
  await shot(a, "mp-12-a-boat-recharging")
  check(/RECHARGING/.test(ops2), "the boat recharges after the sinking")
  mb = await mstate(b)
  check(/\b\d+:1\//.test(mb.kd), `B is credited with the kill: kd "${mb.kd}" feed "${mb.feed}"`)
  await a.close()
  await b.close()
}

/**
 * The fleets start on opposite sides of the archipelago, so B steams its carrier in at full speed while A's boat races
 * out to meet it; within reach A strafes B's carrier (B's hull bar drops; B watches the boat's tracers hit).
 */
async function strafe(): Promise<void> {
  const room = `boat${Math.floor(Math.random() * 1e6)}`
  const a = await openGame(`room=${room}`, "ADA")
  let ma = await muntil(a, (m) => m.online === "online" && m.role === "helm", 20_000)
  const b = await openGame(`room=${room}`, "BO")
  let mb = await muntil(b, (m) => m.online === "online" && m.role === "helm", 20_000)
  check(ma.team !== mb.team && mb.role === "helm", `A and B at their helms: A ${mfmt(ma)} | B ${mfmt(mb)}`)
  const bShip = mb.ship
  await run(b, "carrier.game.state.helm.order = 1")
  await run(a, 'carrier.net.op("boat")')
  ma = await muntil(a, (m) => m.boat.phase === "drive", 10_000)
  // Race at B's carrier, boosting whenever it can, steering round its bow onto its beam at ~550 m.
  await a.evaluate((ship) => {
    type B = { x: number; z: number; heading: number; heave: number; boost?: number }
    const c = (globalThis as unknown as { carrier: { boat: { driver: { boat: B; input: { override: unknown } ; aimAt: number[] | null } }; flight: { carriers: (B & { id?: number })[] } } }).carrier
    const w = globalThis as unknown as { drive?: number }
    w.drive = setInterval(() => {
      const s = c.flight.carriers.find((q) => q.id === ship)
      const d = c.boat.driver
      if (!s) return
      const b = d.boat
      const dx = s.x - b.x
      const dz = s.z - b.z
      const dist = Math.hypot(dx, dz)
      // A point 550 m off whichever beam of B's carrier we are on.
      const side = Math.sign((b.x - s.x) * Math.cos(s.heading) + (b.z - s.z) * Math.sin(s.heading)) || 1
      const tx = s.x + Math.cos(s.heading) * 550 * side
      const tz = s.z + Math.sin(s.heading) * 550 * side
      const close = Math.hypot(tx - b.x, tz - b.z) < 150
      const want = close ? s.heading + Math.PI : Math.atan2(tx - b.x, -(tz - b.z))
      const dh = Math.atan2(Math.sin(want - b.heading), Math.cos(want - b.heading))
      d.input.override = { throttle: close ? 0.5 : 1, steer: Math.max(-1, Math.min(1, dh * 2)), boost: dist > 1500 }
      d.aimAt = [s.x, s.heave + 10, s.z]
    }, 50) as unknown as number
  }, bShip)
  const dist = () =>
    a.evaluate((ship) => {
      const c = (globalThis as unknown as { carrier: { boat: { driver: { boat: { x: number; z: number } } }; flight: { carriers: { id?: number; x: number; z: number }[] } } }).carrier
      const s = c.flight.carriers.find((q) => q.id === ship)
      const b = c.boat.driver.boat
      return s ? Math.hypot(s.x - b.x, s.z - b.z) : 1e9
    }, bShip)
  const t0 = Date.now()
  let d = await dist()
  while (d > 900 && Date.now() - t0 < 330_000) {
    await a.waitForTimeout(2000)
    d = await dist()
    if ((Date.now() - t0) % 30_000 < 2100) console.log(`closing: ${d.toFixed(0)} m, ${mfmt(await mstate(a))}`)
  }
  check(d <= 900, `A's boat within reach of B's carrier: ${d.toFixed(0)} m after ${((Date.now() - t0) / 1000).toFixed(0)} s`)
  await shot(a, "strafe-1-a-closing")
  const hull0 = (await mstate(b)).hulls[bShip] ?? 1000
  await run(a, "carrier.boat.driver.input.trigger = true")
  await a.waitForTimeout(1800)
  await shot(a, "strafe-2-a-strafing")
  await follow(b, `(() => { const r = [...carrier.boat.remotes.boats.values()][0]; return r ? { x: r.shown.x, y: r.shown.heave + 2, z: r.shown.z, heading: r.shown.heading } : null })()`, 2.6, 0.15, 60)
  await b.waitForTimeout(600)
  await shot(b, "strafe-3-b-sees-boat-firing")
  const shipAt = `(() => { const s = carrier.flight.carriers.find((q) => q.id === ${bShip}); return s ? { x: s.x, y: s.heave + 15, z: s.z, heading: s.heading } : null })()`
  await follow(b, shipAt, Math.PI / 2 + 0.6, 0.12, 380)
  await b.waitForTimeout(3000)
  await shot(b, "strafe-4-b-carrier-hit")
  mb = await muntil(b, (m) => (m.hulls[bShip] ?? 1000) < hull0 - 3, 8000)
  check((mb.hulls[bShip] ?? 1000) < hull0, `B's carrier takes the boat's 25 mm: hull ${hull0} -> ${mb.hulls[bShip]}`)
  await unfollow(b)
  await b.waitForTimeout(400)
  await shot(b, "strafe-5-b-hull-bar")
  await run(a, "carrier.boat.driver.input.trigger = false")
  await a.close()
  await b.close()
}

const scenes: Record<string, () => Promise<void>> = { launch, drive, storm, gun, night, recover, hero, mp, strafe }
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
