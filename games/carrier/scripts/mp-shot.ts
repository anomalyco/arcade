// Multiplayer captures and checks on a real GPU. Runs ON hailmary (Mac Studio): Chrome with WebGPU on Metal, loading the
// live dev server. The menu, roster and HUD are DOM, so each capture reads the frame back through the game's own device,
// lays it under the page as an image and screenshots the page.
//
//   ssh hailmary 'cd /tmp/carrier-ocean && ~/.bun/bin/bun mp-shot.ts --out=/tmp/carrier-mp/out'
//
// Steps: the load screen; the roster preview (menu.html, fake crew); then three players quick-joining the real room:
// the first two share a ship, a seat move, the third starts the other team, a new ship, a team switch, launch and return,
// and the helm driving the ship that the crew sees move.
import { chromium, type Page } from "playwright-core"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

const args = process.argv.slice(2)
const opt = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const base = opt("base", "https://carrier.lwoyjcaeyxv6.opentunnel.xyz/")
const out = opt("out", "/tmp/carrier-mp/out")
const [vw, vh] = opt("size", "1536x960").split("x").map(Number) as [number, number]
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
  })
  page.on("pageerror", (e) => logs.push(`${name} pageerror: ${e.message}`))
  // Other agents edit files on the shared dev server: keep Vite's HMR socket from reloading the page mid-run.
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
  await page.goto(url, { waitUntil: "load" })
  await page.waitForFunction(() => !!(globalThis as unknown as { carrier?: { game?: { state: { sea: unknown } } } }).carrier?.game?.state.sea, null, { timeout: 30_000 })
  return page
}

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

/** Frame under the DOM (menu, roster, HUD), then a page screenshot. */
async function shot(page: Page, name: string): Promise<void> {
  const url = await frame(page)
  await page.evaluate((src) => {
    const img = document.createElement("img")
    img.id = "mp-shot-bg"
    img.src = src
    Object.assign(img.style, { position: "fixed", inset: "0", width: "100%", height: "100%", zIndex: "0" })
    const canvas = document.getElementById("view")!
    canvas.style.visibility = "hidden"
    canvas.after(img)
    return new Promise((r) => (img.complete ? r(null) : (img.onload = () => r(null))))
  }, url)
  await page.screenshot({ path: join(out, `${name}.png`) })
  await page.evaluate(() => {
    document.getElementById("mp-shot-bg")?.remove()
    document.getElementById("view")!.style.visibility = ""
  })
  console.log(`shot ${name}`)
}

type View = { room: string | null; id: number; role: string; shipId: number; seat: number; team: number; ships: number; online: string }
const view = (page: Page): Promise<View> =>
  page.evaluate(() => {
    const c = (globalThis as unknown as { carrier: { net: { room: string | null; id: number; state: string; crew: { players: { id: number; team: number }[]; ships: unknown[] } | null }; game: { state: { role: string; shipId: number; seat: number } } } }).carrier
    const me = c.net.crew?.players.find((p) => p.id === c.net.id)
    return { room: c.net.room, id: c.net.id, role: c.game.state.role, shipId: c.game.state.shipId, seat: c.game.state.seat, team: me?.team ?? -1, ships: c.net.crew?.ships.length ?? 0, online: c.net.state }
  })
const until = async (page: Page, ok: (v: View) => boolean, ms = 8000): Promise<View> => {
  const end = Date.now() + ms
  let v = await view(page)
  while (!ok(v) && Date.now() < end) {
    await page.waitForTimeout(150)
    v = await view(page)
  }
  return v
}
const pin = (page: Page, open: boolean) => page.evaluate((o) => (globalThis as unknown as { carrier: { roster: { pin(o: boolean): void } } }).carrier.roster.pin(o), open)
/** Clicks something in the roster (it acts on pointerdown). */
const press = async (page: Page, selector: string) => {
  await pin(page, true)
  await page.waitForTimeout(200)
  await page.locator(selector).first().dispatchEvent("pointerdown", { button: 0 })
}

/** Opens the real game, types a name and quick-joins. */
async function quickJoin(name: string): Promise<Page> {
  const page = await open(base, name)
  await page.fill(".mn-name", name)
  await page.click('[data-act="quick"]')
  await until(page, (v) => v.online === "online" && v.role !== "none", 15_000)
  await page.waitForFunction(() => !document.querySelector(".mn"), null, { timeout: 5000 })
  return page
}

// 1. The load screen, as a first visit sees it (the menu over an offline sea), and the menu preview with fake stats.
{
  const page = await open(base, "menu")
  await page.waitForTimeout(2500)
  await shot(page, "menu")
  await page.close()
  const pre = await open(`${base}menu.html?seed=7&show=roster`, "roster-preview")
  await pre.waitForTimeout(2000)
  await shot(pre, "roster-preview")
  await pre.close()
}

// 2. Three players quick-join.
const a = await quickJoin("ada")
const b = await quickJoin("bo")
let va = await view(a)
let vb = await view(b)
check(!!va.room && va.room === vb.room, `quick join: same room (${va.room} / ${vb.room})`)
check(va.shipId === vb.shipId, `quick join: same ship (${va.shipId} / ${vb.shipId})`)
check(va.role === "helm" && vb.role === "crew", `roles: ada ${va.role}, bo ${vb.role} (seat ${vb.seat})`)
await a.waitForTimeout(1500)
await pin(a, true)
await shot(a, "roster-two")
await pin(a, false)

// The helm drives: ada orders 60% and some rudder; bo (crew) sees the ship move on the room's simulation.
await a.bringToFront()
await a.mouse.click(vw / 2, vh / 2)
for (const k of ["Digit6"]) await a.keyboard.press(k)
await a.keyboard.down("KeyD")
const before = await b.evaluate(() => (globalThis as unknown as { carrier: { net: { ships: Map<number, number[]> } } }).carrier.net.ships)
const shipA = va.shipId
const x0 = await b.evaluate((id) => [...(globalThis as unknown as { carrier: { net: { ships: Map<number, number[]> } } }).carrier.net.ships.get(id)!], shipA)
await a.waitForTimeout(6000)
await a.keyboard.up("KeyD")
const x1 = await b.evaluate((id) => [...(globalThis as unknown as { carrier: { net: { ships: Map<number, number[]> } } }).carrier.net.ships.get(id)!], shipA)
void before
check(x1[8]! > 0.55 && Math.hypot(x1[2]! - x0[2]!, x1[3]! - x0[3]!) > 5, `helm drives the room's ship: order ${x1[8]}, moved ${Math.hypot(x1[2]! - x0[2]!, x1[3]! - x0[3]!).toFixed(1)} m`)
const pred = await a.evaluate(() => (globalThis as unknown as { carrier: { game: { state: { ship: { x: number; z: number } | null } } } }).carrier.game.state.ship)
check(!!pred && Math.hypot(pred.x - x1[2]!, pred.z - x1[3]!) < 30, `helm prediction tracks the room (${pred ? Math.hypot(pred.x - x1[2]!, pred.z - x1[3]!).toFixed(1) : "?"} m apart)`)
await shot(a, "helm")
await shot(b, "crew-seat")

// Seat switch: bo clicks the GUNNER AFT seat on the roster.
await press(b, '.ro-ship.mine [data-ro="seat"][data-seat="4"]')
vb = await until(b, (v) => v.seat === 4)
check(vb.seat === 4 && vb.role === "crew", `seat switch: bo now in seat ${vb.seat}`)
await pin(b, false)
await b.waitForTimeout(800)
await shot(b, "crew-gunner-aft")

// A third player starts the other team.
const c = await quickJoin("cy")
const vc = await view(c)
check(vc.room === va.room && vc.team !== va.team && vc.role === "helm", `third joiner: room ${vc.room}, other team (${vc.team}), helm of ship ${vc.shipId}`)

// bo creates his own ship on his team.
await press(b, `.ro-team [data-ro="create"][data-team="${va.team}"]`)
vb = await until(b, (v) => v.role === "helm" && v.shipId !== va.shipId)
check(vb.role === "helm" && vb.shipId !== va.shipId, `create ship: bo helms ship ${vb.shipId}`)
await pin(b, false)

// bo joins cy's ship on the other team (teams 2-1 -> 1-2 stays balanced).
await press(b, `[data-ro="join"][data-ship="${vc.shipId}"]`)
vb = await until(b, (v) => v.shipId === vc.shipId)
check(vb.shipId === vc.shipId && vb.team === vc.team, `join other ship: bo aboard ${vb.shipId} on team ${vb.team}`)
await b.waitForTimeout(1000)
await shot(b, "roster-joined")
await pin(b, false)

// ada launches from her ship, and lands back aboard (stood in by the recovery a landing sends).
await press(a, ".ro-launch")
va = await until(a, (v) => v.role === "plane")
check(va.role === "plane", `launch: ada is ${va.role}`)
await a.waitForTimeout(600)
await shot(a, "roster-launched")
await pin(a, false)
await a.evaluate(() => (globalThis as unknown as { carrier: { net: { recover(how: string): void } } }).carrier.net.recover("landed"))
va = await until(a, (v) => v.role !== "plane")
check(va.role === "helm" && va.seat === 0, `return: ada back at seat ${va.seat}`)

console.log(logs.length ? `console:\n${logs.slice(0, 30).join("\n")}` : "console: clean")
console.log(failures ? `${failures} FAILED` : "all checks passed")
await browser.close()
process.exit(failures ? 1 : 0)
