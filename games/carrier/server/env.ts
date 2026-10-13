import type { Lobby } from "./lobby"
import type { Room } from "./room"

export interface Env {
  ROOM: DurableObjectNamespace<Room>
  LOBBY: DurableObjectNamespace<Lobby>
  ASSETS?: Fetcher
}
