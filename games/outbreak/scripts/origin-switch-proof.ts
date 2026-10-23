/**
 * Origin build vs streamed window at the same pose: the streamed copy of the 96 m origin block must look the same as
 * the authored origin build, so the swap between them (when the camera nears the block edge) is invisible.
 *
 *   bun scripts/origin-switch-proof.ts [--skip-build] [--viewport 1728x1000] [--out captures/origin-switch]
 *
 * For each pose it draws the origin build, then forces the streamed window, and compares the frames at the same
 * session time: share of pixels that moved by more than 24 RGB levels in total, beauty and albedo. Writes the
 * frames, a diff image per pose and `report.json`. Headless Metal Chromium, muted, no visible window: run it through
 * `hivemind run --kind browser`.
 */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { type Page } from "playwright-core"
import { browserBudget } from "../../../scripts/browser-budget"

await using budget = browserBudget()
const { chromium } = budget

const game = resolve(import.meta.dir, "..")
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const out = resolve(game, "../..", arg("out", "captures/origin-switch")!)
const [vw, vh] = arg("viewport", "1728x1000")!.split("x").map(Number) as [number, number]
const limit = Number(arg("limit", "0.003"))
mkdirSync(out, { recursive: true })
if (!process.argv.includes("--skip-build")) assert.equal(Bun.spawnSync(["bun", "run", "build"], { cwd: game, stdout: "inherit", stderr: "inherit" }).exitCode, 0)
const root = resolve(game, "dist/arcade/outbreak")
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const path = new URL(req.url).pathname
  const file = Bun.file(resolve(root, `.${path === "/" ? "/index.html" : path}`))
  return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 })
} })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse().map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
assert(chrome, "Install Chromium first")

const only = arg("only")?.split(",")
const allPoses = [
  { name: "ash-porch-night", x: 27.7, y: 37.6, hour: 22 },
  { name: "ash-porch-day", x: 27.7, y: 37.6, hour: 13 },
  { name: "elm-porch-night", x: 27.7, y: 67.5, hour: 22 },
  { name: "crossroads-dusk", x: 44, y: 44, hour: 19 },
  { name: "stores-night", x: 62, y: 40, hour: 22 },
  // The camera footprint's west edge just inside x = 0 on a 1728 px window: where the automatic switch happens.
  { name: "ash-west-yard-night", x: 24.8, y: 40, hour: 22 },
  { name: "ash-inside-night", x: 25.2, y: 33, hour: 22 },
]
const poses = only ? allPoses.filter(p => only.includes(p.name)) : allPoses
const HUD = "#status, #hotbar, #stamina, #battery, #prompt, .callouts, .callout, .hud, #hud"

async function frame(page: Page, file: string, diagnostic: number, time: number): Promise<Buffer> {
  await page.evaluate(async a => {
    const h = (window as any).__arcadeHarness
    h.setLab("diagnostic", a.diagnostic)
    h.session().view.time = a.time
    await h.step(0)
  }, { diagnostic, time })
  return page.locator("#game").screenshot({ path: file })
}

/** Share of pixels that moved by more than 24 RGB levels in total; writes a ×4 amplified diff image. */
async function diff(page: Page, a: Buffer, b: Buffer, file: string): Promise<number> {
  const r = await page.evaluate(async ([a, b]) => {
    const load = async (b64: string) => {
      const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob())
      const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext("2d")!
      g.drawImage(bmp, 0, 0)
      return g.getImageData(0, 0, bmp.width, bmp.height)
    }
    const [ia, ib] = await Promise.all([load(a!), load(b!)])
    const c = new OffscreenCanvas(ia.width, ia.height), g = c.getContext("2d")!
    const d = g.createImageData(ia.width, ia.height)
    let changed = 0
    for (let i = 0; i < ia.data.length; i += 4) {
      const e = Math.abs(ia.data[i]! - ib.data[i]!) + Math.abs(ia.data[i + 1]! - ib.data[i + 1]!) + Math.abs(ia.data[i + 2]! - ib.data[i + 2]!)
      if (e > 24) changed++
      d.data[i] = d.data[i + 1] = d.data[i + 2] = Math.min(255, e * 4)
      d.data[i + 3] = 255
    }
    g.putImageData(d, 0, 0)
    const png = await (await c.convertToBlob({ type: "image/png" })).arrayBuffer()
    let bin = ""
    const u8 = new Uint8Array(png)
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000))
    return { changed: changed / (ia.data.length / 4), png: btoa(bin) }
  }, [a.toString("base64"), b.toString("base64")])
  await Bun.write(file, Buffer.from(r.png, "base64"))
  return r.changed
}

const report: Record<string, unknown> = { viewport: [vw, vh], limit, poses: {} as Record<string, unknown> }
const failures: string[] = []
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
try {
  const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
  await page.goto(`http://127.0.0.1:${fixture.port}/?solo&seed=7&bench&peaceful=1`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready)
  await page.evaluate(sel => { for (const el of document.querySelectorAll<HTMLElement>(sel)) el.style.visibility = "hidden" }, HUD)
  for (const pose of poses) {
    const settle = (stream: boolean) => page.evaluate(async a => {
      const h = (window as any).__arcadeHarness
      h.forceLevel(a.stream ? "streamed" : "origin")
      h.setLab("timeScale", 0)
      h.setLab("hour", a.pose.hour)
      h.pose(a.pose.x, a.pose.y, -Math.PI / 2)
      const t0 = performance.now()
      for (let i = 0; performance.now() - t0 < 10000; i++) {
        h.session().ai.agents.length = 0
        await h.step()
        const w = h.state().world
        if (i > 40 && w.pendingBakes === 0 && w.isStreamWindow === a.stream) break
        await new Promise(r => setTimeout(r, 10))
      }
      const s = h.state()
      return { streamed: s.world.isStreamWindow, vertices: Math.round(s.vertices), ...h.levelDraw(), time: h.session().view.time }
    }, { pose, stream })
    const origin = await settle(false)
    const t = origin.time
    const shots = {
      originBeauty: await frame(page, resolve(out, `${pose.name}-origin.png`), 0, t),
      originAlbedo: await frame(page, resolve(out, `${pose.name}-origin-albedo.png`), 1, t),
    }
    const streamed = await settle(true)
    const streamBeauty = await frame(page, resolve(out, `${pose.name}-streamed.png`), 0, t)
    const streamAlbedo = await frame(page, resolve(out, `${pose.name}-streamed-albedo.png`), 1, t)
    await page.evaluate(() => (window as any).__arcadeHarness.setLab("diagnostic", 0))
    const beauty = await diff(page, shots.originBeauty, streamBeauty, resolve(out, `${pose.name}-diff.png`))
    const albedo = await diff(page, shots.originAlbedo, streamAlbedo, resolve(out, `${pose.name}-diff-albedo.png`))
    const problems: string[] = []
    if (origin.streamed) problems.push("origin build not drawn")
    if (!streamed.streamed) problems.push("streamed window not drawn")
    if (beauty > limit) problems.push(`beauty frame changed ${(beauty * 100).toFixed(2)}%`)
    if (albedo > limit) problems.push(`albedo frame changed ${(albedo * 100).toFixed(2)}%`)
    ;(report.poses as Record<string, unknown>)[pose.name] = { pose, origin, streamed, beauty, albedo, problems }
    console.log(pose.name, problems.length ? `FAIL: ${problems.join("; ")}` : "ok", JSON.stringify({ beauty: +(beauty * 100).toFixed(3), albedo: +(albedo * 100).toFixed(3), vertices: [origin.vertices, streamed.vertices], drawn: [origin.drawn, streamed.drawn] }))
    for (const p of problems) failures.push(`${pose.name}: ${p}`)
  }
  report.errors = errors
  if (errors.length) failures.push(...errors.slice(0, 5).map(e => `page error: ${e}`))
} finally {
  writeFileSync(resolve(out, "report.json"), JSON.stringify(report, null, 2))
  await browser.close()
  fixture.stop()
}
console.log(out)
if (failures.length) {
  console.error(failures.join("\n"))
  await budget.exit(1)
}
