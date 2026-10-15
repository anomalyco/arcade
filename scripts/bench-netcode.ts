/**
 * Netcode as a player feels it, for every server-authoritative room game, over the `@arcade/kit/net/link-sim` link
 * profiles (TCP: losses and Wi-Fi stalls arrive as head-of-line bursts). Each game's real room core runs headless
 * with two playing clients, an actor and an observer, each behind its own simulated uplink and downlink. Per game and link:
 *
 * - press → server: a one-shot press (cast, trigger, gadget, fire) from the actor's keydown to the tick the
 *   authoritative world applies it, and how many presses never apply;
 * - press → confirm: until the actor's own client receives the snapshot that shows it (unpredicted actions: hits,
 *   doors, casts);
 * - press → remote: until the observer draws it (snapshot arrival, or its interpolation delay if later);
 * - remote starvation: observer frames whose render time is past the newest snapshot (the remote freezes or coasts);
 * - shooter lag: how far behind the server the actor's view of others is when its press applies, net of any
 *   server rewind; times 5 m/s it is how far a strafing target has moved from where the shot was aimed;
 * - corrections: the actor holds WASD-like keys and predicts every input; a change in (server − predicted)
 *   position at an acked input is a correction pop, in cm at 5 m/s;
 * - snapshot rate and downlink bytes per client, and server tick cost.
 *
 *   bun scripts/bench-netcode.ts [--label=before] [--seconds=60] [--seeds=2] [--games=outbreak,blackout]
 */
import { LINKS, type LinkProfile, TcpLink } from "../packages/kit/net/link-sim"
import { mulberry32 } from "../packages/kit/sim/rng"

Bun.plugin({
  name: "cloudflare-workers-stub",
  setup(build) {
    build.module("cloudflare:workers", () => ({ exports: { DurableObject: class {} }, loader: "object" }))
  },
})

const arg = (key: string) => process.argv.find((s) => s.startsWith(`--${key}=`))?.slice(key.length + 3)
const SECONDS = Number(arg("seconds") ?? 60)
const SEEDS = Number(arg("seeds") ?? 2)
const ONLY = arg("games")?.split(",")

type Data = string | Uint8Array
type Conn = { send(data: Data): void; close(): void }
type Core = { open?(conn: Conn): void; message(conn: Conn, raw: unknown): void; step(): void }
/** Called by the adapter's hook whenever the world applies one of the actor's inputs. */
type Applied = (ack: number, edge: boolean, moves: readonly Move[]) => void
/** Held movement keys, -1, 0 or 1 per axis. */
type Move = readonly [number, number]

type Sender = (seq: number, tick: number, press: boolean, keys: Move) => Data[]

type Game = {
  name: string
  tickHz: number
  /** Seconds the client draws remotes behind the newest server state. */
  interp: number
  /** Seconds of server-side rewind for the actor's hits (0: none). */
  rewind: number
  core(clock: () => number): Promise<Core>
  hello(): Promise<Data>
  /** The movement the world applies for held keys (identity unless the game maps them). */
  vector?(keys: Move): Move
  /** The actor's id from its welcome. */
  welcome(data: Data): string | null
  isSnapshot(data: Data): boolean
  /** Wraps the world so `applied` hears every input of `id` it applies. Called once after the actor joins. */
  watch(core: Core, id: string, applied: Applied): void
  /** A fresh client: its messages for input `seq`, called every client tick (may return nothing while batching). */
  sender(): Promise<Sender>
}

const server = (game: string, file = "room") => import(`../games/${game}/server/${file}.ts`)
const build = async (game: string) => ((await import(`../games/${game}/shared/build.gen.ts`)) as { BUILD: string }).BUILD
const json = (data: Data) => (typeof data === "string" ? (JSON.parse(data) as Record<string, unknown>) : null)
const move = (tick: number, keys: Move) => ({ mx: keys[0], my: keys[1], aim: (tick * 0.02) % 6 })

/** Brawl and Blackout share `@arcade/kit/net/room-core`: hook its `push(id, ack, intent)`. */
function kitWatch(edge: (i: Record<string, unknown>) => boolean) {
  return (core: Core, id: string, applied: Applied) => {
    const c = core as unknown as { push(id: string, ack: number, i: Record<string, unknown>): void }
    const push = c.push.bind(c)
    c.push = (who, ack, i) => {
      if (who === id) applied(ack, edge(i), [[Number(i.mx), Number(i.my)]])
      push(who, ack, i)
    }
  }
}

const GAMES: Game[] = [
  {
    name: "outbreak",
    tickHz: 60,
    interp: 0.1,
    rewind: 0.25,
    async core(clock) {
      const { CoopRoomCore } = await server("outbreak", "room-core")
      const { DEFAULT_COOP_ROOM } = await import("../games/outbreak/shared/coop-config")
      return new CoopRoomCore("bench", DEFAULT_COOP_ROOM, clock, "bench") as Core
    },
    hello: async () => JSON.stringify({ t: "hello", name: "bench", build: "bench" }),
    welcome: (d) => (json(d)?.t === "welcome" ? String(json(d)!.id) : null),
    isSnapshot: (d) => typeof d !== "string",
    watch(core, id, applied) {
      const seats = (core as unknown as { seats: { byId(id: string): { data: { jitter: { ack: number; take(t: number): readonly { fire?: boolean; mx: number; my: number }[] } } } } }).seats
      const jitter = seats.byId(id).data.jitter
      const take = jitter.take.bind(jitter)
      jitter.take = (t) => {
        const out = take(t)
        if (out.length) applied(jitter.ack, out.some((c) => c.fire), out.map((c) => [c.mx, c.my] as const))
        return out
      }
    },
    async sender() {
      const proto = await import("../games/outbreak/shared/net-protocol")
      type Tuple = ReturnType<typeof proto.packCommand>
      let outbox: Tuple[] = []
      let outSeq = 0
      let prev: Tuple[] = []
      let prevSeq = 0
      let prevEdge = false
      return (seq, tick, press, keys) => {
        if (!outbox.length) outSeq = seq
        outbox.push(proto.packCommand({ ...move(tick, keys), interact: false, fire: press, fireHeld: press }))
        if (outbox.length < 2) return []
        // Like NetSession.flush: the batch after one with a press repeats it.
        const repeat = prevEdge && prevSeq + prev.length === outSeq
        const data = proto.encodeClientInText(repeat ? prevSeq : outSeq, repeat ? [...prev, ...outbox] : outbox)
        prevEdge = outbox.some((t) => proto.commandOps.hasEdges(proto.unpackCommand(t)))
        prev = outbox.slice(-2)
        prevSeq = outSeq + outbox.length - prev.length
        outbox = []
        return [data]
      }
    },
  },
  {
    name: "blackout",
    tickHz: 30,
    interp: 0.1,
    rewind: 0,
    async core(clock) {
      const { RoomCore } = await server("blackout")
      return new RoomCore("bench", "ffa", clock) as Core
    },
    hello: async () => JSON.stringify({ type: "hello", build: await build("blackout"), name: "bench", gun: "rifle", equip: "frag" }),
    welcome: (d) => (json(d)?.type === "welcome" ? String(json(d)!.id) : null),
    isSnapshot: (d) => typeof d === "string" && d.startsWith('{"type":"snap"'),
    watch: kitWatch((i) => i.firePressed === true),
    sender: async (): Promise<Sender> => (seq, tick, press, keys) => [
      JSON.stringify({ type: "intent", seq, i: { ...move(tick, keys), fire: press, ...(press ? { firePressed: true } : {}), reload: false, sprint: false, equip: false, tx: 10, ty: 10, use: false } }),
    ],
  },
  {
    name: "brawl",
    tickHz: 30,
    interp: 0.1,
    rewind: 0,
    async core(clock) {
      const { RoomCore } = await server("brawl")
      return new RoomCore("bench", clock) as Core
    },
    hello: async () => JSON.stringify({ type: "hello", build: await build("brawl"), name: "bench", pick: "chef" }),
    welcome: (d) => (json(d)?.type === "welcome" ? String(json(d)!.id) : null),
    isSnapshot: (d) => typeof d === "string" && d.startsWith('{"type":"snap"'),
    watch: kitWatch((i) => typeof i.cast === "number" && i.cast >= 0),
    sender: async (): Promise<Sender> => (seq, tick, press, keys) => [JSON.stringify({ type: "intent", seq, i: { ...move(tick, keys), tx: 10, ty: 10, cast: press ? 1 : -1 } })],
  },
  {
    name: "getaway",
    tickHz: 30,
    interp: 0.1,
    rewind: 0,
    async core() {
      const { RoomCore } = await server("getaway", "core")
      return new RoomCore("BENCH") as Core
    },
    hello: async () => JSON.stringify({ type: "hello", name: "bench", picks: {} }),
    vector: (k) => [k[0], k[1] >= 0 ? 1 : -1],
    welcome: (d) => (json(d)?.type === "welcome" ? String(json(d)!.id) : null),
    isSnapshot: (d) => typeof d === "string" && d.startsWith('{"type":"snapshot"'),
    watch(core, id, applied) {
      type In = { gadget: number | null; steer: number; throttle: number; brake: number }
      const players = (core as unknown as { players: Map<string, { ack: number; input: In; queue: { seq: number; input: In }[] }> }).players
      let watched: unknown = null
      // The queue array is replaced on reconnect; re-hook whenever it changes.
      const step = core.step.bind(core)
      core.step = () => {
        const q = players.get(id)?.queue
        if (q && q !== watched) {
          watched = q
          const shift = q.shift.bind(q)
          q.shift = () => {
            const item = shift()
            if (item) applied(item.seq, item.input.gadget !== null, [[item.input.steer, item.input.throttle - item.input.brake]])
            return item
          }
        }
        const p = players.get(id)
        const dry = !!p && !p.queue.length
        step()
        // A dry tick repeats the last input (and the late original is applied as well when it comes).
        if (p && dry) applied(p.ack, false, [[p.input.steer, p.input.throttle - p.input.brake]])
      }
    },
    sender: async (): Promise<Sender> => (seq, _tick, press, keys) => [
      JSON.stringify({ type: "input", seq, input: { throttle: keys[1] >= 0 ? 1 : 0, brake: keys[1] < 0 ? 1 : 0, steer: keys[0], handbrake: false, boost: false, gadget: press ? 0 : null, engine: false } }),
    ],
  },
]

type Run = {
  presses: number
  applied: number
  toServer: number[]
  toConfirm: number[]
  toRemote: number[]
  shooterLag: number[]
  frames: number
  starved: number
  longestStarve: number
  snaps: number
  bytes: number
  tickMs: number[]
  /** Prediction corrections: changes in (server − predicted) position, in ticks of full-speed movement. */
  corrections: number[]
}

async function run(game: Game, link: LinkProfile, seed: number): Promise<Run> {
  const rand = mulberry32(seed)
  const tickMs = 1000 / game.tickHz
  let now = 0
  const core = await game.core(() => now)

  type Client = { conn: Conn; up: TcpLink; down: TcpLink; inbox: { at: number; data: Data }[]; outbox: { at: number; data: Data }[]; snapArrivals: { at: number; sent: number }[]; id: string | null; bytes: number; snaps: number }
  const client = (): Client => {
    const c: Client = {
      up: new TcpLink(link, rand),
      down: new TcpLink(link, rand),
      inbox: [],
      outbox: [],
      snapArrivals: [],
      id: null,
      bytes: 0,
      snaps: 0,
      conn: {
        send(data) {
          const at = c.down.deliver(now)
          c.inbox.push({ at, data })
          c.bytes += typeof data === "string" ? data.length : data.byteLength
          if (game.isSnapshot(data)) {
            c.snaps++
            c.snapArrivals.push({ at, sent: now })
          }
          c.id ??= game.welcome(data)
        },
        close() {},
      },
    }
    return c
  }
  const send = await game.sender()
  const sendObserver = await game.sender()
  const actor = client()
  const observer = client()
  for (const c of [actor, observer]) {
    core.open?.(c.conn)
    core.message(c.conn, await game.hello())
    if (!c.id) throw new Error(`${game.name}: no welcome`)
  }

  const r: Run = { presses: 0, applied: 0, toServer: [], toConfirm: [], toRemote: [], shooterLag: [], frames: 0, starved: 0, longestStarve: 0, snaps: 0, bytes: 0, tickMs: [], corrections: [] }
  // Presses in flight: sequence number and keydown time. Applied ones wait for their snapshot.
  const pending: { seq: number; at: number }[] = []
  const shown: { at: number; applied: number }[] = []
  // Held keys change every 0.2-1.2 s, like a player on WASD. The client predicts every input; the server's
  // position is the sum of what it applied. A change in their difference at an acked input is a correction.
  const keysAt: Move[] = []
  const keyRand = mulberry32(seed + 1)
  for (let t = 0, keys: Move = [0, 0]; t < SECONDS * game.tickHz + 2; t++) {
    if (t === 0 || keyRand() < 1 / (0.7 * game.tickHz)) keys = [Math.floor(keyRand() * 3) - 1, Math.floor(keyRand() * 3) - 1]
    keysAt.push(keys)
  }
  const predicted: Move[] = [[0, 0]]
  for (let i = 1; i < keysAt.length + 2; i++) {
    const k = game.vector ? game.vector(keysAt[i - 1] ?? [0, 0]) : (keysAt[i - 1] ?? [0, 0])
    predicted.push([predicted[i - 1]![0] + k[0], predicted[i - 1]![1] + k[1]])
  }
  const serverPos = [0, 0]
  let lastErr: Move = [0, 0]
  game.watch(core, actor.id!, (ack, edge, moves) => {
    for (const m of moves) {
      serverPos[0]! += m[0]
      serverPos[1]! += m[1]
    }
    const p = predicted[Math.min(ack, predicted.length - 1)]!
    const err: Move = [serverPos[0]! - p[0], serverPos[1]! - p[1]]
    const d = Math.hypot(err[0] - lastErr[0], err[1] - lastErr[1])
    if (d > 0.01) r.corrections.push(d)
    lastErr = err
    // A stand-in for a late press takes its sequence number without its edge, which rides on an input after the late
    // original arrives; a press is lost once half a second of later inputs applied without it.
    while (pending.length && (edge ? pending[0]!.seq <= ack : pending[0]!.seq < ack - game.tickHz / 2)) {
      const p = pending.shift()!
      if (!edge) continue
      r.applied++
      r.toServer.push(now - p.at)
      shown.push({ at: p.at, applied: now })
    }
  })

  const minOneWay = link.rttMs / 2 - link.jitterMs
  const ticks = Math.round(SECONDS * game.tickHz)
  const startBytes = observer.bytes
  const startSnaps = observer.snaps
  let nextPress = game.tickHz
  let seq = 1
  let starveRun = 0
  const SUB = 4
  for (let tick = 0; tick < ticks; tick++) {
    for (let sub = 0; sub < SUB; sub++) {
      now = tick * tickMs + (sub * tickMs) / SUB
      // Client tick (on the server's tick boundary; phase doesn't matter with random delays).
      if (sub === 0) {
        const press = tick === nextPress && tick < ticks - 2 * game.tickHz
        if (press) {
          nextPress = tick + game.tickHz + Math.floor(rand() * game.tickHz)
          r.presses++
          pending.push({ seq, at: now })
        }
        for (const data of send(seq, tick, press, keysAt[seq - 1]!)) actor.outbox.push({ at: actor.up.deliver(now), data })
        // The observer plays too (a silent one is idle-kicked), without presses.
        for (const data of sendObserver(seq, tick + 500, false, keysAt[keysAt.length - seq] ?? [0, 0])) observer.outbox.push({ at: observer.up.deliver(now), data })
        seq++
      }
      for (const c of [actor, observer]) {
        while (c.outbox.length && c.outbox[0]!.at <= now) core.message(c.conn, c.outbox.shift()!.data)
        while (c.inbox.length && c.inbox[0]!.at <= now) c.inbox.shift()
      }
      // The observer's interpolation: render time = now − (fastest one-way) − delay, starved past the newest snapshot.
      const arrived = observer.snapArrivals.filter((s) => s.at <= now)
      if (tick > game.tickHz && arrived.length) {
        const newest = arrived[arrived.length - 1]!.sent
        r.frames++
        if (now - minOneWay - game.interp * 1000 > newest + 1) {
          r.starved++
          starveRun += tickMs / SUB
          r.longestStarve = Math.max(r.longestStarve, starveRun)
        } else starveRun = 0
      }
      if (sub === 0) {
        const t0 = performance.now()
        core.step()
        r.tickMs.push(performance.now() - t0)
      }
    }
    // Resolve applied presses once a later snapshot reached each client.
    for (let i = shown.length - 1; i >= 0; i--) {
      const s = shown[i]!
      const mine = actor.snapArrivals.find((a) => a.sent >= s.applied)
      const theirs = observer.snapArrivals.find((a) => a.sent >= s.applied)
      if (!mine || !theirs) continue
      r.toConfirm.push(mine.at - s.at)
      r.toRemote.push(Math.max(theirs.at, theirs.sent + minOneWay + game.interp * 1000) - s.at)
      // The actor aimed at what it drew at keydown: server time (keydown − fastest one-way − delay).
      const lag = s.applied - (s.at - minOneWay - game.interp * 1000)
      r.shooterLag.push(Math.max(0, lag - game.rewind * 1000))
      shown.splice(i, 1)
    }
    // Keep arrival lists short.
    for (const c of [actor, observer]) if (c.snapArrivals.length > 64) c.snapArrivals.splice(0, c.snapArrivals.length - 64)
  }
  r.snaps = observer.snaps - startSnaps
  r.bytes = observer.bytes - startBytes
  return r
}

const pct = (a: number[], p: number) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))]! : 0)
const rows: Record<string, unknown>[] = []
for (const game of GAMES) {
  if (ONLY && !ONLY.includes(game.name)) continue
  for (const link of Object.values(LINKS)) {
    const all: Run = { presses: 0, applied: 0, toServer: [], toConfirm: [], toRemote: [], shooterLag: [], frames: 0, starved: 0, longestStarve: 0, snaps: 0, bytes: 0, tickMs: [], corrections: [] }
    for (let s = 1; s <= SEEDS; s++) {
      const r = await run(game, link, s * 7919)
      all.presses += r.presses
      all.applied += r.applied
      all.toServer.push(...r.toServer)
      all.toConfirm.push(...r.toConfirm)
      all.toRemote.push(...r.toRemote)
      all.shooterLag.push(...r.shooterLag)
      all.frames += r.frames
      all.starved += r.starved
      all.longestStarve = Math.max(all.longestStarve, r.longestStarve)
      all.snaps += r.snaps
      all.bytes += r.bytes
      all.tickMs.push(...r.tickMs)
      all.corrections.push(...r.corrections)
    }
    const secs = SECONDS * SEEDS
    const row = {
      game: game.name,
      link: link.name,
      lost: `${all.presses - all.applied}/${all.presses}`,
      serverP50: Math.round(pct(all.toServer, 0.5)),
      serverP95: Math.round(pct(all.toServer, 0.95)),
      confirmP50: Math.round(pct(all.toConfirm, 0.5)),
      confirmP95: Math.round(pct(all.toConfirm, 0.95)),
      remoteP50: Math.round(pct(all.toRemote, 0.5)),
      remoteP95: Math.round(pct(all.toRemote, 0.95)),
      starvedPct: +((all.starved / Math.max(1, all.frames)) * 100).toFixed(2),
      longestStarveMs: Math.round(all.longestStarve),
      shooterLagP50: Math.round(pct(all.shooterLag, 0.5)),
      correctionsPerMin: Math.round(all.corrections.length / (secs / 60)),
      correctionP95Cm: Math.round(pct(all.corrections, 0.95) * (500 / game.tickHz)),
      missCmAt5ms: Math.round(pct(all.shooterLag, 0.5) * 0.5),
      snapHz: +(all.snaps / secs).toFixed(1),
      downKBs: +(all.bytes / secs / 1024).toFixed(1),
      tickMeanMs: +(all.tickMs.reduce((a, b) => a + b, 0) / all.tickMs.length).toFixed(3),
      tickP99Ms: +pct(all.tickMs, 0.99).toFixed(3),
    }
    rows.push(row)
    console.log(JSON.stringify(row))
  }
}
console.table(rows)
const label = arg("label")
if (label) {
  const file = new URL(`../perf/netcode-${label}.json`, import.meta.url)
  await Bun.write(file, JSON.stringify({ label, seconds: SECONDS, seeds: SEEDS, links: LINKS, rows }, null, 2) + "\n")
  console.log(`wrote ${file.pathname}`)
}
