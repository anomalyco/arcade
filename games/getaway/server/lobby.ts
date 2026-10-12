import { DurableObject } from "cloudflare:workers"
import type { Env } from "./env"
import { Matchmaker, type RoomReport } from "./matchmaking"

/** Singleton matchmaker. State is in memory only: rooms heartbeat, so a restarted Lobby is whole again within a minute. */
export class Lobby extends DurableObject<Env> {
  private mm = new Matchmaker()

  report(r: RoomReport) {
    this.mm.report(r, Date.now())
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
