// Headless check of the dev panel (the shared Lab panel, src/dev/dev-panel.ts) against a running dev server: Backquote
// opens it, and a weather preset, a sound audition and a bot spawn work through its buttons; a production build has
// no panel. Screenshots go to captures/lab-panel/.
//   bun scripts/lab-panel-shot.ts --base http://localhost:5197/ [--prod http://localhost:4173/] [--swiftshader]
// The dev server must run its Worker with CARRIER_DEV=1 (.dev.vars) for the bot check.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { type Page } from "playwright-core"
import { browserBudget } from "../../../scripts/browser-budget"

await using budget = browserBudget()
const { chromium } = budget

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}
const base = arg("base") ?? "http://localhost:5197/"
const prod = arg("prod")
const swiftshader = process.argv.includes("--swiftshader")
const out = join(import.meta.dir, "..", "captures", "lab-panel")
mkdirSync(out, { recursive: true })

let failures = 0
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`)
  if (!ok) failures++
}

const browser = await chromium.launch({
  headless: true,
  ...(swiftshader || process.platform !== "darwin" ? {} : { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }),
  args: ["--enable-unsafe-webgpu", "--mute-audio", "--autoplay-policy=no-user-gesture-required", ...(swiftshader ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--enable-features=Vulkan", "--use-vulkan=swiftshader"] : ["--use-angle=metal", "--ignore-gpu-blocklist"])],
})

async function load(url: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  page.on("pageerror", (e) => console.log(`pageerror: ${e.message}`))
  // ?room= joins straight away only with a stored name.
  await page.addInitScript(() => localStorage.setItem("carrier.name", "LABCHECK"))
  await page.goto(url, { waitUntil: "load" })
  await page.waitForFunction(() => !!(globalThis as { carrier?: { game?: { state: { sea: unknown } } } }).carrier?.game?.state.sea, null, { timeout: 120_000 })
  await page.waitForTimeout(1500)
  return page
}

const js = <T>(page: Page, body: string) => page.evaluate((b) => new Function("c", b)((globalThis as unknown as { carrier: unknown }).carrier) as T, body)
const panel = (page: Page) => page.locator("[data-carrier-dev]")
const press = async (page: Page, label: string) => {
  await panel(page).locator("button", { hasText: label }).first().click({ timeout: 5000 })
  await page.waitForTimeout(300)
}
const readout = (page: Page, key: string) => js<string>(page, `return document.querySelector('[data-carrier-dev] .knobs-row[data-field="${key}"]')?.textContent ?? ""`)
/** Waits (up to `ms`) for a readout's text to match. */
const readoutMatches = async (page: Page, key: string, re: RegExp, ms = 15_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (re.test(await readout(page, key))) return true
    await page.waitForTimeout(250)
  }
  return false
}

const room = `labpanel${Math.floor(Math.random() * 1e6)}`
const page = await load(`${base}?room=${room}&tod=10.5`)
check(!(await js<boolean>(page, "return c.debugMenu.visible")), "the dev panel starts closed")
// A focused text field keeps Backquote (the load screen's name field may hold focus): let it go first.
await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
await page.keyboard.press("Backquote")
await page.waitForTimeout(500)
check(await js<boolean>(page, "return c.debugMenu.visible") && (await panel(page).isVisible()), "Backquote opens the dev panel")
const tabs = await panel(page).locator(".knobs-tab").allTextContents()
check(["World", "Audio", "Sounds", "Flight", "Bots", "Game"].every((t) => tabs.some((x) => x.includes(t))), `its tabs: ${tabs.join(", ")}`)

// World: a weather preset through its button switches the weather to manual, fading to the preset.
await press(page, "Heavy")
await page.waitForTimeout(400)
check(await js<boolean>(page, "return c.lab.mode === 'manual' && c.lab.target.rain > 0.8"), `the Heavy preset button sets a manual storm (rain ${await js(page, "return c.lab.target.rain")})`)
await js(page, "c.debugMenu.select('weather')")
await page.waitForTimeout(1200)
await page.screenshot({ path: join(out, "world-weather.png") })
check((await readout(page, "weather-showing")).includes("manual"), `the Showing readout: ${await readout(page, "weather-showing")}`)

// Sounds: a take auditions only through its ▶ button.
await js(page, "c.debugMenu.open('sounds'); c.debugMenu.panel.reveal('sound.trap.play', false)")
await page.waitForTimeout(600)
check((await readout(page, "sounds-playing")).includes("—"), "nothing plays on entering the Sounds tab")
await panel(page).locator('.knobs-row[data-field="sound.trap.play"] button', { hasText: "▶ 2" }).click({ timeout: 5000 })
check(await readoutMatches(page, "sounds-playing", /trap/), `▶ 2 auditions the take: ${await readout(page, "sounds-playing")}`)
await page.screenshot({ path: join(out, "sounds.png") })

// Bots: spawn one Hornet from the panel in this dev room; the live list shows it.
await js(page, "c.debugMenu.open('bots')")
check(await readoutMatches(page, "bots-status", /dev room/i), `the Bots status: ${await readout(page, "bots-status")}`)
await js(page, "c.debugMenu.panel.reveal('bots-spawn', false)")
await panel(page).locator('.knobs-row[data-field="bots-spawn"] button', { hasText: "Spawn" }).click({ timeout: 15_000 })
const spawned = await page.waitForFunction(() => ((globalThis as unknown as { carrier: { net: { bots: unknown[] } } }).carrier.net.bots.length ?? 0) > 0, null, { timeout: 20_000 }).then(() => true, () => false)
check(spawned, "Spawn puts a bot in the room")
await js(page, "c.debugMenu.panel.reveal('bots-list', false)")
check(await readoutMatches(page, "bots-list", /BOT/), `the live list: ${(await readout(page, "bots-list")).slice(0, 120)}`)
await page.screenshot({ path: join(out, "bots.png") })
await js(page, "c.debugMenu.open('view'); c.debugMenu.panel.reveal('shakeScale', false)")
await page.waitForTimeout(600)
check(await panel(page).locator('.knobs-row[data-field="shakeScale"]').isVisible(), "the Game tab has the camera shake")
await js(page, "c.debugMenu.open('bots')")
await page.waitForTimeout(400)
await press(page, "Remove")
await page.keyboard.press("Backquote")
await page.waitForTimeout(400)
check(!(await js<boolean>(page, "return c.debugMenu.visible")), "Backquote closes it")
await page.close()

if (prod) {
  const p = await load(`${prod}?seed=7&tod=10.5&bots&lab=weather&sounds=1`)
  await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await p.keyboard.press("Backquote")
  await p.waitForTimeout(500)
  check(await p.evaluate(() => !document.querySelector("[data-lab-panel]") && !(globalThis as unknown as { carrier: { debugMenu?: unknown } }).carrier.debugMenu), "a production build has no dev panel (` and ?lab/?sounds/?bots do nothing)")
  await p.screenshot({ path: join(out, "prod-no-panel.png") })
  await p.close()
}

await browser.close()
console.log(failures ? `${failures} FAILED` : "all ok")
await budget.exit(failures ? 1 : 0)
