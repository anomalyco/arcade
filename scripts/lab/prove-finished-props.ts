/// <reference types="@webgpu/types" />
// The Lab world's Finished props preset (`@arcade/kit/gpu/finish`, six wear looks on the driveway), headless Metal
// WebGPU, muted: one still with the wear and scans, one with the albedo check, and any page errors.
//   bun scripts/lab/prove-finished-props.ts [--out dir]
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import type { Page } from "playwright-core"
import { createServer } from "vite"
import { FINISHED_CAMERA } from "../../packages/kit/lab/world/scene"
import { browserBudget } from "../browser-budget"

await using budget = browserBudget()
const { chromium } = budget

const { values: flags } = parseArgs({ options: { out: { type: "string", default: resolve(import.meta.dir, "../../captures/finished-props") } } })
const out = resolve(flags.out!)
mkdirSync(out, { recursive: true })
const root = resolve(import.meta.dir, "../..")
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
  .map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
if (!executablePath) throw new Error("Playwright Chromium headless shell required")
const browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const dir = resolve(root, "games/lab")
const server = await createServer({ root: dir, configFile: resolve(dir, "vite.config.ts"), logLevel: "warn", server: { host: "127.0.0.1", port: 0 } })
await server.listen()
const addr = server.httpServer!.address()
if (!addr || typeof addr === "string") throw new Error("No port")

const invoke = async (page: Page, command: string, args: Record<string, unknown>) => {
  const res = await page.evaluate(([c, a]) => (window as any).lab.workbench.invoke(c, a), [command, args] as const)
  if (!res.ok) throw new Error(`${command} ${JSON.stringify(args)}: ${JSON.stringify(res)}`)
}
// Renders a task apart, so the scans' fetch and decode land between frames.
const settle = (page: Page, frames: number) => page.evaluate(async (n) => {
  const lab = (window as any).lab
  for (let i = 0; i < n; i++) { lab.advance(1 / 60); await lab.render(); await new Promise(r => setTimeout(r, 16)) }
}, frames)
const shot = (page: Page, name: string) => page.locator("canvas").first().screenshot({ path: resolve(out, `${name}.png`) })

const errors: string[] = []
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error" || m.type() === "warning") errors.push(m.text()) })
  await page.goto(`http://127.0.0.1:${addr.port}/arcade/lab/?bench#world`)
  await page.waitForFunction(() => !!(window as any).lab, undefined, { timeout: 60000 })
  await invoke(page, "world.preset", { preset: "finished-props" })
  await page.evaluate((c) => {
    const stage = (window as any).lab.context.stage
    stage.focus[0] = c.target[0]; stage.focus[1] = c.target[1]; stage.focus[2] = c.target[2]
    stage.camYaw = stage.targetYaw = c.yaw
    stage.camPitch = stage.targetPitch = c.pitch
    stage.camDist = stage.targetDist = c.dist
    stage.hasDampedTarget = false
    stage.camCustom = true
    stage.updateCamera()
  }, FINISHED_CAMERA)
  await settle(page, 90)
  await shot(page, "finished-props")
  await invoke(page, "world.set", { key: "wear.albedoCheck", value: true })
  await settle(page, 10)
  await shot(page, "albedo-check")
} finally {
  await browser.close()
  await server.close()
}
writeFileSync(resolve(out, "report.json"), JSON.stringify({ errors }, null, 2))
console.log(errors.length ? `errors:\n${errors.join("\n")}` : "no page errors")
