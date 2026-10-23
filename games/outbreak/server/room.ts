import { RoomObject } from "@arcade/kit/server/room-object"
import { TICK_MS } from "../shared/clock"
import { CoopRoomCore } from "./room-core"
import { type Lobby, lobbyOf } from "./lobby"
import type { BaseRoomReport } from "@arcade/kit/sim/matchmaking"

export type RoomEnv = { ROOM: DurableObjectNamespace<OutbreakRoom>; LOBBY: DurableObjectNamespace<Lobby>; ASSETS: Fetcher }

/** One Durable Object per room code (`@arcade/kit/server/room-object`). Ticks while anyone is connected or a dropped survivor may still return. */
export class OutbreakRoom extends RoomObject<RoomEnv, CoopRoomCore, BaseRoomReport> {
  protected readonly tickMs = TICK_MS
  protected override readonly maxCatchup = 6

  protected async open(code: string): Promise<CoopRoomCore> {
    return (this.core ??= new CoopRoomCore(code))
  }

  protected override isAlive(core: CoopRoomCore): boolean {
    return core.alive
  }

  protected report(core: CoopRoomCore, empty: boolean): BaseRoomReport {
    return { code: core.code, players: empty ? 0 : core.connections, private: true }
  }

  protected send(report: BaseRoomReport) {
    return lobbyOf(this.env).report(report)
  }
}
