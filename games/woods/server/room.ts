import { RoomObject } from "@arcade/kit/server/room-object"
import { TICK_HZ } from "../shared/protocol"
import { type Env, lobbyOf } from "./env"
import type { RoomReport } from "./lobby"
import { WoodsRoomCore } from "./room-core"

/** One Durable Object per room code (`@arcade/kit/server/room-object`), ticking the night at 30 Hz. */
export class WoodsRoom extends RoomObject<Env, WoodsRoomCore, RoomReport> {
  protected readonly tickMs = 1000 / TICK_HZ

  protected async open(code: string): Promise<WoodsRoomCore> {
    return (this.core ??= new WoodsRoomCore(code))
  }

  /** Alive while anyone is connected or a dropped person's seat is still held for them. */
  protected override isAlive(core: WoodsRoomCore): boolean {
    return core.connections > 0 || core.humans > 0
  }

  protected report(core: WoodsRoomCore, empty: boolean): RoomReport {
    return { code: core.code, players: empty ? 0 : core.humans, private: true }
  }

  protected send(report: RoomReport) {
    return lobbyOf(this.env).report(report)
  }
}
