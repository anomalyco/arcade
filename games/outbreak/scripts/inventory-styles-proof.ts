// Headless Metal stills (and a muted frame sequence) of the inventory styles (AR-94) on one staged scene: night in Ash,
// a searched dresser in front of you, a teammate beside you. For each of Today, A Ground Pack, B Attaché Case and
// C Survivor Sheet: Tab opens it, the cursor rests on the machete, and the shot is taken. With --clip, the Ground Pack
// is played through with real pointer drags: open, take the machete into hand 3, hand ammo to the teammate, drop a
// bandage, walk away. Run from games/outbreak: bun scripts/inventory-styles-proof.ts [--clip] (fleet: hivemind run
// --kind browser --fetch captures/outbreak-inventory).
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium, type Page } from "playwright-core"
import { createServer } from "vite"

const root = resolve(import.meta.dir, "..")
const out = resolve(process.env.LEASE_OUT ?? resolve(root, "../../captures/outbreak-inventory"))
const clip = process.argv.includes("--clip")
const only = process.argv.includes("--style") ? process.argv[process.argv.indexOf("--style") + 1]! : null
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

async function step(page: Page, n = 1, command: Record<string, unknown> = {}) {
  await page.evaluate(
    async ({ n, command }) => {
      const h = (window as any).__arcadeHarness
      for (let i = 0; i < n; i++) await h.step(1 / 60, { aim: h.session().view.player.aim, ...command })
    },
    { n, command },
  )
}

async function sim(page: Page, fn: string) {
  return page.evaluate((fn) => {
    const h = (window as any).__arcadeHarness
    const session = h.session()
    const view = session.view
    return new Function("session", "progression", "ledger", "view", "h", fn)(session, view.progression, view.progression.ledger, view, h)
  }, fn)
}

let ready = false

/**
 * Night in Ash: the bedroom dresser searched and stocked, the survivor carrying a mixed kit, a teammate beside them.
 * The world is built once (a reset is the slow part on a busy worker); each style restocks the same scene.
 */
async function scene(page: Page, style: string) {
  await page.evaluate(
    async ({ style, first }) => {
      const h = (window as any).__arcadeHarness
      if (first) {
        h.freeze(true)
        h.reset(7)
        h.setLab("timeScale", 0)
        h.setLab("zombieCount", 0)
        h.setLab("hour", 21.5)
      }
      h.setLab("inventoryStyle", style)
      for (let i = 0; i < 4; i++) await h.step()
    },
    { style, first: !ready },
  )
  const dresser = await sim(
    page,
    `const c = view.containers.find((x) => x.kind === "dresser" && x.buildingId === "ash") ?? view.containers.find((x) => x.buildingId === "ash")
     const st = ledger.store(c.id); st.slots = [{ item: "machete", count: 1, charge: 24 }, { item: "plank", count: 2 }, { item: "bandage", count: 2 }, { item: "ammo", count: 8 }, null, null]; st.size = st.slots.length; st.revealed = true; st.rev = ++ledger.rev
     return { id: c.id, x: c.x, y: c.y }`,
  )
  await sim(
    page,
    `const a = view.actorId
     for (const id of [a + "/hotbar", a + "/pack"]) { const st = ledger.store(id); for (let i = 0; i < st.slots.length; i++) if (st.slots[i] && !["fists", "flashlight", "pistol"].includes(st.slots[i].item)) st.slots[i] = null; st.rev = ++ledger.rev }
     for (const item of ["ammo", "plank", "scrap", "battery"]) { const n = ledger.count(a + "/belt", item); if (n) ledger.apply({ kind: "drain", store: a + "/belt", item, count: n }) }
     for (const d of [...ledger.stores.keys()].filter((k) => k.startsWith("drop:"))) ledger.deleteStore(d)
     for (const [item, count] of [["knife", 1], ["medkit", 2], ["toolbox", 1], ["ammo", 14], ["plank", 3], ["scrap", 4], ["battery", 1], ["noisemaker", 1]]) ledger.apply({ kind: "grant", actor: a, item, count })
     session.sim.progression.project(session.slot)`,
  )
  await page.evaluate(async (d) => {
    const h = (window as any).__arcadeHarness
    h.pose(d.x, d.y + 0.8, -Math.PI / 2)
    for (let i = 0; i < 6; i++) await h.step()
  }, dresser)
  await sim(
    page,
    `const s = session.sim; const me = session.slot.survivor
     const mate = s.slots.find((x) => x.id === "mate-1") ?? s.addSurvivor("mate-1", 1)
     Object.assign(mate.survivor, { x: me.x + 1.3, y: me.y - 0.2, aim: Math.PI, flashlightOn: true }); s.rebuildSolids()
     const n = ledger.count("mate-1/belt", "ammo"); if (n) ledger.apply({ kind: "drain", store: "mate-1/belt", item: "ammo", count: n })
     me.flashlightOn = true`,
  )
  ready = true
  await step(page, 10)
}

async function centerOf(page: Page, selector: string): Promise<{ x: number; y: number } | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
  }, selector)
}

const shots: { name: string; caption: string; inspect: unknown }[] = []

async function still(page: Page, name: string, caption: string) {
  await page.screenshot({ path: resolve(out, `${name}.png`) })
  const inspect = await page.evaluate(() => (window as any).__arcadeHarness.state().inventory)
  shots.push({ name, caption, inspect })
  console.log(`${name}: ${caption}`)
}

const t0 = performance.now()
const log = (msg: string) => console.log(`[${((performance.now() - t0) / 1000).toFixed(1)}s] ${msg}`)

async function styleStill(page: Page, style: string, caption: string) {
  log(`${style}: staging`)
  await scene(page, style)
  log(`${style}: open`)
  await page.keyboard.press("Tab")
  await step(page, 50)
  const machete = await centerOf(page, `#inv .inv-cell[data-item="machete"]`)
  if (machete) {
    await page.mouse.move(machete.x, machete.y)
    await step(page, 6)
  }
  await still(page, style, caption)
  await page.mouse.move(5, 5)
  await page.keyboard.press("Escape")
  await step(page, 30)
}

async function drag(page: Page, from: string, to: string | { x: number; y: number }, frames: (n: number) => Promise<void>) {
  const a = await centerOf(page, from)
  const b = typeof to === "string" ? await centerOf(page, to) : to
  if (!a || !b) {
    await page.screenshot({ path: resolve(out, "clip-failed.png") })
    const inv = await page.evaluate(() => ({ inv: (window as any).__arcadeHarness.state().inventory, prompt: (window as any).__arcadeHarness.session().view.prompt?.kind }))
    throw new Error(`drag ${from} → ${JSON.stringify(to)}: ${JSON.stringify(inv)}`)
  }
  await page.mouse.move(a.x, a.y)
  await frames(4)
  await page.mouse.down()
  const n = 14
  for (let i = 1; i <= n; i++) {
    const t = i / n
    const e = t * t * (3 - 2 * t)
    await page.mouse.move(a.x + (b.x - a.x) * e, a.y + (b.y - a.y) * e - Math.sin(t * Math.PI) * 30)
    await frames(1)
  }
  await page.mouse.up()
  await frames(14)
}

async function groundClip(page: Page) {
  const dir = resolve(out, "clip-ground")
  mkdirSync(dir, { recursive: true })
  let frame = 0
  const frames = async (n: number) => {
    for (let i = 0; i < n; i++) {
      await step(page, 2)
      await page.screenshot({ path: resolve(dir, `f${String(frame++).padStart(4, "0")}.png`) })
    }
  }
  log("clip: staging")
  await scene(page, "ground")
  log("clip: recording")
  await frames(10)
  await page.keyboard.press("Tab")
  await frames(2)
  if (!(await page.evaluate(() => (window as any).__arcadeHarness.state().inventory.open))) await page.keyboard.press("Tab")
  await frames(26)
  await drag(page, `#inv .inv-cell[data-item="machete"]`, `#inv .inv-flap .inv-cell[data-ref="hotbar:2"]`, frames)
  await drag(page, `#inv .inv-strap .inv-cell[data-item="ammo"]`, `#inv .inv-mate`, frames)
  const bandage = await centerOf(page, `#inv .inv-cloth .inv-cell[data-item="bandage"]`)
  if (bandage) {
    await page.mouse.move(bandage.x, bandage.y)
    await frames(3)
    await page.mouse.down()
    await page.mouse.up()
    await frames(12)
  }
  const medkit = await centerOf(page, `#inv .inv-cell[data-item="medkit"]`)
  if (medkit) {
    await page.mouse.move(medkit.x, medkit.y)
    await frames(6)
    await page.keyboard.press("KeyG")
    await frames(14)
  }
  await page.mouse.move(5, 5)
  await frames(6)
  // Walking away picks the bag up again.
  for (let i = 0; i < 18; i++) {
    await step(page, 2, { my: 1 })
    await page.screenshot({ path: resolve(dir, `f${String(frame++).padStart(4, "0")}.png`) })
  }
  const after = await sim(page, `const a = view.actorId; return { mate: ledger.count("mate-1", "ammo"), machete: ledger.store(a + "/hotbar").slots[2]?.item ?? null, sent: h.state().inventory.sent }`)
  console.log(`clip: ${frame} frames, ${JSON.stringify(after)}`)
  writeFileSync(resolve(dir, "result.json"), JSON.stringify({ frames: frame, after }, null, 2))
}

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  page.setDefaultTimeout(180_000)
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text())
  })
  await page.goto(`http://127.0.0.1:${port}/?seed=7&bench`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 300_000 })
  log("harness ready")
  const adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)

  const styles: [string, string][] = [
    ["today", "1 Today: Tab grows the 4-slot pack out of the dock"],
    ["ground", "2 Ground Pack: kneel, the bag opens on the floor, the dresser's things on a cloth beside it"],
    ["case", "3 Attaché Case: quick slots on the lid, the pack on grid paper, the dresser as a crate"],
    ["sheet", "4 Survivor Sheet: you on the left, nearby (the dresser, the floor, Sam) on the right"],
  ]
  for (const [style, caption] of styles) if (!only || only === style) await styleStill(page, style, caption)
  if (clip) await groundClip(page)

  writeFileSync(resolve(out, "index.json"), JSON.stringify({ adapter, shots, errors }, null, 2))
  assert.deepEqual(errors, [])
  console.log(`inventory styles: ${shots.length} stills in ${out}`)
} finally {
  await browser.close()
  await server.close()
}
