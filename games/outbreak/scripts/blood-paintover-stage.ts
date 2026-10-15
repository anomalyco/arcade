import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright-core"
import { createServer } from "vite"

const game = resolve(import.meta.dir, "..")
const phaseArg = process.argv.find((a) => a.startsWith("--phase="))?.slice(8)
const phase = phaseArg ?? process.env.BLOOD_PHASE ?? "after"
const out = resolve(game, "../../captures/game-feel")
mkdirSync(out, { recursive: true })

const server = await createServer({
  root: game,
  server: { host: "127.0.0.1", port: 0 },
})
await server.listen()
const port = (server.httpServer!.address() as { port: number }).port

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`)
  .find(existsSync)
assert(chrome, "Playwright Chromium not found")

const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})

try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 680 }, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text())
  })
  await page.goto(`http://127.0.0.1:${port}/?solo&seed=7&bench`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready)

  // 1. Street hit in Noir flashlight (one zombie killed in beam, one hit just outside the beam)
  await page.evaluate(async (isBefore) => {
    const h = (window as any).__arcadeHarness
    h.reset(7)
    h.setLab("timeScale", 0)
    h.setLab("hudMode", 1)
    h.setLab("bloodStyle", isBefore ? 2 : 1)
    h.setLab("feelIntensity", 0)
    h.setLab("hour", 18)
    h.setLab("zoom", 36)
    h.setLab("zombieCount", 0)
    h.setLab("infiniteAmmo", 1)
    h.pose(30, 41, -Math.PI / 2)
    await h.step(1 / 60)

    // Spawn zombie outside the flashlight beam to the left and shoot it twice
    const zOut = h.spawnZombie(27.2, 38.4, "chase", Math.PI / 2)
    zOut.hp = 90
    const aimOut = Math.atan2(zOut.y - 41, zOut.x - 30)
    h.pose(30, 41, aimOut)
    await h.step(1 / 60, { aim: aimOut })
    await h.step(1 / 60, { aim: aimOut })
    await h.step(1 / 60, { fire: true, aim: aimOut })
    for (let i = 0; i < 18; i++) await h.step(1 / 60, { aim: aimOut })
    await h.step(1 / 60, { fire: true, aim: aimOut })
    for (let i = 0; i < 45; i++) await h.step(1 / 60, { aim: aimOut })

    // Aim flashlight north and shoot a zombie directly inside the flashlight cone
    const aimBeam = -Math.PI / 2
    h.pose(30, 41, aimBeam)
    const zBeam = h.spawnZombie(30.0, 38.1, "chase", Math.PI / 2)
    zBeam.hp = 90
    await h.step(1 / 60, { aim: aimBeam })
    await h.step(1 / 60, { aim: aimBeam })
    await h.step(1 / 60, { fire: true, aim: aimBeam })
    for (let i = 0; i < 18; i++) await h.step(1 / 60, { aim: aimBeam })
    await h.step(1 / 60, { fire: true, aim: aimBeam })
    for (let i = 0; i < 45; i++) await h.step(1 / 60, { aim: aimBeam })
  }, phase === "before")
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>(
      "#status, #hotbar, #stamina, #battery, #prompt, .ob-hud, [data-callout-layer], .ob-callout-layer",
    ))
      el.style.visibility = "hidden"
  })
  await page.locator("#game").screenshot({ path: resolve(out, `blood-${phase}-street.png`) })

  // 2. Interior hit against wall & floor inside the house
  await page.evaluate(async (isBefore) => {
    const h = (window as any).__arcadeHarness
    h.reset(7)
    h.setLab("timeScale", 0)
    h.setLab("hudMode", 1)
    h.setLab("bloodStyle", isBefore ? 2 : 1)
    h.setLab("feelIntensity", 0)
    h.setLab("hour", 19)
    h.setLab("zoom", 32)
    h.setLab("zombieCount", 0)
    h.setLab("infiniteAmmo", 1)
    for (const [x, y, a] of [
      [30, 41, -1.57],
      [27.7, 35, -1.57],
      [27.7, 31, -1.57],
    ] as const) {
      h.pose(x, y, a)
      await h.step(1 / 60)
    }
    h.pose(27.7, 31.2, -Math.PI / 2)
    await h.step(1 / 60, { interact: true })
    for (let i = 0; i < 6; i++) await h.step(1 / 60)

    const zIn = h.spawnZombie(27.7, 28.4, "chase", Math.PI / 2)
    zIn.hp = 90
    const aim = -Math.PI / 2
    await h.step(1 / 60, { aim })
    await h.step(1 / 60, { aim })
    await h.step(1 / 60, { fire: true, aim })
    for (let i = 0; i < 18; i++) await h.step(1 / 60, { aim })
    await h.step(1 / 60, { fire: true, aim })
    for (let i = 0; i < 45; i++) await h.step(1 / 60, { aim })
  }, phase === "before")
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>(
      "#status, #hotbar, #stamina, #battery, #prompt, .ob-hud, [data-callout-layer], .ob-callout-layer",
    ))
      el.style.visibility = "hidden"
  })
  await page.locator("#game").screenshot({ path: resolve(out, `blood-${phase}-interior.png`) })

  const state = await page.evaluate(() => (window as any).__arcadeHarness.state())
  console.log(JSON.stringify({ phase, splatter: state.splatter, errors }))
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
  await server.close()
}
