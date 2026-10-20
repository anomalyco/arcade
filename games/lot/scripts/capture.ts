import { chromium } from "playwright-core"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"

// One headless, muted run: reference + kit at the same eye/orientation/FOV.
// Run via HiveMind browser admission with Kit's explicit approval; never use for a screenshot tuning loop.
const out = resolve("captures/lot")
await mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 })
const report: Record<string, unknown> = { camera: { eye: [-26, 1.7, 114], yaw: -0.65, pitch: 0.1, fov: 68 }, viewport: [1400, 900], captured: new Date().toISOString() }
try {
  const names: ("kit" | "aiden")[] = process.argv.includes("--reference-only") ? ["aiden"] : ["kit", "aiden"]
  for (const name of names) {
    const page = await context.newPage()
    const errors: string[] = []
    page.on("pageerror", e => errors.push(e.message))
    page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
    const url = name === "kit" ? "https://studio.taila8e7c7.ts.net:5251/arcade/lot/" : "https://studio.taila8e7c7.ts.net:5252/?shot&view=lot&perf"
    console.log("Loading", name, url)
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 })
    await page.waitForFunction(name => {
      const w = window as unknown as { lot?: { ready: boolean; frames: number }; __afterhours?: { complete: boolean; frames: number } }
      return name === "kit" ? w.lot?.ready && w.lot.frames > 12 : w.__afterhours?.complete && w.__afterhours.frames > 12
    }, name, { timeout: 150_000, polling: 200 })
    if (name === "aiden") await page.evaluate(() => {
      const w = window as unknown as { __afterhoursPlayer: { pos: { x: number; y: number; z: number }; yaw: number; pitch: number; resetMotion(): void; apply(): void }; __afterhoursDebug: { camera: { position: { set(x: number, y: number, z: number): void }; fov: number; updateProjectionMatrix(): void } } }
      const p = w.__afterhoursPlayer
      p.pos.x = -26; p.pos.z = 114; p.pos.y = 0; p.yaw = -0.65; p.pitch = 0.1; p.resetMotion(); p.apply()
      const camera = w.__afterhoursDebug.camera
      camera.position.set(-26, 1.7, 114); camera.fov = 68; camera.updateProjectionMatrix()
    })
    await page.addStyleTag({ content: "#hud,#credits,[data-lab-panel],.hint{display:none!important}" })
    await page.evaluate(() => new Promise<void>(resolve => {
      let n = 0
      const frame = () => { if (++n === 32) resolve(); else requestAnimationFrame(frame) }
      requestAnimationFrame(frame)
    }))
    await page.screenshot({ path: resolve(out, name + ".png") })
    report[name] = { url, errors }
    await Bun.write(resolve(out, "capture.json"), JSON.stringify(report, null, 2))
    if (name === "kit" && errors.length) throw new Error(errors.join("\n"))
    await page.close()
  }
  if (await Bun.file(resolve(out, "kit.png")).exists()) {
    const proc = Bun.spawn(["ffmpeg", "-y", "-i", resolve(out, "aiden.png"), "-i", resolve(out, "kit.png"), "-filter_complex", "hstack=inputs=2", "-frames:v", "1", resolve(out, "comparison.png")], { stdout: "ignore", stderr: "pipe" })
    if (await proc.exited !== 0) throw new Error(await new Response(proc.stderr).text())
  }
  console.log("Captured", out, JSON.stringify(report))
} catch (error) {
  report.failure = String(error)
  await Bun.write(resolve(out, "capture.json"), JSON.stringify(report, null, 2))
  throw error
} finally {
  await context.close()
  await browser.close()
}
