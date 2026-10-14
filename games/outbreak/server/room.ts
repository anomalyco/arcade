import { DurableObject } from "cloudflare:workers"
import { TICK_MS } from "../shared/clock"
import { CoopRoomCore, type Conn } from "./room-core"

/** After a stall, run at most this many catch-up ticks. */
const MAX_CATCHUP = 6

export type RoomEnv = { ROOM: DurableObjectNamespace<OutbreakRoom>; ASSETS: Fetcher }

/** One Durable Object per room code. Ticks while anyone is connected or a dropped survivor may still return. */
export class OutbreakRoom extends DurableObject<RoomEnv> {
  private core: CoopRoomCore | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private clock = 0

  override async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 })
    const code = req.headers.get("x-room")
    if (!code) return new Response("missing room", { status: 400 })
    const core = (this.core ??= new CoopRoomCore(code))
    const pair = new WebSocketPair()
    const socket = pair[1]
    socket.accept()
    const conn: Conn = {
      send(data) {
        try {
          socket.send(data)
        } catch {}
      },
      close(c, reason) {
        try {
          socket.close(c, reason)
        } catch {}
      },
    }
    core.open(conn)
    socket.addEventListener("message", (e) => core.message(conn, e.data))
    socket.addEventListener("close", () => core.close(conn))
    socket.addEventListener("error", () => core.close(conn))
    if (!this.timer) {
      this.clock = Date.now()
      this.timer = setInterval(() => this.loop(), TICK_MS)
    }
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  private loop(): void {
    const core = this.core
    if (!core || !core.alive) {
      if (this.timer) clearInterval(this.timer)
      this.timer = null
      // Everyone left and every grace window ran out: the next visitor gets a fresh neighbourhood.
      this.core = null
      return
    }
    const now = Date.now()
    let due = Math.floor((now - this.clock) / TICK_MS)
    if (due > MAX_CATCHUP) {
      this.clock = now - MAX_CATCHUP * TICK_MS
      due = MAX_CATCHUP
    }
    for (let i = 0; i < due; i++) core.step()
    this.clock += due * TICK_MS
  }
}
