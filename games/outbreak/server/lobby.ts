import { LobbyObject } from "@arcade/kit/server/lobby-object"
import { SharedMatchmaker, type BaseRoomReport } from "@arcade/kit/sim/matchmaking"

/** Presence only: Outbreak still creates and joins private rooms through its existing lobby UI. */
export class Lobby extends LobbyObject<unknown, BaseRoomReport> {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env, new SharedMatchmaker({ maxPlayers: 6, isOpen: () => false }))
  }
}

export const lobbyOf = (env: { LOBBY: DurableObjectNamespace<Lobby> }) => env.LOBBY.get(env.LOBBY.idFromName("lobby"))
