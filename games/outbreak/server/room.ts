import { RoomObject } from "@arcade/kit/server/room-object"
import { TICK_MS } from "../shared/clock"
import { CoopRoomCore } from "./room-core"

export type RoomEnv = { ROOM: DurableObjectNamespace<OutbreakRoom>; ASSETS: Fetcher }

/** One Durable Object per room code (`@arcade/kit/server/room-object`). Ticks while anyone is connected or a dropped survivor may still return. */
export class OutbreakRoom extends RoomObject<RoomEnv, CoopRoomCore> {
  protected readonly tickMs = TICK_MS
  protected override readonly maxCatchup = 6

  protected async open(code: string): Promise<CoopRoomCore> {
    return (this.core ??= new CoopRoomCore(code))
  }

  protected override isAlive(core: CoopRoomCore): boolean {
    return core.alive
  }

  protected report(): null {
    return null
  }

  protected send(): Promise<void> {
    return Promise.resolve()
  }
}
