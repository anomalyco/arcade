import { type ClientMsg, type ServerMsg, decodeServer, encodeClient } from "../../shared/protocol"
import type { RosterRow, Snapshot } from "../../shared/sim/view"
import type { Loadout, SimEvent } from "../../shared/sim/world"
import type { Session } from "./session"

const ID_KEY = "blackout.id."

function socketUrl(room: string): string {
  const dir = location.pathname.replace(/[^/]*$/, "")
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${dir}ws/${encodeURIComponent(room)}`
}

/** A room on the server. Reconnects with the same id, so a dropped player keeps their seat for the match. */
export class NetSession implements Session {
  private ws: WebSocket | null = null
  private snap: { snap: Snapshot; at: number } | null = null
  private players: RosterRow[] = []
  private events: SimEvent[] = []
  private problem: string | null = "Connecting…"
  private retries = 0
  private closed = false
  private id = ""

  constructor(
    readonly room: string,
    private name: string,
    private loadout: Loadout,
    private onFatal: (message: string) => void,
  ) {
    this.id = sessionStorage.getItem(ID_KEY + room) ?? ""
    this.open()
  }

  get myId(): string {
    return this.id
  }

  latest() {
    return this.snap
  }

  roster(): RosterRow[] {
    return this.players
  }

  drainEvents(): SimEvent[] {
    const e = this.events
    this.events = []
    return e
  }

  send(msg: ClientMsg): void {
    if (msg.type === "loadout") this.loadout = msg.loadout
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encodeClient(msg))
  }

  status(): string | null {
    return this.problem
  }

  update(): void {}

  close(): void {
    this.closed = true
    this.ws?.close()
  }

  private open(): void {
    const ws = new WebSocket(socketUrl(this.room))
    this.ws = ws
    ws.onopen = () => {
      this.retries = 0
      ws.send(encodeClient({ type: "hello", name: this.name, id: this.id || undefined, loadout: this.loadout }))
    }
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return
      const msg = decodeServer(e.data)
      if (msg) this.receive(msg)
    }
    ws.onclose = () => {
      if (this.ws !== ws || this.closed) return
      this.ws = null
      this.problem = "Connection lost. Reconnecting…"
      setTimeout(() => !this.closed && this.open(), Math.min(4000, 300 * 2 ** this.retries++))
    }
  }

  private receive(msg: ServerMsg): void {
    switch (msg.type) {
      case "welcome":
        this.id = msg.id
        sessionStorage.setItem(ID_KEY + this.room, msg.id)
        this.problem = null
        return
      case "snap":
        this.snap = { snap: msg, at: performance.now() }
        return
      case "roster":
        this.players = msg.players
        return
      case "ev":
        this.events.push(...msg.events)
        return
      case "error":
        this.closed = true
        this.onFatal(msg.message)
        return
      case "pong":
        return
    }
  }
}
