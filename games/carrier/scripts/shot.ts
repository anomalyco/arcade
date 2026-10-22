// Captures a frame with headless Chromium (WebGPU on SwiftShader: slow, but checks shaders and the look).
// On headless Linux, any submit that touches a WebGPU canvas texture destroys the SwiftShader device, so an init
// script swaps the canvas texture for an offscreen one; this reads it back through the game's device and writes a PNG.
// Usage: bun scripts/shot.ts [url] [--out=file.png] [--wait=seconds] [--query=seed=1&t=120] [--size=1536x1024]
import { browserBudget } from "../../../scripts/browser-budget"
import { mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { deflateSync } from "node:zlib"

await using budget = browserBudget()
const { chromium } = budget

const args = process.argv.slice(2)
const opt = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const base = args.find((a) => a.startsWith("http")) ?? "http://localhost:5197/"
const out = opt("out", "/tmp/opencode/shots/carrier.png")
const wait = Number(opt("wait", "8"))
const query = opt("query", "seed=1&t=120")
const [vw, vh] = opt("size", "1536x1024").split("x").map(Number) as [number, number]
mkdirSync(dirname(out), { recursive: true })

const browser = await chromium.launch({
  executablePath: join(homedir(), ".cache/ms-playwright/chromium-1234/chrome-linux64/chrome"),
  headless: true,
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU", "--ignore-gpu-blocklist", "--no-sandbox"],
})
const page = await browser.newPage({ viewport: { width: vw, height: vh } })
const logs: string[] = []
page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`))
page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`))
page.on("crash", () => console.log("page crashed"))
await page.addInitScript(() => {
  const configure = GPUCanvasContext.prototype.configure
  GPUCanvasContext.prototype.configure = function (this: GPUCanvasContext, c: GPUCanvasConfiguration) {
    configure.call(this, c)
    Reflect.set(this, "shotConfig", c)
  }
  GPUCanvasContext.prototype.getCurrentTexture = function (this: GPUCanvasContext) {
    const c: GPUCanvasConfiguration = Reflect.get(this, "shotConfig")
    const w = this.canvas.width
    const h = this.canvas.height
    let t: GPUTexture | undefined = Reflect.get(this, "shotTex")
    if (!t || t.width !== w || t.height !== h) {
      t?.destroy()
      t = c.device.createTexture({ size: [w, h], format: c.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
      Reflect.set(this, "shotTex", t)
    }
    Reflect.set(globalThis, "shotTex", t)
    return t
  }
})
await page.goto(`${base}?${query}`, { waitUntil: "networkidle" })
await page.waitForTimeout(wait * 1000)

const grab = await page.evaluate(async () => {
  const c = Reflect.get(globalThis, "carrier")
  if (!c) return null
  const renderer = c.renderer
  const device: GPUDevice = renderer.context.device
  const format = navigator.gpu.getPreferredCanvasFormat()
  const tex: GPUTexture | undefined = Reflect.get(globalThis, "shotTex")
  if (!tex) return null
  const w = tex.width
  const h = tex.height
  const row = Math.ceil((w * 4) / 256) * 256
  const buf = device.createBuffer({ size: row * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
  await device.queue.onSubmittedWorkDone()
  const enc = device.createCommandEncoder()
  enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: row }, [w, h])
  device.queue.submit([enc.finish()])
  await buf.mapAsync(GPUMapMode.READ)
  const src = new Uint8Array(buf.getMappedRange())
  const px = new Uint8Array(w * h * 4)
  const bgra = format === "bgra8unorm"
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = y * row + x * 4
      const d = (y * w + x) * 4
      px[d] = src[s + (bgra ? 2 : 0)]!
      px[d + 1] = src[s + 1]!
      px[d + 2] = src[s + (bgra ? 0 : 2)]!
      px[d + 3] = 255
    }
  let bin = ""
  for (let i = 0; i < px.length; i += 0x8000) bin += String.fromCharCode(...px.subarray(i, i + 0x8000))
  return { w, h, data: btoa(bin) }
})

if (grab) {
  const raw = Buffer.from(grab.data, "base64")
  const lines = Buffer.alloc((grab.w * 4 + 1) * grab.h)
  for (let y = 0; y < grab.h; y++) raw.copy(lines, y * (grab.w * 4 + 1) + 1, y * grab.w * 4, (y + 1) * grab.w * 4)
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (b: Buffer) => {
    let c = 0xffffffff
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(grab.w, 0)
  ihdr.writeUInt32BE(grab.h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(lines)), chunk("IEND", Buffer.alloc(0))]))
  console.log(out)
} else console.log("no globalThis.carrier: the game did not start")
console.log(logs.filter((l) => !l.startsWith("debug")).slice(0, 30).join("\n"))
await browser.close()
