// Room CPU per tick, snapshot field breakdown, client decode cost, latency, and reconciliation corrections:
// 1/2/4 survivors (in-process NetSession clients over a loopback with configurable latency, jitter, and packet loss)
// roaming and shooting among 60 / 300 / 1000 zombies, together or spread 1 km apart across streaming chunks.
//
// Usage:
//   bun scripts/coop-bench.ts [--zombies=60] [--players=4] [--seconds=60] [--spread=0|1] [--loss=0] [--latencyMs=50] [--jitterMs=16]
//   bun scripts/coop-bench.ts --horde=500 [--players=4]   a live horde of 500 closing on the squad (survivors kept alive)
//   bun scripts/coop-bench.ts --matrix=1 [--seconds=10]
import { CoopRoomCore } from "../server/room-core"
import { createAIAgent } from "../shared/ai"
import { BUILD } from "../shared/build.gen"
import { TICK_DT } from "../shared/clock"
import { DEFAULT_COOP_ROOM } from "../shared/coop-config"
import { addHorde, materializeHorde } from "../shared/hordes/index"
import { inspectSnapshotBreakdown } from "../shared/net-protocol"
import { outbreakClientFeatures as features } from "../src/features"
import { NetSession } from "../src/net-session"
import { Loopback } from "../tests/loopback"

const arg = (name: string, fallback: number) =>
  Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback)

export const SPREAD_OFFSETS: readonly (readonly [number, number])[] = [
  [0, 0],
  [960, 0],
  [0, 960],
  [960, 960],
]

export type ScenarioConfig = {
  players: number
  zombies: number
  spread: boolean
  lossRate: number
  latencyTicks: number
  jitterTicks: number
  seconds: number
  /** Members of a live horde staged 22 m from the squad and sent at it. */
  horde?: number
}

const pct = (sorted: number[], p: number): number =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]! : 0
const meanOf = (arr: number[]): number => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0)

export function runCoopBenchScenario(cfg: ScenarioConfig) {
  let virtualMs = 0
  const core = new CoopRoomCore("bench", { ...DEFAULT_COOP_ROOM, zombieCount: cfg.zombies }, () => virtualMs, BUILD)
  const decodeMs: number[] = []
  const corrections: { tick: number; mag: number }[] = []
  const ackLatenciesMs: number[] = []
  const snapLatenciesMs: number[] = []
  const sentAtByClient: Map<number, number>[] = Array.from({ length: cfg.players }, () => new Map())
  const breakdownSums = {
    total: 0,
    personalBytes: 0,
    headerBytes: 0,
    survivorsBytes: 0,
    zombiesBytes: 0,
    portalsBytes: 0,
    eventsBytes: 0,
    count: 0,
  }

  let clients: NetSession[] = []
  let measuring = false
  const net = new Loopback(core, cfg.latencyTicks, cfg.jitterTicks, cfg.lossRate, (cIdx, bytes, deliverFn) => {
    if (!measuring) {
      deliverFn()
      return
    }
    const c = clients[cIdx]!
    const p = c.local.survivor
    const bx = p.x
    const by = p.y
    const prevAck = c.lastAck
    const bd = inspectSnapshotBreakdown(bytes, c.snapHistory)
    breakdownSums.total += bd.total
    breakdownSums.personalBytes += bd.personalBytes
    breakdownSums.headerBytes += bd.headerBytes
    breakdownSums.survivorsBytes += bd.survivorsBytes
    breakdownSums.zombiesBytes += bd.zombiesBytes
    breakdownSums.portalsBytes += bd.portalsBytes
    breakdownSums.eventsBytes += bd.eventsBytes
    breakdownSums.count++

    const t0 = performance.now()
    deliverFn()
    decodeMs.push(performance.now() - t0)

    const corr = Math.hypot(p.x - bx, p.y - by)
    corrections.push({ tick: net.tick, mag: corr })

    if (c.lastAck > prevAck) {
      const sentMap = sentAtByClient[cIdx]!
      for (const [seq, tSent] of sentMap) {
        if (seq <= c.lastAck) {
          if (seq === c.lastAck) ackLatenciesMs.push((net.now - tSent) * 1000)
          sentMap.delete(seq)
        }
      }
    }
    const latestTick = c.snapshots.latest?.tick
    if (latestTick !== undefined) {
      snapLatenciesMs.push((net.now - latestTick * TICK_DT) * 1000)
    }
  })

  const memory = new Map<string, string>()
  const sockClass = net.socketClass()
  clients = Array.from(
    { length: cfg.players },
    (_, i) =>
      new NetSession({
        features,
        url: "loop",
        room: "bench",
        name: `Bench ${i + 1}`,
        storage: {
          getItem: (k) => memory.get(`${i}${k}`) ?? null,
          setItem: (k, v) => void memory.set(`${i}${k}`, v),
        },
        now: () => net.now,
        WebSocket: sockClass,
      }),
  )

  // Warmup connection handshake without loss so seats are established deterministically
  const savedLoss = net.lossRate
  net.lossRate = 0
  for (let i = 0; i < 18; i++) {
    virtualMs = net.now * 1000
    net.step()
  }

  if (cfg.spread) {
    const baseAgents = core.sim.ai.agents.slice()
    core.sim.slots.forEach((slot, i) => {
      const [ox, oy] = SPREAD_OFFSETS[i % SPREAD_OFFSETS.length]!
      slot.survivor.x = 27.7 + ox
      slot.survivor.y = 41.0 + oy
    })
    clients.forEach((c, i) => {
      const [ox, oy] = SPREAD_OFFSETS[i % SPREAD_OFFSETS.length]!
      c.local.survivor.x = 27.7 + ox
      c.local.survivor.y = 41.0 + oy
    })
    core.sim.syncWorldChunks()
    core.sim.rebuildCollision()
    core.sim.ai.agents.length = 0
    const n = Math.max(1, cfg.players)
    for (let i = 0; i < cfg.zombies; i++) {
      const [ox, oy] = SPREAD_OFFSETS[(i % n) % SPREAD_OFFSETS.length]!
      const t = baseAgents[i % Math.max(1, baseAgents.length)]!
      const pos = core.sim.ai.nav.nearest({ x: (t.x % 96) + ox, y: (t.y % 96) + oy })
      core.sim.ai.agents.push(createAIAgent(i + 1, core.sim.town.seed, pos.x, pos.y, t.aim))
    }
    for (let i = 0; i < 12; i++) {
      virtualMs = net.now * 1000
      net.step()
      clients.forEach((c) => {
        c.update(TICK_DT, { mx: 0, my: 0, aim: -Math.PI / 2, interact: false })
        c.sync(TICK_DT)
      })
    }
  }

  if (cfg.horde) {
    const lead = core.sim.slots[0]!.survivor
    const h = addHorde(core.sim, lead.x + 22, lead.y, cfg.horde, { x: lead.x, y: lead.y })
    materializeHorde(core.sim, h)
  }

  net.lossRate = savedLoss
  measuring = true

  const downStart = core.bytesSent.slice()
  const upStart = clients.map((c) => c.bytesOut)
  const snapStart = clients.map((c) => c.snapshotCount)

  const stepMs: number[] = []
  const frameMs: number[] = []
  let snapshotTicks = 0
  const ticks = Math.round(cfg.seconds / TICK_DT)
  const startTick = net.tick
  const midTick = startTick + Math.floor(ticks / 2)

  for (let i = 0; i < ticks; i++) {
    virtualMs = net.now * 1000
    net.tick++
    net.deliver()
    if (cfg.horde) for (const slot of core.sim.slots) slot.survivor.health = slot.survivor.maxHealth
    const t0 = performance.now()
    const before = core.tick
    core.step()
    stepMs.push(performance.now() - t0)
    if (core.tick !== before && core.tick % 3 === 0) snapshotTicks++
    clients.forEach((c, k) => {
      const frameStart = performance.now()
      const phase = i / 90 + k * 1.7
      c.update(TICK_DT, {
        mx: Math.cos(phase),
        my: Math.sin(phase * 0.7),
        aim: phase * 2,
        interact: i % 240 === k * 13,
        sprint: (i + k * 50) % 300 < 60,
        fire: i % 45 === k * 7,
        reload: i % 400 === k,
      })
      const lastSeq = c.predictor.unacked.at(-1)?.seq
      if (lastSeq !== undefined) sentAtByClient[k]!.set(lastSeq, net.now)
      c.sync(TICK_DT)
      frameMs.push(performance.now() - frameStart)
    })
  }

  const sortedStep = [...stepMs].sort((a, b) => a - b)
  const sortedDecode = [...decodeMs].sort((a, b) => a - b)
  const sortedFrame = [...frameMs].sort((a, b) => a - b)
  const corrMags = corrections.map((c) => c.mag).sort((a, b) => a - b)
  const firstHalfCorr = corrections.filter((c) => c.tick < midTick).map((c) => c.mag)
  const secondHalfCorr = corrections.filter((c) => c.tick >= midTick).map((c) => c.mag)
  const sortedAckLat = [...ackLatenciesMs].sort((a, b) => a - b)
  const sortedSnapLat = [...snapLatenciesMs].sort((a, b) => a - b)

  const mean = meanOf(stepMs)
  const downEnd = core.bytesSent
  const down = downEnd.map((b, i) => b - (downStart[i] ?? 0))
  const downKBps = down.map((b) => +(b / cfg.seconds / 1024).toFixed(2))
  const upKBps = clients.map((c, i) => +((c.bytesOut - upStart[i]!) / cfg.seconds / 1024).toFixed(2))
  const snapshotsPerClient = clients.map((c, i) => c.snapshotCount - snapStart[i]!)
  const cnt = Math.max(1, breakdownSums.count)

  for (const c of clients) c.close()

  return {
    label: `${cfg.players}p · ${cfg.horde ? `horde ${cfg.horde} + ` : ""}${cfg.zombies}z · ${cfg.spread ? "spread 1km" : "together"} · ${
      cfg.lossRate > 0 ? `lossy (80±30ms, ${Math.round(cfg.lossRate * 100)}%)` : "clean (50ms)"
    }`,
    players: cfg.players,
    zombies: core.sim.ai.agents.length,
    living: core.sim.ai.agents.filter((a) => a.state !== "dead").length,
    chasing: core.sim.ai.agents.filter((a) => a.state === "chase").length,
    spread: cfg.spread,
    lossRate: cfg.lossRate,
    seconds: cfg.seconds,
    serverTickMs: {
      mean: +mean.toFixed(4),
      p50: +pct(sortedStep, 0.5).toFixed(4),
      p95: +pct(sortedStep, 0.95).toFixed(4),
      p99: +pct(sortedStep, 0.99).toFixed(4),
      max: +pct(sortedStep, 1.0).toFixed(4),
    },
    serverCpuPerSecondMs: +(mean / TICK_DT).toFixed(2),
    clientDecodeMs: {
      mean: +meanOf(decodeMs).toFixed(4),
      p50: +pct(sortedDecode, 0.5).toFixed(4),
      p95: +pct(sortedDecode, 0.95).toFixed(4),
    },
    clientFrameMs: {
      mean: +meanOf(frameMs).toFixed(4),
      p50: +pct(sortedFrame, 0.5).toFixed(4),
      p95: +pct(sortedFrame, 0.95).toFixed(4),
    },
    downKBps,
    downKBpsMean: +meanOf(downKBps).toFixed(2),
    upKBps,
    upKBpsMean: +meanOf(upKBps).toFixed(2),
    snapshotBytes: +(down.reduce((a, b) => a + b, 0) / Math.max(1, down.length) / Math.max(1, snapshotTicks)).toFixed(0),
    snapBreakdownBytes: {
      total: Math.round(breakdownSums.total / cnt),
      personal: Math.round(breakdownSums.personalBytes / cnt),
      header: Math.round(breakdownSums.headerBytes / cnt),
      survivors: Math.round(breakdownSums.survivorsBytes / cnt),
      zombies: Math.round(breakdownSums.zombiesBytes / cnt),
      portals: Math.round(breakdownSums.portalsBytes / cnt),
      events: Math.round(breakdownSums.eventsBytes / cnt),
    },
    latencyMs: {
      ackP50: +pct(sortedAckLat, 0.5).toFixed(1),
      ackP95: +pct(sortedAckLat, 0.95).toFixed(1),
      snapP50: +pct(sortedSnapLat, 0.5).toFixed(1),
    },
    correctionsM: {
      mean: +meanOf(corrMags).toFixed(4),
      p95: +pct(corrMags, 0.95).toFixed(4),
      max: +pct(corrMags, 1.0).toFixed(4),
      firstHalfMean: +meanOf(firstHalfCorr).toFixed(4),
      secondHalfMean: +meanOf(secondHalfCorr).toFixed(4),
    },
    snapshotsPerClient,
  }
}

if (import.meta.main) {
  const matrix = arg("matrix", 0) === 1
  const seconds = arg("seconds", matrix ? 10 : 60)
  if (matrix) {
    const scenarios: ScenarioConfig[] = [
      { players: 1, zombies: 60, spread: false, lossRate: 0, latencyTicks: 3, jitterTicks: 1, seconds },
      { players: 2, zombies: 60, spread: false, lossRate: 0, latencyTicks: 3, jitterTicks: 1, seconds },
      { players: 4, zombies: 60, spread: false, lossRate: 0, latencyTicks: 3, jitterTicks: 1, seconds },
      { players: 4, zombies: 60, spread: true, lossRate: 0, latencyTicks: 3, jitterTicks: 1, seconds },
      { players: 4, zombies: 60, spread: false, lossRate: 0.02, latencyTicks: 4, jitterTicks: 3, seconds },
      { players: 1, zombies: 300, spread: false, lossRate: 0, latencyTicks: 3, jitterTicks: 1, seconds },
      { players: 2, zombies: 300, spread: false, lossRate: 0, latencyTicks: 3, jitterTicks: 1, seconds },
      { players: 4, zombies: 300, spread: false, lossRate: 0, latencyTicks: 3, jitterTicks: 1, seconds },
      { players: 4, zombies: 300, spread: true, lossRate: 0, latencyTicks: 3, jitterTicks: 1, seconds },
      { players: 4, zombies: 300, spread: true, lossRate: 0.02, latencyTicks: 4, jitterTicks: 3, seconds },
      { players: 1, zombies: 1000, spread: false, lossRate: 0, latencyTicks: 3, jitterTicks: 1, seconds },
      { players: 4, zombies: 1000, spread: false, lossRate: 0, latencyTicks: 3, jitterTicks: 1, seconds },
      { players: 4, zombies: 1000, spread: true, lossRate: 0, latencyTicks: 3, jitterTicks: 1, seconds },
      { players: 4, zombies: 1000, spread: true, lossRate: 0.02, latencyTicks: 4, jitterTicks: 3, seconds },
    ]
    const out = scenarios.map(runCoopBenchScenario)
    console.log(JSON.stringify(out, null, 2))
  } else {
    const zombies = arg("zombies", 60)
    const players = arg("players", 4)
    const spread = arg("spread", 0) === 1
    const lossRate = arg("loss", 0)
    const latencyMs = arg("latencyMs", 50)
    const jitterMs = arg("jitterMs", 16)
    const latencyTicks = Math.max(1, Math.round((latencyMs - jitterMs / 2) / (TICK_DT * 1000)))
    const jitterTicks = Math.max(0, Math.round(jitterMs / (TICK_DT * 1000)))
    const horde = arg("horde", 0)
    console.log(
      JSON.stringify(
        runCoopBenchScenario({ players, zombies, spread, lossRate, latencyTicks, jitterTicks, seconds, horde }),
        null,
        2,
      ),
    )
  }
}
