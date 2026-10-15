/// <reference types="@webgpu/types" />
// Proves the Lab's Home and Labs flow in a real browser and writes stills to captures/lab-home.
//   hivemind run --kind browser -- bun games/lab/scripts/prove-home.ts
// Headless and muted; live audio is blocked.
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { chromium, type Page } from "playwright-core"
import { createServer } from "vite"

const root = resolve(import.meta.dir, "../../..")
const out = resolve(root, "captures/lab-home")
mkdirSync(out, { recursive: true })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache)
  .filter(n => /^chromium-\d+$/.test(n))
  .reverse()
  .map(n => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`)
  .find(existsSync)
if (!executablePath) throw new Error("Playwright Chromium binary required")

const dir = resolve(root, "games/lab")
const server = await createServer({ root: dir, configFile: resolve(dir, "vite.config.ts"), server: { host: "127.0.0.1", port: 0 }, logLevel: "error" })
await server.listen()
const addr = server.httpServer!.address()
if (!addr || typeof addr === "string") throw new Error("No dev server port")
const base = `http://127.0.0.1:${addr.port}/arcade/lab/`
const browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })

const failures: string[] = []
function check(ok: boolean, what: string) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`)
  if (!ok) failures.push(what)
}

async function page(query = ""): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
  const p = await context.newPage()
  p.on("pageerror", e => failures.push(`pageerror: ${e.message}`))
  await p.addInitScript(() => {
    window.AudioContext = class { constructor() { throw new Error("Live audio is disabled") } } as unknown as typeof AudioContext
  })
  await p.goto(`${base}${query}`)
  await p.waitForFunction(() => Boolean((window as { labs?: unknown }).labs), undefined, { timeout: 120000 })
  return p
}

const state = (p: Page) => p.evaluate(() => {
  const w = window as unknown as { labs: { home: { open: boolean; visibleLabs(): string[] }; current(): { ref: string } | null }; stations: { snapshot(): { variant: { id: string } | null } } }
  return {
    home: w.labs.home.open,
    visible: w.labs.home.visibleLabs(),
    current: w.labs.current()?.ref ?? null,
    variant: w.stations.snapshot().variant?.id ?? null,
    url: location.search,
    crumb: document.querySelector(".lab-crumb")?.textContent ?? "",
    focusInHome: Boolean(document.activeElement?.closest("[data-lab-home]")),
  }
})

try {
  const p = await page()
  await p.waitForTimeout(1500)
  let s = await state(p)
  check(s.home, "the Lab opens on Home")
  check(s.visible.length >= 22, `Home lists every lab (${s.visible.length})`)
  check(s.focusInHome, "Home has keyboard focus")
  await p.screenshot({ path: resolve(out, "home.png") })

  await p.keyboard.press("/")
  await p.keyboard.type("rain")
  s = await state(p)
  check(s.visible.includes("look-and-light/weather") && s.visible.length < 6, `search narrows the list (${s.visible.join(", ")})`)
  await p.screenshot({ path: resolve(out, "home-search.png") })
  await p.keyboard.press("Enter")
  await p.waitForFunction(() => !(window as unknown as { labs: { home: { open: boolean } } }).labs.home.open, undefined, { timeout: 30000 })
  await p.waitForTimeout(2500)
  s = await state(p)
  check(s.current === "look-and-light/weather", `Enter opens the lab (${s.current})`)
  check(s.url.includes("lab=look-and-light%2Fweather") || s.url.includes("lab=look-and-light/weather"), `the URL names the lab (${s.url})`)
  check(s.crumb.replace(/\s+/g, " ").includes("Labs›Look and light›Weather") || s.crumb.includes("Look and light"), `the top bar says where you are (${s.crumb})`)
  await p.screenshot({ path: resolve(out, "lab.png") })

  await p.locator("[data-lab-viewport] canvas").click({ position: { x: 600, y: 300 } })
  await p.keyboard.press("2")
  await p.waitForTimeout(500)
  s = await state(p)
  check(s.variant === "drizzle", `2 picks the second variant (${s.variant})`)

  await p.keyboard.press("Alt+BracketRight")
  await p.waitForTimeout(2500)
  s = await state(p)
  check(s.current === "look-and-light/vegetation", `⌥] steps to the next lab (${s.current})`)
  await p.keyboard.press("Alt+BracketLeft")
  await p.waitForTimeout(2000)
  s = await state(p)
  check(s.current === "look-and-light/weather", `⌥[ steps back (${s.current})`)

  await p.keyboard.press("h")
  await p.waitForTimeout(400)
  s = await state(p)
  check(s.home && s.focusInHome, "H shows Home")
  await p.screenshot({ path: resolve(out, "home-back.png") })
  await p.keyboard.press("Escape")
  await p.waitForTimeout(400)
  s = await state(p)
  check(!s.home && s.current === "look-and-light/weather", "Esc goes back to the open lab")
  await p.context().close()

  const old = await page("?station=explosions")
  await old.waitForTimeout(2500)
  s = await state(old)
  check(!s.home && s.current === "effects/explosions", `an old ?station= link opens its lab (${s.current})`)
  await old.context().close()

  const deep = await page("?lab=characters/game-feel")
  await deep.waitForTimeout(2500)
  s = await state(deep)
  check(!s.home && s.current === "characters/game-feel", `?lab= opens a page lab (${s.current})`)
  await deep.context().close()
} finally {
  await browser.close()
  await server.close()
}
if (failures.length) {
  console.error(`\n${failures.length} failed:\n${failures.join("\n")}`)
  process.exit(1)
}
console.log(`\nall passed · stills in ${out}`)
