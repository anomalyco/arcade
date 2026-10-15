/**
 * How many one-shot presses (Brawl casts, Blackout trigger pulls) survive a lossy link, measured at the point where
 * the authoritative World consumes its input queue. Drives each game's real `RoomCore` with a simulated WebSocket:
 * one intent per 60 Hz client tick, one-way delay `--delay` ± `--jitter` ms, and `--loss` packet loss. A WebSocket
 * runs over TCP, so a lost segment is retransmitted (`--rto` ms later) and everything behind it waits: losses arrive
 * as bursts, the case `queue.splice` trimming used to drop.
 *
 *   bun scripts/bench-input-drops.ts [--label=after] [--seconds=120] [--seeds=3] [--delay=80] [--jitter=30] [--loss=0.02] [--rto=200]
 */
import { mulberry32 } from "../packages/kit/sim/rng"

Bun.plugin({
  name: "cloudflare-workers-stub",
  setup(build) {
    build.module("cloudflare:workers", () => ({ exports: { DurableObject: class {} }, loader: "object" }))
  },
})

const opt = (key: string, fallback: number) => Number(process.argv.find((s) => s.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback)
const SECONDS = opt("seconds", 120)
const SEEDS = opt("seeds", 3)
const DELAY = opt("delay", 80)
const JITTER = opt("jitter", 30)
const LOSS = opt("loss", 0.02)
const RTO = opt("rto", 200)
const TICK_MS = 1000 / 60

type Conn = { send(data: string): void; close(): void }
type Queued = { seq: number; intent: Record<string, unknown> }
type Core = { message(conn: Conn, raw: unknown): void; step(): void; world: { players: Map<string, { queue: Queued[] }> } }

type Game = {
  name: string
  core(clock: () => number): Promise<Core>
  hello: Record<string, unknown>
  intent(tick: number, press: boolean, rand: () => number): Record<string, unknown>
  pressed(intent: Record<string, unknown>): boolean
}

const GAMES: Game[] = [
  {
    name: "brawl",
    async core(clock) {
      const { RoomCore } = await import("../games/brawl/server/room")
      return new RoomCore("bench", clock) as unknown as Core
    },
    hello: { name: "bench", pick: "chef" },
    intent: (tick, press) => ({ mx: Math.sin(tick * 0.05), my: Math.cos(tick * 0.03), aim: (tick * 0.02) % 6, tx: 10, ty: 10, cast: press ? 1 : -1 }),
    pressed: (i) => typeof i.cast === "number" && i.cast >= 0,
  },
  {
    name: "blackout",
    async core(clock) {
      const { RoomCore } = await import("../games/blackout/server/room")
      return new RoomCore("bench", "ffa", clock) as unknown as Core
    },
    hello: { name: "bench", gun: "rifle", equip: "frag" },
    intent: (tick, press) => ({ mx: Math.sin(tick * 0.05), my: Math.cos(tick * 0.03), aim: (tick * 0.02) % 6, fire: press, ...(press ? { firePressed: true } : {}), reload: false, sprint: false, equip: false, tx: 10, ty: 10, use: false }),
    pressed: (i) => i.firePressed === true,
  },
]

async function build(game: Game) {
  const { BUILD } = await import(`../games/${game.name}/shared/build.gen.ts`)
  return BUILD as string
}

type Result = { sent: number; applied: number; latencies: number[]; heldBack: number }

async function run(game: Game, seed: number, delay: number, jitter: number, loss: number): Promise<Result> {
  const rand = mulberry32(seed)
  let now = 0
  const core = await game.core(() => now)
  let id = ""
  const conn: Conn = {
    send(data) {
      const m = JSON.parse(data) as { type: string; id?: string }
      if (m.type === "welcome") id = m.id!
    },
    close() {},
  }
  core.message(conn, JSON.stringify({ type: "hello", build: await build(game), ...game.hello }))
  if (!id) throw new Error(`${game.name}: no welcome`)

  // The link: each message's delivery time, in order (TCP), with retransmits for losses.
  const inflight: { at: number; data: string }[] = []
  let lastDeliver = 0
  let heldBack = 0
  const pressAt = new Map<number, number>()
  let nextPress = 30
  let seq = 0
  const result: Result = { sent: 0, applied: 0, latencies: [], heldBack: 0 }

  // Watch the World consume its queue: every shifted intent is one the simulation applies.
  let watched: Queued[] | null = null
  let tick = 0
  const watch = () => {
    const q = core.world.players.get(id)?.queue
    if (!q || q === watched) return
    watched = q
    const shift = q.shift.bind(q)
    q.shift = () => {
      const item = shift()
      if (item && game.pressed(item.intent)) {
        result.applied++
        const t = pressAt.get(Math.round(Number(item.intent.tx) * 1000))
        if (t !== undefined) result.latencies.push(tick - t)
      }
      return item
    }
  }

  const ticks = SECONDS * 60
  for (tick = 0; tick < ticks; tick++) {
    now = tick * TICK_MS
    // Client tick: one intent, a press every 30-60 ticks (tagged in tx so its latency can be measured).
    // No new presses in the last two seconds, so every press sent has time to arrive.
    const press = tick === nextPress && tick < ticks - 120
    if (press) nextPress = tick + 30 + Math.floor(rand() * 30)
    const intent = game.intent(tick, press, rand)
    if (press) {
      result.sent++
      intent.tx = 10 + result.sent / 1000
      pressAt.set(Math.round(Number(intent.tx) * 1000), tick)
    }
    const oneWay = delay + (rand() * 2 - 1) * jitter
    let at = now + oneWay
    if (rand() < loss) at = now + RTO + delay + (rand() * 2 - 1) * jitter
    if (at < lastDeliver) {
      if (lastDeliver - at > TICK_MS) heldBack++
      at = lastDeliver
    }
    lastDeliver = at
    inflight.push({ at, data: JSON.stringify({ type: "intent", seq: ++seq, i: intent }) })
    // Server tick.
    while (inflight.length && inflight[0]!.at <= now) core.message(conn, inflight.shift()!.data)
    watch()
    core.step()
  }
  result.heldBack = heldBack
  return result
}

const pct = (a: number[], p: number) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))]! : 0)
const scenarios = [
  { label: "clean (20 ms)", delay: 20, jitter: 0, loss: 0 },
  { label: `lossy (${DELAY} ± ${JITTER} ms, ${(LOSS * 100).toFixed(0)}% loss)`, delay: DELAY, jitter: JITTER, loss: LOSS },
]
const rows: Record<string, unknown>[] = []
for (const game of GAMES) {
  for (const s of scenarios) {
    const total: Result = { sent: 0, applied: 0, latencies: [], heldBack: 0 }
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = await run(game, seed * 7919, s.delay, s.jitter, s.loss)
      total.sent += r.sent
      total.applied += r.applied
      total.latencies.push(...r.latencies)
      total.heldBack += r.heldBack
    }
    const row = {
      game: game.name,
      link: s.label,
      presses: total.sent,
      applied: total.applied,
      dropped: total.sent - total.applied,
      dropPct: +(((total.sent - total.applied) / total.sent) * 100).toFixed(2),
      latencyP50Ticks: pct(total.latencies, 0.5),
      latencyP95Ticks: pct(total.latencies, 0.95),
      heldBack: total.heldBack,
    }
    rows.push(row)
    console.log(JSON.stringify(row))
  }
}
console.table(rows)
const label = process.argv.find((s) => s.startsWith("--label="))?.slice(8)
if (label) {
  const file = new URL(`../perf/input-drops-${label}.json`, import.meta.url)
  await Bun.write(file, JSON.stringify({ label, seconds: SECONDS, seeds: SEEDS, rto: RTO, rows }, null, 2) + "\n")
  console.log(`wrote ${file.pathname}`)
}
