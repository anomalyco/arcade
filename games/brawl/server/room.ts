import { type Activity, type IdleState, RoomCore as SharedRoomCore } from "@arcade/kit/net/room-core"
import { seedOf } from "@arcade/kit/sim/rng"
import { RoomObject } from "@arcade/kit/server/room-object"
import { BUILD } from "../shared/build.gen"
import { GAME, MAX_PLAYERS, SNAPSHOT_HZ, TICK_HZ } from "../shared/config"
import { type ClientMsg, type ServerMsg, decodeClient, encodeServer } from "../shared/protocol"
import { type RosterRow, type Snapshot, buildSnapshot, rosterOf, snapshotEntities } from "../shared/view"
import { type Intent, type SimEvent, World } from "../shared/world"
import { type Env, lobbyOf } from "./env"
import type { RoomReport } from "./lobby"

type Ents = ReturnType<typeof snapshotEntities>

/** One room's match. Seats, reconnects, the idle kick and broadcasting come from `@arcade/kit/net/room-core`. */
export class RoomCore extends SharedRoomCore<ClientMsg, Intent, RosterRow, SimEvent, Ents, Snapshot> {
  readonly world: World

  constructor(code: string, clock: () => number = Date.now) {
    super({ code, build: BUILD, title: GAME.title, maxPlayers: MAX_PLAYERS, snapEvery: Math.max(1, Math.round(TICK_HZ / SNAPSHOT_HZ)), clock })
    this.world = new World(seedOf(code))
  }

  protected decode(raw: unknown) {
    return decodeClient(raw)
  }
  protected encode(msg: ServerMsg) {
    return encodeServer(msg)
  }
  protected humanCount() {
    return this.world.humans.length
  }
  protected hasPlayer(id: string) {
    return this.world.players.has(id)
  }
  protected join(id: string, msg: Extract<ClientMsg, { type: "hello" }>) {
    this.world.addHuman(id, msg.name, msg.pick)
  }
  protected leave(id: string) {
    this.world.remove(id)
    this.world.fill()
  }
  protected push(id: string, seq: number, i: Intent) {
    this.world.push(id, seq, i)
  }
  protected activity(i: Intent, a: Activity) {
    const active = !!(i.mx || i.my || i.cast >= 0 || Math.abs(i.aim - a.aim) > 0.05)
    a.aim = i.aim
    return active
  }
  protected handle(id: string, msg: ClientMsg) {
    if (msg.type === "pick") this.world.pick(id, msg.char)
    else if (msg.type === "ready") this.world.setReady(id, msg.ready)
  }
  /** Only time on stage counts toward the idle kick. */
  protected idleState(id: string): IdleState {
    const f = this.world.players.get(id)
    if (!f) return "gone"
    return this.world.phase === "play" && f.alive && !f.fallAt ? "play" : "rest"
  }
  protected stepWorld() {
    this.world.step()
  }
  protected takeEvents() {
    return this.world.takeEvents()
  }
  protected roster() {
    return rosterOf(this.world)
  }
  protected entities() {
    return snapshotEntities(this.world)
  }
  protected snapshot(id: string, entities?: Ents) {
    return buildSnapshot(this.world, id, entities)
  }
}

/** One Durable Object per room code (`@arcade/kit/server/room-object`). */
export class Room extends RoomObject<Env, RoomCore, RoomReport> {
  protected readonly tickMs = 1000 / TICK_HZ
  private priv: boolean | null = null

  protected async open(code: string, url: URL): Promise<RoomCore> {
    const core = (this.core ??= new RoomCore(code))
    this.priv ??= (await this.ctx.storage.get<boolean>("private")) ?? false
    if (!this.priv && core.connections === 0 && url.searchParams.get("private") === "1") {
      this.priv = true
      await this.ctx.storage.put("private", true)
    }
    return core
  }

  protected report(core: RoomCore, empty: boolean): RoomReport {
    return { code: core.code, players: empty ? 0 : core.world.humans.length, phase: core.world.phase, private: !!this.priv }
  }

  protected send(report: RoomReport) {
    return lobbyOf(this.env).report(report)
  }
}
