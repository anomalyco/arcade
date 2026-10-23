import { type Page } from "playwright-core"
import { browserBudget } from "../../../scripts/browser-budget"
import { mkdir, readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { serveDist } from "./serve-dist"

await using budget = browserBudget()
const { chromium } = budget

// Sodium lamp paint-over captures, headless and muted, through HiveMind browser admission:
//   bun scripts/capture-lamps.ts [--lot <url>] [--ashwood <url>] [--dist <dir>] [--tag <name>] [--set k=v ...] [--measure]
// Stills of the lamp hero cameras and the title camera from the Lot (a URL, or a local dist) and from Ashwood's
// debug server at the same pose. `--set lamp.mode=today` applies a Lot setting path before capture. `--measure`
// records paired whole-frame GPU timings, lamps Today vs the tagged settings.
const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }
const out = resolve(process.env.LOT_CAPTURE_DIR ?? "captures/lamps")
await mkdir(out, { recursive: true })
const tag = arg("--tag") ?? "lot"
const dist = arg("--dist")
const local = dist ? serveDist(resolve(dist)) : null
const lotUrl = local ? new URL("/arcade/lot/", local.url).href : arg("--lot")
const ashwoodUrl = arg("--ashwood")
const sets = process.argv.flatMap((a, i) => a === "--set" ? [process.argv[i + 1]!] : []).map(s => { const [k, v] = s.split("="); return [k!, v!] as const })

/** Eye x, height, z, yaw, pitch, fov (Ashwood's YXZ convention; Lot's FirstPerson matches). */
export const SHOTS = {
  // Under and beside the booth's cobra head, looking up at it with the facility behind.
  hero: [8.6, 1.7, 135.8, 0.57, 0.42, 68],
  // The same head from further back: pole, booth and pool in one frame.
  booth: [9.4, 1.7, 138.2, 0.48, 0.36, 68],
  // Beside the shadowed davit on the approach road.
  road: [4.2, 1.7, 217.5, 0.24, 0.42, 68],
  // Ashwood's title drift at t = 8 s (world.ts START).
  title: [-2.5 + 2.2 * Math.sin(8 * 0.021), 1.9 + 0.15 * Math.sin(8 * 0.031), 154 + 5 * Math.sin(8 * 0.013 + 1), -0.05 + 0.05 * Math.sin(8 * 0.017 + 0.5), 0.035 + 0.008 * Math.sin(8 * 0.027), 68],
} as const
const only = arg("--shots")?.split(",") ?? Object.keys(SHOTS)

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = (await readdir(cache)).filter(n => /^chromium_headless_shell-/.test(n)).sort().reverse()
  .map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
if (!executablePath) throw new Error("Headless Chromium missing")
const browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio", "--enable-webgpu-developer-features"] })
const report: Record<string, unknown> = { viewport: [1920, 1080], captured: new Date().toISOString(), shots: SHOTS, sets }
type Lot = { ready: boolean; frames: number; paused: boolean; renderer: { passContext: { device: GPUDevice } }; measureLamps?: (rounds: number) => Promise<unknown> }

async function open(url: string, errors: string[]) {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true })
  const page = await context.newPage()
  page.on("pageerror", e => errors.push(e.stack ?? e.message))
  page.on("console", m => { if (m.type() === "error") errors.push(`${m.text()} (${m.location().url})`) })
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 })
  return { page, context }
}
const pose = (s: readonly number[]) => s.join(",")
const setPaths = (page: Page) => page.evaluate(sets => {
  const lot = (window as unknown as { lot: Record<string, unknown> }).lot
  for (const [path, value] of sets) {
    const keys = path.split("."), last = keys.pop()!
    let o = lot as Record<string, unknown>
    for (const k of keys) o = o[k] as Record<string, unknown>
    const n = Number(value)
    o[last] = value === "true" ? true : value === "false" ? false : Number.isFinite(n) && value !== "" ? n : value
  }
}, sets)

for (const name of only) {
  const shot = SHOTS[name as keyof typeof SHOTS]
  if (lotUrl) {
    const errors: string[] = []
    const url = new URL(lotUrl); url.searchParams.set("cam", pose(shot))
    const { page, context } = await open(url.href, errors)
    await page.waitForFunction(() => { const w = window as unknown as { lot?: Lot }; return w.lot?.ready && w.lot.frames > 30 }, undefined, { timeout: 180_000 })
    await setPaths(page)
    await page.evaluate(async () => { const lot = (window as unknown as { lot: Lot }).lot, start = lot.frames; while (lot.frames < start + 90) await new Promise(r => requestAnimationFrame(r)) })
    await page.addStyleTag({ content: "#hud,#credits,[data-lab-panel]{display:none!important}" })
    await page.evaluate(async () => { const lot = (window as unknown as { lot: Lot }).lot; lot.paused = true; await lot.renderer.passContext.device.queue.onSubmittedWorkDone(); await new Promise(r => requestAnimationFrame(r)) })
    await page.screenshot({ path: resolve(out, `${tag}-${name}.png`), timeout: 60_000 })
    if (process.argv.includes("--measure") && name === "title") {
      await page.evaluate(() => { (window as unknown as { lot: Lot }).lot.paused = false })
      report.gpu = await page.evaluate(() => (window as unknown as { lot: Lot }).lot.measureLamps?.(40))
    }
    report[`${tag}-${name}`] = { url: url.href, errors }
    await context.close()
  }
  if (ashwoodUrl) {
    const errors: string[] = []
    const url = new URL(ashwoodUrl); url.searchParams.set("cam", pose(shot)); url.searchParams.set("view", "gate"); url.searchParams.set("shot", "1")
    const { page, context } = await open(url.href, errors)
    await page.waitForFunction(() => (globalThis as { __afterhours?: { complete: boolean } }).__afterhours?.complete, undefined, { timeout: 240_000 })
    await page.waitForTimeout(Number(arg("--ashwood-wait") ?? 4000))
    await page.screenshot({ path: resolve(out, `ashwood-${name}.png`), timeout: 60_000 })
    report[`ashwood-${name}`] = { url: url.href, errors }
    await context.close()
  }
}
await browser.close()
local?.stop()
await Bun.write(resolve(out, `report-${tag}.json`), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
