import type { Lobby } from "./lobby"
import type { WoodsRoom } from "./room"
import type { VoiceTurnEnv } from "@arcade/kit/server/voice-turn"

export interface Env extends VoiceTurnEnv {
  ROOM: DurableObjectNamespace<WoodsRoom>
  LOBBY: DurableObjectNamespace<Lobby>
  ASSETS?: Fetcher
}

export const lobbyOf = (env: Env) => env.LOBBY.get(env.LOBBY.idFromName("lobby"))
