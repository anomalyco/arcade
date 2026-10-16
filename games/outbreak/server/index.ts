import { gameWorker } from "@arcade/kit/server/worker"
import { ROOM_CODE } from "../shared/net-protocol"
import type { RoomEnv } from "./room"

export { OutbreakRoom } from "./room"

export default gameWorker<RoomEnv>({
  game: "outbreak",
  roomCode: (raw) => {
    const code = raw.toLowerCase()
    return ROOM_CODE.test(code) ? code : null
  },
  api: (path) => (path === "/api/health" ? Response.json({ ok: true, session: "coop" }) : new Response("Not found", { status: 404 })),
})
