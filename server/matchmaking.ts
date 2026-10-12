import { MAX_PLAYERS } from "../shared/config"
import { randomCode } from "../shared/protocol"

/** What a Room tells the Lobby about itself. `players` counts held seats, so a room at MAX_PLAYERS is full. */
export type RoomReport = { code: string; players: number; phase: string; private: boolean }
export type RoomEntry = RoomReport & { updatedAt: number }
type Reservation = { code: string; until: number; private: boolean; claims: number }

/** Rooms heartbeat well inside this; an entry older than it belongs to a room that died without saying so. */
export const STALE_MS = 120_000
/** A freshly handed-out code stays taken this long, so simultaneous quick-joiners share it until the room reports in. */
export const RESERVE_MS = 8_000

const open = (r: RoomEntry) => !r.private && r.players > 0 && r.players < MAX_PLAYERS

/** The public room quick join should send you to: the fullest one with space, rooms between matches first on a tie. */
export function pickRoom(rooms: Iterable<RoomEntry>): RoomEntry | null {
  let best: RoomEntry | null = null
  for (const r of rooms) {
    if (!open(r)) continue
    if (!best) best = r
    else if (r.players !== best.players) best = r.players > best.players ? r : best
    else if ((r.phase === "end") !== (best.phase === "waiting")) best = r.phase === "end" ? r : best
    else if (r.updatedAt !== best.updatedAt) best = r.updatedAt > best.updatedAt ? r : best
    else if (r.code < best.code) best = r
  }
  return best
}

/** Matchmaking state held by the singleton Lobby: live room reports plus short-lived code reservations. */
export class Matchmaker {
  readonly rooms = new Map<string, RoomEntry>()
  readonly reserved = new Map<string, Reservation>()

  constructor(private rand: () => number = Math.random) {}

  report(r: RoomReport, now: number) {
    if (r.players > 0) {
      this.rooms.set(r.code, { ...r, updatedAt: now })
      // The room speaks for itself now; its own entry replaces the reservation.
      this.reserved.delete(r.code)
    } else this.rooms.delete(r.code)
  }

  prune(now: number) {
    for (const [code, r] of this.rooms) if (now - r.updatedAt > STALE_MS) this.rooms.delete(code)
    for (const [code, r] of this.reserved) if (now >= r.until) this.reserved.delete(code)
  }

  /** A room code for quick join: the best open room, else a shared reservation for a brand-new public room. */
  quick(now: number): string {
    this.prune(now)
    const room = pickRoom(this.rooms.values())
    if (room) return room.code
    for (const r of this.reserved.values())
      if (!r.private && r.claims < MAX_PLAYERS) {
        r.claims++
        return r.code
      }
    return this.reserve(now, false)
  }

  /** A fresh private room code. Quick join never hands it out. */
  create(now: number): string {
    this.prune(now)
    return this.reserve(now, true)
  }

  stats(now: number) {
    this.prune(now)
    let players = 0
    let games = 0
    for (const r of this.rooms.values()) {
      players += r.players
      if (open(r)) games++
    }
    return { players, games }
  }

  private reserve(now: number, priv: boolean): string {
    let code = randomCode(this.rand)
    for (let i = 0; i < 64 && (this.rooms.has(code) || this.reserved.has(code)); i++) code = randomCode(this.rand)
    this.reserved.set(code, { code, until: now + RESERVE_MS, private: priv, claims: 1 })
    return code
  }
}
