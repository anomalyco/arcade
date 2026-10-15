// Carrier against carrier, on a real GPU. Runs ON hailmary (Mac Studio): two pages in one fresh room, each at the helm
// of its own carrier, steering with the real helm keys. They close at full speed; B then stops and turns beam-on while
// A runs it down at 60% (~14 m/s) for a T-bone into B's side, and keeps pushing. B watches from above (free camera),
// A from its chase camera. Captures through each game's own device under the DOM (scripts/ffa-shot.ts), and logs the
// room's bumps, both hulls' health and the gap between the hulls.
//
//   ssh hailmary 'cd /tmp/carrier-collide && ~/.bun/bin/bun collide-shot.ts --out=/tmp/carrier-collide/out'
//
// Options: --base=URL  --size=1536x960
import { chromium, type Page } from "playwright-core"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

const args = process.argv.slice(2)
const opt = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const base = opt("base", "https://carrier.lwoyjcaeyxv6.opentunnel.xyz/")
const out = opt("out", "/tmp/carrier-collide/out")
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
    if (m.type() === "error") logs.push(`${name} ${m.type()}: ${m.text()}`)
  })
  page.on("pageerror", (e) => logs.push(`${name} pageerror: ${e.message}`))
  // Vite's HMR socket would reload the page when another agent edits a file mid-run.
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
  await page.goto(url, { waitUntil: "load" })
  await page.waitForFunction(() => (globalThis as unknown as { carrier?: { game?: { state: { role: string; ship: unknown } } } }).carrier?.game?.state.role === "helm", null, { timeout: 60_000 })
  // Record the room's bumps as they arrive (the game empties the queue every frame).
  await page.evaluate(() => {
    const g = globalThis as unknown as { carrier: { net: { bumps: unknown[] } }; bumpLog: unknown[] }
    g.bumpLog = []
    const q = g.carrier.net.bumps
    const push = q.push.bind(q)
    q.push = (...m: unknown[]) => {
      g.bumpLog.push(...m.map((x) => ({ ...(x as object), at: performance.now() })))
      return push(...m)
    }
  })
  return page
}

type St = { ship: number; other: number; x: number; z: number; h: number; u: number; ox: number; oz: number; oh: number; hp: number; ohp: number; bumps: { k: number }[] }
/** Page state; `target` is the other page's ship (default: the nearest carrier). */
const st = (p: Page, target = -1): Promise<St> =>
  p.evaluate((target) => {
    type C = {
      net: { id: number; crew: { players: { id: number; ship: number }[]; ships: { id: number }[] } | null; ships: Map<number, number[]>; hulls: Map<number, { hp: number }> }
      game: { state: { ship: { x: number; z: number; heading: number; u: number } | null } }
    }
    const g = globalThis as unknown as { carrier: C; bumpLog: { k: number }[] }
    const c = g.carrier
    const me = c.net.crew!.players.find((p) => p.id === c.net.id)!
    const s = c.game.state.ship!
    let other = target
    let best = Infinity
    for (const [id, t] of c.net.ships) {
      if (id === me.ship || target >= 0) continue
      const d = Math.hypot(t[2]! - s.x, t[3]! - s.z)
      if (d < best) {
        best = d
        other = id
      }
    }
    const o = c.net.ships.get(other)!
    return { ship: me.ship, other, x: s.x, z: s.z, h: s.heading, u: s.u, ox: o[2]!, oz: o[3]!, oh: o[4]!, hp: c.net.hulls.get(me.ship)?.hp ?? -1, ohp: c.net.hulls.get(other)?.hp ?? -1, bumps: g.bumpLog }
  }, target)

const fmt = (s: St) => `ship ${s.ship} hp ${s.hp.toFixed(0)} | other ${s.other} hp ${s.ohp.toFixed(0)} | gap ${Math.hypot(s.ox - s.x, s.oz - s.z).toFixed(0)} m | ${(s.u / 0.514444).toFixed(1)} kn | bumps ${s.bumps.map((b) => b.k).join(",")}`

async function shot(page: Page, name: string): Promise<void> {
  const url = await page.evaluate(async () => {
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
  console.log(`${name}: ${fmt(await st(page, page === A ? shipB : page === B ? shipA : -1))}`)
}

const wrap = (a: number) => a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2))
const bearing = (x: number, z: number, tx: number, tz: number) => Math.atan2(tx - x, -(tz - z))

/** Holds A or D (or neither) on page `p` to bring its heading to `want`. */
const rudderKeys = new Map<Page, string>()
async function steer(p: Page, s: St, want: number): Promise<void> {
  const err = wrap(want - s.h)
  const key = err > 0.03 ? "KeyD" : err < -0.03 ? "KeyA" : ""
  const held = rudderKeys.get(p) ?? ""
  if (held === key) return
  if (held) await p.keyboard.up(held)
  if (key) await p.keyboard.down(key)
  rudderKeys.set(p, key)
}

/** B's view: the free camera straight above the middle of the two hulls. */
async function overhead(p: Page, s: St, dist: number): Promise<void> {
  await p.evaluate(
    ([x, z, d, yaw]) => {
      const c = (globalThis as unknown as { carrier: { game: { state: { free: boolean } }; camera: { set(v: object): void } } }).carrier
      c.game.state.free = true
      c.camera.set({ x, z, yaw, pitch: 1.2, dist: d })
    },
    [(s.x + s.ox) / 2, (s.z + s.oz) / 2, dist, s.oh + Math.PI / 2] as const,
  )
}

const room = `CL${Math.random().toString(36).slice(2, 6).toUpperCase()}`
const A = await open(`${base}?room=${room}&weather=clear&tod=15`, "RAM")
const B = await open(`${base}?room=${room}&weather=clear&tod=15`, "SIDE")
console.log(`room ${room}`)
for (const p of [A, B]) {
  await p.mouse.click(vw / 2, vh / 2)
  await p.keyboard.press("Equal")
}

const shipA = (await st(A)).ship
const shipB = (await st(B)).ship
const T0 = Date.now()
let phase = "close"
let bTurn = 0
let impactAt = 0
const shots = new Set<string>()
const once = async (name: string, p: Page) => {
  if (shots.has(name)) return
  shots.add(name)
  await shot(p, name)
}
let lastLog = 0
while (Date.now() - T0 < 360_000) {
  const a = await st(A, shipB)
  const b = await st(B, shipA)
  const gap = Math.hypot(a.ox - a.x, a.oz - a.z)
  if (Date.now() - lastLog > 10_000) {
    lastLog = Date.now()
    console.log(`t ${((Date.now() - T0) / 1000).toFixed(0)} s ${phase}: A ${fmt(a)}`)
  }
  // A runs B down (aims at B's middle); slows to 60% for the last stretch.
  await steer(A, a, bearing(a.x, a.z, a.ox, a.oz))
  if (phase === "close") {
    await steer(B, b, bearing(b.x, b.z, b.ox, b.oz))
    if (gap < 2400) {
      phase = "turn"
      bTurn = Date.now()
      await B.keyboard.press("Digit0")
      await A.keyboard.press("Digit6")
    }
  } else if (phase === "turn") {
    // B swings beam-on to A, coasting to a stop.
    await steer(B, b, wrap(bearing(b.x, b.z, b.ox, b.oz) + Math.PI / 2))
    if (gap < 900) phase = "approach"
  } else if (phase === "approach") {
    await steer(B, b, b.h)
    await overhead(B, b, 700)
    if (gap < 600) await once("1-approach-chase", A)
    if (gap < 450) await once("2-approach-above", B)
    if (b.bumps.length || a.bumps.length) {
      phase = "impact"
      impactAt = Date.now()
      await once("3-impact-above", B)
      await once("3-impact-chase", A)
    }
  } else {
    await overhead(B, b, 700)
    const since = Date.now() - impactAt
    if (since > 2000) await once("4-after-2s-above", B)
    if (since > 2000) await once("4-after-2s-chase", A)
    if (since > 8000) await once("5-pushing-8s-above", B)
    if (since > 8000) await once("5-pushing-8s-chase", A)
    if (since > 9000) break
  }
  void bTurn
  await A.waitForTimeout(100)
}

const a = await st(A, shipB)
const b = await st(B, shipA)
console.log(`end: A ${fmt(a)}`)
console.log(`end: B ${fmt(b)}`)
check(a.bumps.length > 0 && b.bumps.length > 0, `both pages got the room's bump (A ${a.bumps.length}, B ${b.bumps.length})`)
check(b.hp < 800 && b.hp > 550, `B (rammed) took ~20-45% (hp ${b.hp.toFixed(0)})`)
check(a.hp < 1000 && a.hp > b.hp, `A (rammer) took less (hp ${a.hp.toFixed(0)})`)
check(Math.hypot(a.ox - a.x, a.oz - a.z) > 150, `hulls apart, not through each other (centres ${Math.hypot(a.ox - a.x, a.oz - a.z).toFixed(0)} m)`)
for (const l of logs.slice(0, 20)) console.log(l)
await browser.close()
process.exit(failures ? 1 : 0)
