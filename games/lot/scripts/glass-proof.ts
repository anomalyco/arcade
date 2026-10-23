import { type Page } from "playwright-core"
import { browserBudget } from "../../../scripts/browser-budget"
import { mkdir, readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { serveDist } from "./serve-dist"

await using budget = browserBudget()
const { chromium } = budget

// Glass, lit-window rooms and contact shadows: Today vs new stills at fixed poses, Ashwood at the same poses, and the
// paired in-page GPU cost of each feature (Renderer.measure, alternating A/B rounds). Headless and muted; run through
// HiveMind browser admission after `bun run build`:
//   hivemind run --kind browser --browser-approval "…" -- bun scripts/glass-proof.ts [--no-ashwood] [--no-timing] [--swiftshader]
const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const out = resolve(process.env.LOT_CAPTURE_DIR ?? "captures/glass")
await mkdir(out, { recursive: true })
const swift = flag("--swiftshader")

/** x, eye height, z, yaw, pitch, fov (Three's YXZ, the compare page's `cam`). */
const POSES: Record<string, readonly [number, number, number, number, number, number]> = {
  title: [-2.132, 1.937, 158.47, -0.0203, 0.0367, 68],
  booth: [3.2, 1.7, 137, -0.52, -0.04, 68],
  boothNear: [6.4, 1.65, 132.2, -0.6, -0.06, 60],
  windows: [8, 1.7, 44, 0.05, 0.28, 68],
  contact: [7.6, 1.65, 133.2, -0.62, -0.36, 68],
}
const poses = swift ? ["boothNear"] : Object.keys(POSES)
type Modes = { glass: "today" | "thin"; rooms: "today" | "rooms"; contact: "today" | "screen" }
const TODAY: Modes = { glass: "today", rooms: "today", contact: "today" }
const ALL: Modes = { glass: "thin", rooms: "rooms", contact: "screen" }

const dist = resolve(import.meta.dir, "../dist")
const server = serveDist(dist)
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = (await readdir(cache)).filter(n => /^chromium_headless_shell-/.test(n)).sort().reverse()
  .map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
if (!executablePath) throw new Error("Headless Chromium shell is missing")
const browser = await chromium.launch({ executablePath, headless: true, args: swift
  ? ["--enable-unsafe-webgpu", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--enable-features=Vulkan", "--use-vulkan=swiftshader", "--mute-audio"]
  : ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const viewport = swift ? { width: 640, height: 360 } : { width: 1920, height: 1080 }
const errors: string[] = []
const report: Record<string, unknown> = { viewport, gpu: swift ? "swiftshader" : "metal", poses: {}, errors }

type Lot = { camera: { body: { x: number; y: number }; height: number; yaw: number; pitch: number; fov: number }; glass: { mode: string }; rooms: { mode: string }; contact: { mode: string }; frames: number; paused: boolean; ready: boolean; measureFrames: (n: number) => Promise<{ median: number; samples: number[] } | null>; renderer: { passContext: { device: GPUDevice } } }

async function open(url: string): Promise<Page> {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 })
  page.on("pageerror", e => errors.push(`${url}: ${e.message}`))
  page.on("console", m => { if (m.type() === "error") errors.push(`${url}: ${m.text()}`) })
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 })
  return page
}
const frames = (page: Page, n: number) => page.evaluate(async n => {
  const lot = (window as unknown as { lot: Lot }).lot
  const start = lot.frames
  while (lot.frames < start + n) await new Promise(r => setTimeout(r, 16))
}, n)
const setModes = (page: Page, m: Modes) => page.evaluate(m => { const lot = (window as unknown as { lot: Lot }).lot; lot.glass.mode = m.glass; lot.rooms.mode = m.rooms; lot.contact.mode = m.contact }, m)
async function still(page: Page, file: string) {
  await page.evaluate(async () => { const lot = (window as unknown as { lot: Lot }).lot; lot.paused = true; await lot.renderer.passContext.device.queue.onSubmittedWorkDone(); await new Promise<void>(r => requestAnimationFrame(() => r())) })
  await page.screenshot({ path: resolve(out, file), timeout: 120_000 })
  await page.evaluate(() => { (window as unknown as { lot: Lot }).lot.paused = false })
}

try {
  const page = await open(new URL("/arcade/lot/", server.url).href)
  await page.waitForFunction(() => { const w = window as unknown as { lot?: Lot }; return w.lot?.ready && w.lot.frames > (2) }, undefined, { timeout: 600_000 })
  await page.addStyleTag({ content: "#hud,#credits,[data-lab-panel]{display:none!important}" })
  for (const name of poses) {
    const pose = POSES[name]!
    await page.evaluate(p => { const c = (window as unknown as { lot: Lot }).lot.camera; c.body.x = p[0]; c.height = p[1]; c.body.y = p[2]; c.yaw = p[3]; c.pitch = p[4]; c.fov = p[5] }, pose)
    const entry: Record<string, unknown> = { pose }
    if (swift) {
      // Software GPU: wall clock per presented frame, Today vs everything on (CI smoke itself stays Today).
      const wall = async (m: Modes) => { await setModes(page, m); await frames(page, 2); const t0 = await page.evaluate(() => performance.now()); await frames(page, 3); return (await page.evaluate(() => performance.now()) - t0) / 3 }
      const rounds: { today: number; all: number }[] = []
      for (let r = 0; r < 3; r++) rounds.push({ today: await wall(TODAY), all: await wall(ALL) })
      entry.swiftshaderFrameMs = rounds
      await setModes(page, ALL); await frames(page, 2); await still(page, `${name}-swiftshader-all.png`)
    } else {
      for (const [variant, m] of [["today", TODAY], ["glass", { ...TODAY, glass: "thin", rooms: "rooms" }], ["all", ALL]] as const) {
        await setModes(page, m as Modes)
        await frames(page, 70)
        await still(page, `${name}-${variant}.png`)
      }
      if (!flag("--no-timing")) {
        const timing: Record<string, unknown> = {}
        for (const [feature, on] of [["glass", { ...TODAY, glass: "thin" }], ["rooms", { ...TODAY, rooms: "rooms" }], ["contact", { ...TODAY, contact: "screen" }], ["all", ALL]] as const) {
          const a: number[] = [], b: number[] = []
          // The loop is paused while measuring; each timed frame follows warm-up frames (Lot measure). Shared workers'
          // GPU work and clock drops only ever add time, so the estimate is the low tail of all samples, not a median.
          const sample = () => page.evaluate(async () => {
            const lot = (window as unknown as { lot: Lot }).lot
            lot.paused = true
            const s = (await lot.measureFrames(12))!.samples
            lot.paused = false
            return s
          })
          for (let r = 0; r < 6; r++) {
            await setModes(page, TODAY); await frames(page, 8)
            a.push(...await sample())
            await setModes(page, on as Modes); await frames(page, 8)
            b.push(...await sample())
          }
          const q = (x: number[], p: number) => [...x].sort((m, n) => m - n)[Math.floor((x.length - 1) * p)]!
          timing[feature] = { today: { min: q(a, 0), p10: q(a, 0.1), p50: q(a, 0.5) }, on: { min: q(b, 0), p10: q(b, 0.1), p50: q(b, 0.5) }, deltaMin: q(b, 0) - q(a, 0), deltaP10: q(b, 0.1) - q(a, 0.1), rounds: { today: a, on: b } }
        }
        entry.timing = timing
        console.log(name, JSON.stringify(timing, (k, v) => (k === "rounds" ? undefined : typeof v === "number" ? +v.toFixed(3) : v)))
      }
    }
    ;(report.poses as Record<string, unknown>)[name] = entry
  }
  await page.close()
  if (!swift && !flag("--no-ashwood")) for (const name of poses) {
    const url = new URL(process.env.ASHWOOD_URL ?? "https://studio.taila8e7c7.ts.net:5253/")
    url.searchParams.set("view", "gate"); url.searchParams.set("shot", "1"); url.searchParams.set("cam", POSES[name]!.join(","))
    const ash = await open(url.href)
    await ash.waitForFunction(() => { const s = (globalThis as { __afterhours?: { ready: boolean; frames: number } }).__afterhours; return s?.ready && s.frames > 120 }, undefined, { timeout: 300_000 })
    await ash.addStyleTag({ content: "#hud,.hint,[data-lab-panel],.lab,#loader{display:none!important}" })
    await ash.screenshot({ path: resolve(out, `${name}-ashwood.png`), timeout: 60_000 })
    await ash.close()
  }
  console.log("Captured", out)
} finally {
  await Bun.write(resolve(out, swift ? "swiftshader.json" : "capture.json"), JSON.stringify(report, null, 2))
  await browser.close()
  server.stop(true)
}
if (errors.length) throw new Error(errors.join("\n"))
