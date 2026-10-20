// Pixel-identity proof: capture deterministic stills from a pixel build (bench/pixel/snap.sh) and diff two sets.
//
//   bun bench/pixel/run.ts capture <pixel build dir> <out dir> [--frames 128 (a multiple of 64)] [--size 1280x720] [--q &extra=params]
//   (`releaseGeometry` is always passed so the after build frees CPU geometry as the game does)
//   bun bench/pixel/run.ts compare <out dir A> <out dir B>
//
// Capture: one page, every camera rendered at the same virtual time with the same random seed (see capture.ts).
// Compare: per camera, the number of differing bytes, the largest per-channel difference and the share of pixels
// that differ by more than 1 LSB.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { arg, launch, serve } from "../lib"

const [mode, a, b] = process.argv.slice(2)
const args = process.argv.slice(2)

const Y3 = 0.15 + 3 * 3.8
const CAMS = [
  { name: "lot", view: "lot" },
  { name: "gate", view: "gate" },
  { name: "road", view: "road" },
  { name: "entrance", view: "entrance" },
  { name: "lobby", view: "lobby" },
  { name: "corridor", view: "corridor" },
  { name: "dock", view: "dock" },
  { name: "forest", view: "forest" },
  { name: "s3-spine", pos: [-12, Y3, 1.1], yaw: Math.PI / 2, pitch: 0 },
  { name: "s3-spine-east", pos: [10, Y3, 1.1], yaw: -Math.PI / 2, pitch: 0 },
  { name: "3-08", pos: [3.4, Y3, -3.6], yaw: 2.6, pitch: -0.05 },
  { name: "3-08-booth", pos: [8.45, Y3, -12.45], yaw: 0.05, pitch: -0.2 },
  { name: "truck-shed", pos: [-51.5, 0.06, -35.9], yaw: -Math.PI / 2 + 0.25, pitch: 0 },
]

if (mode === "capture") {
  const frames = Number(arg(args, "frames", "128"))
  const [w, h] = arg(args, "size", "1280x720")!.split("x").map(Number) as [number, number]
  mkdirSync(b!, { recursive: true })
  const server = serve(a!, 5228, { isolate: false })
  const browser = await launch()
  const page = await browser.newPage({ viewport: { width: w, height: h } })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.goto(`http://localhost:5228/capture.html?shot&view=lot&releaseGeometry${arg(args, "q", "")}`)
  await page.waitForFunction(() => (globalThis as any).__pixel?.ready, undefined, { timeout: 400_000, polling: 500 })
  await page.evaluate(({ cams, frames }) => (globalThis as any).__pixel.run(cams, frames), { cams: CAMS, frames })
  for (const c of CAMS) {
    const s = (await page.evaluate((n) => (globalThis as any).__pixel.shots[n], c.name)) as string
    const [dim, data] = s.split(":") as [string, string]
    writeFileSync(`${b}/${c.name}.${dim}.rgba`, Buffer.from(data, "base64"))
  }
  const errs = await page.evaluate(() => (globalThis as any).__pixel.errors)
  console.log(`captured ${CAMS.length} cameras into ${b}`, errors.concat(errs).slice(0, 5))
  await browser.close()
  server.stop(true)
  process.exit(0)
}

if (mode === "compare") {
  const files = readdirSync(a!).filter((f) => f.endsWith(".rgba")).sort()
  let worst = 0
  const rows: string[] = []
  for (const f of files) {
    const x = readFileSync(`${a}/${f}`)
    let y: Buffer
    try {
      y = readFileSync(`${b}/${f}`)
    } catch {
      rows.push(`${f}: missing in B`)
      worst = 255
      continue
    }
    let diffBytes = 0
    let max = 0
    let over1 = 0
    for (let i = 0; i < x.length; i += 4) {
      let pxOver = false
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(x[i + c]! - y[i + c]!)
        if (d) diffBytes++
        if (d > max) max = d
        if (d > 1) pxOver = true
      }
      if (pxOver) over1++
    }
    worst = Math.max(worst, max)
    rows.push(`${f.split(".")[0]!.padEnd(16)} differing bytes ${String(diffBytes).padStart(8)}  max Δ ${String(max).padStart(3)}  pixels Δ>1 ${over1} (${((over1 / (x.length / 4)) * 100).toFixed(4)}%)`)
  }
  console.log(rows.join("\n"))
  console.log(`worst max Δ: ${worst}`)
  process.exit(0)
}
console.error("usage: run.ts capture|compare …")
process.exit(1)
