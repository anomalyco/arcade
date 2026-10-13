import { CREW, randomCode } from "../shared/crew"

/**
 * What a Room tells the Lobby about itself: its code, how many players it holds (a room at CREW.roomMax is full),
 * and whether it was made with Create game.
 */
export type RoomReport = { code: string; players: number; private: boolean }
export type RoomEntry = RoomReport & { updatedAt: number }
type Reservation = { code: string; until: number; private: boolean; claims: number }

/** Rooms heartbeat every 10 s; an entry older than this belongs to a room that died without saying so. */
export const STALE_MS = 30_000
/** A freshly handed-out code stays taken this long, so simultaneous quick-joiners share it until the room reports in. */
export const RESERVE_MS = 8_000

/**
 * Quick join's rule: a public room with people in it and space left. Rooms made with Create game are for playing with
 * friends, so quick join never sends strangers there (they're still joinable by code or link).
 */
export const isOpen = (r: RoomReport): boolean => !r.private && r.players > 0 && r.players < CREW.roomMax

/** The room quick join sends you to: the open one with the most players; ties go to the latest report, then the code. */
export function pickRoom(rooms: Iterable<RoomEntry>, open: (r: RoomEntry) => boolean = isOpen): RoomEntry | null {
  let best: RoomEntry | null = null
  for (const r of rooms) {
    if (!open(r)) continue
    if (!best) best = r
    else if (r.players !== best.players) best = r.players > best.players ? r : best
    else if (r.updatedAt !== best.updatedAt) best = r.updatedAt > best.updatedAt ? r : best
    else if (r.code < best.code) best = r
  }
  return best
}

/** What `GET /api/room/:code` answers: whether anyone is there, and whether a joiner fits. */
export type RoomInfo = { code: string; players: number; full: boolean; live: boolean }

/** Matchmaking state held by the singleton Lobby: live room reports plus short-lived code reservations. */
export class Matchmaker {
  readonly rooms = new Map<string, RoomEntry>()
  readonly reserved = new Map<string, Reservation>()

  constructor(
    private rand: () => number = Math.random,
    private open: (r: RoomEntry) => boolean = isOpen,
  ) {}

  report(r: RoomReport, now: number): void {
    if (r.players > 0) {
      this.rooms.set(r.code, { ...r, updatedAt: now })
      // The room speaks for itself now; its own entry replaces the reservation.
      this.reserved.delete(r.code)
    } else this.rooms.delete(r.code)
  }

  prune(now: number): void {
    for (const [code, r] of this.rooms) if (now - r.updatedAt > STALE_MS) this.rooms.delete(code)
    for (const [code, r] of this.reserved) if (now >= r.until) this.reserved.delete(code)
  }

  /** A room code for quick join: the best open room, else a shared reservation for a brand-new public room. */
  quick(now: number): string {
    this.prune(now)
    const room = pickRoom(this.rooms.values(), this.open)
    if (room) return room.code
    for (const r of this.reserved.values())
      if (!r.private && r.claims < CREW.roomMax) {
        r.claims++
        return r.code
      }
    return this.reserve(now, false)
  }

  /** A fresh private room code, unused by any live room or reservation. Quick join never hands it out. */
  create(now: number): string {
    this.prune(now)
    return this.reserve(now, true)
  }

  info(code: string, now: number): RoomInfo {
    this.prune(now)
    const r = this.rooms.get(code)
    const players = r?.players ?? 0
    return { code, players, full: players >= CREW.roomMax, live: !!r || this.reserved.has(code) }
  }

  stats(now: number): { players: number; games: number } {
    this.prune(now)
    let players = 0
    let games = 0
    for (const r of this.rooms.values()) {
      players += r.players
      if (this.open(r)) games++
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
