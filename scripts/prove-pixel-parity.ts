// Pixel parity between two production builds of a game: serves each `dist/arcade/<game>` directory, runs the same
// deterministic page (seeded sandbox with a manual clock by default) on headless Metal, and compares canvas pixels.
// Usage: bun scripts/prove-pixel-parity.ts <game> <base-dist-root> <head-dist-root> [--query=sandbox=1&manual&seed=1]
//        [--advance=2500] [--out=dir] [--dpr=1] [--viewport=1280x800] [--drive=advance|bench|clock]
// Drivers: `advance` calls the page's manual clock (`globalThis.advance(ms)`); `bench` steps Getaway's deterministic
// `__getawayBench` (reset, then one step per 1/30 s); `clock` pauses Playwright's fake clock while the page loads, then
// runs it for `advance` ms, for games without a manual clock. Math.random is seeded on every driver.
import { mkdirSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import { chromium, type Browser } from "playwright-core"

const [game, baseDir, headDir] = process.argv.slice(2).filter((a) => !a.startsWith("--"))
const opt = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
if (!game || !baseDir || !headDir) throw Error("usage: prove-pixel-parity.ts <game> <base-dist-root> <head-dist-root>")
const query = opt("query", "sandbox=1&manual&seed=1")
const advance = Number(opt("advance", "2500"))
const dpr = Number(opt("dpr", "1"))
const [vw = 1280, vh = 800] = opt("viewport", "1280x800").split("x").map(Number)
const drive = opt("drive", "advance")
const out = resolve(opt("out", `captures/pixel-parity/${game}`))
mkdirSync(out, { recursive: true })

function serve(dist: string) {
  const prefix = `/arcade/${game}/`
  const root = resolve(dist, `arcade/${game}`)
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path === `${prefix}api/stats`) return Response.json({ players: 0, games: 0 })
      if (!path.startsWith(prefix)) return new Response("Not found", { status: 404 })
      const file = resolve(root, decodeURIComponent(path.slice(prefix.length)) || "index.html")
      if (!file.startsWith(root + sep)) return new Response("Not found", { status: 404 })
      const asset = Bun.file(file)
      return (await asset.exists()) ? new Response(asset) : new Response("Not found", { status: 404 })
    },
  })
}

async function capture(browser: Browser, dist: string, name: string): Promise<Buffer> {
  const server = serve(dist)
  const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: dpr })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.addInitScript(() => {
    let s = 0x2545f491
    Math.random = () => ((s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 4294967296)
  })
  if (drive === "clock") {
    await page.clock.install({ time: 1_000_000 })
    await page.clock.pauseAt(1_000_000)
  }
  await page.goto(`http://127.0.0.1:${server.port}/arcade/${game}/?${query}`)
  if (drive === "advance") {
    await page.waitForFunction(() => typeof (globalThis as { advance?: unknown }).advance === "function", null, { timeout: 20_000 })
    await page.evaluate((ms) => (globalThis as unknown as { advance(ms: number): Promise<void> }).advance(ms), advance)
  } else if (drive === "bench") {
    type Bench = { ready: Promise<unknown>; reset(): void; step(i: number, dt: number, waitGpu: boolean): Promise<unknown> }
    await page.waitForFunction(() => (globalThis as { __getawayBench?: unknown }).__getawayBench, null, { timeout: 30_000 })
    await page.evaluate(async (frames) => {
      const b = (globalThis as unknown as { __getawayBench: Bench }).__getawayBench
      await b.ready
      b.reset()
      for (let i = 0; i < frames; i++) await b.step(i, 1 / 30, true)
    }, Math.round(advance / (1000 / 30)))
  } else {
    // Let the page load and compile on real time while the fake clock holds, then run it.
    await page.waitForTimeout(4000)
    await page.clock.runFor(advance)
    // Renderers that drop frames while one is in flight may not have drawn the last tick: one more frame, GPU idle.
    await page.waitForTimeout(500)
    await page.clock.runFor(17)
    await page.waitForTimeout(500)
  }
  const canvasSize = await page.evaluate(() => {
    const c = [...document.querySelectorAll("canvas")].sort((a, b) => b.width * b.height - a.width * a.height)[0]!
    return `${c.width}×${c.height}`
  })
  console.log(`${name}: canvas ${canvasSize}`)
  const view = page.locator("canvas#view")
  const png = await ((await view.count()) ? view : page.locator("canvas").first()).screenshot()
  await Bun.write(join(out, `${name}.png`), png)
  await page.close()
  server.stop(true)
  if (errors.length) throw Error(`${name}: ${errors.join("; ")}`)
  return png
}

const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
try {
  const a = await capture(browser, baseDir, "base")
  const b = await capture(browser, headDir, "head")
  const page = await browser.newPage()
  const diff = await page.evaluate(
    async ([x, y]) => {
      const load = async (b64: string) => {
        const img = new Image()
        img.src = `data:image/png;base64,${b64}`
        await img.decode()
        const c = new OffscreenCanvas(img.width, img.height)
        const g = c.getContext("2d")!
        g.drawImage(img, 0, 0)
        return g.getImageData(0, 0, img.width, img.height)
      }
      const [p, q] = [await load(x), await load(y)]
      if (p.width !== q.width || p.height !== q.height) return { pixels: -1, total: 0, max: 255 }
      let pixels = 0
      let max = 0
      for (let i = 0; i < p.data.length; i += 4) {
        let d = 0
        for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(p.data[i + k]! - q.data[i + k]!))
        if (d) pixels++
        max = Math.max(max, d)
      }
      return { pixels, total: p.width * p.height, max }
    },
    [a.toString("base64"), b.toString("base64")] as const,
  )
  const result = { game, query, advance, ...diff, identical: diff.pixels === 0 }
  await Bun.write(join(out, "result.json"), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
  if (!result.identical) process.exitCode = 1
} finally {
  await browser.close()
}
