import { RoomSocket, rejoinKey } from "@arcade/kit/net/room-socket"
import { BUILD } from "../shared/build.gen"
import { DT, GAME, SNAPSHOT_HZ, TICK_HZ } from "../shared/config"
import { type ClientMsg, type ServerMsg, decodeServer, encodeClient } from "../shared/protocol"
import { type RosterRow, type Snapshot, buildSnapshot, rosterOf } from "../shared/view"
import { type SimEvent, World } from "../shared/world"

/** Set before a version reload: main.ts rejoins this room without the landing page. */
export const REJOIN_KEY = rejoinKey(GAME.id)

/** What the game loop needs from a match, whether it runs in this tab or in a room on the server. */
export interface Session {
  readonly room: string | null
  readonly myId: string
  /** Latest snapshot and when it arrived (performance.now() ms). */
  latest(): { snap: Snapshot; at: number } | null
  roster(): RosterRow[]
  drainEvents(): SimEvent[]
  send(msg: ClientMsg): void
  status(): string | null
  /** Called every frame; the local session advances its world here. */
  update(dt: number): void
  close(): void
}

/**
 * Practice against bots without a server: the same World runs in the tab. `watch` leaves you out (bots only), for
 * attract mode and captures.
 */
export class LocalSession implements Session {
  readonly room = null
  readonly myId: string
  readonly world: World
  private acc = 0
  private snap: { snap: Snapshot; at: number } | null = null
  private events: SimEvent[] = []
  private every = Math.max(1, Math.round(TICK_HZ / SNAPSHOT_HZ))
  /** Simulation speed (the Lab slows it down). */
  speed = 1

  constructor(name: string, opts: { pick?: string; bots?: number; watch?: boolean; seed?: number } = {}) {
    this.world = new World(opts.seed ?? (Math.random() * 2 ** 31) | 0)
    this.world.botFill = opts.bots ?? 4
    this.myId = opts.watch ? "" : "you"
    if (opts.watch) {
      this.world.fill()
      this.world.startRound()
    } else this.world.addHuman(this.myId, name, opts.pick)
    this.publish()
    ;(globalThis as { practice?: World }).practice = this.world
  }

  latest() {
    return this.snap
  }

  roster(): RosterRow[] {
    return rosterOf(this.world)
  }

  drainEvents(): SimEvent[] {
    const e = this.events
    this.events = []
    return e
  }

  send(msg: ClientMsg): void {
    if (msg.type === "intent") this.world.push(this.myId, msg.seq, msg.i)
    else if (msg.type === "pick") this.world.pick(this.myId, msg.char)
    else if (msg.type === "ready") this.world.setReady(this.myId, msg.ready)
  }

  status(): string | null {
    return null
  }

  update(dt: number): void {
    this.acc = Math.min(this.acc + dt * this.speed, DT * 6)
    while (this.acc >= DT) {
      this.acc -= DT
      this.world.step()
      // Watching: straight into the next round instead of waiting on the select screen.
      if (!this.myId && this.world.phase === "select") this.world.startRound()
      this.events.push(...this.world.takeEvents())
      if (this.world.tick % this.every === 0) this.publish()
    }
  }

  private publish(): void {
    this.snap = { snap: buildSnapshot(this.world, this.myId), at: performance.now() }
  }

  close(): void {}
}

/** A room on the server (`@arcade/kit/net/room-socket`). Reconnects with the same id and keeps the seat. */
export class NetSession implements Session {
  private socket: RoomSocket<ClientMsg>
  private snap: { snap: Snapshot; at: number } | null = null
  private players: RosterRow[] = []
  private events: SimEvent[] = []

  constructor(readonly room: string, name: string, private pick: string, onFatal: (message: string) => void, priv = false) {
    this.socket = new RoomSocket<ClientMsg>({
      game: GAME.id,
      room,
      query: { private: priv ? "1" : null },
      hello: (id) => ({ type: "hello", name, id, build: BUILD, pick: this.pick || undefined }),
      receive: (msg) => this.receive(msg as ServerMsg),
      fatal: onFatal,
      encode: (msg) => encodeClient(msg as ClientMsg),
      decode: decodeServer,
    })
  }

  get myId(): string {
    return this.socket.id
  }

  latest() {
    return this.snap
  }

  roster(): RosterRow[] {
    return this.players
  }

  drainEvents(): SimEvent[] {
    const e = this.events
    this.events = []
    return e
  }

  send(msg: ClientMsg): void {
    if (msg.type === "pick") this.pick = msg.char
    this.socket.send(msg)
  }

  status(): string | null {
    return this.socket.status()
  }

  update(): void {}

  close(): void {
    this.socket.close()
  }

  private receive(msg: ServerMsg): void {
    if (msg.type === "snap") this.snap = { snap: msg, at: performance.now() }
    else if (msg.type === "roster") this.players = msg.players
    else if (msg.type === "ev") this.events.push(...msg.events)
  }
}
