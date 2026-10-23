// Day-night captures on a real GPU. Runs ON hailmary (Mac Studio): headless Chrome with WebGPU on Metal loads the live
// dev server and captures fixed views (the same ones the time-of-day concepts were painted over) through the game's
// own device. Refuses SwiftShader adapters.
//
//   ssh hailmary 'cd /tmp/carrier-daynight && ~/.bun/bin/bun daynight-shot.ts --out=/tmp/carrier-daynight/out'
//
// Options: --base=URL  --seed=7  --t=300  --size=1536x1024  --wait=5  --views=chase,jet,reef,wide,sun
//          --times=  (comma list of hours, e.g. 6,12,18.5,22; each view is captured once per hour as <view>-<h>.png,
//                     passing ?tod=<h> to the page; empty = the page's own time, as <view>.png)
//          --query='&weather=heavy'  (appended to every URL)  --eval='js' (run before each capture)
//          --bench=chase  (throughput: frames encoded back to back, ms/frame, per --times hour)
//          --weather=heavy  (the game views' weather; default clear)  --strike=1 (a lightning strike at the capture)
//          --lab=1  (also a page screenshot of the TIME tab open over the chase view, as lab-<h>.png)
//          --fx=1  (weapon effects over the chase view: a gun burst's tracers, a missile with its trail, an explosion)  --aim=1 (the sun view faces the painted disc)
// The game views pass ?tod=<h>. The flight harness (jet view) has no day-night wiring of its own, so the script imports
// the day-night modules into it and hooks them onto its passes.
import { type Page } from "playwright-core"
import { browserBudget } from "../../../scripts/browser-budget"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

await using budget = browserBudget()
const { chromium } = budget

const args = process.argv.slice(2)
const opt = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const base = opt("base", "https://carrier.lwoyjcaeyxv6.opentunnel.xyz/")
const out = opt("out", "/tmp/carrier-daynight/out")
const seed = opt("seed", "7")
const t0 = opt("t", "300")
const wait = Number(opt("wait", "5"))
const query = opt("query", "")
const evalJs = opt("eval", "")
const views = opt("views", "chase,jet,reef,wide,sun").split(",").filter(Boolean)
const times = opt("times", "").split(",").filter(Boolean)
const bench = opt("bench", "")
const weatherKind = opt("weather", "clear")
// --aim=1: the "sun" view turns to face the painted sun (or moon) disc at each hour.
const aim = opt("aim", "0") === "1"
const [vw, vh] = opt("size", "1536x1024").split("x").map(Number) as [number, number]
mkdirSync(out, { recursive: true })

const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--enable-features=WebGPU", "--ignore-gpu-blocklist", "--enable-webgpu-developer-features"],
})
const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 })
const logs: string[] = []
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") logs.push(`${m.type()}: ${m.text()}`)
})
page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`))
// Other agents edit files on the shared dev server: block Vite's HMR socket so a reload can't reset a capture.
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

type Isle = { kind: string; x: number; z: number; radius: number; peak: number }
type Carrier = { arch?: { islands: Isle[] }; ocean?: { tiles: number }; flight?: unknown }

/** Copies the next swapchain texture through the game's device: PNG bytes of the WebGPU canvas alone. */
async function grab(p: Page): Promise<Buffer> {
  const b64 = await p.evaluate(async () => {
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
    cv.getContext("2d")!.putImageData(img, 0, 0)
    const bytes = new Uint8Array(await (await cv.convertToBlob({ type: "image/png" })).arrayBuffer())
    let bin = ""
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(bin)
  })
  return Buffer.from(b64, "base64")
}

async function load(url: string, ready: () => boolean): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await page.goto(url, { waitUntil: "load" })
      await page.waitForFunction(ready, null, { timeout: 30_000 })
      return
    } catch (e) {
      if (i >= 3) throw e
      await page.waitForTimeout(2000)
    }
  }
}
const gameReady = () => {
  const c = (globalThis as unknown as { carrier?: Carrier }).carrier
  return !!c?.arch && (c.ocean?.tiles ?? 0) > 0
}
const harnessReady = () => !!(globalThis as unknown as { carrier?: Carrier }).carrier?.flight

let isles: Isle[] = []
let aimAtDisc = false
const pick = (kinds: string[]) => {
  for (const k of kinds) {
    const all = isles.filter((i) => i.kind === k).sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z))
    if (all.length) return all[0]!
  }
  return isles[0]!
}

/**
 * Wires the day-night modules into the flight harness (dynamic imports of the dev server's modules, prototype hooks on
 * its passes, as main.ts wires them into the game), then shows clock hour `hour` on the local clock.
 */
async function inject(hour: number): Promise<void> {
  await page.evaluate(async (hour) => {
    type Any = any // eslint-disable-line @typescript-eslint/no-explicit-any
    const g = globalThis as Any
    const c = g.carrier as Any
    if (!g.__dn) {
      const imp = (p: string) => import(/* @vite-ignore */ p) as Promise<Any>
      const [dnm, stm, lm, skym, ocm, spm, fxm, atm, rm] = await Promise.all(
        ["daynight", "stars", "lights", "sky", "ocean", "ship-pass", "plane-fx", "atmosphere", "renderer"].map((m) => imp(`/src/render/${m}.ts`)),
      )
      const look = { ...ocm.OCEAN_LOOK_DEFAULT, deep: [...ocm.OCEAN_LOOK_DEFAULT.deep], scatter: [...ocm.OCEAN_LOOK_DEFAULT.scatter], foam: [...ocm.OCEAN_LOOK_DEFAULT.foam] }
      const bases = { atmosphere: { ...c.atmosphere }, grade: { ...c.grade }, ocean: look }
      const dn = new dnm.DayNight(bases)
      const stars = new stm.Stars(c.renderer)
      const lights = new lm.Lights(c.renderer)
      c.renderer.addPass("sky", stars)
      c.renderer.addPass("alpha", lights)
      const st: Any = { last: performance.now(), ocean: null }
      const sky = skym.Sky.prototype.update
      skym.Sky.prototype.update = function (view: Any) {
        const now = performance.now()
        const dt = Math.min(0.1, (now - st.last) / 1000)
        st.last = now
        dn.update(dt, 0, bases, st.ocean ?? undefined)
        if (st.ocean) {
          for (let i = 0; i < 3; i++) st.ocean.deep[i] = dn.ocean.deep[i]
          st.ocean.glitter = dn.ocean.glitter
        }
        Object.assign(c.grade, dn.grade)
        atm.fillAtmosphere(c.frame, dn.atmosphere)
        dn.fill(c.frame)
        dn.passes(view, stars, lights, { fov: c.camera.fov, height: c.frame[37], overcast: 0, storm: 0 })
        return sky.call(this, view, dn.atmosphere.sunView)
      }
      const ocean = ocm.Ocean.prototype.update
      ocm.Ocean.prototype.update = function (t: number, view: Any) {
        st.ocean = this.look
        return ocean.call(this, t, view, dn.atmosphere.sunView)
      }
      const render = rm.Renderer.prototype.render
      rm.Renderer.prototype.render = function (frame: Any) {
        return render.call(this, frame, dn.grade)
      }
      const sb = spm.ShipPass.prototype.begin
      spm.ShipPass.prototype.begin = function () {
        this.lights ??= lights
        return sb.call(this)
      }
      const fb = fxm.PlaneFx.prototype.begin
      fxm.PlaneFx.prototype.begin = function (...a: Any[]) {
        if (!this.lights) this.setLights(lights)
        return fb.apply(this, a)
      }
      g.__dn = dn
      Object.assign(c, { daynight: dn, stars, lights })
    }
    g.__dn.setManual(hour, 0)
  }, hour)
  await page.waitForTimeout(1500)
}

/** Each view: the page to open and anything to do before the capture. */
const VIEWS: Record<string, { note: string; run: (tod: string) => Promise<void> }> = {
  chase: {
    note: "the helm's chase camera behind the carrier, under way",
    run: async (tod) => {
      await load(`${base}?seed=${seed}&t=${t0}&weather=${weatherKind}${tod}${query}`, gameReady)
      await page.evaluate(() => {
        const c = (globalThis as unknown as { carrier: { game: { state: { helm: { order: number } } } } }).carrier
        c.game.state.helm.order = 0.6
      })
      await page.waitForTimeout(Math.max(wait, 10) * 1000)
    },
  },
  jet: {
    note: "a jet in flight near an island (flight harness, camera orbiting the jet)",
    run: async (tod) => {
      await load(`${base}flight.html?seed=${seed}${query}`, harnessReady)
      await page.waitForTimeout(2500)
      await page.evaluate(() => {
        type C = { arch: { islands: Isle[] }; warp(...a: number[]): void; inspect: unknown }
        const c = (globalThis as unknown as { carrier: C }).carrier
        const isl = c.arch.islands.filter((i) => i.peak > 80).sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z))[0]!
        const d = Math.hypot(isl.x, isl.z)
        const sx = isl.x - (isl.x / d) * (isl.radius + 900)
        const sz = isl.z - (isl.z / d) * (isl.radius + 900)
        const heading = Math.atan2(isl.x - sx, -(isl.z - sz)) + 0.35
        c.warp(sx, 140, sz, heading, 0, 160)
        c.inspect = { yaw: 2.6, pitch: 0.12, dist: 26 }
      })
      await page.waitForTimeout(1200)
    },
  },
  reef: {
    note: "an island reef shelf from above",
    run: async (tod) => {
      const i = pick(["jungle", "volcanic"])
      await load(`${base}?seed=${seed}&t=${t0}&weather=${weatherKind}&cam=${i.x},${i.z + i.radius * 1.1},0,32,${Math.max(700, i.radius * 3.2)}${tod}${query}`, gameReady)
      await page.waitForTimeout(wait * 1000)
    },
  },
  wide: {
    note: "high wide archipelago",
    run: async (tod) => {
      await load(`${base}?seed=${seed}&t=${t0}&weather=${weatherKind}&cam=0,-1200,0,32,4000${tod}${query}`, gameReady)
      await page.waitForTimeout(wait * 1000)
    },
  },
  sun: {
    note: "low over the sea toward the sun: glitter path",
    run: async (tod) => {
      await load(`${base}?seed=${seed}&t=${t0}&weather=${weatherKind}&cam=300,300,32,9,320${tod}${query}`, gameReady)
      await page.waitForTimeout(wait * 1000)
      aimAtDisc = aim
    },
  },
}

await page.goto(base, { waitUntil: "load" })
const adapter = await page.evaluate(async () => {
  const a = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" })
  return a ? `${a.info.vendor} / ${a.info.architecture} / ${a.info.description}` : "no adapter"
})
console.log(`adapter: ${adapter}`)
if (/swiftshader/i.test(adapter) || adapter === "no adapter") {
  console.log("no hardware adapter: refusing to trust these captures")
  await budget.exit(2)
}
await load(`${base}?seed=${seed}&t=${t0}&weather=clear${query}`, gameReady)
isles = await page.evaluate(() => (globalThis as unknown as { carrier: { arch: { islands: Isle[] } } }).carrier.arch.islands.map((i) => ({ kind: i.kind, x: i.x, z: i.z, radius: i.radius, peak: i.peak })))

for (const v of views) {
  const view = VIEWS[v]
  if (!view) continue
  for (const h of times.length ? times : [""]) {
    for (let attempt = 0; ; attempt++) {
      try {
        await view.run(h ? `&tod=${h}` : "")
        if (v === "jet" && h) await inject(Number(h))
        if (aimAtDisc) {
          aimAtDisc = false
          await page.evaluate(() => {
            const c = (globalThis as unknown as { carrier: { camera: { yaw: number }; daynight: { atmosphere: { sunView: number[] } } } }).carrier
            const d = c.daynight.atmosphere.sunView
            c.camera.yaw = Math.atan2(d[0]!, -d[2]!) - 0.12
          })
          await page.waitForTimeout(800)
        }
        if (opt("fx", "0") === "1") {
          // Weapon effects ahead of the camera, fed every frame right after the weapons' own begin (as Weapons does).
          await page.evaluate(() => {
            type Fx = { begin(...a: unknown[]): void; tracer(...a: number[]): void; missile(...a: (number | boolean)[]): void; explosion(...a: number[]): void }
            const c = (globalThis as unknown as { carrier: { flight: { weapons: { fx: Fx } }; camera: { eye: ArrayLike<number>; forward: ArrayLike<number> } } }).carrier
            const fx = c.flight.weapons.fx
            const e = [...Array.from(c.camera.eye)]
            const f = [...Array.from(c.camera.forward)]
            const at = (d: number, side: number, up: number) => [e[0]! + f[0]! * d - f[2]! * side, Math.max(20, e[1]! + f[1]! * d + up), e[2]! + f[2]! * d + f[0]! * side]
            const boom = at(420, -70, 60)
            const start = performance.now()
            let boomAt = -1
            const begin = fx.begin.bind(fx)
            fx.begin = (...a: unknown[]) => {
              begin(...a)
              const s = (performance.now() - start) / 1000
              // A fresh explosion every 1.2 s, so a capture always catches a fireball.
              if (s - boomAt > 1.2) {
                boomAt = s
                fx.explosion(boom[0]!, boom[1]!, boom[2]!, 0, 0, 0, 1.4)
              }
              for (let i = 0; i < 6; i++) {
                const p = at(260 + ((s * 900 + i * 60) % 360), 40 - i * 2, 40 + i)
                fx.tracer(p[0]!, p[1]!, p[2]!, f[0]! * 900, 0, f[2]! * 900)
              }
              const m = at(200 + s * 250, 120 - s * 40, 60 + s * 10)
              fx.missile(7, m[0]!, m[1]!, m[2]!, f[0]! * 250, 10, f[2]! * 250, true)
            }
          })
          await page.waitForTimeout(1500)
        }
        if (opt("strike", "0") === "1") {
          // With ?t the sea clock is frozen: place the strike 30 ms before it (the main stroke's peak).
          await page.evaluate(() => {
            const w = (globalThis as unknown as { carrier: { weather: { forced: unknown; lastT: number } } }).carrier.weather
            w.forced = { t: w.lastT - 0.03, power: 1, bearing: 0.3, dist: 2500, seed: 5 }
          })
          await page.waitForTimeout(100)
        }
        if (evalJs) {
          await page.evaluate(evalJs)
          await page.waitForTimeout(500)
        }
        writeFileSync(join(out, `${v}${h ? `-${h}` : ""}.png`), await grab(page))
        if (opt("lab", "0") === "1" && v === "chase") {
          await page.evaluate(() => (globalThis as unknown as { carrier: { debugMenu: { open(t: string): void } } }).carrier.debugMenu.open("time"))
          await page.waitForTimeout(600)
          writeFileSync(join(out, `lab${h ? `-${h}` : ""}.png`), await page.screenshot())
        }
        break
      } catch (e) {
        if (attempt >= 3) throw e
        await page.waitForTimeout(2000)
      }
    }
    console.log(`${v}${h ? ` @ ${h} h` : ""}: ${view.note}`)
  }
}

if (bench && VIEWS[bench]) {
  for (const h of times.length ? times : [""]) {
    await VIEWS[bench]!.run(h ? `&tod=${h}` : "")
    if (bench === "jet" && h) await inject(Number(h))
    const ms = await page.evaluate(async () => {
      const c = (globalThis as unknown as { carrier: { renderer: { context: { device: GPUDevice } }; frame: Float32Array; grade: unknown } }).carrier
      const r = c.renderer as unknown as { draw(f: Float32Array, g: unknown): void }
      const dev = c.renderer.context.device
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
      const all: number[] = []
      for (let k = 0; k < 5; k++) all.push(await run(60))
      return all.sort((a, b) => a - b)
    })
    console.log(`bench ${bench}${h ? ` @ ${h} h` : ""}: median ${ms[2]!.toFixed(2)} ms/frame [${ms.map((m) => m.toFixed(2)).join(" ")}]`)
  }
}

if (logs.length) console.log(`console:\n${[...new Set(logs)].slice(0, 20).join("\n")}`)
await browser.close()
