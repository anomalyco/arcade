// F-35C captures on a real GPU. Runs ON hailmary (Mac Studio): Chrome with WebGPU on Metal loads the live dev server's
// game, offline (?seed) and in a fresh room, and captures the frame under the DOM (menus, HUD) as scripts/ui-shot.ts.
//
//   ssh hailmary 'cd /tmp/carrier-f35 && ~/.bun/bin/bun f35-shot.ts --out=/tmp/carrier-f35/out'
//
// Steps (--only=solo,mp): solo: DEPLOY with both launch ops, LAUNCH F-35C, the jet on deck, the catapult
// stroke, flying (chase, side, three-quarter), bombs selected (bay open, bombs aboard), a bomb drop, its water spout and
// a ground burst on an island, then an auto-landing (approach, trap). mp: two pages in one room, an F-35C and a Hornet
// flying in formation, each drawn by the other page as a remote with its own model; the menu shows the F-35C in use.
// --only=polish (into <out>/polish/): undersides seen from below, the HUD role line over sea and sky, the F-35C's and
// the Hornet's touchdowns (hooks on the same wires), and weapons.html?f35 on the F-35C model.
import { type Page } from "playwright-core"
import { browserBudget } from "../../../scripts/browser-budget"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

await using budget = browserBudget()
const { chromium } = budget

const args = process.argv.slice(2)
const opt = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const base = opt("base", "https://studio.taila8e7c7.ts.net:5187/arcade/carrier/")
const out = opt("out", "/tmp/carrier-f35/out")
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

async function open(url: string, name: string, harness = false): Promise<Page> {
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
  if (harness) {
    await page.waitForFunction(() => !!(globalThis as { carrier?: { weapons?: unknown } }).carrier?.weapons, null, { timeout: 60_000 })
    return page
  }
  await page.waitForFunction(() => !!(globalThis as { carrier?: { game?: { state: { sea: unknown } } } }).carrier?.game?.state.sea, null, { timeout: 60_000 })
  // Camera hooks for the shots: `__inspect` orbits the flight camera round the jet (yaw from the nose, pitch up,
  // distance, in the jet's frame); `__look` puts it at `eye` looking at `at`.
  await page.evaluate(() => {
    type V = [number, number, number]
    type Cam = { eye: V; forward: V; up: V; fov: number; update(p: { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number }, ...rest: unknown[]): void }
    const g = globalThis as unknown as { carrier: { flight: { flight: { cam: Cam } } }; __inspect: { yaw: number; pitch: number; dist: number } | null; __look: { eye: V; at: V } | null }
    g.__inspect = null
    g.__look = null
    const cam = g.carrier.flight.flight.cam
    const orig = cam.update.bind(cam)
    cam.update = (p, ...rest) => {
      orig(p, ...rest)
      const set = (eye: V, at: V, up: V) => {
        const f: V = [at[0] - eye[0], at[1] - eye[1], at[2] - eye[2]]
        const l = Math.hypot(...f)
        cam.eye.splice(0, 3, ...eye)
        cam.forward.splice(0, 3, f[0] / l, f[1] / l, f[2] / l)
        cam.up.splice(0, 3, ...up)
        cam.fov = (40 * Math.PI) / 180
      }
      if (g.__look) return set(g.__look.eye, g.__look.at, [0, 1, 0])
      const d = g.__inspect
      if (!d) return
      const { qx, qy, qz, qw } = p
      const rot = (x: number, y: number, z: number): V => {
        const tx = 2 * (qy * z - qz * y)
        const ty = 2 * (qz * x - qx * z)
        const tz = 2 * (qx * y - qy * x)
        return [x + qw * tx + (qy * tz - qz * ty), y + qw * ty + (qz * tx - qx * tz), z + qw * tz + (qx * ty - qy * tx)]
      }
      const o = rot(Math.sin(d.yaw) * Math.cos(d.pitch) * d.dist, Math.sin(d.pitch) * d.dist, Math.cos(d.yaw) * Math.cos(d.pitch) * d.dist)
      set([p.x + o[0], p.y + o[1], p.z + o[2]], [p.x, p.y, p.z], rot(0, 1, 0))
    }
  })
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

/** Frame under the DOM (menus, HUD), then a page screenshot. */
async function shot(page: Page, name: string): Promise<void> {
  const url = await frame(page)
  await page.evaluate((src) => {
    const img = document.createElement("img")
    img.id = "f35-shot-bg"
    img.src = src
    Object.assign(img.style, { position: "fixed", inset: "0", width: "100%", height: "100%", zIndex: "0" })
    const canvas = document.getElementById("view")!
    canvas.style.visibility = "hidden"
    canvas.after(img)
    return new Promise((r) => (img.complete ? r(null) : (img.onload = () => r(null))))
  }, url)
  await page.screenshot({ path: join(out, `${name}.png`) })
  await page.evaluate(() => {
    document.getElementById("f35-shot-bg")?.remove()
    document.getElementById("view")!.style.visibility = ""
  })
  const s = await js<string>(page, "return `${f.vehicle} ${f.phase} ${Math.round(c.flight.status.speed)} m/s y ${Math.round(f.plane.y)} doors ${w.doors.toFixed(2)} bombs ${w.loadout.bombs}`").catch(() => "")
  console.log(`shot ${name}: ${s}`)
}

const inspect = (page: Page, v: { yaw: number; pitch: number; dist: number } | null) => js(page, `globalThis.__inspect = ${JSON.stringify(v)}`)

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

/** Where a point `behind` m behind the stern and `up` m above the sea is, and the ship's heading and speed. */
const sternPoint = (page: Page, behind: number, side = 0) =>
  js<{ x: number; z: number; h: number; u: number }>(
    page,
    `const s = c.game.state.ship ?? c.flight.ctx?.deck?.()
    const fz = -165 - ${behind}, fx = 15.2 + ${side}
    const F = [Math.sin(s.heading), -Math.cos(s.heading)], L = [-Math.cos(s.heading), -Math.sin(s.heading)]
    return { x: s.x + F[0] * fz + L[0] * fx, z: s.z + F[1] * fz + L[1] * fx, h: s.heading, u: s.u }`,
  )

async function until(page: Page, cond: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await js<boolean>(page, `return !!(${cond})`)) return true
    await page.waitForTimeout(50)
  }
  return false
}

async function solo(): Promise<void> {
  const page = await open(`${base}?seed=7&tod=${tod}`, "solo")
  await page.waitForTimeout(4000)
  // DEPLOY: helm, Hornets and the F-35C.
  await js(page, "c.ops.pin(true)")
  await page.waitForTimeout(400)
  check(await page.evaluate(() => document.querySelector(".om")?.textContent?.includes("LAUNCH F-35C") ?? false), "the ops menu lists LAUNCH F-35C")
  await shot(page, "01-ops-menu")
  await js(page, "c.ops.pin(false); c.net.op('f35')")
  check(await until(page, "f.phase !== 'idle' && f.vehicle === 'f35'", 5000), "LAUNCH F-35C starts an F-35C sortie")
  // Hold it on the catapult for the deck shots: keep restarting the hold (engines at idle, on the shuttle).
  await until(page, "f.launch && f.launch.phase === 'ready'", 4000)
  await js(page, "globalThis.__hold = setInterval(() => { if (f.launch && f.launch.phase === 'ready') f.launch.time = 0 }, 10)")
  await page.waitForTimeout(600)
  await shot(page, "02-deck-chase")
  await inspect(page, { yaw: 2.2, pitch: 0.28, dist: 28 })
  await shot(page, "03-deck-side")
  await inspect(page, { yaw: 0.6, pitch: 0.12, dist: 22 })
  await shot(page, "03b-deck-front")
  // The catapult: parked, then the stroke.
  await inspect(page, null)
  await js(page, "clearInterval(globalThis.__hold)")
  await until(page, "f.launch && f.launch.phase === 'stroke'", 6000)
  await page.waitForTimeout(700)
  await inspect(page, { yaw: 2.0, pitch: 0.2, dist: 34 })
  await shot(page, "04-catapult")
  await inspect(page, null)
  check(await until(page, "f.phase === 'flying'", 6000), "the F-35C leaves the catapult")
  await page.waitForTimeout(3500)
  await shot(page, "05-climb-out-chase")
  // Level at 500 m over open sea.
  const s0 = await sternPoint(page, -1800, 900)
  await warp(page, s0.x, 500, s0.z, s0.h + 0.6, 150)
  await page.waitForTimeout(1500)
  await shot(page, "06-flying-chase")
  await inspect(page, { yaw: Math.PI / 2, pitch: 0.05, dist: 24 })
  await shot(page, "07-flying-side")
  await inspect(page, { yaw: 0.8, pitch: 0.25, dist: 24 })
  await shot(page, "08-flying-front34")
  // Bombs: the bay opens.
  await js(page, "w.loadout.slot = 1")
  check(await until(page, "w.doors >= 1", 2000), "selecting bombs opens the bay doors")
  await inspect(page, { yaw: 2.4, pitch: -0.42, dist: 20 })
  await shot(page, "09-bay-open")
  await inspect(page, { yaw: Math.PI / 2, pitch: -0.18, dist: 18 })
  await shot(page, "09b-bay-open-side")
  // A bomb from 160 m over the sea: the first bay bomb leaves its station.
  const s1 = await sternPoint(page, -2400, 1200)
  await warp(page, s1.x, 160, s1.z, s1.h + 0.6, 140)
  await page.waitForTimeout(800)
  await js(page, "w.input.trigger = true")
  await page.waitForTimeout(120)
  await js(page, "w.input.trigger = false")
  check(await until(page, "w.loadout.bombs === w.loadout.spec.bombs - 1", 1500), "the trigger drops a bomb")
  await inspect(page, { yaw: 2.0, pitch: -0.3, dist: 26 })
  await page.waitForTimeout(250)
  await shot(page, "10-bomb-drop")
  await bombImpact(page, "11-bomb-spout")
  // A ground burst: the wing bombs after the bay, aimed onto the centrepiece island's slope (the release point is the
  // fall time ahead of the target at 140 m/s, 200 m above the ground there).
  const aim = await page.evaluate(async () => {
    const { terrainHeight } = (await import(["", "shared", "islands.ts"].join("/"))) as { terrainHeight: (a: unknown, x: number, z: number) => number }
    const c = (globalThis as unknown as { carrier: { arch: { islands: { x: number; z: number; radius: number }[] } } }).carrier
    const i = c.arch.islands[0]!
    const tx = i.x
    const tz = i.z + i.radius * 0.7
    const ground = terrainHeight(c.arch, tx, tz)
    const fall = Math.sqrt((2 * 220) / 9.81)
    return { x: tx - 140 * fall, y: ground + 220, z: tz, ground }
  })
  console.log(`ground burst target: ${aim.ground.toFixed(0)} m terrain`)
  await warp(page, aim.x, aim.y, aim.z, Math.PI / 2, 140)
  await js(page, "w.loadout.bombs = 2; w.loadout.launchIn = 0")
  await page.waitForTimeout(150)
  await js(page, "w.input.trigger = true")
  await page.waitForTimeout(100)
  await js(page, "w.input.trigger = false")
  await inspect(page, { yaw: 2.2, pitch: -0.25, dist: 26 })
  await page.waitForTimeout(300)
  await shot(page, "12-wing-bomb-drop")
  // Then climb clear of the island (the camera watches the bomb, not the jet).
  await warp(page, aim.x + 2500, 1200, aim.z + 1500, Math.PI / 2, 140)
  await bombImpact(page, "13-bomb-ground")
  await inspect(page, null)
  await js(page, "w.loadout.slot = 0")
  // Landing: near the carrier the HUD offers R LAND; R flies the scripted landing and the hook traps it.
  const s2 = await sternPoint(page, 1400, 20)
  await warp(page, s2.x, 26 + 90, s2.z, s2.h, 120 + s2.u)
  await page.waitForTimeout(300)
  await page.keyboard.press("KeyR")
  check(await until(page, "f.phase === 'landing'", 3000), "R lands the F-35C")
  await page.waitForTimeout(3500)
  await shot(page, "14-landing-approach")
  await until(page, "f.landing && f.landing.z > -175", 30000)
  await inspect(page, { yaw: 2.3, pitch: 0.12, dist: 30 })
  await page.waitForTimeout(250)
  await shot(page, "15-landing-hook")
  await until(page, "f.landing && f.landing.phase !== 'approach'", 10000)
  await page.waitForTimeout(500)
  await inspect(page, { yaw: 1.4, pitch: 0.35, dist: 34 })
  await shot(page, "16-landing-trap")
  check(await until(page, "f.phase === 'idle' || (f.landing && f.landing.phase === 'done')", 15000), "the F-35C lands aboard")
  await inspect(page, null)
  await page.close()
}

/** Terrain height (m, the sea level at least) at (x, z). */
const terrainAt = (page: Page, x: number, z: number) =>
  page.evaluate(async ([x, z]) => {
    const { terrainHeight } = (await import(["", "shared", "islands.ts"].join("/"))) as { terrainHeight: (a: unknown, x: number, z: number) => number }
    return Math.max(0, terrainHeight((globalThis as unknown as { carrier: { arch: unknown } }).carrier.arch, x!, z!))
  }, [x, z])

/** Follows the newest bomb down and captures its burst from 260 m off, at the moment and 1 s and 2.5 s later. */
async function bombImpact(page: Page, name: string): Promise<void> {
  type B = { x: number; y: number; z: number; vx: number; vz: number; alive: boolean } | null
  const bomb = () => js<B>(page, "const m = [...w.world.missiles].filter((m) => m.kind === 'bomb').pop(); return m ? { x: m.x, y: m.y, z: m.z, vx: m.vx, vz: m.vz, alive: m.alive } : null")
  let last = await bomb()
  let placed = false
  // The sun's plan direction (Frame sunDir), and the ground under the bomb's path.
  const sun = await js<{ x: number; z: number }>(page, "const l = Math.hypot(c.frame[20], c.frame[22]) || 1; return { x: c.frame[20] / l, z: c.frame[22] / l }")
  const ground = last ? await terrainAt(page, last.x + last.vx * 5, last.z + last.vz * 5) : 0
  const end = Date.now() + 15000
  while (Date.now() < end) {
    const b = await bomb()
    if (!b || !b.alive) break
    last = b
    if (!placed && b.y < ground + 90) {
      // Where it will land (about 1.2 s of travel ahead), seen from 280 m off with the sun behind the camera.
      const ix = b.x + b.vx * 1.2
      const iz = b.z + b.vz * 1.2
      const ex = ix - sun.x * 300
      const ez = iz - sun.z * 300
      const eyeY = Math.max(ground + 45, (await terrainAt(page, ex, ez)) + 60)
      await js(page, `globalThis.__look = { eye: [${ex}, ${eyeY}, ${ez}], at: [${ix}, ${ground + 20}, ${iz}] }`)
      placed = true
    }
    await page.waitForTimeout(30)
  }
  check(!!last, `${name}: the bomb burst`)
  if (last) {
    const ex = last.x - sun.x * 300
    const ez = last.z - sun.z * 300
    const eyeY = Math.max(last.y + 40, (await terrainAt(page, ex, ez)) + 60)
    await js(page, `globalThis.__look = { eye: [${ex}, ${eyeY}, ${ez}], at: [${last.x}, ${last.y + 22}, ${last.z}] }`)
  }
  await page.waitForTimeout(250)
  await shot(page, `${name}-a`)
  await page.waitForTimeout(700)
  await shot(page, `${name}-b`)
  await page.waitForTimeout(1300)
  await shot(page, `${name}-c`)
  await js(page, "globalThis.__look = null")
}

async function mp(): Promise<void> {
  const room = `f35${Math.random().toString(36).slice(2, 7)}`
  const a = await open(`${base}?room=${room}&tod=${tod}`, "ada")
  const b = await open(`${base}?room=${room}&tod=${tod}`, "bo")
  await a.waitForTimeout(4000)
  // A (the helm) launches the F-35C; B (a pilot on deck) sees it in use, then launches a Hornet.
  await js(a, "c.net.op('f35')")
  check(await until(a, "f.phase !== 'idle' && f.vehicle === 'f35'", 6000), "A flies an F-35C")
  await until(a, "f.launch && f.launch.phase === 'ready'", 4000)
  await js(a, "globalThis.__hold = setInterval(() => { if (f.launch && f.launch.phase === 'ready') f.launch.time = 0 }, 10)")
  await b.waitForTimeout(1500)
  await js(b, "c.ops.pin(true)")
  await b.waitForTimeout(400)
  await shot(b, "20-mp-ops-f35-in-use")
  await js(b, "c.ops.pin(false)")
  await js(a, "clearInterval(globalThis.__hold)")
  await js(b, "c.net.op('hornet')")
  check(await until(b, "f.phase !== 'idle' && f.vehicle === 'hornet'", 6000), "B flies a Hornet")
  await until(a, "f.phase === 'flying'", 8000)
  await until(b, "f.phase === 'flying'", 8000)
  // Formation at 600 m: B's Hornet leads, A's F-35C on its right wing, both at 150 m/s.
  const s = await sternPoint(b, -1500, 700)
  const h = s.h + 0.4
  const R = [-Math.cos(h), -Math.sin(h)] as const
  const F = [Math.sin(h), -Math.cos(h)] as const
  await warp(b, s.x, 600, s.z, h, 150)
  await warp(a, s.x + R[0] * 28 - F[0] * 18, 603, s.z + R[1] * 28 - F[1] * 18, h, 150)
  await b.waitForTimeout(1200)
  const remote = await js<string>(b, "return [...c.flight.remotes.jets.values()].map((r) => r.pose.kind).join(',')")
  check(remote.includes("f35"), `B draws A's jet as an F-35C (${remote})`)
  const remoteA = await js<string>(a, "return [...c.flight.remotes.jets.values()].map((r) => r.pose.kind).join(',')")
  check(remoteA.includes("hornet"), `A draws B's jet as a Hornet (${remoteA})`)
  await inspect(b, { yaw: 2.6, pitch: 0.18, dist: 60 })
  await shot(b, "22-mp-hornet-and-f35")
  await inspect(b, { yaw: -2.2, pitch: 0.3, dist: 75 })
  await shot(b, "23-mp-hornet-and-f35-b")
  await inspect(a, { yaw: 2.9, pitch: 0.15, dist: 70 })
  await shot(a, "24-mp-from-the-f35")
  await a.close()
  await b.close()
}

/**
 * The review polish: undersides lit by the sea (from below, bay open), the HUD's role line over bright sea and sky, the
 * F-35C and the Hornet touching down at their own points (hooks on the same wires), and weapons.html?f35 on its model.
 */
async function polish(): Promise<void> {
  const page = await open(`${base}?seed=7&tod=${tod}`, "polish")
  await page.waitForTimeout(4000)
  await js(page, "c.net.op('f35')")
  check(await until(page, "f.phase === 'flying'", 12000), "the F-35C flies")
  const s0 = await sternPoint(page, -1800, 900)
  await warp(page, s0.x, 500, s0.z, s0.h + 0.6, 150)
  await js(page, "w.loadout.slot = 1")
  await until(page, "w.doors >= 1", 2000)
  await inspect(page, { yaw: 2.4, pitch: -0.42, dist: 20 })
  await shot(page, "polish/01-underside-bay-open")
  await inspect(page, { yaw: 2.9, pitch: -0.85, dist: 28 })
  await shot(page, "polish/02-underside-from-below")
  await inspect(page, { yaw: 1.2, pitch: -0.2, dist: 24 })
  await shot(page, "polish/03-underside-side")
  await inspect(page, null)
  await js(page, "w.loadout.slot = 0")
  await page.waitForTimeout(900)
  await shot(page, "polish/04-hud-role-line-sea")
  await inspect(page, { yaw: 2.8, pitch: -0.55, dist: 34 })
  await shot(page, "polish/05-hud-role-line-sky")
  await inspect(page, null)
  // Touchdowns: where each jet's centre and hook are when it is put down (ship z).
  const touchdown = async (name: string, hookZ: number) => {
    const s = await sternPoint(page, 1400, 0)
    await warp(page, s.x, 26 + 90, s.z, s.h, 120 + s.u)
    await page.waitForTimeout(300)
    await page.keyboard.press("KeyR")
    check(await until(page, "f.phase === 'landing'", 3000), `${name}: captured`)
    await until(page, "f.landing && f.landing.z > f.landing.touchZ - 30", 40000)
    await inspect(page, { yaw: Math.PI / 2, pitch: 0.06, dist: 34 })
    await until(page, "f.landing && f.landing.phase !== 'approach'", 8000)
    const z = await js<{ z: number; touch: number }>(page, "return { z: f.landing.z, touch: f.landing.touchZ }")
    await shot(page, `polish/${name}`)
    console.log(`${name}: centre down at ship z ${z.z.toFixed(2)} (aim ${z.touch.toFixed(2)}), hook tip at ${(z.z + hookZ).toFixed(2)}`)
    await inspect(page, null)
    check(await until(page, "f.phase === 'idle' || !f.landing", 20000), `${name}: landed`)
    return z.z + hookZ
  }
  const f35Hook = await touchdown("06-f35-touchdown", -4.41 - 1.75 * Math.cos(0.7))
  await page.waitForTimeout(1500)
  await js(page, "c.net.op('hornet')")
  check(await until(page, "f.phase === 'flying' && f.vehicle === 'hornet'", 12000), "the Hornet flies")
  const hornetHook = await touchdown("07-hornet-touchdown", -6.35 - 1.9 * Math.cos(0.7))
  check(Math.abs(f35Hook - hornetHook) < 1.5, `hooks touch down within 1.5 m of each other (${f35Hook.toFixed(2)} vs ${hornetHook.toFixed(2)})`)
  await page.close()

  // weapons.html?f35: the harness flies the F-35C model with its loadout.
  const h = await open(`${base}weapons.html?seed=7&drone=1&f35`, "harness", true)
  await h.waitForTimeout(3000)
  await h.evaluate(() => (globalThis as unknown as { carrier: { behind(id: number, d: number, up: number): void } }).carrier.behind(100, 220, 30))
  await h.waitForTimeout(1200)
  await shot(h, "polish/08-weapons-harness-f35-chase")
  const hj = (fn: string) => h.evaluate(`(() => { const c = globalThis.carrier; ${fn} })()`)
  await hj("c.weapons.loadout.slot = 1")
  await h.waitForTimeout(900)
  await hj("c.inspect = { yaw: 2.4, pitch: -0.4, dist: 20 }")
  await h.waitForTimeout(300)
  await shot(h, "polish/09-weapons-harness-f35-bay")
  await hj("c.winput.trigger = true")
  await h.waitForTimeout(100)
  await hj("c.winput.trigger = false")
  await h.waitForTimeout(450)
  await hj("c.inspect = { yaw: 2.0, pitch: -0.3, dist: 26 }")
  await h.waitForTimeout(200)
  await shot(h, "polish/10-weapons-harness-f35-bomb-away")
  const kind = await hj("return c.weapons.loadout.vehicle + ' ' + c.flight.vehicle")
  check(kind === "f35 f35", `the harness flies the F-35C (${kind})`)
  await h.close()
}

if (only.includes("polish")) await polish()
if (only.includes("solo")) await solo()
if (only.includes("mp")) await mp()
console.log(logs.length ? logs.slice(0, 40).join("\n") : "no console errors")
await browser.close()
await budget.exit(failures ? 1 : 0)
