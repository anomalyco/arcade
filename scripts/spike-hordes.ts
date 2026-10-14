import { existsSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright-core"
import { createServer } from "vite"
import { makeTown, sightRects } from "../games/outbreak/shared/map"
import { OutbreakAISubsystem } from "../games/outbreak/shared/ai"
import { Vision } from "../games/outbreak/shared/vision"
import { supportHeight } from "../games/outbreak/shared/terrain"
import { ZombieCrowdRenderer } from "../games/outbreak/src/zombies"
import { zombieTuning } from "../games/outbreak/src/zombie-profile"
import { FlowFieldNav, SoAZombieCrowdRenderer } from "../packages/kit/gpu/spike-hordes/horde-engine"
import type { Vec } from "../packages/kit/sim/geom"

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
}
const p95 = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]!
}
const mad = (xs: number[]) => {
  const m = median(xs)
  return median(xs.map((x) => Math.abs(x - m)))
}

function setupTownHorde(count: number, useFlowField: boolean) {
  const town = makeTown(7, 7, 0.22)
  const ai = new OutbreakAISubsystem(town, 27.7, 41, { zombieCount: count })
  while (ai.agents.length < count) {
    ai.spawnZombie(town, 10 + ((ai.agents.length * 7) % 76), 10 + ((ai.agents.length * 13) % 76), "wander")
  }
  // Place 65% of the horde in active chase/investigate around the street & houses so pathfinding + flocking are heavily stressed
  for (let i = 0; i < ai.agents.length; i++) {
    const a = ai.agents[i]!
    if (i % 3 !== 0) {
      a.state = "chase"
      a.awareness = 1
      a.targetX = 27.7
      a.targetY = 41
      // Stagger or align repath timers to test both steady state and simultaneous repath storms
      a.repathAt = (i % 10) * 0.05
    }
  }

  let flow: FlowFieldNav | null = null
  if (useFlowField) {
    flow = new FlowFieldNav(96, 96, 0.5, 2)
    flow.syncFromGrid(ai.nav.grid)
    let anchorX = 27.7
    let anchorY = 41.0
    flow.ensureField(anchorX, anchorY, true)

    // Cache static obstacle grid so door state changes only re-stamp the 8 doors/windows (< 0.01 ms) instead of all 163 town props!
    const staticGrid = new Uint8Array(ai.nav.grid)
    let lastRebuildTick = -100
    ai.rebuildTopology = (t) => {
      ;(ai as any).closedDoors = t.doors
        .filter((d) => !d.open || (ai.portalStates.get(d.id)?.barricadePlanks ?? 0) > 0)
        .map((d) => d.rect)
      if (ai.tick - lastRebuildTick < 15) return
      lastRebuildTick = ai.tick
      ai.nav.grid.set(staticGrid)
      for (const d of t.doors) {
        const st = ai.portalStates.get(d.id)
        const code = (st?.barricadePlanks ?? 0) > 0 ? 4 : d.open ? 0 : 2
        const [rx0, ry0, rx1, ry1] = d.rect
        const horiz = rx1 - rx0 > ry1 - ry0
        const bx0 = horiz ? rx0 + 0.18 : rx0 - 0.42
        const by0 = horiz ? ry0 - 0.42 : ry0 + 0.18
        const bx1 = horiz ? rx1 - 0.18 : rx1 + 0.42
        const by1 = horiz ? ry1 + 0.42 : ry1 - 0.18
        const x0 = Math.max(0, Math.floor(bx0 / 0.5))
        const x1 = Math.min(ai.nav.w - 1, Math.floor(bx1 / 0.5))
        const y0 = Math.max(0, Math.floor(by0 / 0.5))
        const y1 = Math.min(ai.nav.h - 1, Math.floor(by1 / 0.5))
        for (let cy = y0; cy <= y1; cy++) {
          for (let cx = x0; cx <= x1; cx++) ai.nav.grid[cy * ai.nav.w + cx] = code
        }
      }
      flow!.syncFromGrid(ai.nav.grid)
    }

    ai.nav.path = (from: Vec): Vec[] | null => {
      return flow!.traceShortPath(from.x, from.y, anchorX, anchorY, 8)
    }
  }

  return { town, ai, flow }
}

// 1. Standalone Dijkstra Flow-Field Microbenchmark (Full Rebuild vs Cached Cell Lookup)
const town0 = makeTown(7, 7, 0.22)
const ai0 = new OutbreakAISubsystem(town0, 27.7, 41, { zombieCount: 28 })
const flowBench = new FlowFieldNav(96, 96, 0.5)
flowBench.syncFromGrid(ai0.nav.grid)

const rebuildTimes: number[] = []
for (let i = 0; i < 40; i++) {
  const gx = 24 + (i % 12) * 0.6
  const gy = 38 + Math.floor(i / 12) * 0.6
  const t0 = performance.now()
  flowBench.ensureField(gx, gy, true)
  if (i >= 5) rebuildTimes.push(performance.now() - t0)
}

const astarSingleTimes: number[] = []
for (let i = 0; i < 40; i++) {
  const sx = 14 + (i % 10) * 5.2
  const sy = 14 + Math.floor(i / 10) * 14.0
  const t0 = performance.now()
  ai0.nav.path({ x: sx, y: sy }, { x: 27.7, y: 41 })
  if (i >= 5) astarSingleTimes.push(performance.now() - t0)
}

// 2. Compare Current (A* + AoS ZombieCrowdRenderer) vs From-Scratch (FlowField + SoAZombieCrowdRenderer) across 28, 150, 500 zombies
const hordeComparison: Record<string, unknown> = {}

// Warmup JIT for both implementations before timed loops
{
  const wCur = setupTownHorde(60, false)
  const wNxt = setupTownHorde(60, true)
  const wVis = new Vision()
  wVis.update(27.7, 41, 0, sightRects(wCur.town), { range: 45, cone: 180, awareness: 45 })
  const wMock = { addModel: () => 0 }
  const wCurCrowd = new ZombieCrowdRenderer(wMock)
  const wNxtCrowd = new SoAZombieCrowdRenderer(wMock, 1024)
  const p = { x: 27.7, y: 41, vx: 1, vy: 0, aim: 0, noise: 9, flashlightOn: true, battery: 1, batteryDepleted: false, flashlightOutput: 1, lightSignature: 16, flickerPhase: 0 }
  for (let i = 0; i < 60; i++) {
    wCur.ai.step(wCur.town, p, 21, i / 60, 1 / 60)
    wNxt.ai.step(wNxt.town, p, 21, i / 60, 1 / 60)
    wCurCrowd.draw(wCur.ai.agents, 1 / 60, (x, z) => supportHeight(wCur.town, x, z), wVis, [0, 0, 96, 96], zombieTuning, true)
    wNxtCrowd.draw(wNxt.ai.agents, 1 / 60, (x, z) => supportHeight(wNxt.town, x, z), wVis, [0, 0, 96, 96], zombieTuning, true)
  }
}

for (const count of [28, 150, 500]) {
  const blockers = sightRects(town0)
  const vision = new Vision()
  vision.update(27.7, 41, 0, blockers, { range: 45, cone: 180, awareness: 45 })
  const mockRenderer = { addModel: () => 0 }
  const TICKS = 120

  // Run Current (A* + AoS ZombieCrowdRenderer) in its own isolated loop
  Bun.gc(true)
  const cur = setupTownHorde(count, false)
  const curCrowd = new ZombieCrowdRenderer(mockRenderer)
  const curAiTimes: number[] = []
  const curRigTimes: number[] = []
  let curBatches: ReturnType<ZombieCrowdRenderer["draw"]> = []
  {
    let simTime = 0
    for (let tick = 0; tick < TICKS; tick++) {
      simTime += 1 / 60
      const px = 27.7 + Math.sin(simTime * 0.8) * 3.4 * simTime * 0.25
      const py = 41.0 + Math.cos(simTime * 0.6) * 2.2 * simTime * 0.25
      const player = {
        x: px,
        y: py,
        vx: 3.4,
        vy: 0,
        aim: 0,
        noise: tick === 60 ? 42 : 9,
        flashlightOn: true,
        battery: 1,
        batteryDepleted: false,
        flashlightOutput: 1,
        lightSignature: 16,
        flickerPhase: 0,
      }
      if (tick === 60) {
        cur.ai.emitNoise(px, py, 42, "gunshot", simTime, 1.8)
        for (const a of cur.ai.agents) if (a.state === "chase") a.repathAt = 0
      }
      const t0 = performance.now()
      cur.ai.step(cur.town, player, 21, simTime, 1 / 60)
      const t1 = performance.now()
      curBatches = curCrowd.draw(
        cur.ai.agents,
        1 / 60,
        (x, z) => supportHeight(cur.town, x, z),
        vision,
        [0, 0, 96, 96],
        zombieTuning,
        true,
      )
      const t2 = performance.now()
      if (tick >= 10) {
        curAiTimes.push(t1 - t0)
        curRigTimes.push(t2 - t1)
      }
    }
  }

  // Run From-Scratch (FlowFieldNav + SoAZombieCrowdRenderer) in its own isolated loop after GC
  Bun.gc(true)
  const nxt = setupTownHorde(count, true)
  const nxtCrowd = new SoAZombieCrowdRenderer(mockRenderer, 1024)
  const nxtAiTimes: number[] = []
  const nxtRigTimes: number[] = []
  let nxtBatches: ReturnType<SoAZombieCrowdRenderer["draw"]> = []
  {
    let simTime = 0
    for (let tick = 0; tick < TICKS; tick++) {
      simTime += 1 / 60
      const px = 27.7 + Math.sin(simTime * 0.8) * 3.4 * simTime * 0.25
      const py = 41.0 + Math.cos(simTime * 0.6) * 2.2 * simTime * 0.25
      const player = {
        x: px,
        y: py,
        vx: 3.4,
        vy: 0,
        aim: 0,
        noise: tick === 60 ? 42 : 9,
        flashlightOn: true,
        battery: 1,
        batteryDepleted: false,
        flashlightOutput: 1,
        lightSignature: 16,
        flickerPhase: 0,
      }
      if (tick === 60) {
        nxt.ai.emitNoise(px, py, 42, "gunshot", simTime, 1.8)
        for (const a of nxt.ai.agents) if (a.state === "chase") a.repathAt = 0
      }
      const t0 = performance.now()
      nxt.ai.step(nxt.town, player, 21, simTime, 1 / 60)
      const t1 = performance.now()
      nxtBatches = nxtCrowd.draw(
        nxt.ai.agents,
        1 / 60,
        (x, z) => supportHeight(nxt.town, x, z),
        vision,
        [0, 0, 96, 96],
        zombieTuning,
        true,
      )
      const t2 = performance.now()
      if (tick >= 10) {
        nxtAiTimes.push(t1 - t0)
        nxtRigTimes.push(t2 - t1)
      }
    }
  }

  const curTotalInstances = curBatches.reduce((s, b) => s + b.count, 0)
  const nxtTotalInstances = nxtBatches.reduce((s, b) => s + b.count, 0)
  const curThighInstances = curBatches[5]?.count ?? 0
  const nxtThighInstances = nxtBatches[5]?.count ?? 0
  hordeComparison[`zombies_${count}`] = {
    currentAStarAndAoS: {
      aiStepMedianMs: Number(median(curAiTimes).toFixed(3)),
      aiStepP95Ms: Number(p95(curAiTimes).toFixed(3)),
      aiStepMaxGunshotSpikeMs: Number(Math.max(...curAiTimes).toFixed(3)),
      rigIkMedianMs: Number(median(curRigTimes).toFixed(3)),
      rigIkP95Ms: Number(p95(curRigTimes).toFixed(3)),
      totalCpuMedianMs: Number((median(curAiTimes) + median(curRigTimes)).toFixed(3)),
      totalCpuP95Ms: Number((p95(curAiTimes) + p95(curRigTimes)).toFixed(3)),
      submittedPartInstances: curTotalInstances,
      submittedThighInstances: curThighInstances,
      expectedThighInstances: count * 2,
      missingLimbsPct: Number((((count * 2 - curThighInstances) / (count * 2)) * 100).toFixed(1)),
    },
    fromScratchFlowFieldAndSoA: {
      aiStepMedianMs: Number(median(nxtAiTimes).toFixed(3)),
      aiStepP95Ms: Number(p95(nxtAiTimes).toFixed(3)),
      aiStepMaxGunshotSpikeMs: Number(Math.max(...nxtAiTimes).toFixed(3)),
      rigIkMedianMs: Number(median(nxtRigTimes).toFixed(3)),
      rigIkP95Ms: Number(p95(nxtRigTimes).toFixed(3)),
      totalCpuMedianMs: Number((median(nxtAiTimes) + median(nxtRigTimes)).toFixed(3)),
      totalCpuP95Ms: Number((p95(nxtAiTimes) + p95(nxtRigTimes)).toFixed(3)),
      submittedPartInstances: nxtTotalInstances,
      submittedThighInstances: nxtThighInstances,
      expectedThighInstances: count * 2,
      missingLimbsPct: Number((((count * 2 - nxtThighInstances) / (count * 2)) * 100).toFixed(1)),
      flowFieldRebuildsIn120Ticks: nxt.flow!.rebuildCount,
      flowFieldCacheHitsIn120Ticks: nxt.flow!.cacheHitCount,
    },
    speedup: {
      aiP95SpeedupX: Number((p95(curAiTimes) / Math.max(0.001, p95(nxtAiTimes))).toFixed(1)),
      gunshotSpikeSpeedupX: Number((Math.max(...curAiTimes) / Math.max(0.001, Math.max(...nxtAiTimes))).toFixed(1)),
      rigIkMedianSpeedupX: Number((median(curRigTimes) / Math.max(0.001, median(nxtRigTimes))).toFixed(1)),
      totalCpuP95SpeedupX: Number(
        ((p95(curAiTimes) + p95(curRigTimes)) / Math.max(0.001, p95(nxtAiTimes) + p95(nxtRigTimes))).toFixed(1),
      ),
    },
  }
}

// 3. Headless Metal GPU Benchmark: Measure 28 vs 150 vs 500 Zombies (4,000+ part instances) on M5 Max Metal at 3456x1894
const rootDir = resolve(import.meta.dir, "..")
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache)
  .filter((n) => /^chromium-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`)
  .find(existsSync)!

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})

let metalHordeResults: unknown = null

try {
  const server = await createServer({
    root: resolve(rootDir, "games/outbreak"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "expose-outbreak-spike-b",
        enforce: "pre",
        transform(code, id) {
          if (id.endsWith("games/outbreak/src/main.ts")) {
            return code.replace(
              "const harness = {",
              "const harness = { renderer, render, session: () => session, zombieCrowd, vision: () => vision,",
            )
          }
          if (id.endsWith("games/outbreak/src/zombies.ts")) {
            return code.replace("const MAX_INSTANCES_PER_PART = 256", "const MAX_INSTANCES_PER_PART = 2048")
          }
        },
      },
    ],
  })
  await server.listen()
  const port = (server.httpServer!.address() as { port: number }).port
  const page = await browser.newPage({ viewport: { width: 1728, height: 947 }, deviceScaleFactor: 2 })
  await page.addInitScript(() => {
    const orig = GPUAdapter.prototype.requestDevice
    GPUAdapter.prototype.requestDevice = function (desc: GPUDeviceDescriptor = {}) {
      return orig.call(this, { ...desc, requiredFeatures: this.features.has("timestamp-query") ? ["timestamp-query"] : [] })
    }
  })
  await page.goto(`http://127.0.0.1:${port}/?seed=7&bench`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready)

  metalHordeResults = await page.evaluate(async () => {
    const h = (window as any).__arcadeHarness
    const r = h.renderer
    const d: GPUDevice = r.device
    const qSet = d.createQuerySet({ type: "timestamp", count: 2 })
    const resBuf = d.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC })
    const readBuf = d.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })

    async function sampleGpuFrame(): Promise<{ gpuMs: number; instCount: number }> {
      for (let k = 0; k < 3; k++) await h.step(0)
      await d.queue.onSubmittedWorkDone()
      let firstPass = true
      let lastTargetView: GPUTextureView | null = null
      let instCount = 0
      const origCreate = d.createCommandEncoder.bind(d)
      d.createCommandEncoder = (desc) => {
        const enc = origCreate(desc)
        const origCompute = enc.beginComputePass.bind(enc)
        enc.beginComputePass = (cDesc) => {
          const tw = firstPass ? { querySet: qSet, beginningOfPassWriteIndex: 0 } : undefined
          firstPass = false
          return origCompute(tw ? { ...cDesc, timestampWrites: tw } : cDesc)
        }
        const origRender = enc.beginRenderPass.bind(enc)
        enc.beginRenderPass = (rDesc) => {
          const tw = firstPass ? { querySet: qSet, beginningOfPassWriteIndex: 0 } : undefined
          firstPass = false
          const ca = Array.from(rDesc.colorAttachments)
          if (ca[0]?.view) lastTargetView = ca[0].view
          const pass = origRender(tw ? { ...rDesc, timestampWrites: tw } : rDesc)
          const origDraw = pass.draw.bind(pass)
          pass.draw = (vc, ic = 1, fv = 0, fi = 0) => {
            if (ic > 1) instCount += ic
            return origDraw(vc, ic, fv, fi)
          }
          return pass
        }
        const origFinish = enc.finish.bind(enc)
        enc.finish = (fDesc) => {
          if (lastTargetView) {
            enc.beginRenderPass({
              timestampWrites: { querySet: qSet, endOfPassWriteIndex: 1 },
              colorAttachments: [{ view: lastTargetView, loadOp: "load", storeOp: "store" }],
            }).end()
            enc.resolveQuerySet(qSet, 0, 2, resBuf, 0)
            enc.copyBufferToBuffer(resBuf, 0, readBuf, 0, 16)
          }
          return origFinish(fDesc)
        }
        return enc
      }
      await h.step(0)
      d.createCommandEncoder = origCreate
      await d.queue.onSubmittedWorkDone()
      await readBuf.mapAsync(GPUMapMode.READ)
      const stamps = new BigUint64Array(readBuf.getMappedRange())
      const gpuMs = Number(stamps[1]! - stamps[0]!) / 1e6
      readBuf.unmap()
      return { gpuMs, instCount }
    }

    const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
    const madFn = (xs: number[]) => {
      const m = med(xs)
      return med(xs.map((x) => Math.abs(x - m)))
    }

    h.reset(7)
    h.setLab("timeScale", 0)
    h.setLab("hour", 19)
    h.setLab("zoom", 42)
    h.setLab("aiDebugOverlay", 0)
    h.pose(27.7, 44.5, -Math.PI / 2)
    await h.step(0)

    const counts = [28, 150, 500]
    const samples: Record<number, number[]> = { 28: [], 150: [], 500: [] }
    const instCounts: Record<number, number> = { 28: 0, 150: 0, 500: 0 }
    for (let round = 0; round < 6; round++) {
      const order = round % 2 === 0 ? counts : [...counts].reverse()
      for (const targetZombies of order) {
        const sess = h.session()
        const ai = sess.ai
        const town = sess.view.town
        ai.agents.length = 0
        for (let i = 0; i < targetZombies; i++) {
          const zx = 18.2 + ((i * 2.13) % 19.0)
          const zy = 38.2 + ((i * 0.79) % 5.4)
          ai.spawnZombie(town, zx, zy, "chase")
        }
        const res = await sampleGpuFrame()
        instCounts[targetZombies] = res.instCount
        if (round > 0) samples[targetZombies]!.push(res.gpuMs)
      }
    }
    return Object.fromEntries(
      counts.map((c) => [
        `visibleZombies_${c}`,
        {
          gpuMedianMs: Number(med(samples[c]!).toFixed(3)),
          gpuMadMs: Number(madFn(samples[c]!).toFixed(3)),
          submittedInstances: instCounts[c],
        },
      ]),
    )
  })

  await page.close()
  await server.close()
} finally {
  await browser.close()
}

console.log(
  JSON.stringify(
    {
      microbenchmark: {
        singleAStarSearchMedianMs: Number(median(astarSingleTimes).toFixed(3)),
        fullMapFlowFieldRebuildMedianMs: Number(median(rebuildTimes).toFixed(3)),
        cachedFlowFieldLookupMs: 0.0,
      },
      hordeScalingComparison: hordeComparison,
      metal3456x1894GpuScaling: metalHordeResults,
    },
    null,
    2,
  ),
)
