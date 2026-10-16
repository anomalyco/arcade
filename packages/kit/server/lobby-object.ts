import { DurableObject } from "cloudflare:workers"
import type { BaseRoomReport, RoomEntry, SharedMatchmaker } from "../sim/matchmaking"

/**
 * Singleton matchmaker. Room reports are kept in storage too, so a Lobby that was evicted or restarted still knows
 * every live room at once instead of waiting for their next heartbeat. Subclass it with the game's matchmaker:
 * `class Lobby extends LobbyObject<Env, RoomReport> { constructor(ctx, env) { super(ctx, env, new Matchmaker()) } }`.
 */
export class LobbyObject<Env, R extends BaseRoomReport> extends DurableObject<Env> {
  constructor(
    ctx: DurableObjectState,
    env: Env,
    protected readonly mm: SharedMatchmaker<R>,
  ) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<RoomEntry<R>[]>("rooms")
      for (const r of saved ?? []) this.mm.rooms.set(r.code, r)
    })
  }

  async report(r: R) {
    this.mm.report(r, Date.now())
    await this.ctx.storage.put("rooms", [...this.mm.rooms.values()])
  }

  quick() {
    return this.mm.quick(Date.now())
  }

  create() {
    return this.mm.create(Date.now())
  }

  info(code: string) {
    return this.mm.info(code, Date.now())
  }

  stats() {
    return this.mm.stats(Date.now())
  }
}
