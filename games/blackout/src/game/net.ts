import { RoomSocket, rejoinKey } from "@arcade/kit/net/room-socket"
import { BUILD } from "../../shared/build.gen"
import { type ClientMsg, type ServerMsg, decodeServer, encodeClient } from "../../shared/protocol"
import type { RosterRow, Snapshot } from "../../shared/sim/view"
import type { Equip, Gun } from "../../shared/config"
import type { MapChoice } from "../../shared/maps"
import type { ModeId } from "../../shared/sim/modes"
import type { SimEvent } from "../../shared/sim/world"
import type { Session } from "./session"

/** Set before a version reload: main.ts rejoins this room without the landing page. */
export const REJOIN_KEY = rejoinKey("blackout")

/** A room on the server (`@arcade/kit/net/room-socket`). Reconnects with the seat's private token, so a dropped player keeps their seat for the match. */
export class NetSession implements Session {
  private socket: RoomSocket<ClientMsg>
  private snap: { snap: Snapshot; at: number } | null = null
  private players: RosterRow[] = []
  private events: SimEvent[] = []

  constructor(
    readonly room: string,
    name: string,
    private gun: Gun,
    private equip: Equip,
    onFatal: (message: string) => void,
    /** Created with "Create game": the room stays out of quick join. */
    priv = false,
    /** The mode picked on Create game; the room takes it only from its first arrival. */
    mode: ModeId | null = null,
    /** What Create game picked to play on; likewise taken only from the first arrival. */
    maps: MapChoice | null = null,
  ) {
    this.socket = new RoomSocket<ClientMsg>({
      game: "blackout",
      room,
      query: { private: priv ? "1" : null, mode, map: maps },
      hello: (token) => ({ type: "hello", name, token, gun: this.gun, equip: this.equip, build: BUILD }),
      receive: (msg) => this.receive(msg as ServerMsg),
      fatal: onFatal,
      encode: (msg) => encodeClient(msg as ClientMsg),
      decode: decodeServer,
    })
  }

  get myId(): string {
    return this.socket.id
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
    if (msg.type === "gun") this.gun = msg.gun
    if (msg.type === "equip") this.equip = msg.equip
    this.socket.send(msg)
  }

  status(): string | null {
    return this.socket.status()
  }

  update(): void {}

  close(): void {
    this.socket.close()
  }

  private receive(msg: ServerMsg): void {
    if (msg.type === "snap") this.snap = { snap: msg, at: performance.now() }
    else if (msg.type === "roster") this.players = msg.players
    else if (msg.type === "ev") this.events.push(...msg.events)
  }
}
