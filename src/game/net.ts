import { type ClientMsg, type ServerMsg, decodeServer, encodeClient } from "../../shared/protocol"
import type { Loadout } from "../../shared/sim/world"
import type { SimEvent } from "../../shared/sim/world"
import type { Snapshot } from "../../shared/sim/view"

export type NetHandlers = {
  welcome(id: string): void
  snap(s: Snapshot): void
  events(ev: SimEvent[]): void
  error(code: string, message: string): void
  status(text: string | null): void
}

const RECONNECT_MAX_MS = 4000

function socketUrl(room: string): string {
  const dir = location.pathname.replace(/[^/]*$/, "")
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${dir}ws/${encodeURIComponent(room)}`
}

/** WebSocket connection to a room. Reconnects with the same identity so a dropped player keeps their seat. */
export class Net {
  private ws: WebSocket | null = null
  private retries = 0
  private stopped = false
  private id = ""
  private hello: { name: string; loadout: Loadout } | null = null
  rtt = 0

  constructor(
    readonly room: string,
    private h: NetHandlers,
  ) {}

  connect(name: string, loadout: Loadout): void {
    this.hello = { name, loadout }
    this.open()
  }

  get myId(): string {
    return this.id
  }

  send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encodeClient(msg))
  }

  close(): void {
    this.stopped = true
    this.ws?.close()
  }

  private open(): void {
    const ws = new WebSocket(socketUrl(this.room))
    this.ws = ws
    ws.onopen = () => {
      this.retries = 0
      this.h.status(null)
      if (this.hello) this.send({ type: "hello", name: this.hello.name, id: this.id || undefined, loadout: this.hello.loadout })
      this.send({ type: "ping", t: performance.now() })
    }
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return
      const msg = decodeServer(e.data)
      if (msg) this.receive(msg)
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      if (this.stopped) return
      this.h.status("Reconnecting…")
      const delay = Math.min(RECONNECT_MAX_MS, 300 * 2 ** this.retries++)
      setTimeout(() => {
        if (!this.stopped) this.open()
      }, delay)
    }
  }

  private receive(msg: ServerMsg): void {
    switch (msg.type) {
      case "welcome":
        this.id = msg.id
        this.h.welcome(msg.id)
        return
      case "snap":
        this.h.snap(msg)
        return
      case "ev":
        this.h.events(msg.events)
        return
      case "error":
        this.stopped = true
        this.h.error(msg.code, msg.message)
        return
      case "pong":
        this.rtt = performance.now() - msg.t
        setTimeout(() => this.send({ type: "ping", t: performance.now() }), 2000)
        return
    }
  }
}
