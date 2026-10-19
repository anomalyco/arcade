// Headless Metal walkthrough of crafting as a new player meets it: the opening frame, picking up a material, Q with
// nothing learned, the workbench mat and corkboard, a failed and a good try, field craft, a craft and its notice, and a
// short cost. `--phase variants` stages the same moments under each Lab crafting style (Crafting › Style).
// Run from games/outbreak: bun scripts/crafting-proof.ts [--phase audit|variants] (fleet: hivemind run --kind browser).
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium, type Page } from "playwright-core"
import { createServer } from "vite"

const root = resolve(import.meta.dir, "..")
const phase = process.argv.includes("--phase") ? process.argv[process.argv.indexOf("--phase") + 1]! : "audit"
const out = resolve(process.env.LEASE_OUT ?? resolve(root, "../../captures/outbreak-crafting"), phase)
mkdirSync(out, { recursive: true })

const server = await createServer({ root, logLevel: "warn", server: { host: "127.0.0.1", port: 0 } })
await server.listen()
const port = (server.httpServer!.address() as { port: number }).port
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
assert(chrome, "Playwright Chromium binary not found")
const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})

const shots: { name: string; caption: string; text?: string }[] = []

async function stage(page: Page, s: { x: number; y: number; aim: number; zoom?: number; hour?: number }) {
  await page.evaluate(async (s) => {
    const h = (window as any).__arcadeHarness
    h.setLab("hour", s.hour ?? 15)
    if (s.zoom) h.setLab("zoom", s.zoom)
    h.pose(s.x, s.y, s.aim)
    for (let i = 0; i < 4; i++) await h.step()
  }, s)
}

async function fresh(page: Page) {
  await page.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    h.freeze(true)
    h.reset(7)
    h.setLab("timeScale", 0)
    h.setLab("zombieCount", 0)
    h.inventoryHud().resetFamiliar()
    h.resetCraftTips()
    h.setLab("craftTipTime", 12)
    for (let i = 0; i < 4; i++) await h.step()
  })
}

async function step(page: Page, n = 1, command: Record<string, unknown> = {}) {
  await page.evaluate(
    async ({ n, command }) => {
      const h = (window as any).__arcadeHarness
      for (let i = 0; i < n; i++) await h.step(1 / 60, { aim: h.session().view.player.aim, ...command })
    },
    { n, command },
  )
}

/** Runs `fn(progression, ledger, view, hud)` in the page. */
async function sim(page: Page, fn: string) {
  return page.evaluate((fn) => {
    const h = (window as any).__arcadeHarness
    const view = h.session().view
    return new Function("progression", "ledger", "view", "hud", "h", fn)(view.progression, view.progression.ledger, view, h.inventoryHud(), h)
  }, fn)
}

/** Every piece of text a player can read right now: the prompt, field craft, callouts and any tip. */
async function readable(page: Page): Promise<string> {
  return page.evaluate(() => {
    const t = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)].filter((e) => !e.hidden && e.offsetParent !== null).map((e) => e.innerText.replace(/\s+/g, " ").trim()).filter(Boolean)
    return JSON.stringify({ prompt: t("#prompt"), craft: t("#craft"), callouts: t(".callout"), tip: t("#craft-tip") })
  })
}

async function snap(page: Page, name: string, caption: string, crop?: string) {
  await page.screenshot({ path: resolve(out, `${name}.png`) })
  if (crop) {
    const rect = await page.evaluate((crop) => {
      const els = crop.split(",").map((s) => document.querySelector<HTMLElement>(s.trim())).filter((e): e is HTMLElement => Boolean(e && !e.hidden))
      if (!els.length) return null
      const rs = els.map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0)
      if (!rs.length) return null
      const x = Math.min(...rs.map((r) => r.left))
      const y = Math.min(...rs.map((r) => r.top))
      return { x, y, width: Math.max(...rs.map((r) => r.right)) - x, height: Math.max(...rs.map((r) => r.bottom)) - y }
    }, crop)
    const vw = page.viewportSize()!
    if (rect) {
      const pad = 24
      const x = Math.max(0, rect.x - pad)
      const y = Math.max(0, rect.y - pad)
      await page.screenshot({ path: resolve(out, `${name}-crop.png`), clip: { x, y, width: Math.min(vw.width - x, rect.width + pad * 2), height: Math.min(vw.height - y, rect.height + pad * 2) } })
    }
  }
  const text = await readable(page)
  shots.push({ name, caption, text })
  console.log(`${name}: ${caption}\n  ${text}`)
}

async function setStyle(page: Page, style: number) {
  await page.evaluate((style) => (window as any).__arcadeHarness.setLab("craftStyle", style), style)
}

/** Walks a fresh survivor through finding chem, the bench, a try, field craft and a craft. Returns nothing; snaps. */
async function walkthrough(page: Page, tag: string) {
  await fresh(page)
  await snap(page, `${tag}01-opening`, "The first frame of a run: what tells you crafting exists?")

  // A dresser with chem and scrap in it.
  const dresser = await sim(page, `const c = view.containers.find((x) => x.kind === "dresser" && x.buildingId === "ash"); return { id: c.id, x: c.x, y: c.y }`)
  await sim(page, `const st = ledger.store(${JSON.stringify(dresser.id)}); st.slots.fill(null); st.slots[0] = { item: "chem", count: 2 }; st.slots[1] = { item: "scrap", count: 2 }; st.revealed = false; st.rev = ++ledger.rev`)
  await stage(page, { x: dresser.x, y: dresser.y + 0.75, aim: -Math.PI / 2 })
  await step(page, 1, { interact: true })
  await step(page, 80)
  await step(page, 1, { interact: true })
  await step(page, 6)
  await snap(page, `${tag}02-picked-up`, "Took chem and scrap from a dresser: is there any sign they make something?", "#prompt, .callouts, #dock, #craft-tip")

  // Hold Q with nothing learned.
  await sim(page, `if (!hud.craftOpen) hud.toggleCraft()`)
  await step(page, 20)
  await snap(page, `${tag}03-q-nothing-learned`, "Hold Q before learning anything", "#craft, #dock")
  await sim(page, `hud.close()`)
  await step(page, 20)

  // The Ash workbench by day.
  const bench = await sim(page, `const b = progression.benches.find((b) => b.id === "bench:ash"); return { id: b.id, x: b.bench.x, y: b.bench.y }`)
  await stage(page, { x: bench.x - 0.85, y: bench.y, aim: 0 })
  await sim(page, `ledger.apply({ kind: "grant", actor: view.actorId, item: "plank", count: 1 })`)
  await step(page, 30)
  await snap(page, `${tag}04-bench`, "Walk up to the workbench: E lays out, nothing says what it is for", "#prompt, #craft-tip")
  await step(page, 1, { interact: true })
  await step(page, 30)
  const first = await sim(page, `return progression.tinkering.mat(${JSON.stringify(bench.id)}).map((s) => s.item).join("+")`)
  await snap(page, `${tag}05-laid-out`, `Tap E: the mat takes a pair (${first})`, "#prompt, #craft-tip")
  // A try that clatters.
  await step(page, 1, { interact: true, interactHeld: true })
  await step(page, 200, { interactHeld: true })
  await step(page, 20)
  await snap(page, `${tag}06-clatter`, `Hold E on ${first}: it clatters; a crossed-out scrap goes up`, "#prompt, .callouts, #craft-tip")
  // Cycle to chem+chem and assemble.
  for (let i = 0; i < 12 && (await sim(page, `return progression.tinkering.mat(${JSON.stringify(bench.id)}).map((s) => s.item).join("+")`)) !== "chem+chem"; i++) await step(page, 1, { interact: true })
  await step(page, 1, { interact: true, interactHeld: true })
  await step(page, 200, { interactHeld: true })
  await step(page, 30)
  assert.equal(await sim(page, `return progression.learned("bandage")`), true, "chem+chem teaches the bandage")
  await snap(page, `${tag}07-assembled`, "chem+chem assembled a bandage on the mat and pinned a sketch", "#prompt, .callouts, #craft-tip")
  await step(page, 1, { interact: true })
  await step(page, 30)
  await snap(page, `${tag}08-took-bandage`, "Tap E takes the bandage: is there a sign it can now be made anywhere?", "#prompt, .callouts, #dock, #craft-tip")

  // Field craft in the street with a chem in hand.
  await stage(page, { x: 44, y: 44, aim: 0, hour: 16 })
  await sim(page, `ledger.apply({ kind: "grant", actor: view.actorId, item: "chem", count: 1 })`)
  await step(page, 20)
  await snap(page, `${tag}09a-ready`, "Picked up a chem with the bandage learned: does anything say it can be made?", "#craft-tip, #dock")
  await sim(page, `if (!hud.craftOpen) hud.toggleCraft()`)
  await step(page, 20)
  await snap(page, `${tag}09-field-craft`, "Hold Q: the field-craft strip with the bandage learned", "#craft, #dock")
  await sim(page, `ledger.apply({ kind: "grant", actor: view.actorId, item: "learned:lure", store: "team/known" }); ledger.apply({ kind: "grant", actor: view.actorId, item: "learned:spiked-board", store: "team/known" })`)
  await step(page, 10)
  await snap(page, `${tag}10-field-craft-three`, "Three learned recipes, one affordable", "#craft, #dock")
  await sim(page, `hud.digit(0, view)`)
  await step(page, 1, { pick: { mode: "craft", index: 0 } })
  await step(page, 50)
  await snap(page, `${tag}11-crafting`, "Digit 1: crafting (2 s, sprinting cancels)", "#craft, .callouts, #dock")
  await step(page, 90)
  await snap(page, `${tag}12-crafted`, "Crafted: where did it go?", "#craft, .callouts, #dock")
  await sim(page, `if (!hud.craftOpen) hud.toggleCraft()`)
  await step(page, 20)
  await snap(page, `${tag}13-short`, "Hold Q with nothing to spend: rows dimmed, which material is missing?", "#craft, #dock")
  await step(page, 1, { pick: { mode: "craft", index: 0 } })
  await step(page, 10)
  await snap(page, `${tag}14-short-press`, "Press 1 anyway", "#craft, .callouts, #dock")
  await sim(page, `hud.close()`)
}

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
  page.setDefaultTimeout(180_000)
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text())
  })
  await page.goto(`http://127.0.0.1:${port}/?seed=7&bench`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 120_000 })
  const adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
  assert.match(adapter.architecture, /metal/)

  if (phase === "audit") await walkthrough(page, "")
  else {
    for (const [style, name] of [[0, "today"], [1, "panel"], [2, "tips"], [3, "both"]] as const) {
      await setStyle(page, style)
      await walkthrough(page, `${name}-`)
    }
  }

  assert.deepEqual(errors, [])
  writeFileSync(resolve(out, "index.json"), JSON.stringify({ adapter, shots }, null, 2))
  console.log(`crafting proof (${phase}): ${shots.length} stills in ${out}`)
} finally {
  await browser.close()
  await server.close()
}
