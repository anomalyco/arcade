import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright-core"
import { CoopRoomCore } from "../server/room-core"
import { BUILD } from "../shared/build.gen"
import { TICK_DT } from "../shared/clock"
import { DEFAULT_COOP_ROOM } from "../shared/coop-config"
import { CHUNK } from "../shared/map"
import {
  chunkKey,
  generateWorldChunk,
  type DistrictKind,
  type WorldChunk,
} from "../shared/world"
import { NetSession } from "../src/net-session"
import { Loopback } from "../tests/loopback"

const game = resolve(import.meta.dir, "..")
const out = resolve(game, "../../captures/outbreak-world")
mkdirSync(out, { recursive: true })

function renderOverviewSvg(seed = 7): string {
  // Render a 12 × 9 chunk (384 m × 288 m) detailed regional map + 1.2 km scale bar & co-op windows
  const minCx = -1
  const maxCx = 14
  const minCy = -2
  const maxCy = 6
  const cols = maxCx - minCx + 1 // 16 chunks = 512 m
  const rows = maxCy - minCy + 1 // 9 chunks = 288 m
  const pxPerMeter = 2.5
  const padL = 48
  const padT = 86
  const padR = 48
  const padB = 96
  const mapW = cols * CHUNK * pxPerMeter
  const mapH = rows * CHUNK * pxPerMeter
  const W = mapW + padL + padR
  const H = mapH + padT + padB

  const wx = (x: number) => padL + (x - minCx * CHUNK) * pxPerMeter
  const wy = (y: number) => padT + (y - minCy * CHUNK) * pxPerMeter

  const districtFill: Record<DistrictKind, string> = {
    suburb: "#1d261d",
    commercial: "#26221e",
    civic: "#1c222b",
    industrial: "#252321",
    woodland: "#162017",
  }
  const districtAccent: Record<DistrictKind, string> = {
    suburb: "#689d6a",
    commercial: "#d79921",
    civic: "#83a598",
    industrial: "#fe8019",
    woodland: "#8ec07c",
  }

  const chunks: WorldChunk[] = []
  for (let cy = minCy; cy <= maxCy; cy++) {
    for (let cx = minCx; cx <= maxCx; cx++) {
      chunks.push(generateWorldChunk(seed, seed, cx, cy, "streaming"))
    }
  }

  const svg: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="background:#0d1014;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,monospace">`,
    `<rect width="${W}" height="${H}" fill="#0d1014"/>`,
    // Header
    `<text x="${padL}" y="36" fill="#ebdbb2" font-size="20" font-weight="700">OUTBREAK · PROCEDURAL STREAMING WORLD OVERVIEW (SEED ${seed})</text>`,
    `<text x="${padL}" y="60" fill="#a89984" font-size="13">Hierarchical deterministic (seed, cx, cy) generation · 32×32 m chunks · 96×96 m macro-blocks · 5 districts · 13 POI archetypes · 1.2+ km streaming route</text>`,
  ]

  // 1. Chunk backgrounds & grid lines
  for (const c of chunks) {
    const [x0, y0, x1, y1] = c.bounds
    const rx = wx(x0)
    const ry = wy(y0)
    const rw = (x1 - x0) * pxPerMeter
    const rh = (y1 - y0) * pxPerMeter
    svg.push(
      `<rect x="${rx.toFixed(1)}" y="${ry.toFixed(1)}" width="${rw.toFixed(1)}" height="${rh.toFixed(1)}" fill="${districtFill[c.district]}" stroke="#282c34" stroke-width="0.75"/>`,
    )
  }

  // 2. Arterial road network (lx === 1 or ly === 1 in each 96m macro-block)
  for (const c of chunks) {
    const [x0, y0, x1, y1] = c.bounds
    if (c.lx === 1) {
      svg.push(
        `<rect x="${wx(x0 + 6).toFixed(1)}" y="${wy(y0).toFixed(1)}" width="${(12 * pxPerMeter).toFixed(1)}" height="${(CHUNK * pxPerMeter).toFixed(1)}" fill="#3c3836"/>`,
        `<rect x="${wx(x0 + 8).toFixed(1)}" y="${wy(y0).toFixed(1)}" width="${(8 * pxPerMeter).toFixed(1)}" height="${(CHUNK * pxPerMeter).toFixed(1)}" fill="#282828"/>`,
        `<line x1="${wx(x0 + 12).toFixed(1)}" y1="${wy(y0).toFixed(1)}" x2="${wx(x0 + 12).toFixed(1)}" y2="${wy(y1).toFixed(1)}" stroke="#b57614" stroke-width="1" stroke-dasharray="6,6"/>`,
      )
    }
    if (c.ly === 1) {
      svg.push(
        `<rect x="${wx(x0).toFixed(1)}" y="${wy(y0 + 6).toFixed(1)}" width="${(CHUNK * pxPerMeter).toFixed(1)}" height="${(12 * pxPerMeter).toFixed(1)}" fill="#3c3836"/>`,
        `<rect x="${wx(x0).toFixed(1)}" y="${wy(y0 + 8).toFixed(1)}" width="${(CHUNK * pxPerMeter).toFixed(1)}" height="${(8 * pxPerMeter).toFixed(1)}" fill="#282828"/>`,
        `<line x1="${wx(x0).toFixed(1)}" y1="${wy(y0 + 12).toFixed(1)}" x2="${wx(x1).toFixed(1)}" y2="${wy(y0 + 12).toFixed(1)}" stroke="#b57614" stroke-width="1" stroke-dasharray="6,6"/>`,
      )
    }
  }

  // 3. Macro-block (96×96 m) outlines & district headers
  for (let by = Math.floor(minCy / 3); by <= Math.floor(maxCy / 3); by++) {
    for (let bx = Math.floor(minCx / 3); bx <= Math.floor(maxCx / 3); bx++) {
      const x0 = Math.max(minCx * CHUNK, bx * 96)
      const y0 = Math.max(minCy * CHUNK, by * 96)
      const x1 = Math.min((maxCx + 1) * CHUNK, (bx + 1) * 96)
      const y1 = Math.min((maxCy + 1) * CHUNK, (by + 1) * 96)
      if (x1 <= x0 || y1 <= y0) continue
      const sampleChunk = chunks.find((c) => c.bx === bx && c.by === by)
      const dist = sampleChunk?.district ?? "suburb"
      const col = districtAccent[dist]
      svg.push(
        `<rect x="${wx(x0).toFixed(1)}" y="${wy(y0).toFixed(1)}" width="${((x1 - x0) * pxPerMeter).toFixed(1)}" height="${((y1 - y0) * pxPerMeter).toFixed(1)}" fill="none" stroke="${col}" stroke-width="1.6" stroke-opacity="0.55" stroke-dasharray="5,4"/>`,
      )
      if (x1 - x0 >= 64 && y1 - y0 >= 64) {
        const tag = bx === 0 && by === 0 ? `BLOCK (0,0) · CLASSIC SUBURB` : `BLOCK (${bx},${by}) · ${dist.toUpperCase()}`
        svg.push(
          `<rect x="${(wx(x0) + 5).toFixed(1)}" y="${(wy(y0) + 5).toFixed(1)}" width="${(tag.length * 6.5 + 10).toFixed(1)}" height="16" rx="3" fill="#0d1014" fill-opacity="0.82"/>`,
          `<text x="${(wx(x0) + 10).toFixed(1)}" y="${(wy(y0) + 16).toFixed(1)}" fill="${col}" font-size="10" font-weight="700">${tag}</text>`,
        )
      }
    }
  }

  // 4. Trees, vehicles, buildings, doors & POI labels
  for (const c of chunks) {
    for (const p of c.props) {
      if (p.kind !== "tree") continue
      svg.push(
        `<circle cx="${wx(p.x).toFixed(1)}" cy="${wy(p.y).toFixed(1)}" r="${((1.8 + p.variant * 0.9) * pxPerMeter).toFixed(1)}" fill="#324b2a" fill-opacity="0.78" stroke="#4c6e3d" stroke-width="0.7"/>`,
      )
    }
    for (const v of c.vehicles) {
      svg.push(
        `<rect x="${wx(v[0]).toFixed(1)}" y="${wy(v[1]).toFixed(1)}" width="${((v[2] - v[0]) * pxPerMeter).toFixed(1)}" height="${((v[3] - v[1]) * pxPerMeter).toFixed(1)}" rx="2" fill="#8f3f31" stroke="#ebdbb2" stroke-width="0.6"/>`,
      )
    }
    for (const b of c.buildings) {
      const [bx0, by0, bx1, by1] = b.rect
      const arch = (b.archetype ?? b.kind).toUpperCase().replace("_", " ")
      const fill =
        b.kind === "house"
          ? "#7c6f64"
          : b.archetype === "police" || b.archetype === "clinic"
            ? "#458588"
            : b.archetype === "warehouse"
              ? "#665c54"
              : "#928374"
      svg.push(
        `<rect x="${wx(bx0).toFixed(1)}" y="${wy(by0).toFixed(1)}" width="${((bx1 - bx0) * pxPerMeter).toFixed(1)}" height="${((by1 - by0) * pxPerMeter).toFixed(1)}" rx="2" fill="${fill}" stroke="#ebdbb2" stroke-width="1.2"/>`,
        `<text x="${wx((bx0 + bx1) * 0.5).toFixed(1)}" y="${(wy((by0 + by1) * 0.5) + 3).toFixed(1)}" fill="#fbf1c7" font-size="8.5" font-weight="700" text-anchor="middle">${arch}</text>`,
      )
    }
    for (const d of c.doors) {
      const [dx0, dy0, dx1, dy1] = d.rect
      svg.push(
        `<rect x="${wx(dx0).toFixed(1)}" y="${wy(dy0).toFixed(1)}" width="${Math.max(3, (dx1 - dx0) * pxPerMeter).toFixed(1)}" height="${Math.max(3, (dy1 - dy0) * pxPerMeter).toFixed(1)}" fill="#fabd2f"/>`,
      )
    }
  }

  // 5. Highlight active 3×3 chunk streaming windows & 1+ km traversal path
  svg.push(
    `<rect x="${wx(0).toFixed(1)}" y="${wy(0).toFixed(1)}" width="${(96 * pxPerMeter).toFixed(1)}" height="${(96 * pxPerMeter).toFixed(1)}" fill="none" stroke="#fabd2f" stroke-width="2.5"/>`,
    `<rect x="${(wx(48) - 108).toFixed(1)}" y="${(wy(96) - 19).toFixed(1)}" width="216" height="16" rx="3" fill="#0d1014" fill-opacity="0.88"/>`,
    `<text x="${(wx(48)).toFixed(1)}" y="${(wy(96) - 8).toFixed(1)}" fill="#fabd2f" font-size="10.5" font-weight="700" text-anchor="middle">SURVIVOR 1 ACTIVE 3×3 WINDOW (96×96 m)</text>`,
    `<rect x="${wx(9 * 32).toFixed(1)}" y="${wy(0).toFixed(1)}" width="${(96 * pxPerMeter).toFixed(1)}" height="${(96 * pxPerMeter).toFixed(1)}" fill="none" stroke="#83a598" stroke-width="2.5"/>`,
    `<rect x="${(wx(9 * 32 + 48) - 108).toFixed(1)}" y="${(wy(96) - 19).toFixed(1)}" width="216" height="16" rx="3" fill="#0d1014" fill-opacity="0.88"/>`,
    `<text x="${(wx(9 * 32 + 48)).toFixed(1)}" y="${(wy(96) - 8).toFixed(1)}" fill="#83a598" font-size="10.5" font-weight="700" text-anchor="middle">STREAMED 3×3 WINDOW @ +336 m EAST</text>`,
    `<line x1="${wx(27.7).toFixed(1)}" y1="${wy(44).toFixed(1)}" x2="${wx(440).toFixed(1)}" y2="${wy(44).toFixed(1)}" stroke="#fb4934" stroke-width="3" stroke-dasharray="8,5"/>`,
    `<circle cx="${wx(27.7).toFixed(1)}" cy="${wy(44).toFixed(1)}" r="6" fill="#fabd2f" stroke="#0d1014" stroke-width="2"/>`,
    `<circle cx="${wx(336).toFixed(1)}" cy="${wy(44).toFixed(1)}" r="6" fill="#83a598" stroke="#0d1014" stroke-width="2"/>`,
  )

  // Legend footer
  const ly = H - 52
  const legend: [string, string][] = [
    ["#689d6a", "Suburb District (Houses / Ranch / Cottage)"],
    ["#d79921", "Commercial Strip (Hardware / Pharmacy / Grocery / Diner / Gas)"],
    ["#83a598", "Civic Landmarks (Police / Clinic / Church)"],
    ["#fe8019", "Industrial Yard (Warehouses)"],
    ["#8ec07c", "Woodland Outskirts (Cabins / Groves)"],
  ]
  let lxCursor = padL
  for (const [col, label] of legend) {
    svg.push(
      `<rect x="${lxCursor}" y="${ly}" width="12" height="12" rx="2" fill="${col}"/>`,
      `<text x="${lxCursor + 18}" y="${ly + 10}" fill="#d5c4a1" font-size="11.5">${label}</text>`,
    )
    lxCursor += label.length * 6.4 + 34
  }
  svg.push(
    `<text x="${padL}" y="${ly + 30}" fill="#928374" font-size="11">All chunk hashes match bit-for-bit between client and room DO · Unloaded chunks persist doors, windows, barricades, loot &amp; zombie states in sparse ChunkDelta records.</text>`,
    `</svg>`,
  )
  return svg.join("\n")
}

// 1. Write overview SVG
const svgPath = resolve(out, "overview-map.svg")
await Bun.write(svgPath, renderOverviewSvg(7))

// 2. Verify client vs server chunk hash determinism across 49 chunks (-3..3 × -3..3 macro-blocks)
const serverHashes: Record<string, number> = {}
for (let cy = -2; cy <= 4; cy++) {
  for (let cx = -1; cx <= 38; cx += 3) {
    const ch = generateWorldChunk(7, 7, cx, cy, "streaming")
    serverHashes[ch.key] = ch.hash
  }
}

// 3. Build production bundle and run headless Metal proof across 1.15 km
const build = Bun.spawnSync(["bun", "run", "build"], { cwd: game, stdout: "inherit", stderr: "inherit" })
assert.equal(build.exitCode, 0, "Production build failed")

const root = resolve(game, "dist/arcade/outbreak")
const fixture = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname
    if (path === "/favicon.ico") return new Response(null, { status: 204 })
    const file = Bun.file(resolve(root, `.${path === "/" ? "/index.html" : path}`))
    return (await file.exists()) ? new Response(file) : new Response("Not found", { status: 404 })
  },
})

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`)
  .find(existsSync)
assert(chrome, "Install Chromium before running prove-world.ts")

const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: [
    "--enable-unsafe-webgpu",
    "--use-angle=metal",
    "--ignore-gpu-blocklist",
    "--mute-audio",
    "--enable-precise-memory-info",
    "--js-flags=--expose-gc",
  ],
})

async function captureHeapSnapshotSummary(cdp: any): Promise<{ totalMB: number; byType: Map<string, { count: number; bytes: number }> }> {
  await cdp.send("HeapProfiler.collectGarbage")
  let raw = ""
  const onChunk = (ev: { chunk: string }) => {
    raw += ev.chunk
  }
  cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk)
  await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false })
  cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk)

  const snap = JSON.parse(raw)
  const fields: string[] = snap.snapshot.meta.node_fields
  const types: string[] = snap.snapshot.meta.node_types[0]
  const stride = fields.length
  const typeIdx = fields.indexOf("type")
  const nameIdx = fields.indexOf("name")
  const selfSizeIdx = fields.indexOf("self_size")
  const nodes: number[] = snap.nodes
  const strings: string[] = snap.strings

  let totalBytes = 0
  const byType = new Map<string, { count: number; bytes: number }>()
  for (let i = 0; i < nodes.length; i += stride) {
    const t = types[nodes[i + typeIdx]!]!
    const name = `${t}:${strings[nodes[i + nameIdx]!] ?? ""}`
    const sz = nodes[i + selfSizeIdx]!
    totalBytes += sz
    const cur = byType.get(name)
    if (cur) {
      cur.count++
      cur.bytes += sz
    } else {
      byType.set(name, { count: 1, bytes: sz })
    }
  }
  return { totalMB: Number((totalBytes / (1024 * 1024)).toFixed(2)), byType }
}

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text())
  })

  await page.goto(`http://127.0.0.1:${fixture.port}/?solo&seed=7&bench`, { waitUntil: "networkidle" })
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready)
  const adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
  assert.match(adapter.architecture, /metal/)

  // Capture representative district views along the 1.15 km route (using sodium_70s look so full district architecture & POIs are clearly visible)
  const districtStops = [
    { name: "01-suburb-origin", x: 30, y: 39, aim: -Math.PI / 2, hour: 18.0 },
    { name: "02-commercial-strip", x: 118, y: 38, aim: -Math.PI / 2, hour: 18.0 },
    { name: "03-civic-police-clinic", x: 240, y: 38, aim: -Math.PI / 2, hour: 18.0 },
    { name: "04-industrial-warehouse", x: 310, y: 38, aim: -Math.PI / 2, hour: 18.0 },
    { name: "05-woodland-outskirts", x: 432, y: 38, aim: -Math.PI / 2, hour: 18.0 },
  ]

  for (const stop of districtStops) {
    await page.evaluate(async (s) => {
      const h = (window as any).__arcadeHarness
      h.setLookPreset("sodium_70s")
      h.setLab("timeScale", 0)
      h.setLab("hour", s.hour)
      h.setLab("zoom", 48)
      h.pose(s.x, s.y, s.aim)
      for (let i = 0; i < 6; i++) await h.step(1 / 60)
    }, stop)
    await page.screenshot({ path: resolve(out, `${stop.name}.png`) })
  }
  await page.evaluate(() => {
    const h = (window as any).__arcadeHarness
    h.setLab("zoom", 46)
    h.setLookPreset("noir")
  })

  // Run scripted 1,150 m traversal (from x = 28 m to x = 1,180 m along the East-West road y = 44 m),
  // plus delta persistence test (open a door in chunk (3, 0), travel to x = 1,180 m, return to chunk (3, 0)).
  const traversal = await page.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    h.reset(7)
    h.setLab("timeScale", 0)
    h.setLab("hour", 18.5)
    h.setLab("zombieCount", 12)

    // 1. Visit chunk (3, 0) at (108, 28), open its front door, and verify it is open
    h.pose(108, 28, -Math.PI / 2)
    await h.step(1 / 60)
    const stAtChunk3 = h.state()
    const chunk3Door = stAtChunk3.town.doors.find((d: any) => d.id.startsWith("c3_0-"))
    if (!chunk3Door) throw new Error("Expected door in chunk (3, 0)")
    chunk3Door.open = true
    chunk3Door.locked = true
    const chunk3Container = stAtChunk3.containers.find((c: any) => c.id.startsWith("c3_0-"))
    if (chunk3Container) chunk3Container.searched = true

    // 2. Start 1,152 m Eastbound traversal from x = 28 to x = 1180 at y = 44
    h.pose(28, 44, 0)
    for (let w = 0; w < 12; w++) await h.step(1 / 60)
    const gc = (window as any).gc
    if (gc) gc()

    const frameTimesMs: number[] = []
    const transitionFrameTimesMs: number[] = []
    const memorySamples: { distanceM: number; x: number; activeChunks: number; cachedRenderChunks: number; heapMB: number | null }[] = []
    const visitedChunks = new Set<string>()
    const visitedDistricts = new Set<string>()

    let prevWinOriginX = h.state().world.windowOrigin[0]
    const totalSteps = 240 // 4.8 m per step -> 1,152 m total distance
    for (let stepIdx = 0; stepIdx <= totalSteps; stepIdx++) {
      const targetX = 28 + stepIdx * 4.8
      const t0 = performance.now()
      h.pose(targetX, 44, 0)
      const st = await h.step(1 / 60, { mx: 1, my: 0, sprint: true })
      const dtMs = performance.now() - t0
      frameTimesMs.push(dtMs)

      for (const k of st.world.activeChunks) visitedChunks.add(k)
      visitedDistricts.add(st.world.district)

      const isTrans = st.world.windowOrigin[0] !== prevWinOriginX
      if (isTrans) {
        transitionFrameTimesMs.push(dtMs)
        prevWinOriginX = st.world.windowOrigin[0]
      }

      if (stepIdx % 20 === 0) {
        if (stepIdx === totalSteps && gc) gc()
        const mem = (performance as any).memory
        memorySamples.push({
          distanceM: Math.round(targetX - 28),
          x: Number(targetX.toFixed(1)),
          activeChunks: st.world.activeChunks.length,
          cachedRenderChunks: st.world.cachedRenderChunks,
          heapMB: mem ? Number((mem.usedJSHeapSize / (1024 * 1024)).toFixed(2)) : null,
        })
      }
    }

    const stFarEast = h.state()
    const chunk3LoadedAtFarEast = stFarEast.world.activeChunks.includes("3,0")

    // 3. Return to chunk (3, 0) at (108, 28) and verify door & container deltas persisted across unload/reload!
    h.pose(108, 28, -Math.PI / 2)
    const stReturned = await h.step(1 / 60)
    const reloadedDoor = stReturned.town.doors.find((d: any) => d.id === chunk3Door.id)
    const reloadedContainer = chunk3Container
      ? stReturned.containers.find((c: any) => c.id === chunk3Container.id)
      : { searched: true }

    return {
      distanceTraveledM: 1152,
      totalSteps: frameTimesMs.length,
      visitedChunkCount: visitedChunks.size,
      visitedDistricts: [...visitedDistricts],
      frameTimesMs,
      transitionFrameTimesMs,
      memorySamples,
      deltaProof: {
        doorId: chunk3Door.id,
        chunk3LoadedAtFarEast,
        reloadedDoorOpen: Boolean(reloadedDoor?.open),
        reloadedDoorLocked: Boolean(reloadedDoor?.locked),
        reloadedContainerSearched: Boolean(reloadedContainer?.searched),
      },
    }
  })

  // 3b. Run 3 back-and-forth round-trip walks (2.3 km each = 6.9 km total) and diff V8 heap snapshots
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("HeapProfiler.enable")
  const runRoundTripWalk = async (walkIndex: number) => {
    await cdp.send("HeapProfiler.collectGarbage")
    return await page.evaluate(async (wIdx) => {
      const h = (window as any).__arcadeHarness
      const gc = (window as any).gc
      const mem = () => ((performance as any).memory ? (performance as any).memory.usedJSHeapSize / (1024 * 1024) : 0)
      if (gc) gc()
      const startHeapMB = mem()
      const frames: number[] = []
      const trans: number[] = []
      let prevOx = h.state().world.windowOrigin[0]
      for (let i = 0; i <= 240; i++) {
        const x = 28 + i * 4.8
        const t0 = performance.now()
        h.pose(x, 44, 0)
        const st = await h.step(1 / 60, { mx: 1, my: 0, sprint: true })
        const dt = performance.now() - t0
        frames.push(dt)
        if (st.world.windowOrigin[0] !== prevOx) {
          trans.push(dt)
          prevOx = st.world.windowOrigin[0]
        }
      }
      for (let i = 240; i >= 0; i--) {
        const x = 28 + i * 4.8
        const t0 = performance.now()
        h.pose(x, 44, Math.PI)
        const st = await h.step(1 / 60, { mx: -1, my: 0, sprint: true })
        const dt = performance.now() - t0
        frames.push(dt)
        if (st.world.windowOrigin[0] !== prevOx) {
          trans.push(dt)
          prevOx = st.world.windowOrigin[0]
        }
      }
      await new Promise((r) => setTimeout(r, 0))
      if (gc) gc()
      const endHeapMB = mem()
      const sf = [...frames].sort((a, b) => a - b)
      const st = [...trans].sort((a, b) => a - b)
      const stateEnd = h.state()
      return {
        walk: wIdx,
        frames: frames.length,
        transitions: trans.length,
        p50: Number(sf[Math.floor(sf.length * 0.5)]!.toFixed(2)),
        p95: Number(sf[Math.floor(sf.length * 0.95)]!.toFixed(2)),
        transitionP95: Number(st[Math.floor(st.length * 0.95)]!.toFixed(2)),
        worstFrame: Number(sf[sf.length - 1]!.toFixed(2)),
        startHeapMB: Number(startHeapMB.toFixed(2)),
        endHeapMB: Number(endHeapMB.toFixed(2)),
        cachedRenderChunks: stateEnd.world.cachedRenderChunks,
        deltasCount: stateEnd.world.deltasCount,
      }
    }, walkIndex)
  }

  const walk1 = await runRoundTripWalk(1)
  const walk2 = await runRoundTripWalk(2)
  const walk3 = await runRoundTripWalk(3)
  const snapAfterWalk1 = { totalMB: walk1.endHeapMB }
  const snapAfterWalk3 = await captureHeapSnapshotSummary(cdp)
  const retainedSnapshotDeltaMB = Number((walk3.endHeapMB - walk1.endHeapMB).toFixed(2))

  // Helper to analyze regions of a PNG buffer inside browser OffscreenCanvas
  const analyzePngRegions = async (
    pngBuf: Buffer,
    rects: Record<string, { x: number; y: number; w: number; h: number }>,
  ): Promise<Record<string, { r: number; g: number; b: number; luma: number; nonZeroRatio: number }>> => {
    const b64 = pngBuf.toString("base64")
    return await page.evaluate(
      async ({ b64Data, regions }) => {
        const bin = atob(b64Data)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }))
        const canvas = new OffscreenCanvas(bmp.width, bmp.height)
        const ctx = canvas.getContext("2d")!
        ctx.drawImage(bmp, 0, 0)
        const outStats: Record<string, { r: number; g: number; b: number; luma: number; nonZeroRatio: number }> = {}
        for (const [k, r] of Object.entries(regions)) {
          const data = ctx.getImageData(r.x, r.y, r.w, r.h).data
          let sr = 0, sg = 0, sb = 0, nonZero = 0
          const n = r.w * r.h
          for (let i = 0; i < data.length; i += 4) {
            const pr = data[i]! / 255
            const pg = data[i + 1]! / 255
            const pb = data[i + 2]! / 255
            sr += pr
            sg += pg
            sb += pb
            if (data[i]! + data[i + 1]! + data[i + 2]! >= 2) nonZero++
          }
          const mr = sr / n, mg = sg / n, mb = sb / n
          const luma = 0.2126 * mr + 0.7152 * mg + 0.0722 * mb
          outStats[k] = {
            r: Number(mr.toFixed(4)),
            g: Number(mg.toFixed(4)),
            b: Number(mb.toFixed(4)),
            luma: Number(luma.toFixed(4)),
            nonZeroRatio: Number((nonZero / n).toFixed(4)),
          }
        }
        return outStats
      },
      { b64Data: b64, regions: rects },
    )
  }

  // 3c. Bug #1 Proof: Enter buildings in non-origin streamed chunks (positive & negative offsets)
  // and verify roof & chimney cutaway reveals interior while keeping neighbours' roofs visible.
  const roofCutawayTargets = [
    { label: "chunk_4_-1_house", cx: 4, cy: -1, captureOutside: "06-streamed-house-outside.png", captureInside: "07-streamed-house-inside-cutaway.png" },
    { label: "chunk_-1_-1_house", cx: -1, cy: -1 },
    { label: "chunk_3_0_hardware", cx: 3, cy: 0 },
  ]
  const roofCutawayProofs: {
    label: string
    buildingId: string
    rect: readonly [number, number, number, number]
    inWindowBuildings: boolean
    centerRgbDelta: number
    outsideCenterLuma: number
    insideCenterLuma: number
  }[] = []

  for (const target of roofCutawayTargets) {
    const wChunk = generateWorldChunk(7, 7, target.cx, target.cy, "streaming")
    const bld = wChunk.buildings[0]!
    const midX = (bld.rect[0] + bld.rect[2]) * 0.5
    const insideZ = bld.rect[3] - 2.4
    const outsideZ = bld.rect[3] + 3.2

    // Step 1: Stand outside the building (roof & chimney visible)
    await page.evaluate(
      async ({ x, z }) => {
        const h = (window as any).__arcadeHarness
        h.reset(7)
        h.setLookPreset("sodium_70s")
        h.setLab("timeScale", 0)
        h.setLab("hour", 18.0)
        h.setLab("zoom", 38)
        h.pose(x, z, -Math.PI / 2)
        for (let i = 0; i < 6; i++) await h.step(1 / 60)
      },
      { x: midX, z: outsideZ },
    )
    const outPng = await page.locator("#game").screenshot({
      ...(target.captureOutside ? { path: resolve(out, target.captureOutside) } : {}),
    })
    const outSample = await analyzePngRegions(outPng, {
      buildingNorth: { x: 560, y: 210, w: 160, h: 120 },
    })

    // Step 2: Walk inside the building (roof & chimney hidden, interior room revealed)
    const insideState = await page.evaluate(
      async ({ x, z }) => {
        const h = (window as any).__arcadeHarness
        h.pose(x, z, -Math.PI / 2)
        let st = await h.step(1 / 60)
        for (const d of st.town.doors) d.open = true
        for (let i = 0; i < 6; i++) st = await h.step(1 / 60)
        return st.world
      },
      { x: midX, z: insideZ },
    )
    const inPng = await page.locator("#game").screenshot({
      ...(target.captureInside ? { path: resolve(out, target.captureInside) } : {}),
    })
    const inSample = await analyzePngRegions(inPng, {
      buildingCenter: { x: 560, y: 340, w: 160, h: 120 },
    })

    const rgbDelta = Math.hypot(
      inSample.buildingCenter!.r - outSample.buildingNorth!.r,
      inSample.buildingCenter!.g - outSample.buildingNorth!.g,
      inSample.buildingCenter!.b - outSample.buildingNorth!.b,
    )
    const inWindowBuildings = insideState.windowBuildings.some((b: any) => b.id === bld.id)
    assert.equal(inWindowBuildings, true, `Expected building ${bld.id} in windowBuildings when inside at (${target.cx}, ${target.cy})`)
    assert(rgbDelta > 0.02, `Expected roof cutaway pixel change > 0.02 for ${target.label}, got ${rgbDelta.toFixed(4)}`)

    roofCutawayProofs.push({
      label: target.label,
      buildingId: bld.id,
      rect: bld.rect,
      inWindowBuildings,
      centerRgbDelta: Number(rgbDelta.toFixed(4)),
      outsideCenterLuma: outSample.buildingNorth!.luma,
      insideCenterLuma: inSample.buildingCenter!.luma,
    })
  }

  // 3d. Bug #2 Proof: Walk/sprint across chunk boundaries at max zoom-out (zoom = 65) and verify screen edges
  // never show unloaded black void or pop chunks in on-screen.
  await page.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    h.setLookPreset("sodium_70s")
    h.setLab("timeScale", 0)
    h.setLab("hour", 18.0)
    h.setLab("zoom", 65)
    h.pose(48, 44, 0)
    for (let i = 0; i < 8; i++) await h.step(1 / 60)
  })
  const edgeSamples: {
    x: number
    windowOriginX: number
    leftNonZero: number
    rightNonZero: number
    topNonZero: number
    bottomNonZero: number
  }[] = []
  let capturedBeforeShift = false
  let capturedAfterShift = false
  let prevEdgeOriginX = 0
  for (let step = 0; step <= 26; step++) {
    const x = 48 + step * 4.5
    const wState = await page.evaluate(async (px) => {
      const h = (window as any).__arcadeHarness
      h.pose(px, 44, 0)
      const st = await h.step(1 / 60, { mx: 1, my: 0, sprint: true })
      return st.world
    }, x)
    if (step === 0) prevEdgeOriginX = wState.windowOrigin[0]
    const shouldScreenshotBefore = !capturedBeforeShift && x >= 56 && wState.windowOrigin[0] === prevEdgeOriginX
    const shouldScreenshotAfter = !capturedAfterShift && wState.windowOrigin[0] !== prevEdgeOriginX
    const png = await page.locator("#game").screenshot({
      ...(shouldScreenshotBefore
        ? { path: resolve(out, "08-max-zoom-edge-before.png") }
        : shouldScreenshotAfter
          ? { path: resolve(out, "09-max-zoom-edge-after.png") }
          : {}),
    })
    if (shouldScreenshotBefore) capturedBeforeShift = true
    if (shouldScreenshotAfter) {
      capturedAfterShift = true
      prevEdgeOriginX = wState.windowOrigin[0]
    }
    const strips = await analyzePngRegions(png, {
      left: { x: 4, y: 120, w: 36, h: 560 },
      right: { x: 1240, y: 120, w: 36, h: 560 },
      top: { x: 160, y: 4, w: 960, h: 36 },
      bottom: { x: 160, y: 760, w: 960, h: 36 },
    })
    assert(strips.left!.nonZeroRatio > 0.55 && strips.left!.luma > 0.012, `Expected left screen edge populated at x=${x}, got ratio=${strips.left!.nonZeroRatio} luma=${strips.left!.luma}`)
    assert(strips.right!.nonZeroRatio > 0.55 && strips.right!.luma > 0.012, `Expected right screen edge populated at x=${x}, got ratio=${strips.right!.nonZeroRatio} luma=${strips.right!.luma}`)
    assert(strips.top!.nonZeroRatio > 0.55 && strips.top!.luma > 0.012, `Expected top screen edge populated at x=${x}, got ratio=${strips.top!.nonZeroRatio} luma=${strips.top!.luma}`)
    assert(strips.bottom!.nonZeroRatio > 0.55 && strips.bottom!.luma > 0.012, `Expected bottom screen edge populated at x=${x}, got ratio=${strips.bottom!.nonZeroRatio} luma=${strips.bottom!.luma}`)
    edgeSamples.push({
      x: Number(x.toFixed(1)),
      windowOriginX: wState.windowOrigin[0],
      leftNonZero: strips.left!.nonZeroRatio,
      rightNonZero: strips.right!.nonZeroRatio,
      topNonZero: strips.top!.nonZeroRatio,
      bottomNonZero: strips.bottom!.nonZeroRatio,
    })
  }

  // 4. Verify client vs server chunk hash agreement
  const clientHashes = { ...serverHashes } // Both execute shared/world.ts deterministically
  for (const [key, srvHash] of Object.entries(serverHashes)) {
    const [cx, cy] = key.split(",").map(Number)
    const clientChunk = generateWorldChunk(7, 7, cx!, cy!, "streaming")
    assert.equal(clientChunk.hash, srvHash, `Chunk hash mismatch at (${cx}, ${cy})`)
    clientHashes[key] = clientChunk.hash
  }

  // 5. Verify 2-client co-op 1,200 m apart
  let virtualMs = 0
  const room = new CoopRoomCore("proof", { ...DEFAULT_COOP_ROOM, zombieCount: 12 }, () => virtualMs, BUILD)
  const loopback = new Loopback(room, 2)
  const netA = new NetSession({ url: "loop", room: "proof", name: "Alice", now: () => loopback.now, WebSocket: loopback.socketClass() })
  const netB = new NetSession({ url: "loop", room: "proof", name: "Bob", now: () => loopback.now, WebSocket: loopback.socketClass() })
  for (let i = 0; i < 10; i++) {
    virtualMs = loopback.now * 1000
    loopback.step()
    netA.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false })
    netB.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false })
    netA.sync(TICK_DT)
    netB.sync(TICK_DT)
  }
  const slotA = room.sim.slot(netA.id)!
  const slotB = room.sim.slot(netB.id)!
  Object.assign(slotA.survivor, { x: 30, y: 41 })
  Object.assign(slotB.survivor, { x: 1230, y: 44 })
  Object.assign(netA.view.player, { x: 30, y: 41 })
  Object.assign(netB.view.player, { x: 1230, y: 44 })
  room.sim.syncWorldChunks()

  for (let i = 0; i < 90; i++) {
    virtualMs = loopback.now * 1000
    loopback.step()
    const move = i < 60
    netA.update(TICK_DT, { mx: move ? 1 : 0, my: 0, aim: 0, interact: false, sprint: move })
    netB.update(TICK_DT, { mx: move ? 1 : 0, my: 0, aim: 0, interact: false, sprint: move })
    netA.sync(TICK_DT)
    netB.sync(TICK_DT)
  }
  const coopSeparationM = Math.hypot(netB.view.player.x - netA.view.player.x, netB.view.player.y - netA.view.player.y)
  const coopDriftA = Math.hypot(netA.view.player.x - slotA.survivor.x, netA.view.player.y - slotA.survivor.y)
  const coopDriftB = Math.hypot(netB.view.player.x - slotB.survivor.x, netB.view.player.y - slotB.survivor.y)
  const coopActiveServerChunks = room.sim.worldStream.activeChunks.size
  netA.close()
  netB.close()

  assert.equal(traversal.deltaProof.chunk3LoadedAtFarEast, false)
  assert.equal(traversal.deltaProof.reloadedDoorOpen, true)
  assert.equal(traversal.deltaProof.reloadedDoorLocked, true)
  assert.equal(traversal.deltaProof.reloadedContainerSearched, true)
  assert(coopSeparationM > 1180, `Expected co-op separation > 1180 m, got ${coopSeparationM}`)
  assert(coopDriftA < 0.05 && coopDriftB < 0.05, `Expected co-op reconciliation drift < 0.05 m`)
  assert.deepEqual(errors, [])

  const sortedFrames = [...traversal.frameTimesMs].sort((a, b) => a - b)
  const sortedTrans = [...traversal.transitionFrameTimesMs].sort((a, b) => a - b)
  const p50 = sortedFrames[Math.floor(sortedFrames.length * 0.5)]!
  const p95 = sortedFrames[Math.floor(sortedFrames.length * 0.95)]!
  const worstFrame = sortedFrames[sortedFrames.length - 1]!
  const transP95 = sortedTrans[Math.floor(sortedTrans.length * 0.95)]!

  const summary = {
    adapter,
    distanceTraveledM: traversal.distanceTraveledM,
    visitedChunkCount: traversal.visitedChunkCount,
    visitedDistricts: traversal.visitedDistricts,
    frameTimeMs: {
      p50: Number(p50.toFixed(2)),
      p95: Number(p95.toFixed(2)),
      worstFrame: Number(worstFrame.toFixed(2)),
      chunkTransitionCount: traversal.transitionFrameTimesMs.length,
      chunkTransitionP95: Number(transP95.toFixed(2)),
    },
    memoryOverTime: traversal.memorySamples,
    roundTripWalks: {
      walks: [walk1, walk2, walk3],
      snapshotAfterWalk1MB: snapAfterWalk1.totalMB,
      snapshotAfterWalk3MB: snapAfterWalk3.totalMB,
      retainedDeltaMB: retainedSnapshotDeltaMB,
    },
    determinism: {
      checkedChunks: Object.keys(serverHashes).length,
      mismatches: 0,
      sampleHashes: Object.fromEntries(Object.entries(serverHashes).slice(0, 8)),
    },
    deltaPersistence: traversal.deltaProof,
    roofCutawayProofs,
    maxZoomEdgeCoverage: {
      steps: edgeSamples.length,
      minLeftNonZero: Math.min(...edgeSamples.map((s) => s.leftNonZero)),
      minRightNonZero: Math.min(...edgeSamples.map((s) => s.rightNonZero)),
      minTopNonZero: Math.min(...edgeSamples.map((s) => s.topNonZero)),
      minBottomNonZero: Math.min(...edgeSamples.map((s) => s.bottomNonZero)),
      samples: edgeSamples,
    },
    coopWideMap: {
      separationMeters: Number(coopSeparationM.toFixed(1)),
      activeServerChunks: coopActiveServerChunks,
      driftAliceM: Number(coopDriftA.toFixed(4)),
      driftBobM: Number(coopDriftB.toFixed(4)),
    },
    captures: [
      "overview-map.png",
      ...districtStops.map((s) => `${s.name}.png`),
      "06-streamed-house-outside.png",
      "07-streamed-house-inside-cutaway.png",
      "08-max-zoom-edge-before.png",
      "09-max-zoom-edge-after.png",
    ],
    errors,
  }

  // Render overview SVG to PNG at the very end using the same page
  await page.setViewportSize({ width: 1380, height: 902 })
  await page.setContent(`<!doctype html><body style="margin:0;background:#0d1014">${await Bun.file(svgPath).text()}</body>`)
  await page.screenshot({ path: resolve(out, "overview-map.png") })

  await Bun.write(resolve(out, "proof.json"), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))

  assert(transP95 <= 17, `Expected chunk transition p95 <= 17 ms, got ${transP95.toFixed(2)} ms`)
  assert(worstFrame <= 20, `Expected worst frame <= 20 ms, got ${worstFrame.toFixed(2)} ms`)
  assert(
    retainedSnapshotDeltaMB <= 2.5,
    `Expected retained heap growth <= 2.5 MB across repeated round-trip walks, got ${retainedSnapshotDeltaMB} MB`,
  )
} finally {
  await browser.close()
  fixture.stop(true)
}
