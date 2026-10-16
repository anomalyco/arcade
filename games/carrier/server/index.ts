import { gameWorker } from "@arcade/kit/server/worker"
import { roomName } from "../shared/protocol"
import type { Env } from "./env"
import { lobbyApi } from "./lobby"

export { Lobby } from "./lobby"
export { Room } from "./room"

export default gameWorker<Env>({
  game: "carrier",
  lab: false,
  wsQueryParam: "room",
  roomCode: roomName,
  api: (path, req, env) => lobbyApi(path, req, env.LOBBY),
})
