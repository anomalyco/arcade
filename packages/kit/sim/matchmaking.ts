/**
 * Shared room-code generation, player-name sanitization, and in-memory/persisted Lobby matchmaking state across
 * Getaway, Blackout, and Carrier.
 */

export type BaseRoomReport = {
  code: string
  players: number
  private: boolean
  phase?: string
  mode?: string
}

export type RoomEntry<R extends BaseRoomReport = BaseRoomReport> = R & { updatedAt: number }

export type Reservation = {
  code: string
  until: number
  private: boolean
  claims: number
}

/** What `GET /api/room/:code` answers: whether anyone is there, and whether a joiner fits. */
export type RoomInfo = {
  code: string
  players: number
  full: boolean
  live: boolean
}

export const DEFAULT_RESERVE_MS = 8_000
export const DEFAULT_STALE_MS = 30_000
export const LOWER_CODE_CHARS = "abcdefghjkmnpqrstuvwxyz23456789"
export const UPPER_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ"

export function randomRoomCode(chars = LOWER_CODE_CHARS, rand: () => number = Math.random, length = 4): string {
  let out = ""
  for (let i = 0; i < length; i++) out += chars[Math.floor(rand() * chars.length)]
  return out
}

export function cleanPlayerName(v: unknown, maxLen: number, fallback: string): string {
  const s = typeof v === "string" ? v.replace(/[^\p{L}\p{N} _.'-]/gu, "").trim().slice(0, maxLen) : ""
  return s || fallback
}

/**
 * The open room quick join sends you to: the fullest one with space; optional `preferPhase` (e.g. `"waiting"`) breaks
 * player-count ties before latest report timestamp and lexicographic code.
 */
export function pickOpenRoom<R extends BaseRoomReport>(
  rooms: Iterable<RoomEntry<R>>,
  isOpen: (r: RoomEntry<R>) => boolean,
  preferPhase?: string,
): RoomEntry<R> | null {
  let best: RoomEntry<R> | null = null
  for (const r of rooms) {
    if (!isOpen(r)) continue
    if (!best) best = r
    else if (r.players !== best.players) best = r.players > best.players ? r : best
    else if (preferPhase && (r.phase === preferPhase) !== (best.phase === preferPhase))
      best = r.phase === preferPhase ? r : best
    else if (r.updatedAt !== best.updatedAt) best = r.updatedAt > best.updatedAt ? r : best
    else if (r.code < best.code) best = r
  }
  return best
}

export type MatchmakerConfig<R extends BaseRoomReport = BaseRoomReport> = {
  maxPlayers: number
  staleMs?: number
  reserveMs?: number
  rand?: () => number
  randomCode?: (rand: () => number) => string
  isOpen?: (r: RoomEntry<R>) => boolean
  preferPhase?: string
}

export class SharedMatchmaker<R extends BaseRoomReport = BaseRoomReport> {
  readonly rooms = new Map<string, RoomEntry<R>>()
  readonly reserved = new Map<string, Reservation>()
  private readonly maxPlayers: number
  private readonly staleMs: number
  private readonly reserveMs: number
  private readonly rand: () => number
  private readonly makeCode: (rand: () => number) => string
  private readonly open: (r: RoomEntry<R>) => boolean
  private readonly preferPhase?: string

  constructor(config: MatchmakerConfig<R>) {
    this.maxPlayers = config.maxPlayers
    this.staleMs = config.staleMs ?? DEFAULT_STALE_MS
    this.reserveMs = config.reserveMs ?? DEFAULT_RESERVE_MS
    this.rand = config.rand ?? Math.random
    this.makeCode = config.randomCode ?? ((r) => randomRoomCode(LOWER_CODE_CHARS, r))
    this.open = config.isOpen ?? ((r) => !r.private && r.players > 0 && r.players < this.maxPlayers)
    this.preferPhase = config.preferPhase
  }

  report(r: R, now: number): void {
    if (r.players > 0) {
      this.rooms.set(r.code, { ...r, updatedAt: now })
      this.reserved.delete(r.code)
    } else {
      this.rooms.delete(r.code)
    }
  }

  prune(now: number): void {
    for (const [code, r] of this.rooms) if (now - r.updatedAt > this.staleMs) this.rooms.delete(code)
    for (const [code, r] of this.reserved) if (now >= r.until) this.reserved.delete(code)
  }

  quick(now: number): string {
    this.prune(now)
    const room = pickOpenRoom(this.rooms.values(), this.open, this.preferPhase)
    if (room) return room.code
    for (const r of this.reserved.values()) {
      if (!r.private && r.claims < this.maxPlayers) {
        r.claims++
        return r.code
      }
    }
    return this.reserve(now, false)
  }

  create(now: number): string {
    this.prune(now)
    return this.reserve(now, true)
  }

  info(code: string, now: number): RoomInfo {
    this.prune(now)
    const r = this.rooms.get(code)
    const players = r?.players ?? 0
    return { code, players, full: players >= this.maxPlayers, live: !!r || this.reserved.has(code) }
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
    let code = this.makeCode(this.rand)
    for (let i = 0; i < 64 && (this.rooms.has(code) || this.reserved.has(code)); i++) code = this.makeCode(this.rand)
    this.reserved.set(code, { code, until: now + this.reserveMs, private: priv, claims: 1 })
    return code
  }
}
