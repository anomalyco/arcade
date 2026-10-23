// Life-around-you captures (seabirds, canopy rain) from a dev server: the real game offline on a
// fixed seed, the free camera on a flock, then heavy rain through the canopy-rain preview (no jet needed).
//
//   bun run dev:client   (or any dev server)  then   bun scripts/life-shot.ts --base=http://localhost:5197/ --out=/tmp/opencode/juice-life
//
// Options: --seed=7  --size=1536x960  --swiftshader (CI-style software WebGPU instead of the machine's GPU; on macOS the
// default is Chrome on Metal).
import type { Page } from "playwright-core"
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { browserBudget } from "../../../scripts/browser-budget"

await using budget = browserBudget()
const { chromium } = budget

const args = process.argv.slice(2)
const opt = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const base = opt("base", "http://localhost:5197/")
const out = opt("out", "/tmp/opencode/juice-life")
const seed = opt("seed", "7")
const [vw, vh] = opt("size", "1536x960").split("x").map(Number) as [number, number]
mkdirSync(out, { recursive: true })

const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const soft = args.includes("--swiftshader") || !existsSync(MAC_CHROME)
const browser = await chromium.launch({
  executablePath: soft ? undefined : MAC_CHROME,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--mute-audio", "--ignore-gpu-blocklist", ...(soft ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--enable-features=Vulkan", "--use-vulkan=swiftshader"] : ["--use-angle=metal", "--enable-features=WebGPU"])],
})
const page: Page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 })
page.on("pageerror", (e) => console.log(`pageerror: ${e.message}`))
page.on("console", (m) => m.type() === "error" && console.log(`console: ${m.text()}`))
await page.goto(new URL(`?seed=${seed}&tod=14&quality=high`, base).href, { waitUntil: "load" })
await page.waitForFunction(() => !!(globalThis as unknown as { carrier?: { arch?: unknown; life?: unknown } }).carrier?.arch, null, { timeout: 120_000 })
await page.waitForTimeout(4000)

type Flock = { x: number; z: number; scatter: number }
type Isl = { x: number; z: number }
type C = {
  game: { state: { free: boolean } }
  arch: { islands: Isl[] }
  camera: { set(v: { x: number; z: number; yaw: number; pitch: number; dist: number }): void }
  lab?: { force(kind: string, fade: number): void }
  life: { birds: { flocks: Flock[] }; canopyRain: { count: number }; settings: { canopyRain: { preview: number; previewSpeed: number } } }
}
const shot = async (name: string) => {
  await page.screenshot({ path: join(out, `${name}.png`) })
  console.log(`wrote ${name}.png`)
}

// Seabirds: the free camera close to the first flock, low, looking along the shore.
const flocks = await page.evaluate(() => (globalThis as unknown as { carrier: C }).carrier.life.birds.flocks)
console.log(`${flocks.length} flocks`)
const DEG = Math.PI / 180
const islands = await page.evaluate(() => (globalThis as unknown as { carrier: C }).carrier.arch.islands.map((i) => ({ x: i.x, z: i.z })))
for (const [i, f] of flocks.slice(0, 3).entries()) {
  // Stand out at sea looking along the shore past the flock (yaw 0 looks north, -z).
  const isl = islands.reduce((a, b) => (Math.hypot(b.x - f.x, b.z - f.z) < Math.hypot(a.x - f.x, a.z - f.z) ? b : a))
  const yaw = Math.atan2(isl.x - f.x, -(isl.z - f.z)) + Math.PI / 2
  await page.evaluate(([x, z, y, deg]) => {
    const c = (globalThis as unknown as { carrier: C }).carrier
    c.game.state.free = true
    c.camera.set({ x: x!, z: z!, yaw: y!, pitch: 8 * deg!, dist: 45 })
  }, [f.x, f.z, yaw, DEG])
  await page.waitForTimeout(2500)
  await shot(`birds-${i + 1}`)
}

// Canopy rain: heavy weather, the preview at 180 m/s through the canopy, then standing still, then the chase lens.
await page.evaluate(() => {
  const c = (globalThis as unknown as { carrier: C }).carrier
  c.lab?.force("heavy", 0)
  c.camera.set({ x: 300, z: -400, yaw: 0, pitch: 4 * (Math.PI / 180), dist: 30 })
  c.life.settings.canopyRain.preview = 1
  c.life.settings.canopyRain.previewSpeed = 180
})
await page.waitForTimeout(3500)
await shot("canopy-rain-fast")
await page.evaluate(() => {
  const c = (globalThis as unknown as { carrier: C }).carrier
  c.life.settings.canopyRain.previewSpeed = 0
})
await page.waitForTimeout(3500)
await shot("canopy-rain-still")
await page.evaluate(() => {
  const c = (globalThis as unknown as { carrier: C }).carrier
  c.life.settings.canopyRain.preview = 2
})
await page.waitForTimeout(8000)
await shot("lens-rain-chase")
await browser.close()
