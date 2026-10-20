// Prelude Lab captures: the grid and one fullscreen frame mid-type, to captures/prelude-lab-*.png (dev server :5196).
//
//   bun src/prelude-lab/shots.ts [--draft memo] [--panel 0]
import { chromium } from "playwright-core"
import { existsSync, readdirSync } from "node:fs"

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`)
  return i > 0 ? process.argv[i + 1] : undefined
}
const out = `${import.meta.dir}/../../captures`
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--mute-audio"] })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
await page.goto("http://localhost:5196/prelude-lab.html")
await page.evaluate(() => localStorage.removeItem("preludeLab.v1"))
await page.reload()
const draft = arg("draft")
if (draft) await page.click(`.pl-drafts button[data-id="${draft}"]`)
await page.waitForTimeout(5500)
await page.screenshot({ path: `${out}/prelude-lab-grid.png` })
await page.click(".pl-card >> nth=" + (arg("panel") ?? "0"))
await page.waitForTimeout(4000)
await page.screenshot({ path: `${out}/prelude-lab-full.png` })
await browser.close()
console.log(errors.length ? `errors: ${errors.join(" | ")}` : "no page errors")
