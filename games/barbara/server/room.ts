import { RoomObject } from "@arcade/kit/server/room-object"
import { TICK_HZ } from "../shared/protocol"
import { type Env, lobbyOf } from "./env"
import type { RoomReport } from "./lobby"
import { WoodsRoomCore, type NightCheckpoint } from "./room-core"

/** One Durable Object per room code (`@arcade/kit/server/room-object`), ticking the night at 30 Hz. */
export class WoodsRoom extends RoomObject<Env, WoodsRoomCore, RoomReport> {
  protected readonly tickMs = 1000 / TICK_HZ

  protected async open(code: string): Promise<WoodsRoomCore> {
    if (this.core) return this.core
    const sql = this.ctx.storage.sql
    sql.exec("CREATE TABLE IF NOT EXISTS night (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)")
    const row = sql.exec<{ data: string }>("SELECT data FROM night WHERE id = 1").toArray()[0]
    let core = row ? WoodsRoomCore.restore(JSON.parse(row.data) as NightCheckpoint) : new WoodsRoomCore(code)
    if (row && !core.humans) { sql.exec("DELETE FROM night WHERE id = 1"); core = new WoodsRoomCore(code) }
    core.onCheckpoint = (night) => {
      if (!core.humans) sql.exec("DELETE FROM night WHERE id = 1")
      else sql.exec("INSERT OR REPLACE INTO night (id, data) VALUES (1, ?)", JSON.stringify(night))
    }
    return (this.core = core)
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
