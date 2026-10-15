/**
 * Transport-free seat keeping for one authoritative room: the build handshake, seats held for a reconnect, the idle
 * kick with its countdown, and the fixed tick that broadcasts events, roster changes and snapshots. A game subclasses
 * `RoomCore` with its World; the Durable Object wrapper (`@arcade/kit/server/room-object`) only moves bytes.
 * Runs in Workers, Bun tests and browsers: no DOM or Worker APIs.
 */

/** One client socket. */
export type Conn = { send(data: string): void; close(code?: number, reason?: string): void }

/** Last activity (clock ms), last aim and the countdown last sent, per player. */
export type Activity = { at: number; aim: number; warned: number }

/** Server frames every room sends, besides its game's snapshot. */
export type RoomFrame<Row, Ev> =
  | { type: "welcome"; id: string; room: string }
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
  /** `build` is the client's BUILD; a mismatched client is told to reload. `id` reclaims a held seat. */
  | { type: "hello"; id?: string; build?: string }
  | { type: "intent"; seq: number; i: I }

export type RoomCoreOptions = {
  code: string
  /** Hash of the game's shared code (`scripts/build-id.ts`). */
  build: string
  /** The game's name, for the stale-client message. */
  title: string
  maxPlayers: number
  /** Ticks between snapshots. */
  snapEvery: number
  clock?: () => number
  /** A dropped player's seat (and score) is kept this long for a reconnect. */
  graceMs?: number
  /** No input for this long while able to play gets you kicked; a warning shows for the last `idleWarnMs`. */
  idleKickMs?: number
  idleWarnMs?: number
}

export const DEFAULT_GRACE_MS = 15_000
export const DEFAULT_IDLE_KICK_MS = 90_000
export const DEFAULT_IDLE_WARN_MS = 15_000
/** Per-socket message budget (token bucket). Clients send ~30 intents/s; 120/s with burst 240 allows headroom without enabling spam. */
const MSG_RATE = 120
const MSG_BURST = 240

/** Whether idle time counts for a player now: "gone" (no such player), "rest" (end screen, dead) or "play". */
export type IdleState = "gone" | "rest" | "play"

const newId = () => (Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).slice(0, 10)

export abstract class RoomCore<C extends { type: string }, I, Row, Ev, Ents, Snap> {
  readonly code: string
  protected readonly clock: () => number
  private readonly opts: Required<Omit<RoomCoreOptions, "clock" | "code">>
  private conns = new Map<Conn, string>()
  private gone = new Map<string, number>()
  private rosterKey = ""
  private ticks = 0
  private active = new Map<string, Activity>()
  /** Token-bucket rate limit per connection (anti-spam / DoS). */
  private rateStates = new Map<Conn, { tokens: number; at: number }>()

  constructor(options: RoomCoreOptions) {
    this.code = options.code
    this.clock = options.clock ?? Date.now
    this.opts = {
      build: options.build,
      title: options.title,
      maxPlayers: options.maxPlayers,
      snapEvery: options.snapEvery,
      graceMs: options.graceMs ?? DEFAULT_GRACE_MS,
      idleKickMs: options.idleKickMs ?? DEFAULT_IDLE_KICK_MS,
      idleWarnMs: options.idleWarnMs ?? DEFAULT_IDLE_WARN_MS,
    }
  }

  /** Validates an untrusted client frame. */
  protected abstract decode(raw: unknown): (C | RoomClientFrame<I>) | null
  protected abstract encode(msg: RoomFrame<Row, Ev> | Snap): string
  /** Humans holding a seat. */
  protected abstract humanCount(): number
  /** Whether a player with this id is still in the world (a held seat). */
  protected abstract hasPlayer(id: string): boolean
  /** Seats a new human. */
  protected abstract join(id: string, hello: Extract<C | RoomClientFrame<I>, { type: "hello" }>): void
  /** Removes a player for good (seat expired, idle kick) and tops the room back up. */
  protected abstract leave(id: string): void
  /** Queues an intent. */
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

  get connections(): number {
    return this.conns.size
  }

  message(conn: Conn, raw: unknown): void {
    // Token-bucket rate limit: drop excess messages to prevent spam/DoS on the Durable Object.
    let state = this.rateStates.get(conn)
    const now = this.clock()
    if (!state) {
      state = { tokens: MSG_BURST, at: now }
      this.rateStates.set(conn, state)
    } else {
      state.tokens = Math.min(MSG_BURST, state.tokens + ((now - state.at) / 1000) * MSG_RATE)
      state.at = now
    }
    if (state.tokens < 1) return
    state.tokens--
    const msg = this.decode(raw)
    if (msg) this.dispatch(conn, msg)
  }

  private dispatch(conn: Conn, msg: C | RoomClientFrame<I>): void {
    if (msg.type === "ping") return conn.send(this.encode({ type: "pong", t: (msg as { t: number }).t }))
    if (msg.type === "hello") return this.hello(conn, msg as Extract<C | RoomClientFrame<I>, { type: "hello" }>)
    const id = this.conns.get(conn)
    if (!id) return
    if (msg.type === "intent") {
      const { seq, i } = msg as { seq: number; i: I }
      const a = this.active.get(id)
      if (a && this.activity(i, a)) a.at = this.clock()
      this.push(id, seq, i)
      return
    }
    this.touch(id)
    this.handle(id, msg as C)
  }

  private hello(conn: Conn, msg: Extract<C | RoomClientFrame<I>, { type: "hello" }>): void {
    if (this.conns.has(conn)) return
    const { build, id: claim } = msg as { build?: string; id?: string }
    // A client built from different shared code (protocol, simulation) must reload before it can play here.
    if (build !== this.opts.build) {
      conn.send(this.encode(build ? { type: "reload" } : { type: "error", message: `A new version of ${this.opts.title} is out. Reload the page.` }))
      conn.close(4003, "stale client")
      return
    }
    let id = claim && this.gone.has(claim) && this.hasPlayer(claim) ? claim : undefined
    if (id) this.gone.delete(id)
    else {
      if (this.humanCount() >= this.opts.maxPlayers) {
        conn.send(this.encode({ type: "error", message: `Room ${this.code} is full.` }))
        conn.close(4001, "room full")
        return
      }
      id = newId()
      this.join(id, msg)
    }
    this.conns.set(conn, id)
    this.active.set(id, { at: this.clock(), aim: 0, warned: 0 })
    conn.send(this.encode({ type: "welcome", id, room: this.code }))
    conn.send(this.encode({ type: "roster", players: this.roster() }))
    conn.send(this.encode(this.snapshot(id)))
  }

  close(conn: Conn): void {
    const id = this.conns.get(conn)
    this.conns.delete(conn)
    this.rateStates.delete(conn)
    if (id && ![...this.conns.values()].includes(id)) this.gone.set(id, this.clock())
  }

  private touch(id: string): void {
    const a = this.active.get(id)
    if (a) a.at = this.clock()
  }

  /** Kicks players who haven't touched the controls for `idleKickMs` while able to play, with a countdown at the end. */
  private idle(now: number): void {
    const { idleKickMs, idleWarnMs } = this.opts
    for (const [conn, id] of [...this.conns]) {
      const a = this.active.get(id)
      const state = this.idleState(id)
      if (!a || state === "gone") continue
      if (state === "rest") {
        a.at = now
        continue
      }
      const left = idleKickMs - (now - a.at)
      if (left <= 0) {
        conn.send(this.encode({ type: "error", message: "You were kicked for being idle." }))
        conn.close(4002, "idle")
        this.conns.delete(conn)
        this.active.delete(id)
        this.gone.delete(id)
        this.leave(id)
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
    for (const [id, at] of this.gone) {
      if (now - at < this.opts.graceMs) continue
      this.gone.delete(id)
      this.active.delete(id)
      this.leave(id)
    }
    this.idle(now)
    this.stepWorld()
    this.ticks++
    const events = this.takeEvents()
    const roster = this.roster()
    const key = JSON.stringify(roster)
    const rosterChanged = key !== this.rosterKey
    this.rosterKey = key
    const entities = this.ticks % this.opts.snapEvery === 0 ? this.entities() : null
    for (const [conn, id] of this.conns) {
      if (events.length) conn.send(this.encode({ type: "ev", events }))
      if (rosterChanged) conn.send(this.encode({ type: "roster", players: roster }))
      if (entities) conn.send(this.encode(this.snapshot(id, entities)))
    }
  }
}
