// Headless Metal proof of the Attaché Case (AR-94, D-46) on a staged scene (night in Ash, a searched dresser holding a
// machete, rounds and a hiking pack, a crowbar in hand, a teammate beside you). Writes:
//   after.png            the case open: fitted thumbnails on the lid, art at its shape on the grid
//   transition.mp4       Tab open, close, then Tab spam, 60 frames a second of game time (and -slow.mp4 at 1/4 speed)
//   transition.json      the stage's opacity, rise, scale, the lid's swing and the dim, read from the DOM every frame,
//                        checked for jumps (motion.ts is traced in tests/inventory-motion.test.ts too)
//   clip.mp4             packing: the toolbox turned with R mid-drag, the knife turned where it lies, the hiking pack
//                        dragged in (the case grows), the machete dragged onto the new row
// Real pointer and key input throughout.
// Run from games/outbreak: bun scripts/attache-case-proof.ts (fleet: hivemind run --kind browser
// --fetch captures/outbreak-attache).
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium, type Page } from "playwright-core"
import { createServer } from "vite"

const root = resolve(import.meta.dir, "..")
const out = resolve(process.env.LEASE_OUT ?? resolve(root, "../../captures/outbreak-attache"))
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

const t0 = performance.now()
const log = (msg: string) => console.log(`[${((performance.now() - t0) / 1000).toFixed(1)}s] ${msg}`)

async function step(page: Page, n = 1) {
  await page.evaluate(async (n) => {
    const h = (window as any).__arcadeHarness
    for (let i = 0; i < n; i++) await h.step(1 / 60, { aim: h.session().view.player.aim })
  }, n)
}

async function sim<T>(page: Page, fn: string): Promise<T> {
  return page.evaluate((fn) => {
    const h = (window as any).__arcadeHarness
    const session = h.session()
    const view = session.view
    return new Function("session", "progression", "ledger", "view", "h", fn)(session, view.progression, view.progression.ledger, view, h)
  }, fn)
}

/** Night in Ash: the bedroom dresser searched and stocked, a mixed kit carried, a teammate beside you. */
async function scene(page: Page) {
  await page.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    h.freeze(true)
    h.reset(7)
    h.setLab("timeScale", 0)
    h.setLab("zombieCount", 0)
    h.setLab("hour", 21.5)
    h.setLab("inventoryStyle", "case")
    for (let i = 0; i < 4; i++) await h.step()
  })
  const dresser = await sim<{ x: number; y: number }>(
    page,
    `const c = view.containers.find((x) => x.kind === "dresser" && x.buildingId === "ash") ?? view.containers.find((x) => x.buildingId === "ash")
     const st = ledger.store(c.id); st.slots = [{ item: "machete", count: 1, charge: 24 }, { item: "hiking-pack", count: 1 }, { item: "ammo", count: 8 }, { item: "bandage", count: 2 }]; st.size = st.slots.length; st.revealed = true; st.rev = ++ledger.rev
     return { x: c.x, y: c.y }`,
  )
  // A known layout in the 6×3 school backpack: the toolbox lying top-left, a knife beside it, rounds below that.
  await sim(
    page,
    `const a = view.actorId
     const pk = ledger.store(a + "/pack")
     for (let i = 0; i < pk.slots.length; i++) pk.slots[i] = null
     pk.rev = ++ledger.rev
     for (const [item, count] of [["medkit", 2], ["crowbar", 1]]) ledger.apply({ kind: "grant", actor: a, item, count })
     const hb = ledger.store(a + "/hotbar")
     const put = (item, count, x, y, extra = {}) => { const i = pk.slots.indexOf(null); pk.slots[i] = { item, count, ...extra }; pk.places[i] = { x, y }; pk.rev = ++ledger.rev }
     put("toolbox", 1, 0, 0)
     put("knife", 1, 3, 0, { charge: 18 })
     put("ammo", 14, 5, 1)
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
     me.flashlightOn = true`,
  )
  await step(page, 10)
  // Seen once, so nothing glows as new.
  await page.keyboard.press("Tab")
  await step(page, 4)
  await page.keyboard.press("Tab")
  await step(page, 4)
}

type Pt = { x: number; y: number }

async function centerOf(page: Page, selector: string): Promise<Pt | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
  }, selector)
}

/**
 * The screen point to carry `item` to (held by its centre) so it lands on the first free place for it in the case,
 * as it lies or turned, leaving out the case slot it comes from.
 */
async function landing(page: Page, item: string, turned: boolean, skipSlot = -1): Promise<Pt | null> {
  const spot = await sim<{ x: number; y: number; w: number; h: number } | null>(
    page,
    `const pk = ledger.store(view.actorId + "/pack"); const occ = ledger.occupancy(pk, ${skipSlot}); const fp = ledger.footprint(${JSON.stringify(item)}, ${turned})
     for (let y = 0; y + fp.h <= pk.grid.rows; y++) for (let x = 0; x + fp.w <= pk.grid.cols; x++) {
       let free = true
       for (let yy = y; yy < y + fp.h && free; yy++) for (let xx = x; xx < x + fp.w; xx++) if (occ[yy * pk.grid.cols + xx] !== -1) { free = false; break }
       if (free) return { x, y, w: fp.w, h: fp.h }
     }
     return null`,
  )
  if (!spot) return null
  return page.evaluate((s) => {
    const paper = document.querySelector<HTMLElement>("#inv .inv-case-paper")!
    const cols = Number(getComputedStyle(paper).getPropertyValue("--cols"))
    const r = paper.getBoundingClientRect()
    const cell = r.width / cols
    return { x: r.left + (s.x + s.w / 2) * cell, y: r.top + (s.y + s.h / 2) * cell }
  }, spot)
}

async function drag(page: Page, from: string, to: () => Promise<Pt | null>, frames: (n: number) => Promise<void>, turnAt = -1) {
  const a = await centerOf(page, from)
  if (!a) throw new Error(`drag from ${from}: not on screen`)
  await page.mouse.move(a.x, a.y)
  await frames(4)
  await page.mouse.down()
  const n = 16
  let b = a
  for (let i = 1; i <= n; i++) {
    if (i === 2 || i === turnAt + 1) b = (await to()) ?? b
    if (i === turnAt) {
      await page.keyboard.press("KeyR")
      await frames(4)
    }
    const t = i / n
    const e = t * t * (3 - 2 * t)
    await page.mouse.move(a.x + (b.x - a.x) * e, a.y + (b.y - a.y) * e - Math.sin(t * Math.PI) * 26)
    await frames(1)
  }
  await frames(3)
  await page.mouse.up()
  await frames(16)
}

const caseItems = (page: Page) => page.evaluate(() => (window as any).__arcadeHarness.state().inventory.cells?.case)

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
  const adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
  log("harness ready")

  // The still: the case open beside the dresser, the cursor on the machete.
  await scene(page)
  await page.keyboard.press("Tab")
  await step(page, 40)
  const machete = await centerOf(page, `#inv .inv-crate [data-item="machete"]`)
  if (machete) await page.mouse.move(machete.x, machete.y)
  await step(page, 8)
  await page.screenshot({ path: resolve(out, "after.png") })
  const still = await caseItems(page)
  log(`still: ${JSON.stringify(still)}`)
  await page.mouse.move(5, 5)
  await page.keyboard.press("Tab")
  await step(page, 20)

  // The transition: every frame of game time, with the DOM read back each frame.
  const tdir = resolve(out, "transition-frames")
  rmSync(tdir, { recursive: true, force: true })
  mkdirSync(tdir, { recursive: true })
  type Sample = { f: number; hidden: boolean; opacity: number; ty: number; scale: number; lid: string; dim: number; piece: number; p: number }
  const samples: Sample[] = []
  let tf = 0
  const tframes = async (n: number) => {
    for (let i = 0; i < n; i++) {
      await step(page, 1)
      samples.push(
        await page.evaluate((f) => {
          const root = document.querySelector<HTMLElement>("#inv")
          const stage = document.querySelector<HTMLElement>("#inv .inv-stage")
          const cs = stage ? getComputedStyle(stage) : null
          const m = cs && cs.transform !== "none" ? new DOMMatrix(cs.transform) : new DOMMatrix()
          const quick = document.querySelector<HTMLElement>("#inv .inv-quick")
          const motion = (window as any).__arcadeHarness.state().inventory.motion
          return {
            f,
            hidden: !root || root.hidden,
            opacity: cs ? Number(cs.opacity) : 0,
            ty: m.m42,
            scale: m.m11,
            lid: document.querySelector<HTMLElement>("#inv .inv-lid")?.style.transform ?? "",
            dim: Number(document.querySelector<HTMLElement>("#inv .inv-floor")?.style.opacity || 0),
            piece: quick ? Number(getComputedStyle(quick).opacity) : 0,
            p: motion?.p ?? 0,
          }
        }, tf),
      )
      await page.screenshot({ path: resolve(tdir, `f${String(tf++).padStart(4, "0")}.png`) })
    }
  }
  log("transition: recording")
  await tframes(6)
  await page.keyboard.press("Tab")
  await tframes(28)
  await page.keyboard.press("Tab")
  await tframes(16)
  // Tab spam: open, shut, open, shut, open, each a few frames apart, then shut.
  for (const gap of [4, 3, 5, 3]) {
    await page.keyboard.press("Tab")
    await tframes(gap)
  }
  await page.keyboard.press("Tab")
  await tframes(24)
  await page.keyboard.press("Tab")
  await tframes(16)
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!
    const b = samples[i]!
    if (a.hidden || b.hidden) {
      // It only leaves the page once it has faded out.
      if (!a.hidden && b.hidden) assert.ok(a.opacity < 0.05, `frame ${b.f}: hidden at opacity ${a.opacity}`)
      continue
    }
    assert.ok(Math.abs(b.opacity - a.opacity) <= 0.42, `frame ${b.f}: opacity jumped ${a.opacity} → ${b.opacity}`)
    assert.ok(Math.abs(b.ty - a.ty) <= 4.2, `frame ${b.f}: rise jumped ${a.ty} → ${b.ty}`)
    assert.ok(Math.abs(b.scale - a.scale) <= 0.016, `frame ${b.f}: scale jumped ${a.scale} → ${b.scale}`)
    assert.ok(Math.abs(b.dim - a.dim) <= 0.31, `frame ${b.f}: dim jumped ${a.dim} → ${b.dim}`)
  }
  writeFileSync(resolve(out, "transition.json"), JSON.stringify(samples, null, 1))
  for (const [name, filter] of [["transition.mp4", "null"], ["transition-slow.mp4", "setpts=4*PTS"]] as const) {
    const r = Bun.spawnSync(["ffmpeg", "-y", "-loglevel", "error", "-framerate", "60", "-i", resolve(tdir, "f%04d.png"), "-vf", filter, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-r", "60", resolve(out, name)])
    assert.equal(r.exitCode, 0, r.stderr.toString())
  }
  log(`transition: ${samples.length} frames, max opacity step ${Math.max(...samples.slice(1).map((s, i) => Math.abs(s.opacity - samples[i]!.opacity))).toFixed(3)}`)

  // The packing clip, 30 frames a second of game time.
  const dir = resolve(out, "frames")
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  let frame = 0
  const frames = async (n: number) => {
    for (let i = 0; i < n; i++) {
      await step(page, 2)
      await page.screenshot({ path: resolve(dir, `f${String(frame++).padStart(4, "0")}.png`) })
    }
  }
  await scene(page)
  log("clip: recording")
  await frames(8)
  await page.keyboard.press("Tab")
  await frames(24)
  // The toolbox: picked up, turned with R mid-carry, set down standing.
  const toolboxSlot = await sim<number>(page, `return ledger.store(view.actorId + "/pack").slots.findIndex((s) => s && s.item === "toolbox")`)
  await drag(page, `#inv .inv-case-paper [data-item="toolbox"]`, () => landing(page, "toolbox", true, toolboxSlot), frames, 7)
  // The knife turned where it lies (R over it), if it fits turned.
  const knife = await centerOf(page, `#inv .inv-case-paper [data-item="knife"]`)
  if (knife) {
    await page.mouse.move(knife.x, knife.y)
    await frames(8)
    await page.keyboard.press("KeyR")
    await frames(16)
  }
  // The hiking pack: worn at once, and the case unfolds a column and a row.
  await drag(page, `#inv .inv-crate [data-item="hiking-pack"]`, () => centerOf(page, "#inv .inv-case-paper"), frames)
  await frames(20)
  // In from the dresser: the machete lies down on the new row.
  await drag(page, `#inv .inv-crate [data-item="machete"]`, () => landing(page, "machete", false), frames)
  await page.mouse.move(5, 5)
  await frames(36)
  const after = await caseItems(page)
  log(`clip: ${frame} frames, ${JSON.stringify(after)}`)
  assert.equal(after.cols, 7, "the hiking pack grew the case")
  assert.ok(after.items.some((i: string) => i.startsWith("machete@")), "the machete is in the case")
  assert.ok(after.items.some((i: string) => /^toolbox@\d+,\d+r/.test(i)), "the toolbox lies turned")
  assert.ok(after.items.some((i: string) => /^knife@\d+,\d+r/.test(i)), "the knife lies turned")

  const enc = Bun.spawnSync(["ffmpeg", "-y", "-loglevel", "error", "-framerate", "30", "-i", resolve(dir, "f%04d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", resolve(out, "clip.mp4")])
  assert.equal(enc.exitCode, 0, enc.stderr.toString())
  writeFileSync(resolve(out, "index.json"), JSON.stringify({ adapter, still, after, frames: frame, errors }, null, 2))
  assert.deepEqual(errors, [])
  log(`attaché case proof in ${out}`)
} finally {
  await browser.close()
  await server.close()
}
