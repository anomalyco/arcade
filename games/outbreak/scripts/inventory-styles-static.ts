// DOM-only preview of the three inventory layouts (AR-94) from a fixed model, for tuning CSS without the game: writes
// captures/outbreak-inventory/static/{ground,case,sheet}.png. No WebGPU, no game; the floor is a flat dark gradient.
// Run from games/outbreak: bun scripts/inventory-styles-static.ts
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright-core"
import { quadMatrix } from "../src/inventory/bag"
import type { InvCell, InvModel } from "../src/inventory/model"
import { caseHtml, groundHtml, sheetHtml, type RenderState } from "../src/inventory/render"

const root = resolve(import.meta.dir, "..")
const out = resolve(root, "../../captures/outbreak-inventory/static")
mkdirSync(out, { recursive: true })

const cell = (at: InvCell["ref"]["at"], slot: number, item: string | null, count = 1, extra: Partial<InvCell> = {}): InvCell => ({
  ref: { at, slot },
  stack: item ? { item, count } : null,
  label: item ? (count > 1 ? `${item} ×${count}` : item) : "",
  ...extra,
})
const model: InvModel = {
  hands: [
    cell("hotbar", 0, "flashlight", 1, { charge: { value: 72, max: 100, kind: "battery" } }),
    cell("hotbar", 1, "pistol", 1, { charge: { value: 6, max: 8, kind: "rounds" }, selected: true }),
    cell("hotbar", 2, null),
    cell("hotbar", 3, "medkit", 2),
    cell("hotbar", 4, "noisemaker"),
  ],
  pack: [cell("pack", 0, "knife", 1, { charge: { value: 10, max: 14, kind: "wear" } }), cell("pack", 1, "toolbox"), cell("pack", 2, null), cell("pack", 3, null)],
  belt: [cell("belt", 0, "ammo", 14), cell("belt", 1, "plank", 3), cell("belt", 2, "scrap", 4), cell("belt", 4, "battery", 1)],
  target: {
    kind: "container",
    title: "Search",
    cells: [cell("target", 0, "machete", 1, { charge: { value: 24, max: 24, kind: "wear" } }), cell("target", 1, "plank", 2), cell("target", 2, "bandage", 2), cell("target", 3, "ammo", 8)],
  },
  mates: [{ index: 1, name: "Sam", colour: "#6fb4e8", distance: 1.3, dx: 1.3, dy: -0.2 }],
  key: "",
}
const st: RenderState = { fresh: new Set(["pack:1"]), pending: new Set(), cell: 40 }

const tokens = readFileSync(resolve(root, "src/hud/tokens.css"), "utf8")
const css = readFileSync(resolve(root, "src/inventory/inventory.css"), "utf8")
const keyCss = await (async () => {
  const mod = await import("@arcade/kit/client/key-cap")
  return (mod as unknown as { KEY_CAP_CSS?: string }).KEY_CAP_CSS ?? ""
})()

const floor = `background: radial-gradient(ellipse at 45% 55%, #2a2620, #12100d 60%, #070605)`
const mat = quadMatrix(820, 470, [
  { x: 300, y: 330 },
  { x: 980, y: 330 },
  { x: 1010, y: 720 },
  { x: 270, y: 720 },
])

function page(style: string, inner: string, stageStyle = ""): string {
  return `<!doctype html><html><head><style>${tokens}${keyCss}${css} html,body{margin:0;height:100%;${floor}}</style></head>
  <body><div id="inv" data-style="${style}"><div class="inv-floor" data-ref="ground:0"></div><div class="inv-stage" style="${stageStyle}">${inner}</div>
  <div class="inv-caption" data-on="true">Machete · 100%</div></div></body></html>`
}

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
assert(chrome)
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--mute-audio"] })
try {
  const p = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  for (const [style, html, stage] of [
    ["ground", groundHtml(model, st), `transform:${mat}`],
    ["case", caseHtml(model, st), ""],
    ["sheet", sheetHtml(model, st), ""],
  ] as const) {
    await p.setContent(page(style, html, stage))
    await p.waitForTimeout(100)
    await p.screenshot({ path: resolve(out, `${style}.png`) })
  }
  console.log(`static previews in ${out}`)
} finally {
  await browser.close()
}
