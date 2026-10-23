// Weapons captures on a real GPU. Runs ON hailmary (Mac Studio): Chrome with WebGPU on Metal loads the live dev
// server's weapons harness (weapons.html) and plays scripted engagements against the AI drones, capturing the frame
// through the game's own device under the DOM HUD (as scripts/mp-shot.ts).
//
//   ssh hailmary 'cd /tmp/carrier-ocean && ~/.bun/bin/bun weapons-shot.ts --out=/tmp/carrier-weapons/out'
//
// Options: --base=URL  --size=1536x1024  --only=gun,missile,flares,f35,mp
//   mp: the real game, two pages in one fresh room on rival carriers: A shoots B down with the gun, B flares A's first
//   missile, A's missiles bring B down on B's next sortie; kill feed, Tab tallies and B's recharging slot checked.
import { type Page } from "playwright-core"
import { browserBudget } from "../../../scripts/browser-budget"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

await using budget = browserBudget()
const { chromium } = budget

const args = process.argv.slice(2)
const opt = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const base = opt("base", "https://carrier.lwoyjcaeyxv6.opentunnel.xyz/")
const out = opt("out", "/tmp/carrier-weapons/out")
const only = opt("only", "gun,missile,flares,f35").split(",")
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

async function open(query: string, path = "weapons.html", ready = "carrier.weapons"): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 })
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") logs.push(`${m.type()}: ${m.text()}`)
  })
  page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`))
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
  // A room link joins straight away only for a player who already has a name (src/ui/lobby.ts).
  await page.addInitScript((n) => localStorage.setItem("carrier.name", n), `PILOT ${Math.floor(Math.random() * 90 + 10)}`)
  await page.goto(`${base}${path}?${query}`, { waitUntil: "load" })
  await page.waitForFunction((r) => !!r.split(".").reduce((o: Record<string, unknown> | undefined, k) => o?.[k] as Record<string, unknown> | undefined, globalThis as unknown as Record<string, unknown>), ready, { timeout: 60_000 })
  await page.waitForTimeout(1500)
  return page
}

type S = { phase: string; weapon: string; heat: number; missiles: number; flares: number; lock: number; locked: boolean; hp: number; inbound: number; drones: { id: number; hp: number; dead: number; dist: number }[]; missilesLive: number; feed: string; warn: string }
const state = (p: Page): Promise<S> =>
  p.evaluate(() => {
    type C = {
      flight: { phase: string; plane: { x: number; y: number; z: number } }
      weapons: { status: Omit<S, "phase" | "drones" | "missilesLive" | "feed" | "warn">; world: { hp(id: number): number; missiles: { alive: boolean }[] } }
      drones: { list: { id: number; dead: number; plane: { x: number; y: number; z: number } }[] }
    }
    const c = (globalThis as unknown as { carrier: C }).carrier
    const me = c.flight.plane
    return {
      phase: c.flight.phase,
      ...c.weapons.status,
      drones: c.drones.list.map((d) => ({ id: d.id, hp: c.weapons.world.hp(d.id), dead: d.dead, dist: Math.round(Math.hypot(d.plane.x - me.x, d.plane.y - me.y, d.plane.z - me.z)) })),
      missilesLive: c.weapons.world.missiles.filter((m) => m.alive).length,
      feed: (document.querySelector("#wp .feed") as HTMLElement).innerText.replace(/\s+/g, " "),
      warn: (document.querySelector("#wp .warn") as HTMLElement).innerText,
    }
  })
const fmt = (s: S) =>
  `${s.phase} ${s.weapon} heat ${s.heat.toFixed(2)} msl ${s.missiles} flr ${s.flares} lock ${s.lock}${s.locked ? " LOCKED" : ""} hp ${s.hp.toFixed(0)} inbound ${Number.isFinite(s.inbound) ? s.inbound.toFixed(0) : "-"} live ${s.missilesLive} warn "${s.warn}" feed "${s.feed}" drones ${s.drones.map((d) => `${d.id}:${d.hp.toFixed(0)}${d.dead >= 0 ? "x" : ""}@${d.dist}`).join(" ")}`

async function until(p: Page, ok: (s: S) => boolean, ms = 15_000): Promise<S> {
  const end = Date.now() + ms
  let s = await state(p)
  while (!ok(s) && Date.now() < end) {
    await p.waitForTimeout(50)
    s = await state(p)
  }
  return s
}

const run = (p: Page, js: string) => p.evaluate(js)

/** The current frame as a PNG data URL, read back through the game's device. */
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

/** Frame under the DOM HUD, then a page screenshot. The game is paused (`paused`) only by the capture's own latency. */
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
  const harness = await page.evaluate(() => !!(globalThis as unknown as { carrier: { weapons?: unknown } }).carrier.weapons)
  console.log(`${name}: ${harness ? fmt(await state(page)) : mfmt(await mstate(page))}`)
}

async function gun(): Promise<void> {
  const p = await open("drone=3")
  await run(p, "carrier.behind(100, 260, 4); carrier.aim = 100")
  await p.waitForTimeout(1200)
  await run(p, "carrier.winput.trigger = true")
  await p.waitForTimeout(450)
  await shot(p, "gun/01-burst")
  let s = await until(p, (s) => s.drones[0]!.hp < 50 || s.heat > 0.9, 4000)
  await run(p, "carrier.winput.trigger = false")
  check(s.drones[0]!.hp < 100, `rounds hit the drone: ${fmt(s)}`)
  await p.waitForTimeout(300)
  await shot(p, "gun/02-smoking")
  await run(p, "carrier.winput.trigger = true")
  s = await until(p, (s) => s.drones[0]!.dead >= 0 || s.heat > 0.97, 4000)
  await shot(p, "gun/03-hot")
  await run(p, "carrier.winput.trigger = false")
  s = await until(p, (s) => s.drones[0]!.dead >= 0 || !s.heat, 1500)
  if (s.drones[0]!.dead < 0) {
    // Overheated before the kill: let it cool and finish the job.
    await until(p, (s) => s.heat < 0.3, 6000)
    await run(p, "carrier.winput.trigger = true")
    s = await until(p, (s) => s.drones[0]!.dead >= 0, 5000)
    await run(p, "carrier.winput.trigger = false")
  }
  check(s.drones[0]!.dead >= 0 && s.feed.includes("DRONE 1"), `drone shot down, kill feed: ${fmt(s)}`)
  await run(p, "carrier.aim = null; carrier.input.override = { pitch: 0, roll: 0 }")
  await p.waitForTimeout(150)
  await shot(p, "gun/04-kill")
  await p.waitForTimeout(900)
  await shot(p, "gun/05-wreck")
  await p.close()
}

async function missile(): Promise<void> {
  const p = await open("drone=3")
  await run(p, "carrier.behind(101, 1300, 30); carrier.aim = 101")
  await p.keyboard.press("Digit2")
  let s = await until(p, (s) => s.lock === 101, 3000)
  await p.waitForTimeout(500)
  await shot(p, "missile/01-locking")
  s = await until(p, (s) => s.locked, 4000)
  check(s.locked && s.lock === 101, `missile lock: ${fmt(s)}`)
  await shot(p, "missile/02-locked")
  await run(p, "carrier.winput.trigger = true")
  await p.waitForTimeout(100)
  await run(p, "carrier.winput.trigger = false")
  s = await until(p, (s) => s.missilesLive > 0, 1000)
  check(s.missiles === 1 && s.missilesLive === 1, `missile away: ${fmt(s)}`)
  await p.waitForTimeout(500)
  await shot(p, "missile/03-away")
  // Look at the missile from the side as it closes.
  await p.waitForTimeout(700)
  await shot(p, "missile/04-trail")
  s = await until(p, (s) => s.missilesLive === 0, 8000)
  check(s.drones.find((d) => d.id === 101)!.hp < 50, `missile hit: ${fmt(s)}`)
  await p.waitForTimeout(80)
  await shot(p, "missile/05-hit")
  await p.waitForTimeout(600)
  await shot(p, "missile/06-after")
  await p.close()
}

async function flares(): Promise<void> {
  const p = await open("drone=3&flares")
  // Our missile at a flaring drone: decoyed.
  await run(p, "carrier.behind(100, 1300, 30); carrier.aim = 100")
  await p.keyboard.press("Digit2")
  let s = await until(p, (s) => s.locked, 5000)
  await run(p, "carrier.winput.trigger = true")
  await p.waitForTimeout(100)
  await run(p, "carrier.winput.trigger = false")
  await p.waitForTimeout(1600)
  await shot(p, "flares/01-drone-flares")
  s = await until(p, (s) => s.missilesLive === 0, 8000)
  check(s.drones[0]!.hp === 100, `drone's flares decoyed our missile: ${fmt(s)}`)
  await run(p, "carrier.aim = null; carrier.input.override = null")
  // A drone's missile at us: MISSILE warning, then our flares.
  await run(p, "carrier.incoming(102)")
  s = await until(p, (s) => s.warn === "MISSILE", 3000)
  check(s.warn === "MISSILE", `inbound warning: ${fmt(s)}`)
  s = await until(p, (s) => s.inbound < 900, 8000)
  await shot(p, "flares/02-inbound")
  await p.keyboard.press("f")
  await p.waitForTimeout(400)
  await shot(p, "flares/03-our-flares")
  s = await until(p, (s) => s.missilesLive === 0, 8000)
  check(s.hp === 100 && s.flares === 1, `our flares decoyed the missile: ${fmt(s)}`)
  await shot(p, "flares/04-decoyed")
  // And without flares it hits.
  await run(p, "carrier.incoming(102)")
  s = await until(p, (s) => s.missilesLive === 0, 9000)
  check(s.hp < 100, `unflared missile hits us: ${fmt(s)}`)
  await p.waitForTimeout(200)
  await shot(p, "flares/05-hit")
  await p.close()
}

async function f35(): Promise<void> {
  const p = await open("drone=1&f35")
  await run(p, "carrier.behind(100, 600, 200)")
  await p.waitForTimeout(500)
  let s: S = await state(p)
  check(s.weapon === "missile", `F-35C starts on missiles (no gun): ${fmt(s)}`)
  await p.keyboard.press("Digit2")
  s = await until(p, (s) => s.weapon === "bomb", 1000)
  check(s.weapon === "bomb", `2 selects bombs: ${fmt(s)}`)
  await run(p, "carrier.winput.trigger = true")
  await p.waitForTimeout(100)
  await run(p, "carrier.winput.trigger = false")
  await p.waitForTimeout(600)
  await shot(p, "f35/01-bomb-away")
  s = await until(p, (s) => s.missilesLive === 0, 20000)
  check(s.missilesLive === 0, `the bomb burst: ${fmt(s)}`)
  await shot(p, "f35/02-burst")
  await p.close()
}

// ---- the real game, two pages --------------------------------------------------------------------------------------

type M = { online: string; id: number; role: string; team: number; phase: string; crashed: string; weapon: string; missiles: number; flares: number; lock: number; locked: boolean; hp: number; inbound: number; feed: string; warn: string; card: string; remote: number; kd: string; recharging: number }
const mstate = (p: Page): Promise<M> =>
  p.evaluate(() => {
    type C = {
      net: { state: string; id: number; crew: { players: { id: number; team: number; ship: number }[]; ships: { id: number; aircraft: { pilot: number | null; readyAt: number }[] }[] } | null; serverNow(): number; stats: Map<number, { kills: number; deaths: number }> }
      game: { state: { role: string } }
      flight: { flight: { phase: string; plane: { crashed: string } }; weaponStatus: { weapon: string; missiles: number; flares: number; lock: number; locked: boolean; hp: number; inbound: number }; remotes: { jets: Map<number, unknown> } }
    }
    const c = (globalThis as unknown as { carrier: C }).carrier
    const me = c.net.crew?.players.find((p) => p.id === c.net.id)
    const ship = me && c.net.crew!.ships.find((s) => s.id === me.ship)
    const txt = (s: string) => ((document.querySelector(s) as HTMLElement | null)?.innerText ?? "").replace(/\s+/g, " ").trim()
    const kd = [...c.net.stats].map(([id, v]) => `${id}:${v.kills}/${v.deaths}`).join(" ")
    return {
      online: c.net.state,
      id: c.net.id,
      role: c.game.state.role,
      team: me?.team ?? -1,
      phase: c.flight.flight.phase,
      crashed: c.flight.flight.plane.crashed,
      ...c.flight.weaponStatus,
      feed: txt("#wp .feed"),
      warn: txt("#wp .warn"),
      card: txt("#fl .center"),
      remote: c.flight.remotes.jets.size,
      kd,
      recharging: ship ? ship.aircraft.filter((a) => a.pilot === null && a.readyAt > c.net.serverNow()).length : -1,
    }
  })
const mfmt = (m: M) =>
  `${m.online} id ${m.id} team ${m.team} ${m.role} ${m.phase}${m.crashed ? `(${m.crashed})` : ""} ${m.weapon} msl ${m.missiles} flr ${m.flares} lock ${m.lock}${m.locked ? " LOCKED" : ""} hp ${m.hp.toFixed(0)} inbound ${Number.isFinite(m.inbound) ? m.inbound.toFixed(0) : "-"} warn "${m.warn}" card "${m.card}" feed "${m.feed}" kd "${m.kd}" recharging ${m.recharging}`
async function muntil(p: Page, ok: (m: M) => boolean, ms = 15_000): Promise<M> {
  const end = Date.now() + ms
  let m = await mstate(p)
  while (!ok(m) && Date.now() < end) {
    await p.waitForTimeout(80)
    m = await mstate(p)
  }
  return m
}

/** Puts a page's jet in level flight at (x, y, z), nose along compass `heading` (rad), at cruise speed, stick centred. */
const place = (p: Page, x: number, y: number, z: number, heading: number) =>
  p.evaluate(
    ([x, y, z, h]) => {
      type P = Record<string, number | string>
      const c = (globalThis as unknown as { carrier: { flight: { flight: { plane: P; prev: P; cam: { reset(): void } }; input: { override: unknown } } } }).carrier
      const f = c.flight.flight
      const p = f.plane
      const a = (Math.PI - h!) / 2
      Object.assign(p, { x, y, z, qx: 0, qy: Math.sin(a), qz: 0, qw: Math.cos(a), vx: 140 * Math.sin(h!), vy: 0, vz: -140 * Math.cos(h!), p: 0, r: 0, w: 0, throttle: 140 / 182, blend: 1, stall: 0, outside: 0 })
      Object.assign(f.prev, p)
      f.cam.reset()
      c.flight.input.override = { pitch: 0, roll: 0, yaw: 0 }
    },
    [x, y, z, heading],
  )
const trigger = (p: Page, on: boolean) => p.evaluate((on) => ((globalThis as unknown as { carrier: { flight: { weapons: { input: { trigger: boolean | null } } } } }).carrier.flight.weapons.input.trigger = on), on)

/** A launches and lines up behind B (`gap` metres, same heading, both level at cruise). */
async function lineUp(a: Page, b: Page, gap: number): Promise<void> {
  const at = await b.evaluate(() => {
    const p = (globalThis as unknown as { carrier: { flight: { flight: { plane: { x: number; z: number } } } } }).carrier.flight.flight.plane
    return { x: p.x, z: p.z }
  })
  // Head north, well clear of the carriers, at 1,200 m.
  const x = Math.max(-5000, Math.min(5000, at.x))
  const z = Math.max(-5000, Math.min(5000, at.z)) - 1500
  await place(b, x, 1200, z, 0)
  await place(a, x, 1200, z + gap, 0)
}

async function mp(): Promise<void> {
  const room = `wpn${Math.floor(Math.random() * 1e6)}`
  const a = await open(`room=${room}`, "", "carrier.flight")
  let ma = await muntil(a, (m) => m.online === "online" && m.role !== "none", 20_000)
  const b = await open(`room=${room}`, "", "carrier.flight")
  let mb = await muntil(b, (m) => m.online === "online" && m.role !== "none", 20_000)
  check(ma.team === 0 && mb.team === 1, `rival carriers: A ${mfmt(ma)} | B ${mfmt(mb)}`)
  await run(a, 'carrier.net.op("hornet")')
  await run(b, 'carrier.net.op("hornet")')
  ma = await muntil(a, (m) => m.phase === "flying", 15_000)
  mb = await muntil(b, (m) => m.phase === "flying", 15_000)
  check(ma.phase === "flying" && mb.phase === "flying", "both airborne")
  await a.waitForTimeout(1500)

  // Guns.
  await lineUp(a, b, 280)
  await a.waitForTimeout(700)
  ma = await muntil(a, (m) => m.remote > 0, 3000)
  await trigger(a, true)
  await a.waitForTimeout(500)
  await shot(a, "mp/01-a-guns")
  mb = await muntil(b, (m) => m.hp < 50, 3000)
  await shot(b, "mp/02-b-hit")
  mb = await muntil(b, (m) => m.phase === "crashed", 6000)
  // What streams past B's crash camera: A's rounds (drawn from A's trigger) and how close the nearest tracer comes.
  const near = await b.evaluate(() => {
    type B = { cap: number; state: Uint8Array; x: Float64Array; y: Float64Array; z: Float64Array; vx: Float64Array; vy: Float64Array; vz: Float64Array }
    const c = (globalThis as unknown as { carrier: { camera: { eye: ArrayLike<number> }; flight: { weapons: { others: B } } } }).carrier
    const o = c.flight.weapons.others
    const e = c.camera.eye
    let best = Infinity
    let live = 0
    for (let i = 0; i < o.cap; i++) {
      if (o.state[i] !== 2) continue
      live++
      for (let k = 0; k <= 8; k++) {
        const t = (k / 8) * 0.032
        best = Math.min(best, Math.hypot(o.x[i]! - o.vx[i]! * t - e[0]!, o.y[i]! - o.vy[i]! * t - e[1]!, o.z[i]! - o.vz[i]! * t - e[2]!))
      }
    }
    return { live, best }
  })
  console.log(`B's crash camera: ${near.live} of A's tracers in flight, nearest ${near.best.toFixed(1)} m from the eye`)
  await trigger(a, false)
  mb = await muntil(b, (m) => m.card.startsWith("SHOT DOWN"), 1000)
  check(mb.crashed === "shot" && mb.card.startsWith("SHOT DOWN"), `B shot down by A's gun: ${mfmt(mb)}`)
  await shot(b, "mp/03-b-shot-down")
  ma = await muntil(a, (m) => m.feed.length > 0 && m.kd.includes(`${m.id}:1/0`), 3000)
  check(ma.feed.includes("✕") && ma.kd.includes(`${mb.id}:0/1`), `kill feed and tallies on A: ${mfmt(ma)}`)
  await shot(a, "mp/04-a-kill")
  await a.keyboard.press("Tab")
  await a.waitForTimeout(400)
  await shot(a, "mp/05-a-tab-stats")
  await a.keyboard.press("Tab")
  // No manual way out of a flight: R does nothing, and TAKE HELM reads AIRBORNE in the (read-only) ops menu.
  await a.keyboard.press("KeyR")
  await a.waitForTimeout(300)
  ma = await mstate(a)
  check(ma.phase === "flying" && ma.role === "pilot", `R does not end A's flight: ${mfmt(ma)}`)
  await a.keyboard.press("KeyG")
  await a.waitForTimeout(400)
  const ops = await a.evaluate(() => {
    const c = (globalThis as unknown as { carrier: { ops: { open: boolean; pin(o: boolean): void } } }).carrier
    const how = c.ops.open ? "G" : "pin"
    if (!c.ops.open) c.ops.pin(true)
    return `${how}: ${((document.querySelector(".om") as HTMLElement | null)?.innerText ?? "").replace(/\s+/g, " ")}`
  })
  check(/AIRBORNE/.test(ops), `ops menu in the air: "${ops}"`)
  await shot(a, "mp/05b-a-ops-airborne")
  await run(a, "carrier.ops.close()")
  mb = await muntil(b, (m) => m.phase === "idle" || m.role !== "pilot" || m.recharging > 0, 6000)
  mb = await muntil(b, (m) => m.recharging > 0, 3000)
  check(mb.recharging === 1, `B's slot recharging after the shoot-down: ${mfmt(mb)}`)

  // B's next sortie (the ship's other Hornet): a missile at B, flared; then two that hit.
  await run(b, 'carrier.net.op("hornet")')
  mb = await muntil(b, (m) => m.phase === "flying", 15_000)
  check(mb.phase === "flying", `B airborne again: ${mfmt(mb)}`)
  await b.waitForTimeout(1000)
  await lineUp(a, b, 1300)
  await a.keyboard.press("Digit2")
  ma = await muntil(a, (m) => m.locked, 5000)
  mb = await muntil(b, (m) => m.warn === "LOCK", 2000)
  check(ma.locked && mb.warn === "LOCK", `A locked on, B warned: A ${mfmt(ma)} | B ${mfmt(mb)}`)
  await shot(a, "mp/06-a-locked")
  await trigger(a, true)
  await a.waitForTimeout(120)
  await trigger(a, false)
  mb = await muntil(b, (m) => m.inbound < 900, 6000)
  check(mb.warn === "MISSILE", `B sees the missile coming: ${mfmt(mb)}`)
  await b.keyboard.press("f")
  await b.waitForTimeout(300)
  await shot(b, "mp/07-b-flares")
  mb = await muntil(b, (m) => !Number.isFinite(m.inbound), 6000)
  await b.waitForTimeout(500)
  mb = await mstate(b)
  check(mb.hp === 100 && mb.flares === 1, `B's flares decoyed it: ${mfmt(mb)}`)
  // Second missile: hits.
  ma = await muntil(a, (m) => m.locked, 5000)
  await trigger(a, true)
  await a.waitForTimeout(120)
  await trigger(a, false)
  await a.waitForTimeout(900)
  await shot(a, "mp/08-a-missile")
  mb = await muntil(b, (m) => m.hp < 100, 8000)
  check(mb.hp < 60, `the second missile hits B: ${mfmt(mb)}`)
  await shot(b, "mp/09-b-missile-hit")
  // A's rail rearms; a third missile finishes B.
  ma = await muntil(a, (m) => m.missiles > 0 && m.locked, 15_000)
  await trigger(a, true)
  await a.waitForTimeout(120)
  await trigger(a, false)
  mb = await muntil(b, (m) => m.phase === "crashed", 10_000)
  check(mb.crashed === "shot", `B shot down by A's missile: ${mfmt(mb)}`)
  await a.waitForTimeout(200)
  await shot(a, "mp/10-a-missile-kill")
  ma = await muntil(a, (m) => m.kd.includes(`${m.id}:2/0`), 3000)
  check(ma.kd.includes(`${mb.id}:0/2`), `tallies 2/0 and 0/2: ${mfmt(ma)}`)
  await b.close()
  await a.close()
}

try {
  if (only.includes("mp")) await mp()
  if (only.includes("gun")) await gun()
  if (only.includes("missile")) await missile()
  if (only.includes("flares")) await flares()
  if (only.includes("f35")) await f35()
} finally {
  console.log(logs.slice(0, 30).join("\n"))
  console.log(failures ? `${failures} FAILED` : "all ok")
  await browser.close()
}
