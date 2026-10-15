import { gameWorker } from "@arcade/kit/server/worker"
import { type Env, lobbyOf } from "./env"

export { Lobby } from "./lobby"
export { Room } from "./room"

export default gameWorker<Env>({ game: "blackout", lobby: lobbyOf })
