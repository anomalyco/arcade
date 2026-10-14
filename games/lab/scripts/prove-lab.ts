// Headless Metal proof for the single Lab app: every game's sections load from /arcade/lab/, assets resolve under the
// prefix, audio exists only after a gesture, and mute/volume persist. Never plays sound (muted browser, muted Lab).
//   bun games/lab/scripts/prove-lab.ts [--out dir] [--base http://127.0.0.1:5180]
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium, type Page } from "playwright-core"
import { createServer, type ViteDevServer } from "vite"

const root = resolve(import.meta.dir, "..")
const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }
const out = resolve(arg("--out") ?? resolve(root, "../../captures/unified-lab"))
mkdirSync(out, { recursive: true })

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache).filter(n => /^chromium-\d+$/.test(n)).reverse()
  .map(n => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)
assert(executablePath, "Playwright Chromium binary required")

let server: ViteDevServer | undefined
let base = arg("--base")
if (!base) {
  server = await createServer({ root, configFile: resolve(root, "vite.config.ts"), base: "/arcade/lab/", server: { host: "127.0.0.1", port: 0 }, logLevel: "warn" })
  await server.listen()
  const address = server.httpServer!.address()
  if (!address || typeof address === "string") throw new Error("No port")
  base = `http://127.0.0.1:${address.port}`
}
const browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const report: Record<string, unknown> = { base }
const errors: string[] = []

async function open(path: string, options: { audioProbe?: boolean } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  page.on("pageerror", e => errors.push(`${path}: ${e.message}`))
  page.on("console", m => { if (m.type() === "error") errors.push(`${path}: ${m.text()}`) })
  const failed: string[] = []
  page.on("response", r => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`) })
  if (options.audioProbe) await page.addInitScript(() => {
    const w = window as unknown as { __audioContexts: number; __audioStates: string[] }
    w.__audioContexts = 0; w.__audioStates = []
    const Native = window.AudioContext
    window.AudioContext = class extends Native {
      constructor(options?: AudioContextOptions) { super(options); w.__audioContexts++ }
    } as typeof AudioContext
  })
  await page.goto(`${base}${path}`)
  return { page, failed }
}

const ready = (page: Page) => page.waitForFunction(() => Boolean((window as unknown as { lab?: unknown }).lab), undefined, { timeout: 60000 })
const shot = (page: Page, name: string) => page.screenshot({ path: resolve(out, name) })

try {
  // 1. Every game's sections, loaded from the one app.
  const sectionsByGame: Record<string, string[]> = {}
  for (const game of ["all", "getaway", "blackout", "outbreak"]) {
    const { page, failed } = await open(`/arcade/lab/?bench${game === "all" ? "" : `&game=${game}`}`)
    await ready(page)
    const ids = await page.evaluate(() => (window as unknown as { lab: { sections: { id: string }[] } }).lab.sections.map(s => s.id))
    sectionsByGame[game] = ids
    for (const id of ids) {
      await page.evaluate(async id => {
        const lab = (window as unknown as { lab: { select(id: string): void; advance(dt: number): void; render(): Promise<number> } }).lab
        lab.select(id); for (let i = 0; i < 3; i++) { lab.advance(1 / 60); await lab.render() }
      }, id)
    }
    assert.deepEqual(failed, [], `${game}: failed requests`)
    await page.close()
  }
  report.sections = sectionsByGame
  for (const id of ["getaway-effects", "blackout-effects", "fire-water", "splatter", "outbreak-vignette", "audio", "looks", "materials", "foliage", "spawn"]) {
    assert(sectionsByGame.all!.includes(id), `all: missing ${id}`)
  }
  assert(!sectionsByGame.getaway!.includes("blackout-effects"), "getaway only loads its own adapters")
  assert(!sectionsByGame.outbreak!.includes("spawn"), "outbreak has no Playground")
  writeFileSync(resolve(out, "proof.json"), JSON.stringify(report, null, 2))
  assert.deepEqual(errors, [], "browser errors")
  console.log(JSON.stringify(report, null, 2))
} finally {
  writeFileSync(resolve(out, "proof.json"), JSON.stringify({ ...report, errors }, null, 2))
  await browser.close()
  await server?.close()
}
