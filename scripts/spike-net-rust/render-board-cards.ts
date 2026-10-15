import { readFileSync } from "node:fs"
import { join } from "node:path"
import { chromium } from "playwright-core"

const html = readFileSync(join(import.meta.dir, "prototype/index.html"), "utf8")
const browser = await chromium.launch({ headless: true, args: ["--mute-audio", "--disable-gpu"] })
const page = await browser.newPage({ viewport: { width: 1280, height: 940 }, deviceScaleFactor: 2 })

await page.setContent(html, { waitUntil: "load" })

for (let i = 0; i < 4; i++) {
  await page.evaluate((idx) => (window as any).setOpt(idx), i)
  await page.screenshot({ path: join(import.meta.dir, `opt-${i + 1}.png`) })
}

await browser.close()
console.log("Rendered 4 board option cards.")
