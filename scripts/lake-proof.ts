/** Real forest renderer, identical clear-night setup; no timing rounds. Run after the BARBARA build. */
import { browserBudget } from "./browser-budget"
import { resolve, sep } from "node:path"
import { mkdirSync } from "node:fs"
import { hostname } from "node:os"
import { MOONLIT_LAKE } from "../packages/kit/water/lake-preset"

type Woods = {
  frames: number; paused: boolean; look: Record<string, string | number | boolean>
  setPose(x: number, z: number, yaw: number, pitch: number): void; step(ms: number): void
  hold(code: string, down: boolean): void
  camera: { flashlight: boolean; viewProj: Float32Array }
  state: { t: number; players: { x: number; z: number }[]; brains: { mode: string; timer: number }[] }
  panel: { visible: boolean; toggle(): void }
  view: { forest: { debug: Record<string, boolean>; waterProbe: { x: number; z: number }; sky: { ready: Promise<void>; active: boolean }; lakeSky: { ready: Promise<void>; active: boolean }; resetExposure(): void } }
}
declare const woods: Woods
await using budget = browserBudget()
const { chromium } = budget
const out = resolve("captures/water-lake/barbara")
if (!hostname().startsWith("aak2-2")) throw Error("Lake proof must run on mini")
mkdirSync(out, { recursive: true })
const root = resolve("games/barbara/dist/arcade/barbara")
const prefix = "/arcade/barbara/"
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const path = new URL(req.url).pathname
  if (!path.startsWith(prefix)) return new Response("Not found", { status: 404 })
  const file = resolve(root, decodeURIComponent(path.slice(prefix.length)) || "index.html")
  if (!file.startsWith(root + sep)) return new Response("Not found", { status: 404 })
  const f = Bun.file(file)
  return await f.exists() ? new Response(f) : new Response("Not found", { status: 404 })
} })
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const errors: string[] = []
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 })
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
  const ready = async (lab: boolean) => {
    await page.goto(`http://127.0.0.1:${server.port}${prefix}?quality=high${lab ? "&lab=water" : ""}`)
    await page.waitForFunction(() => (window as unknown as { woods?: Woods }).woods?.frames! > 2, null, { timeout: 180000 })
    await page.evaluate(preset => {
      woods.paused = true
      Object.assign(woods.look, preset)
      // The shared shell's cards and the HUD are not part of the still.
      const hide = document.createElement("style")
      hide.textContent = "#tuning,#hud,#toast,#objective,#subs,#reticle,#prompt,#room,.as-overlay,.as-pill,.as-loading{display:none!important}"
      document.head.append(hide)
      woods.setPose(-22, 89, Math.PI, -0.12)
      for (const p of woods.state.players.slice(1)) { p.x = 0; p.z = 40 }
      for (const b of woods.state.brains) { b.mode = "wait"; b.timer = 999 }
    }, MOONLIT_LAKE)
    await page.evaluate(async () => {
      woods.step(1000 / 60)
      await Promise.all([woods.view.forest.sky.ready, woods.view.forest.lakeSky.ready])
      woods.step(1000 / 60)
      if (!woods.view.forest.sky.active || !woods.view.forest.lakeSky.active) throw Error("Shared sky not ready")
    })
  }
  const frames = (n: number) => page.evaluate(async n => {
    for (let i = 0; i < n; i++) { woods.step(1000 / 60); if (i % 5 === 4) await new Promise(r => setTimeout(r, 0)) }
  }, n)
  if (process.argv.includes("--diagnose")) {
    await ready(false)
    await page.evaluate(() => { woods.camera.flashlight = false; woods.view.forest.debug.ssr = false })
    await frames(30)
    await page.locator("canvas#view").screenshot({ path: `${out}/diagnose-no-ssr.png` })
    await page.evaluate(() => { woods.look.skyStars = 0; woods.look.lakeMist = 0 })
    await frames(30)
    await page.locator("canvas#view").screenshot({ path: `${out}/diagnose-no-stars-mist.png` })
    await page.evaluate(() => { woods.look.skyMode = "today" })
    await frames(30)
    await page.locator("canvas#view").screenshot({ path: `${out}/diagnose-no-cube.png` })
  } else {
  if (!process.argv.includes("--editor-only")) {
  await ready(false)
  for (const torch of [false, true]) for (const mode of ["today", "moonlit"] as const) {
    await page.evaluate(({ torch, mode }) => {
      woods.look.lakeLook = mode
      woods.state.t = 120
      woods.camera.flashlight = torch
      woods.setPose(-22, 89, Math.PI, torch ? -0.33 : -0.12)
      woods.view.forest.resetExposure()
    }, { torch, mode })
    await frames(120)
    await page.locator("canvas#view").screenshot({ path: `${out}/${torch ? "torch" : "moon"}-${mode}.png` })
  }
  }
  await ready(true)
  await frames(30)
  const initial = await page.evaluate(() => ({ ...woods.view.forest.waterProbe }))
  await page.evaluate(() => { if (woods.panel.visible) woods.panel.toggle() })
  const point = await page.evaluate(() => {
    const log = woods.view.forest.waterProbe, m = woods.camera.viewProj, p = [log.x, 0, log.z, 1]
    const c = [0,1,2,3].map(row => p.reduce((sum,v,i) => sum + v * m[i * 4 + row]!, 0))
    return { x: (c[0]! / c[3]! + 1) * innerWidth / 2, y: (1 - c[1]! / c[3]!) * innerHeight / 2 }
  })
  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  await page.mouse.move(point.x + 120, point.y - 25, { steps: 8 })
  await frames(2)
  await page.mouse.up()
  const moved = await page.evaluate(() => ({ ...woods.view.forest.waterProbe }))
  if (Math.hypot(initial.x - moved.x, initial.z - moved.z) < 0.4) throw Error("Log did not follow real pointer drag")
  if (await page.evaluate(() => !!document.pointerLockElement)) throw Error("Edit took pointer lock")
  const before = await page.evaluate(() => ({ ...woods.state.players[0]! }))
  await page.evaluate(() => woods.hold("KeyW", true))
  await frames(30)
  await page.evaluate(() => woods.hold("KeyW", false))
  const after = await page.evaluate(() => ({ ...woods.state.players[0]! }))
  if (Math.hypot(before.x - after.x, before.z - after.z) > 0.001) throw Error("Edit accepted walking input")
  await page.evaluate(() => { woods.look.lakeRain = 0.7 })
  await frames(30)
  await page.locator("canvas#view").screenshot({ path: `${out}/log-rain.png` })
  await page.evaluate(() => woods.panel.toggle())
  const today = page.getByRole("radio", { name: "Today", exact: true }).first()
  if (await today.isVisible()) await today.click()
  else {
    await page.getByRole("button", { name: "Water look", exact: true }).click()
    await page.getByRole("menuitemradio", { name: "Today", exact: true }).click()
  }
  if (await page.evaluate(() => woods.look.lakeLook) !== "today") throw Error("Today control failed")
  await Bun.write(`${out}/proof.json`, JSON.stringify({ errors, initial, moved, editSuppressedWalking: true, editPointerLock: false, todayControl: true, preset: MOONLIT_LAKE, sky: "Production kit/sky: visible catalogue and cached HDR reflection cube; canopy-height silhouette from actual trees; shared lunar lux drives ripple glitter" }, null, 2))
  if (errors.length) throw Error(errors.join("\n"))
  }
} finally { await browser.close(); server.stop(true) }
