import { gameWorker } from "@arcade/kit/server/worker"
import { GAME, ROOM_CODE } from "../shared/protocol"
import { type Env, lobbyOf } from "./env"

export { Lobby } from "./lobby"
export { WoodsRoom } from "./room"

/** Strips `/arcade/woods`, answers health and room creation from the Lobby, sends `/ws/<code>` to that room. */
export default gameWorker<Env>({ game: GAME, lobby: lobbyOf, lab: false, roomCode: (raw) => (ROOM_CODE.test(raw.toLowerCase()) ? raw.toLowerCase() : null) })
