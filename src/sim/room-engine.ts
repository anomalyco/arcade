// STUB — owned by the Server agent. Signatures are the contract; replace implementations.
// Authoritative game loop shared by the Room Durable Object and the browser's offline/loopback mode.
import type { ClientMessage, RoomConfig, ServerMessage } from "./protocol"

export interface RoomEngineHooks {
  /** Send a message to one player (by player id). */
  send(playerId: string, message: ServerMessage): void
  /** Optional: called when a match ends or the room should be persisted. */
  onChange?(): void
}

export class RoomEngine {
  constructor(public readonly code: string, public config: RoomConfig, private hooks: RoomEngineHooks) {}

  /** Register a human connection; returns its player id. */
  addPlayer(name: string): string {
    return crypto.randomUUID().slice(0, 8)
  }

  removePlayer(playerId: string): void {}

  handle(playerId: string, message: ClientMessage): void {}

  /** Advance wall-clock time (seconds). Runs fixed 60 Hz ticks internally and emits snapshots at 20 Hz. */
  advance(elapsed: number): void {}

  humanCount(): number {
    return 0
  }

  playerCount(): number {
    return 0
  }
}
