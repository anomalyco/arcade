import { LobbyObject } from "@arcade/kit/server/lobby-object"
import { SharedMatchmaker } from "@arcade/kit/sim/matchmaking"
import { MAX_PLAYERS } from "../shared/protocol"
import type { Env } from "./env"

export type RoomReport = { code: string; players: number; private: boolean }

/** Hands out room codes for "play with friends" and counts live rooms. Rooms are shared by link, never quick-joined. */
export class Lobby extends LobbyObject<Env, RoomReport> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, new SharedMatchmaker<RoomReport>({ maxPlayers: MAX_PLAYERS, isOpen: () => false }))
  }
}
