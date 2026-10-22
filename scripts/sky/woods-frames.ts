/** Actual woods frames, fixed cameras, headless and muted. Run under HiveMind browser admission. */
import { chromium } from "playwright-core"
import { mkdir, readdir, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
const out = resolve("captures/sky-baseline")
await mkdir(out, { recursive: true })
const url = process.argv[2] ?? "https://studio.taila8e7c7.ts.net:5298/arcade/woods/?bench=1"
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = (await readdir(cache)).filter(n => n.startsWith("chromium_headless_shell-")).sort().reverse().map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
if (!executablePath) throw new Error("Headless Chromium missing")
const browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio", "--enable-features=WebGPUExperimentalFeatures"] })
type Woods = {
  frames: number; paused: boolean; autoplay: boolean; setPose(x: number, z: number, yaw: number, pitch: number): void; step(ms: number): void
  world: { camp: { x: number; z: number; spawn: { x: number; z: number; yaw: number } }; lake: { x: number; z: number; rx: number; rz: number } }
  camera: { flashlight: boolean }; look: Record<string, unknown>
  view: { forest: { camera: unknown; renderer: { device: GPUDevice; passContext: { device: GPUDevice } } } }
}
const errors: string[] = []
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 })
  await page.waitForFunction(() => (window as unknown as { woods?: Woods }).woods?.frames! > 4, undefined, { timeout: 240000 })
  await page.evaluate(() => { (window as unknown as { woods: Woods }).woods.autoplay = true })
  await page.getByRole("button", { name: /Play alone/ }).waitFor({ state: "hidden" })
  await page.addStyleTag({ content: "#hud,[data-lab-panel]{visibility:hidden!important}" })
  const report: Record<string, unknown> = { url, viewport: [1920, 1080], errors }
  for (const shot of ["clearing-up", "lake"]) {
    report[shot] = await page.evaluate(async shot => {
      const w = (window as unknown as { woods: Woods }).woods
      w.paused = true
      w.camera.flashlight = false
      const c = w.world.camp, l = w.world.lake
      const pose = shot === "clearing-up" ? [c.spawn.x, c.spawn.z, c.spawn.yaw, 0.95] : [l.x, l.z + l.rz + 6, 0, 0.22]
      w.setPose(pose[0]!, pose[1]!, pose[2]!, pose[3]!)
      for (let i = 0; i < 60; i++) w.step(1000 / 60)
      await w.view.forest.renderer.passContext.device.queue.onSubmittedWorkDone()
      return { pose, look: w.look, camera: w.view.forest.camera }
    }, shot)
    await page.screenshot({ path: resolve(out, `${shot}-today.png`) })
  }
  await writeFile(resolve(out, "woods-frames.json"), JSON.stringify(report, null, 2))
} finally { await browser.close() }
if (errors.length) throw new Error(errors.join("\n"))
console.log(`Woods frames: ${out}`)
