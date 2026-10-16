import { RoomObject } from "@arcade/kit/server/room-object"
import { RoomCore } from "./core"
import type { Env } from "./env"
import { lobbyOf } from "./lobby"
import type { RoomReport } from "./matchmaking"

/**
 * One Durable Object per room code (`@arcade/kit/server/room-object`). The world, crew and ships live in memory only:
 * when the last player leaves they are gone. Ticks while anyone is connected and reports its player count to the Lobby.
 */
export class Room extends RoomObject<Env, RoomCore, RoomReport> {
  protected readonly tickMs = 50
  protected override readonly catchup = false
  private code = ""
  /** Made with Create game: the Lobby keeps it out of quick join. */
  private priv: boolean | null = null

  protected async open(code: string, url: URL): Promise<RoomCore> {
    this.code = code
    const core = (this.core ??= new RoomCore(Date.now, undefined, { dev: this.env.CARRIER_DEV === "1" }))
    this.priv ??= (await this.ctx.storage.get<boolean>("private")) ?? false
    // Only the first arrival in an empty room can make it private, so a link can't hide an existing public room.
    const wantPrivate = url.searchParams.get("private") === "1"
    if (core.players === 0 && wantPrivate !== this.priv) {
      this.priv = wantPrivate
      await this.ctx.storage.put("private", wantPrivate)
    }
    return core
  }

  protected override isAlive(core: RoomCore): boolean {
    return core.players > 0 || this.sockets.size > 0
  }

  protected report(core: RoomCore, empty: boolean): RoomReport | null {
    if (!this.code) return null
    return { code: this.code, players: empty ? 0 : core.players, private: !!this.priv }
  }

  protected send(report: RoomReport): Promise<unknown> {
    return lobbyOf(this.env.LOBBY).report(report)
  }
}
