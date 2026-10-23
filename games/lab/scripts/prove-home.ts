/// <reference types="@webgpu/types" />
// Proves the Lab's Home and Labs flow in a real browser and writes stills to captures/lab-home.
//   hivemind run --kind browser -- bun games/lab/scripts/prove-home.ts
// Headless and muted; live audio is blocked.
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { type Page } from "playwright-core"
import { browserBudget } from "../../../scripts/browser-budget"
import { createServer } from "vite"

await using budget = browserBudget()
const { chromium } = budget

const root = resolve(import.meta.dir, "../../..")
const out = resolve(root, "captures/lab-home")
mkdirSync(out, { recursive: true })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache)
  .filter(n => /^chromium_headless_shell-\d+$/.test(n))
  .reverse()
  .map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
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

  await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await p.keyboard.press("Meta+k")
  const k = await p.evaluate(() => ({ search: document.activeElement?.classList.contains("lh-search-input") ?? false, palette: Boolean(document.querySelector(".knobs-palette-item")) }))
  check(k.search && !k.palette, `⌘K on Home is its search, not the palette behind it (${JSON.stringify(k)})`)
  await p.keyboard.press("Escape")
  await p.keyboard.press("/")
  await p.keyboard.type("street")
  s = await state(p)
  check(s.visible.includes("world/look-and-world") && s.visible.length < 6, `search narrows the list (${s.visible.join(", ")})`)
  await p.waitForTimeout(700)
  await p.screenshot({ path: resolve(out, "home-search.png") })
  await p.keyboard.press("Enter")
  await p.waitForFunction(() => !(window as unknown as { labs: { home: { open: boolean } } }).labs.home.open, undefined, { timeout: 30000 })
  await p.waitForTimeout(2500)
  s = await state(p)
  check(s.current === "world/look-and-world", `Enter opens the lab (${s.current})`)
  check(s.url.includes("lab=world%2Flook-and-world") || s.url.includes("lab=world/look-and-world"), `the URL names the lab (${s.url})`)
  check(s.crumb.includes("Look and world"), `the top bar says where you are (${s.crumb})`)
  await p.screenshot({ path: resolve(out, "lab.png") })

  await p.locator('canvas[aria-label="Lab scene"]').click({ position: { x: 600, y: 300 } })
  await p.keyboard.press("2")
  await p.waitForTimeout(500)
  s = await state(p)
  check(s.variant === "golden-hour", `2 picks the second variant (${s.variant})`)
  const chrome = await p.evaluate(() => ({
    library: getComputedStyle(document.querySelector(".lab-library")!).display,
    world: getComputedStyle(document.querySelector(".lab-world")!).display,
  }))
  check(chrome.library === "none" && chrome.world === "none", `a lab hides the Library drawer and World footer (${JSON.stringify(chrome)})`)
  await p.keyboard.press("Control+Space")
  await p.waitForTimeout(300)
  const libraryOpen = await p.evaluate(() => document.querySelector(".lab-workbench")!.getAttribute("data-drawer"))
  check(libraryOpen !== "true", "Ctrl+Space does nothing in a lab")
  await p.keyboard.press("Shift+Digit3")
  await p.waitForTimeout(800)
  s = await state(p)
  const wipe = await p.evaluate(() => { const w = document.querySelector<HTMLElement>(".lab-wipe-overlay"); return Boolean(w && !w.hidden && getComputedStyle(w).display !== "none") })
  check(s.variant === "dusk" && wipe, `⇧3 shows Golden hour beside Dusk as an A/B wipe (${s.variant}, wipe ${wipe})`)
  await p.screenshot({ path: resolve(out, "lab-wipe.png") })
  await p.evaluate(() => (window as unknown as { labWorkbench: { invoke(id: string): unknown } }).labWorkbench.invoke("compare.wipe"))

  await p.keyboard.press("Alt+BracketRight")
  await p.waitForTimeout(2500)
  s = await state(p)
  check(s.current === "world/effects", `⌥] steps to the next lab (${s.current})`)
  await p.keyboard.press("Alt+BracketLeft")
  await p.waitForTimeout(2000)
  s = await state(p)
  check(s.current === "world/look-and-world", `⌥[ steps back (${s.current})`)

  await p.keyboard.press("h")
  await p.waitForTimeout(400)
  s = await state(p)
  check(s.home && s.focusInHome, "H shows Home")
  await p.screenshot({ path: resolve(out, "home-back.png") })
  await p.keyboard.press("Escape")
  await p.waitForTimeout(400)
  s = await state(p)
  check(!s.home && s.current === "world/look-and-world", "Esc goes back to the open lab")
  await p.context().close()

  // Making, keeping, archiving and deleting labs from Home.
  const life = await page()
  await life.waitForTimeout(1200)
  const labs = (q: Page) => q.evaluate(() => {
    const w = window as unknown as { labs: { catalog: { all(): { ref: string; status: string; title: string }[]; archived(): { ref: string }[] } } }
    return { all: w.labs.catalog.all().map(l => `${l.ref}:${l.status}`), archived: w.labs.catalog.archived().map(l => l.ref) }
  })
  await life.keyboard.press("/")
  await life.keyboard.type("weather")
  await life.keyboard.press("ArrowDown")
  await life.keyboard.press("Meta+d")
  await life.waitForTimeout(300)
  let l = await labs(life)
  check(l.all.includes("world/look-and-world-copy:draft"), "⌘D makes a draft copy beside the original")
  await life.screenshot({ path: resolve(out, "home-draft.png") })
  await life.keyboard.press("Meta+s")
  l = await labs(life)
  check(l.all.includes("world/look-and-world-copy:kept"), "⌘S keeps the draft")
  await life.keyboard.press("Backspace")
  await life.waitForTimeout(300)
  l = await labs(life)
  check(l.archived.includes("world/look-and-world-copy") && !l.all.some(x => x.startsWith("world/look-and-world-copy")), "⌫ archives it")
  await life.evaluate(() => (window as unknown as { labs: { home: { search(t: string): void } } }).labs.home.search("weather copy"))
  await life.waitForTimeout(500)
  await life.locator('[data-act="restore"]').click()
  l = await labs(life)
  check(l.all.includes("world/look-and-world-copy:kept"), "Restore brings it back")
  await life.keyboard.press("Shift+Backspace")
  await life.waitForTimeout(400)
  await life.screenshot({ path: resolve(out, "home-delete.png") })
  await life.getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true }).click()
  await life.waitForTimeout(400)
  l = await labs(life)
  check(!l.all.some(x => x.startsWith("world/look-and-world-copy")) && !l.archived.includes("world/look-and-world-copy"), "⇧⌫ deletes it after a confirm")
  await life.evaluate(() => (window as unknown as { labs: { home: { search(t: string): void } } }).labs.home.search(""))
  await life.keyboard.press("/")
  await life.keyboard.type("materials")
  await life.keyboard.press("ArrowDown")
  await life.keyboard.press("Backspace")
  await life.waitForTimeout(300)
  l = await labs(life)
  check(l.archived.length === 1, `a station's lab archives too (${l.archived.join(", ")})`)
  if (l.archived[0]) {
    await life.evaluate(r => (window as unknown as { labs: { catalog: { restore(r: string): unknown } } }).labs.catalog.restore(r), l.archived[0])
    l = await labs(life)
    check(l.archived.length === 0, "and restoring it drops this browser's archived copy")
  }
  await life.keyboard.press("/")
  await life.keyboard.press("Meta+a")
  await life.keyboard.press("Backspace")
  await life.keyboard.press("ArrowDown")
  await life.keyboard.press("+")
  await life.waitForTimeout(400)
  await life.screenshot({ path: resolve(out, "home-new.png") })
  await life.locator(".lh-kind", { hasText: "Rug" }).first().click()
  await life.waitForFunction(() => !(window as unknown as { labs: { home: { open: boolean } } }).labs.home.open, undefined, { timeout: 30000 })
  await life.waitForTimeout(1500)
  s = await state(life)
  check(s.current === "drafts/rug-lab", `+ starts a draft lab of a kind and opens it (${s.current})`)
  await life.screenshot({ path: resolve(out, "lab-new-rug.png") })
  await life.context().close()

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
  await budget.exit(1)
}
console.log(`\nall passed · stills in ${out}`)
