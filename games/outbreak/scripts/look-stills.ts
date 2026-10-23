// Stills of the Outbreak look presets and survivor styles at the start house at dusk, each beside today's look,
// in one headless run (no window, muted). Builds nothing: run `bun run build` first.
// LOOK_OUT=<dir> bun scripts/look-stills.ts   (default ../../captures/outbreak-look-stills)
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { type Page } from "playwright-core"
import { browserBudget } from "../../../scripts/browser-budget"
import { HERO_STYLES } from "../src/look/hero"
import { OUTBREAK_LOOK_PRESETS } from "../src/look/presets"

await using budget = browserBudget()
const { chromium } = budget

const game = resolve(import.meta.dir, "..")
const out = resolve(process.env.LOOK_OUT ?? resolve(game, "../../captures/outbreak-look-stills"))
mkdirSync(out, { recursive: true })
const root = resolve(game, "dist/arcade/outbreak")
assert(existsSync(resolve(root, "index.html")), "run bun run build first")
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const path = new URL(req.url).pathname
  const file = Bun.file(resolve(root, `.${path === "/" ? "/index.html" : path}`))
  return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 })
} })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
  .map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
assert(chrome)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })

/**
 * How the survivor moves before the still: a second of input from the front walk, the same for every look. `close`
 * moves the camera in (below the Lab's 24 m minimum) and crops around the survivor to judge the figure and its motion.
 */
type Move = { name: string; zoom: number; close?: boolean; mx: number; my: number; aim: number; sprint?: boolean; from: [number, number] }
const WALK: Move = { name: "walk", zoom: 40, mx: 0, my: -1, aim: -Math.PI / 2, from: [27.7, 43.2] }
const MOVES: Move[] = [
  { ...WALK, name: "walk", zoom: 11, close: true },
  { name: "run", zoom: 11, close: true, mx: 0, my: -1, aim: -Math.PI / 2, sprint: true, from: [27.7, 45.5] },
  { name: "strafe", zoom: 11, close: true, mx: 1, my: 0, aim: -Math.PI / 2, from: [25.9, 41] },
  { name: "aim", zoom: 11, close: true, mx: 0, my: 0, aim: -2.2, from: [27.7, 41] },
]

const meta: Record<string, unknown> = {}
const errors: string[] = []
async function still(page: Page, name: string, knobs: { preset: string; heroStyle?: number }, move: Move) {
  const info = await page.evaluate(async ({ knobs, move }) => {
    const h = (window as any).__arcadeHarness
    h.reset(7)
    h.setLab("timeScale", 0)
    h.setLab("hour", 17.5)
    h.setZoomRaw(move.zoom)
    h.lookPreset(knobs.preset)
    if (knobs.heroStyle !== undefined) h.setLab("heroStyle", knobs.heroStyle)
    h.pose(move.from[0], move.from[1], move.aim)
    for (let i = 0; i < 20; i++) await h.step()
    const aimOnly = move.mx === 0 && move.my === 0
    // Aim: hold the trigger on an empty-sounding moment (muted) so the pistol comes up to the raised aim.
    for (let i = 0; i < 52; i++) await h.step(1 / 60, { mx: move.mx, my: move.my, aim: move.aim, sprint: move.sprint ?? false, fire: aimOnly && i === 30 })
    const s = h.state()
    const rect = h.resolveTargetRect({ objectId: "player" })
    return { hour: s.hour ?? null, look: s.look ?? null, player: { x: s.player?.x, y: s.player?.y }, rect }
  }, { knobs, move })
  meta[name] = info
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>("#status, #hotbar, #stamina, #battery, #prompt, .callouts, .callout, #hud, .hud")) el.style.visibility = "hidden"
  })
  const file = resolve(out, `${name}.png`)
  if (move.close && info.rect) {
    const cx = info.rect.x + info.rect.width / 2
    const cy = info.rect.y + info.rect.height / 2
    await page.screenshot({ path: file, clip: { x: Math.max(0, Math.min(1000 - 500, cx - 250)), y: Math.max(0, Math.min(680 - 340, cy - 190)), width: 500, height: 340 } })
  } else {
    await page.locator("#game").screenshot({ path: file })
  }
  return file
}

/** One sheet: today's still on the left, each option beside it, labelled. */
async function sheet(page: Page, file: string, title: string, tiles: { label: string; file: string }[], columns: number) {
  const img = (f: string) => `data:image/png;base64,${readFileSync(f).toString("base64")}`
  await page.setViewportSize({ width: columns * 520 + 24, height: 200 })
  await page.setContent(`<body style="margin:0;padding:12px;background:#111;color:#ddd;font:15px -apple-system,sans-serif">
    <div style="font-size:18px;margin:0 0 10px">${title}</div>
    <div style="display:grid;grid-template-columns:repeat(${columns},508px);gap:12px">
    ${tiles.map(t => `<figure style="margin:0"><img src="${img(t.file)}" style="width:508px;display:block"><figcaption style="padding:4px 0">${t.label}</figcaption></figure>`).join("")}
    </div></body>`)
  await page.locator("body").screenshot({ path: file })
}

try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 680 }, deviceScaleFactor: 1 })
  page.on("pageerror", e => errors.push(e.message))
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
  await page.goto(`http://127.0.0.1:${fixture.port}/?solo&seed=7&bench&peaceful=1`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready)

  const presets: { label: string; file: string }[] = []
  const presetsClose: { label: string; file: string }[] = []
  for (const p of OUTBREAK_LOOK_PRESETS) {
    presets.push({ label: `${p.label} · v${p.version}`, file: await still(page, `preset-${p.id}`, { preset: p.id }, WALK) })
    presetsClose.push({ label: `${p.label} · close`, file: await still(page, `preset-${p.id}-close`, { preset: p.id }, MOVES[0]!) })
  }
  const heroes: { label: string; file: string }[] = []
  const heroMoves: Record<string, { label: string; file: string }[]> = {}
  for (const [style, s] of HERO_STYLES.entries()) {
    heroes.push({ label: s.label, file: await still(page, `hero-${s.id}`, { preset: "today", heroStyle: style }, WALK) })
    for (const move of MOVES) {
      ;(heroMoves[s.id] ??= []).push({ label: `${s.label} · ${move.name}`, file: await still(page, `hero-${s.id}-${move.name}`, { preset: "today", heroStyle: style }, move) })
    }
  }
  const sheetPage = await browser.newPage({ deviceScaleFactor: 1 })
  await sheet(sheetPage, resolve(out, "sheet-presets.png"), "Outbreak look presets · start house, 17:30", presets, 3)
  await sheet(sheetPage, resolve(out, "sheet-heroes.png"), "Survivor styles · start house, 17:30", heroes, 2)
  for (const [i, s] of HERO_STYLES.entries()) {
    if (i === 0) continue
    // Each style beside today, same frame: walk, close walk, run and strafe.
    const tiles = [heroes[0]!, heroes[i]!, ...heroMoves.today!.flatMap((t, k) => [t, heroMoves[s.id]![k]!])]
    await sheet(sheetPage, resolve(out, `sheet-hero-${s.id}.png`), `${s.label} beside today`, tiles, 2)
  }
  for (const [i, p] of OUTBREAK_LOOK_PRESETS.entries()) {
    if (i === 0) continue
    await sheet(sheetPage, resolve(out, `sheet-preset-${p.id}.png`), `${p.label} beside today`, [presets[0]!, presets[i]!, presetsClose[0]!, presetsClose[i]!], 2)
  }
  meta.errors = errors
  writeFileSync(resolve(out, "meta.json"), JSON.stringify(meta, null, 2))
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
  fixture.stop(true)
}
