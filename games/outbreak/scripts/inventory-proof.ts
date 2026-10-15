// Headless Metal proof for the inventory and safehouse HUD: belt, hotbar, pack, container strips, ground drops,
// pings, noisemakers, keyed doors and (with a bench in the town) the workbench panel. Deterministic stills from
// scripted inputs. Run from games/outbreak: bun scripts/inventory-proof.ts (fleet: hivemind run --kind browser).
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium, type Page } from "playwright-core"
import { createServer } from "vite"

const root = resolve(import.meta.dir, "..")
const out = resolve(process.env.INVENTORY_OUT ?? process.env.LEASE_OUT ?? resolve(root, "../../captures/outbreak-inventory"))
mkdirSync(out, { recursive: true })

const server = await createServer({
  root,
  logLevel: "warn",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "inventory-proof-hooks",
      enforce: "pre",
      transform(code, id) {
        if (id !== resolve(root, "src/main.ts")) return
        return code.replace("const harness = {", "const harness = { inventoryHud, session: () => session,")
      },
    },
  ],
})
await server.listen()
const port = (server.httpServer!.address() as { port: number }).port
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`)
  .find(existsSync)
assert(chrome, "Playwright Chromium binary not found")
const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})

const shots: { name: string; caption: string }[] = []

async function stage(page: Page, s: { x: number; y: number; aim: number; zoom?: number; hour?: number }) {
  await page.evaluate(async (s) => {
    const h = (window as any).__arcadeHarness
    h.freeze(true)
    h.reset(7)
    h.setLab("timeScale", 0)
    h.setLab("hour", s.hour ?? 17)
    h.setLab("zoom", s.zoom ?? 30)
    h.setLab("zombieCount", 0)
    h.pose(s.x, s.y, s.aim)
    for (let i = 0; i < 4; i++) await h.step()
  }, s)
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

/** Runs `fn(progression, ledger, view)` in the page. */
async function sim(page: Page, fn: string) {
  return page.evaluate((fn) => {
    const h = (window as any).__arcadeHarness
    const view = h.session().view
    return new Function("progression", "ledger", "view", "hud", fn)(view.progression, view.progression.ledger, view, h.inventoryHud)
  }, fn)
}

async function snap(page: Page, name: string, caption: string, crop: "prompt" | "hud" | "player" | "both" = "both") {
  await page.screenshot({ path: resolve(out, `${name}.png`) })
  const rect = await page.evaluate((crop) => {
    const pick = (sel: string) => document.querySelector(sel)?.getBoundingClientRect()
    if (crop === "hud") return pick("#hud")
    if (crop === "prompt") return pick("#prompt")
    const h = (window as any).__arcadeHarness
    return h.resolveTargetRect({ objectId: "player" })
  }, crop)
  const vw = page.viewportSize()!
  if (rect && rect.width > 0) {
    const pad = crop === "hud" ? 12 : 150
    const clip = {
      x: Math.max(0, rect.x - pad),
      y: Math.max(0, rect.y - pad - (crop === "prompt" ? 40 : 0)),
      width: Math.min(vw.width, rect.width + pad * 2),
      height: Math.min(vw.height, rect.height + pad * 2 + (crop === "prompt" ? 120 : 0)),
    }
    clip.width = Math.min(clip.width, vw.width - clip.x)
    clip.height = Math.min(clip.height, vw.height - clip.y)
    await page.screenshot({ path: resolve(out, `${name}-crop.png`), clip })
  }
  shots.push({ name, caption })
}

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text())
  })
  await page.goto(`http://127.0.0.1:${port}/?seed=7&bench`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 120_000 })
  const adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
  assert.match(adapter.architecture, /metal/)

  // A bedroom dresser: unsearched prompt with both speeds, the search, then the strip of what is inside.
  const dresser = await sim(page, `const c = view.containers.find((x) => x.kind === "dresser" && x.buildingId === "ash"); return { id: c.id, x: c.x, y: c.y }`)
  await stage(page, { x: dresser.x, y: dresser.y + 0.75, aim: -Math.PI / 2 })
  await sim(page, `const st = ledger.store(${JSON.stringify(dresser.id)}); st.slots.fill(null); st.slots[0] = { item: "ammo", count: 6 }; st.slots[1] = { item: "medkit", count: 1 }; st.slots[2] = { item: "scrap", count: 2 }; st.revealed = false; st.rev = ++ledger.rev`)
  await step(page, 2)
  await snap(page, "search-prompt", "Unsearched dresser: E searches quietly, Shift+E smashes it open", "prompt")
  await step(page, 1, { interact: true })
  await step(page, 40)
  await snap(page, "searching", "Quiet search in progress (1.2 s, 3.5 m of noise)", "player")
  await step(page, 40)
  await snap(page, "strip", "Searched: the strip shows what is inside and where each item goes", "prompt")
  const strip = await page.evaluate(() => document.querySelector("#prompt")?.textContent ?? "")
  assert.match(strip, /9mm ×6/)
  assert.match(strip, /First Aid Kit|MED/)
  await step(page, 1, { pick: { mode: "take", index: 1 } })
  await step(page, 4)
  await snap(page, "took-one", "Digit 2 took the first aid kit into hand slot 4; the rest stays for the squad", "prompt")

  // Full kit: belt, hotbar and an open pack with a heavy part.
  await sim(page, `for (const [item, n] of [["crowbar",1],["noisemaker",2],["toolbox",1],["car-battery",1],["chem",3],["key",1],["battery",1]]) ledger.apply({ kind: "grant", actor: view.actorId, item, count: n }); hud.togglePack()`)
  await step(page, 2)
  await snap(page, "hud", "Belt, five hand slots and the Tab pack (the car battery takes two slots)", "hud")
  await sim(page, `hud.close()`)

  // Hand-offs: a dropped medkit, a supply bundle, a ping, and a thrown noisemaker.
  await stage(page, { x: 44, y: 44, aim: 0, zoom: 34 })
  await sim(page, `for (const [item, n] of [["medkit",1],["noisemaker",1],["ammo",12]]) ledger.apply({ kind: "grant", actor: view.actorId, item, count: n })`)
  await step(page, 1, { hotbarSlot: 3 })
  await step(page, 1, { drop: true })
  await step(page, 1, { aim: Math.PI / 2, bundle: true })
  await step(page, 1, { aim: -0.6, ping: true })
  await step(page, 1, { hotbarSlot: 4 })
  await step(page, 1, { aim: 0.4, fire: true })
  await step(page, 20)
  await snap(page, "handoff", "G drops the medkit, hold G leaves 6 ammo and 2 planks, Q pings, a noisemaker calls the dead", "player")
  const markers = await page.evaluate(() => [...document.querySelectorAll("#markers .marker:not([hidden])")].map((m) => m.textContent))
  assert(markers.length >= 3, `expected drop, ping and lure markers, got ${markers}`)

  // A keyed store back room with a crowbar in the pack.
  const door = await sim(page, `const d = view.town.doors.find((x) => x.id === "hardware-room"); return { x: (d.rect[0] + d.rect[2]) / 2, y: d.rect[3] }`)
  await stage(page, { x: door.x + 0.7, y: door.y + 0.6, aim: -Math.PI / 2 })
  await sim(page, `ledger.apply({ kind: "grant", actor: view.actorId, item: "crowbar" })`)
  await step(page, 2)
  await snap(page, "keyed-door", "The hardware back room is locked: a crowbar pries it open (loud)", "prompt")

  // The bench, when the town has one.
  const bench = await sim(page, `const b = progression.benches[0]; return b ? { id: b.id, x: b.bench.x, y: b.bench.y } : null`)
  if (bench) {
    await stage(page, { x: bench.x - 0.85, y: bench.y, aim: 0, hour: 15 })
    await sim(page, `for (const [item, n] of [["scrap",6],["chem",3],["plank",3],["battery",1],["toolbox",1]]) ledger.apply({ kind: "grant", actor: view.actorId, item, count: n })`)
    await step(page, 1, { interact: true })
    await step(page, 4)
    await snap(page, "bench", "The workbench: deposit, the tier, and the recipes the squad's materials have revealed", "prompt")
  }

  assert.deepEqual(errors, [])
  writeFileSync(resolve(out, "index.json"), JSON.stringify({ adapter, shots }, null, 2))
  console.log(`inventory proof: ${shots.length} stills in ${out}`)
} finally {
  await browser.close()
  await server.close()
}
