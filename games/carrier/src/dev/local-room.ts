import { type Conn, RoomCore } from "../../server/core"
import { BUILD } from "../../shared/build.gen"

/** The Room Durable Object's tick (server/room.ts). */
const TICK_MS = 50

/**
 * Dev builds: a room in the page. `?seed=N&bots` plays offline on it instead of the local crew of one, so the BOTS
 * panel works with no server: the same RoomCore as the Worker's (in dev mode), its frames delivered asynchronously like
 * a socket's. Returns a WebSocket stand-in factory for `connect({ socket })`.
 */
export function localRoom(): (url: string) => WebSocket {
  const core = new RoomCore(Date.now, undefined, { dev: true })
  let timer: ReturnType<typeof setInterval> | null = null
  const open = () => {
    const sock = {
      readyState: 0 as number,
      onopen: null as ((e: Event) => void) | null,
      onmessage: null as ((e: MessageEvent) => void) | null,
      onclose: null as ((e: CloseEvent) => void) | null,
      onerror: null as ((e: Event) => void) | null,
      binaryType: "arraybuffer" as BinaryType,
      send(data: string | Uint8Array) {
        if (sock.readyState === 1) core.message(conn, data)
      },
      close() {
        if (sock.readyState === 3) return
        sock.readyState = 3
        core.close(conn)
        queueMicrotask(() => sock.onclose?.(new CloseEvent("close")))
      },
    }
    const conn: Conn = {
      send: (data) => queueMicrotask(() => sock.readyState === 1 && sock.onmessage?.(new MessageEvent("message", { data }))),
      close: () => sock.close(),
    }
    queueMicrotask(() => {
      sock.readyState = 1
      sock.onopen?.(new Event("open"))
    })
    timer ??= setInterval(() => core.step(), TICK_MS)
    return sock as unknown as WebSocket
  }
  // Scripted captures join extra players through the same sockets (`open()`, a hello with `build`).
  const g = globalThis as { carrierRoom?: unknown }
  g.carrierRoom = { core, open, build: BUILD }
  return open
}
