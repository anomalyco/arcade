import { gameWorker } from "@arcade/kit/server/worker"
import { normalizeRoom } from "../shared/protocol"
import { type Env, lobbyOf } from "./env"

export { Lobby } from "./lobby"
export { Room } from "./room"

export default gameWorker<Env>({ game: "getaway", lobby: lobbyOf, roomCode: normalizeRoom })
