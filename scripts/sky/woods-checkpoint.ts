/** Production woods Today/new checkpoints and a deterministic camp look-up. Headless/muted, HiveMind only. */
import { chromium } from "playwright-core"
import { mkdir, readdir, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve, sep } from "node:path"
import { hostname } from "node:os"
import type { ForestView } from "../../packages/kit/forest/view"

const out = resolve(process.env.SKY_OUT ?? "captures/sky-woods")
await mkdir(out, { recursive: true })
const root = resolve("games/woods/dist/arcade/woods")
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const path = new URL(req.url).pathname.replace(/^\/arcade\/woods\//, "")
  const file = resolve(root, path || "index.html")
  if (!file.startsWith(root + sep)) return new Response("Not found", { status: 404 })
  const f = Bun.file(file); return await f.exists() ? new Response(f) : new Response("Not found", { status: 404 })
} })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = (await readdir(cache)).filter(n => n.startsWith("chromium_headless_shell-")).sort().reverse().map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
if (!executablePath) throw Error("Headless Chromium missing")
const browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio", "--enable-features=WebGPUExperimentalFeatures"] })
type Woods = { frames: number; paused: boolean; autoplay: boolean; setPose(x: number, z: number, yaw: number, pitch: number): void; step(ms: number): void; camera: { flashlight: boolean }; look: ForestView["settings"]; view: { forest: ForestView } }
declare const woods: Woods
const errors: string[] = []
const report: Record<string, unknown> = { host: hostname(), viewport: [1920, 1080], errors }
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
  page.on("pageerror", e => { errors.push(e.message); console.error(e.message) })
  page.on("console", m => { if (m.type() === "error") { errors.push(m.text()); console.error(m.text()) } })
  await page.addInitScript(() => {
    let seed = 31273
    Math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296)
    const configure = GPUCanvasContext.prototype.configure
    GPUCanvasContext.prototype.configure = function(c) { configure.call(this, { ...c, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC }) }
  })
  await page.goto(`http://127.0.0.1:${server.port}/arcade/woods/?bench=1&quality=high`, { timeout: 120000 })
  await page.waitForFunction(() => typeof woods !== "undefined" && woods.frames > 2, undefined, { timeout: 240000 })
  await page.evaluate(() => {
    woods.autoplay = true; woods.paused = true; woods.camera.flashlight = false
    woods.view.forest.renderer.render = woods.view.forest.renderer.drawTo.bind(woods.view.forest.renderer)
    const forest = woods.view.forest, update = forest.update.bind(forest)
    // Settle presentation/adaptation without advancing bots, wind, noise or the scene clock between modes.
    forest.update = input => update({ ...input, time: 8, dt: 1 / 30 })
    ;(window as Window & { skyRestore?: () => void }).skyRestore = () => { forest.update = update }
  })
  async function capture() {
    const base64 = await page.evaluate(async () => {
      const forest = woods.view.forest, d = forest.renderer.passContext.device
      const canvas = document.querySelector<HTMLCanvasElement>("#view") ?? document.querySelector<HTMLCanvasElement>("canvas")!
      const row = Math.ceil(canvas.width * 4 / 256) * 256
      const buffer = d.createBuffer({ size: row * canvas.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
      forest.drawTo()
      const enc = d.createCommandEncoder()
      enc.copyTextureToBuffer({ texture: canvas.getContext("webgpu")!.getCurrentTexture() }, { buffer, bytesPerRow: row }, [canvas.width, canvas.height])
      d.queue.submit([enc.finish()]); await buffer.mapAsync(GPUMapMode.READ)
      const src = new Uint8Array(buffer.getMappedRange()), rgba = new Uint8ClampedArray(canvas.width * canvas.height * 4)
      for (let y = 0; y < canvas.height; y++) rgba.set(src.subarray(y * row, y * row + canvas.width * 4), y * canvas.width * 4)
      buffer.unmap(); buffer.destroy()
      if (navigator.gpu.getPreferredCanvasFormat().startsWith("bgra")) for (let i = 0; i < rgba.length; i += 4) { const r = rgba[i]!; rgba[i] = rgba[i + 2]!; rgba[i + 2] = r }
      const image = document.createElement("canvas"); image.width = canvas.width; image.height = canvas.height
      image.getContext("2d")!.putImageData(new ImageData(rgba, canvas.width, canvas.height), 0, 0)
      return image.toDataURL("image/png").split(",")[1]!
    })
    return Buffer.from(base64, "base64")
  }
  for (const shot of ["clearing-up", "lake"]) for (const mode of ["today", "physical"] as const) {
    const state = await page.evaluate(async ({ shot, mode }) => {
      const f = woods.view.forest
      Object.assign(woods.look, { skyMode: mode, skyMoon: "crescent", skyMoonAzimuth: 20, skyMoonAltitude: 36, skyHaze: 0.4 })
      const pose = shot === "clearing-up" ? [-23, 64, .4, .95] : [-30, 164, 0, .22]
      woods.setPose(pose[0]!, pose[1]!, pose[2]!, pose[3]!)
      woods.step(0); await f.sky.load()
      for (let i = 0; i < 90; i++) { woods.step(0); await f.renderer.passContext.device.queue.onSubmittedWorkDone() }
      return { pose, settings: woods.look, stats: f.stats(), active: f.sky.active }
    }, { shot, mode })
    const name = `${shot}-${mode === "physical" ? "new" : mode}`
    report[name] = state
    await writeFile(resolve(out, `${name}.png`), await capture())
    console.log(name, state.stats)
  }
  if (process.argv.includes("--clip")) {
    await page.evaluate(async () => {
      ;(window as Window & { skyRestore?: () => void }).skyRestore?.()
      woods.look.skyMode = "physical"; woods.look.skyMoon = "crescent"
      woods.setPose(-23, 64, .4, .02)
      for (let i = 0; i < 30; i++) { woods.step(1000 / 30); await woods.view.forest.renderer.passContext.device.queue.onSubmittedWorkDone() }
    })
    const encode = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "image2pipe", "-framerate", "30", "-i", "pipe:0", "-c:v", "libx264", "-preset", "fast", "-crf", "19", "-pix_fmt", "yuv420p", "-movflags", "+faststart", resolve(out, "camp-look-up.mp4")], { stdin: "pipe", stdout: "ignore", stderr: "inherit" })
    for (let i = 0; i < 180; i++) {
      await page.evaluate(async i => {
        const t = Math.max(0, Math.min(1, (i / 30 - 1) / 3)), ease = t * t * (3 - 2 * t)
        // Assign the camera pitch without teleport/resetExposure on each frame.
        ;(woods.camera as typeof woods.camera & { pitch: number }).pitch = .02 + ease * .93
        woods.step(1000 / 30); await woods.view.forest.renderer.passContext.device.queue.onSubmittedWorkDone()
      }, i)
      encode.stdin.write(await capture()); await encode.stdin.flush()
    }
    encode.stdin.end()
    if (await encode.exited) throw Error("Clip encode failed")
  }
  await writeFile(resolve(out, "report.json"), JSON.stringify(report, null, 2))
  if (errors.length) throw Error(errors.join("\n"))
} finally { await browser.close(); server.stop(true) }
