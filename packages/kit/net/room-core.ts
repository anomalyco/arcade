/**
 * Transport-free seat keeping for one authoritative room: the build handshake, seats held for a reconnect, the idle
 * kick with its countdown, per-socket rate limiting, the input jitter buffer and the fixed tick that broadcasts
 * events, roster changes and snapshots. A game subclasses `RoomCore` with its World; the Durable Object wrapper
 * (`@arcade/kit/server/room-object`) only moves bytes.
 *
 * Seats come from `./seats`: everyone sees a seat's public `id`, only its owner gets the `token` that reclaims it, so
 * knowing someone's id is never enough to take their seat. Intents go through a `./jitter-buffer` per seat, which
 * hands the World one input per tick and carries one-shot edges (casts, trigger presses) forward instead of dropping
 * them when a burst arrives after a stall.
 *
 * Runs in Workers, Bun tests and browsers: no DOM or Worker APIs.
 */
import { JitterBuffer, type InputOps, type JitterConfig, socketJitter } from "./jitter-buffer"
import { Seats } from "./seats"
import { decodeVoiceClient, type VoiceRoom } from "./voice"

export type RoomLocationHint = "wnam" | "enam" | "weur" | "eeur" | "apac" | "oc" | "sam" | "afr" | "me"

const WEST_US_CA = new Set(["CA", "OR", "WA", "NV", "AZ", "UT", "ID", "MT", "WY", "AK", "HI", "BC", "AB", "YT"])
const EAST_EU = new Set(["PL", "CZ", "SK", "HU", "RO", "BG", "UA", "EE", "LV", "LT", "FI", "GR", "HR", "RS", "SI"])
const MIDDLE_EAST = new Set(["AE", "SA", "IL", "QA", "KW", "BH", "OM", "JO", "TR"])

/**
 * Maps Cloudflare edge request metadata (`req.cf`) to the nearest Durable Object `locationHint` so a newly created
 * room spawns in the creator's region instead of across an ocean.
 */
export function roomLocationHint(req: { cf?: { continent?: string; country?: string; regionCode?: string } } | null | undefined): RoomLocationHint | undefined {
  const cf = req?.cf
  if (!cf) return undefined
  const country = cf.country?.toUpperCase()
  const region = cf.regionCode?.toUpperCase()
  if (country && MIDDLE_EAST.has(country)) return "me"
  switch (cf.continent?.toUpperCase()) {
    case "NA":
      return (country === "US" || country === "CA") && region && WEST_US_CA.has(region) ? "wnam" : "enam"
    case "EU":
      return country && EAST_EU.has(country) ? "eeur" : "weur"
    case "AS":
      return "apac"
    case "OC":
      return "oc"
    case "SA":
      return "sam"
    case "AF":
      return "afr"
    default:
      return undefined
  }
}

/** One client socket. */
export type Conn = { send(data: string): void; close(code?: number, reason?: string): void }

/** Last activity (clock ms), last aim and the countdown last sent, per player. */
export type Activity = { at: number; aim: number; warned: number }

/** Server frames every room sends, besides its game's snapshot. */
export type RoomFrame<Row, Ev> =
  /** `token` is private to this client: present it in `hello` to reclaim the seat after a drop. */
  | { type: "welcome"; id: string; token: string; room: string }
  | { type: "roster"; players: Row[] }
  | { type: "ev"; events: Ev[] }
  | { type: "error"; message: string }
  /** The server runs different shared code than this client: reload the page. */
  | { type: "reload" }
  /** Seconds until you're kicked for idling, during the warning; 0 clears it. */
  | { type: "idle"; seconds: number }
  | { type: "pong"; t: number }

/** Client frames the core handles itself; everything else goes to `handle`. */
export type RoomClientFrame<I> =
  | { type: "ping"; t: number }
  /** `build` is the client's BUILD; a mismatched client is told to reload. `token` reclaims a held seat. */
  | { type: "hello"; token?: string; build?: string }
  | { type: "intent"; seq: number; i: I; prev?: readonly I[] }

export type RoomCoreOptions<I> = {
  code: string
  /** Hash of the game's shared code (`scripts/build-id.ts`). */
  build: string
  /** The game's name, for the stale-client message. */
  title: string
  maxPlayers: number
  /** Ticks between snapshots. */
  snapEvery: number
  /** How intents merge and stand in (`./jitter-buffer`): which fields are one-shot edges. */
  inputs: InputOps<I>
  /** Defaults to `ROOM_JITTER`. */
  jitter?: JitterConfig
  clock?: () => number
  /** A dropped player's seat (and score) is kept this long for a reconnect. */
  graceMs?: number
  /** No input for this long while able to play gets you kicked; a warning shows for the last `idleWarnMs`. */
  idleKickMs?: number
  idleWarnMs?: number
  /** Per-socket message budget: a token bucket refilled at `msgRate` per second, holding at most `msgBurst`. */
  msgRate?: number
  msgBurst?: number
}

export const DEFAULT_GRACE_MS = 15_000
export const DEFAULT_IDLE_KICK_MS = 90_000
export const DEFAULT_IDLE_WARN_MS = 15_000
/**
 * The jitter buffer for 30 Hz rooms over a WebSocket (`socketJitter`): one or two ticks deep, sized from how late
 * inputs actually arrive rather than grown after every TCP stall. Wi-Fi profile (`scripts/bench-netcode.ts`): press to
 * server p50 100 → 67 ms in Blackout, no presses lost.
 */
export const ROOM_JITTER: JitterConfig = socketJitter(30)
/** Clients send one intent per 30 Hz tick; four times that leaves room for pings and menu frames. */
export const DEFAULT_MSG_RATE = 120
export const DEFAULT_MSG_BURST = 240

/** Whether idle time counts for a player now: "gone" (no such player), "rest" (end screen, dead) or "play". */
export type IdleState = "gone" | "rest" | "play"

type SeatData<I> = { activity: Activity; jitter: JitterBuffer<I> }
type ConnState = { id: string | null; tokens: number; at: number }

export abstract class RoomCore<C extends { type: string }, I, Row, Ev, Ents, Snap> {
  /** Games opt in; only authenticated seats can signal, and disconnects destroy voice membership immediately. */
  voice: VoiceRoom | null = null
  readonly code: string
  protected readonly clock: () => number
  private readonly opts: Required<Omit<RoomCoreOptions<I>, "clock" | "code">>
  private readonly seats: Seats<SeatData<I>>
  private conns = new Map<Conn, ConnState>()
  private rosterKey = ""
  private ticks = 0

  constructor(options: RoomCoreOptions<I>) {
    this.code = options.code
    this.clock = options.clock ?? Date.now
    this.opts = {
      build: options.build,
      title: options.title,
      maxPlayers: options.maxPlayers,
      snapEvery: options.snapEvery,
      inputs: options.inputs,
      jitter: options.jitter ?? ROOM_JITTER,
      graceMs: options.graceMs ?? DEFAULT_GRACE_MS,
      idleKickMs: options.idleKickMs ?? DEFAULT_IDLE_KICK_MS,
      idleWarnMs: options.idleWarnMs ?? DEFAULT_IDLE_WARN_MS,
      msgRate: options.msgRate ?? DEFAULT_MSG_RATE,
      msgBurst: options.msgBurst ?? DEFAULT_MSG_BURST,
    }
    this.seats = new Seats(options.maxPlayers, this.opts.graceMs, this.clock)
  }

  /** Validates an untrusted client frame. */
  protected abstract decode(raw: unknown): (C | RoomClientFrame<I>) | null
  protected abstract encode(msg: RoomFrame<Row, Ev> | Snap): string
  /** Whether a player with this id is still in the world (a held seat). */
  protected abstract hasPlayer(id: string): boolean
  /** Seats a new human. */
  protected abstract join(id: string, hello: Extract<C | RoomClientFrame<I>, { type: "hello" }>): void
  /** Removes a player for good (seat expired, idle kick) and tops the room back up. */
  protected abstract leave(id: string): void
  /**
   * The intent to apply for a player this tick, called at most once per player per tick just before `stepWorld`.
   * `seq` is the last client sequence it covers (the snapshot's ack). After a reconnect the client's sequence may
   * start again from the beginning.
   */
  protected abstract push(id: string, seq: number, intent: I): void
  /** Whether an intent counts as activity; may update `a.aim`. */
  protected abstract activity(intent: I, a: Activity): boolean
  /** Any other frame from a seated player. */
  protected abstract handle(id: string, msg: C): void
  protected abstract idleState(id: string): IdleState
  protected abstract stepWorld(): void
  protected abstract takeEvents(): Ev[]
  protected abstract roster(): Row[]
  /** One broadcast's public entities, shared by every viewer's snapshot. */
  protected abstract entities(): Ents
  /** A viewer's snapshot; without `entities` it builds its own. */
  protected abstract snapshot(id: string, entities?: Ents): Snap

  /** Open sockets, seated or not. */
  get connections(): number {
    return this.conns.size
  }

  /** A socket was accepted (before its hello), so the room counts it while it handshakes. */
  open(conn: Conn): void {
    if (!this.conns.has(conn)) this.conns.set(conn, { id: null, tokens: this.opts.msgBurst, at: this.clock() })
  }

  message(conn: Conn, raw: unknown): void {
    this.open(conn)
    const state = this.conns.get(conn)!
    const now = this.clock()
    state.tokens = Math.min(this.opts.msgBurst, state.tokens + ((now - state.at) / 1000) * this.opts.msgRate)
    state.at = now
    if (state.tokens < 1) return
    state.tokens--
    const voice = this.voice && decodeVoiceClient(raw)
    if (voice) {
      if (state.id && this.seats.byId(state.id)?.connected) this.voice!.message(state.id, voice, (m) => conn.send(JSON.stringify(m)))
      return
    }
    const msg = this.decode(raw)
    if (msg) this.dispatch(conn, state, msg)
  }

  private dispatch(conn: Conn, state: ConnState, msg: C | RoomClientFrame<I>): void {
    if (msg.type === "ping") return conn.send(this.encode({ type: "pong", t: (msg as { t: number }).t }))
    if (msg.type === "hello") return this.hello(conn, state, msg as Extract<C | RoomClientFrame<I>, { type: "hello" }>)
    const seat = state.id ? this.seats.byId(state.id) : undefined
    if (!seat) return
    if (msg.type === "intent") {
      const { seq, i, prev } = msg as { seq: number; i: I; prev?: readonly I[] }
      if (prev?.length) {
        const base = seq - prev.length
        for (let k = 0; k < prev.length; k++) if (base + k > 0) seat.data.jitter.push(base + k, prev[k]!, this.ticks)
      }
      if (this.activity(i, seat.data.activity)) seat.data.activity.at = this.clock()
      seat.data.jitter.push(seq, i, this.ticks)
      return
    }
    seat.data.activity.at = this.clock()
    this.handle(seat.id, msg as C)
  }

  private hello(conn: Conn, state: ConnState, msg: Extract<C | RoomClientFrame<I>, { type: "hello" }>): void {
    if (state.id) return
    const { build, token } = msg as { build?: string; token?: string }
    // A client built from different shared code (protocol, simulation) must reload before it can play here.
    if (build !== this.opts.build) {
      conn.send(this.encode(build ? { type: "reload" } : { type: "error", message: `A new version of ${this.opts.title} is out. Reload the page.` }))
      conn.close(4003, "stale client")
      return
    }
    // Only a seat whose owner dropped is reclaimed: a second tab carrying the same token gets a seat of its own.
    const held = token ? this.seats.all.find((s) => s.token === token) : undefined
    const resume = !!held && !held.connected && this.hasPlayer(held.id)
    if (held && !held.connected && !resume) this.seats.remove(held.id)
    const fresh = () => ({ activity: { at: this.clock(), aim: 0, warned: 0 }, jitter: new JitterBuffer(this.opts.inputs, this.opts.jitter) })
    const joined = this.seats.join("", resume ? token : undefined, fresh)
    if (!joined.ok) {
      conn.send(this.encode({ type: "error", message: `Room ${this.code} is full.` }))
      conn.close(4001, "room full")
      return
    }
    const seat = joined.seat
    if (joined.resumed) seat.data = fresh()
    else this.join(seat.id, msg)
    state.id = seat.id
    conn.send(this.encode({ type: "welcome", id: seat.id, token: seat.token, room: this.code }))
    conn.send(this.encode({ type: "roster", players: this.roster() }))
    conn.send(this.encode(this.snapshot(seat.id)))
  }

  close(conn: Conn): void {
    const state = this.conns.get(conn)
    this.conns.delete(conn)
    if (!state?.id) return
    this.voice?.leave(state.id)
    this.seats.leave(state.id)
    this.dropped(state.id)
  }

  /** A seated player's socket closed; the seat is held for `graceMs` (`leave` follows if they don't come back). */
  protected dropped(_id: string): void {}

  /** Kicks players who haven't touched the controls for `idleKickMs` while able to play, with a countdown at the end. */
  private idle(now: number): void {
    const { idleKickMs, idleWarnMs } = this.opts
    for (const [conn, state] of [...this.conns]) {
      const seat = state.id ? this.seats.byId(state.id) : undefined
      const idle = seat ? this.idleState(seat.id) : "gone"
      if (!seat || idle === "gone") continue
      const a = seat.data.activity
      if (idle === "rest") {
        a.at = now
        continue
      }
      const left = idleKickMs - (now - a.at)
      if (left <= 0) {
        conn.send(this.encode({ type: "error", message: "You were kicked for being idle." }))
        conn.close(4002, "idle")
        this.conns.delete(conn)
        this.voice?.leave(seat.id)
        this.seats.remove(seat.id)
        this.leave(seat.id)
        continue
      }
      const secs = left <= idleWarnMs ? Math.ceil(left / 1000) : 0
      if (secs !== a.warned) {
        a.warned = secs
        conn.send(this.encode({ type: "idle", seconds: secs }))
      }
    }
  }

  step(): void {
    const now = this.clock()
    for (const seat of this.seats.expire()) this.leave(seat.id)
    this.idle(now)
    for (const seat of this.seats.all) {
      const jitter = seat.data.jitter
      const got = jitter.take(this.ticks)
      // Catching up hands over two inputs: the later one's movement with both one-shot edges.
      if (got.length) this.push(seat.id, jitter.ack, got.length === 1 ? got[0]! : this.opts.inputs.merge(got[0]!, got[1]!))
    }
    this.stepWorld()
    this.ticks++
    const events = this.takeEvents()
    const roster = this.roster()
    const key = JSON.stringify(roster)
    const rosterChanged = key !== this.rosterKey
    this.rosterKey = key
    const entities = this.ticks % this.opts.snapEvery === 0 ? this.entities() : null
    for (const [conn, state] of this.conns) {
      if (!state.id) continue
      if (events.length) conn.send(this.encode({ type: "ev", events }))
      if (rosterChanged) conn.send(this.encode({ type: "roster", players: roster }))
      if (entities) conn.send(this.encode(this.snapshot(state.id, entities)))
    }
  }
}
