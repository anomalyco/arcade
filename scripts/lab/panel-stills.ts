/// <reference types="@webgpu/types" />
// Stills of a game's Backquote LabPanel and its shape (groups, sub-headings, rows on show, panel height), for before
// and after comparisons. --root serves another checkout (a worktree at origin/main for "before").
//   hivemind run --kind browser --fetch captures/lab-panel-ux -- bun scripts/lab/panel-stills.ts --game outbreak --label after
//   bun scripts/lab/panel-stills.ts --root /tmp/arcade-before --game woods --label before --dist   (build first)
// Never opens a visible window and never plays sound (muted browser).
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve, sep } from "node:path"
import { chromium } from "playwright-core"
import { createServer } from "vite"

const arg = (name: string) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const here = resolve(import.meta.dir, "../..")
const root = resolve(arg("--root") ?? here)
const games = (arg("--game") ?? "outbreak").split(",")
const label = arg("--label") ?? "after"
const out = resolve(here, arg("--out") ?? "captures/lab-panel-ux")
const wait = Number(arg("--wait") ?? 6000)
const query = arg("--query") ?? ""
// --dist serves each game's production build (games/<game>/dist/arcade/<game>, built first) instead of Vite dev.
const dist = process.argv.includes("--dist")

async function serve(game: string): Promise<{ port: number; close: () => Promise<void> }> {
  const dir = resolve(root, "games", game)
  if (!dist) {
    const server = await createServer({ root: dir, configFile: resolve(dir, "vite.config.ts"), server: { host: "127.0.0.1", port: 0 }, logLevel: "error" })
    await server.listen()
    const addr = server.httpServer!.address()
    if (!addr || typeof addr === "string") throw new Error("No dev server port")
    return { port: addr.port, close: () => server.close() }
  }
  const built = resolve(dir, "dist/arcade", game)
  const prefix = `/arcade/${game}/`
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname
    if (!path.startsWith(prefix)) return Response.redirect(prefix, 302)
    const file = resolve(built, decodeURIComponent(path.slice(prefix.length)) || "index.html")
    if (!file.startsWith(built + sep) && file !== built) return new Response("Not found", { status: 404 })
    const f = Bun.file(file)
    return (await f.exists()) ? new Response(f) : new Response("Not found", { status: 404 })
  } })
  return { port: server.port!, close: async () => { server.stop(true) } }
}
mkdirSync(out, { recursive: true })

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache)
  .filter(n => /^chromium-\d+$/.test(n))
  .sort()
  .reverse()
  .map(n => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`)
  .find(existsSync)
assert(executablePath, "Playwright Chromium binary required")
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio", "--autoplay-policy=user-gesture-required"],
})

try {
  for (const game of games) {
    const server = await serve(game)
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
    const errors: string[] = []
    page.on("pageerror", e => errors.push(e.message))
    page.on("console", m => { if (m.type() === "error") errors.push(m.text().slice(0, 300)) })
    await page.goto(`http://127.0.0.1:${server.port}/arcade/${game}/${query}`)
    const ready = await page.waitForSelector("[data-lab-panel]", { state: "attached", timeout: 300_000 }).then(() => true, () => false)
    if (!ready) {
      console.error(game, "no panel", errors)
      await page.screenshot({ path: resolve(out, `${game}-${label}-failed.png`) })
      await page.close()
      await server.close()
      continue
    }
    await page.waitForTimeout(wait)
    let open = false
    for (let tries = 0; tries < 6 && !open; tries++) {
      await page.keyboard.press("Backquote")
      open = await page.waitForSelector("[data-lab-panel] .lab-panel-body:not([hidden])", { timeout: 4000 }).then(() => true, () => false)
    }
    if (!open) {
      console.error(game, "panel did not open", errors, await page.evaluate(() => ({
        active: document.activeElement?.outerHTML.slice(0, 160),
        host: document.querySelector("[data-lab-panel]")?.outerHTML.slice(0, 300),
        bodyHidden: document.querySelector("[data-lab-panel] .lab-panel-body")?.hasAttribute("hidden"),
      })))
      await page.screenshot({ path: resolve(out, `${game}-${label}-failed.png`) })
      await page.close()
      await server.close()
      continue
    }
    await page.waitForTimeout(900)
    const shape = await page.evaluate(() => {
      const host = document.querySelector<HTMLElement>("[data-lab-panel]")!
      const body = host.querySelector<HTMLElement>(".lab-panel-body")!
      const shown = (el: Element) => (el as HTMLElement).getClientRects().length > 0
      const groups = [...host.querySelectorAll<HTMLElement>(".knobs-group-head")].filter(shown).map(head => ({
        label: head.querySelector(".knobs-group-label")?.textContent ?? head.textContent,
        open: head.getAttribute("aria-expanded") !== "false",
        foldable: head.hasAttribute("data-foldable"),
      }))
      const subheads = [...host.querySelectorAll<HTMLElement>(".knobs-subhead")].filter(shown).map(s => ({ label: s.textContent, open: s.getAttribute("aria-expanded") === "true" }))
      return {
        groups,
        subheads,
        rowsShown: [...host.querySelectorAll(".knobs-row")].filter(shown).length,
        rowsTotal: host.querySelectorAll(".knobs-row").length,
        panelHeight: Math.round(body.getBoundingClientRect().height),
        contentHeight: body.scrollHeight,
        viewport: innerHeight,
        fits: body.scrollHeight <= body.clientHeight + 1,
      }
    })
    await page.locator("[data-lab-panel]").screenshot({ path: resolve(out, `${game}-${label}-panel.png`), timeout: 120_000 })
    await page.screenshot({ path: resolve(out, `${game}-${label}.png`), timeout: 120_000 }).catch(e => errors.push(String(e).slice(0, 200)))
    writeFileSync(resolve(out, `${game}-${label}.json`), `${JSON.stringify({ game, label, root, shape, errors }, null, 2)}\n`)
    console.log(game, label, JSON.stringify({ groups: shape.groups.length, subheads: shape.subheads.length, rowsShown: shape.rowsShown, rowsTotal: shape.rowsTotal, contentHeight: shape.contentHeight, fits: shape.fits }))
    await page.close()
    await server.close()
  }
} finally {
  await browser.close()
}
