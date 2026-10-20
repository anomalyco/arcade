// Objective HUD captures: a new objective arriving (centred) and settled (top-left corner), plus a completed one
// struck through, in the corridor and outdoors at the entrance. Dev server :5196, headless, muted.
// Output: captures/objective-<view>-<state>.png.
//
//   bun scripts/objective-shots.ts
import { chromium } from "playwright-core"
import { existsSync, readdirSync } from "node:fs"

const out = `${import.meta.dir}/../captures`
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"] })
const errors: string[] = []
type O = { setObjective(t: string): void; completeObjective(): void }
for (const view of ["corridor", "entrance"]) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  page.on("pageerror", (e) => errors.push(e.message))
  await page.goto(`http://localhost:5196/?view=${view}`)
  await page.waitForFunction(() => (globalThis as { __ashwood?: { complete: boolean } }).__ashwood?.complete, null, { timeout: 300_000 })
  await page.addStyleTag({ content: "#hud, [data-lab-panel] { display: none !important; }" })
  await page.waitForTimeout(1500)
  const call = (fn: "set" | "complete", text = "") =>
    page.evaluate(
      async ([fn, text]) => {
        const url = "/src/game/objective.ts"
        const o = (await import(/* @vite-ignore */ url)) as unknown as O
        if (fn === "set") o.setObjective(text!)
        else o.completeObjective()
      },
      [fn, text] as const,
    )
  await call("set", "Find the radio room: 3-08")
  await page.waitForTimeout(1900)
  await page.screenshot({ path: `${out}/objective-${view}-arriving.png` })
  await page.waitForTimeout(9000)
  await page.screenshot({ path: `${out}/objective-${view}-corner.png` })
  if (view === "corridor") {
    await call("complete")
    await page.waitForTimeout(500)
    await page.screenshot({ path: `${out}/objective-${view}-struck.png` })
  }
  await page.close()
}
await browser.close()
console.log(errors.length ? `errors: ${errors.join(" | ")}` : "no page errors")
