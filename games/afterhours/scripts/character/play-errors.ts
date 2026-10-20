// Play-mode console/page-error check: home → Play → title → intro (12 s of the drive) → skip → explore, then into
// room 3-08 (the transmitter room: the warning beat) with the flashlight on, past the washroom mirror on the way,
// looking round; every console error and page error is logged. One browser, 1280×720.
//
//   bun scripts/character/play-errors.ts [--char kate]
import { chromium } from "playwright-core"
import { existsSync, readdirSync } from "node:fs"

const args = process.argv.slice(2)
const ci = args.indexOf("--char")
const char = ci >= 0 ? args[ci + 1]! : "remy"
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"] })
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
const errs: string[] = []
const log = (s: string) => {
  errs.push(s)
  console.log(s)
}
page.on("pageerror", (e) => log(`[page] ${e.message.slice(0, 300)}`))
page.on("console", (m) => m.type() === "error" && log(`[console] ${m.text().slice(0, 300)}`))
await page.routeWebSocket(/.*/, () => {})
type G = { __static?: { flow: { phase: string } } }
try {
  await page.goto("http://localhost:5196/")
  await page.evaluate((c) => localStorage.setItem("afterhours.character", c), char)
  await page.reload()
  await page.waitForSelector(".shell-play", { timeout: 240_000 })
  await page.waitForTimeout(800)
  await page.click(".shell-play")
  await page.waitForFunction(() => (globalThis as unknown as G).__static?.flow.phase === "title", null, { timeout: 240_000 }).catch(() => {})
  await page.waitForTimeout(1500)
  await page.keyboard.press("Space")
  await page.waitForFunction(() => (globalThis as unknown as G).__static?.flow.phase === "intro", null, { timeout: 30_000 })
  console.log("intro")
  await page.waitForTimeout(12000)
  await page.keyboard.down("Space")
  await page.waitForTimeout(1500)
  await page.keyboard.up("Space")
  await page.waitForFunction(() => (globalThis as unknown as G).__static?.flow.phase === "explore", null, { timeout: 40_000 })
  console.log("explore")
  await page.waitForTimeout(2000)
  const ev = (src: string) => page.evaluate((src) => new Function("P", src)((globalThis as any).__afterhoursPlayer), src)
  await ev(`P.flashlight = true`)
  // Past a washroom mirror (ground floor), then into 3-08.
  await ev(`P.pos.x=-34.6; P.pos.y=0.3; P.pos.z=3.1; P.yaw=-Math.PI/2; P.pitch=0; P.resetMotion()`)
  await page.waitForTimeout(3000)
  const at = (await ev(`const d = P.ctx.doors.get("s3:3-08"); if (!d) return null; const c = d.centre({x:0,y:0,z:0}); const s = Math.sign((P.pos.x - d.hx) * Math.sin(d.yaw0) + (P.pos.z - d.hz) * Math.cos(d.yaw0)) || 1; return { x: c.x, y: d.hy, z: c.z, nx: Math.sin(d.yaw0), nz: Math.cos(d.yaw0) }`)) as { x: number; y: number; z: number; nx: number; nz: number } | null
  if (!at) log("3-08 door not found")
  else {
    for (const sgn of [1, -1]) {
      await ev(`P.pos.x=${at.x + at.nx * 1.2 * sgn}; P.pos.y=${at.y + 0.3}; P.pos.z=${at.z + at.nz * 1.2 * sgn}; P.yaw=${Math.atan2(at.nx * sgn, at.nz * sgn)}; P.pitch=-0.2; P.resetMotion()`)
      await page.waitForTimeout(2500)
      for (let i = 0; i < 8; i++) {
        await ev(`P.yaw += 0.8`)
        await page.waitForTimeout(400)
      }
    }
    console.log("3-08 visited")
  }
  await page.keyboard.down("KeyW")
  await page.waitForTimeout(2000)
  await page.keyboard.up("KeyW")
  await page.waitForTimeout(1500)
} finally {
  await browser.close()
}
console.log(`${char}: ${errs.length} errors`)
