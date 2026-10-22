// Deliberately uncooperative work. Run through browser-budget-proof.ts in HiveMind.
import { browserBudget } from "./browser-budget"
import { mkdirSync } from "node:fs"

const mode = process.argv[2] ?? "hang-page"
await using budget = browserBudget()
const { chromium } = budget
const options = { headless: true, args: ["--mute-audio"] }
const browser = mode === "persistent"
  ? await chromium.launchPersistentContext("", options)
  : await chromium.launch(options)
const page = await browser.newPage()
const cdp = "newBrowserCDPSession" in browser
  ? await browser.newBrowserCDPSession()
  : await browser.browser()!.newBrowserCDPSession()
const { processInfo } = await cdp.send("SystemInfo.getProcessInfo")
console.log(`BROWSER_PIDS ${JSON.stringify(processInfo.map((p: { id: number }) => p.id))}`)
if ("isConnected" in browser) browser.on("disconnected", () => console.log("BROWSER_CLOSED"))
else browser.on("close", () => console.log("BROWSER_CLOSED"))
await page.setContent("<h1>Browser budget fixture</h1>")
if (mode === "hang-page") await page.evaluate(() => new Promise(() => {}))
else if (mode === "hang-work") await new Promise(() => {})
else if (mode === "blocked-host") { while (true) {} }
else if (mode === "throw") throw new Error("deliberate fixture error")
else {
  mkdirSync(".lab-output/browser-budget", { recursive: true })
  await page.screenshot({ path: `.lab-output/browser-budget/${mode}.png` })
}
