import { DT, SNAPSHOT_HZ, TICK_HZ } from "../../shared/config"
import type { ClientMsg } from "../../shared/protocol"
import { type RosterRow, type Snapshot, buildSnapshot, rosterOf } from "../../shared/sim/view"
import type { Gun } from "../../shared/config"
import { type SimEvent, World } from "../../shared/sim/world"

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

  constructor(name: string, gun: Gun) {
    this.world = new World((Math.random() * 2 ** 31) | 0)
    // Local practice (dev only, ?practice) is the one place with bots.
    this.world.botFill = 4
    this.world.addHuman(this.myId, name, gun)
    this.publish()
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
}
