// Driving captures on a real GPU. Runs ON hailmary (Mac Studio): Chrome with WebGPU on Metal, loading the live dev
// server, pressing the helm keys and capturing the chase view through the game's own device.
//
//   ssh hailmary 'cd /tmp/carrier-ocean && ~/.bun/bin/bun drive-shot.ts --out=/tmp/carrier-drive/out'
//
// Options: --base=URL  --seed=7  --size=1536x1024  --only=start,accel,turn,swell,island,waterline  --mp (two pages in
//          one room, each capturing the other's carrier)  --eval='js' (run in the page after load)
import { type Page } from "playwright-core"
import { browserBudget } from "../../../scripts/browser-budget"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

await using budget = browserBudget()
const { chromium } = budget

const args = process.argv.slice(2)
const opt = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const base = opt("base", "https://carrier.lwoyjcaeyxv6.opentunnel.xyz/")
const out = opt("out", "/tmp/carrier-drive/out")
const seed = opt("seed", "7")
const evalJs = opt("eval", "")
const only = opt("only", "start,accel,turn,orbit,swell,island,waterline").split(",")
const mp = args.includes("--mp")
const [vw, vh] = opt("size", "1536x1024").split("x").map(Number) as [number, number]
mkdirSync(out, { recursive: true })

const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--enable-features=WebGPU", "--ignore-gpu-blocklist"],
})
const logs: string[] = []

async function open(url: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 })
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") logs.push(`${m.type()}: ${m.text()}`)
  })
  page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`))
  // Other agents edit files on the shared dev server all the time: an HMR full reload mid-run would reset the ship.
  // Vite's HMR socket uses the "vite-hmr" subprotocol; give it a socket that never opens (the game's own has none).
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
  await page.waitForFunction(() => !!(globalThis as unknown as { carrier?: { game?: { state: { ship: unknown } } } }).carrier?.game?.state.ship, null, { timeout: 30_000 })
  if (evalJs) await page.evaluate(evalJs)
  return page
}

/** Grabs the next swapchain texture through the game's own device and returns PNG bytes (as scripts/ocean-shot.ts). */
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
    // The HUD is DOM: draw its text on top so captures show what the player sees.
    const cv = new OffscreenCanvas(w, h)
    const g = cv.getContext("2d")!
    g.putImageData(img, 0, 0)
    g.fillStyle = "#f4f7fb"
    g.font = "300 15px 'IBM Plex Mono', monospace"
    g.textAlign = "right"
    const helm = document.querySelector("#br") as HTMLElement | null
    if (helm && !helm.hidden) {
      const rows = [...helm.querySelectorAll(".helm-row")].map((r) => (r as HTMLElement).innerText.replace(/\s+/g, "  "))
      g.font = "300 21px 'IBM Plex Mono', monospace"
      g.fillText(rows[0] ?? "", w - 28, h - 56)
      g.font = "300 12px 'IBM Plex Mono', monospace"
      g.fillText(rows[1] ?? "", w - 28, h - 28)
    }
    g.textAlign = "left"
    g.font = "300 17px 'IBM Plex Mono', monospace"
    g.fillText("C A R R I E R", 22, 36)
    const blob = await cv.convertToBlob({ type: "image/png" })
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let bin = ""
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(bin)
  })
  return Buffer.from(b64, "base64")
}

type ShipState = { x: number; z: number; heading: number; u: number; heave: number; pitch: number; roll: number; power: number; order: number; ground: number; slam: number; t: number }
const shipOf = (page: Page) => page.evaluate(() => ({ ...(globalThis as unknown as { carrier: { game: { state: { ship: ShipState } } } }).carrier.game.state.ship }))
const fmt = (s: ShipState) =>
  `t ${s.t.toFixed(1)} pos ${s.x.toFixed(0)},${s.z.toFixed(0)} hdg ${((s.heading * 180) / Math.PI).toFixed(0)}° ${(s.u / 0.5144).toFixed(1)} kn order ${(s.order * 100).toFixed(0)}% power ${(s.power * 100).toFixed(0)}% heave ${s.heave.toFixed(2)} pitch ${((s.pitch * 180) / Math.PI).toFixed(2)}° roll ${((s.roll * 180) / Math.PI).toFixed(2)}° ground ${s.ground.toFixed(2)} slam ${s.slam.toFixed(2)}`

async function shot(page: Page, name: string): Promise<void> {
  writeFileSync(join(out, `${name}.png`), await grab(page))
  console.log(`${name}: ${fmt(await shipOf(page))}`)
}

/** Overwrites fields of the player's ship (a test warp: skips the minute it takes to work up speed). */
const warp = (page: Page, s: Partial<ShipState>) =>
  page.evaluate((s) => {
    const g = (globalThis as unknown as { carrier: { game: { state: { ship: Record<string, number> } } } }).carrier.game
    Object.assign(g.state.ship, s)
  }, s)

const adapter = async (page: Page) =>
  page.evaluate(async () => {
    const a = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" })
    return a ? `${a.info.vendor} / ${a.info.architecture} / ${a.info.description}` : "no adapter"
  })

if (!mp) {
  const page = await open(`${base}?seed=${seed}`)
  const info = await adapter(page)
  console.log(`adapter: ${info}`)
  if (/swiftshader/i.test(info)) {
    console.log("SwiftShader adapter: refusing to trust these captures")
    await budget.exit(2)
  }
  await page.waitForTimeout(2500)
  if (only.includes("start")) await shot(page, "01-start")
  if (only.includes("accel")) {
    // Ten taps of W: full ahead in detents.
    for (let i = 0; i < 10; i++) await page.keyboard.press("w", { delay: 30 })
    await page.waitForTimeout(4000)
    await shot(page, "02-accel-4s")
    await page.waitForTimeout(8000)
    await shot(page, "02-accel-12s")
    for (let i = 0; i < 4; i++) {
      await page.waitForTimeout(250)
      await shot(page, `02-bob-${i}`)
    }
  }
  if (only.includes("turn")) {
    await page.keyboard.press("Equal")
    await page.keyboard.down("d")
    await page.waitForTimeout(6000)
    await shot(page, "03-turn-6s")
    await page.waitForTimeout(10_000)
    await shot(page, "03-turn-16s")
    await page.keyboard.up("d")
  }
  if (only.includes("orbit")) {
    // Drag the camera round to the side: it must pivot on the ship's centre.
    await page.mouse.move(vw / 2, vh / 2)
    await page.mouse.down()
    for (let i = 0; i < 20; i++) await page.mouse.move(vw / 2 + i * 16, vh / 2 - i * 2)
    await page.mouse.up()
    await page.waitForTimeout(300)
    await shot(page, "07-orbit-side")
    await page.mouse.down()
    for (let i = 0; i < 20; i++) await page.mouse.move(vw / 2 + 320 + i * 16, vh / 2 - 40)
    await page.mouse.up()
    await page.waitForTimeout(300)
    await shot(page, "07-orbit-front")
    await page.waitForTimeout(5000)
    await shot(page, "07-orbit-returned")
  }
  if (only.includes("swell")) {
    const into = await page.evaluate(() => {
      const c = globalThis as unknown as { carrier: { game: { state: { sea: { swell: [number, number] } } } } }
      const sw = c.carrier.game.state.sea.swell
      return Math.atan2(-sw[0], sw[1])
    })
    await warp(page, { heading: into, u: 15.4, power: 1, r: 0, v: 0 } as Partial<ShipState>)
    await page.waitForTimeout(6000)
    for (let i = 0; i < 6; i++) {
      await shot(page, `04-swell-${i}`)
      await page.waitForTimeout(500)
    }
  }
  if (only.includes("island")) {
    const isl = await page.evaluate(() => {
      const c = globalThis as unknown as { carrier: { arch: { islands: { x: number; z: number; radius: number }[] } } }
      const i = c.carrier.arch.islands[0]!
      return { x: i.x, z: i.z, r: i.radius }
    })
    // Start 1.4 radii out on the spawn side, heading straight at it at 15 kn.
    const dx = 0 - isl.x
    const dz = 0 - isl.z
    const d = Math.hypot(dx, dz)
    const x = isl.x + (dx / d) * (isl.r * 1.6 + 400)
    const z = isl.z + (dz / d) * (isl.r * 1.6 + 400)
    await warp(page, { x, z, heading: Math.atan2(isl.x - x, -(isl.z - z)), u: 8, power: 1, r: 0, v: 0 } as Partial<ShipState>)
    await page.keyboard.press("Equal")
    await page.waitForTimeout(2000)
    await shot(page, "05-island-approach")
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(1000)
      const s = await shipOf(page)
      if (s.ground > 0.05) break
    }
    await shot(page, "05-island-aground")
    await page.waitForTimeout(3000)
    await shot(page, "05-island-aground-3s")
  }
  if (only.includes("waterline")) {
    await warp(page, { x: 0, z: 0, u: 6, power: 0.4, r: 0, v: 0 } as Partial<ShipState>)
    await page.keyboard.press("4")
    await page.waitForTimeout(3000)
    // Low free camera beside the hull, to judge the waterline.
    await page.evaluate(() => {
      const c = globalThis as unknown as { carrier: { game: { state: { free: boolean; ship: { x: number; z: number; heading: number } } }; camera: { set(v: object): void } } }
      const s = c.carrier.game.state.ship
      c.carrier.game.state.free = true
      c.carrier.camera.set({ x: s.x, z: s.z, yaw: s.heading + Math.PI / 2 - 0.5, pitch: (9 * Math.PI) / 180, dist: 420 })
    })
    for (let i = 0; i < 3; i++) {
      await shot(page, `06-waterline-${i}`)
      await page.waitForTimeout(700)
    }
  }
} else {
  const room = `drive-${Math.floor(Math.random() * 1e6)}`
  const a = await open(`${base}?room=${room}`)
  const b = await open(`${base}?room=${room}`)
  console.log(`adapter: ${await adapter(a)} room ${room}`)
  await a.waitForTimeout(2000)
  // B moves its ship 900 m to the side of A and both orbit their camera toward the other.
  const sa = await shipOf(a)
  await warp(b, { x: sa.x + Math.cos(sa.heading) * 700, z: sa.z + Math.sin(sa.heading) * 700 })
  await a.keyboard.press("5")
  await b.keyboard.press("3")
  await a.waitForTimeout(4000)
  for (const [p, name, other] of [
    [a, "a", b],
    [b, "b", a],
  ] as const) {
    const me = await shipOf(p)
    const them = await shipOf(other)
    await p.evaluate(
      ([me, them]) => {
        const c = globalThis as unknown as { carrier: { game: { state: { free: boolean } }; camera: { set(v: object): void } } }
        c.carrier.game.state.free = true
        const mx = (me.x + them.x) / 2
        const mz = (me.z + them.z) / 2
        c.carrier.camera.set({ x: mx, z: mz, yaw: Math.atan2(them.x - me.x, -(them.z - me.z)) + 1.2, pitch: (14 * Math.PI) / 180, dist: 900 })
      },
      [me, them] as const,
    )
  }
  await a.waitForTimeout(1500)
  const remote = await a.evaluate(() => (globalThis as unknown as { carrier: { net: { ships: Map<number, unknown>; players: number; state: string } } }).carrier.net.ships.size)
  console.log(`A sees ${remote} remote ship(s)`)
  // Same sea time on both pages, then capture both within a few ms of each other, three times.
  for (let i = 0; i < 3; i++) {
    const [pa, pb] = await Promise.all([grab(a), grab(b)])
    writeFileSync(join(out, `mp-a-${i}.png`), pa)
    writeFileSync(join(out, `mp-b-${i}.png`), pb)
    const [ta, tb] = await Promise.all([shipOf(a), shipOf(b)])
    console.log(`mp ${i}: A ${fmt(ta)}\n      B ${fmt(tb)}`)
    // Compare: the remote copy of each ship (floated locally) against the owner's own heave/pitch/roll.
    const [va, vb] = await Promise.all([a, b].map((p) => p.evaluate(() => (globalThis as unknown as { carrier: { game: { remoteStates(): object[] } } }).carrier.game.remoteStates())))
    console.log(`      A's copy of B: ${JSON.stringify(va)}\n      B's copy of A: ${JSON.stringify(vb)}`)
    await a.waitForTimeout(600)
  }
}

console.log([...new Set(logs)].slice(0, 12).join("\n"))
await browser.close()
