// Captures the objective line (src/game/objective.ts) at its three states (entrance flare mid type-in, full hold,
// persistent rest) over a bright and a dark spot, with a subtitle on screen to check they don't clash.
//
//   bun scripts/objective-shot.ts            # captures/objective/<spot>-<state>.png
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync } from "node:fs"

const SPOTS: Record<string, [number, number, number, number, number]> = {
  // Feet x, y, z, yaw, pitch.
  desk: [6.5, 11.56, -7.5, 0.25, -0.32],
  corridor: [-20, 3.96, 0, Math.PI / 2, -0.02],
}
const out = `${import.meta.dir}/../captures/objective`
mkdirSync(out, { recursive: true })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"] })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
await page.goto("http://localhost:5196/?shot=1&view=lobby")
await page.waitForFunction(() => ((globalThis as { __ashwood?: { frames: number } }).__ashwood?.frames ?? 0) > 20, null, { timeout: 180_000 })
for (const [name, at] of Object.entries(SPOTS)) {
  await page.evaluate(async (at) => {
    const g = globalThis as Record<string, any>
    const p = g.__ashwoodPlayer
    ;[p.pos.x, p.pos.y, p.pos.z, p.yaw, p.pitch] = at
    p.resetMotion()
    p.apply()
    const ob = await import(/* @vite-ignore */ `${location.origin}/src/game/objective.ts`)
    const sub = await import(/* @vite-ignore */ `${location.origin}/src/game/shell/subtitles.ts`)
    ob.clearObjective()
    await new Promise((r) => setTimeout(r, 1500))
    ob.setObjective("Check the body at the desk")
    sub.showSubtitle("RADIO", "…anyone on three, come back. Over.", 30)
  }, at)
  await page.waitForTimeout(450)
  await page.screenshot({ path: `${out}/${name}-entrance.png` })
  await page.waitForTimeout(3000)
  await page.screenshot({ path: `${out}/${name}-full.png` })
  await page.waitForTimeout(8000)
  await page.screenshot({ path: `${out}/${name}-rest.png` })
}
console.log(JSON.stringify({ out, errors }))
await browser.close()
process.exit(0)
