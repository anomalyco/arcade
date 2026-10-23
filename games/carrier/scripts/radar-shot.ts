// Pilot's radar, full map and target markers on a real GPU. Runs ON hailmary (Mac Studio): Chrome with WebGPU on Metal
// loads the live dev server's game in fresh rooms (offline draws only our own carrier), and captures the frame under the DOM (HUD,
// radar) as scripts/ui-shot.ts does.
//
//   ssh hailmary 'cd /tmp/carrier-radar && ~/.bun/bin/bun radar-shot.ts --out=/tmp/carrier-radar/out'
//
// Steps (--only=solo,mp): solo: a Hornet near an enemy carrier (radar, bracket, distance), flying away from it (the
// edge arrow), the full map held on G, a missile homing on us, a fixed 10 km range. mp: two pages in one room, each
// on its own carrier: an enemy jet ahead and above (radar arrow with its height tick, diamond), the enemy jet over its
// carrier, and the full map with both jets.
import { type Page } from "playwright-core"
import { browserBudget } from "../../../scripts/browser-budget"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

await using budget = browserBudget()
const { chromium } = budget

const args = process.argv.slice(2)
const opt = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const base = opt("base", "https://carrier.lwoyjcaeyxv6.opentunnel.xyz/")
const out = opt("out", "/tmp/carrier-radar/out")
const [vw, vh] = opt("size", "1536x960").split("x").map(Number) as [number, number]
const only = opt("only", "solo,mp").split(",")
const tod = opt("tod", "10.5")
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

async function open(url: string, name: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 })
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") logs.push(`${name} ${m.type()}: ${m.text()}`)
    if (m.type() === "error") console.log(`${name} error: ${m.text()}`)
  })
  page.on("pageerror", (e) => {
    logs.push(`${name} pageerror: ${e.message}`)
    console.log(`${name} pageerror: ${e.message}`)
  })
  // Other agents edit files on the shared dev server: keep Vite's HMR socket from reloading the page mid-run.
  await page.addInitScript((n) => {
    localStorage.setItem("carrier.name", n)
    const Real = WebSocket
    const Fake = function (this: unknown, url: string | URL, protocols?: string | string[]) {
      const p = Array.isArray(protocols) ? protocols : protocols ? [protocols] : []
      if (p.some((x) => x.startsWith("vite"))) return Object.assign(new EventTarget(), { readyState: 0, send() {}, close() {} })
      return new Real(url, protocols)
    } as unknown as typeof WebSocket
    Object.assign(Fake, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3, prototype: Real.prototype })
    globalThis.WebSocket = Fake
  }, name)
  await page.goto(url, { waitUntil: "load" })
  await page.waitForFunction(() => !!(globalThis as { carrier?: { game?: { state: { sea: unknown } } } }).carrier?.game?.state.sea, null, { timeout: 60_000 })
  return page
}

const js = <T = unknown>(page: Page, fn: string): Promise<T> => page.evaluate(`(() => { const c = globalThis.carrier; const f = c.flight.flight; const w = c.flight.weapons; ${fn} })()`) as Promise<T>

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
    const cv = document.createElement("canvas")
    cv.width = w
    cv.height = h
    cv.getContext("2d")!.putImageData(img, 0, 0)
    return cv.toDataURL("image/png")
  })
}

/** Frame under the DOM (HUD, radar), then a page screenshot. */
async function shot(page: Page, name: string): Promise<void> {
  const url = await frame(page)
  await page.evaluate((src) => {
    const img = document.createElement("img")
    img.id = "radar-shot-bg"
    img.src = src
    Object.assign(img.style, { position: "fixed", inset: "0", width: "100%", height: "100%", zIndex: "0" })
    const canvas = document.getElementById("view")!
    canvas.style.visibility = "hidden"
    canvas.after(img)
    return new Promise((r) => (img.complete ? r(null) : (img.onload = () => r(null))))
  }, url)
  await page.screenshot({ path: join(out, `${name}.png`) })
  await page.evaluate(() => {
    document.getElementById("radar-shot-bg")?.remove()
    document.getElementById("view")!.style.visibility = ""
  })
  const s = await js<string>(page, "return `${f.phase} y ${Math.round(f.plane.y)} markers ${[...document.querySelectorAll('#tmk .m:not([hidden])')].map((m) => m.className.slice(2)).join(',')}`").catch(() => "")
  console.log(`shot ${name}: ${s}`)
}

/** Puts our jet in free flight at (x, y, z) heading `h` (rad, compass), level, at `speed` m/s. */
const warp = (page: Page, x: number, y: number, z: number, h: number, speed: number) =>
  js(
    page,
    `const p = f.plane
    Object.assign(p, { x: ${x}, y: ${y}, z: ${z}, vx: ${speed} * Math.sin(${h}), vy: 0, vz: ${-speed} * Math.cos(${h}), p: 0, r: 0, w: 0, throttle: 0.75, crashed: "", blend: 1, stall: 0, outside: 0 })
    const a = (Math.PI - ${h}) / 2
    Object.assign(p, { qx: 0, qy: Math.sin(a), qz: 0, qw: Math.cos(a) })
    Object.assign(f.prev, p)
    f.phase = "flying"
    f.airborne = 10
    f.landing = null
    f.noCapture = 30`,
  )

async function until(page: Page, cond: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await js<boolean>(page, `return !!(${cond})`)) return true
    await page.waitForTimeout(50)
  }
  return false
}

type Pt = { x: number; z: number; heading: number; id: number; team: number }
/** Our team and the carriers as drawn (with the enemy nearest us first). */
const carriers = (page: Page) =>
  js<{ team: number; own: Pt | null; enemies: Pt[] }>(
    page,
    `const me = c.net.crew.players.find((p) => p.id === c.net.id)
    const all = c.flight.drawnShips.map((s) => ({ x: s.x, z: s.z, heading: s.heading, id: s.id, team: s.team }))
    const p = f.plane
    const enemies = all.filter((s) => s.team !== me.team).sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))
    return { team: me.team, own: all.find((s) => s.id === me.ship) ?? null, enemies }`,
  )

async function launch(page: Page): Promise<void> {
  await js(page, "c.net.op('hornet')")
  check(await until(page, "f.phase !== 'idle'", 6000), "a Hornet sortie starts")
  check(await until(page, "f.phase === 'flying'", 12000), "the Hornet flies")
}

const mapKey = async (page: Page, down: boolean) => (down ? page.keyboard.down("g") : page.keyboard.up("g"))

async function solo(): Promise<void> {
  const page = await open(`${base}?room=rs${Math.random().toString(36).slice(2, 7)}&tod=${tod}`, "solo")
  await page.waitForTimeout(4000)
  await launch(page)
  await page.waitForTimeout(1500)
  // Radar and island mask are up.
  check(await page.evaluate(() => !document.querySelector<HTMLCanvasElement>("#rd .mini")!.hidden), "the radar shows while flying")
  const w0 = await carriers(page)
  check(w0.enemies.length > 0, `enemy carriers drawn (${w0.enemies.length})`)
  const e = w0.enemies[0]!
  // 3.6 km out from the enemy carrier, heading at it, slightly off its line.
  {
    const b = Math.atan2(e.x - (w0.own?.x ?? 0), -(e.z - (w0.own?.z ?? 0)))
    const x = e.x - Math.sin(b) * 3600
    const z = e.z + Math.cos(b) * 3600
    await warp(page, x, 450, z, b + 0.12, 150)
    await page.waitForTimeout(2200)
    await shot(page, "01-approach-enemy-carrier")
    check(await page.evaluate(() => document.querySelectorAll("#tmk .m.ship:not([hidden])").length > 0), "a bracket on the enemy carrier in view")
    // Closer, 1.6 km.
    await warp(page, e.x - Math.sin(b) * 1600, 300, e.z + Math.cos(b) * 1600, b - 0.08, 140)
    await page.waitForTimeout(2200)
    await shot(page, "02-close-enemy-carrier")
    // Flying away from it: the edge arrow points back.
    await warp(page, e.x - Math.sin(b) * 3000, 500, e.z + Math.cos(b) * 3000, b + Math.PI - 0.7, 150)
    await page.waitForTimeout(2200)
    await shot(page, "03-edge-arrow-to-enemy")
    check(await page.evaluate(() => document.querySelectorAll("#tmk .m.edge:not([hidden])").length === 1), "an edge arrow toward the nearest enemy carrier")
  }
  // The full map on G.
  await mapKey(page, true)
  await page.waitForTimeout(400)
  check(await page.evaluate(() => !document.querySelector<HTMLCanvasElement>("#rd .map")!.hidden), "holding G shows the full map")
  await shot(page, "04-full-map")
  await mapKey(page, false)
  await page.waitForTimeout(200)
  check(await page.evaluate(() => Boolean(document.querySelector<HTMLCanvasElement>("#rd .map")!.hidden)), "releasing G after a hold closes it")
  // A tap pins it, a second tap closes it.
  await page.keyboard.press("g")
  await page.waitForTimeout(200)
  const pinned = await page.evaluate(() => !document.querySelector<HTMLCanvasElement>("#rd .map")!.hidden)
  await page.keyboard.press("g")
  await page.waitForTimeout(200)
  const closed = await page.evaluate(() => Boolean(document.querySelector<HTMLCanvasElement>("#rd .map")!.hidden))
  check(pinned && closed, "a tap pins the map, a second tap closes it")
  // A missile homing on us from behind (local world only, for the radar's blinking dot).
  await js(
    page,
    `const p = f.plane, h = Math.atan2(p.vx, -p.vz)
    w.world.fire({ owner: 4242, seq: 1, t: p.t, x: p.x - Math.sin(h) * 1400 + 300, y: p.y, z: p.z + Math.cos(h) * 1400, vx: Math.sin(h) * 320, vy: 0, vz: -Math.cos(h) * 320, target: c.net.id, kind: "missile" }, 3)`,
  )
  await page.waitForTimeout(300)
  const inbound = await js<number>(page, "return w.world.missiles.filter((m) => m.alive && m.target === c.net.id).length")
  check(inbound === 1, `a missile homes on us (${inbound})`)
  await shot(page, "05-missile-inbound")
  await page.waitForTimeout(125)
  await shot(page, "05b-missile-inbound-blink")
  await page.waitForTimeout(4000)
  // A fixed 10 km range.
  await page.evaluate(async () => {
    const m = (await import(["", "src", "flight", "radar.ts"].join("/"))) as { RADAR: { radarRange: number } }
    m.RADAR.radarRange = 10
  })
  await launchAgainIfDown(page)
  await warp(page, e.x + 2500, 700, e.z + 5200, Math.PI * 1.75, 150)
  await page.waitForTimeout(1500)
  await shot(page, "06-radar-10km")
  await page.close()
}

async function launchAgainIfDown(page: Page): Promise<void> {
  if (await js<boolean>(page, "return f.phase === 'flying'")) return
  await until(page, "f.phase === 'idle'", 8000)
  await page.waitForTimeout(500)
  await launch(page)
}

async function mp(): Promise<void> {
  const room = `radar${Math.random().toString(36).slice(2, 7)}`
  const a = await open(`${base}?room=${room}&tod=${tod}`, "ada")
  const b = await open(`${base}?room=${room}&tod=${tod}`, "bo")
  await a.waitForTimeout(4000)
  await launch(a)
  await launch(b)
  const wa = await carriers(a)
  const wb = await carriers(b)
  check(wa.team !== wb.team, `A and B are enemies (teams ${wa.team} / ${wb.team})`)
  // A over open water; B 1.7 km ahead, 450 m to the right and 350 m above, crossing left.
  const own = wa.own!
  const h = 0.6
  const F = [Math.sin(h), -Math.cos(h)] as const
  const R = [Math.cos(h), Math.sin(h)] as const
  const ax = own.x + F[0] * 2500
  const az = own.z + F[1] * 2500
  await warp(a, ax, 500, az, h, 150)
  await warp(b, ax + F[0] * 1700 + R[0] * 450, 850, az + F[1] * 1700 + R[1] * 450, h - 1.2, 150)
  await a.waitForTimeout(2500)
  check(await until(a, "[...w.jets.values()].some((j) => j.alive)", 3000), "A sees B's jet")
  await shot(a, "10-mp-enemy-jet-ahead")
  check(await a.evaluate(() => document.querySelectorAll("#tmk .m.jet:not([hidden])").length > 0), "a diamond on the enemy jet")
  await mapKey(a, true)
  await a.waitForTimeout(400)
  await shot(a, "11-mp-full-map")
  await mapKey(a, false)
  // B over its own carrier; A inbound to it from 4 km.
  const eb = wb.own!
  const bearing = Math.atan2(eb.x - ax, -(eb.z - az))
  await warp(b, eb.x + 400, 600, eb.z - 300, bearing + 2.4, 140)
  await warp(a, eb.x - Math.sin(bearing) * 4000, 650, eb.z + Math.cos(bearing) * 4000, bearing + 0.06, 150)
  await a.waitForTimeout(2500)
  await shot(a, "12-mp-enemy-carrier-and-jet")
  await a.close()
  await b.close()
}

if (only.includes("solo")) await solo()
if (only.includes("mp")) await mp()
console.log(logs.length ? logs.slice(0, 40).join("\n") : "no console errors")
await browser.close()
await budget.exit(failures ? 1 : 0)
