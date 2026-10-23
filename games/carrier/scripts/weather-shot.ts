// Weather captures on a real GPU. Runs ON hailmary (Mac Studio): headless Chrome with WebGPU on Metal, loading the live
// dev server, one capture per weather kind at the same camera, plus a low camera into the storm swell, and optionally
// the weather lab open over a heavy storm and a rain cost benchmark. Refuses SwiftShader adapters.
//
//   ssh hailmary 'cd /tmp/carrier-weather && ~/.bun/bin/bun weather-shot.ts --out=/tmp/carrier-weather/out'
//
// Options: --base=URL (the game, default the dev tunnel)  --seed=1  --t=300  --size=1536x1024  --wait=5
//          --kinds=clear,light,medium,heavy  --cam=x,z,yaw,pitch,dist  --low=1 (storm swell view)  --lab=1 (panel shot)
//          --bench=1 (GPU throughput with and without rain at heavy)  --eval='js' (run before each capture)
//          --storm=N (chase-camera storm sequence: N frames 0.5 s apart, head seas at full speed, plus a low camera
//          beside the hull; writes storm-<i>.png with the ship's pitch/roll/heave/bow clearance per frame)
import { browserBudget } from "../../../scripts/browser-budget"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

await using budget = browserBudget()
const { chromium } = budget

const args = process.argv.slice(2)
const opt = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const base = opt("base", "https://carrier.lwoyjcaeyxv6.opentunnel.xyz/")
const out = opt("out", "/tmp/carrier-weather/out")
const seed = opt("seed", "1")
const t0 = opt("t", "300")
const wait = Number(opt("wait", "5"))
const kinds = opt("kinds", "clear,light,medium,heavy").split(",").filter(Boolean)
const cam = opt("cam", "0,0,0,12,170")
const evalJs = opt("eval", "")
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

type Carrier = {
  renderer: { context: { device: GPUDevice } }
  ocean?: { tiles: number; swell: [number, number] }
  arch?: unknown
  weather: { current: Record<string, number>; flash: number; view: unknown }
}

/** Copies the next swapchain texture through the game's device: PNG bytes of the WebGPU canvas alone. */
async function grab(): Promise<Buffer> {
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
    cv.getContext("2d")!.putImageData(img, 0, 0)
    const bytes = new Uint8Array(await (await cv.convertToBlob({ type: "image/png" })).arrayBuffer())
    let bin = ""
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(bin)
  })
  return Buffer.from(b64, "base64")
}

async function load(query: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await page.goto(`${base}?seed=${seed}${t0 === "live" ? "" : `&t=${t0}`}&${query}`, { waitUntil: "load" })
      await page.waitForFunction(() => {
        const c = (globalThis as unknown as { carrier?: Carrier }).carrier
        return !!c?.weather?.view && (c.ocean?.tiles ?? 0) > 0
      }, null, { timeout: 30_000 })
      break
    } catch (e) {
      if (i >= 3) throw e
      await page.waitForTimeout(1500)
    }
  }
  if (evalJs) await page.evaluate(evalJs)
  await page.waitForTimeout(wait * 1000)
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

/** Loads and captures, retrying when another agent's edit HMR-reloads the page mid-capture. */
async function shot(query: string, capture: () => Promise<Buffer> = grab): Promise<Buffer> {
  for (let i = 0; ; i++) {
    try {
      await load(query)
      return await capture()
    } catch (e) {
      if (i >= 4) throw e
    }
  }
}

const summary = async () =>
  page.evaluate(() => {
    const c = (globalThis as unknown as { carrier: Carrier }).carrier
    const w = c.weather.current
    return `rain ${w.rain!.toFixed(2)} sea ${w.sea!.toFixed(2)} fog ${w.fog!.toFixed(2)} flash ${c.weather.flash.toFixed(2)}`
  })

for (const kind of kinds) {
  writeFileSync(join(out, `weather-${kind}.png`), await shot(`weather=${kind}&lab=0&cam=${cam}`))
  console.log(`${kind}: ${await summary()}`)
}

if (opt("low", "1") === "1") {
  // Low camera looking into the storm swell (toward where the primary swell comes from).
  let sw: number[] = []
  await shot(`weather=heavy&lab=0&cam=0,0,0,8,60`, async () => {
    sw = await page.evaluate(() => [...(globalThis as unknown as { carrier: Carrier }).carrier.ocean!.swell])
    return Buffer.alloc(0)
  })
  const yaw = ((Math.atan2(-sw[0]!, sw[1]!) * 180) / Math.PI).toFixed(1)
  writeFileSync(join(out, "weather-heavy-low.png"), await shot(`weather=heavy&lab=0&cam=0,0,${yaw},8,60`))
  console.log(`heavy low (yaw ${yaw}): ${await summary()}`)
}

if (opt("lab", "1") === "1") {
  const png = await shot(`weather=heavy&lab=weather&cam=${cam}`, async () => {
    await page.waitForTimeout(1500)
    return page.screenshot()
  })
  writeFileSync(join(out, "weather-lab-heavy.png"), png)
  console.log("lab: page screenshot with the panel open")
}

if (opt("bench", "0") === "1") {
  // Throughput: encode frames back to back through the renderer and divide the wall time (per-pass timestamps lie on an
  // idle Apple GPU, docs/game-notes.md). Heavy weather with the rain on, then the same frame with the rain amount at 0.
  await load(`weather=heavy&lab=0&cam=${cam}`)
  const run = async (rain: boolean) =>
    page.evaluate(async (rain) => {
      const c = (globalThis as unknown as { carrier: { renderer: { context: { device: GPUDevice } }; frame: Float32Array; grade: unknown; lab: { target: { rain: number; splash: number } } } }).carrier
      c.lab.target.rain = rain ? 1 : 0
      await new Promise((r) => setTimeout(r, 300))
      const r = c.renderer as unknown as { draw(f: Float32Array, g: unknown): void }
      const device = c.renderer.context.device
      const times: number[] = []
      for (let k = 0; k < 7; k++) {
        await device.queue.onSubmittedWorkDone()
        const t = performance.now()
        for (let i = 0; i < 60; i++) r.draw(c.frame, c.grade)
        await device.queue.onSubmittedWorkDone()
        times.push((performance.now() - t) / 60)
      }
      times.sort((a, b) => a - b)
      return times
    }, rain)
  await run(true)
  const on = await run(true)
  const off = await run(false)
  const med = (a: number[]) => a[Math.floor(a.length / 2)]!
  console.log(`bench heavy: rain on ${med(on).toFixed(3)} ms/frame [${on.map((v) => v.toFixed(2)).join(" ")}], off ${med(off).toFixed(3)} ms [${off.map((v) => v.toFixed(2)).join(" ")}], rain costs ${(med(on) - med(off)).toFixed(3)} ms`)
}

// Storm look set (--look=1): the helm's chase camera for every kind (ship stopped, so the view matches), plus a heavy
// low camera into the swell and a heavy view from 2.5 km. Optional --lookkinds=clear,heavy.
if (opt("look", "0") === "1") {
  for (const kind of opt("lookkinds", "clear,light,medium,heavy").split(",")) {
    writeFileSync(join(out, `look-${kind}-chase.png`), await shot(`weather=${kind}&lab=0`))
    console.log(`look ${kind} chase: ${await summary()}`)
  }
  let sw: number[] = []
  await shot(`weather=heavy&lab=0&cam=0,0,0,8,60`, async () => {
    sw = await page.evaluate(() => [...(globalThis as unknown as { carrier: Carrier }).carrier.ocean!.swell])
    return Buffer.alloc(0)
  })
  const yaw = ((Math.atan2(-sw[0]!, sw[1]!) * 180) / Math.PI).toFixed(1)
  writeFileSync(join(out, "look-heavy-low.png"), await shot(`weather=heavy&lab=0&cam=0,0,${yaw},8,60`))
  writeFileSync(join(out, "look-heavy-far.png"), await shot(`weather=heavy&lab=0&cam=0,0,${yaw},14,2500`))
  writeFileSync(join(out, "look-clear-far.png"), await shot(`weather=clear&lab=0&cam=0,0,${yaw},14,2500`))
  // A lightning strike lighting the deck (STRIKE NOW in the weather tab).
  writeFileSync(
    join(out, "look-heavy-flash.png"),
    await shot(`weather=heavy&lab=0`, async () => {
      // With ?t the sea clock is frozen, so place the strike 30 ms before the frozen time (the main stroke's peak).
      await page.evaluate(() => {
        const w = (globalThis as unknown as { carrier: { weather: { forced: unknown; lastT: number } } }).carrier.weather
        w.forced = { t: w.lastT - 0.03, power: 1, bearing: 0.3, dist: 2500, seed: 5 }
      })
      await page.waitForTimeout(100)
      return grab()
    }),
  )
  console.log("look: low, far and lightning views")
}

const stormN = Number(opt("storm", "0"))
if (stormN > 0) {
  type G = { carrier: { game: { state: { ship: Record<string, number> | null; helm: { order: number }; free: boolean } }; camera: { set(v: object): void; eye: Float64Array | Float32Array }; weather: { view: { sea: { swell: [number, number] } } } } }
  const telemetry = () =>
    page.evaluate(() => {
      const s = (globalThis as unknown as G).carrier.game.state.ship!
      const D = 180 / Math.PI
      return `pitch ${(s.pitch! * D).toFixed(1)}° roll ${(s.roll! * D).toFixed(1)}° heave ${s.heave!.toFixed(1)} m bow clear ${s.bowAir!.toFixed(1)} m slam ${s.slam!.toFixed(2)} (${s.slams} slams) ${(s.u! / 0.5144).toFixed(0)} kn`
    })
  const setup = (throttle: number) =>
    page.evaluate((throttle) => {
      const c = (globalThis as unknown as G).carrier
      const ship = c.game.state.ship!
      const [sx, sz] = c.weather.view.sea.swell
      ship.heading = Math.atan2(-sx, sz)
      ship.u = 23.6 * throttle
      ship.power = throttle
      c.game.state.helm.order = throttle
    }, throttle)
  for (let attempt = 0; ; attempt++) {
    try {
      await load(`weather=heavy&lab=0`)
      await page.waitForFunction(() => !!(globalThis as unknown as G).carrier.game.state.ship, null, { timeout: 20_000 })
      await setup(Number(opt("throttle", "1")))
      await page.waitForTimeout(Number(opt("settle", "20")) * 1000)
      for (let i = 0; i < stormN; i++) {
        const t0 = Date.now()
        const png = await grab()
        writeFileSync(join(out, `storm-${String(i).padStart(2, "0")}.png`), png)
        console.log(`storm ${i}: ${await telemetry()}`)
        await page.waitForTimeout(Math.max(0, 500 - (Date.now() - t0)))
      }
      // Low camera beside the hull, looking across the bow into the swell.
      await page.evaluate(() => {
        const c = (globalThis as unknown as G).carrier
        const s = c.game.state.ship!
        c.game.state.free = true
        const fx = Math.sin(s.heading!)
        const fz = -Math.cos(s.heading!)
        // Focus 120 m ahead of midships and 90 m off the starboard side; the eye looks back toward the bow quarter.
        const x = s.x! + fx * 120 + -fz * 90
        const z = s.z! + fz * 120 + fx * 90
        c.camera.set({ x, z, yaw: s.heading! - 2.2, pitch: (8 * Math.PI) / 180, dist: 70 })
      })
      for (let i = 0; i < 3; i++) {
        await page.waitForTimeout(700)
        writeFileSync(join(out, `storm-low-${i}.png`), await grab())
        console.log(`storm low ${i}: ${await telemetry()}`)
      }
      // Broadside: the whole hull against the swell, pitching through a few crests.
      for (let i = 0; i < 6; i++) {
        await page.evaluate(() => {
          const c = (globalThis as unknown as G).carrier
          const s = c.game.state.ship!
          c.camera.set({ x: s.x!, z: s.z!, yaw: s.heading! - Math.PI / 2, pitch: (6 * Math.PI) / 180, dist: 620 })
        })
        await page.waitForTimeout(i ? 1000 : 300)
        writeFileSync(join(out, `storm-side-${i}.png`), await grab())
        console.log(`storm side ${i}: ${await telemetry()}`)
      }
      break
    } catch (e) {
      if (attempt >= 3) throw e
    }
  }
}

if (logs.length) console.log(`console:\n${[...new Set(logs)].slice(0, 30).join("\n")}`)
await browser.close()
