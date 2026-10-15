// Fixed-seed game captures for refactors that must not change what the game draws.
//
//   bun scripts/parity-capture.ts --label before        build, pose, capture → captures/parity/before/
//   bun scripts/parity-capture.ts --label after
//   bun scripts/parity-capture.ts --compare captures/parity/before captures/parity/after
//
// Each label runs headless Metal Chromium (muted) against a production build, freezes the clock, poses the survivor at
// fixed spots for two seeds, steps the sim a fixed number of ticks and screenshots. --compare diffs every pair in a
// headless page and reports the share of pixels that differ. Run both labels on the same worker (hivemind --worker).
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { chromium, type Browser } from "playwright-core"

const argv = process.argv.slice(2)
const option = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
const game = resolve(import.meta.dir, "..")

function launch(): Promise<Browser> {
  const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
  const chrome = readdirSync(cache)
    .filter((n) => /^chromium-\d+$/.test(n))
    .sort()
    .reverse()
    .map((n) => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`)
    .find(existsSync)
  assert(chrome, "Install Chromium before the capture")
  return chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
  })
}

type Pose = { name: string; x: number; y: number; aim: number; hour: number; zoom: number }
const POSES: Pose[] = [
  { name: "dusk-street", x: 42, y: 43, aim: -0.7, hour: 18, zoom: 58 },
  { name: "house-interior", x: 31, y: 34, aim: 0.3, hour: 18, zoom: 38 },
  { name: "spawn-noon", x: 27.7, y: 41, aim: -Math.PI / 2, hour: 12, zoom: 46 },
  { name: "night-lamps", x: 42, y: 43, aim: -0.7, hour: 0, zoom: 58 },
  { name: "night-flashlight", x: 30, y: 38, aim: 0.9, hour: 23, zoom: 40 },
]
const SEEDS = [7, 1234]

async function capture(label: string): Promise<void> {
  const out = resolve(game, "../../captures/parity", label)
  mkdirSync(out, { recursive: true })
  const build = Bun.spawnSync(["bun", "run", "build"], { cwd: game, stdout: "inherit", stderr: "inherit" })
  assert.equal(build.exitCode, 0)
  const root = resolve(game, "dist/arcade/outbreak")
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      const file = Bun.file(resolve(root, `.${path === "/" ? "/index.html" : path}`))
      return (await file.exists()) ? new Response(file) : new Response("Not found", { status: 404 })
    },
  })
  const browser = await launch()
  const manifest: Record<string, unknown> = {}
  try {
    for (const seed of SEEDS) {
      const page = await browser.newPage({ viewport: { width: 960, height: 640 }, deviceScaleFactor: 1 })
      const errors: string[] = []
      page.on("pageerror", (e) => errors.push(e.message))
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text())
      })
      await page.goto(`http://127.0.0.1:${server.port}/?solo&seed=${seed}&bench`, { waitUntil: "networkidle" })
      await page.waitForFunction(() => (window as any).__arcadeHarness?.ready)
      // Baked rugs arrive from a Worker whenever it finishes, so a frame may or may not have them: draw flat rugs.
      await page.evaluate(() => (window as any).__arcadeHarness.setInterior("rugSource", 2))
      for (const pose of POSES) {
        const state = await page.evaluate(async (p) => {
          const h = (window as any).__arcadeHarness
          h.setLab("timeScale", 0)
          h.setLab("hour", p.hour)
          h.setLab("zoom", p.zoom)
          h.pose(p.x, p.y, p.aim)
          for (let i = 0; i < 12; i++) await h.step()
          const s = h.state()
          return { hour: s.dayCycle.hour, chunk: s.world.chunk, explored: s.explored }
        }, pose)
        const name = `seed${seed}-${pose.name}`
        // The HUD eases on wall-clock CSS transitions; let them land so a frame never catches one mid-way.
        await page.waitForTimeout(800)
        await page.screenshot({ path: join(out, `${name}.png`), animations: "disabled" })
        manifest[name] = state
      }
      manifest[`seed${seed}-errors`] = errors
      await page.close()
    }
  } finally {
    await browser.close()
    server.stop(true)
  }
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 1))
  console.log(`parity-capture: ${Object.keys(manifest).length} entries → ${out}`)
}

async function compare(a: string, b: string): Promise<void> {
  const names = readdirSync(a).filter((n) => n.endsWith(".png") && !n.endsWith(".diff.png")).sort()
  assert(names.length > 0, `no captures in ${a}`)
  const browser = await launch()
  const page = await browser.newPage()
  const rows: string[] = []
  let worst = 0
  try {
    for (const name of names) {
      const left = readFileSync(join(a, name)).toString("base64")
      const right = existsSync(join(b, name)) ? readFileSync(join(b, name)).toString("base64") : null
      if (!right) {
        rows.push(`${name}: missing in ${b}`)
        worst = 1
        continue
      }
      const { share, mask } = await page.evaluate(
        async ({ left, right }) => {
          const load = async (src: string) => {
            const img = new Image()
            img.src = `data:image/png;base64,${src}`
            await img.decode()
            const c = new OffscreenCanvas(img.width, img.height)
            const g = c.getContext("2d")!
            g.drawImage(img, 0, 0)
            return g.getImageData(0, 0, img.width, img.height)
          }
          const [p, q] = await Promise.all([load(left), load(right)])
          if (p.data.length !== q.data.length) return { share: 1, mask: null }
          const mask = new ImageData(p.width, p.height)
          let differ = 0
          for (let i = 0; i < p.data.length; i += 4) {
            const d = Math.abs(p.data[i]! - q.data[i]!) + Math.abs(p.data[i + 1]! - q.data[i + 1]!) + Math.abs(p.data[i + 2]! - q.data[i + 2]!)
            mask.data[i] = d > 6 ? 255 : p.data[i]! * 0.3
            mask.data[i + 1] = p.data[i + 1]! * 0.3
            mask.data[i + 2] = p.data[i + 2]! * 0.3
            mask.data[i + 3] = 255
            if (d > 6) differ++
          }
          if (!differ) return { share: 0, mask: null }
          const c = new OffscreenCanvas(p.width, p.height)
          c.getContext("2d")!.putImageData(mask, 0, 0)
          const blob = await c.convertToBlob({ type: "image/png" })
          const bytes = new Uint8Array(await blob.arrayBuffer())
          let bin = ""
          for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!)
          return { share: differ / (p.data.length / 4), mask: btoa(bin) }
        },
        { left, right },
      )
      if (mask) writeFileSync(join(b, name.replace(/\.png$/, ".diff.png")), Buffer.from(mask, "base64"))
      worst = Math.max(worst, share)
      rows.push(`${name}: ${(share * 100).toFixed(3)}% pixels differ`)
    }
  } finally {
    await browser.close()
  }
  const ma = existsSync(join(a, "manifest.json")) ? readFileSync(join(a, "manifest.json"), "utf8") : ""
  const mb = existsSync(join(b, "manifest.json")) ? readFileSync(join(b, "manifest.json"), "utf8") : ""
  console.log(rows.join("\n"))
  console.log(`manifest ${ma === mb ? "identical" : "DIFFERS"}; worst ${(worst * 100).toFixed(3)}% pixels differ`)
}

const cmp = argv.indexOf("--compare")
if (cmp >= 0) await compare(resolve(argv[cmp + 1]!), resolve(argv[cmp + 2]!))
else await capture(option("--label") ?? "capture")
