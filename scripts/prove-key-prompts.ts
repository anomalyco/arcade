// Headless Metal proof for QWERTY prompt labels and the shared key-cap component. Captures real prompts in Outbreak,
// Blackout, Getaway and the Lab on QWERTY, on a simulated Dvorak layout (labels must match QWERTY) and on Dvorak with
// the opt-in "My keyboard layout" setting (labels must change, which shows the simulation is live). Also captures hold
// prompts mid-progress and builds one contact sheet. Muted browser, no visible window.
//   bun scripts/prove-key-prompts.ts [--out dir]
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { type Browser, type Page } from "playwright-core"
import { browserBudget } from "./browser-budget"
import { createServer, type ViteDevServer } from "vite"
import { KEY_CAP_CSS, keyCapHtml, keyPromptHtml } from "../packages/kit/client/key-cap"

await using budget = browserBudget()
const { chromium } = budget

const repo = resolve(import.meta.dir, "..")
const arg = (name: string) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const out = resolve(arg("--out") ?? resolve(repo, "captures/key-prompts"))
mkdirSync(out, { recursive: true })

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
assert(executablePath, "Playwright Chromium binary not found")

type Variant = "qwerty" | "dvorak" | "dvorak-layout"
const VARIANTS: Variant[] = ["qwerty", "dvorak", "dvorak-layout"]
const VARIANT_LABEL: Record<Variant, string> = {
  qwerty: "QWERTY",
  dvorak: "Dvorak (default labels)",
  "dvorak-layout": "Dvorak + My keyboard layout",
}
const DVORAK: Record<string, string> = {
  KeyQ: "'", KeyW: ",", KeyE: ".", KeyR: "p", KeyT: "y", KeyY: "f", KeyU: "g", KeyI: "c", KeyO: "r", KeyP: "l",
  KeyA: "a", KeyS: "o", KeyD: "e", KeyF: "u", KeyG: "i", KeyH: "d", KeyJ: "h", KeyK: "t", KeyL: "n",
  KeyZ: ";", KeyX: "q", KeyC: "j", KeyV: "k", KeyB: "x", KeyN: "b", KeyM: "m",
  Semicolon: "s", Quote: "-", Comma: "w", Period: "v", Slash: "z", BracketLeft: "/", BracketRight: "=",
}

const servers: ViteDevServer[] = []
async function serve(root: string, base = "/"): Promise<string> {
  const server = await createServer({
    root,
    configFile: existsSync(resolve(root, "vite.config.ts")) ? resolve(root, "vite.config.ts") : false,
    base,
    logLevel: "warn",
    server: { host: "127.0.0.1", port: 0 },
  })
  await server.listen()
  servers.push(server)
  const address = server.httpServer!.address()
  if (!address || typeof address === "string") throw new Error("no port")
  return `http://127.0.0.1:${address.port}${base}`
}

const errors: string[] = []
const report: Record<string, Record<string, unknown>> = {}
type Shot = { row: string; variant: Variant; file: string; text: string }
const shots: Shot[] = []

async function openPage(browser: Browser, url: string, variant: Variant, viewport = { width: 1280, height: 800 }): Promise<Page> {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 })
  page.on("pageerror", (e) => errors.push(`${variant} ${url}: ${e.message}`))
  await page.addInitScript(
    ({ variant, dvorak }) => {
      localStorage.setItem("arcade.keyLabels", variant === "dvorak-layout" ? "layout" : "qwerty")
      if (variant === "qwerty") return
      const map = new Map(Object.entries(dvorak))
      Object.defineProperty(Navigator.prototype, "keyboard", {
        configurable: true,
        get: () => ({ getLayoutMap: async () => map, addEventListener() {}, lock: async () => {}, unlock() {} }),
      })
    },
    { variant, dvorak: DVORAK },
  )
  await page.goto(url)
  return page
}

/** Physical key event with the layout's character: code stays KeyE, key is "." on Dvorak. */
async function physicalKey(page: Page, type: "keyDown" | "keyUp", code: string, variant: Variant) {
  const cdp = await page.context().newCDPSession(page)
  const key = variant === "qwerty" ? code.slice(3).toLowerCase() : DVORAK[code]!
  await cdp.send("Input.dispatchKeyEvent", { type, code, key, text: type === "keyDown" ? key : undefined })
  await cdp.detach()
}

async function crop(page: Page, selector: string, row: string, variant: Variant, pad = 28): Promise<Shot> {
  const el = page.locator(selector).first()
  await el.waitFor({ state: "visible", timeout: 30_000 })
  // Content bounds, so a full-width strip like Getaway's key line crops to its text and caps.
  const box = await el.evaluate((n) => {
    const range = document.createRange()
    range.selectNodeContents(n)
    const r = range.getBoundingClientRect()
    const e = n.getBoundingClientRect()
    return r.width > 0 && r.width < e.width ? { x: r.x, y: Math.min(r.y, e.y), width: r.width, height: Math.max(r.height, e.height) } : { x: e.x, y: e.y, width: e.width, height: e.height }
  })
  const vw = page.viewportSize()!
  const x = Math.max(0, box.x - pad)
  const y = Math.max(0, box.y - pad)
  const clip = { x, y, width: Math.min(vw.width - x, box.width + pad * 2), height: Math.min(vw.height - y, box.height + pad * 2) }
  const file = resolve(out, `${row}-${variant}.png`)
  await page.screenshot({ path: file, clip })
  const text = (await el.evaluate((n) => {
    const caps = [...n.querySelectorAll("kbd.akc")].map((k) => k.getAttribute("aria-label"))
    return `${(n as HTMLElement).innerText.replace(/\s+/g, " ").trim()}${caps.length ? ` [caps: ${caps.join(", ")}]` : ""}`
  })) as string
  const shot = { row, variant, file, text }
  shots.push(shot)
  return shot
}

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})

async function outbreak(base: string, variant: Variant) {
  const page = await openPage(browser, `${base}?seed=7&bench`, variant)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 120_000 })
  const stage = (look: string) =>
    page.evaluate(async (look) => {
      const h = (window as any).__arcadeHarness
      h.freeze(true)
      h.reset(7)
      h.setLab("timeScale", 0)
      h.setLab("hour", 19)
      h.setLab("zoom", 30)
      h.setLab("zombieCount", 0)
      h.setLookPreset(look)
      h.pose(27.7, 36.2, -Math.PI / 2)
      for (let i = 0; i < 6; i++) await h.step()
    }, look)
  const step = (n: number, command: Record<string, unknown> = {}) =>
    page.evaluate(
      async ({ n, command }) => {
        const h = (window as any).__arcadeHarness
        for (let i = 0; i < n; i++) await h.step(1 / 60, { aim: h.state().player.aim, ...command })
      },
      { n, command },
    )
  await stage("current")
  await crop(page, "#prompt", "outbreak-door", variant, 40)
  // Hold E for 12 of the 23 frames HOLD_DURATION needs: the ring is about half full.
  await step(1, { interact: true, interactHeld: true })
  await step(11, { interactHeld: true })
  const hold = await page.evaluate(() => (document.querySelector("#prompt .akc-hold") as HTMLElement | null)?.style.getPropertyValue("--akc-p"))
  await crop(page, "#prompt", "outbreak-hold", variant, 40)
  await stage("noir")
  await step(1, { interact: true, interactHeld: true })
  await step(15, { interactHeld: true })
  await crop(page, "#prompt", "outbreak-hold-noir", variant, 40)
  // Out of ammo with reserve left: the callout names the reload key.
  await stage("current")
  await page.evaluate(() => Object.assign((window as any).__arcadeHarness.state().player, { magAmmo: 0, reserveAmmo: 12 }))
  await page.evaluate(() => (window as any).__arcadeHarness.pose(30, 41, -Math.PI / 2))
  await step(2)
  await step(1, { fire: true })
  await step(6)
  const callouts = await page.evaluate(() => (window as any).__arcadeHarness.callouts())
  const empty = JSON.stringify(callouts).match(/Empty[^"]*/)?.[0] ?? ""
  report[`outbreak-${variant}`] = { hold, empty }
  await page.close()
}

async function blackout(base: string, variant: Variant) {
  const page = await openPage(browser, `${base}?peaceful=1&mode=snd&seed=3`, variant)
  await page.waitForFunction(() => Boolean((globalThis as any).practice), null, { timeout: 120_000 })
  await page.waitForTimeout(1500)
  // Hand the local player the bomb and stand them in site A.
  const site = await page.evaluate(() => {
    const w = (globalThis as any).practice
    const me = w.players.get("you")
    const sites = w.mode.view(w, "you").sites
    w.mode.bomb.state = "carried"
    w.mode.bomb.carrier = "you"
    me.x = sites[0].x
    me.y = sites[0].y
    return sites[0]
  })
  await page.waitForTimeout(600)
  await crop(page, "#mhint", "blackout-plant", variant, 30)
  await physicalKey(page, "keyDown", "KeyE", variant)
  await page.waitForTimeout(1350)
  const progress = await page.evaluate(() => (globalThis as any).practice.mode.bomb.progress)
  await crop(page, "#mhint", "blackout-plant-hold", variant, 30)
  await physicalKey(page, "keyUp", "KeyE", variant)
  await crop(page, "#equip", "blackout-equip", variant, 16)
  const help = await page.locator("#help").innerText()
  report[`blackout-${variant}`] = { site, progress, help }
  await page.close()
}

async function getaway(base: string, variant: Variant) {
  const page = await openPage(browser, `${base}?solo&seed=7`, variant)
  await page.waitForFunction(() => Boolean((window as any).__view), null, { timeout: 120_000 })
  await page.locator(".h-keys:not(.off)").first().waitFor({ state: "visible", timeout: 30_000 })
  await page.waitForTimeout(1400)
  await crop(page, ".h-keys:not(.off)", "getaway-keys", variant, 16)
  await page.close()
}

async function lab(base: string, variant: Variant) {
  const page = await openPage(browser, `${base}?bench&game=getaway`, variant)
  await page.waitForFunction(() => Boolean((window as any).lab), null, { timeout: 120_000 })
  await page.waitForTimeout(800)
  await page.getByRole("searchbox", { name: "Search details" }).fill("key labels")
  await crop(page, '[data-row="keyLabels"]', "lab-key-labels-setting", variant, 10)
  await page.getByRole("searchbox", { name: "Search details" }).fill("")
  await page.locator("canvas").first().focus()
  await page.keyboard.press("p")
  await page.waitForFunction(() => /Move/.test(document.querySelector("[data-hint-text]")?.textContent ?? ""), null, { timeout: 30_000 })
  await crop(page, "[data-hint-text]", "lab-play-hint", variant, 12)
  await page.close()
}

/** The component itself on dark, Noir-grey and bright grounds, rendered from the shipped CSS and markup. */
async function gallery() {
  const grounds = [
    ["Night street", "radial-gradient(circle at 30% 40%, #2a3036, #07090b 70%)"],
    ["Noir", "repeating-linear-gradient(115deg, #1b1b1b 0 14px, #2c2c2c 14px 28px)"],
    ["Bright", "linear-gradient(135deg, #d9d2c0, #f5f1e6)"],
  ] as const
  const caps = [
    keyCapHtml("KeyE"),
    keyCapHtml("KeyR"),
    keyCapHtml("KeyF"),
    keyCapHtml("Backquote"),
    keyCapHtml("ShiftLeft"),
    keyCapHtml("Space"),
    keyCapHtml("Mouse0"),
    keyCapHtml("Mouse2"),
    keyCapHtml("KeyE", { hold: true }),
    keyCapHtml("KeyE", { hold: true, progress: 0.35 }),
    keyCapHtml("KeyE", { hold: true, progress: 0.7 }),
    keyCapHtml("KeyE", { hold: true, progress: 1 }),
  ].join("")
  const prompt = `${keyPromptHtml("KeyE", "Open")}<span style="opacity:.45">·</span>${keyPromptHtml("KeyE", "Lock", { hold: true, progress: 0.55 })}`
  const html = `<!doctype html><style>${KEY_CAP_CSS}
    body{margin:0;font:13px ui-sans-serif,system-ui;color:#ece9dc;background:#000}
    .g{display:flex;align-items:center;gap:14px;padding:18px 22px}
    .g h3{width:110px;margin:0;font-weight:500;font-size:12px;opacity:.85}
    .bright h3{color:#222}
    .p{display:inline-flex;align-items:center;gap:8px;padding:4px 10px 4px 5px;border:1px solid #ffffff29;border-radius:999px;background:#0f1515e6}
  </style>${grounds
    .map(([name, bg]) => `<div class="g ${name === "Bright" ? "bright" : ""}" style="background:${bg}"><h3>${name}</h3>${caps}<span class="p">${prompt}</span></div>`)
    .join("")}`
  const page = await browser.newPage({ viewport: { width: 1280, height: 120 }, deviceScaleFactor: 2 })
  await page.setContent(html)
  const file = resolve(out, "component-gallery.png")
  await page.screenshot({ path: file, fullPage: true })
  await page.emulateMedia({ reducedMotion: "reduce" })
  const reduced = await page.evaluate(() => getComputedStyle(document.querySelector(".akc-cap")!).transitionDuration)
  report.gallery = { file, reducedMotionTransition: reduced }
  await page.close()
  return file
}

function sheet(galleryFile: string) {
  const rows = [...new Set(shots.map((s) => s.row))]
  const img = (file: string) => `data:image/png;base64,${readFileSync(file).toString("base64")}`
  const cell = (s: Shot | undefined) =>
    s ? `<td><img src="${img(s.file)}"><div class="t">${s.text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</div></td>` : "<td>—</td>"
  return `<!doctype html><style>
    body{margin:0;padding:20px;background:#101214;color:#ddd;font:12px ui-sans-serif,system-ui}
    h1{font-size:16px;margin:0 0 4px} p{margin:0 0 14px;opacity:.7}
    table{border-collapse:collapse} td,th{border:1px solid #2a2e33;padding:8px;vertical-align:top;text-align:left}
    th{font-weight:600} td img{display:block;max-width:420px;max-height:150px;width:auto;height:auto}
    .t{margin-top:6px;max-width:420px;font:11px ui-monospace,monospace;opacity:.75;word-break:break-word}
    .gal{display:block;width:1280px;margin-top:16px}
  </style><h1>Key prompts: QWERTY labels on every layout</h1>
  <p>Bindings stay on physical KeyboardEvent.code. The first two columns must read the same; the third is the opt-in "My keyboard layout" setting on Dvorak.</p>
  <table><tr><th>Prompt</th>${VARIANTS.map((v) => `<th>${VARIANT_LABEL[v]}</th>`).join("")}</tr>
  ${rows.map((r) => `<tr><th>${r}</th>${VARIANTS.map((v) => cell(shots.find((s) => s.row === r && s.variant === v))).join("")}</tr>`).join("")}
  </table><img class="gal" src="${img(galleryFile)}">`
}

try {
  const outbreakBase = await serve(resolve(repo, "games/outbreak"))
  const blackoutBase = await serve(resolve(repo, "games/blackout"))
  const getawayBase = await serve(resolve(repo, "games/getaway"))
  const labBase = await serve(resolve(repo, "games/lab"), "/arcade/lab/")
  const runs: [string, (base: string, v: Variant) => Promise<void>, string][] = [
    ["outbreak", outbreak, outbreakBase],
    ["blackout", blackout, blackoutBase],
    ["getaway", getaway, getawayBase],
    ["lab", lab, labBase],
  ]
  const only = arg("--only")
  for (const [name, run, base] of runs) {
    if (only && !only.split(",").includes(name)) continue
    for (const variant of VARIANTS) {
      try {
        await run(base, variant)
      } catch (e) {
        errors.push(`${name} ${variant}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }
  const galleryFile = await gallery()
  const sheetHtml = resolve(out, "sheet.html")
  writeFileSync(sheetHtml, sheet(galleryFile))
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 })
  await page.goto(`file://${sheetHtml}`)
  await page.screenshot({ path: resolve(out, "sheet.png"), fullPage: true })
  await page.close()

  // QWERTY and default Dvorak must read the same; the opt-in must differ where a letter key is shown.
  const mismatches: string[] = []
  for (const row of new Set(shots.map((s) => s.row))) {
    const q = shots.find((s) => s.row === row && s.variant === "qwerty")?.text
    const d = shots.find((s) => s.row === row && s.variant === "dvorak")?.text
    if (q !== d) mismatches.push(`${row}: "${q}" != "${d}"`)
  }
  const optInChanged = shots.some((s) => s.variant === "dvorak-layout" && s.text !== shots.find((q) => q.row === s.row && q.variant === "qwerty")?.text)
  writeFileSync(resolve(out, "summary.json"), JSON.stringify({ shots: shots.map(({ file, ...s }) => ({ ...s, file: file.replace(`${out}/`, "") })), report, errors, mismatches, optInChanged }, null, 2))
  console.log(JSON.stringify({ report, mismatches, optInChanged, errors }, null, 2))
  assert.deepEqual(mismatches, [], "QWERTY and Dvorak labels differ")
  assert(optInChanged, "the opt-in layout setting never changed a label, so the Dvorak simulation was not live")
  assert.deepEqual(errors, [])
  console.log(`sheet: ${resolve(out, "sheet.png")}`)
} finally {
  await browser.close()
  for (const s of servers) await s.close()
}
