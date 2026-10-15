/**
 * Room seats: join, leave and reconnect. Every seat has a public `id` that other players see in rosters and
 * snapshots, and a private `token` that only its owner receives (in `welcome`) and presents to reclaim the seat
 * within the grace window. Knowing someone's public id is never enough to take their seat.
 */
export type Seat<P> = {
  /** Public, shown to everyone. */
  readonly id: string
  /** Private bearer secret for reconnecting. Never broadcast. */
  readonly token: string
  /** Lowest free slot when joined: stable colour/order. */
  readonly index: number
  name: string
  connected: boolean
  /** Clock time of the last disconnect. */
  leftAt: number
  data: P
}

export type JoinResult<P> = { ok: true; seat: Seat<P>; resumed: boolean } | { ok: false; reason: "full" }

const hex = (bytes: number) => {
  const b = new Uint8Array(bytes)
  crypto.getRandomValues(b)
  return Array.from(b, (v) => v.toString(16).padStart(2, "0")).join("")
}

export class Seats<P> {
  private readonly seats: Seat<P>[] = []

  constructor(
    readonly max: number,
    readonly graceMs: number,
    private readonly clock: () => number = Date.now,
  ) {}

  get all(): readonly Seat<P>[] {
    return this.seats
  }

  get connectedCount(): number {
    let n = 0
    for (const s of this.seats) if (s.connected) n++
    return n
  }

  byId(id: string): Seat<P> | undefined {
    return this.seats.find((s) => s.id === id)
  }

  /** Reclaims the seat holding `token` (connected or within grace), or takes a new one. */
  join(name: string, token: string | undefined, create: (index: number, id: string) => P): JoinResult<P> {
    const existing = token ? this.seats.find((s) => s.token === token) : undefined
    if (existing) {
      existing.connected = true
      existing.name = name || existing.name
      return { ok: true, seat: existing, resumed: true }
    }
    if (this.seats.length >= this.max) return { ok: false, reason: "full" }
    let index = 0
    while (this.seats.some((s) => s.index === index)) index++
    const id = `p${index + 1}${hex(2)}`
    const seat: Seat<P> = { id, token: hex(16), index, name, connected: true, leftAt: 0, data: create(index, id) }
    this.seats.push(seat)
    this.seats.sort((a, b) => a.index - b.index)
    return { ok: true, seat, resumed: false }
  }

  leave(id: string): void {
    const seat = this.byId(id)
    if (!seat || !seat.connected) return
    seat.connected = false
    seat.leftAt = this.clock()
  }

  /** Frees a seat at once (an idle kick), whether or not its owner is connected. */
  remove(id: string): Seat<P> | undefined {
    const i = this.seats.findIndex((s) => s.id === id)
    return i < 0 ? undefined : this.seats.splice(i, 1)[0]
  }

  /** Removes seats whose owners have been gone longer than the grace window; returns them. */
  expire(): Seat<P>[] {
    const now = this.clock()
    const gone: Seat<P>[] = []
    for (let i = this.seats.length - 1; i >= 0; i--) {
      const s = this.seats[i]!
      if (!s.connected && now - s.leftAt >= this.graceMs) gone.push(...this.seats.splice(i, 1))
    }
    return gone
  }
}
