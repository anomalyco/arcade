// Headless Metal proof for the Outbreak map: walks a scripted ~1 km loop through the streamed world, then captures the
// full map (survey and noir, three zooms), the compass ring, the corner minimap, teammates, pings, a last-known horde
// and marks; checks pan/zoom/marker input and that the game keeps running with the map open; and measures what the map
// costs per frame with the sheet closed and open. No visible window, no audio.
// Run from games/outbreak: bun scripts/map-proof.ts   (fleet: hivemind run --kind browser -- bun scripts/map-proof.ts)
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { type Page } from "playwright-core"
import { browserBudget } from "../../../scripts/browser-budget"
import { createServer } from "vite"

await using budget = browserBudget()
const { chromium } = budget

const root = resolve(import.meta.dir, "..")
const out = resolve(process.env.MAP_OUT ?? resolve(root, "../../captures/outbreak-map"))
mkdirSync(out, { recursive: true })

const server = await createServer({
  root,
  logLevel: "warn",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "map-proof-hooks",
      enforce: "pre",
      transform(code, id) {
        if (id !== resolve(root, "src/main.ts")) return
        const hooked = code.replace("Object.assign(window, { __arcadeHarness: harness })", "Object.assign(window, { __arcadeHarness: Object.assign(harness, { map, session: () => session, cam }) })")
        if (hooked === code) throw new Error("map-proof hook did not match src/main.ts")
        return hooked
      },
    },
  ],
})
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

const report: Record<string, unknown> = {}
const shots: { name: string; caption: string }[] = []

async function snap(page: Page, name: string, caption: string) {
  await page.screenshot({ path: resolve(out, `${name}.png`) })
  shots.push({ name, caption })
  console.log(`  ${name}: ${caption}`)
}

const inspect = (page: Page) => page.evaluate(() => (window as any).__arcadeHarness.map.inspect())

/** Steps the game `n` fixed ticks walking toward (tx, ty), sweeping the aim to look at both sides of the street. */
async function walkTo(page: Page, tx: number, ty: number, timings: number[]) {
  for (let guard = 0; guard < 400; guard++) {
    const r = await page.evaluate(
      async ({ tx, ty }) => {
        const h = (window as any).__arcadeHarness
        const ms: number[] = []
        let p = h.state().player
        for (let i = 0; i < 12; i++) {
          const dx = tx - p.x
          const dy = ty - p.y
          const d = Math.hypot(dx, dy)
          if (d < 1.2) return { done: true, ms, x: p.x, y: p.y }
          const heading = Math.atan2(dy, dx)
          const aim = heading + Math.sin(performance.now() / 700) * 1.05
          const t0 = performance.now()
          const s = await h.step(1 / 60, { mx: dx / d, my: dy / d, sprint: true, aim })
          ms.push(performance.now() - t0)
          p = s.player
        }
        return { done: false, ms, x: p.x, y: p.y }
      },
      { tx, ty },
    )
    timings.push(...r.ms)
    if (r.done) return
    // Hop past anything parked across the lane rather than stalling the route.
    if (guard % 20 === 19) {
      const prev = (await page.evaluate(() => (window as any).__arcadeHarness.state().player)) as { x: number; y: number }
      const d = Math.hypot(tx - prev.x, ty - prev.y)
      await page.evaluate(
        ({ x, y, a }) => (window as any).__arcadeHarness.pose(x, y, a),
        { x: prev.x + ((tx - prev.x) / d) * 2.5, y: prev.y + ((ty - prev.y) / d) * 2.5, a: Math.atan2(ty - prev.y, tx - prev.x) },
      )
    }
  }
  throw new Error(`walk to ${tx}, ${ty} did not arrive`)
}

const pctl = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return Number((s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0).toFixed(2))
}
const summary = (xs: number[]) => ({ n: xs.length, p50: pctl(xs, 0.5), p95: pctl(xs, 0.95), max: Number(Math.max(0, ...xs).toFixed(2)) })

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
  page.on("pageerror", (e) => console.error("pageerror", e.message))
  await page.goto(`http://127.0.0.1:${port}/?seed=7&bench&peaceful=1&hour=13`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 120_000 })
  const adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
  report.adapter = adapter
  console.log("adapter", adapter)
  await page.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    try {
      localStorage.clear()
    } catch {}
    h.map.reset()
    for (let i = 0; i < 10; i++) await h.step()
    h.map.resetStats()
  })

  // 1. The route: east along the arterial through three districts, north, west, and back down to the start street.
  const route: [number, number][] = [
    [30, 44],
    [332, 44],
    [332, -148],
    [44, -148],
    [44, 30],
  ]
  const walk: number[] = []
  const t0 = Date.now()
  for (const [x, y] of route) {
    await walkTo(page, x, y, walk)
    const st = await inspect(page)
    console.log(`  reached ${x},${y}: ${st.chunks} chunks, ${st.knownPois} POIs`)
    if (x === 332 && y === 44) {
      // A group on the industrial block: seen once, then gone from where they were.
      await page.evaluate(async () => {
        const h = (window as any).__arcadeHarness
        const p = h.state().player
        for (let i = 0; i < 6; i++) h.spawnZombie(p.x + 9 + (i % 3) * 1.1, p.y - 8 - Math.floor(i / 3) * 1.2, "wander")
        for (let i = 0; i < 30; i++) await h.step(1 / 60, { aim: Math.atan2(-8, 10) })
        for (const z of h.state().zombies) {
          z.x += 900
          z.y += 900
        }
      })
    }
  }
  report.walk = { seconds: Math.round((Date.now() - t0) / 1000), steps: walk.length, stepMs: summary(walk) }
  const explored = await inspect(page)
  report.explored = { chunks: explored.chunks, cells: explored.exploredCells, knownBuildings: explored.knownBuildings, knownPois: explored.knownPois, sightings: explored.sightings.length }
  report.closedUpdate = explored.updateMs
  report.prewarm = explored.tiles
  assert(explored.chunks >= 40, `explored only ${explored.chunks} chunks`)
  assert(explored.knownPois >= 4, `only ${explored.knownPois} POIs known`)
  assert(explored.sightings.length >= 1, "the horde was not recorded")

  // 2. Open with the physical key and measure the opening frame.
  await page.evaluate(() => (window as any).__arcadeHarness.map.resetStats())
  await page.keyboard.press("KeyN")
  const openFrame = await page.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    const t = performance.now()
    await h.step()
    const first = performance.now() - t
    const frames: number[] = []
    for (let i = 0; i < 20; i++) {
      const s = performance.now()
      await h.step()
      frames.push(performance.now() - s)
    }
    return { first, frames, map: h.map.inspect() }
  })
  assert(openFrame.map.open, "KeyN did not open the map")
  report.open = { firstStepMs: Number(openFrame.first.toFixed(2)), next20: summary(openFrame.frames), tiles: openFrame.map.tiles, screen: openFrame.map.screen, update: openFrame.map.updateMs }
  await snap(page, "01-map-survey", "Full map after the 1 km loop, survey paper, opening zoom")

  const setView = (zoom: number, x?: number, y?: number) =>
    page.evaluate(
      async ({ zoom, x, y }) => {
        const h = (window as any).__arcadeHarness
        const m = h.map
        m.screen.zoomAt(zoom / m.screen.view.zoom)
        if (x !== undefined && y !== undefined) m.screen.centreOn(x, y)
        for (let i = 0; i < 40 && (i < 3 || m.tiles.stats.pending > 0); i++) await h.step()
        return m.inspect()
      },
      { zoom, x, y },
    )
  await setView(7.5, 44, 44)
  await snap(page, "02-map-close", "Zoomed in on Ash & Elm: safehouses, hardware and pharmacy, kerbs and hatching at DPR 2")
  await setView(0.9, 180, -50)
  await snap(page, "03-map-overview", "The whole loop at 0.9 px/m")
  await page.evaluate(() => (window as any).__arcadeHarness.setLab("mapStyle", 1))
  await setView(2.6, 190, -50)
  await snap(page, "04-map-noir", "Noir survey look")
  await page.evaluate(() => (window as any).__arcadeHarness.setLab("mapStyle", 0))
  const horde = await page.evaluate(() => (window as any).__arcadeHarness.map.hordes().sort((a: any, b: any) => b.count - a.count)[0])
  await setView(3.2, horde.x, horde.y + 10)
  await snap(page, "05-map-horde", `Last-known horde of ${horde.count} on the industrial block, with its age`)

  // 3. Input: pinch zoom about the cursor, two-finger pan follows the fingers, click to mark, click again to clear.
  const input = await page.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    const m = h.map
    m.screen.zoomAt(3 / m.screen.view.zoom)
    m.screen.centreOn(100, 0)
    const live = document.querySelector(".obmap-live") as HTMLCanvasElement
    const r = live.getBoundingClientRect()
    const fire = (init: WheelEventInit) => live.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: r.left + r.width * 0.75, clientY: r.top + r.height * 0.5, ...init }))
    const before = { ...m.screen.view }
    const under = m.screen.toWorld(r.width * 0.75, r.height * 0.5)
    fire({ deltaY: -40, ctrlKey: true })
    const pinched = { ...m.screen.view }
    const underAfter = m.screen.toWorld(r.width * 0.75, r.height * 0.5)
    // Fingers move up the pad: the browser reports positive deltaY and the sheet should move up with them.
    fire({ deltaY: 30, deltaX: -20 })
    const panned = { ...m.screen.view }
    return { before, pinched, panned, under, underAfter }
  })
  assert(input.pinched.zoom > input.before.zoom, "pinch did not zoom in")
  assert(Math.abs(input.under[0] - input.underAfter[0]) < 0.01 && Math.abs(input.under[1] - input.underAfter[1]) < 0.01, "pinch moved the point under the cursor")
  assert(input.panned.y > input.pinched.y && input.panned.x < input.pinched.x, "two-finger pan went the wrong way")
  const box = (await page.locator(".obmap-live").boundingBox())!
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.45)
  const marked = await inspect(page)
  assert.equal(marked.markers.length, 1, "click did not place a mark")
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.45 - 10)
  assert.equal((await inspect(page)).markers.length, 0, "clicking the mark did not clear it")
  report.input = { pinchZoom: [input.before.zoom, input.pinched.zoom], panDelta: [input.panned.x - input.pinched.x, input.panned.y - input.pinched.y], markToggle: true }

  // 4. Co-op: a teammate, their ping, our marks and the horde, then the same on the compass ring and minimap.
  await page.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    const sim = h.session().sim
    const p = h.state().player
    const mate = sim.slots.find((s: any) => s.id === "Wren") ?? sim.addSurvivor("Wren", 1)
    Object.assign(mate.survivor, { x: p.x + 60, y: p.y - 40, aim: 2.4 })
    const now = h.state().time
    h.state().progression.pings.push({ id: 900, by: 1, x: p.x + 70, y: p.y - 70, label: "Pharmacy", until: now + 60 })
    h.map.memory.addMarker(p.x + 120, p.y + 30)
    h.map.memory.addMarker(p.x - 40, p.y - 110)
    h.map.screen.zoomAt(2.2 / h.map.screen.view.zoom)
    h.map.screen.centreOn(p.x + 40, p.y - 20)
    for (let i = 0; i < 8; i++) await h.step()
  })
  await snap(page, "06-map-coop", "Teammate with facing, their ping, two marks and the last-known horde")
  await page.keyboard.press("KeyN")
  assert.equal((await inspect(page)).open, false, "KeyN did not close the map")

  await page.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    h.setLab("mapMinimap", 1)
    h.setLab("zoom", 30)
    for (let i = 0; i < 6; i++) await h.step()
  })
  const compass = await inspect(page)
  assert(compass.compass.visible && compass.compass.bearings >= 3, "compass ring missing bearings")
  await snap(page, "07-compass", "Compass ring on the ground: marks, teammate, ping and known places")
  await page.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    h.setLab("mapMinimap", 2)
    for (let i = 0; i < 6; i++) await h.step()
  })
  assert((await inspect(page)).minimap.visible, "minimap not shown")
  await snap(page, "08-minimap", "Corner minimap from the same tiles")

  // 5. Cost with the sheet closed vs open while walking, in alternating pairs over the same street.
  await page.evaluate(() => (window as any).__arcadeHarness.setLab("mapMinimap", 0))
  const pairs: { closed: number[]; open: number[]; closedMap: unknown; openMap: unknown }[] = []
  for (let k = 0; k < 4; k++) {
    // Each pair walks east then back west; which leg has the sheet open alternates so direction doesn't bias it.
    const pair = { closed: [] as number[], open: [] as number[], closedMap: null as unknown, openMap: null as unknown }
    for (const [leg, target] of [[0, 150], [1, 44]] as const) {
      const open = (leg === 1) !== (k % 2 === 1)
      await page.evaluate((open) => {
        const m = (window as any).__arcadeHarness.map
        if (open !== m.isOpen) m.toggle()
        m.resetStats()
      }, open)
      const ms: number[] = []
      await walkTo(page, target, 44, ms)
      const st = await inspect(page)
      if (open) Object.assign(pair, { open: ms, openMap: st.updateMs })
      else Object.assign(pair, { closed: ms, closedMap: st.updateMs })
    }
    pairs.push(pair)
  }
  report.pairs = pairs.map((p) => ({ closedStep: summary(p.closed), openStep: summary(p.open), closedMap: p.closedMap, openMap: p.openMap }))
  report.memory = await page.evaluate(() => {
    const m = (window as any).__arcadeHarness.map
    return { tilesCached: m.tiles.stats.cached, tileBytesMB: Number((m.tiles.stats.bytes / 1048576).toFixed(1)), chunks: m.memory.chunks.size, exploredKB: Math.round((m.memory.chunks.size * 1024) / 1024) }
  })

  // 6. Real time: with the map open the game keeps running and movement keys still move the survivor.
  const live = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
  await live.goto(`http://127.0.0.1:${port}/?seed=7&peaceful=1`)
  await live.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 120_000 })
  await live.waitForTimeout(500)
  await live.keyboard.press("KeyN")
  const a = await live.evaluate(() => {
    const s = (window as any).__arcadeHarness.state()
    return { time: s.time, y: s.player.y, open: (window as any).__arcadeHarness.map.isOpen }
  })
  await live.keyboard.down("KeyW")
  await live.waitForTimeout(900)
  await live.keyboard.up("KeyW")
  const b = await live.evaluate(() => {
    const s = (window as any).__arcadeHarness.state()
    return { time: s.time, y: s.player.y, open: (window as any).__arcadeHarness.map.isOpen }
  })
  assert(a.open && b.open, "map closed unexpectedly")
  assert(b.time > a.time + 0.5, "the game paused while the map was open")
  assert(b.y < a.y - 1, "W did not move the survivor with the map open")
  report.realtime = { simSeconds: Number((b.time - a.time).toFixed(2)), movedMetres: Number((a.y - b.y).toFixed(2)) }
  await snap(live, "09-map-realtime", "Map open over the running game (real-time page, after walking north with W)")
  await live.close()
  await page.close()
} finally {
  writeFileSync(resolve(out, "report.json"), JSON.stringify({ report, shots }, null, 2))
  console.log(JSON.stringify(report, null, 2))
  await browser.close()
  await server.close()
}
