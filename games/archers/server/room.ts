import { type Activity, type IdleState, RoomCore as SharedRoomCore } from "@arcade/kit/net/room-core"
import { InputRelay } from "@arcade/kit/net/rollback"
import { seedOf } from "@arcade/kit/sim/rng"
import { RoomObject } from "@arcade/kit/server/room-object"
import { ARENAS } from "../shared/arena"
import { BUILD } from "../shared/build.gen"
import { GAME, MAX_PLAYERS, TICK_HZ } from "../shared/config"
import { SLOT_NAMES, hashWorld, newMatch, runFrame } from "../shared/match"
import { type ClientMsg, type Cmd, type Frame, HASH_EVERY, type RosterRow, type ServerMsg, cleanName, decodeClient, emptyInputs, encodeServer } from "../shared/protocol"
import type { World } from "../shared/world"
import { type Env, lobbyOf } from "./env"
import type { RoomReport } from "./lobby"

type Ents = { t: number; i: number[]; c?: Cmd[]; h?: number }

/** RoomCore's intent path (a jitter buffer per seat) goes unused: buttons arrive tick-stamped as `in` frames. */
const NO_INTENTS = { merge: (_a: number, b: number) => b, standIn: (b: number) => b, hasEdges: () => false }

/**
 * One room's match: the input authority for rollback. Seats, reconnects, rate limits and the idle kick come from
 * `@arcade/kit/net/room-core`; each tick it takes every person's buttons from the `InputRelay` (late ones a tick
 * later, missing ones held), runs the world, and sends everyone that frame. A client that joins, comes back or
 * falls out of step gets the whole world instead.
 */
export class RoomCore extends SharedRoomCore<ClientMsg, number, RosterRow, never, Ents, ServerMsg> {
  readonly world: World
  private readonly relay = new InputRelay<number>()
  private readonly slots = new Map<string, number>()
  private pending: Cmd[] = []
  private frame: Frame = { i: emptyInputs() }
  private hash: number | undefined
  private readonly full = new Set<string>()

  constructor(code: string, arena = "belltower", clock: () => number = Date.now) {
    super({ code, build: BUILD, title: GAME.title, maxPlayers: MAX_PLAYERS, snapEvery: 1, inputs: NO_INTENTS, clock })
    this.world = newMatch(seedOf(code), arena)
  }

  get humans(): number {
    return this.slots.size
  }

  protected decode(raw: unknown) {
    return decodeClient(raw)
  }
  protected encode(msg: ServerMsg) {
    return encodeServer(msg)
  }
  protected hasPlayer(id: string) {
    return this.slots.has(id)
  }
  protected join(id: string, msg: Extract<ClientMsg, { type: "hello" }>) {
    const used = new Set(this.slots.values())
    let slot = 0
    while (used.has(slot)) slot++
    this.slots.set(id, slot)
    this.relay.release(slot)
    this.pending.push({ k: "seat", slot, name: cleanName(msg.name, SLOT_NAMES[slot]!), human: true })
  }
  protected leave(id: string) {
    const slot = this.slots.get(id)
    if (slot === undefined) return
    this.slots.delete(id)
    this.relay.release(slot)
    this.pending.push({ k: "seat", slot, name: SLOT_NAMES[slot]!, human: false })
  }
  /** A dropped player's archer lets go of everything while their seat is held. */
  protected override dropped(id: string) {
    const slot = this.slots.get(id)
    if (slot !== undefined) this.relay.release(slot)
  }
  protected push() {}
  protected activity(_i: number, _a: Activity) {
    return false
  }
  protected handle(id: string, msg: ClientMsg) {
    const slot = this.slots.get(id)
    if (slot === undefined) return
    if (msg.type === "in") this.relay.receive(slot, msg.t, msg.b, this.world.s.tick)
    else if (msg.type === "resync") this.full.add(id)
  }
  protected idleState(id: string): IdleState {
    const slot = this.slots.get(id)
    if (slot === undefined) return "gone"
    const a = this.world.s.archers.find((x) => x.slot === slot)
    return this.world.s.phase === "play" && a?.alive ? "play" : "rest"
  }
  protected stepWorld() {
    const t = this.world.s.tick + 1
    const i = emptyInputs()
    for (const slot of this.slots.values()) i[slot] = this.relay.take(slot, t)
    this.frame = this.pending.length ? { i, c: this.pending } : { i }
    this.pending = []
    runFrame(this.world, this.frame)
    this.hash = t % HASH_EVERY === 0 ? hashWorld(this.world) : undefined
  }
  protected takeEvents(): never[] {
    return []
  }
  protected roster(): RosterRow[] {
    return [...this.slots].map(([id, slot]) => ({ id, slot, name: this.world.s.archers.find((a) => a.slot === slot)?.name ?? SLOT_NAMES[slot]! }))
  }
  protected entities(): Ents {
    const f = this.frame
    return { t: this.world.s.tick, i: f.i, ...(f.c ? { c: f.c } : {}), ...(this.hash !== undefined ? { h: this.hash } : {}) }
  }
  protected snapshot(id: string, ents?: Ents): ServerMsg {
    if (!ents || this.full.delete(id)) return { type: "state", t: this.world.s.tick, s: this.world.s, i: this.frame.i }
    const slot = this.slots.get(id)
    const a = slot === undefined ? [] : this.relay.drain(slot)
    return a.length ? { type: "f", ...ents, a } : { type: "f", ...ents }
  }
}

/** One Durable Object per room code (`@arcade/kit/server/room-object`), ticking at the sim's 60 Hz. */
export class Room extends RoomObject<Env, RoomCore, RoomReport> {
  protected readonly tickMs = 1000 / TICK_HZ
  private priv: boolean | null = null

  protected async open(code: string, url: URL): Promise<RoomCore> {
    const arena = url.searchParams.get("arena") ?? ""
    const core = (this.core ??= new RoomCore(code, ARENAS[arena] ? arena : "belltower"))
    this.priv ??= (await this.ctx.storage.get<boolean>("private")) ?? false
    if (!this.priv && core.connections === 0 && url.searchParams.get("private") === "1") {
      this.priv = true
      await this.ctx.storage.put("private", true)
    }
    return core
  }

  protected report(core: RoomCore, empty: boolean): RoomReport {
    return { code: core.code, players: empty ? 0 : core.humans, phase: core.world.s.phase, private: !!this.priv }
  }

  protected send(report: RoomReport) {
    return lobbyOf(this.env).report(report)
  }
}
