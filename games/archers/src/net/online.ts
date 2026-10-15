import { RollbackClient, TickPacer } from "@arcade/kit/net/rollback"
import { RoomSocket } from "@arcade/kit/net/room-socket"
import { BUILD } from "../../shared/build.gen"
import { GAME, TICK_HZ } from "../../shared/config"
import { hashWorld, rollbackSim } from "../../shared/match"
import { type ClientMsg, type Frame, type RosterRow, type ServerMsg, decodeServer, encodeClient } from "../../shared/protocol"
import type { Buttons } from "../../shared/input"
import { DEFAULT_TUNING } from "../../shared/tuning"
import { type SimEvent, World } from "../../shared/world"

const TICK_MS = 1000 / TICK_HZ
/** While something is held, resend it this often so the room keeps measuring how early inputs arrive. */
const HEARTBEAT_TICKS = 6
const PING_MS = 2000

/**
 * This tab's seat in an online room: the socket, the rollback client and its pacer. Each frame `update` runs the
 * local fixed step up to the pacer's head, sending buttons as they change, and returns the events to show.
 */
export class OnlineSession {
  readonly socket: RoomSocket<ClientMsg>
  readonly rb = new RollbackClient(rollbackSim(() => this.slot))
  readonly pacer = new TickPacer(TICK_MS)
  roster: RosterRow[] = []
  slot = -1
  /** Smoothed round trip, ms. */
  rtt = 0
  desyncs = 0
  /** For proofs: frames run, the last slack the room reported, and how far the head ran past the confirmed tick. */
  readonly stats = { frames: 0, slack: [] as number[], ahead: [] as number[], arrivals: [] as number[], lead: [] as number[], room: [] as number[], speed: [] as number[] }
  fatal: string | null = null
  private helloAt = 0
  private held = -1
  private waitingState = false
  private pingAt = 0
  private pending: SimEvent[] = []

  constructor(
    readonly room: string,
    name: string | undefined,
    query: Record<string, string | null> = {},
  ) {
    this.socket = new RoomSocket<ClientMsg>({
      game: GAME.id,
      room,
      query,
      hello: (token) => {
        this.helloAt = performance.now()
        return { type: "hello", token, build: BUILD, ...(name ? { name } : {}) }
      },
      receive: (m) => this.receive(m as ServerMsg),
      fatal: (message) => (this.fatal = message),
      encode: (m) => encodeClient(m as ClientMsg),
      decode: decodeServer,
      pong: (t) => this.sample(Date.now() - t),
    })
  }

  get ready(): boolean {
    return this.rb.ready
  }

  /** The world to draw: the prediction at the head tick. */
  get world(): World {
    return this.rb.state
  }

  get id(): string {
    return this.slot >= 0 ? `a${this.slot}` : ""
  }

  private sample(ms: number): void {
    this.rtt = this.rtt ? this.rtt * 0.8 + ms * 0.2 : ms
  }

  private receive(m: ServerMsg): void {
    switch (m.type) {
      case "roster":
        this.roster = m.players
        this.slot = m.players.find((p) => p.id === this.socket.id)?.slot ?? -1
        return
      case "state":
        this.rb.reset(new World(m.s, DEFAULT_TUNING), m.t, { i: m.i })
        if (!this.waitingState || !this.rtt) {
          if (!this.rtt) this.sample(performance.now() - this.helloAt)
          this.pacer.start(m.t, this.rtt, performance.now())
        }
        this.waitingState = false
        this.held = -1
        return
      case "f": {
        if (!this.rb.ready || this.waitingState) return
        const now = performance.now()
        if (this.stats.arrivals.length < 20_000) this.stats.arrivals.push(now)
        this.pacer.frame(m.t, now)
        const frame: Frame = m.c ? { i: m.i, c: m.c } : { i: m.i }
        const ev = this.rb.confirm(m.t, frame)
        if (ev === "gap") return this.resync()
        this.pending.push(...ev)
        for (const v of m.a ?? []) {
          this.pacer.slack(v)
          if (this.stats.slack.length < 20_000) this.stats.slack.push(v)
        }
        if (m.h !== undefined && this.rb.tick === m.t && hashWorld(this.rb.confirmed) !== m.h) {
          this.desyncs++
          console.warn(`archers: world hash differs from the room's at tick ${m.t}; resyncing`)
          this.resync()
        }
        return
      }
    }
  }

  private resync(): void {
    if (this.waitingState) return
    this.waitingState = true
    this.socket.send({ type: "resync" })
  }

  /**
   * Runs the local step to the pacer's head tick. `buttons()` is read once per new tick; `after` hears
   * every simulated tick's world (including re-simulated ones). Returns the events to show.
   */
  update(buttons: () => Buttons, after?: (w: World, tick: number) => void): SimEvent[] {
    const now = performance.now()
    if (now - this.pingAt > PING_MS) {
      this.pingAt = now
      this.socket.send({ type: "ping", t: Date.now() })
    }
    const out = this.pending
    this.pending = []
    if (!this.rb.ready) return out
    this.pacer.atLeast(this.rb.tick)
    const from = this.rb.headTick
    const head = this.pacer.update(now)
    // A long stall leaves the head far ahead of what we may predict; inputs for ticks past it aren't sent.
    const until = Math.min(head, this.rb.tick + this.rb.maxAhead)
    for (let t = from + 1; t <= until; t++) {
      const b = this.slot >= 0 ? buttons() : 0
      this.rb.input(t, b)
      if (this.slot >= 0 && (b !== this.held || (b && t % HEARTBEAT_TICKS === 0))) this.socket.send({ type: "in", t, b })
      this.held = b
    }
    out.push(...this.rb.advance(until, after))
    this.stats.frames++
    if (this.stats.ahead.length < 20_000) {
      this.stats.ahead.push(this.rb.headTick - this.rb.tick)
      this.stats.lead.push(this.pacer.ahead)
      this.stats.room.push(this.pacer.room(now) - this.rb.tick)
      this.stats.speed.push(this.pacer.speed)
    }
    return out
  }

  /** How far into the next tick the head is, for drawing between ticks. */
  get fraction(): number {
    return this.rb.headTick === this.pacer.tick ? this.pacer.fraction : 1
  }

  close(): void {
    this.socket.close()
  }
}
