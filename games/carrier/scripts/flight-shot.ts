// Flight captures on a real GPU. Runs ON hailmary (Mac Studio): Chrome with WebGPU on Metal loads the live dev server's
// flight harness (flight.html), launches the jet off the carrier, flies it with keys and the stick override, and
// captures through the game's own device (as scripts/ocean-shot.ts and drive-shot.ts).
//
//   ssh hailmary 'cd /tmp/carrier-ocean && ~/.bun/bin/bun flight-shot.ts --out=/tmp/carrier-flight/out'
//
// Options: --base=URL  --seed=7  --size=1536x1024  --only=deck,catapult,bow,climb,turn,low,cockpit  --query='&rudder=1'
//          --mp: the real game instead, two pages in one fresh room: A (helm) launches off the shared carrier, B (crew,
//          PRI-FLY) watches the catapult run and the jet fly; A crashes, then gets their seat back, launches again and
//          returns with R.
//          --paint: paint and team-colour close-ups from the harness (jet in both team colours, chase and side views,
//          two teams in one frame, a carrier of each team, a jet on deck), into <out>/paint-*.png.
import { chromium, type Page } from "playwright-core"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const args = process.argv.slice(2)
const opt = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const base = opt("base", "https://carrier.lwoyjcaeyxv6.opentunnel.xyz/")
const out = opt("out", "/tmp/carrier-flight/out")
const seed = opt("seed", "7")
const query = opt("query", "")
const only = opt("only", "deck,catapult,bow,climb,turn,low,cockpit").split(",")
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

async function open(url: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 })
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") logs.push(`${m.type()}: ${m.text()}`)
  })
  page.on("pageerror", (e) => { logs.push(`pageerror: ${e.message}`); console.log(`pageerror: ${e.message}`) })
  page.on("crash", () => console.log("page crashed"))
  page.on("close", () => console.log("page closed"))
  // Other agents edit files on the shared dev server: block Vite's HMR socket so a full reload can't reset the run.
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
      await page.goto(url, { waitUntil: "load" })
      break
    } catch (e) {
      if (i >= 3) throw e
      await page.waitForTimeout(1500)
    }
  }
  await page.waitForFunction(() => !!(globalThis as unknown as { carrier?: { flight?: unknown } }).carrier?.flight, null, { timeout: 60_000 })
  return page
}

type View = { role: string; seat: number; ship: number; online: string; phase: string; speed: number; crashed: string; y: number; remote: number; launchBtn: string }
const view = (page: Page): Promise<View> =>
  page.evaluate(() => {
    type C = {
      net: { state: string }
      game: { state: { role: string; seat: number; shipId: number } }
      flight: { status: { phase: string; speed: number; crashed: string }; flight: { plane: { y: number } }; remotes: { jets: Map<number, { snaps: number[][] }> } }
    }
    const c = (globalThis as unknown as { carrier: C }).carrier
    const btn = document.querySelector("#fl .launch") as HTMLButtonElement | null
    return {
      role: c.game.state.role,
      seat: c.game.state.seat,
      ship: c.game.state.shipId,
      online: c.net.state,
      phase: c.flight.status.phase,
      speed: c.flight.status.speed,
      crashed: c.flight.status.crashed,
      y: c.flight.flight.plane.y,
      // Jets B would draw: relayed and not crashed.
      remote: [...c.flight.remotes.jets.values()].filter((j) => j.snaps.length && j.snaps[j.snaps.length - 1]![1] !== 2).length,
      launchBtn: !btn || btn.hidden ? "hidden" : btn.disabled ? "busy" : "ready",
    }
  })
async function until(page: Page, ok: (v: View) => boolean, ms = 15_000): Promise<View> {
  const end = Date.now() + ms
  let v = await view(page)
  while (!ok(v) && Date.now() < end) {
    await page.waitForTimeout(100)
    v = await view(page)
  }
  return v
}
const vfmt = (v: View) => `${v.role} seat ${v.seat} ship ${v.ship} ${v.phase} ${(v.speed / 0.5144).toFixed(0)} kn y ${v.y.toFixed(1)} ${v.crashed} remote jets ${v.remote} launch ${v.launchBtn}`

/** Free orbit camera on page `p` looking at A's jet as B sees it (from the remote jets), or at a world point. */
async function watch(p: Page, yawOff: number, dist: number, pitchDeg: number): Promise<void> {
  await p.evaluate(
    ([yawOff, dist, pitchDeg]) => {
      type C = {
        game: { state: { free: boolean } }
        camera: { set(v: object): void; y: number }
        flight: { remotes: { jets: Map<number, { pose: { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number } }> } }
      }
      const c = (globalThis as unknown as { carrier: C }).carrier
      const j = [...c.flight.remotes.jets.values()][0]
      if (!j) return
      const q = j.pose
      const fx = 2 * (q.qx * q.qz + q.qw * q.qy)
      const fz = 1 - 2 * (q.qx * q.qx + q.qy * q.qy)
      c.game.state.free = true
      c.camera.set({ x: q.x, z: q.z, yaw: Math.atan2(fx, -fz) + yawOff!, pitch: (pitchDeg! * Math.PI) / 180, dist: dist! })
      c.camera.y = q.y
    },
    [yawOff, dist, pitchDeg],
  )
}

type Dbg = {
  paused: boolean
  team: number
  inspect: { yaw: number; pitch: number; dist: number } | null
  wing: { x: number; y: number; z: number; team: number } | null
  warp(...a: number[]): void
  flight: { toDeck(s: unknown): void; requestLaunch(): void }
  ship: { x: number; z: number; heading: number }
}
const dbg = (page: Page, fn: string) => page.evaluate(`(() => { const c = globalThis.carrier; ${fn} })()`)

async function paint(): Promise<void> {
  const page = await open(`${base}flight.html?seed=${seed}&team=0${query}`)
  const dir = opt("dir", "paint")
  await page.waitForTimeout(2500)
  const set = async (js: string, wait = 350) => {
    await dbg(page, js)
    await page.waitForTimeout(wait)
  }
  // On the deck, both teams (jet and carrier wear the colour).
  await shot(page, `${dir}/01-deck-team0`)
  await set("c.inspect = { yaw: 2.6, pitch: 0.32, dist: 32 }")
  await shot(page, `${dir}/02-deck-closeup-team0`)
  await set("c.team = 1; c.inspect = { yaw: -0.9, pitch: 0.18, dist: 26 }")
  await shot(page, `${dir}/03-deck-closeup-team1`)
  // Carriers from chase distance, both teams (the orbit is round the jet on the bow, i.e. round the ship).
  await set("c.team = 0; c.inspect = { yaw: 3.0, pitch: 0.3, dist: 520 }")
  await shot(page, `${dir}/04-carrier-team0`)
  await set("c.team = 1; c.inspect = { yaw: 2.4, pitch: 0.42, dist: 470 }")
  await shot(page, `${dir}/05-carrier-team1`)
  await set("c.inspect = { yaw: -2.2, pitch: 0.2, dist: 420 }")
  await shot(page, `${dir}/05b-carrier-team1-bow`)
  // In the air, frozen: three-quarter, side, top-rear and chase views in each colour.
  const sx = await page.evaluate(() => (globalThis as unknown as { carrier: Dbg }).carrier.ship)
  await set(`c.inspect = null; c.warp(${sx.x + 300}, 500, ${sx.z}, ${sx.heading + 0.5}, 0.02, 140); c.paused = false`, 900)
  await set("c.paused = true")
  for (const team of [0, 1]) {
    await set(`c.team = ${team}; c.inspect = { yaw: 0.75, pitch: 0.28, dist: 25 }`)
    await shot(page, `${dir}/1${team}-a-front34-team${team}`)
    await set("c.inspect = { yaw: Math.PI / 2, pitch: 0.04, dist: 24 }")
    await shot(page, `${dir}/1${team}-b-side-team${team}`)
    await set("c.inspect = { yaw: 2.5, pitch: 0.55, dist: 26 }")
    await shot(page, `${dir}/1${team}-c-rear34-team${team}`)
    await set("c.inspect = null", 600)
    await shot(page, `${dir}/1${team}-d-chase-team${team}`)
  }
  // Two teams in one frame: the player (team 0) and a team-1 wingman, close and at a few hundred metres.
  await set("c.team = 0; c.wing = { x: -16, y: 3, z: -12, team: 1 }; c.inspect = { yaw: 2.75, pitch: 0.2, dist: 70 }")
  await shot(page, `${dir}/20-two-teams-close`)
  await set("c.inspect = { yaw: 2.2, pitch: 0.15, dist: 300 }")
  await shot(page, `${dir}/21-two-teams-300m`)
  await set("c.inspect = { yaw: -1.2, pitch: -0.25, dist: 160 }")
  await shot(page, `${dir}/22-two-teams-below`)
  await set("c.wing = null; c.inspect = null")
}

type LandState = { phase: string; land: string; u: number; z: number; since: number }
const landState = (page: Page): Promise<LandState> =>
  page.evaluate(() => {
    const f = (globalThis as unknown as { carrier: { flight: { phase: string; landing: { phase: string; u: number; z: number; since: number } | null } } }).carrier.flight
    return { phase: f.phase, land: f.landing?.phase ?? "", u: f.landing?.u ?? 0, z: f.landing?.z ?? 0, since: f.landing?.since ?? 0 }
  })
async function untilLand(page: Page, ok: (s: LandState) => boolean, ms: number): Promise<LandState> {
  const end = Date.now() + ms
  let s = await landState(page)
  while (!ok(s) && Date.now() < end) {
    await page.waitForTimeout(50)
    s = await landState(page)
  }
  return s
}

/** Puts the jet `dist` m from the ship at relative bearing `bearing` (rad, 0 = ahead of the bow, + starboard), `height`
 *  m above the deck, nose `off` rad from the bearing back to the ship, at `speed` m/s. */
const warpNear = (page: Page, dist: number, bearing: number, height: number, speed: number, off = 0) =>
  page.evaluate(
    ([dist, bearing, height, speed, off]) => {
      type C = { ship: { x: number; z: number; heading: number }; warp(...a: number[]): void }
      const c = (globalThis as unknown as { carrier: C }).carrier
      const s = c.ship
      const a = s.heading + bearing!
      const x = s.x + Math.sin(a) * dist!
      const z = s.z - Math.cos(a) * dist!
      c.warp(x, 26 + height!, z, Math.atan2(s.x - x, -(s.z - z)) + off!, -0.03, speed!)
    },
    [dist, bearing, height, speed, off],
  )

/** The simple landing: a clean HUD approaching from the side, the capture, the autopilot swinging round, touchdown. */
async function simpleShots(): Promise<void> {
  const page = await open(`${base}flight.html?seed=${seed}&team=0${query}`)
  await page.waitForTimeout(2500)
  const dir = "landing-simple"
  // Off to the side, flying away: only the tiny edge chevron points home.
  await warpNear(page, 4200, -1.7, 380, 150, 2.4)
  await page.waitForTimeout(1200)
  await shot(page, `${dir}/01-edge-chevron`)
  // 4 km off the starboard beam, heading at the ship: the tiny tick and distance under the carrier, nothing else.
  await warpNear(page, 4000, -1.6, 380, 150, 0.15)
  await page.waitForTimeout(1500)
  await shot(page, `${dir}/02-side-approach-clean`)
  let s = await untilLand(page, (v) => v.phase === "landing", 20_000)
  check(s.phase === "landing", `captured from the side: ${JSON.stringify(s)}`)
  await page.waitForTimeout(600)
  await shot(page, `${dir}/03-captured`)
  await page.waitForTimeout(7000)
  await shot(page, `${dir}/04-swing-around`)
  await dbg(page, "c.inspect = { yaw: 1.4, pitch: 0.35, dist: 140 }")
  await page.waitForTimeout(250)
  await shot(page, `${dir}/05-swing-around-side`)
  await dbg(page, "c.inspect = null")
  s = await untilLand(page, (v) => v.land === "approach", 90_000)
  await page.waitForTimeout(2000)
  await shot(page, `${dir}/06-joined-final`)
  s = await untilLand(page, (v) => v.z > -300, 60_000)
  await shot(page, `${dir}/07-short-final`)
  s = await untilLand(page, (v) => v.land === "trap", 30_000)
  check(s.land === "trap", `touchdown: ${JSON.stringify(s)}`)
  await page.waitForTimeout(350)
  await shot(page, `${dir}/08-touchdown-trap`)
  s = await untilLand(page, (v) => v.land === "stopped", 6000)
  await page.waitForTimeout(400)
  await shot(page, `${dir}/09-stopped`)
  s = await untilLand(page, (v) => v.phase === "deck", 4000)
  check(s.phase === "deck", `back on deck: ${JSON.stringify(s)}`)
}

/** Auto-landing captures: warp behind the stern, lined up and low; the autopilot lands the jet. */
async function landing(): Promise<void> {
  const page = await open(`${base}flight.html?seed=${seed}&team=0${query}`)
  await page.waitForTimeout(2500)
  // 1300 m behind the stern, 60 m off the centreline, 160 m above the deck, on the ship's heading at 140 m/s.
  await page.evaluate(() => {
    type C = { ship: { x: number; z: number; heading: number; u: number }; warp(...a: number[]): void }
    const c = (globalThis as unknown as { carrier: C }).carrier
    const s = c.ship
    const f = [Math.sin(s.heading), -Math.cos(s.heading)]
    const left = [-Math.cos(s.heading), -Math.sin(s.heading)]
    const z = -165 - 1300
    const x = 15.2 + 60
    c.warp(s.x + f[0]! * z + left[0]! * x, 26 + 160, s.z + f[1]! * z + left[1]! * x, s.heading + 0.08, -0.02, 140 + s.u)
  })
  let s = await untilLand(page, (v) => v.phase === "landing", 3000)
  check(s.phase === "landing", `captured: ${JSON.stringify(s)}`)
  await page.waitForTimeout(2500)
  await shot(page, "landing/01-approach-cue")
  await dbg(page, "c.inspect = { yaw: 1.2, pitch: 0.12, dist: 60 }")
  await page.waitForTimeout(300)
  await shot(page, "landing/02-approach-side")
  await dbg(page, "c.inspect = null")
  s = await untilLand(page, (v) => v.z > -260, 30_000)
  await shot(page, "landing/03-short-final")
  s = await untilLand(page, (v) => v.land === "trap", 10_000)
  check(s.land === "trap", `touchdown: ${JSON.stringify(s)}`)
  await page.waitForTimeout(250)
  await shot(page, "landing/04-touchdown")
  await dbg(page, "c.inspect = { yaw: 2.3, pitch: 0.35, dist: 45 }")
  await page.waitForTimeout(200)
  await shot(page, "landing/05-trap-hook")
  await dbg(page, "c.inspect = null")
  s = await untilLand(page, (v) => v.land === "stopped", 5000)
  check(s.land === "stopped", `stopped: ${JSON.stringify(s)}`)
  await page.waitForTimeout(300)
  await shot(page, "landing/06-stopped")
  await dbg(page, "c.inspect = { yaw: -2.6, pitch: 0.4, dist: 120 }")
  await page.waitForTimeout(200)
  await shot(page, "landing/07-stopped-wide")
  await dbg(page, "c.inspect = null")
  s = await untilLand(page, (v) => v.phase === "deck", 4000)
  check(s.phase === "deck", `recovered to the deck: ${JSON.stringify(s)}`)
}

async function multiplayer(): Promise<void> {
  const room = `flt${Math.floor(Math.random() * 1e6)}`
  const a = await open(`${base}?room=${room}`)
  let va = await until(a, (v) => v.online === "online" && v.role !== "none")
  const b = await open(`${base}?room=${room}`)
  let vb = await until(b, (v) => v.online === "online" && v.role !== "none")
  console.log(`room ${room}\nA: ${vfmt(va)}\nB: ${vfmt(vb)}`)
  // Watch A's connection, id and role, to explain any surprise.
  await a.evaluate(() => {
    type C = { net: { state: string; id: number; refused: { error: string } | null }; game: { state: { role: string } }; flight: { status: { phase: string; crashed: string } } }
    const g = globalThis as unknown as { carrier: C; __log: string[] }
    g.__log = []
    let last = ""
    setInterval(() => {
      const c = g.carrier
      const k = `${c.net.state} id ${c.net.id} ${c.game.state.role} ${c.flight.status.phase} ${c.flight.status.crashed} ${c.net.refused?.error ?? ""}`
      if (k !== last) g.__log.push(`${(performance.now() / 1000).toFixed(2)} ${k}`)
      last = k
    }, 50)
  })
  check(va.role === "helm" && vb.role === "crew" && va.ship === vb.ship, "A helms, B crews the same carrier")
  // B to PRI-FLY (seat 2), looking over the runway; A rings up 60% and lets the ship work up speed.
  await b.evaluate(() => (globalThis as unknown as { carrier: { net: { seat(n: number): void } } }).carrier.net.seat(2))
  await a.keyboard.press("Digit6")
  await a.waitForTimeout(5000)
  vb = await until(b, (v) => v.seat === 2)
  check(va.launchBtn === "ready" || (await view(a)).launchBtn === "ready", "LAUNCH offered to a seated player")
  await shot(a, "integrated/01-a-helm-launch-button")
  await shot(b, "integrated/02-b-prifly")

  // A launches with F: the room grants a slot, the jet appears on the shared carrier's catapult.
  await a.keyboard.press("f")
  va = await until(a, (v) => v.role === "plane" && v.phase === "launching", 5000)
  check(va.role === "plane", `A granted a plane slot: ${vfmt(va)}`)
  await a.waitForTimeout(600)
  await shot(a, "integrated/03-a-on-deck")
  vb = await until(b, (v) => v.remote > 0, 3000)
  check(vb.remote === 1, `B sees A's jet on the deck: ${vfmt(vb)}`)
  await b.waitForTimeout(1500)
  // B looks from off the port quarter down onto A's jet on the shared deck.
  await watch(b, 2.5, 95, 24)
  await b.waitForTimeout(100)
  await shot(b, "integrated/04-b-sees-a-spool")
  await b.waitForTimeout(1300)
  await watch(b, 2.2, 140, 20)
  await b.waitForTimeout(100)
  await shot(b, "integrated/05-b-sees-a-catapult")
  va = await until(a, (v) => v.phase === "flying", 5000)
  check(va.phase === "flying" && va.speed > 80, `A airborne: ${vfmt(va)}`)
  // A climbs out on full throttle; B follows A's jet with a free camera.
  await a.keyboard.down("w")
  await stick(a, { pitch: 0.4, roll: 0 })
  await a.waitForTimeout(1200)
  await stick(a, null)
  await shot(a, "integrated/06-a-climb")
  await b.waitForTimeout(300)
  await watch(b, 2.4, 120, 12)
  await b.waitForTimeout(200)
  await shot(b, "integrated/07-b-sees-a-fly")
  await stick(a, { pitch: 0.9, roll: 0.9 })
  await a.waitForTimeout(900)
  await stick(a, { pitch: 1, roll: 0 })
  await a.waitForTimeout(1200)
  await watch(b, 0.6, 90, 8)
  await b.waitForTimeout(150)
  await shot(b, "integrated/08-b-sees-a-turn")
  await shot(a, "integrated/09-a-turn")
  // A dives into the sea.
  await a.keyboard.up("w")
  await stick(a, { pitch: -1, roll: 0 })
  va = await until(a, (v) => v.phase === "crashed", 20_000)
  await stick(a, null)
  check(va.phase === "crashed" && va.crashed === "sea", `A crashed: ${vfmt(va)}`)
  await a.waitForTimeout(300)
  await shot(a, "integrated/10-a-splash")
  vb = await until(b, (v) => v.remote === 0, 2000)
  check(vb.remote === 0, "B no longer draws A's crashed jet")
  va = await until(a, (v) => v.role !== "plane", 6000)
  check(va.role === "helm" && va.seat === 0, `A back at the helm after the crash: ${vfmt(va)}`)
  await a.waitForTimeout(1300)
  await shot(a, "integrated/11-a-back-at-helm")
  // Second sortie: launch from the HUD button, then end it the way a landing does (there is no key to quit a flight).
  await a.click("#fl .launch")
  va = await until(a, (v) => v.role === "plane", 5000)
  check(va.role === "plane", "A launched again from the HUD button")
  await until(a, (v) => v.phase === "flying", 6000)
  await a.waitForTimeout(800)
  await a.keyboard.press("c")
  await a.waitForTimeout(500)
  await shot(a, "integrated/12-a-cockpit")
  await a.keyboard.press("c")
  await a.evaluate(() => (globalThis as unknown as { carrier: { net: { recover(how: string): void } } }).carrier.net.recover("landed"))
  va = await until(a, (v) => v.role !== "plane", 4000)
  check(va.role === "helm" && va.seat === 0, `landed: A back at the helm: ${vfmt(va)}`)
  vb = await until(b, (v) => v.remote === 0, 2000)
  check(vb.remote === 0, "A's jet despawned for B")
  console.log((await a.evaluate(() => (globalThis as unknown as { __log: string[] }).__log)).join("\n"))
  await b.close()
  await a.close()
}

/** Grabs the next swapchain texture through the game's own device, draws the DOM HUD on top, returns PNG bytes. */
async function grab(page: Page): Promise<Buffer> {
  const b64 = await page.evaluate(async () => {
    const c = (globalThis as unknown as { carrier: { renderer: { context: { device: GPUDevice } } } }).carrier
    const device = c.renderer.context.device
    const ctx = (c.renderer as unknown as { canvas: GPUCanvasContext }).canvas
    const format = navigator.gpu.getPreferredCanvasFormat()
    ctx.configure({ device, format, alphaMode: "opaque", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
    const w = (ctx.canvas as HTMLCanvasElement).width
    const h = (ctx.canvas as HTMLCanvasElement).height
    const row = Math.ceil((w * 4) / 256) * 256
    const buf = device.createBuffer({ size: row * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
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
    const cv = new OffscreenCanvas(w, h)
    const g = cv.getContext("2d")!
    g.putImageData(img, 0, 0)
    const sx = w / innerWidth
    const ink = "#f4f7fb"
    g.shadowColor = "rgba(10,30,60,0.5)"
    g.shadowBlur = 8
    g.fillStyle = ink
    g.textAlign = "left"
    g.font = "300 17px 'IBM Plex Mono', monospace"
    g.fillText("C A R R I E R", 22, 36)
    const vis = (el: Element | null): el is HTMLElement => !!el && (el as HTMLElement).offsetParent !== null
    const bl = document.querySelector("#bl .role") as HTMLElement | null
    if (vis(bl) && bl.innerText.trim()) {
      g.font = "300 15px 'IBM Plex Mono', monospace"
      g.fillText(bl.innerText.replace(/\s+/g, " ").split("").join(""), 22, h - 28)
    }
    const helm = document.querySelector("#br") as HTMLElement | null
    if (vis(helm)) {
      g.textAlign = "right"
      const rows = [...helm.querySelectorAll(".helm-row")].map((r) => (r as HTMLElement).innerText.replace(/\s+/g, "  "))
      g.font = "300 21px 'IBM Plex Mono', monospace"
      g.fillText(rows[0] ?? "", w - 28, h - 56)
      g.font = "300 12px 'IBM Plex Mono', monospace"
      g.fillText(rows[1] ?? "", w - 28, h - 28)
      g.textAlign = "left"
    }
    const home = document.querySelector("#fl .home") as HTMLElement | null
    if (vis(home)) {
      const col = getComputedStyle(home).color
      g.strokeStyle = col
      g.fillStyle = col
      g.lineWidth = 1.5
      const tick = home.querySelector(".tick") as HTMLElement
      if (vis(tick)) {
        const r = tick.getBoundingClientRect()
        g.fillRect(r.left * sx, r.top * sx, Math.max(1.5, r.width * sx), r.height * sx)
      }
      const chev = home.querySelector(".chev") as HTMLElement
      if (vis(chev)) {
        const r = chev.getBoundingClientRect()
        const m = /rotate\(([-\d.e]+)rad\)/.exec(chev.style.transform)
        const a = m ? Number(m[1]) : 0
        const cx = (r.left + r.width / 2) * sx
        const cy = (r.top + r.height / 2) * sx
        g.save()
        g.translate(cx, cy)
        g.rotate(a)
        g.lineWidth = 1.5
        g.beginPath()
        g.moveTo(-2, -4.5); g.lineTo(2.5, 0); g.lineTo(-2, 4.5)
        g.stroke()
        g.restore()
      }
      const km = home.querySelector(".km") as HTMLElement
      const r = km.getBoundingClientRect()
      g.font = "300 9px 'IBM Plex Mono', monospace"
      g.textAlign = "center"
      g.fillText(km.innerText.split("").join(" "), (r.left + r.width / 2) * sx, (r.top + r.height * 0.8) * sx)
      g.textAlign = "right"
    }
    const read = document.querySelector("#fl .read")
    g.textAlign = "right"
    if (vis(read)) {
      // The readout's own colour (white): the carrier marker above left the team colour as the fill.
      g.fillStyle = getComputedStyle(read).color
      const rows = [...read.querySelectorAll(".row")].map((r) => (r as HTMLElement).innerText.replace(/\s+/g, "  "))
      g.font = "300 21px 'IBM Plex Mono', monospace"
      g.fillText(rows[0] ?? "", w - 28, h - 56)
      g.font = "300 12px 'IBM Plex Mono', monospace"
      g.fillText(rows[1] ?? "", w - 28, h - 28)
    }
    const at = (el: HTMLElement) => {
      const r = el.getBoundingClientRect()
      return { x: (r.left + r.width / 2) * sx, y: (r.top + r.height / 2) * sx }
    }
    const nose = document.querySelector("#fl .nose")
    if (vis(nose)) {
      const p = at(nose)
      g.fillStyle = ink
      g.fillRect(p.x - 1, p.y - 11, 2, 7)
      g.fillRect(p.x - 11, p.y - 1, 7, 2)
      g.fillRect(p.x + 4, p.y - 1, 7, 2)
    }
    const fpm = document.querySelector("#fl .fpm")
    if (vis(fpm)) {
      const p = at(fpm)
      g.strokeStyle = "#9dffb8"
      g.lineWidth = 1.5
      g.beginPath()
      g.arc(p.x, p.y, 6, 0, Math.PI * 2)
      g.moveTo(p.x - 6, p.y)
      g.lineTo(p.x - 15, p.y)
      g.moveTo(p.x + 6, p.y)
      g.lineTo(p.x + 15, p.y)
      g.stroke()
    }
    g.textAlign = "center"
    const warn = document.querySelector("#fl .warn") as HTMLElement | null
    if (warn?.textContent) {
      g.fillStyle = warn.classList.contains("cue") ? "#f4f7fb" : "#ffc861"
      g.font = "300 13px 'IBM Plex Mono', monospace"
      g.fillText(warn.textContent.split("").join(" "), w / 2, h * 0.62)
    }
    const card = document.querySelector("#fl .center")
    if (vis(card)) {
      g.fillStyle = ink
      g.font = "300 26px 'IBM Plex Mono', monospace"
      g.fillText((card.querySelector(".title") as HTMLElement).innerText.split("").join(" "), w / 2, h * 0.4)
      g.font = "300 11px 'IBM Plex Mono', monospace"
      g.fillText((card.querySelector(".sub") as HTMLElement).innerText, w / 2, h * 0.4 + 26)
    }
    const btn = document.querySelector("#fl .launch") as HTMLButtonElement | null
    if (vis(btn)) {
      const r = btn.getBoundingClientRect()
      g.globalAlpha = btn.disabled ? 0.45 : 1
      g.fillStyle = "rgba(10,24,44,0.32)"
      g.fillRect(r.left * sx, r.top * sx, r.width * sx, r.height * sx)
      g.strokeStyle = "rgba(244,247,251,0.75)"
      g.lineWidth = 1
      g.strokeRect(r.left * sx + 0.5, r.top * sx + 0.5, r.width * sx - 1, r.height * sx - 1)
      g.fillStyle = ink
      g.font = "300 14px 'IBM Plex Mono', monospace"
      g.fillText("L A U N C H", (r.left + r.width / 2) * sx, (r.top + r.height / 2 + 5) * sx)
      g.globalAlpha = 1
    }
    const blob = await cv.convertToBlob({ type: "image/png" })
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let bin = ""
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(bin)
  })
  return Buffer.from(b64, "base64")
}

type State = { phase: string; x: number; y: number; z: number; speed: number; pitch: number; bank: number; heading: number; stall: number; g: number; crashed: string; shipT: number; launch: string }
const stateOf = (page: Page) =>
  page.evaluate(() => {
    type P = { x: number; y: number; z: number; vx: number; vy: number; vz: number; qx: number; qy: number; qz: number; qw: number; stall: number; g: number; crashed: string }
    const f = (globalThis as unknown as { carrier: { flight: { phase: string; plane: P; launch: { phase: string } | null }; ship: { t: number } } }).carrier
    const p = f.flight.plane
    const fx = 2 * (p.qx * p.qz + p.qw * p.qy)
    const fy = 2 * (p.qy * p.qz - p.qw * p.qx)
    const fz = 1 - 2 * (p.qx * p.qx + p.qy * p.qy)
    const ly = 2 * (p.qx * p.qy + p.qw * p.qz)
    const uy = 1 - 2 * (p.qx * p.qx + p.qz * p.qz)
    return {
      phase: f.flight.phase,
      launch: f.flight.launch?.phase ?? "",
      x: p.x,
      y: p.y,
      z: p.z,
      speed: Math.hypot(p.vx, p.vy, p.vz),
      pitch: Math.asin(Math.max(-1, Math.min(1, fy))),
      bank: Math.atan2(ly, uy),
      heading: Math.atan2(fx, -fz),
      stall: p.stall,
      g: p.g,
      crashed: p.crashed,
      shipT: f.ship.t,
    }
  })
const D = 180 / Math.PI
const fmt = (s: State) =>
  `${s.phase}/${s.launch} pos ${s.x.toFixed(0)},${s.y.toFixed(1)},${s.z.toFixed(0)} ${(s.speed / 0.5144).toFixed(0)} kn pitch ${(s.pitch * D).toFixed(1)}° bank ${(s.bank * D).toFixed(0)}° hdg ${(s.heading * D).toFixed(0)}° stall ${s.stall.toFixed(2)} g ${s.g.toFixed(1)} ${s.crashed}`

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(join(out, name, ".."), { recursive: true })
  writeFileSync(join(out, `${name}.png`), await grab(page))
  console.log(`${name}: ${args.includes("--mp") ? vfmt(await view(page)) : fmt(await stateOf(page))}`)
}

const stick = (page: Page, v: { pitch: number; roll: number; yaw?: number } | null) =>
  page.evaluate((v) => {
    // The harness exposes its FlightInput as carrier.input; the game, as carrier.flight.input.
    const c = (globalThis as unknown as { carrier: { input: { override: unknown }; flight: { input?: { override: unknown } } } }).carrier
    const i = c.flight.input && "override" in c.flight.input ? c.flight.input : c.input
    i.override = v
  }, v)

/** Flies a bank-and-hold autopilot for `ms`: rolls to `bank` (rad) and pulls `pull` (0..1), via the stick override. */
async function hold(page: Page, bank: number, pull: number, ms: number): Promise<void> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const s = await stateOf(page)
    const roll = Math.max(-1, Math.min(1, (bank - s.bank) * 2.5))
    // Keep the nose near the horizon: the turn stays a level turn.
    const over = Math.max(-1, Math.min(1, s.pitch * 3)) * Math.sign(bank)
    await stick(page, { pitch: pull, roll: Math.max(-1, Math.min(1, roll + over)) })
    await page.waitForTimeout(50)
  }
}

if (args.includes("--simple")) {
  await simpleShots()
  console.log(logs.length ? logs.join("\n") : "no console errors")
  await browser.close()
  process.exit(failures ? 1 : 0)
}

if (args.includes("--land")) {
  await landing()
  console.log(logs.length ? logs.join("\n") : "no console errors")
  await browser.close()
  process.exit(failures ? 1 : 0)
}

if (args.includes("--paint")) {
  await paint()
  console.log(logs.length ? logs.join("\n") : "no console errors")
  await browser.close()
  process.exit(0)
}

if (args.includes("--mp")) {
  await multiplayer()
  console.log(logs.length ? logs.join("\n") : "no console errors")
  await browser.close()
  process.exit(failures ? 1 : 0)
}

const page = await open(`${base}flight.html?seed=${seed}${query}`)
const info = await page.evaluate(async () => {
  const a = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" })
  return a ? `${a.info.vendor} / ${a.info.architecture} / ${a.info.description}` : "no adapter"
})
console.log(`adapter: ${info}`)
if (/swiftshader/i.test(info)) {
  console.log("SwiftShader adapter: refusing to trust these captures")
  process.exit(2)
}
await page.waitForTimeout(2500)
if (only.includes("deck")) await shot(page, "01-deck")
await page.keyboard.press("f")
// Line-up 1.1 s + spool 1 s, then 1.3 s into the 2.4 s stroke.
await page.waitForTimeout(3400)
if (only.includes("catapult")) await shot(page, "02-catapult")
await page.waitForFunction(() => (globalThis as unknown as { carrier: { flight: { phase: string } } }).carrier.flight.phase === "flying", null, { timeout: 10_000 })
await page.waitForTimeout(250)
if (only.includes("bow")) await shot(page, "03-leaving-bow")
await page.keyboard.down("w")
await page.waitForTimeout(1200)
await stick(page, { pitch: 0.45, roll: 0 })
await page.waitForTimeout(900)
await stick(page, null)
await page.waitForTimeout(1500)
if (only.includes("climb")) await shot(page, "04-climb")
await page.keyboard.down("Shift")
await page.waitForTimeout(1500)
if (only.includes("climb")) await shot(page, "04b-afterburner")
await page.keyboard.up("Shift")
// Level off before the turn.
for (let i = 0; i < 40; i++) {
  const s = await stateOf(page)
  if (Math.abs(s.pitch) < 0.05) break
  await stick(page, { pitch: Math.max(-1, Math.min(1, -s.pitch * 2.5)), roll: 0 })
  await page.waitForTimeout(60)
}
await stick(page, null)
if (only.includes("turn")) {
  await hold(page, 1.35, 0, 600)
  await hold(page, 1.35, 1, 1600)
  await shot(page, "05-hard-turn")
  await hold(page, 1.35, 1, 800)
  await shot(page, "05b-hard-turn")
  await stick(page, { pitch: 0, roll: 0 })
}
await page.keyboard.up("w")
await stick(page, null)
if (only.includes("low") || only.includes("cockpit")) {
  // Low over the waves toward a high island, 900 m off its shore, at 30 m and ~300 kn.
  const target = await page.evaluate(() => {
    const c = (globalThis as unknown as { carrier: { arch: { islands: { x: number; z: number; radius: number; peak: number; kind: string }[] } } }).carrier
    const isl = c.arch.islands.filter((i) => i.peak > 80).sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z))[0]!
    return { x: isl.x, z: isl.z, r: isl.radius }
  })
  const dx = -target.x
  const dz = -target.z
  const d = Math.hypot(dx, dz)
  const sx = target.x + (dx / d) * (target.r + 1400)
  const sz = target.z + (dz / d) * (target.r + 1400)
  const heading = Math.atan2(target.x - sx, -(target.z - sz)) + 0.25
  await page.evaluate(([x, z, h]) => (globalThis as unknown as { carrier: { warp(...a: number[]): void } }).carrier.warp(x!, 30, z!, h!, 0, 150), [sx, sz, heading])
  await page.waitForTimeout(1800)
  if (only.includes("low")) await shot(page, "06-low-waves")
  if (only.includes("cockpit")) {
    await page.keyboard.press("c")
    await page.waitForTimeout(600)
    await shot(page, "07-cockpit")
    await page.keyboard.press("c")
  }
}
console.log(logs.length ? logs.join("\n") : "no console errors")
await browser.close()
