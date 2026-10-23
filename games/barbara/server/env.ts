import type { Lobby } from "./lobby"
import type { WoodsRoom } from "./room"

export interface Env {
  ROOM: DurableObjectNamespace<WoodsRoom>
  LOBBY: DurableObjectNamespace<Lobby>
  ASSETS?: Fetcher
}

export const lobbyOf = (env: Env) => env.LOBBY.get(env.LOBBY.idFromName("lobby"))
