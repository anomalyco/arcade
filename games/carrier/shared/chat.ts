// Text chat: the rules the room (server/core.ts) and the client (src/net.ts, src/ui/chat.ts) share. T talks to
// everyone in the room, Y to your own carrier's crew (its `team`, shared/crew.ts). The room stamps every line with the
// sender's id, crew name and team from its own crew, never from the client, and delivers a crew line only to players
// of the sender's team. Each player may send CHAT.burst lines per CHAT.windowMs; the room drops the rest silently and
// the client refuses them first, with a notice in the feed.

import { type Crew, playerOf } from "./crew"

export const CHAT = {
  /** Longest line, in code points, after cleaning. */
  max: 120,
  /** Lines a player may send per `windowMs`. */
  burst: 5,
  windowMs: 5000,
} as const

/** Who hears a line: everyone in the room, or the sender's carrier's crew. */
export type ChatChannel = "all" | "crew"

/** A line as the room relays it: the sender's id, name and team as the room knows them. */
export type ChatLine = { from: number; name: string; team: number; text: string; channel: ChatChannel }

/**
 * Chat text from anyone: control, bidi-override and zero-width characters become spaces, whitespace collapses, at most
 * CHAT.max code points. "" for anything that isn't a string or has nothing left.
 */
export function cleanChat(v: unknown): string {
  if (typeof v !== "string" || v.length > 4 * CHAT.max) return ""
  const s = v.replace(/[\p{Cc}\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/gu, " ").replace(/\s+/g, " ").trim()
  return Array.from(s).slice(0, CHAT.max).join("").trim()
}

/** Per-player send budget: at most `burst` lines in any `windowMs` (a sliding window). */
export class ChatLimiter {
  private sent = new Map<number, number[]>()

  constructor(
    private burst: number = CHAT.burst,
    private windowMs: number = CHAT.windowMs,
  ) {}

  /** Spends one line for player `id` at `now` (ms) if the budget allows it. */
  allow(id: number, now: number): boolean {
    const recent = (this.sent.get(id) ?? []).filter((t) => now - t < this.windowMs)
    const ok = recent.length < this.burst
    if (ok) recent.push(now)
    this.sent.set(id, recent)
    return ok
  }

  forget(id: number): void {
    this.sent.delete(id)
  }

  clear(): void {
    this.sent.clear()
  }
}

/** Whether player `listener` gets a line from a sender on `team`: everyone for "all", that team's crew for "crew". */
export function hearsChat(crew: Crew, listener: number, team: number, channel: ChatChannel): boolean {
  if (channel === "all") return true
  return playerOf(crew, listener)?.team === team
}
