// Room CPU per tick and bandwidth per client: 4 survivors (in-process NetSession clients over a loopback with
// 50 ms one-way latency) roaming and shooting among 60 zombies for 60 simulated seconds.
// Usage: bun scripts/coop-bench.ts [--zombies=60] [--players=4] [--seconds=60]
import { CoopRoomCore } from "../server/room-core"
import { BUILD } from "../shared/build.gen"
import { TICK_DT } from "../shared/clock"
import { DEFAULT_COOP_ROOM } from "../shared/coop-config"
import { NetSession } from "../src/net-session"
import { Loopback } from "../tests/loopback"

const arg = (name: string, fallback: number) => Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback)
const zombies = arg("zombies", 60)
const players = arg("players", 4)
const seconds = arg("seconds", 60)

let virtualMs = 0
const core = new CoopRoomCore("bench", { ...DEFAULT_COOP_ROOM, zombieCount: zombies }, () => virtualMs, BUILD)
const net = new Loopback(core, 3, 2)
const memory = new Map<string, string>()
const clients = Array.from({ length: players }, (_, i) => new NetSession({
  url: "loop",
  room: "bench",
  name: `Bench ${i + 1}`,
  storage: { getItem: (k) => memory.get(`${i}${k}`) ?? null, setItem: (k, v) => void memory.set(`${i}${k}`, v) },
  now: () => net.now,
  WebSocket: net.socketClass(),
}))

const stepMs: number[] = []
let snapshotTicks = 0
const ticks = Math.round(seconds / TICK_DT)
for (let i = 0; i < ticks; i++) {
  virtualMs = net.now * 1000
  net.tick++
  net.deliver()
  const t0 = performance.now()
  const before = core.tick
  core.step()
  stepMs.push(performance.now() - t0)
  if (core.tick !== before && core.tick % 3 === 0) snapshotTicks++
  clients.forEach((c, k) => {
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
    c.sync(TICK_DT)
  })
}

const sorted = [...stepMs].sort((a, b) => a - b)
const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!
const mean = stepMs.reduce((a, b) => a + b, 0) / stepMs.length
const down = core.bytesSent
const result = {
  players,
  zombies: core.sim.ai.agents.length,
  living: core.sim.ai.agents.filter((a) => a.state !== "dead").length,
  chasing: core.sim.ai.agents.filter((a) => a.state === "chase").length,
  seconds,
  serverTickMs: { mean: +mean.toFixed(4), p50: +pct(0.5).toFixed(4), p95: +pct(0.95).toFixed(4), p99: +pct(0.99).toFixed(4), max: +sorted.at(-1)!.toFixed(4) },
  serverCpuPerSecondMs: +(mean / TICK_DT).toFixed(2),
  downKBps: down.map((b) => +(b / seconds / 1024).toFixed(2)),
  upKBps: clients.map((c) => +(c.bytesOut / seconds / 1024).toFixed(2)),
  snapshotBytes: +(down.reduce((a, b) => a + b, 0) / down.length / Math.max(1, snapshotTicks)).toFixed(0),
  snapshotsPerClient: clients.map((c) => c.snapshotCount),
}
console.log(JSON.stringify(result, null, 2))
for (const c of clients) c.close()
