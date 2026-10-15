import { gameWorker } from "@arcade/kit/server/worker"
import { GAME } from "../shared/config"
import { type Env, lobbyOf } from "./env"

export { Lobby } from "./lobby"
export { Room } from "./room"

export default gameWorker<Env>({ game: GAME.id, lobby: lobbyOf, lab: false })
