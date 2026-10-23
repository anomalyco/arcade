// Explosion captures on a real GPU. Runs ON hailmary (Mac Studio): Chrome with WebGPU on Metal loads the game offline
// (?seed=7&tod=H) from a dev server and stages jet kills and crashes, capturing the frame through the game's own device
// (as scripts/f35-shot.ts).
//
//   scp scripts/explosion-shot.ts hailmary:/tmp/carrier-explo/ && ssh hailmary 'cd /tmp/carrier-explo && ~/.bun/bin/bun explosion-shot.ts --base=http://localhost:5301/ --out=/tmp/carrier-explo/out/after'
//
// Scenes (--only=air,airfar,sea,land,deck,seq,bench): a bandit (a fake remote jet fed into the flight module's frame, so
// the remote path runs) shot down mid-air seen from 70 m (camera riding with its wreck) and from 300 m (fixed); our own
// Hornet diving into open sea, into an island slope and onto the carrier's deck (the game's crash camera, plus a
// fixed side view for the sea); `seq`: 8-frame sequences of the 300 m kill and the sea crash; `bench`: GPU throughput
// with a big explosion on screen, the explosion passes on against off (alternating pairs). --tod=10.5 (day) or 22.
import { type Page } from "playwright-core"
import { browserBudget } from "../../../scripts/browser-budget"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

await using budget = browserBudget()
const { chromium } = budget

const args = process.argv.slice(2)
const opt = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const base = opt("base", "http://localhost:5301/")
const out = opt("out", "/tmp/carrier-explo/out")
const tod = opt("tod", "10.5")
const only = opt("only", "air,airfar,sea,land,deck").split(",")
const [vw, vh] = opt("size", "1536x1024").split("x").map(Number) as [number, number]
const tag = tod === "10.5" ? "day" : `tod${tod}`
mkdirSync(out, { recursive: true })

const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--enable-features=WebGPU", "--ignore-gpu-blocklist"],
})
const logs: string[] = []

async function open(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 })
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") logs.push(`${m.type()}: ${m.text()}`)
  })
  page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`))
  page.on("crash", () => console.log(`page crashed; last logs:\n${logs.slice(-8).join("\n")}`))
  page.on("close", () => console.log(`page closed; last logs:\n${logs.slice(-8).join("\n")}`))
  browser.on("disconnected", () => console.log("browser disconnected"))
  await page.addInitScript(() => {
    localStorage.setItem("carrier.name", "PILOT")
    const Real = WebSocket
    const Fake = function (this: unknown, url: string | URL, protocols?: string | string[]) {
      const p = Array.isArray(protocols) ? protocols : protocols ? [protocols] : []
      if (p.some((x) => x.startsWith("vite"))) return Object.assign(new EventTarget(), { readyState: 0, send() {}, close() {} })
      return new Real(url, protocols)
    } as unknown as typeof WebSocket
    Object.assign(Fake, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3, prototype: Real.prototype })
    globalThis.WebSocket = Fake
  })
  await page.goto(`${base}?seed=7&tod=${tod}`, { waitUntil: "load" })
  await page.waitForFunction(() => !!(globalThis as { carrier?: { game?: { state: { sea: unknown } } } }).carrier?.game?.state.sea, null, { timeout: 60_000 })
  // Camera hook (`__look`): eye and target, or ride `off` metres from jet `follow`'s falling wreck; applied after both
  // the chase camera and the crash camera. Fake remote (`__fake`): a bandit fed into the flight module's frame.
  await page.evaluate(() => {
    type V = [number, number, number]
    type Cam = { eye: V; forward: V; up: V; fov: number; update(...a: unknown[]): void; crashView(...a: unknown[]): void }
    type Look = { eye?: V; at?: V; follow?: number; off?: V; fov?: number }
    type Fake = { id: number; x0: V; v: V; t0: number; q: [number, number, number, number]; mode: 1 | 2; at: V }
    const g = globalThis as unknown as {
      carrier: { flight: { flight: { cam: Cam }; weapons: { wreckPoses(): Iterable<[number, { x: number; y: number; z: number }]> }; frame(v: Record<string, unknown>): void } }
      __look: Look | null
      __fake: Fake | null
      __lastAt: V
    }
    g.__look = null
    g.__fake = null
    g.__lastAt = [0, 0, 0]
    const fm = g.carrier.flight
    const cam = fm.flight.cam
    const apply = () => {
      const L = g.__look
      if (!L) return
      let at = L.at ?? g.__lastAt
      if (L.follow !== undefined) for (const [id, p] of fm.weapons.wreckPoses()) if (id === L.follow) at = [p.x, p.y, p.z]
      g.__lastAt = at
      const eye: V = L.off ? [at[0] + L.off[0], at[1] + L.off[1], at[2] + L.off[2]] : L.eye!
      const f: V = [at[0] - eye[0], at[1] - eye[1], at[2] - eye[2]]
      const l = Math.hypot(...f)
      cam.eye.splice(0, 3, ...eye)
      cam.forward.splice(0, 3, f[0] / l, f[1] / l, f[2] / l)
      cam.up.splice(0, 3, 0, 1, 0)
      cam.fov = ((L.fov ?? 40) * Math.PI) / 180
    }
    for (const k of ["update", "crashView"] as const) {
      const orig = cam[k].bind(cam)
      cam[k] = (...a: unknown[]) => {
        orig(...a)
        apply()
      }
    }
    const frame = fm.frame.bind(fm)
    fm.frame = (v) => {
      const F = g.__fake
      if (F) {
        const t = v.t as number
        const planes = new Map(v.planes as Map<number, number[]>)
        const dt = t - F.t0
        const p = F.mode === 1 ? [F.x0[0] + F.v[0] * dt, F.x0[1] + F.v[1] * dt, F.x0[2] + F.v[2] * dt] : F.at
        planes.set(F.id, [t, F.mode, p[0]!, p[1]!, p[2]!, ...F.q, ...F.v, 0.8, 0, 0, 0, 0, 0, 0])
        const crew = v.crew as { players: unknown[] } | null
        const player = { id: F.id, name: "BANDIT", team: 1, ship: -5, role: "pilot", plane: 0, mount: -1, sortie: 1, waitSince: 0, since: 0 }
        v = { ...v, planes, crew: crew ? { ...crew, players: [...crew.players, player] } : { seed: 0, made: 0, nextShip: 0, ships: [], players: [player] } }
      }
      frame(v)
    }
  })
  return page
}

const js = <T = unknown>(page: Page, fn: string): Promise<T> =>
  page.evaluate(`(() => { const c = globalThis.carrier; const m = c.flight; const f = m.flight; const w = m.weapons; ${fn} })()`) as Promise<T>

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

/** Frame under the DOM (the HUD, the crash card), then a page screenshot. */
async function shot(page: Page, name: string, t0?: number): Promise<void> {
  const url = await frame(page)
  await page.evaluate((src) => {
    const img = document.createElement("img")
    img.id = "explo-shot-bg"
    img.src = src
    Object.assign(img.style, { position: "fixed", inset: "0", width: "100%", height: "100%", zIndex: "0" })
    const canvas = document.getElementById("view")!
    canvas.style.visibility = "hidden"
    canvas.after(img)
    return new Promise((r) => (img.complete ? r(null) : (img.onload = () => r(null))))
  }, url)
  await page.screenshot({ path: join(out, `${name}.png`) })
  await page.evaluate(() => {
    document.getElementById("explo-shot-bg")?.remove()
    document.getElementById("view")!.style.visibility = ""
  })
  console.log(`shot ${name}${t0 !== undefined ? ` at +${((Date.now() - t0) / 1000).toFixed(2)} s` : ""}`)
}

async function until(page: Page, cond: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await js<boolean>(page, `return !!(${cond})`)) return true
    await page.waitForTimeout(30)
  }
  return false
}

/** Shots at the given seconds after t0 (as close as readback allows). */
async function shots(page: Page, name: string, t0: number, at: number[]): Promise<void> {
  for (let i = 0; i < at.length; i++) {
    const wait = t0 + at[i]! * 1000 - Date.now()
    if (wait > 0) await page.waitForTimeout(wait)
    await shot(page, at.length > 4 ? `${name}-${String(i + 1).padStart(2, "0")}` : `${name}-${String.fromCharCode(97 + i)}`, t0)
  }
}

/** Our jet in free flight at (x, y, z), compass heading h, pitch p (rad, negative dives), at `speed` m/s. */
const warp = (page: Page, x: number, y: number, z: number, h: number, p: number, speed: number) =>
  js(
    page,
    `const P = f.plane
    const h = ${h}, p = ${p}, s = ${speed}
    Object.assign(P, { x: ${x}, y: ${y}, z: ${z}, vx: s * Math.cos(p) * Math.sin(h), vy: s * Math.sin(p), vz: -s * Math.cos(p) * Math.cos(h), p: 0, r: 0, w: 0, throttle: 0.75, crashed: "", blend: 1, stall: 0, outside: 0 })
    const a = (Math.PI - h) / 2, b = -p / 2
    const y1 = [0, Math.sin(a), 0, Math.cos(a)], x1 = [Math.sin(b), 0, 0, Math.cos(b)]
    // y1 * x1
    Object.assign(P, { qx: y1[3] * x1[0], qy: y1[1] * x1[3], qz: -y1[1] * x1[0], qw: y1[3] * x1[3] })
    Object.assign(f.prev, P)
    f.phase = "flying"
    f.airborne = 10
    f.landing = null
    f.noCapture = 30
    f.crashTime = 0
    f.onRespawn = () => {}
    w.sortie("hornet")`,
  )

const terrainAt = (page: Page, x: number, z: number) =>
  page.evaluate(async ([x, z]) => {
    const { terrainHeight } = (await import(["", "shared", "islands.ts"].join("/"))) as { terrainHeight: (a: unknown, x: number, z: number) => number }
    return terrainHeight((globalThis as unknown as { carrier: { flight: { world: { arch: unknown } } } }).carrier.flight.world.arch, x!, z!)
  }, [x, z])

type ShipState = { x: number; z: number; heading: number; u: number; heave: number }
const ship = (page: Page) => js<ShipState>(page, "const s = c.game.state.ship; return { x: s.x, z: s.z, heading: s.heading, u: s.u, heave: s.heave }")

/** An open-sea point about `r` metres from (x, z) with no land within 600 m. */
async function openSea(page: Page, x: number, z: number, r: number): Promise<[number, number]> {
  for (let k = 0; k < 64; k++) {
    const a = k * 2.399
    const px = x + Math.cos(a) * r
    const pz = z + Math.sin(a) * r
    let ok = true
    for (let j = 0; j < 12 && ok; j++) ok = (await terrainAt(page, px + Math.cos(j * 0.52) * 600, pz + Math.sin(j * 0.52) * 600)) < -3
    if (ok && (await terrainAt(page, px, pz)) < -3) return [px, pz]
  }
  return [x + r, z]
}

/** A bandit at `at` flying along +x at 150 m/s; shot down 0.8 s later; returns its kill point and the kill time. */
async function bandit(page: Page, at: [number, number, number]): Promise<{ k: [number, number, number]; t0: number }> {
  await js(page, `const t = c.game.state.ship.t; globalThis.__fake = { id: 900, x0: [${at[0]}, ${at[1]}, ${at[2]}], v: [150, 0, 0], t0: t, q: [0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)], mode: 1, at: [0, 0, 0] }`)
  await until(page, "w.jets.has(900)", 3000)
  await page.waitForTimeout(800)
  const k = await js<[number, number, number]>(
    page,
    `const j = w.jets.get(900)
    w.apply({ k: "kill", on: 900, by: w.id, w: "gun" })
    return [j.x, j.y, j.z]`,
  )
  const t0 = Date.now()
  // The bandit's client now reports it crashed where its wreck is.
  await js(page, `const F = globalThis.__fake; F.mode = 2; F.at = [${k[0]}, ${k[1]}, ${k[2]}]`)
  return { k, t0 }
}

async function launch(page: Page): Promise<void> {
  await page.waitForTimeout(3000)
  await js(page, "c.net.op('hornet')")
  await until(page, "f.phase !== 'idle'", 8000)
  await page.waitForTimeout(500)
}

const page = await open()
await launch(page)
const s0 = await ship(page)
const [ax, az] = await openSea(page, s0.x, s0.z, 2600)
console.log(`open sea at ${ax.toFixed(0)}, ${az.toFixed(0)}`)

/** Parks our jet high and far from the action so it stays out of the shots. */
const park = (x: number, z: number) => warp(page, x - 3000, 2500, z + 3000, Math.PI, 0, 150)

if (only.includes("air")) {
  await park(ax, az)
  await page.waitForTimeout(300)
  await js(page, "globalThis.__look = { follow: 900, off: [-38, 14, 62], fov: 45 }")
  const { k, t0 } = await bandit(page, [ax - 120, 500, az])
  console.log(`air kill at ${k.map((v) => v.toFixed(0)).join(", ")}`)
  await shots(page, `air-close-${tag}`, t0, [0.12, 0.6, 1.6, 3.2])
  await js(page, "globalThis.__fake = null; globalThis.__look = null")
  await page.waitForTimeout(6000)
}

if (only.includes("airfar") || only.includes("seq")) {
  const seq = only.includes("seq")
  await park(ax, az)
  await page.waitForTimeout(300)
  // The kill point: 0.8 s along from the start; the camera 300 m south of 1 s further along, slightly above.
  const kx = ax - 120 + 150 * 0.8 - 18
  await js(page, `globalThis.__look = { eye: [${kx + 120}, 545, ${az + 300}], at: [${kx + 120}, 490, ${az}], fov: 40 }`)
  const { t0 } = await bandit(page, [ax - 120, 500, az])
  await shots(page, `air-far-${tag}`, t0, [0.12, 0.7, 2.0, 7.0])
  if (seq) {
    await js(page, "globalThis.__fake = null")
    await page.waitForTimeout(9000)
    const r = await bandit(page, [ax - 120, 500, az])
    await shots(page, `seq-air-${tag}`, r.t0, [0.05, 0.4, 0.8, 1.2, 1.7, 2.2, 2.6, 3.0])
  }
  await js(page, "globalThis.__fake = null; globalThis.__look = null")
  await page.waitForTimeout(6000)
}

/** Dives our jet into the sea at (x, z): from 1.5 km out at 140 m/s and -12°. Resolves when it hits. */
async function seaDive(x: number, z: number): Promise<number> {
  const d = 700
  const p = -0.2
  await warp(page, x - d, Math.tan(-p) * d + 2, z, Math.PI / 2, p, 140)
  await until(page, "f.phase === 'crashed'", 12000)
  return Date.now()
}

if (only.includes("sea") || only.includes("seq")) {
  // The game's crash camera (the SPLASH card), then a fixed side view.
  let t0 = await seaDive(ax, az + 400)
  console.log(`crash: ${await js<string>(page, "return f.plane.crashed")}`)
  await shots(page, `sea-cam-${tag}`, t0, [0.15, 0.8, 2.0, 4.0])
  if (only.includes("sea")) {
    await js(page, `globalThis.__look = { eye: [${ax + 10}, 30, ${az + 400 + 230}], at: [${ax + 10}, 14, ${az + 400}], fov: 40 }`)
    t0 = await seaDive(ax, az + 400)
    await shots(page, `sea-side-${tag}`, t0, [0.15, 0.8, 2.0, 5.0])
  }
  if (only.includes("seq")) {
    await js(page, `globalThis.__look = { eye: [${ax + 10}, 30, ${az + 400 + 230}], at: [${ax + 10}, 14, ${az + 400}], fov: 40 }`)
    t0 = await seaDive(ax, az + 400)
    await shots(page, `seq-sea-${tag}`, t0, [0.05, 0.4, 0.8, 1.2, 1.7, 2.2, 2.6, 3.0])
  }
  await js(page, "globalThis.__look = null")
}

if (only.includes("land")) {
  // The centrepiece island's slope, approached from the west.
  const target = await page.evaluate(async () => {
    const { terrainHeight } = (await import(["", "shared", "islands.ts"].join("/"))) as { terrainHeight: (a: unknown, x: number, z: number) => number }
    const c = (globalThis as unknown as { carrier: { flight: { world: { arch: { islands: { x: number; z: number; radius: number }[] } } } } }).carrier
    const arch = c.flight.world.arch
    let best = { x: 0, z: 0, h: -1e9 }
    for (const i of arch.islands.slice(0, 12))
      for (let k = 0; k < 24; k++) {
        const x = i.x - i.radius * (0.3 + 0.03 * k)
        const z = i.z
        const h = terrainHeight(arch, x, z)
        // A low, bare shore (beaches and rock below the treeline), open sea to the west.
        if (h > 2 && h < 9 && terrainHeight(arch, x - 400, z) < 0 && terrainHeight(arch, x - 150, z) < 0) return { x, z, h }
        if (h > best.h) best = { x, z, h }
      }
    return best
  })
  console.log(`land target ${target.x.toFixed(0)}, ${target.z.toFixed(0)} at ${target.h.toFixed(0)} m`)
  const d = 800
  const p = -0.22
  await warp(page, target.x - d, target.h + Math.tan(-p) * d, target.z, Math.PI / 2, p, 140)
  await until(page, "f.phase === 'crashed'", 12000)
  const t0 = Date.now()
  console.log(`crash: ${await js<string>(page, "return f.plane.crashed")}`)
  await shots(page, `land-cam-${tag}`, t0, [0.15, 0.8, 2.0, 4.0])
  const e = await js<number[]>(page, "return [...f.cam.eye, f.plane.x, f.plane.y, f.plane.z]")
  console.log(`crash cam eye ${e.slice(0, 3).map((v) => v.toFixed(0)).join(", ")} (terrain ${(await terrainAt(page, e[0]!, e[2]!)).toFixed(0)}), wreck ${e.slice(3).map((v) => v.toFixed(0)).join(", ")}`)
  // And a fixed view from the sea side, 260 m out and 60 m up.
  await js(page, `globalThis.__look = { eye: [${target.x - 240}, ${target.h + 45}, ${target.z + 140}], at: [${target.x + 20}, ${target.h + 12}, ${target.z}], fov: 40 }`)
  await warp(page, target.x - d, target.h + Math.tan(-p) * d, target.z, Math.PI / 2, p, 140)
  await until(page, "f.phase === 'crashed'", 12000)
  await shots(page, `land-side-${tag}`, Date.now(), [0.15, 0.8, 2.0, 5.0])
  await js(page, "globalThis.__look = null")
}

if (only.includes("deck")) {
  const s = await ship(page)
  const F = [Math.sin(s.heading), -Math.cos(s.heading)]
  const L = [-Math.cos(s.heading), -Math.sin(s.heading)]
  // The deck amidships (20 m forward of the middle, on the centreline), led by the ship's way during the dive.
  const tFly = 2.4
  const dx = s.x + F[0]! * (20 + s.u * tFly)
  const dz = s.z + F[1]! * (20 + s.u * tFly)
  const deckY = s.heave + 26
  const dist = 140 * tFly * Math.cos(0.4)
  // From the port side, 23° down.
  const sx = dx + L[0]! * dist
  const sz = dz + L[1]! * dist
  const h = Math.atan2(dx - sx, -(dz - sz))
  await warp(page, sx, deckY + Math.tan(0.4) * dist, sz, h, -0.4, 140)
  await until(page, "f.phase === 'crashed'", 12000)
  const t0 = Date.now()
  console.log(`crash: ${await js<string>(page, "return f.plane.crashed")}`)
  await shots(page, `deck-cam-${tag}`, t0, [0.15, 0.8, 2.0, 4.0])
  // Again, seen from 150 m off the side opposite the island, riding along with the ship.
  await page.waitForTimeout(3000)
  const s2 = await ship(page)
  const F2 = [Math.sin(s2.heading), -Math.cos(s2.heading)]
  const L2 = [-Math.cos(s2.heading), -Math.sin(s2.heading)]
  const ex = s2.x + F2[0]! * (20 + s2.u * tFly)
  const ez = s2.z + F2[1]! * (20 + s2.u * tFly)
  await js(page, `globalThis.__look = { eye: [${ex + L2[0]! * 150}, ${s2.heave + 75}, ${ez + L2[1]! * 150}], at: [${ex}, ${s2.heave + 32}, ${ez}], fov: 40 }`)
  const dy2 = s2.heave + 26
  const sx2 = ex + L2[0]! * dist
  const sz2 = ez + L2[1]! * dist
  await warp(page, sx2, dy2 + Math.tan(0.4) * dist, sz2, Math.atan2(ex - sx2, -(ez - sz2)), -0.4, 140)
  await until(page, "f.phase === 'crashed'", 12000)
  console.log(`crash: ${await js<string>(page, "return f.plane.crashed")}`)
  await shots(page, `deck-side-${tag}`, Date.now(), [0.15, 0.8, 2.5, 5.0])
  await js(page, "globalThis.__look = null")
}

if (only.includes("bench")) {
  // A big explosion on screen: the 70 m kill view, 0.5 s in. Then the renderer re-draws that frame flat out, with the
  // explosion passes on and off in alternating pairs (scripts/ocean-shot.ts --bench method).
  await park(ax, az)
  await page.waitForTimeout(300)
  await js(page, "globalThis.__look = { follow: 900, off: [-38, 14, 62], fov: 45 }")
  await bandit(page, [ax - 120, 500, az])
  // Two more big bursts beside it: the worst case of a busy furball.
  await js(page, `const b = m.boom; b.blast(11, ${ax}, 520, ${az + 40}, 1.2, "air"); b.blast(12, ${ax + 40}, 480, ${az - 30}, 1.2, "air")`)
  await page.waitForTimeout(500)
  const res = await page.evaluate(async () => {
    type P = { draw(p: GPURenderPassEncoder): void }
    const c = (globalThis as unknown as { carrier: { renderer: { draw(f: Float32Array, g: unknown): void; context: { device: GPUDevice }; passes?: Record<string, P[]> }; frame: Float32Array; grade: unknown; flight: { boom?: { passes: P[] } } } }).carrier
    const r = c.renderer
    const dev = r.context.device
    const passes: P[] = c.flight.boom?.passes ?? []
    const draws = passes.map((p) => p.draw)
    const set = (on: boolean) => passes.forEach((p, i) => (p.draw = on ? draws[i]! : () => {}))
    // Stop the game loop so the frame stays put.
    const raf = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = () => 0
    await new Promise((res) => setTimeout(res, 100))
    const run = async (n: number) => {
      await dev.queue.onSubmittedWorkDone()
      const t = performance.now()
      for (let i = 0; i < n; i++) {
        r.draw(c.frame, c.grade)
        if (i % 20 === 19) await dev.queue.onSubmittedWorkDone()
      }
      await dev.queue.onSubmittedWorkDone()
      return (performance.now() - t) / n
    }
    await run(30)
    const on: number[] = []
    const off: number[] = []
    for (let k = 0; k < 7; k++) {
      set(true)
      on.push(await run(60))
      set(false)
      off.push(await run(60))
    }
    set(true)
    globalThis.requestAnimationFrame = raf
    const fx = (c.flight.boom as unknown as { fx: Record<string, number> }).fx
    return { on, off, passes: passes.length, counts: `puffs ${fx.puffs} pieces ${fx.pieces} sprites ${fx.sprites} smoke ${fx.smokes}` }
  })
  const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1]!
  console.log(`bench scene: ${res.counts}`)
  console.log(`bench (${res.passes} passes): on ${res.on.map((v) => v.toFixed(3)).join(" ")} | off ${res.off.map((v) => v.toFixed(3)).join(" ")}`)
  console.log(`bench median: on ${med(res.on).toFixed(3)} ms, off ${med(res.off).toFixed(3)} ms, delta ${(med(res.on) - med(res.off)).toFixed(3)} ms`)
}

console.log([...new Set(logs)].slice(0, 12).join("\n"))
await browser.close()
