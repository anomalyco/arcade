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
 *   position between two of its snapshots is a correction pop when it reconciles, in cm at 5 m/s;
 * - snapshot rate and downlink bytes per client, and server tick cost.
 *
 *   bun scripts/bench-netcode.ts [--label=before] [--seconds=60] [--seeds=2] [--games=outbreak,blackout]
 */
import { SnapshotBuffer } from "../packages/kit/net/interpolate"
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
  /** The client's remote interpolation buffer, configured as the game's client does. */
  buffer(): Promise<SnapshotBuffer<unknown>>
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
const client = (game: string, file: string) => import(`../games/${game}/src/${file}.ts`)
const build = async (game: string) => ((await import(`../games/${game}/shared/build.gen.ts`)) as { BUILD: string }).BUILD
const json = (data: Data) => (typeof data === "string" ? (JSON.parse(data) as Record<string, unknown>) : null)
const move = (tick: number, keys: Move) => ({ mx: keys[0], my: keys[1], aim: (tick * 0.02) % 6 })

/**
 * Brawl and Blackout share `@arcade/kit/net/room-core`: hook the actor's jitter buffer. A tick it hands over nothing
 * stops the player (the worlds use a neutral intent); two inputs are applied as one (the later's movement).
 */
function kitWatch(edge: (i: Record<string, unknown>) => boolean) {
  type Jitter = { ack: number; take(t: number): readonly Record<string, unknown>[] }
  return (core: Core, id: string, applied: Applied) => {
    const seats = (core as unknown as { seats: { byId(id: string): { data: { jitter: Jitter } } | undefined } }).seats
    let watched: Jitter | null = null
    let took = false
    const step = core.step.bind(core)
    core.step = () => {
      const j = seats.byId(id)?.data.jitter
      if (j && j !== watched) {
        watched = j
        const take = j.take.bind(j)
        j.take = (t) => {
          const out = take(t)
          took = true
          const last = out[out.length - 1]
          applied(j.ack, out.some(edge), [last ? [Number(last.mx), Number(last.my)] : [0, 0]])
          return out
        }
      }
      took = false
      step()
      if (!took) throw new Error("kit room didn't take input this tick")
    }
  }
}

const GAMES: Game[] = [
  {
    name: "outbreak",
    tickHz: 60,
    buffer: async () => (await import("../games/outbreak/src/net-session")).remoteBuffer() as SnapshotBuffer<unknown>,
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
    buffer: async () => (await import("../games/blackout/src/game/remote")).remoteBuffer() as SnapshotBuffer<unknown>,
    // Shots carry the client's render time; soldiers on foot are rewound up to REWIND_SECONDS.
    rewind: (await import("../games/blackout/shared/sim/world")).REWIND_SECONDS,
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
    buffer: async () => new SnapshotBuffer(0.1),
    // Casts carry the client's render time; the world rewinds others up to 350 ms for melee, grabs and bursts.
    rewind: 0.35,
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
    // NetClient draws remote cars with adaptive time-stretched SnapshotBuffer (80–100 ms).
    buffer: async () => (await import("../games/getaway/src/game/netcode")).remoteBuffer() as SnapshotBuffer<unknown>,
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
      type Jitter = { ack: number; take(t: number): readonly In[] }
      type P = { ack?: number; input: In; queue?: { seq: number; input: In }[]; jitter?: Jitter }
      const players = (core as unknown as { players: Map<string, P> }).players
      const vec = (i: In): Move => [i.steer, i.throttle - i.brake]
      // The input buffer is replaced on reconnect; re-hook whenever it changes.
      let watched: unknown = null
      let took = false
      const step = core.step.bind(core)
      core.step = () => {
        const p = players.get(id)
        const buf = p?.jitter ?? p?.queue
        if (p && buf && buf !== watched) {
          watched = buf
          if (p.jitter) {
            const j = p.jitter
            const take = j.take.bind(j)
            j.take = (t) => {
              const out = take(t)
              took = out.length > 0
              if (took) applied(j.ack, out.some((i) => i.gadget !== null), [vec(out[out.length - 1]!)])
              return out
            }
          } else {
            const q = p.queue!
            const shift = q.shift.bind(q)
            q.shift = () => {
              const item = shift()
              took = !!item
              if (item) applied(item.seq, item.input.gadget !== null, [vec(item.input)])
              return item
            }
          }
        }
        took = false
        step()
        // A dry tick on the legacy queue repeats the last input without advancing the ack.
        if (p?.queue && !took) applied(p.ack!, false, [vec(p.input)])
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
  /** Prediction corrections: changes in (server − predicted) position between snapshots, in ticks of movement. */
  corrections: number[]
}

async function run(game: Game, link: LinkProfile, seed: number): Promise<Run> {
  const rand = mulberry32(seed)
  const tickMs = 1000 / game.tickHz
  let now = 0
  const core = await game.core(() => now)

  let onActorSnapshot = () => {}
  type Client = {
    conn: Conn
    up: TcpLink
    down: TcpLink
    inbox: { at: number; data: Data; sent: number; snap: boolean }[]
    outbox: { at: number; data: Data }[]
    snapArrivals: { at: number; sent: number }[]
    buf: SnapshotBuffer<unknown>
    /** Server time (ms) of the newest snapshot received. */
    newest: number
    id: string | null
    bytes: number
    snaps: number
  }
  const client = async (): Promise<Client> => {
    const c: Client = {
      buf: await game.buffer(),
      newest: -Infinity,
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
          const snap = game.isSnapshot(data)
          c.inbox.push({ at, data, sent: now, snap })
          c.bytes += typeof data === "string" ? data.length : data.byteLength
          if (snap) {
            if (c === actor) onActorSnapshot()
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
  const actor = await client()
  const observer = await client()
  for (const c of [actor, observer]) {
    core.open?.(c.conn)
    core.message(c.conn, await game.hello())
    if (!c.id) throw new Error(`${game.name}: no welcome`)
  }

  const r: Run = { presses: 0, applied: 0, toServer: [], toConfirm: [], toRemote: [], shooterLag: [], frames: 0, starved: 0, longestStarve: 0, snaps: 0, bytes: 0, tickMs: [], corrections: [] }
  // Presses in flight: sequence number and keydown time. Applied ones wait for their snapshot.
  const pending: { seq: number; at: number; view: number }[] = []
  const shown: { at: number; applied: number }[] = []
  const remote: { at: number; applied: number }[] = []
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
  // Reconciliation happens per snapshot: what the player sees is the error's change since the previous one.
  let shownErr: Move = [0, 0]
  onActorSnapshot = () => {
    const d = Math.hypot(lastErr[0] - shownErr[0], lastErr[1] - shownErr[1])
    if (d > 0.01) r.corrections.push(d)
    shownErr = lastErr
  }
  game.watch(core, actor.id!, (ack, edge, moves) => {
    for (const m of moves) {
      serverPos[0]! += m[0]
      serverPos[1]! += m[1]
    }
    const p = predicted[Math.max(0, Math.min(ack, predicted.length - 1))]!
    const err: Move = [serverPos[0]! - p[0], serverPos[1]! - p[1]]
    lastErr = err
    // A stand-in for a late press takes its sequence number without its edge, which rides on an input after the late
    // original arrives; a press is lost once half a second of later inputs applied without it.
    while (pending.length && (edge ? pending[0]!.seq <= ack : pending[0]!.seq < ack - game.tickHz / 2)) {
      const p = pending.shift()!
      if (!edge) continue
      r.applied++
      r.toServer.push(now - p.at)
      shown.push({ at: p.at, applied: now })
      remote.push({ at: p.at, applied: now })
      r.shooterLag.push(Math.max(0, now - p.view - game.rewind * 1000))
    }
  })

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
          // The actor aims at what it draws now.
          pending.push({ seq, at: now, view: actor.buf.renderTime(now / 1000) * 1000 })
        }
        for (const data of send(seq, tick, press, keysAt[seq - 1]!)) actor.outbox.push({ at: actor.up.deliver(now), data })
        // The observer plays too (a silent one is idle-kicked), without presses.
        for (const data of sendObserver(seq, tick + 500, false, keysAt[keysAt.length - seq] ?? [0, 0])) observer.outbox.push({ at: observer.up.deliver(now), data })
        seq++
      }
      for (const c of [actor, observer]) {
        while (c.outbox.length && c.outbox[0]!.at <= now) core.message(c.conn, c.outbox.shift()!.data)
        while (c.inbox.length && c.inbox[0]!.at <= now) {
          const m = c.inbox.shift()!
          if (!m.snap) continue
          c.buf.push(m.sent / 1000, null, now / 1000)
          c.newest = m.sent
        }
      }
      // The observer's interpolation: starved when its render time is past the newest snapshot.
      const observerAt = observer.buf.renderTime(now / 1000) * 1000
      for (let i = remote.length - 1; i >= 0; i--) {
        // Drawn once the first snapshot after the press applied has arrived and the render time reaches it.
        const s = remote[i]!
        const snap = observer.snapArrivals.find((a) => a.sent >= s.applied)
        if (snap && snap.at <= now && observerAt >= snap.sent) {
          r.toRemote.push(now - s.at)
          remote.splice(i, 1)
        }
      }
      if (tick > game.tickHz && observer.newest > -Infinity) {
        r.frames++
        if (observerAt > observer.newest + 1) {
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
      if (!mine) continue
      r.toConfirm.push(mine.at - s.at)
      shown.splice(i, 1)
    }
    // Keep arrival lists short.
    for (const c of [actor, observer]) if (c.snapArrivals.length > 256) c.snapArrivals.splice(0, c.snapArrivals.length - 256)
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
      feedbackMs: 0,
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

type OptimisticRow = {
  game: string
  link: string
  pressToFeedbackMs: number
  actionsPredicted: number
  actionsConfirmed: number
  actionsRejected: number
  actionMispredictPct: number
  hitsPredicted: number
  hitTP: number
  hitTN: number
  hitFP: number
  hitFN: number
  hitFalsePositivePct: number
  hitDisagreePct: number
}

async function benchOutbreakOptimistic(link: LinkProfile, seed: number): Promise<OptimisticRow> {
  const { CoopRoomCore } = await server("outbreak", "room-core")
  const { DEFAULT_COOP_ROOM } = await import("../games/outbreak/shared/coop-config.ts")
  const { TICK_DT } = await import("../games/outbreak/shared/clock.ts")
  const BUILD = await build("outbreak")
  const { NetSession } = await client("outbreak", "net-session")
  const { outbreakClientFeatures } = await client("outbreak", "features")

  let nowMs = 0
  const core = new CoopRoomCore("opt-bench", { ...DEFAULT_COOP_ROOM, zombieCount: 16 }, () => nowMs, BUILD)

  type WireEvt = { at: number; fn: () => void }
  const wire: WireEvt[] = []
  let sockSeed = seed

  class LinkSocket {
    static OPEN = 1
    readyState = 0
    binaryType = "arraybuffer"
    onopen: (() => void) | null = null
    onmessage: ((e: { data: string | ArrayBuffer }) => void) | null = null
    onclose: ((e: CloseEvent) => void) | null = null
    private up = new TcpLink(link, mulberry32((sockSeed += 101)))
    private down = new TcpLink(link, mulberry32((sockSeed += 103)))
    private conn: Conn

    constructor(_url: string) {
      this.conn = {
        send: (data: Data) => {
          const at = typeof data === "string" ? nowMs + link.rttMs / 2 : this.down.deliver(nowMs)
          const payload = typeof data === "string" ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
          wire.push({ at, fn: () => this.onmessage?.({ data: payload as string | ArrayBuffer }) })
        },
        close: () => {
          this.readyState = 3
        },
      }
      wire.push({
        at: nowMs + link.rttMs / 2,
        fn: () => {
          this.readyState = 1
          core.open(this.conn)
          this.onopen?.()
        },
      })
    }
    send(data: string | Uint8Array): void {
      const isCtrl = typeof data === "string" && (data.includes('"hello"') || data.includes('"ping"'))
      const at = isCtrl ? nowMs + link.rttMs / 2 : this.up.deliver(nowMs)
      const copy = typeof data === "string" ? data : new Uint8Array(data)
      wire.push({ at, fn: () => core.message(this.conn, copy) })
    }
    close(): void {
      this.readyState = 3
      core.close(this.conn)
    }
  }

  const a = new NetSession({
    features: outbreakClientFeatures,
    url: "ws://bench",
    room: "opt-bench",
    name: "Actor",
    now: () => nowMs,
    WebSocket: LinkSocket as unknown as typeof WebSocket,
  })
  const b = new NetSession({
    features: outbreakClientFeatures,
    url: "ws://bench",
    room: "opt-bench",
    name: "Peer",
    now: () => nowMs,
    WebSocket: LinkSocket as unknown as typeof WebSocket,
  })

  const { vignetteDropId } = await import("../games/outbreak/shared/discovery/vignettes.ts")
  const totalTicks = 25 * 60
  for (let tick = 0; tick < totalTicks; tick++) {
    nowMs = tick * (1000 / 60)
    wire.sort((x, y) => x.at - y.at)
    while (wire.length && wire[0]!.at <= nowMs) wire.shift()!.fn()

    if (tick === 20 && a.id) {
      const slotA = core.sim.slot(a.id)!
      core.sim.progression.ledger.apply({ kind: "grant", actor: a.id, item: "ammo", count: 64 })
      slotA.survivor.reserveAmmo = 64
      a.local.survivor.reserveAmmo = 64
    }
    if (tick === 300 && a.id) {
      const slotA = core.sim.slot(a.id)!
      Object.assign(slotA.survivor, { x: 27.7, y: 36.3, aim: -Math.PI / 2 })
      Object.assign(a.local.survivor, { x: 27.7, y: 36.3, aim: -Math.PI / 2 })
      core.sim.rebuildSolids()
      a.sim.rebuildSolids()
    }
    if (tick === 420 && a.id) {
      const slotA = core.sim.slot(a.id)!
      const drop = vignetteDropId("hid", "elm")
      const at = core.sim.progression.ledger.store(drop)?.at
      if (at) {
        Object.assign(slotA.survivor, { x: at.x, y: at.y + 0.5, aim: -Math.PI / 2 })
        Object.assign(a.local.survivor, { x: at.x, y: at.y + 0.5, aim: -Math.PI / 2 })
      }
    }
    if (tick > 20 && tick % 90 === 0 && a.id) {
      const slotA = core.sim.slot(a.id)!
      const ang = ((tick / 90) % 6) * 0.4 - 1.0
      core.sim.ai.spawnZombie(
        core.sim.town,
        slotA.survivor.x + Math.cos(ang) * 5.5,
        slotA.survivor.y + Math.sin(ang) * 5.5,
        "chase",
        ang + Math.PI,
      )
    }

    // Aim at the closest visible zombie in the client's interpolated view (or sweep aim to test misses too)
    let aim = tick >= 300 && tick <= 460 ? -Math.PI / 2 : (tick * 0.03) % 6.28
    const p = a.local.survivor
    if (tick < 300 || tick > 460) {
      let bestD = 12
      for (const z of a.sim.ai.agents) {
        if (z.state === "dead") continue
        const d = Math.hypot(z.x - p.x, z.y - p.y)
        if (d < bestD && d > 0.5) {
          bestD = d
          aim = Math.atan2(z.y - p.y, z.x - p.x) + (tick % 5 === 0 ? 0.28 : 0)
        }
      }
    }

    const interact = tick === 320 || tick === 340 || tick === 440
    const fire = !interact && tick > 30 && tick % 28 === 0
    const shove = !interact && tick > 30 && tick % 85 === 40
    const reload = !interact && tick > 30 && tick % 160 === 80
    a.update(TICK_DT, {
      mx: tick >= 300 && tick <= 460 ? 0 : Math.cos(tick * 0.04),
      my: tick >= 300 && tick <= 460 ? 0 : Math.sin(tick * 0.05),
      aim,
      interact,
      sprint: false,
      fire,
      fireHeld: fire,
      melee: shove,
      reload,
    })
    b.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false, sprint: false })
    core.step()
    a.sync(TICK_DT)
    b.sync(TICK_DT)
  }

  // Drain remaining snapshots so in-flight predictions resolve
  for (let tick = totalTicks; tick < totalTicks + 60; tick++) {
    nowMs = tick * (1000 / 60)
    wire.sort((x, y) => x.at - y.at)
    while (wire.length && wire[0]!.at <= nowMs) wire.shift()!.fn()
    a.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false, sprint: false })
    b.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false, sprint: false })
    core.step()
    a.sync(TICK_DT)
    b.sync(TICK_DT)
  }

  const st = a.optimistic.stats
  const hs = a.hitStats
  const resolvedActions = Math.max(1, st.confirmed + st.rejected)
  const resolvedHits = Math.max(1, hs.truePositive + hs.trueNegative + hs.falsePositive + hs.falseNegative)
  a.close()
  b.close()
  return {
    game: "outbreak",
    link: link.name,
    pressToFeedbackMs: 0,
    actionsPredicted: st.predicted,
    actionsConfirmed: st.confirmed,
    actionsRejected: st.rejected,
    actionMispredictPct: +((st.rejected / resolvedActions) * 100).toFixed(2),
    hitsPredicted: hs.predicted,
    hitTP: hs.truePositive,
    hitTN: hs.trueNegative,
    hitFP: hs.falsePositive,
    hitFN: hs.falseNegative,
    hitFalsePositivePct: +((hs.falsePositive / Math.max(1, hs.truePositive + hs.falsePositive)) * 100).toFixed(2),
    hitDisagreePct: +(((hs.falsePositive + hs.falseNegative) / resolvedHits) * 100).toFixed(2),
  }
}

async function benchBlackoutOptimistic(link: LinkProfile, seed: number): Promise<OptimisticRow> {
  const { OptimisticEvents } = await import("../packages/kit/net/prediction.ts")
  const { RoomCore } = await server("blackout")
  const BUILD = await build("blackout")
  const { GUNS } = await import("../games/blackout/shared/config.ts")
  const { bulletSpread } = await import("../games/blackout/shared/sim/world.ts")
  const { decodeServer } = await import("../games/blackout/shared/protocol.ts")
  const { remoteBuffer, pushSnapshot, sampleRemote, soldierAt } = await import("../games/blackout/src/game/remote.ts")

  let nowMs = 0
  const core = new RoomCore("opt-bo", "ffa", () => nowMs)
  const gun = GUNS.rifle
  const opt = new OptimisticEvents<"shot" | "reload" | "equip", { tentativeHit?: boolean; serverHit?: boolean }>()
  const hitStats = { predicted: 0, tp: 0, tn: 0, fp: 0, fn: 0 }

  type WireEvt = { at: number; fn: () => void }
  const wire: WireEvt[] = []
  let sockSeed = seed
  const makeClient = (name: string, onSnap?: (s: ReturnType<typeof decodeServer>) => void) => {
    const up = new TcpLink(link, mulberry32((sockSeed += 107)))
    const down = new TcpLink(link, mulberry32((sockSeed += 109)))
    let id = ""
    const conn: Conn = {
      send(raw: Data) {
        const s = typeof raw === "string" ? raw : new TextDecoder().decode(raw)
        const at = s.startsWith('{"type":"snap"') || s.startsWith('{"type":"ev"') ? down.deliver(nowMs) : nowMs + link.rttMs / 2
        wire.push({
          at,
          fn: () => {
            const msg = decodeServer(s)
            if (!msg) return
            if (msg.type === "welcome") id = msg.id
            onSnap?.(msg)
          },
        })
      },
      close() {},
    }
    core.open?.(conn)
    core.message(conn, JSON.stringify({ type: "hello", build: BUILD, name, gun: "rifle", equip: "frag" }))
    return {
      get id() {
        return id
      },
      send(msg: unknown) {
        const raw = JSON.stringify(msg)
        wire.push({ at: up.deliver(nowMs), fn: () => core.message(conn, raw) })
      },
    }
  }

  const remote = remoteBuffer()
  let myId = ""
  let myPos = { x: 10, y: 10 }
  let mag = gun.mag
  let reloadUntil = 0
  const actor = makeClient("Actor", (msg) => {
    if (!msg) return
    if (msg.type === "welcome") myId = msg.id
    if (msg.type === "ev") {
      for (const e of msg.events) {
        if (e.k === "shot" && e.by === myId) {
          const pend = opt.confirmWhere((p) => p.kind === "shot")
          if (pend) {
            const srvHit = Boolean(e.hit)
            const cliHit = Boolean(pend.payload.tentativeHit)
            if (cliHit && srvHit) hitStats.tp++
            else if (!cliHit && !srvHit) hitStats.tn++
            else if (cliHit && !srvHit) hitStats.fp++
            else hitStats.fn++
          }
        }
      }
      return
    }
    if (msg.type !== "snap") return
    const s = msg
    pushSnapshot(remote, s, nowMs / 1000)
    const me = s.players.find((p) => p.id === myId)
    if (me) myPos = { x: me.x, y: me.y }
    opt.reconcile(s.ack, (ev) => {
      if (ev.kind === "reload") return (s.you?.reloading ?? 0) > 0 || (s.you?.mag ?? 0) === gun.mag
      return true
    })
  })
  const target = makeClient("Target")

  const totalTicks = 25 * 30
  let seq = 1
  for (let tick = 0; tick < totalTicks + 30; tick++) {
    nowMs = tick * (1000 / 30)
    wire.sort((x, y) => x.at - y.at)
    while (wire.length && wire[0]!.at <= nowMs) wire.shift()!.fn()

    if (tick < totalTicks && actor.id && target.id) {
      const world = (core as unknown as {
        world: {
          blockers: { x: number; y: number; w: number; h: number }[]
          players: Map<string, { x: number; y: number; hp: number; alive: boolean; invuln: number }>
        }
      }).world
      const pa = world.players.get(actor.id)
      const pt = world.players.get(target.id)
      if (pa && pt) {
        if (tick === 10) {
          world.blockers.length = 0
          pa.x = 12
          pa.y = 12
          pt.x = 16
          pt.y = 12
        }
        pa.hp = 100
        pt.hp = 100
        pa.invuln = 0
        pt.invuln = 0
      }

      const sample = sampleRemote(remote, nowMs / 1000)
      const drawnTarget = sample ? soldierAt(sample, target.id) : null
      let aim = 0
      if (drawnTarget) {
        aim = Math.atan2(drawnTarget.y - myPos.y, drawnTarget.x - myPos.x) + (tick % 4 === 0 ? 0.22 : 0)
      }
      if (reloadUntil > 0 && nowMs / 1000 >= reloadUntil) {
        reloadUntil = 0
        mag = gun.mag
      }
      const fire = tick > 20 && tick % 9 === 0 && reloadUntil <= 0 && mag > 0
      const reload = tick > 20 && mag === 0 && reloadUntil <= 0
      if (reload) {
        reloadUntil = nowMs / 1000 + gun.reload
        opt.predict({ seq, kind: "reload", key: "reload", payload: {} })
      }
      if (fire) {
        mag--
        const spread = bulletSpread(actor.id, seq, gun, 0)
        const a = aim + spread
        const dx = Math.cos(a)
        const dy = Math.sin(a)
        let cliHit = false
        if (drawnTarget) {
          const along = (drawnTarget.x - myPos.x) * dx + (drawnTarget.y - myPos.y) * dy
          const off = Math.abs(-(drawnTarget.x - myPos.x) * dy + (drawnTarget.y - myPos.y) * dx)
          if (along > 0 && along < gun.range && off < 0.4) cliHit = true
        }
        hitStats.predicted++
        opt.predict({ seq, kind: "shot", payload: { tentativeHit: cliHit } })
      }
      const view = remote.size > 0 ? Math.round(Math.max(0, remote.renderTime(nowMs / 1000)) * 1000) / 1000 : undefined
      actor.send({
        type: "intent",
        seq,
        i: { mx: 0, my: 0, aim, fire, ...(fire ? { firePressed: true } : {}), reload, sprint: false, equip: false, tx: 17, ty: 12, use: false, ...(view !== undefined ? { view } : {}) },
      })
      target.send({
        type: "intent",
        seq,
        i: { mx: 0, my: Math.sin(tick * 0.12) > 0 ? 1 : -1, aim: Math.PI, fire: false, reload: false, sprint: false, equip: false, tx: 12, ty: 12, use: false },
      })
      seq++
    }
    core.step()
  }

  const st = opt.stats
  const resolvedActions = Math.max(1, st.confirmed + st.rejected)
  const resolvedHits = Math.max(1, hitStats.tp + hitStats.tn + hitStats.fp + hitStats.fn)
  return {
    game: "blackout",
    link: link.name,
    pressToFeedbackMs: 0,
    actionsPredicted: st.predicted,
    actionsConfirmed: st.confirmed,
    actionsRejected: st.rejected,
    actionMispredictPct: +((st.rejected / resolvedActions) * 100).toFixed(2),
    hitsPredicted: hitStats.predicted,
    hitTP: hitStats.tp,
    hitTN: hitStats.tn,
    hitFP: hitStats.fp,
    hitFN: hitStats.fn,
    hitFalsePositivePct: +((hitStats.fp / Math.max(1, hitStats.tp + hitStats.fp)) * 100).toFixed(2),
    hitDisagreePct: +(((hitStats.fp + hitStats.fn) / resolvedHits) * 100).toFixed(2),
  }
}

async function benchBrawlOptimistic(link: LinkProfile, seed: number): Promise<OptimisticRow> {
  const { OptimisticEvents, Predictor } = await import("../packages/kit/net/prediction.ts")
  const { RoomCore } = await server("brawl")
  const BUILD = await build("brawl")
  const { CHARACTERS } = await import("../games/brawl/shared/characters/index.ts")
  const { decodeServer } = await import("../games/brawl/shared/protocol.ts")

  let nowMs = 0
  const core = new RoomCore("opt-br", () => nowMs)
  const def = CHARACTERS.chef!
  const opt = new OptimisticEvents<"cast", { slot: number }>()
  const predictor = new Predictor<{ mx: number; my: number; aim: number; tx: number; ty: number; cast: number }>()
  const predictedCd = [0, 0, 0, 0]

  type WireEvt = { at: number; fn: () => void }
  const wire: WireEvt[] = []
  let sockSeed = seed
  let myId = ""
  let playing = false
  const up = new TcpLink(link, mulberry32((sockSeed += 113)))
  const down = new TcpLink(link, mulberry32((sockSeed += 127)))
  const conn: Conn = {
    send(raw: Data) {
      const s = typeof raw === "string" ? raw : new TextDecoder().decode(raw)
      const at = s.startsWith('{"type":"snap"') || s.startsWith('{"type":"ev"') ? down.deliver(nowMs) : nowMs + link.rttMs / 2
      wire.push({
        at,
        fn: () => {
          const msg = decodeServer(s)
          if (!msg) return
          if (msg.type === "welcome") myId = msg.id
          if (msg.type === "ev") {
            for (const e of msg.events) {
              if ((e.k === "cast" || e.k === "melee") && e.by === myId) {
                opt.confirmWhere((p) => p.kind === "cast")
              }
            }
          }
          if (msg.type === "snap") {
            const me = msg.f.find((f) => f.i === myId)
            playing = msg.phase === "play" && msg.go <= 0 && Boolean(msg.you?.move) && Boolean(me && (me.f & 1) !== 0 && (me.f & 4) === 0)
            predictor.reconcile(msg.ack - 1, () => {}, () => {})
            opt.reconcile(msg.ack, (ev) => (msg.you?.cd[ev.payload.slot] ?? 0) > 0.05)
            for (let k = 0; k < 4; k++) {
              if (!opt.hasPending("cast", `cast:${k}`)) predictedCd[k] = msg.you?.cd[k] ?? 0
            }
          }
        },
      })
    },
    close() {},
  }
  core.open?.(conn)
  core.message(conn, JSON.stringify({ type: "hello", build: BUILD, name: "Actor", pick: "chef" }))
  core.message(conn, JSON.stringify({ type: "ready", ready: true }))

  const totalTicks = 25 * 30
  let castLockUntil = 0
  for (let tick = 0; tick < totalTicks + 30; tick++) {
    nowMs = tick * (1000 / 30)
    wire.sort((x, y) => x.at - y.at)
    while (wire.length && wire[0]!.at <= nowMs) wire.shift()!.fn()

    for (let k = 0; k < 4; k++) if (predictedCd[k]! > 0) predictedCd[k] = Math.max(0, predictedCd[k]! - 1 / 30)
    if (tick < totalTicks && myId) {
      const slot = playing && nowMs / 1000 >= castLockUntil && tick > 20 && tick % 18 === 0 ? ((tick / 18) % 4) | 0 : -1
      const cast = slot >= 0 && predictedCd[slot]! <= 0.05 ? slot : -1
      const i = { mx: Math.cos(tick * 0.05), my: Math.sin(tick * 0.04), aim: 0, tx: 10, ty: 10, cast }
      const seq = predictor.record(i) + 1
      const prev = predictor.prevCommands(2)
      if (cast >= 0) {
        const ab = def.abilities[cast]!
        predictedCd[cast] = ab.cooldown
        castLockUntil = nowMs / 1000 + ab.windup + (ab.channel?.time ?? 0) + (ab.recover ?? 0) + 0.05
        opt.predict({ seq, kind: "cast", key: `cast:${cast}`, payload: { slot: cast } })
      }
      const raw = JSON.stringify(prev.length ? { type: "intent", seq, i, prev } : { type: "intent", seq, i })
      wire.push({ at: up.deliver(nowMs), fn: () => core.message(conn, raw) })
    }
    core.step()
  }

  const st = opt.stats
  const resolvedActions = Math.max(1, st.confirmed + st.rejected)
  return {
    game: "brawl",
    link: link.name,
    pressToFeedbackMs: 0,
    actionsPredicted: st.predicted,
    actionsConfirmed: st.confirmed,
    actionsRejected: st.rejected,
    actionMispredictPct: +((st.rejected / resolvedActions) * 100).toFixed(2),
    hitsPredicted: 0,
    hitTP: 0,
    hitTN: 0,
    hitFP: 0,
    hitFN: 0,
    hitFalsePositivePct: 0,
    hitDisagreePct: 0,
  }
}

async function benchArchersOptimistic(link: LinkProfile, seed: number): Promise<OptimisticRow> {
  const { RollbackClient, TickPacer } = await import("../packages/kit/net/rollback.ts")
  const { RoomCore } = await server("archers")
  const BUILD = await build("archers")
  const { TICK_HZ } = await import("../games/archers/shared/config.ts")
  const { BTN } = await import("../games/archers/shared/input.ts")
  const { rollbackSim } = await import("../games/archers/shared/match.ts")
  const { DEFAULT_TUNING } = await import("../games/archers/shared/tuning.ts")
  const { World } = await import("../games/archers/shared/world.ts")
  const { decodeServer, encodeClient } = await import("../games/archers/shared/protocol.ts")

  const tickMs = 1000 / TICK_HZ
  let nowMs = 0
  const core = new RoomCore("opt-ar", "cloister", () => nowMs)
  let myId = ""
  let slot = 0
  const rb = new RollbackClient(rollbackSim(() => slot))
  const pacer = new TickPacer(tickMs)

  type WireEvt = { at: number; fn: () => void }
  const wire: WireEvt[] = []
  const up = new TcpLink(link, mulberry32(seed + 131))
  const down = new TcpLink(link, mulberry32(seed + 137))
  const conn: Conn = {
    send(raw: Data) {
      const s = typeof raw === "string" ? raw : new TextDecoder().decode(raw)
      const msg = decodeServer(s)
      if (!msg) return
      const at = msg.type === "f" ? down.deliver(nowMs) : nowMs + link.rttMs / 2
      wire.push({
        at,
        fn: () => {
          if (msg.type === "welcome") myId = msg.id
          else if (msg.type === "roster") slot = msg.players.find((p) => p.id === myId)?.slot ?? 0
          else if (msg.type === "state") {
            rb.reset(new World(msg.s, DEFAULT_TUNING), msg.t, { i: msg.i })
            pacer.start(msg.t, link.rttMs, nowMs)
          } else if (msg.type === "f") {
            pacer.frame(msg.t, nowMs)
            if (rb.confirm(msg.t, msg.c ? { i: msg.i, c: msg.c } : { i: msg.i }) === "gap") {
              wire.push({ at: nowMs + link.rttMs / 2, fn: () => core.message(conn, encodeClient({ type: "resync" })) })
            }
            for (const v of msg.a ?? []) pacer.slack(v)
          }
        },
      })
    },
    close() {},
  }
  core.open(conn)
  core.message(conn, encodeClient({ type: "hello", build: BUILD }))

  const totalTicks = 25 * TICK_HZ
  let held = -1
  for (let tick = 0; tick < totalTicks + 30; tick++) {
    nowMs = tick * tickMs
    wire.sort((x, y) => x.at - y.at)
    while (wire.length && wire[0]!.at <= nowMs) wire.shift()!.fn()
    core.step()
    if (tick < totalTicks && rb.tick > 0) {
      pacer.atLeast(rb.tick)
      const from = rb.headTick
      const head = pacer.update(nowMs)
      for (let t = from + 1; t <= head; t++) {
        const phase = t % 45
        const b = (t % 90 < 45 ? BTN.right : BTN.left) | (phase === 5 ? BTN.jump : 0) | (phase >= 12 && phase <= 22 ? BTN.shoot : 0)
        rb.input(t, b)
        if (b !== held || (b && t % 6 === 0)) {
          const raw = encodeClient({ type: "in", t, b })
          wire.push({ at: up.deliver(nowMs), fn: () => core.message(conn, raw) })
        }
        held = b
      }
      rb.advance(head)
    }
  }

  const st = rb.optimistic.stats
  const resolvedActions = Math.max(1, st.confirmed + st.rejected)
  return {
    game: "archers",
    link: link.name,
    pressToFeedbackMs: 0,
    actionsPredicted: st.predicted,
    actionsConfirmed: st.confirmed,
    actionsRejected: st.rejected,
    actionMispredictPct: +((st.rejected / resolvedActions) * 100).toFixed(2),
    hitsPredicted: 0,
    hitTP: 0,
    hitTN: 0,
    hitFP: 0,
    hitFN: 0,
    hitFalsePositivePct: 0,
    hitDisagreePct: 0,
  }
}

async function benchGetawayOptimistic(link: LinkProfile, seed: number): Promise<OptimisticRow> {
  const { RoomCore } = await server("getaway", "core")
  const { DT, TICK_HZ } = await import("../games/getaway/shared/config.ts")
  const { decodeServer, encodeClient } = await import("../games/getaway/shared/protocol.ts")
  const { NetClient } = await import("../games/getaway/src/game/netcode.ts")

  const tickMs = 1000 / TICK_HZ
  let nowMs = 0
  const core = new RoomCore("OPTGW")

  type WireEvt = { at: number; fn: () => void }
  const wire: WireEvt[] = []
  let sockSeed = seed

  const makePeer = (name: string) => {
    const up = new TcpLink(link, mulberry32((sockSeed += 139)))
    const down = new TcpLink(link, mulberry32((sockSeed += 149)))
    let netClient: InstanceType<typeof NetClient> | null = null
    const conn: Conn = {
      send(raw: Data) {
        const s = typeof raw === "string" ? raw : new TextDecoder().decode(raw)
        const msg = decodeServer(s)
        if (!msg) return
        const at = msg.type === "snapshot" || msg.type === "events" ? down.deliver(nowMs) : nowMs + link.rttMs / 2
        wire.push({
          at,
          fn: () => {
            if (msg.type === "welcome") {
              netClient = new NetClient(core.world!.city, msg.id, (cm) => {
                const text = encodeClient(cm)
                wire.push({ at: up.deliver(nowMs), fn: () => core.message(conn, text) })
              })
            } else {
              netClient?.receive(msg)
            }
          },
        })
      },
      close() {},
    }
    core.open(conn)
    core.message(conn, encodeClient({ type: "hello", name, picks: { robber: "muscle", cop: "cruiser" } }))
    return {
      get client() {
        return netClient
      },
    }
  }

  const rob = makePeer("Rob")
  const cop = makePeer("Cop")

  // Advance past intro (4s) + headstart (5s) = 9s (270 ticks) + 25s of chase (750 ticks).
  const totalTicks = (10 + 25) * TICK_HZ
  for (let tick = 0; tick < totalTicks + 30; tick++) {
    nowMs = tick * tickMs
    wire.sort((x, y) => x.at - y.at)
    while (wire.length && wire[0]!.at <= nowMs) wire.shift()!.fn()

    if (tick < totalTicks && rob.client && cop.client) {
      const inChase = core.world?.phase === "chase"
      const gadget = inChase && tick > 310 && tick % 330 === 20 ? (0 as const) : null
      const boost = inChase && tick % 120 >= 10 && tick % 120 < 35
      const engine = inChase && (tick % 240 === 80 || tick % 240 === 95)
      rob.client.update(DT, {
        throttle: 1,
        brake: 0,
        steer: Math.sin(tick * 0.06) * 0.5,
        handbrake: tick % 90 > 78,
        boost: tick % 150 >= 20 && tick % 150 < 45,
        gadget: null,
        engine: false,
      })
      cop.client.update(DT, {
        throttle: 1,
        brake: 0,
        steer: Math.cos(tick * 0.05) * 0.5,
        handbrake: false,
        boost,
        gadget,
        engine,
      })
      rob.client.drainEvents()
      cop.client.drainEvents()
    } else {
      rob.client?.update(DT, { throttle: 0, brake: 1, steer: 0, handbrake: false, boost: false, gadget: null, engine: false })
      cop.client?.update(DT, { throttle: 0, brake: 1, steer: 0, handbrake: false, boost: false, gadget: null, engine: false })
    }
    core.step()
  }

  const rSt = rob.client!.optimistic.stats
  const cSt = cop.client!.optimistic.stats
  const predicted = rSt.predicted + cSt.predicted
  const confirmed = rSt.confirmed + cSt.confirmed
  const rejected = rSt.rejected + cSt.rejected
  const resolvedActions = Math.max(1, confirmed + rejected)
  return {
    game: "getaway",
    link: link.name,
    pressToFeedbackMs: 0,
    actionsPredicted: predicted,
    actionsConfirmed: confirmed,
    actionsRejected: rejected,
    actionMispredictPct: +((rejected / resolvedActions) * 100).toFixed(2),
    hitsPredicted: 0,
    hitTP: 0,
    hitTN: 0,
    hitFP: 0,
    hitFN: 0,
    hitFalsePositivePct: 0,
    hitDisagreePct: 0,
  }
}

const optimisticRows: OptimisticRow[] = []
for (const link of Object.values(LINKS)) {
  if (!ONLY || ONLY.includes("outbreak")) optimisticRows.push(await benchOutbreakOptimistic(link, 42))
  if (!ONLY || ONLY.includes("blackout")) optimisticRows.push(await benchBlackoutOptimistic(link, 42))
  if (!ONLY || ONLY.includes("brawl")) optimisticRows.push(await benchBrawlOptimistic(link, 42))
  if (!ONLY || ONLY.includes("archers")) optimisticRows.push(await benchArchersOptimistic(link, 42))
  if (!ONLY || ONLY.includes("getaway")) optimisticRows.push(await benchGetawayOptimistic(link, 42))
}
if (optimisticRows.length) {
  console.table(optimisticRows)
}

const label = arg("label")
if (label) {
  const file = new URL(`../perf/netcode-${label}.json`, import.meta.url)
  await Bun.write(file, JSON.stringify({ label, seconds: SECONDS, seeds: SEEDS, links: LINKS, rows, optimisticRows }, null, 2) + "\n")
  console.log(`wrote ${file.pathname}`)
}
