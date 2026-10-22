import assert from "node:assert/strict"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { randomRoomCode } from "@arcade/kit/sim/matchmaking"
import { type Browser, type Page } from "playwright-core"
import { browserBudget } from "../../../scripts/browser-budget"
import { createServer } from "vite"

await using budget = browserBudget()
const { chromium } = budget

/**
 * Lobby practice proof (AR-89, Kit: "Maybe a tutorial in the loadout. While loading out you can train.") in headless
 * Metal Chromium, muted, no window:
 *   hivemind run --kind browser --fetch captures/outbreak-lobby-practice -- bun games/outbreak/scripts/lobby-practice-proof.ts
 * Solo: the lobby opens over the practice space; a scripted practice with real clicks on the kit cards and real Tab
 * and Enter keys, ending in Play Solo. Co-op (`--no-coop` skips it; needs `vite build` + `wrangler dev`): two pages
 * in one room practise separately, ready up with Enter and drop into the room's run together.
 * Writes captures/outbreak-lobby-practice/{proof.json,*.png,practice.mp4,coop.mp4}.
 */
const game = resolve(import.meta.dir, "..")
const out = resolve(game, "../../captures/outbreak-lobby-practice")
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const report: Record<string, unknown> = {}
type Cmd = Record<string, unknown>

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache).filter((n) => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
assert(executablePath, "Install Chromium for Playwright")
const browser: Browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })

function watch(page: Page, errors: string[], who = ""): void {
  page.on("pageerror", (e) => errors.push(`${who}${e.message}`))
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("404")) errors.push(`${who}${m.text()}`)
  })
}

const ffmpeg = (args: string[]) => spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args])

async function solo(): Promise<void> {
  const server = await createServer({ root: game, logLevel: "error", server: { host: "127.0.0.1", port: 0 } })
  await server.listen()
  const url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`
  const errors: string[] = []
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 2 })
    page.setDefaultTimeout(120000)
    watch(page, errors)
    console.error(`solo: opening ${url}`)
    await page.goto(`${url}/?lobby=1&seed=7`, { waitUntil: "networkidle", timeout: 240000 })
    console.error("solo: loaded")
    await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, undefined, { timeout: 240000 })
    await page.evaluate(() => {
      localStorage.removeItem("arcade.outbreak.familiar")
      ;(window as any).__arcadeHarness.freeze(true)
    })
    const state = () => page.evaluate(() => {
      const h = (window as any).__arcadeHarness
      const s = h.state()
      return { practice: s.practice, lobby: h.coop()?.lobby ?? null, hour: h.session().view.hour }
    })
    report.soloStart = await state()
    assert.equal((report.soloStart as { lobby: { practice: boolean } }).lobby.practice, true, "the lobby opens over the practice space")

    const frames = join(out, "solo-frames")
    mkdirSync(frames, { recursive: true })
    let frame = 0
    const step = (n: number, cmd: Cmd) =>
      page.evaluate(async ({ n, cmd }) => {
        const h = (window as any).__arcadeHarness
        for (let i = 0; i < n; i++) await h.step(1 / 60, cmd)
      }, { n, cmd })
    const capture = async (cmd: Cmd = {}, ticks = 2) => {
      await step(ticks, cmd)
      const path = join(frames, `${String(frame++).padStart(5, "0")}.jpg`)
      await page.screenshot({ path, type: "jpeg", quality: 82, timeout: 60000 })
    }
    const still = (name: string) => page.screenshot({ path: join(out, `${name}.png`), timeout: 90000 })
    const player = () => page.evaluate(() => {
      const p = (window as any).__arcadeHarness.session().view.player
      return { x: p.x, y: p.y }
    })
    const wait = async (seconds: number, cmd: Cmd = {}) => {
      for (let i = 0; i < seconds * 30; i++) await capture(cmd)
    }
    const press = (cmd: Cmd) => capture(cmd, 1)
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
    const kit = async (id: string) => {
      await page.click(`[data-loadout="${id}"]`)
      await capture()
      return page.evaluate(() => (window as any).__arcadeHarness.state().practice?.loadout)
    }
    const timeline: unknown[] = []
    const note = async (label: string) => {
      timeline.push({ label, frame, ...(await state()) })
      console.error(`solo: ${label} (frame ${frame})`)
    }

    await wait(1.4)
    await still("01-lobby-over-practice")
    await note("lobby")
    await walk(28.4, 27.2)
    await press({ flashlight: true, aim: -0.4 })
    await wait(0.5, { aim: -0.4 })
    // The kit swaps live: the Breacher's pipe and attaché case.
    report.kitBreacher = await kit("breacher")
    await wait(1.0, { aim: -0.4 })
    await still("02-kit-swapped-breacher")
    await walk(29.3, 25.95)
    await wait(0.3, { aim: -Math.PI / 2 })
    await press({ interact: true, aim: -Math.PI / 2 })
    await wait(2.2, { aim: -Math.PI / 2 })
    await press({ interact: true, aim: -Math.PI / 2 })
    await wait(0.6, { aim: -Math.PI / 2 })
    // A real Tab: the game owns the key over the practice space; the panel tucks away while the case is open.
    await page.keyboard.press("Tab")
    await wait(1.4, { aim: -Math.PI / 2 })
    report.caseOpen = await page.evaluate(() => document.querySelector("#outbreak-lobby")?.getAttribute("data-tucked"))
    await still("03-case-open-panel-tucked")
    await page.keyboard.press("Tab")
    await wait(0.5, { aim: -Math.PI / 2 })
    await note("dresser + case")
    await walk(27.7, 28.8, {}, [27.7, 29.6])
    await press({ interact: true, aim: Math.PI / 2 })
    await wait(0.5, { aim: Math.PI / 2 })
    await walk(27.7, 30.4)
    await press({ interact: true, aim: -Math.PI / 2 })
    await wait(0.5, { aim: -Math.PI / 2 })
    await walk(33.4, 30.8)
    await walk(35.9, 30.25, {}, [37, 29.6])
    await wait(0.4, { aim: 0 })
    await still("04-window-board-hint")
    await press({ barricade: true, aim: 0 })
    await wait(2.6, { aim: 0 })
    await note("boarded")
    await walk(35.2, 34.0)
    await walk(28.6, 34.3, { sprint: true })
    await walk(27.7, 34.5, {}, [27.7, 35.4])
    await press({ interact: true, aim: Math.PI / 2 })
    await wait(0.5, { aim: Math.PI / 2 })
    await walk(27.7, 36.6)
    await walk(29.6, 37.7, {}, [31.6, 38.9])
    // The pipe on the chained one (hotbar index 2; the pistol is 1), then it comes back and the pistol (standard kit) takes it.
    const fight = async (slot: number, swings: number) => {
      await press({ hotbarSlot: slot })
      for (let i = 0; i < swings; i++) {
        const z = await page.evaluate(() => {
          const z = (window as any).__arcadeHarness.session().view.zombies.find((a: { state: string }) => a.state !== "dead")
          return z ? { x: z.x, y: z.y } : null
        })
        if (!z) break
        const p = await player()
        const aim = Math.atan2(z.y - p.y, z.x - p.x)
        await press({ fire: true, aim })
        await wait(0.45, { aim })
      }
    }
    await fight(2, 8)
    await still("05-chained-one-pipe")
    await note("pipe")
    await wait(3.4)
    report.kitStandard = await kit("standard")
    await wait(0.4)
    await fight(1, 6)
    await wait(0.8)
    await note("pistol")
    // Enter: Play Solo drops you into the run.
    await page.keyboard.press("Enter")
    await wait(2.4)
    await still("06-run")
    await note("run")
    report.soloEnd = await state()
    assert.equal((report.soloEnd as { practice: unknown }).practice, null, "the run is not the practice space")
    report.soloTimeline = timeline
    const ff = ffmpeg(["-framerate", "30", "-i", join(frames, "%05d.jpg"), "-vf", "scale=1280:-2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "22", join(out, "practice.mp4")])
    report.soloClip = ff.status === 0 ? "practice.mp4" : String(ff.stderr)
    if (ff.status === 0) rmSync(frames, { recursive: true, force: true })
  } finally {
    report.soloErrors = errors
    await server.close()
  }
}

async function coop(): Promise<void> {
  const errors: string[] = []
  let dev: ChildProcess | null = null
  try {
    const built = spawnSync("bun", ["scripts/build-id.ts"], { cwd: game })
    assert.equal(built.status, 0)
    const vite = spawnSync("bunx", ["--no-install", "vite", "build", "--logLevel", "error"], { cwd: game })
    assert.equal(vite.status, 0, String(vite.stderr))
    dev = spawn("bunx", ["--no-install", "wrangler", "dev", "--port", "8797", "--ip", "127.0.0.1"], { cwd: game, stdio: "ignore" })
    const base = "http://127.0.0.1:8797/arcade/outbreak/"
    const end = Date.now() + 90000
    while (Date.now() < end) {
      try {
        if ((await fetch(base)).ok) break
      } catch {}
      await new Promise((r) => setTimeout(r, 500))
    }
    const room = randomRoomCode(undefined, Math.random, 5)
    const pages: Page[] = []
    for (const name of ["Ann", "Bob"]) {
      const context = await browser.newContext({ viewport: { width: 760, height: 560 }, deviceScaleFactor: 1 })
      const page = await context.newPage()
      page.setDefaultTimeout(60000)
      watch(page, errors, `${name}: `)
      await page.goto(`${base}?room=${room}&name=${name}`, { waitUntil: "load" })
      await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 120000 })
      pages.push(page)
    }
    const [a, b] = pages as [Page, Page]
    const look = (page: Page) => page.evaluate(() => {
      const h = (window as any).__arcadeHarness
      const c = h.coop()
      const s = h.state()
      return { phase: c?.phase, roster: c?.roster?.length, lobby: c?.lobby, practice: s.practice, local: c?.local, hour: h.session().view.hour }
    })
    const until = async (what: string, test: () => Promise<boolean>, ms = 30000) => {
      const stop = Date.now() + ms
      while (!(await test())) {
        if (Date.now() > stop) throw new Error(`timed out: ${what}`)
        await new Promise((r) => setTimeout(r, 150))
      }
    }
    await until("both in the room's lobby", async () => (await look(a)).roster === 2 && (await look(b)).roster === 2)
    const frames = join(out, "coop-frames")
    mkdirSync(frames, { recursive: true })
    let frame = 0
    const capture = async (seconds: number) => {
      for (let i = 0; i < seconds * 10; i++) {
        const n = String(frame++).padStart(5, "0")
        await Promise.all([a.screenshot({ path: join(frames, `a-${n}.jpg`), type: "jpeg", quality: 80 }), b.screenshot({ path: join(frames, `b-${n}.jpg`), type: "jpeg", quality: 80 })])
      }
    }
    report.coopLobby = { a: await look(a), b: await look(b) }
    await capture(1)
    // Each practises on their own: Ann walks and swaps kit, Bob turns his light on and walks the other way.
    await a.keyboard.down("KeyD")
    await b.keyboard.press("KeyF")
    await b.keyboard.down("KeyS")
    await capture(1.2)
    await a.keyboard.up("KeyD")
    await b.keyboard.up("KeyS")
    await a.click('[data-loadout="breacher"]')
    await capture(1)
    report.coopPracticing = { a: await look(a), b: await look(b) }
    await a.screenshot({ path: join(out, "07-coop-ann-practising.png") })
    await b.screenshot({ path: join(out, "08-coop-bob-practising.png") })
    // Ready with Enter on both: the room starts and both drop into its run.
    await b.keyboard.press("Enter")
    await capture(0.8)
    await a.keyboard.press("Enter")
    await until("the room's run started on both", async () => (await look(a)).phase === "running" && (await look(b)).phase === "running")
    await capture(2.5)
    report.coopRun = { a: await look(a), b: await look(b) }
    await a.screenshot({ path: join(out, "09-coop-ann-run.png") })
    const run = report.coopRun as { a: { practice: unknown; lobby: { open: boolean } }; b: { practice: unknown; lobby: { open: boolean } } }
    assert.equal(run.a.practice, null)
    assert.equal(run.b.practice, null)
    const ff = ffmpeg(["-framerate", "10", "-i", join(frames, "a-%05d.jpg"), "-framerate", "10", "-i", join(frames, "b-%05d.jpg"), "-filter_complex", "[0:v][1:v]hstack=inputs=2,scale=1520:-2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", join(out, "coop.mp4")])
    report.coopClip = ff.status === 0 ? "coop.mp4" : String(ff.stderr)
    if (ff.status === 0) rmSync(frames, { recursive: true, force: true })
  } catch (e) {
    report.coopFailure = String(e)
  } finally {
    report.coopErrors = errors
    dev?.kill()
  }
}

try {
  await solo()
  if (!process.argv.includes("--no-coop")) await coop()
} finally {
  writeFileSync(join(out, "proof.json"), JSON.stringify(report, null, 2))
  await browser.close()
}
console.log(JSON.stringify({ out, soloErrors: report.soloErrors, coopErrors: report.coopErrors, coopFailure: report.coopFailure, stuck: report.stuck, clips: [report.soloClip, report.coopClip] }, null, 2))
