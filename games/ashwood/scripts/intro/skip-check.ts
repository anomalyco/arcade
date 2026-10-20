// Skips the intro (hold Space 1 s) at several moments and checks the hand-over: the player stands on the ground
// beside the driver's door, outside the parked car's collider, facing the building; the car is parked solid with
// its door shut. One browser, a fresh page per moment; a screenshot of each result in captures/intro/skip-<t>.png.
//
//   bun scripts/intro/skip-check.ts [times...]       # default: 5 (early drive) 33 (gate) 55 (parked) 59.5 (door)
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync } from "node:fs"

const times = process.argv.slice(2).map(Number)
if (!times.length) times.push(5, 33, 55, 59.5)
const outDir = `${import.meta.dir}/../../captures/intro`
mkdirSync(outDir, { recursive: true })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache).filter((n) => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse().map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"] })
let failed = 0
try {
  for (const t of times) {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } })
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(e.message))
    await page.goto(`http://localhost:5196/?intro&introAt=${t}`)
    await page.waitForFunction(() => (globalThis as any).__afterhoursIntro && (globalThis as any).__afterhours?.complete, undefined, { timeout: 240000 })
    await page.waitForTimeout(800)
    const before = await page.evaluate(() => (globalThis as any).__afterhoursIntro.time)
    await page.keyboard.down("Space")
    await page.waitForTimeout(1200)
    await page.keyboard.up("Space")
    // Hand-over: the cutscene restores the player's own update.
    await page.waitForFunction(() => !Object.prototype.hasOwnProperty.call((globalThis as any).__afterhoursPlayer, "update"), undefined, { timeout: 20000 })
    await page.waitForTimeout(1500)
    const r = await page.evaluate(() => {
      const G = globalThis as any
      const p = G.__afterhoursPlayer
      const car = G.__afterhoursIntro.car
      const box = car.footprint()
      const { x, y, z } = p.pos
      const inside = box && x > box.min[0] - 0.3 && x < box.max[0] + 0.3 && z > box.min[2] - 0.3 && z < box.max[2] + 0.3
      const solid = box && p.ctx.colliders.includes(box)
      const ground = G.__afterhoursIntro.route.groundAt(x, z)
      const cam = G.__afterhoursDebug.camera.position
      const local = car.root.worldToLocal(cam.clone())
      return { x: +x.toFixed(2), y: +y.toFixed(3), z: +z.toFixed(2), ground: +ground.toFixed(3), eye: +(cam.y - y).toFixed(2), carLocal: [+local.x.toFixed(2), +local.z.toFixed(2)], yaw: +p.yaw.toFixed(2), inside, solid, door: car.doorAmount, doorRot: +car.door.rotation.y.toFixed(3) }
    })
    const ok = !r.inside && r.solid && Math.abs(r.y - r.ground) < 0.02 && r.eye > 1.5 && r.door === 0 && r.doorRot === 0 && r.carLocal[0] < -1.2
    if (!ok) failed++
    const file = `${outDir}/skip-${t}.png`
    await page.screenshot({ path: file })
    console.log(`${ok ? "ok  " : "FAIL"} skip at ${before.toFixed(1)} s`, JSON.stringify(r), errors.slice(0, 3).join(" | "), file)
    await page.close()
  }
} finally {
  await browser.close()
}
process.exit(failed ? 1 : 0)
