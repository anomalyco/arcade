import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { chromium, type Page } from "playwright-core"
import { createServer } from "vite"

/**
 * Onboarding proof (AR-89) in headless Metal Chromium, muted, no window:
 *   hivemind run --kind browser --fetch captures/outbreak-onboarding -- bun games/outbreak/scripts/onboarding-proof.ts
 * Stills of every E prompt state the clarity pass changes (verbs, outline, B and board pips, a boarded door, a hold
 * in progress, a stamp, familiar and Today), a still of each training-room beat's hint, and a muted clip of a scripted
 * walk through the training room out to the run. Writes captures/outbreak-onboarding/{proof.json,*.png,training.mp4}.
 */
const game = resolve(import.meta.dir, "..")
const out = resolve(game, "../../captures/outbreak-onboarding")
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const clipOnly = process.argv.includes("--clip-only")

const server = await createServer({ root: game, logLevel: "error", server: { host: "127.0.0.1", port: 0 } })
await server.listen()
const url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache).filter((n) => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
assert(executablePath, "Install Chromium for Playwright")
const browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const report: Record<string, unknown> = {}
const BEATS = ["move", "light", "search", "take", "craft", "door-open", "door-close", "crouch", "board", "sprint", "front-door", "melee"]

type Cmd = Record<string, unknown>

async function open(page: Page): Promise<void> {
  await page.goto(`${url}/?seed=7&bench`, { waitUntil: "networkidle", timeout: 240000 })
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, undefined, { timeout: 240000 })
  await page.evaluate(() => {
    localStorage.removeItem("arcade.outbreak.familiar")
    localStorage.removeItem("arcade.outbreak.training")
  })
}

const step = (page: Page, n: number, cmd: Cmd = {}) =>
  page.evaluate(async ({ n, cmd }) => {
    const h = (window as any).__arcadeHarness
    let s = h.state()
    for (let i = 0; i < n; i++) s = await h.step(1 / 60, cmd)
    return { onboarding: s.onboarding, promptClarity: s.promptClarity, prompt: document.querySelector("#prompt")?.textContent ?? "" }
  }, { n, cmd })

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
  page.setDefaultTimeout(120000)
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("404")) errors.push(m.text())
  })
  await open(page)
  report.adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
  const shot = (name: string) => page.screenshot({ path: join(out, `${name}.png`), timeout: 90000 })
  const beat = (b: string) => page.evaluate((b) => (window as any).__arcadeHarness.trainingBeat(b), b)
  const pose = (x: number, y: number, aim: number) => page.evaluate(({ x, y, aim }) => (window as any).__arcadeHarness.pose(x, y, aim), { x, y, aim })
  const lab = (k: string, v: unknown) => page.evaluate(({ k, v }) => (window as any).__arcadeHarness.setLab(k, v), { k, v })

  if (!clipOnly) {
    // Every training beat's hint.
    for (const b of BEATS) {
      assert.ok(await beat(b))
      const s = await step(page, 24)
      report[`beat:${b}`] = s.onboarding
      await shot(`beat-${String(BEATS.indexOf(b) + 1).padStart(2, "0")}-${b}`)
    }
    // Prompt states, in the training house.
    await beat("door-open")
    await pose(27.7, 28.9, Math.PI / 2)
    report["prompt:door"] = await step(page, 20, { aim: Math.PI / 2 })
    await shot("prompt-01-door-verbs-outline")
    report["prompt:door-hold"] = await step(page, 12, { aim: Math.PI / 2, interactHeld: true })
    await shot("prompt-02-door-hold-lock")
    await step(page, 30, { aim: Math.PI / 2 })
    await step(page, 1, { aim: Math.PI / 2, interact: true })
    report["prompt:stamp"] = await step(page, 8, { aim: Math.PI / 2 })
    await shot("prompt-03-door-open-stamp")
    report["prompt:close"] = await step(page, 50, { aim: Math.PI / 2 })
    await shot("prompt-04-door-close")
    await beat("search")
    await pose(29.3, 25.95, -Math.PI / 2)
    report["prompt:search"] = await step(page, 20, { aim: -Math.PI / 2 })
    await shot("prompt-05-dresser-search")
    await beat("board")
    await pose(35.9, 30.2, 0)
    report["prompt:window-b"] = await step(page, 20, { aim: 0 })
    await shot("prompt-06-window-board-key")
    await step(page, 1, { aim: 0, barricade: true })
    report["prompt:boarding"] = await step(page, 40, { aim: 0 })
    await shot("prompt-07-window-boarding")
    report["prompt:boarded"] = await step(page, 200, { aim: 0 })
    await shot("prompt-08-window-boarded-pips")
    await page.evaluate(() => {
      const h = (window as any).__arcadeHarness
      const s = h.session()
      s.sim.ai.addBarricadePlank("ash-front")
      s.sim.ai.addBarricadePlank("ash-front")
    })
    await beat("front-door")
    await pose(27.7, 34.5, Math.PI / 2)
    report["prompt:boarded-door"] = await step(page, 20, { aim: Math.PI / 2 })
    await shot("prompt-09-boarded-door")
    await beat("craft")
    report["prompt:bench"] = await step(page, 20, { aim: -Math.PI / 4 })
    await shot("prompt-10-bench")
    // Familiar (verbs gone after three uses) and Today.
    await page.evaluate(() => {
      const f: Record<string, number> = {}
      for (const k of ["a:door:door-open", "a:door:lock", "a:door:door-close"]) f[k] = 3
      localStorage.setItem("arcade.outbreak.familiar", JSON.stringify(f))
    })
    await page.reload({ waitUntil: "networkidle" })
    await page.waitForFunction(() => (window as any).__arcadeHarness?.ready)
    await beat("door-open")
    await pose(27.7, 28.9, Math.PI / 2)
    report["prompt:familiar"] = await step(page, 20, { aim: Math.PI / 2 })
    await shot("prompt-11-door-familiar")
    await lab("promptClarity", 0)
    report["prompt:today"] = await step(page, 20, { aim: Math.PI / 2 })
    await shot("prompt-12-door-today")
    await lab("promptClarity", 1)
  }

  // The clip: a scripted walk from the bed to the street, 30 fps, two ticks a frame.
  await open(page)
  assert.ok(await page.evaluate(() => (window as any).__arcadeHarness.startTraining()))
  const frames = join(out, "clip-frames")
  mkdirSync(frames, { recursive: true })
  let frame = 0
  const capture = async (cmd: Cmd, ticks = 2) => {
    const s = await step(page, ticks, cmd)
    const path = join(frames, `${String(frame++).padStart(5, "0")}.jpg`)
    try {
      await page.screenshot({ path, type: "jpeg", quality: 82, timeout: 20000 })
    } catch {
      report.screenshotRetries = Number(report.screenshotRetries ?? 0) + 1
      await page.screenshot({ path, type: "jpeg", quality: 82, timeout: 60000 })
    }
    return s
  }
  const player = () => page.evaluate(() => {
    const p = (window as any).__arcadeHarness.session().view.player
    return { x: p.x, y: p.y }
  })
  const wait = async (seconds: number, cmd: Cmd = {}) => {
    for (let i = 0; i < seconds * 30; i++) await capture(cmd)
  }
  const press = async (cmd: Cmd) => {
    await capture({ ...cmd }, 1)
  }
  const walk = async (x: number, y: number, extra: Cmd = {}, aimAt?: [number, number]) => {
    for (let i = 0; i < 30 * 8; i++) {
      const p = await player()
      const dx = x - p.x
      const dy = y - p.y
      const d = Math.hypot(dx, dy)
      if (d < 0.25) return
      const aim = aimAt ? Math.atan2(aimAt[1] - p.y, aimAt[0] - p.x) : Math.atan2(dy, dx)
      await capture({ mx: dx / d, my: dy / d, aim, ...extra })
    }
    report.stuck = [...((report.stuck as unknown[]) ?? []), [x, y]]
  }
  const timeline: unknown[] = []
  const note = async (label: string) => timeline.push({ label, frame, ...(await step(page, 0)) })
  await wait(1.6)
  await note("woke")
  await walk(28.4, 27.2)
  await press({ flashlight: true, aim: -0.4 })
  await wait(0.6, { aim: -0.4 })
  await walk(29.3, 25.95)
  await wait(0.4, { aim: -Math.PI / 2 })
  await press({ interact: true, aim: -Math.PI / 2 })
  await wait(2.4, { aim: -Math.PI / 2 })
  await press({ interact: true, aim: -Math.PI / 2 })
  await wait(0.8, { aim: -Math.PI / 2 })
  await note("dresser")
  await walk(30.2, 27.4, {}, [30.9, 26.3])
  if (!process.argv.includes("--no-panel")) await page.evaluate(() => (window as any).__arcadeHarness.benchPanel(true))
  await wait(1.0, { aim: -Math.PI / 4 })
  const bandage = await page.evaluate(() => {
    const s = (window as any).__arcadeHarness.session()
    return s.sim.progression.craftable().findIndex((r: { id: string }) => r.id === "bandage")
  })
  await press({ pick: { mode: "craft", index: Math.max(0, bandage) }, aim: -Math.PI / 4 })
  await wait(2.2, { aim: -Math.PI / 4 })
  await page.evaluate(() => (window as any).__arcadeHarness.benchPanel(false))
  await note("crafted")
  await walk(27.7, 28.8, {}, [27.7, 29.6])
  await wait(0.4, { aim: Math.PI / 2 })
  await press({ interact: true, aim: Math.PI / 2 })
  await wait(0.5, { aim: Math.PI / 2 })
  await walk(27.7, 31.0)
  await wait(0.3, { aim: -Math.PI / 2 })
  await press({ interact: true, aim: -Math.PI / 2 })
  await wait(0.6, { aim: -Math.PI / 2 })
  await note("hall door")
  await walk(33.4, 30.8)
  await walk(35.9, 30.25, { crouch: true }, [37, 29.6])
  await wait(0.4, { crouch: true, aim: 0 })
  await press({ barricade: true, aim: 0 })
  await wait(3.2, { aim: 0 })
  await note("boarded")
  await walk(35.2, 34.0)
  await walk(28.6, 34.3, { sprint: true })
  await walk(27.7, 34.5, {}, [27.7, 35.4])
  await press({ interact: true, aim: Math.PI / 2 })
  await wait(0.6, { aim: Math.PI / 2 })
  await walk(27.7, 36.6)
  await walk(29.4, 37.6, {}, [31.6, 38.9])
  await note("yard")
  for (let i = 0; i < 6; i++) {
    const z = await page.evaluate(() => {
      const s = (window as any).__arcadeHarness.session()
      const z = s.view.zombies.find((a: { state: string }) => a.state !== "dead")
      return z ? { x: z.x, y: z.y, state: z.state } : null
    })
    if (!z) break
    const p = await player()
    const aim = Math.atan2(z.y - p.y, z.x - p.x)
    await press({ fire: true, aim })
    await wait(0.5, { aim })
  }
  await wait(0.8)
  await note("chained one")
  await walk(27.7, 43.0)
  await wait(3.6)
  await note("run")
  report.timeline = timeline
  report.errors = errors
  const ff = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "30", "-i", join(frames, "%05d.jpg"), "-vf", "scale=1280:-2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "22", join(out, "training.mp4")])
  report.clip = ff.status === 0 ? "training.mp4" : String(ff.stderr)
  if (ff.status === 0) rmSync(frames, { recursive: true, force: true })
} finally {
  writeFileSync(join(out, "proof.json"), JSON.stringify(report, null, 2))
  await browser.close()
  await server.close()
}
console.log(JSON.stringify({ out, errors: report.errors, stuck: report.stuck, clip: report.clip }, null, 2))
