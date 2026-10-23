import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { type Page } from "playwright-core"
import { browserBudget } from "../../../scripts/browser-budget"
import { createServer } from "vite"

await using budget = browserBudget()
const { chromium } = budget

/**
 * The radial E menu (playtest Oct 21, 1:45:21) in the real game in headless Metal Chromium (`--mute-audio`, no window),
 * with real key and mouse input through the live loop: at a closed door, a tap opens it as Today; holding E opens the
 * ring, pointing at Lock and letting go locks it. Writes stills of the ring and a readout.
 *
 *   bun scripts/radial-proof.ts [--out <dir>]
 */
const root = resolve(import.meta.dir, "..")
const argOut = process.argv.indexOf("--out")
const out = resolve(argOut >= 0 ? process.argv[argOut + 1]! : resolve(root, "captures/radial"))

const server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0 } })
await server.listen()
const port = (server.httpServer!.address() as { port: number }).port
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
assert(executablePath, "Playwright Chromium not found")
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})

type Read = { prompt: string | null; open: boolean | null; locked: boolean | null; radial: { phase: string; shown: { labels: string[]; hover: number; x: number; y: number } | null } }
const read = (page: Page, doorId: string): Promise<Read> =>
  page.evaluate((doorId) => {
    const h = (window as any).__arcadeHarness
    const s = h.session()
    const d = s.sim.town.doors.find((x: any) => x.id === doorId)
    return { prompt: s.view.prompt ? `${s.view.prompt.kind}:${s.view.prompt.id}` : null, open: d?.open ?? null, locked: d?.locked ?? null, radial: h.state().radial }
  }, doorId)

try {
  mkdirSync(out, { recursive: true })
  const page = await browser.newPage({ viewport: { width: 960, height: 600 }, deviceScaleFactor: 2 })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.goto(`http://127.0.0.1:${port}/?solo&seed=7&bench&peaceful=1&hour=13`, { timeout: 240_000 })
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 240_000 })
  // Stand at the nearest closed, unlocked, unboarded door, facing it, with the cursor on it.
  const setup = await page.evaluate(() => {
    const h = (window as any).__arcadeHarness
    h.setLab("zombieCount", 0)
    const s = h.session()
    const p = s.view.player
    const doors = s.sim.town.doors
      .filter((d: any) => !d.open && !d.locked && s.sim.ai.getBarricadePlanks(d.id) === 0)
      .map((d: any) => ({ d, dist: Math.hypot((d.rect[0] + d.rect[2]) / 2 - p.x, (d.rect[1] + d.rect[3]) / 2 - p.y) }))
      .sort((a: any, b: any) => a.dist - b.dist)
    for (const { d } of doors) {
      const cx = (d.rect[0] + d.rect[2]) / 2
      const cy = (d.rect[1] + d.rect[3]) / 2
      const horizontal = d.rect[2] - d.rect[0] > d.rect[3] - d.rect[1]
      for (const side of [1, -1]) {
        const x = horizontal ? cx : cx + side * 1.1
        const y = horizontal ? cy + side * 1.1 : cy
        h.pose(x, y, Math.atan2(cy - y, cx - x))
        const prompt = h.session().view.prompt
        if (prompt?.kind === "door" && prompt.id === d.id) return { id: d.id, x, y, cx, cy }
      }
    }
    return null
  })
  assert(setup, "no door to stand at")
  await page.evaluate(() => (window as any).__arcadeHarness.freeze(false))
  const screen = await page.evaluate(({ cx, cy }) => {
    const h = (window as any).__arcadeHarness
    const r = h.resolveTargetRect({ world: [cx, 1, cy] })
    return r ? { ok: true, x: r.x + r.width / 2, y: r.y + r.height / 2 } : null
  }, setup)
  const cursor = screen && screen.ok ? { x: screen.x, y: screen.y } : { x: 480, y: 250 }
  await page.mouse.move(cursor.x, cursor.y)
  await page.waitForTimeout(400)
  const readout: Record<string, unknown> = { door: setup.id, cursor, start: await read(page, setup.id) }

  // A tap opens it, as Today.
  await page.keyboard.press("KeyE")
  await page.waitForTimeout(500)
  readout.afterTap = await read(page, setup.id)
  // And a tap shuts it again.
  await page.keyboard.press("KeyE")
  await page.waitForTimeout(500)
  readout.afterSecondTap = await read(page, setup.id)

  // Hold: the ring opens at the cursor.
  await page.keyboard.down("KeyE")
  await page.waitForTimeout(450)
  readout.held = await read(page, setup.id)
  await page.screenshot({ path: resolve(out, "radial-open.png"), timeout: 120_000 })
  const shown = (readout.held as Read).radial.shown
  const lockIndex = shown ? shown.labels.indexOf("Lock") : -1
  if (shown && lockIndex >= 0) {
    const a = (lockIndex / shown.labels.length) * Math.PI * 2
    await page.mouse.move(shown.x + Math.sin(a) * 60, shown.y - Math.cos(a) * 60, { steps: 6 })
    await page.waitForTimeout(250)
    readout.pointing = await read(page, setup.id)
    await page.screenshot({ path: resolve(out, "radial-hover-lock.png"), timeout: 120_000 })
    await page.screenshot({
      path: resolve(out, "radial-hover-lock-crop.png"),
      clip: { x: Math.max(0, shown.x - 180), y: Math.max(0, shown.y - 130), width: 360, height: 260 },
      timeout: 120_000,
    })
  }
  await page.keyboard.up("KeyE")
  await page.waitForTimeout(500)
  readout.afterRelease = await read(page, setup.id)
  readout.errors = errors
  writeFileSync(resolve(out, "readout.json"), JSON.stringify(readout, null, 2))
  console.log(JSON.stringify(readout, null, 2))

  const r = readout as Record<string, Read>
  assert.equal(errors.length, 0, errors.join("\n"))
  assert.equal(r.afterTap!.open, true, "a tap did not open the door")
  assert.equal(r.afterSecondTap!.open, false, "a second tap did not shut it")
  assert.equal(r.held!.radial.phase, "open", "holding E did not open the radial")
  assert(lockIndex >= 0, "the radial has no Lock")
  assert.equal(r.afterRelease!.locked, true, "releasing over Lock did not lock the door")
  assert.equal(r.afterRelease!.radial.phase, "idle")
} finally {
  await browser.close()
  await server.close()
}
