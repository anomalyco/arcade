import type { Lobby } from "./lobby"
import type { Room } from "./room"

export interface Env {
  ROOM: DurableObjectNamespace<Room>
  LOBBY: DurableObjectNamespace<Lobby>
  ASSETS?: Fetcher
  /** "1" only under `wrangler dev` (.dev.vars): the rooms run in dev mode (dev tools, bots). Never set when deployed. */
  CARRIER_DEV?: string
}
