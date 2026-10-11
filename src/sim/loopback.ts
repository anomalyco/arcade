// In-process "server": runs a RoomEngine locally and exchanges JSON-cloned messages with one client,
// so offline play behaves exactly like a network room (same serialization, async delivery).
// Dependency-free (timers + performance only) so it also works in tests and workers.
import type { ClientMessage, RoomConfig, ServerMessage } from "./protocol"
import { DEFAULT_ROOM_CONFIG } from "./protocol"
import { RoomEngine, createSnapshotDecoder, sanitizeConfig } from "./room-engine"

export type RoomStatus = "connecting" | "open" | "closed"

export interface RoomHandlers {
  onMessage(message: ServerMessage): void
  onStatus?(status: RoomStatus): void
}

export interface LoopbackOptions {
  code?: string
  /** Milliseconds clock; defaults to performance.now(). */
  now?: () => number
  /** Driver interval in ms (default 1000/60). Set `manual: true` to drive with `step()` instead. */
  intervalMs?: number
  manual?: boolean
}

export interface LoopbackRoom {
  send(message: ClientMessage): void
  close(): void
  /** Round-trip time in ms (always 0 locally). */
  rtt(): number
  readonly engine: RoomEngine
  readonly playerId: string
  /** Advance the engine by `seconds` (for manual driving / tests). */
  step(seconds: number): void
}

export function createLoopbackRoom(
  config: Partial<RoomConfig>, name: string, handlers: RoomHandlers, options: LoopbackOptions = {},
): LoopbackRoom {
  const now = options.now ?? (() => performance.now())
  let open = true
  // Server → client traffic uses the real wire format (compact snapshots, JSON text) and delivered
  // asynchronously so handlers can call send() without re-entering the engine mid-tick.
  const outbox: string[] = []
  let flushing = false
  const decode = createSnapshotDecoder()
  const flush = () => {
    flushing = false
    const batch = outbox.splice(0)
    for (const raw of batch) if (open) handlers.onMessage(decode(JSON.parse(raw)))
  }
  const enqueue = (text: string) => {
    if (!open) return
    outbox.push(text)
    if (!flushing) { flushing = true; queueMicrotask(flush) }
  }
  const engine = new RoomEngine(options.code ?? "local", sanitizeConfig({ ...DEFAULT_ROOM_CONFIG, listed: false, ...config }), {
    send: (_id, message) => enqueue(JSON.stringify(message)),
    sendText: (_id, text) => enqueue(text),
  })
  handlers.onStatus?.("connecting")
  const playerId = engine.addPlayer(name)
  queueMicrotask(() => { if (open) handlers.onStatus?.("open") })

  let last = now()
  const timer = options.manual ? undefined : setInterval(() => {
    const t = now()
    engine.advance((t - last) / 1000)
    last = t
  }, options.intervalMs ?? 1000 / 60)

  return {
    engine,
    playerId,
    send(message) {
      if (!open) return
      engine.handle(playerId, JSON.parse(JSON.stringify(message)) as ClientMessage)
    },
    close() {
      if (!open) return
      open = false
      if (timer !== undefined) clearInterval(timer)
      engine.removePlayer(playerId)
      handlers.onStatus?.("closed")
    },
    rtt: () => 0,
    step(seconds) {
      engine.advance(seconds)
    },
  }
}
