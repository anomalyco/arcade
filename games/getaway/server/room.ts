import { RoomObject } from "@arcade/kit/server/room-object"
import { TICK_HZ } from "../shared/config"
import { RoomCore } from "./core"
import { type Env, lobbyOf } from "./env"
import type { RoomReport } from "./matchmaking"

/** One Durable Object per room code (`@arcade/kit/server/room-object`). Holds sockets in memory and ticks the simulation while anyone is around. */
export class Room extends RoomObject<Env, RoomCore, RoomReport> {
  protected readonly tickMs = 1000 / TICK_HZ
  protected override readonly heartbeatMs = 60_000
  /** Private rooms (made with "Create game") are never handed out by quick join. Sticky for the life of the code. */
  private priv: boolean | null = null

  protected async open(code: string, url: URL): Promise<RoomCore> {
    const core = (this.core ??= new RoomCore(code))
    this.priv ??= (await this.ctx.storage.get<boolean>("private")) ?? false
    // Only the room's first arrival can make it private, so a link can't hide an existing public room.
    if (!this.priv && core.humans() === 0 && url.searchParams.get("private") === "1") {
      this.priv = true
      await this.ctx.storage.put("private", true)
    }
    return core
  }

  protected override isAlive(core: RoomCore): boolean {
    return core.alive()
  }

  protected report(core: RoomCore, empty: boolean): RoomReport {
    return {
      code: core.code,
      players: empty ? 0 : core.humans(),
      phase: core.world?.phase ?? "waiting",
      private: !!this.priv,
    }
  }

  protected send(report: RoomReport): Promise<unknown> {
    return lobbyOf(this.env).report(report)
  }
}
