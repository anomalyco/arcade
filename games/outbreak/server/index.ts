import { gameWorker } from "@arcade/kit/server/worker"
import { ROOM_CODE } from "../shared/net-protocol"
import type { RoomEnv } from "./room"
import { lobbyOf } from "./lobby"

export { OutbreakRoom } from "./room"
export { Lobby } from "./lobby"

export default gameWorker<RoomEnv>({
  game: "outbreak",
  roomCode: (raw) => {
    const code = raw.toLowerCase()
    return ROOM_CODE.test(code) ? code : null
  },
  api: async (path, _req, env) => {
    if (path === "/api/health") return Response.json({ ok: true, session: "coop" })
    if (path === "/api/stats") return Response.json(await lobbyOf(env).stats(), { headers: { "cache-control": "no-store" } })
    return new Response("Not found", { status: 404 })
  },
})
