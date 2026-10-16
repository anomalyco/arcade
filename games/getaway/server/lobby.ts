import { LobbyObject } from "@arcade/kit/server/lobby-object"
import type { Env } from "./env"
import { Matchmaker, type RoomReport } from "./matchmaking"

/** Singleton matchmaker (`@arcade/kit/server/lobby-object`), with Getaway's quick-join policy. */
export class Lobby extends LobbyObject<Env, RoomReport> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, new Matchmaker())
  }
}
