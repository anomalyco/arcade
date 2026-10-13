// Gunnery captures on a real GPU. Runs ON hailmary (Mac Studio): Chrome with WebGPU on Metal loads the live dev server's
// gunnery harness (gunnery.html) and plays scripted engagements from each of the carrier's guns, capturing the frame
// through the game's own device under the DOM HUD (as scripts/weapons-shot.ts).
//
//   scp scripts/gunnery-shot.ts hailmary:/tmp/carrier-ocean/
//   ssh hailmary 'cd /tmp/carrier-ocean && ~/.bun/bin/bun gunnery-shot.ts --out=/tmp/carrier-gunnery/out'
//
// Options: --base=URL  --size=1536x1024  --only=views,ciws,intercept,sam,gun,mp
//   views: the first-person sight from every mount, plus an orbit view of a turret trained off its rest.
//   ciws: tracks a drone in range and shreds it. intercept: an incoming missile and a bomb shot down by the CIWS.
//   sam: locks a drone and kills it with a SAM. gun: lobs 5-inch shells at the enemy carrier (splashes, a hit).
//   mp: the real game, two pages in one room: A mans the CIWS on its carrier and shoots down B's jet; B sees A's turret turn.
import { chromium, type Page } from "playwright-core"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

const args = process.argv.slice(2)
const opt = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const base = opt("base", "https://carrier.lwoyjcaeyxv6.opentunnel.xyz/")
const out = opt("out", "/tmp/carrier-gunnery/out")
const only = opt("only", "views,ciws,intercept,sam,gun").split(",")
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

async function open(query: string, path = "gunnery.html", ready = "carrier.gunnery"): Promise<Page> {
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
  await page.addInitScript((n) => localStorage.setItem("carrier.name", n), `GUNNER ${Math.floor(Math.random() * 90 + 10)}`)
  await page.goto(`${base}${path}?${query}`, { waitUntil: "load" })
  await page.waitForFunction((r) => !!r.split(".").reduce((o: Record<string, unknown> | undefined, k) => o?.[k] as Record<string, unknown> | undefined, globalThis as unknown as Record<string, unknown>), ready, { timeout: 60_000 })
  await page.waitForTimeout(1500)
  return page
}

type S = {
  kind: string
  yaw: number
  pitch: number
  heat: number
  cells: number
  lock: number
  locked: boolean
  live: number
  impact: { x: number; z: number; kind: string; time: number }
  drones: { id: number; hp: number; dead: number; dist: number }[]
  stores: number
  hits: { direct: number; near: number; ciws: number; sam: number }
  feed: string
}
const state = (p: Page): Promise<S> =>
  p.evaluate(() => {
    type C = {
      gunnery: { status: Omit<S, "drones" | "stores" | "hits" | "feed"> }
      weapons: { world: { hp(id: number): number; missiles: { alive: boolean }[] } }
      drones: { list: { id: number; dead: number; plane: { x: number; y: number; z: number } }[] }
      own: { ship: { x: number; z: number; heave: number } }
      hits: S["hits"]
    }
    const c = (globalThis as unknown as { carrier: C }).carrier
    const me = c.own.ship
    const st = c.gunnery.status
    return {
      ...st,
      impact: { x: st.impact.x, z: st.impact.z, kind: st.impact.kind, time: st.impact.time },
      drones: c.drones.list.map((d) => ({ id: d.id, hp: c.weapons.world.hp(d.id), dead: d.dead, dist: Math.round(Math.hypot(d.plane.x - me.x, d.plane.y - 30, d.plane.z - me.z)) })),
      stores: c.weapons.world.missiles.filter((m) => m.alive).length,
      hits: { direct: c.hits.direct, near: c.hits.near, ciws: c.hits.ciws, sam: c.hits.sam },
      feed: (document.querySelector("#wp .feed") as HTMLElement | null)?.innerText.replace(/\s+/g, " ") ?? "",
    }
  })
const fmt = (s: S) =>
  `${s.kind} yaw ${s.yaw.toFixed(2)} pitch ${s.pitch.toFixed(2)} heat ${s.heat.toFixed(2)} cells ${s.cells} lock ${s.lock}${s.locked ? " LOCKED" : ""} live ${s.live} stores ${s.stores} hits ${JSON.stringify(s.hits)} feed "${s.feed}" drones ${s.drones.map((d) => `${d.id}:${d.hp.toFixed(0)}${d.dead >= 0 ? "x" : ""}@${d.dist}`).join(" ")}`

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
  return Promise.race([frameOnce(page), new Promise<string>((_, no) => setTimeout(() => no(new Error("frame capture timed out (render loop stopped?)")), 15_000))])
}
async function frameOnce(page: Page): Promise<string> {
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

/** Frame under the DOM HUD, then a page screenshot. */
async function shot(page: Page, name: string, log = true): Promise<void> {
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
  mkdirSync(join(out, name, ".."), { recursive: true })
  await page.screenshot({ path: join(out, `${name}.png`) })
  await page.evaluate(() => {
    document.getElementById("shot-bg")?.remove()
    document.getElementById("view")!.style.visibility = ""
  })
  if (log) {
    const harness = await page.evaluate(() => !!(globalThis as unknown as { carrier: { gunnery?: unknown } }).carrier.gunnery)
    console.log(`${name}: ${harness ? fmt(await state(page)) : ""}`)
  }
}

/** Points the gunner along a ship-local yaw/pitch (world-stabilised from then on). */
const aimLocal = (yaw: number, pitch: number) =>
  `(() => { const c = carrier; const s = c.own ? c.own.draw : c.flight.carriers.find((x) => x.id === c.game.state.shipId); const q = [Math.sin(${yaw}) * Math.cos(${pitch}), Math.sin(${pitch}), Math.cos(${yaw}) * Math.cos(${pitch})];
    const h = s.heading, cy = Math.cos(Math.PI - h), sy = Math.sin(Math.PI - h);
    const wx = q[0] * cy + q[2] * sy, wz = -q[0] * sy + q[2] * cy;
    c.gunnery.aimHeading = Math.atan2(wx, -wz); c.gunnery.aimElevation = ${pitch}; })()`

async function views(): Promise<void> {
  const list: [string, number, number][] = [
    ["gun", -0.5, 0.05],
    ["sam", -1.3, 0.25],
    ["ciws", 0.9, 0.12],
    ["sam-port", 1.6, 0.3],
    ["ciws-stbd", -2.2, 0.15],
  ]
  for (const [g, yaw, pitch] of list) {
    const p = await open(`gunner=${g}&drone=3`)
    await run(p, aimLocal(yaw, pitch))
    await p.waitForTimeout(3500)
    await shot(p, `views/fp-${g}`)
    if (g === "ciws" || g === "gun" || g === "sam") {
      await run(p, `carrier.inspect = { yaw: ${g === "ciws" ? 0.9 : -0.9}, pitch: 0.3, dist: ${g === "gun" ? 46 : 34} }`)
      await p.waitForTimeout(400)
      await shot(p, `views/turret-${g}`)
    }
    await p.close()
  }
}

/** Waits for a drone to come within `range` m, returning its id. */
async function droneWithin(p: Page, range: number, ms = 60_000): Promise<number> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const ids = (await p.evaluate((r) => (globalThis as unknown as { carrier: { candidates(r: number): number[] } }).carrier.candidates(r), range)) as number[]
    if (ids.length) return ids[0]!
    await p.waitForTimeout(200)
  }
  return -1
}

async function ciws(): Promise<void> {
  const p = await open("gunner=ciws&drone=4")
  const id = await droneWithin(p, 1300)
  check(id >= 0, `a drone came within CIWS range (${id})`)
  if (id < 0) return void (await p.close())
  await run(p, `carrier.track = { kind: "drone", id: ${id} }`)
  await p.waitForTimeout(900)
  await shot(p, "ciws/01-tracking")
  await run(p, "carrier.gunnery.input.trigger = true")
  await p.waitForTimeout(500)
  await shot(p, "ciws/02-firing")
  let s = await until(p, (s) => (s.drones.find((d) => d.id === id)?.hp ?? 100) < 60, 3000)
  await shot(p, "ciws/03-hits")
  s = await until(p, (s) => (s.drones.find((d) => d.id === id)?.dead ?? -1) >= 0 || s.heat > 0.98, 6000)
  if ((s.drones.find((d) => d.id === id)?.dead ?? -1) < 0) {
    await run(p, "carrier.gunnery.input.trigger = false")
    await until(p, (s) => s.heat < 0.25, 8000)
    await run(p, "carrier.gunnery.input.trigger = true")
    s = await until(p, (s) => (s.drones.find((d) => d.id === id)?.dead ?? -1) >= 0, 6000)
  }
  await shot(p, "ciws/04-kill")
  await run(p, "carrier.gunnery.input.trigger = false")
  check((s.drones.find((d) => d.id === id)?.dead ?? -1) >= 0 && s.feed.includes("YOU"), `CIWS shot the drone down: ${fmt(s)}`)
  await p.waitForTimeout(900)
  await shot(p, "ciws/05-wreck")
  await p.close()
}

async function intercept(): Promise<void> {
  for (const kind of ["missile", "bomb"] as const) {
    const p = await open("gunner=ciws&drone=1")
    await run(p, aimLocal(0.6, 0.1))
    await p.waitForTimeout(800)
    await run(p, `carrier.incoming("${kind}", 2600, 0.7)`)
    await run(p, `carrier.track = { kind: "store", id: 0 }`)
    let s = await state(p)
    check(s.stores === 1, `${kind} inbound: ${fmt(s)}`)
    // Hold fire until it is inside 1.5 km.
    await p.waitForFunction(() => {
      const c = (globalThis as unknown as { carrier: { weapons: { world: { missiles: { alive: boolean; x: number; y: number; z: number }[] } }; own: { ship: { x: number; z: number } } } }).carrier
      const m = c.weapons.world.missiles.find((m) => m.alive)
      return !m || Math.hypot(m.x - c.own.ship.x, m.z - c.own.ship.z) < 1500
    }, undefined, { timeout: 30_000 })
    await shot(p, `intercept/${kind}-01-inbound`)
    await run(p, "carrier.gunnery.input.trigger = true")
    await p.waitForTimeout(250)
    await shot(p, `intercept/${kind}-02-firing`)
    s = await until(p, (s) => s.stores === 0, 8000)
    await p.waitForTimeout(80)
    await shot(p, `intercept/${kind}-03-shot-down`)
    await run(p, "carrier.gunnery.input.trigger = false")
    const ok = await p.evaluate(() => (globalThis as unknown as { carrier: { hits: { log: string[] } } }).carrier.hits.log.length === 0)
    check(s.stores === 0 && ok, `${kind} shot down before it struck: ${fmt(s)}`)
    await p.waitForTimeout(600)
    await shot(p, `intercept/${kind}-04-after`)
    await p.close()
  }
}

async function sam(): Promise<void> {
  const p = await open("gunner=sam&drone=4")
  const id = await droneWithin(p, 4500)
  check(id >= 0, `a drone within SAM range (${id})`)
  if (id < 0) return void (await p.close())
  await run(p, `carrier.track = { kind: "drone", id: ${id} }`)
  await p.waitForTimeout(1000)
  await shot(p, "sam/01-locking")
  let s = await until(p, (s) => s.locked, 6000)
  check(s.locked && s.lock === id, `SAM locked drone ${id}: ${fmt(s)}`)
  await shot(p, "sam/02-locked")
  await run(p, "carrier.gunnery.input.trigger = true")
  await p.waitForTimeout(120)
  await run(p, "carrier.gunnery.input.trigger = false")
  await p.waitForTimeout(350)
  await shot(p, "sam/03-launch")
  await run(p, `carrier.inspect = { yaw: -0.6, pitch: 0.2, dist: 60 }`)
  await p.waitForTimeout(500)
  await shot(p, "sam/04-launch-orbit")
  await run(p, "carrier.inspect = null")
  s = await until(p, (s) => (s.drones.find((d) => d.id === id)?.dead ?? -1) >= 0 || s.live === 0, 14_000)
  await p.waitForTimeout(100)
  await shot(p, "sam/05-burst")
  check((s.drones.find((d) => d.id === id)?.dead ?? -1) >= 0, `SAM killed drone ${id}: ${fmt(s)}`)
  await p.close()
}

async function gun(): Promise<void> {
  const p = await open("gunner=gun&drone=0&enemy=3600")
  const lob = "(() => { const e = carrier.enemy.draw; carrier.lob(e.x, e.z) })()"
  await run(p, lob)
  await p.waitForTimeout(2500)
  await run(p, lob)
  await p.waitForTimeout(800)
  await shot(p, "gun/01-ranging")
  await run(p, "carrier.gunnery.input.trigger = true")
  await p.waitForTimeout(150)
  await shot(p, "gun/02-shot")
  await run(p, "carrier.gunnery.input.trigger = false")
  // The time of flight, then the splash.
  const tof = (await state(p)).impact.time
  await p.waitForTimeout(Math.max(500, tof * 1000 - 400))
  await run(p, "carrier.gunnery.input.zoom = true")
  await p.waitForTimeout(500)
  await shot(p, "gun/03-splash")
  // A few more, walking onto it.
  for (let i = 0; i < 5; i++) {
    await run(p, lob)
    await p.waitForTimeout(300)
    await run(p, "carrier.gunnery.input.trigger = true")
    await p.waitForTimeout(1600)
  }
  await run(p, "carrier.gunnery.input.trigger = false")
  await p.waitForTimeout(tof * 1000 + 600)
  await shot(p, "gun/04-straddle")
  const s = await state(p)
  check(s.hits.direct + s.hits.near > 0, `shells hit or straddled the enemy carrier: ${fmt(s)}`)
  await p.close()
}


type G = { online: string; id: number; role: string; team: number; ship: number; phase: string; crashed: string; hp: number; card: string; feed: string; kd: string; turret: number[] }
const gstate = (p: Page): Promise<G> =>
  p.evaluate(() => {
    type C = {
      net: { state: string; id: number; crew: { players: { id: number; team: number; ship: number }[] } | null; stats: Map<number, { kills: number; deaths: number }> }
      game: { state: { role: string } }
      flight: { flight: { phase: string; plane: { crashed: string } }; weaponStatus: { hp: number } }
      gunnery: { turret: { yaw: number; pitch: number } }
    }
    const c = (globalThis as unknown as { carrier: C }).carrier
    const me = c.net.crew?.players.find((p) => p.id === c.net.id)
    const txt = (s: string) => ((document.querySelector(s) as HTMLElement | null)?.innerText ?? "").replace(/\s+/g, " ").trim()
    return {
      online: c.net.state,
      id: c.net.id,
      role: c.game.state.role,
      team: me?.team ?? -1,
      ship: me?.ship ?? -1,
      phase: c.flight.flight.phase,
      crashed: c.flight.flight.plane.crashed,
      hp: c.flight.weaponStatus.hp,
      card: txt("#fl .center"),
      feed: txt("#wp .feed"),
      kd: [...c.net.stats].map(([id, v]) => `${id}:${v.kills}/${v.deaths}`).join(" "),
      turret: [c.gunnery.turret.yaw, c.gunnery.turret.pitch],
    }
  })
const gfmt = (m: G) => `${m.online} id ${m.id} team ${m.team} ship ${m.ship} ${m.role} ${m.phase}${m.crashed ? `(${m.crashed})` : ""} hp ${m.hp.toFixed(0)} card "${m.card}" feed "${m.feed}" kd "${m.kd}" turret ${m.turret.map((v) => v.toFixed(2)).join(",")}`
async function guntil(p: Page, ok: (m: G) => boolean, ms = 15_000): Promise<G> {
  const end = Date.now() + ms
  let m = await gstate(p)
  while (!ok(m) && Date.now() < end) {
    await p.waitForTimeout(80)
    m = await gstate(p)
  }
  return m
}

/** Ship `ship` as drawn on page `p`, and a ship-local point on it in the world (plan rotation only). */
const shipPoint = (p: Page, ship: number, lx: number, ly: number, lz: number) =>
  p.evaluate(
    ([ship, lx, ly, lz]) => {
      const c = (globalThis as unknown as { carrier: { flight: { carriers: { id?: number; x: number; z: number; heave: number; heading: number }[] } } }).carrier
      const s = c.flight.carriers.find((x) => x.id === ship)
      if (!s) return null
      const a = Math.PI - s.heading
      return { x: s.x + lx! * Math.cos(a) + lz! * Math.sin(a), y: s.heave + ly!, z: s.z - lx! * Math.sin(a) + lz! * Math.cos(a), heading: s.heading }
    },
    [ship, lx, ly, lz],
  )

async function mp(): Promise<void> {
  const room = `gun${Math.floor(Math.random() * 1e6)}`
  const a = await open(`room=${room}`, "", "carrier.flight")
  let ga = await guntil(a, (m) => m.online === "online" && m.role !== "none", 20_000)
  const b = await open(`room=${room}`, "", "carrier.flight")
  let gb = await guntil(b, (m) => m.online === "online" && m.role !== "none", 20_000)
  check(ga.team !== gb.team, `opposite teams: A ${gfmt(ga)} | B ${gfmt(gb)}`)
  // A mans the port CIWS from SHIP OPERATIONS.
  await a.keyboard.press("KeyE")
  await a.waitForTimeout(300)
  await shot(a, "mp/00-a-ops-menu", false)
  await run(a, 'carrier.net.op("ciws-port")')
  ga = await guntil(a, (m) => m.role === "gunner", 5000)
  check(ga.role === "gunner", `A is a gunner: ${gfmt(ga)}`)
  await run(a, aimLocal(0.3, 0.1))
  await a.waitForTimeout(1500)
  await shot(a, "mp/01-a-first-person")
  // B watches A's CIWS from a free camera beside it while A trains it round.
  const ciws = [43, 26, 130] as const
  await run(b, "carrier.game.state.free = true")
  await b.evaluate(
    ([ship, x, y, z]) => {
      const c = (globalThis as unknown as { carrier: { camera: { set(v: object): void }; flight: { carriers: { id?: number; x: number; z: number; heading: number }[] } } }).carrier
      const w = globalThis as unknown as { follow?: number }
      w.follow = setInterval(() => {
        const s = c.flight.carriers.find((q) => q.id === ship)
        if (!s) return
        const a = Math.PI - s.heading
        c.camera.set({ x: s.x + x! * Math.cos(a) + z! * Math.sin(a), z: s.z - x! * Math.sin(a) + z! * Math.cos(a), yaw: s.heading - Math.PI / 2 - 0.5, pitch: 0.2, dist: 70 })
      }, 30) as unknown as number
      void y
    },
    [ga.ship, ciws[0], ciws[1], ciws[2]],
  )
  await b.waitForTimeout(1200)
  const angle = () => b.evaluate((ship) => Array.from((globalThis as unknown as { carrier: { gunnery: { anglesFor(id: number): Float32Array | null } } }).carrier.gunnery.anglesFor(ship) ?? []).slice(4, 6), ga.ship)
  const before = await angle()
  await shot(b, "mp/02-b-sees-a-turret")
  await run(a, aimLocal(1.7, 0.7))
  await a.waitForTimeout(1800)
  const after = await angle()
  await shot(b, "mp/03-b-sees-a-turret-trained")
  check(Math.abs((after[0] ?? 0) - (before[0] ?? 0)) > 0.8 && (after[1] ?? 0) > 0.4, `B sees A's turret turn: ${before.map((v) => v.toFixed(2))} -> ${after.map((v) => v.toFixed(2))}`)
  await b.evaluate(() => clearInterval((globalThis as unknown as { follow?: number }).follow))
  await run(b, "carrier.game.state.free = false")

  // B launches and flies past A's port bow; A tracks it with lead and fires.
  await run(b, 'carrier.net.op("hornet")')
  gb = await guntil(b, (m) => m.phase === "flying", 20_000)
  check(gb.phase === "flying", `B airborne: ${gfmt(gb)}`)
  const pass = async () => {
    const at = await shipPoint(b, ga.ship, 650, 320, -250)
    if (at) await placeJet(b, at.x, at.y, at.z, at.heading)
  }
  await pass()
  await a.evaluate((bid) => {
    type V = { x: number; y: number; z: number; vx: number; vy: number; vz: number; alive: boolean }
    const c = (globalThis as unknown as { carrier: { flight: { weapons: { jets: Map<number, V> } }; gunnery: { cam: { eye: number[] }; aimAt(x: number, y: number, z: number): void } } }).carrier
    const w = globalThis as unknown as { track?: number }
    const loop = () => {
      const j = c.flight.weapons.jets.get(bid)
      if (j && j.alive) {
        const e = c.gunnery.cam.eye
        const d = Math.hypot(j.x - e[0]!, j.y - e[1]!, j.z - e[2]!)
        const t = d / 1100
        c.gunnery.aimAt(j.x + j.vx * t, j.y + j.vy * t + 4.9 * t * t, j.z + j.vz * t)
      }
      w.track = requestAnimationFrame(loop)
    }
    loop()
  }, gb.id)
  await a.waitForTimeout(1500)
  await shot(a, "mp/04-a-tracking")
  await run(a, "carrier.gunnery.input.trigger = true")
  await a.waitForTimeout(600)
  await shot(a, "mp/05-a-firing")
  gb = await guntil(b, (m) => m.hp < 60 || m.phase === "crashed", 6000)
  await shot(b, "mp/06-b-hit")
  gb = await guntil(b, (m) => m.phase === "crashed", 8000)
  if (gb.phase !== "crashed") {
    await run(a, "carrier.gunnery.input.trigger = false")
    await a.waitForTimeout(3000)
    await pass()
    await run(a, "carrier.gunnery.input.trigger = true")
    gb = await guntil(b, (m) => m.phase === "crashed", 8000)
  }
  await run(a, "carrier.gunnery.input.trigger = false")
  check(gb.crashed === "shot", `B shot down by A's CIWS: ${gfmt(gb)}`)
  await shot(b, "mp/07-b-shot-down")
  ga = await guntil(a, (m) => m.kd.includes(`${m.id}:1/0`), 4000)
  check(ga.feed.includes("✕") && ga.kd.includes(`${ga.id}:1/0`), `kill feed and tally on A: ${gfmt(ga)}`)
  await shot(a, "mp/08-a-kill")
  await a.close()
  await b.close()
}

/** Puts a page's jet in level flight at (x, y, z), nose along compass `heading`, at 140 m/s. */
const placeJet = (p: Page, x: number, y: number, z: number, heading: number) =>
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

for (const k of only) {
  try {
    if (k === "views") await views()
    if (k === "ciws") await ciws()
    if (k === "intercept") await intercept()
    if (k === "sam") await sam()
    if (k === "gun") await gun()
    if (k === "mp") await mp()
  } catch (e) {
    failures++
    console.log(`FAIL ${k}: ${(e as Error).message}`)
  }
}
await browser.close()
if (logs.length) console.log(`console:\n${[...new Set(logs)].slice(0, 30).join("\n")}`)
console.log(failures ? `${failures} failure(s)` : "all ok")
process.exit(failures ? 1 : 0)
