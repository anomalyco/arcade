import { TICK_DT } from "../shared/clock"
import type { CoopRoomCore, Conn } from "../server/room-core"

/**
 * In-process network between `NetSession` clients and a `CoopRoomCore`, with a fixed one-way latency in ticks,
 * optional jitter, and optional simulated packet loss on gameplay frames.
 * Drives the room and the clients on one virtual clock so prediction and interpolation can be tested exactly.
 */
export class Loopback {
  tick = 0
  /** Test checkpoints may explicitly send a snapshot to connected peers without advancing the world clock. */
  readonly connections: Conn[] = []
  private queue: { at: number; run: () => void }[] = []

  private lastAt = new Map<object, number>()
  private seed = 1
  private lossSeed = 0x12345678

  constructor(
    readonly core: CoopRoomCore,
    public latencyTicks = 3,
    /** Extra random delay (0..jitterTicks) per message; order per direction is kept, as on a WebSocket. */
    public jitterTicks = 0,
    /** Simulated packet drop rate (0..1) applied to non-control frames (snapshots and input batches). */
    public lossRate = 0,
    /** Optional hook invoked right around binary snapshot delivery to a client socket. */
    public onBinaryDeliver?: (clientIndex: number, bytes: Uint8Array, deliver: () => void) => void,
  ) {}

  get now(): number {
    return this.tick * TICK_DT
  }

  private shouldDrop(): boolean {
    if (this.lossRate <= 0) return false
    this.lossSeed = (Math.imul(this.lossSeed, 1664525) + 1013904223) >>> 0
    return this.lossSeed / 2 ** 32 < this.lossRate
  }

  private later(run: () => void, lane: object = this, droppable = false): void {
    if (droppable && this.shouldDrop()) return
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0
    const jitter = this.jitterTicks ? Math.floor((this.seed / 2 ** 32) * (this.jitterTicks + 1)) : 0
    const at = Math.max(this.lastAt.get(lane) ?? 0, this.tick + Math.max(1, this.latencyTicks + jitter))
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
    let nextClientIndex = 0
    class LoopbackSocket {
      binaryType = "arraybuffer"
      readyState = 0
      onopen: (() => void) | null = null
      onmessage: ((e: { data: string | ArrayBuffer }) => void) | null = null
      onclose: ((e: { code: number }) => void) | null = null
      private conn: Conn
      private up = {}
      private clientIndex = nextClientIndex++
      constructor(_url: string) {
        const socket = this
        const down = {}
        this.conn = {
          send(data) {
            const isBin = typeof data !== "string"
            const copy = typeof data === "string" ? data : data.slice().buffer
            net.later(
              () => {
                if (socket.readyState !== 1) return
                if (isBin && net.onBinaryDeliver) {
                  net.onBinaryDeliver(socket.clientIndex, new Uint8Array(copy as ArrayBuffer), () =>
                    socket.onmessage?.({ data: copy }),
                  )
                } else {
                  socket.onmessage?.({ data: copy })
                }
              },
              down,
              isBin,
            )
          },
          close(code = 1000) {
            net.later(() => {
              socket.readyState = 3
              socket.onclose?.({ code })
            }, down)
          },
        }
        net.core.open(this.conn)
        net.connections.push(this.conn)
        net.later(() => {
          this.readyState = 1
          this.onopen?.()
        })
      }
      send(data: string | Uint8Array | ArrayBuffer): void {
        const copy = typeof data === "string" ? data : data instanceof Uint8Array ? data.slice() : new Uint8Array(data).slice()
        const droppable =
          typeof copy !== "string" || copy.startsWith("I") || copy.includes('"t":"in"') || copy.includes('"t":"ping"')
        net.later(() => net.core.message(this.conn, copy), this.up, droppable)
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
