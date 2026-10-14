import { DurableObject } from "cloudflare:workers"
import type { Env } from "./env"
import { Matchmaker, type RoomEntry, type RoomReport } from "./matchmaking"

/**
 * Singleton matchmaker. Room reports are kept in storage too, so a Lobby that was evicted or restarted still knows
 * every live room at once instead of waiting for their next heartbeat.
 */
export class Lobby extends DurableObject<Env> {
  private mm = new Matchmaker()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<RoomEntry[]>("rooms")
      for (const r of saved ?? []) this.mm.rooms.set(r.code, r)
    })
  }

  async report(r: RoomReport) {
    this.mm.report(r, Date.now())
    await this.ctx.storage.put("rooms", [...this.mm.rooms.values()])
  }

  quick() {
    return this.mm.quick(Date.now())
  }

  create() {
    return this.mm.create(Date.now())
  }

  stats() {
    return this.mm.stats(Date.now())
  }
}
