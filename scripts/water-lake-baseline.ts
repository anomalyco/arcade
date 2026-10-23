/** Read-only capture of the woods owner's preview; no changes to their worktree. */
import { browserBudget } from "./browser-budget"
await using budget = browserBudget()
const { chromium } = budget
import { mkdirSync } from "node:fs"
import { hostname } from "node:os"

if (!hostname().startsWith("aak2-2")) throw Error("Water proof must run on mini")
const out = "captures/water/lake"
mkdirSync(out, { recursive: true })
type Woods = {
  ready: boolean; paused: boolean; frames: number
  world: { lake: { x: number; z: number; rx: number; rz: number; level: number }; camp: { x: number; z: number } }
  camera: { flashlight: boolean }; look: Record<string, unknown>
  setPose(x: number, z: number, yaw: number, pitch: number): void
  step(ms: number): void
  renderer: { device: GPUDevice }
}
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
  await page.goto(process.env.WATER_WOODS_URL ?? "http://127.0.0.1:15322/arcade/woods/?quality=high", { waitUntil: "domcontentloaded" })
  await page.waitForFunction(() => (globalThis as unknown as { woods?: Woods }).woods?.ready, null, { timeout: 120_000 })
  const pose = await page.evaluate(() => {
    const w = (globalThis as unknown as { woods: Woods }).woods
    const start = document.getElementById("start")
    if (start) start.style.display = "none"
    w.paused = true
    const l = w.world.lake
    // End of the existing north-shore dock, looking across the lake.
    const pose = { x: w.world.camp.x + 4, z: l.z - l.rz + 10, yaw: Math.PI, pitch: -0.12 }
    w.setPose(pose.x, pose.z, pose.yaw, pose.pitch)
    w.camera.flashlight = true
    return { pose, lake: l, look: w.look }
  })
  for (let i = 0; i < 90; i++) await page.evaluate(() => (globalThis as unknown as { woods: Woods }).woods.step(1000 / 60))
  await page.locator("canvas").first().screenshot({ path: `${out}/woods-today.png` })
  await Bun.write(`${out}/baseline.json`, JSON.stringify({ url: page.url(), hostname: hostname(), viewport: page.viewportSize(), ...pose, errors }, null, 2))
  if (errors.length) throw Error(errors.join("\n"))
} finally { await browser.close() }
