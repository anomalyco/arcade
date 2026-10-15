import { RoomCore as SharedRoomCore, type Activity, type IdleState, DEFAULT_IDLE_KICK_MS, DEFAULT_IDLE_WARN_MS } from "@arcade/kit/net/room-core"
import { RoomObject } from "@arcade/kit/server/room-object"
import { MAX_PLAYERS, SNAPSHOT_HZ, TICK_HZ } from "../shared/config"
import { BUILD } from "../shared/build.gen"
import { type ClientMsg, type ServerMsg, decodeClient, encodeServer } from "../shared/protocol"
import { seedOf } from "../shared/rng"
import { type MapChoice, mapChoiceOf } from "../shared/maps"
import { hostMaps, hostRestart, moveTeam, shuffleTeams } from "../shared/sim/host"
import { type ModeId, modeOf } from "../shared/sim/modes"
import { type RosterRow, type Snapshot, buildSnapshot, rosterOf, snapshotEntities } from "../shared/sim/view"
import { type Intent, type SimEvent, World } from "../shared/sim/world"
import { type Env, lobbyOf } from "./env"
import type { RoomReport } from "./matchmaking"

export type { Conn } from "@arcade/kit/net/room-core"

const TICK_MS = 1000 / TICK_HZ
const SNAP_EVERY = Math.max(1, Math.round(TICK_HZ / SNAPSHOT_HZ))
/** No input for this long while able to play gets you kicked; a warning shows for the last IDLE_WARN_MS. */
export const IDLE_KICK_MS = DEFAULT_IDLE_KICK_MS
export const IDLE_WARN_MS = DEFAULT_IDLE_WARN_MS
/** Aim changes smaller than this (radians) don't count as activity. */
const AIM_ACTIVE = 0.05

type Ents = ReturnType<typeof snapshotEntities>

/** One room's game, independent of the transport so tests can drive it. Seats and ticks: `@arcade/kit/net/room-core`. */
export class RoomCore extends SharedRoomCore<ClientMsg, Intent, RosterRow, SimEvent, Ents, Snapshot> {
  world: World

  constructor(code: string, mode: ModeId = "ffa", clock: () => number = Date.now, maps: MapChoice = "office") {
    super({ code, build: BUILD, title: "BLACKOUT", maxPlayers: MAX_PLAYERS, snapEvery: SNAP_EVERY, clock })
    this.world = new World(seedOf(code), null, mode, maps)
  }

  /** The creator's pick of what the room plays on, taken only while the room is empty: the first map follows it. */
  setMaps(maps: MapChoice): boolean {
    if (this.world.humans.length) return false
    this.world.setMaps(maps, true)
    return true
  }

  /** The creator's pick of mode, taken only while the room is empty. */
  setMode(mode: ModeId): boolean {
    if (this.world.humans.length) return false
    if (this.world.mode.id !== mode) this.world.setMode(mode)
    return true
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
    this.world.addHuman(id, msg.name, msg.gun, msg.equip)
  }

  protected leave(id: string) {
    this.world.remove(id)
    this.world.fill()
  }

  protected push(id: string, seq: number, i: Intent) {
    this.world.push(id, seq, i)
  }

  protected activity(i: Intent, a: Activity) {
    const active = !!(i.mx || i.my || i.fire || i.reload || i.equip || i.use || i.cast || i.enter || Math.abs(i.aim - a.aim) > AIM_ACTIVE)
    a.aim = i.aim
    return active
  }

  protected handle(id: string, msg: ClientMsg) {
    if (msg.type === "gun") this.world.pickGun(id, msg.gun)
    else if (msg.type === "equip") this.world.pickEquip(id, msg.equip)
    else if (msg.type === "vote") this.world.vote(id, msg.mode)
    else if (msg.type === "team") moveTeam(this.world, id, msg.id, msg.team)
    else if (msg.type === "shuffle") shuffleTeams(this.world, id)
    else if (msg.type === "spells" && id === this.world.host && this.world.spells) this.world.spells.config = msg.config
    else if (msg.type === "host" && msg.action === "maps") hostMaps(this.world, id, msg.maps)
    else if (msg.type === "host") hostRestart(this.world, id, msg.action === "mode" ? msg.mode : this.world.mode.id, msg.newFloor)
  }

  /** Time on the end screen or spent dead (waiting to respawn, or spectating after elimination) doesn't count. */
  protected idleState(id: string): IdleState {
    const p = this.world.players.get(id)
    if (!p) return "gone"
    return this.world.phase !== "play" || !p.alive ? "rest" : "play"
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

/** One Durable Object per room code (`@arcade/kit/server/room-object`): reports its seats, mode and phase to the Lobby. */
export class Room extends RoomObject<Env, RoomCore, RoomReport> {
  protected readonly tickMs = TICK_MS
  /** Made with "Create game" (reported to the Lobby; quick join still finds the room once people are in it). */
  private priv: boolean | null = null
  /** The mode the room was created with, for the first match whenever the room starts up again. */
  private mode: ModeId | null = null
  /** What the room plays on (Create game picks it; quick rooms play a random kind each match). */
  private maps: MapChoice | null = null

  protected async open(code: string, url: URL): Promise<RoomCore> {
    this.mode ??= modeOf(await this.ctx.storage.get<string>("mode")) ?? "ffa"
    this.maps ??= mapChoiceOf(await this.ctx.storage.get<string>("maps")) ?? "random"
    const core = (this.core ??= new RoomCore(code, this.mode, Date.now, this.maps))
    this.priv ??= (await this.ctx.storage.get<boolean>("private")) ?? false
    // Likewise only the first arrival picks the mode (Create game sends it).
    const mode = modeOf(url.searchParams.get("mode"))
    if (mode && core.connections === 0 && core.setMode(mode)) {
      this.mode = mode
      await this.ctx.storage.put("mode", mode)
    }
    const maps = mapChoiceOf(url.searchParams.get("map"))
    if (maps && core.connections === 0 && core.setMaps(maps)) {
      this.maps = maps
      await this.ctx.storage.put("maps", maps)
    }
    // Only the first arrival in an empty room can make it private, so a link can't hide an existing public room.
    if (!this.priv && core.connections === 0 && url.searchParams.get("private") === "1") {
      this.priv = true
      await this.ctx.storage.put("private", true)
    }
    return core
  }

  protected report(core: RoomCore, empty: boolean): RoomReport {
    return { code: core.code, players: empty ? 0 : core.world.humans.length, phase: core.world.phase, private: !!this.priv, mode: core.world.mode.id }
  }

  protected send(report: RoomReport) {
    return lobbyOf(this.env).report(report)
  }
}
