import { DT, SNAPSHOT_HZ, TICK_HZ } from "../../shared/config"
import type { ClientMsg } from "../../shared/protocol"
import { type RosterRow, type Snapshot, buildSnapshot, rosterOf } from "../../shared/sim/view"
import type { Equip, Gun } from "../../shared/config"
import { hostMaps, hostRestart, moveTeam, shuffleTeams } from "../../shared/sim/host"
import { MODES, type ModeId } from "../../shared/sim/modes"
import { type SimEvent, World } from "../../shared/sim/world"
import { type MapDef, mapChoiceOf } from "../../shared/maps"
import { lotMap } from "../../shared/sim/vehicle-lot"

/** What the game loop needs from a match, whether it runs in this tab or in a room on the server. */
export interface Session {
  readonly room: string | null
  readonly myId: string
  /** Latest snapshot and when it arrived (performance.now() ms). */
  latest(): { snap: Snapshot; at: number } | null
  roster(): RosterRow[]
  drainEvents(): SimEvent[]
  send(msg: ClientMsg): void
  /** A connection problem to show, or null. */
  status(): string | null
  /** Called every frame; the local session advances its world here. */
  update(dt: number): void
  close(): void
  /** A practice session on a fixed test map, which the client can't generate from the seed. */
  fixedMap?(): MapDef | null
}

/** Dev practice against bots without a server: the same World runs in the tab. */
export class LocalSession implements Session {
  readonly room = null
  readonly myId = "you"
  private world: World
  private acc = 0
  private snap: { snap: Snapshot; at: number } | null = null
  private events: SimEvent[] = []
  private every = Math.max(1, Math.round(TICK_HZ / SNAPSHOT_HZ))

  private fixed: MapDef | null

  /** `map` "lot" practices on the vehicle test yard (shared/sim/vehicle-lot.ts). */
  constructor(name: string, gun: Gun, equip: Equip, mode: ModeId = "ffa", map: string | null = null) {
    this.fixed = map === "lot" ? lotMap() : null
    // Or `map` picks what the practice room plays on: office, downtown or random.
    this.world = new World((Math.random() * 2 ** 31) | 0, this.fixed, mode, mapChoiceOf(map) ?? "office")
    // Local practice (dev only, ?practice) is the one place with bots: 3 on 3 in team modes.
    this.world.botFill = MODES[mode].teams ? 6 : 4
    this.world.addHuman(this.myId, name, gun, equip)
    this.publish()
    // Dev handle for screenshots and poking at the match from the console.
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
    else if (msg.type === "gun") this.world.pickGun(this.myId, msg.gun)
    else if (msg.type === "equip") this.world.pickEquip(this.myId, msg.equip)
    else if (msg.type === "vote") this.world.vote(this.myId, msg.mode)
    else if (msg.type === "team") moveTeam(this.world, this.myId, msg.id, msg.team)
    else if (msg.type === "shuffle") shuffleTeams(this.world, this.myId)
    else if (msg.type === "host" && msg.action === "maps") hostMaps(this.world, this.myId, msg.maps)
    else if (msg.type === "host" && hostRestart(this.world, this.myId, msg.action === "mode" ? msg.mode : this.world.mode.id, msg.newFloor)) {
      // Practice keeps its 3 on 3 in team modes.
      this.world.botFill = MODES[this.world.mode.id].teams ? 6 : 4
      this.world.fill()
    }
  }

  status(): string | null {
    return null
  }

  update(dt: number): void {
    this.acc = Math.min(this.acc + dt, DT * 6)
    while (this.acc >= DT) {
      this.acc -= DT
      this.world.step()
      this.events.push(...this.world.takeEvents())
      if (this.world.tick % this.every === 0) this.publish()
    }
  }

  private publish(): void {
    this.snap = { snap: buildSnapshot(this.world, this.myId), at: performance.now() }
  }

  close(): void {}

  fixedMap(): MapDef | null {
    return this.fixed
  }
}
