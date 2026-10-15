// Capture zones (shared/objective.ts) on a real GPU. Runs ON hailmary (Mac Studio) against the dev room: page A and
// page B join one fresh room on carriers of their own and an autopilot sails each at the live zone (B 40 s later, to
// contest it); page C launches a Hornet for the view from the air. Captures the zone seen from the deck on the way in,
// a capture in progress, the zone from the air and from overhead, contested, the next spot revealed, and the
// scoreboard; then an offline page wins a round (short rules) for the result banner. Frames go through the game's own
// device under the DOM (scripts/ffa-shot.ts).
//
//   ssh hailmary 'cd /tmp/carrier-zones && ~/.bun/bin/bun zones-shot.ts --out=/tmp/carrier-zones/out'
//
// Options: --base=URL  --size=1536x960
import { chromium, type Page } from "playwright-core"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

const args = process.argv.slice(2)
const opt = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const base = opt("base", "https://carrier.lwoyjcaeyxv6.opentunnel.xyz/")
const out = opt("out", "/tmp/carrier-zones/out")
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
  await page.addInitScript(pilotScript)
  await page.goto(url, { waitUntil: "load" })
  await page.waitForFunction(() => !!(globalThis as unknown as { carrier?: { zones?: unknown } }).carrier?.zones, null, { timeout: 60_000 })
  return page
}

type Mark = { id: number; x: number; z: number; r: number; holder: number; cap: number; progress: number; contested: boolean; next: boolean }
type M = { online: string; team: number; role: string; x: number; z: number; zones: Mark[]; obj: string; end: string; phase: string; scores: number[] }
const blank: M = { online: "reloading", team: -1, role: "none", x: 0, z: 0, zones: [], obj: "", end: "", phase: "", scores: [] }
/** A page reloads when another agent's shared/ edit changes the build (the room asks it to): read blank meanwhile. */
const st = (p: Page): Promise<M> =>
  p.evaluate(() => {
    type C = {
      net: { state: string; id: number; crew: { players: { id: number; team: number }[] } | null; objective: { scores: number[] } | null }
      game: { state: { role: string; ship: { x: number; z: number } | null } }
      zones: { marks: Mark[]; local?: { state: { scores: number[] } } | null }
      flight: { flight: { phase: string } }
    }
    const c = (globalThis as unknown as { carrier: C }).carrier
    const me = c.net.crew?.players.find((p) => p.id === c.net.id)
    const txt = (s: string) => ((document.querySelector(s) as HTMLElement | null)?.innerText ?? "").replace(/\s+/g, " ").trim()
    const s = c.game.state.ship
    return {
      online: c.net.state,
      team: me?.team ?? -1,
      role: c.game.state.role,
      x: s?.x ?? 0,
      z: s?.z ?? 0,
      zones: c.zones.marks.map((m) => ({ ...m })),
      obj: txt("#obj"),
      end: txt("#obj-end"),
      phase: c.flight.flight.phase,
      scores: c.net.objective?.scores ?? c.zones.local?.state.scores ?? [],
    }
  }).catch(() => blank)
const live = (m: M) => m.zones.find((z) => !z.next)
const dist = (m: M) => {
  const z = live(m)
  return z ? Math.hypot(z.x - m.x, z.z - m.z) : Infinity
}
const fmt = (m: M) => `${m.online} team ${m.team} ${m.role} at ${m.x.toFixed(0)},${m.z.toFixed(0)} zone ${live(m) ? `${live(m)!.x.toFixed(0)},${live(m)!.z.toFixed(0)} r${(live(m)?.r ?? 0)} holder ${live(m)!.holder} cap ${live(m)!.cap} ${(live(m)?.progress ?? 0).toFixed(2)}` : "-"} d ${dist(m).toFixed(0)} hud "${m.obj}"${m.end ? ` end "${m.end}"` : ""}`
async function until(p: Page, ok: (m: M) => boolean, ms = 15_000): Promise<M> {
  const end = Date.now() + ms
  let m = await st(p)
  while (!ok(m) && Date.now() < end) {
    await p.waitForTimeout(250)
    m = await st(p)
  }
  return m
}

/** The current frame under the DOM, then a page screenshot (retried across a build reload). */
async function shot(page: Page, name: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      return await shotOnce(page, name)
    } catch (e) {
      if (i >= 3) throw e
      console.log(`${name}: retry (${String(e).split("\n")[0]})`)
      await page.waitForFunction(() => !!(globalThis as unknown as { carrier?: { zones?: unknown } }).carrier?.zones, null, { timeout: 60_000 })
      await page.waitForTimeout(2500)
    }
  }
}

async function shotOnce(page: Page, name: string): Promise<void> {
  await page.bringToFront()
  await page.waitForTimeout(250)
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
  console.log(`${name}: ${fmt(await st(page))}`)
}

/**
 * Sails this page's carrier at the live zone: full ahead, rudder toward its centre, slow once well inside. Installed
 * in the page (and again after any reload) once `localStorage["zones.autopilot"]` is set; it sends the orders itself
 * too, so it keeps steering while the page is in the background.
 */
function pilotScript() {
  type Mark = { x: number; z: number; r: number; next: boolean }
  type H = { order: number; rudder: number; update(i: unknown, dt: number): void }
  type C = { game: { state: { helm: H; ship: { x: number; z: number; heading: number } | null } }; zones: { marks: Mark[] }; net: { sendHelm(o: number, r: number): void } }
  const w = globalThis as unknown as { carrier?: C; __pilot?: boolean }
  const install = () => {
    const c = w.carrier
    if (w.__pilot || !c?.zones || localStorage.getItem("zones.autopilot") !== "1") return
    w.__pilot = true
    const h = c.game.state.helm
    const cmd = { order: 1, rudder: 0 }
    const up = h.update.bind(h)
    h.update = (i, dt) => {
      up(i, dt)
      h.order = cmd.order
      h.rudder = cmd.rudder
    }
    setInterval(() => {
      const s = c.game.state.ship
      const z = c.zones.marks.find((m) => !m.next)
      if (!s || !z) return
      const dx = z.x - s.x
      const dz = z.z - s.z
      const e0 = Math.atan2(dx, -dz) - s.heading
      const e = Math.atan2(Math.sin(e0), Math.cos(e0))
      cmd.rudder = Math.max(-1, Math.min(1, e * 2.5))
      cmd.order = Math.hypot(dx, dz) < z.r * 0.45 ? 0.25 : 1
      c.net.sendHelm(cmd.order, cmd.rudder)
    }, 100)
  }
  setInterval(install, 250)
}
const autopilot = (p: Page) => p.evaluate(() => localStorage.setItem("zones.autopilot", "1"))

/** Free camera over (x, z): yaw/pitch in degrees, distance in metres; null returns to the chase camera. */
const freeCam = (p: Page, v: { x: number; z: number; yaw: number; pitch: number; dist: number } | null) =>
  p.evaluate((v) => {
    const c = (globalThis as unknown as { carrier: { game: { state: { free: boolean } }; camera: { set(v: unknown): void } } }).carrier
    c.game.state.free = !!v
    if (v) c.camera.set(v)
  }, v)

/** Page `p`'s jet in level flight at (x, y, z), nose along compass `heading`, at cruise (scripts/ffa-shot.ts). */
const place = (p: Page, x: number, y: number, z: number, heading: number) =>
  p.evaluate(
    ([x, y, z, h]) => {
      type P = Record<string, number | string>
      const c = (globalThis as unknown as { carrier: { flight: { flight: { plane: P; prev: P; cam: { reset(): void } }; input: { override: unknown } } } }).carrier
      const f = c.flight.flight
      const a = (Math.PI - h!) / 2
      Object.assign(f.plane, { x, y, z, qx: 0, qy: Math.sin(a), qz: 0, qw: Math.cos(a), vx: 140 * Math.sin(h!), vy: 0, vz: -140 * Math.cos(h!), p: 0, r: 0, w: 0, throttle: 140 / 182, blend: 1, stall: 0, outside: 0 })
      Object.assign(f.prev, f.plane)
      f.cam.reset()
      c.flight.input.override = { pitch: 0, roll: 0, yaw: 0 }
    },
    [x, y, z, heading],
  )

// ---- online: the dev room ----------------------------------------------------------------------------------------
const room = `zones${Math.floor(Math.random() * 1e6)}`
const a = await open(`${base}?room=${room}&tod=11`, "ADA")
let ma = await until(a, (m) => m.online === "online" && m.role === "helm" && !!live(m), 20_000)
const b = await open(`${base}?room=${room}&tod=11`, "BO")
let mb = await until(b, (m) => m.online === "online" && m.role === "helm", 20_000)
const c = await open(`${base}?room=${room}&tod=11`, "CY")
await until(c, (m) => m.online === "online" && m.role === "helm", 20_000)
console.log(`room ${room}\n${fmt(ma)}\n${fmt(mb)}`)
check(ma.zones.filter((z) => !z.next).length === 1, `three carriers: one zone (${ma.zones.length})`)
check(/MOVE \d+:\d\d/.test(ma.obj) && /TO \d+/.test(ma.obj), `scoreboard: "${ma.obj}"`)
await shot(a, "01-deck-spawn-scoreboard")

await autopilot(a)
const t0 = Date.now()
// Sailing in: the zone ahead from the deck, a kilometre out.
ma = await until(a, (m) => dist(m) < (live(m)?.r ?? 0) + 1100, 240_000)
await shot(a, "02-deck-approach")
await autopilot(b)
console.log(`B sails at ${((Date.now() - t0) / 1000).toFixed(0)} s`)
ma = await until(a, (m) => (live(m)?.cap ?? -1) === m.team && (live(m)?.progress ?? 0) > 0.35 && (live(m)?.progress ?? 0) < 0.8, 240_000)
check(/CAPTURING A/.test(ma.obj), `capture in progress: ${fmt(ma)}`)
await shot(a, "03-deck-capturing")
await freeCam(a, { x: ma.x, z: ma.z, yaw: 200, pitch: 34, dist: 1900 })
await a.waitForTimeout(400)
await shot(a, "04-air-overhead-capturing")
await freeCam(a, null)
ma = await until(a, (m) => live(m)?.holder === m.team, 20_000)
check(live(ma)?.holder === ma.team, "A captured the zone")
await a.waitForTimeout(6000)
ma = await st(a)
check((ma.scores[ma.team] ?? 0) > 5, `A scores while holding: ${ma.scores.join(" ")}`)
await shot(a, "05-deck-holding")

// From the air: C's Hornet 3 km out, 900 m up, heading at the zone.
await c.evaluate(() => (globalThis as unknown as { carrier: { net: { op(id: string): void } } }).carrier.net.op("hornet"))
await until(c, (m) => m.phase === "flying", 30_000)
await c.evaluate(() => ((globalThis as unknown as { carrier: { flight: { flight: { landables: unknown[] } } } }).carrier.flight.flight.landables = []))
const z = live(ma)!
const back = Math.atan2(ma.x - z.x, -(ma.z - z.z)) + 0.6
await place(c, z.x + Math.sin(back) * 3200, 900, z.z - Math.cos(back) * 3200, back + Math.PI)
await c.waitForTimeout(1200)
await shot(c, "06-air-hornet")

// B arrives: contested.
mb = await until(b, (m) => m.zones.some((x) => !x.next && x.contested), 200_000)
check(mb.zones.some((x) => x.contested), `contested: ${fmt(mb)}`)
await shot(b, "07-deck-contested")
await freeCam(b, { x: live(mb)!.x, z: live(mb)!.z, yaw: 30, pitch: 40, dist: 2300 })
await b.waitForTimeout(400)
await shot(b, "08-air-overhead-contested")
await freeCam(b, null)

// The next spot revealed before the opening ends.
ma = await until(a, (m) => m.zones.some((x) => x.next), 330_000)
check(/MOVING IN \d+S/.test(ma.obj), `next spot revealed: "${ma.obj}"`)
const nx = ma.zones.find((x) => x.next)!
const lz = live(ma)!
await freeCam(a, { x: (nx.x + lz.x) / 2, z: (nx.z + lz.z) / 2, yaw: 160, pitch: 48, dist: Math.hypot(nx.x - lz.x, nx.z - lz.z) * 1.15 + 1200 })
await a.waitForTimeout(400)
await shot(a, "09-air-next-spot")
await freeCam(a, null)
await shot(a, "10-deck-moving-countdown")
for (const p of [a, b, c]) await p.close()

// ---- offline: a round won (short rules, the ship placed in the zone) ---------------------------------------------
const o = await open(`${base}?seed=7&tod=11`, "SOLO")
await until(o, (m) => !!live(m) && m.role !== "none", 20_000)
// Short rules through the ZONES tab's path (APPLY restarts the local round), then the ship on its zone.
await o.evaluate(async () => {
  type C = {
    zones: { rules: Record<string, number>; apply(net: unknown, t: number): void; marks: { x: number; z: number; next: boolean }[] }
    game: { state: { ship: { x: number; z: number } | null } }
    net: { seaTime(): number }
  }
  const c = (globalThis as unknown as { carrier: C }).carrier
  Object.assign(c.zones.rules, { target: 60, rate: 10, capture: 3 })
  c.zones.apply(c.net, c.net.seaTime())
  await new Promise((r) => setTimeout(r, 300))
  const z = c.zones.marks.find((x) => !x.next)!
  const s = c.game.state.ship!
  s.x = z.x
  s.z = z.z + 120
})
const mo = await until(o, (m) => !!m.end, 30_000)
check(/WINS/.test(mo.end), `round result: "${mo.end}"`)
await shot(o, "11-round-won")

console.log(logs.length ? `console:\n${logs.slice(0, 30).join("\n")}` : "console: clean")
console.log(failures ? `${failures} FAILED` : "all checks passed")
await browser.close()
process.exit(failures ? 1 : 0)
