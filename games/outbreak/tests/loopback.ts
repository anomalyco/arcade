import { TICK_DT } from "../shared/clock"
import type { CoopRoomCore, Conn } from "../server/room-core"

/**
 * In-process network between `NetSession` clients and a `CoopRoomCore`, with a fixed one-way latency in ticks.
 * Drives the room and the clients on one virtual clock so prediction and interpolation can be tested exactly.
 */
export class Loopback {
  tick = 0
  private queue: { at: number; run: () => void }[] = []

  private lastAt = new Map<object, number>()
  private seed = 1

  constructor(
    readonly core: CoopRoomCore,
    public latencyTicks = 3,
    /** Extra random delay (0..jitterTicks) per message; order per direction is kept, as on a WebSocket. */
    public jitterTicks = 0,
  ) {}

  get now(): number {
    return this.tick * TICK_DT
  }

  private later(run: () => void, lane: object = this): void {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0
    const jitter = this.jitterTicks ? Math.floor((this.seed / 2 ** 32) * (this.jitterTicks + 1)) : 0
    const at = Math.max(this.lastAt.get(lane) ?? 0, this.tick + this.latencyTicks + jitter)
    this.lastAt.set(lane, at)
    this.queue.push({ at, run })
  }

  deliver(): void {
    const due = this.queue.filter((m) => m.at <= this.tick)
    this.queue = this.queue.filter((m) => m.at > this.tick)
    for (const m of due) m.run()
  }

  /** A WebSocket class whose instances talk to the room through this loopback. */
  socketClass(): typeof WebSocket {
    const net = this
    class LoopbackSocket {
      binaryType = "arraybuffer"
      readyState = 0
      onopen: (() => void) | null = null
      onmessage: ((e: { data: string | ArrayBuffer }) => void) | null = null
      onclose: ((e: { code: number }) => void) | null = null
      private conn: Conn
      private up = {}
      constructor(_url: string) {
        const socket = this
        const down = {}
        this.conn = {
          send(data) {
            const copy = typeof data === "string" ? data : data.slice().buffer
            net.later(() => socket.readyState === 1 && socket.onmessage?.({ data: copy }), down)
          },
          close(code = 1000) {
            net.later(() => {
              socket.readyState = 3
              socket.onclose?.({ code })
            }, down)
          },
        }
        net.core.open(this.conn)
        net.later(() => {
          this.readyState = 1
          this.onopen?.()
        })
      }
      send(data: string): void {
        net.later(() => net.core.message(this.conn, data), this.up)
      }
      close(): void {
        this.readyState = 3
        net.later(() => net.core.close(this.conn))
      }
    }
    return LoopbackSocket as unknown as typeof WebSocket
  }

  /** Advances one tick: deliver due messages, then step the room. */
  step(): void {
    this.tick++
    this.deliver()
    this.core.step()
  }
}
