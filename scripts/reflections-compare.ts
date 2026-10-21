import { chromium, type Page } from "playwright-core"
import { mkdir, readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

// Wet-road comparison: the Lot (built from this checkout) and Aiden's Ashwood preview at the same camera poses,
// 1920×1080, headless and muted. Run through HiveMind browser admission:
//   hivemind run --kind browser --browser-approval "…" -- bun scripts/reflections-compare.ts [--no-ashwood] [--variant name=query]
// Then `uv run --with pillow --with numpy scripts/reflections-crops.py <out>` crops the road and scores it.
// Ashwood is the local-only preview checkout on :5253 (`?view=gate&shot=1&cam=`); it is never modified.
const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const option = (name: string) => args.flatMap((a, i) => (a === name ? [args[i + 1]!] : []))
const out = resolve(option("--out")[0] ?? "captures/reflections/current")
await mkdir(out, { recursive: true })

/** x, eye height, z, yaw, pitch, fov: Three's YXZ convention, the compare page's `cam` query. */
export const POSES: Record<string, readonly [number, number, number, number, number, number]> = {
  title: [-2.132, 1.937, 158.47, -0.0203, 0.0367, 68],
  booth: [-1.5, 1.7, 141, -0.4, -0.18, 68],
  road: [-3.5, 1.7, 150, 0.25, -0.1, 68],
  gate: [0, 1.7, 145, -0.474, -0.1, 68],
  lamps: [1, 1.7, 122, 0.32, -0.05, 68],
}
const poses = option("--pose").length ? option("--pose") : Object.keys(POSES)
// name=assignments: Lot settings per variant (`window.lot` paths), e.g. today=ssr.mode=today&fog.reflection=4
const variants = option("--variant").map((v) => [v.slice(0, v.indexOf("=")), v.slice(v.indexOf("=") + 1)] as const)
if (!variants.length) variants.push(["lot", ""])

const dist = resolve(import.meta.dir, "../games/lot/dist")
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname)
    if (pathname.includes("..")) return new Response("Bad path", { status: 400 })
    const file = Bun.file(`${dist}${pathname}${pathname.endsWith("/") ? "index.html" : ""}`)
    return (await file.exists()) ? new Response(file) : new Response("Not found", { status: 404 })
  },
})
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = (await readdir(cache))
  .filter((n) => /^chromium_headless_shell-/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
if (!executablePath) throw new Error("Headless Chromium shell is missing")
const browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const report: Record<string, unknown> = { poses: {}, errors: [] as string[] }
const errors = report.errors as string[]

async function open(url: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
  page.on("pageerror", (e) => errors.push(`${url}: ${e.message}`))
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`${url}: ${m.text()}`)
  })
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 })
  return page
}

async function lot(name: string, variant: string, query: string, pose: readonly number[]) {
  const url = new URL("/arcade/lot/", server.url)
  url.searchParams.set("cam", pose.join(","))
  const page = await open(url.href)
  await page.waitForFunction(() => {
    const w = window as unknown as { lot?: { ready: boolean; frames: number } }
    return w.lot?.ready && w.lot.frames > 30
  }, undefined, { timeout: 180_000 })
  const start = await page.evaluate((assignments) => {
    const w = window as unknown as { lot: Record<string, unknown> & { frames: number } }
    for (const [path, raw] of assignments) {
      const keys = path.split(".")
      let target = w.lot as Record<string, unknown>
      for (const k of keys.slice(0, -1)) target = target[k] as Record<string, unknown>
      const old = target[keys.at(-1)!]
      target[keys.at(-1)!] = typeof old === "number" ? Number(raw) : typeof old === "boolean" ? raw === "true" : raw
    }
    return w.lot.frames
  }, [...new URLSearchParams(query)])
  await page.waitForFunction((f) => (window as unknown as { lot: { frames: number } }).lot.frames > f + 90, start, { timeout: 180_000 })
  await page.addStyleTag({ content: "#hud,#credits,[data-lab-panel]{display:none!important}" })
  const timing = flag("--timing") ? await page.evaluate(async () => {
    const w = window as unknown as { lot: { measure?: (n: number) => Promise<unknown> } }
    return w.lot.measure ? await w.lot.measure(24) : null
  }) : null
  await page.evaluate(async () => {
    const w = window as unknown as { lot: { paused: boolean; renderer: { passContext: { device: GPUDevice } } } }
    w.lot.paused = true
    await w.lot.renderer.passContext.device.queue.onSubmittedWorkDone()
    await new Promise<void>((r) => requestAnimationFrame(() => r()))
  })
  await page.screenshot({ path: resolve(out, `${name}-${variant}.png`), timeout: 60_000 })
  await page.close()
  return timing
}

async function ashwood(name: string, pose: readonly number[]) {
  const url = new URL(option("--ashwood-url")[0] ?? "https://studio.taila8e7c7.ts.net:5253/")
  url.searchParams.set("view", "gate")
  url.searchParams.set("shot", "1")
  url.searchParams.set("cam", pose.join(","))
  const page = await open(url.href)
  await page.waitForFunction(() => {
    const s = (globalThis as { __afterhours?: { ready: boolean; frames: number } }).__afterhours
    return s?.ready && s.frames > 120
  }, undefined, { timeout: 300_000 })
  await page.addStyleTag({ content: "#hud,.hint,[data-lab-panel],.lab,#loader{display:none!important}" })
  await page.screenshot({ path: resolve(out, `${name}-ashwood.png`), timeout: 60_000 })
  await page.close()
}

try {
  for (const name of poses) {
    const pose = POSES[name]
    if (!pose) throw new Error(`Unknown pose ${name}`)
    const timings: Record<string, unknown> = {}
    for (const [variant, query] of variants) timings[variant] = await lot(name, variant, query, pose)
    if (!flag("--no-ashwood")) await ashwood(name, pose)
    ;(report.poses as Record<string, unknown>)[name] = { pose, timings }
  }
  console.log("Captured", out)
} finally {
  await Bun.write(resolve(out, "capture.json"), JSON.stringify(report, null, 2))
  await browser.close()
  server.stop(true)
}
if (errors.length) throw new Error(errors.join("\n"))
