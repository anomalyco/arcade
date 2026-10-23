// A short proof clip of the SAM from the gunner's seat on a real GPU: the seeker tracking a drone (the box closing,
// the progress bar), an early click (ARMED), the launch the moment it locks, the motor plume and smoke trail through
// the scope, and the proximity burst with its hanging puff. Starts its own Vite dev server for the gunnery harness
// (gunnery.html, offline, muted) and steps it on a virtual clock (performance.now and requestAnimationFrame are the
// script's), so every video frame is exactly 1/FPS s of game time however slow the capture. Each frame is read back
// through the game's device, laid under the DOM HUD and screenshotted, then piped to ffmpeg: sam.mp4 in --out.
//
//   hivemind run --kind browser -- bun scripts/sam-clip.ts --out=captures/sam-proof
//
// Options: --out=DIR  --size=1280x800  --seed=7  --fps=30  --port=N (dev server)
import { spawn } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import { join, resolve } from "node:path"
import type { Page } from "playwright-core"
import { browserBudget } from "../../../scripts/browser-budget"

await using budget = browserBudget()
const { chromium } = budget

const args = process.argv.slice(2)
const opt = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const root = resolve(import.meta.dir, "..")
const out = resolve(opt("out", join(root, "captures/sam-proof")))
const [vw, vh] = opt("size", "1280x800").split("x").map(Number) as [number, number]
const FPS = Number(opt("fps", "30"))
const port = Number(opt("port", String(5300 + Math.floor(Math.random() * 600))))
mkdirSync(out, { recursive: true })

const vite = spawn(join(root, "../../node_modules/.bin/vite"), ["--port", String(port), "--strictPort"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] })
await new Promise<void>((ok, no) => {
  const t = setTimeout(() => no(new Error("vite did not start")), 30_000)
  vite.stdout.on("data", (b: Buffer) => {
    if (b.toString().includes("Local")) {
      clearTimeout(t)
      ok()
    }
  })
  vite.on("exit", (c) => no(new Error(`vite exited ${c}`)))
})

type C = {
  gunnery: { status: { lock: number; locked: boolean; live: number; cells: number }; state: { armed: boolean } | null; input: { trigger: boolean | null; zoom: boolean | null } }
  drones: { list: { id: number; dead: number }[] }
  candidates(r: number): number[]
  track: unknown
  renderer: { context: { device: GPUDevice } }
}
type W = { carrier: C; __step(ms: number, n?: number): void; __grab(ms: number): Promise<string> }

/** Virtual clock: the page's frames run only when the script steps them. */
function clock(): void {
  const g = globalThis as unknown as W
  let vt = 0
  let queue: FrameRequestCallback[] = []
  let configured = false
  performance.now = () => vt
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => queue.push(cb)
  g.__step = (ms: number, n = 1) => {
    for (let i = 0; i < n; i++) {
      vt += ms
      const q = queue
      queue = []
      for (const cb of q) cb(vt)
    }
  }
  // One frame stepped and read back through the game's device as a JPEG data URL.
  g.__grab = async (ms: number) => {
    const c = g.carrier
    const device = c.renderer.context.device
    const ctx = (c.renderer as unknown as { canvas: GPUCanvasContext }).canvas
    const format = navigator.gpu.getPreferredCanvasFormat()
    if (!configured) ctx.configure({ device, format, alphaMode: "opaque", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
    configured = true
    const w = (ctx.canvas as HTMLCanvasElement).width
    const h = (ctx.canvas as HTMLCanvasElement).height
    const row = Math.ceil((w * 4) / 256) * 256
    const buf = device.createBuffer({ size: row * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    // The renderer draws in a microtask with at most one frame in flight: let the last one finish first.
    await device.queue.onSubmittedWorkDone()
    await new Promise((r) => setTimeout(r, 0))
    const get = ctx.getCurrentTexture.bind(ctx)
    const submit = device.queue.submit.bind(device.queue)
    let tex: GPUTexture | null = null
    const copied = new Promise<boolean>((resolve) => {
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
        resolve(true)
      }
      setTimeout(() => resolve(false), 2000)
    })
    g.__step(ms)
    const ok = await copied
    ctx.getCurrentTexture = get
    device.queue.submit = submit
    if (!ok) console.error("[clip] frame not drawn")
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
    buf.destroy()
    const cv = document.createElement("canvas")
    cv.width = w
    cv.height = h
    cv.getContext("2d")!.putImageData(img, 0, 0)
    return cv.toDataURL("image/jpeg", 0.92)
  }
}

const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "19", "-preset", "medium", "-movflags", "+faststart", join(out, "sam.mp4")], { stdio: ["pipe", "inherit", "inherit"] })
try {
  const browser = await chromium.launch({
    executablePath: existsSync(MAC_CHROME) ? MAC_CHROME : undefined,
    headless: true,
    args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--enable-features=WebGPU", "--ignore-gpu-blocklist", "--mute-audio"],
  })
  const page: Page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 })
  page.on("pageerror", (e) => console.log(`pageerror: ${e.message}`))
  page.on("console", (m) => m.type() === "error" && console.log(`[page] ${m.text()}`))
  await page.addInitScript(clock)
  await page.goto(`http://localhost:${port}/gunnery.html?gunner=sam&drone=4&seed=${opt("seed", "7")}`, { waitUntil: "load" })
  await page.waitForFunction(() => !!(globalThis as unknown as Partial<W>).carrier?.gunnery, undefined, { timeout: 60_000 })
  const dt = 1000 / FPS
  const step = (n: number) => page.evaluate(([ms, k]) => (globalThis as unknown as W).__step(ms!, k), [dt, n])
  const st = (id: number) =>
    page.evaluate((i) => {
      const c = (globalThis as unknown as W).carrier
      const g = c.gunnery as unknown as { world: { projectiles: { alive: boolean; x: number; y: number; z: number; age: number; speed: number; target: number }[] } }
      const p = g.world.projectiles.find((p) => p.alive)
      const d = c.drones.list.find((d) => d.id === i) as unknown as { dead: number; plane: { x: number; y: number; z: number } } | undefined
      const sam = p && d ? { age: +p.age.toFixed(2), speed: Math.round(p.speed), target: p.target, miss: Math.round(Math.hypot(p.x - d.plane.x, p.y - d.plane.y, p.z - d.plane.z)) } : null
      const { lock, locked, live, cells } = c.gunnery.status
      return { id: i, lock, locked, live, cells, armed: c.gunnery.state?.armed ?? false, dead: d?.dead ?? -1, sam }
    }, id)
  const set = (js: string) => page.evaluate(js)
  // Warm up (assets, the first frames), then fast-forward until a drone flies 1.5-3.2 km out.
  await step(FPS * 2)
  await page.waitForTimeout(1500)
  let id = -1
  for (let k = 0; k < 120 && id < 0; k++) {
    id = (await page.evaluate(() => (globalThis as unknown as W).carrier.candidates(3200)))[0] ?? -1
    if (id < 0) await step(FPS / 2)
  }
  if (id < 0) throw new Error("no drone in range")
  let frames = 0
  const grab = async () => {
    const url = await page.evaluate((ms) => (globalThis as unknown as W).__grab(ms), dt)
    await page.evaluate((src) => {
      let img = document.getElementById("shot-bg") as HTMLImageElement | null
      if (!img) {
        img = document.createElement("img")
        img.id = "shot-bg"
        Object.assign(img.style, { position: "fixed", inset: "0", width: "100%", height: "100%", zIndex: "0" })
        const canvas = document.getElementById("view")!
        canvas.style.visibility = "hidden"
        canvas.after(img)
      }
      img.src = src
      return img.decode()
    }, url)
    ff.stdin.write(await page.screenshot({ type: "jpeg", quality: 92 }))
    frames++
  }
  const t = () => frames / FPS
  // The sight starts high, clear of every drone (they fly below 45°), so the lock starts only once it tracks.
  await set("carrier.gunnery.aimElevation = 1.15")
  for (let i = 0; i < FPS * 0.8; i++) await grab()
  await set(`carrier.track = { kind: "drone", id: ${id} }`)
  let s = await st(id)
  while (s.lock < 0 && t() < 6) {
    await grab()
    s = await st(id)
  }
  const tracked = t()
  // An early click, while the lock still builds.
  for (let i = 0; i < FPS * 0.35; i++) await grab()
  await set("carrier.gunnery.input.trigger = true")
  await grab()
  await grab()
  await set("carrier.gunnery.input.trigger = false")
  s = await st(id)
  console.log(`clicked early at +${(t() - tracked).toFixed(2)} s: ${JSON.stringify(s)}`)
  while (s.live === 0 && t() < tracked + 5) {
    await grab()
    s = await st(id)
  }
  const launched = t()
  console.log(`launched on lock +${(launched - tracked).toFixed(2)} s after tracking began: ${JSON.stringify(s)}`)
  for (let i = 0; i < FPS * 0.6; i++) await grab()
  await set("carrier.gunnery.input.zoom = true")
  while (s.live > 0 && t() < launched + 10) {
    await grab()
    s = await st(id)
    if (frames % (FPS / 2) === 0) console.log(`  +${(t() - launched).toFixed(1)} s ${JSON.stringify(s)}`)
  }
  console.log(`burst ${(t() - launched).toFixed(2)} s after launch: drone ${s.dead >= 0 ? "killed" : "alive"} ${JSON.stringify(s)}`)
  for (let i = 0; i < FPS * 3; i++) await grab()
  await browser.close()
  console.log(`${frames} frames (${t().toFixed(1)} s)`)
} finally {
  ff.stdin.end()
  await new Promise((r) => ff.on("exit", r))
  vite.kill()
}
console.log(`wrote ${join(out, "sam.mp4")}`)
