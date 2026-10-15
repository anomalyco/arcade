/**
 * A deterministic model of one direction of a WebSocket between a browser on Wi-Fi and a Durable Object, for headless
 * netcode benches and tests. A WebSocket runs over TCP, so nothing is ever lost or reordered: a lost segment is
 * retransmitted after `rtoMs` and everything sent behind it waits (head-of-line blocking), and a Wi-Fi stall (a
 * channel scan, power save, a burst of interference) holds everything until it ends. Both turn into bursts.
 */
export type LinkProfile = {
  name: string
  /** Round trip time; each direction gets half. */
  rttMs: number
  /** One-way delay varies uniformly by ± this. */
  jitterMs: number
  /** Chance a message's segment is lost and retransmitted. */
  loss: number
  /** Retransmit delay after a loss (Linux's floor is 200 ms; fast retransmit is about one RTT). */
  rtoMs?: number
  /** Wi-Fi stalls: on average one every `stallEveryMs`, lasting `stallMs`. */
  stallEveryMs?: number
  stallMs?: number
}

export const LINKS = {
  /** Wired or a quiet 5 GHz network near the edge. */
  good: { name: "good · 30 ms", rttMs: 30, jitterMs: 3, loss: 0 },
  /** Home Wi-Fi to a nearby colo: some jitter, 1% loss, a short stall every ~10 s. */
  wifi: { name: "wifi · 80 ms ± 15, 1%, stalls", rttMs: 80, jitterMs: 15, loss: 0.01, stallEveryMs: 10_000, stallMs: 150 },
  /** Busy Wi-Fi or a far colo: 150 ms, 2% loss, a 250 ms stall every ~5 s. */
  bad: { name: "bad · 150 ms ± 30, 2%, stalls", rttMs: 150, jitterMs: 30, loss: 0.02, stallEveryMs: 5_000, stallMs: 250 },
} satisfies Record<string, LinkProfile>

/** One direction of a link: `deliver(sentAt)` says when a message sent at `sentAt` (ms) arrives. Call in send order. */
export class TcpLink {
  private last = 0
  private stallStart = Infinity
  private stallEnd = -Infinity

  constructor(
    readonly profile: LinkProfile,
    private readonly rand: () => number,
  ) {
    this.nextStall(0)
  }

  private nextStall(after: number): void {
    const p = this.profile
    if (!p.stallEveryMs || !p.stallMs) {
      this.stallStart = this.stallEnd = Infinity
      return
    }
    this.stallStart = after + -Math.log(1 - this.rand()) * p.stallEveryMs
    this.stallEnd = this.stallStart + p.stallMs
  }

  deliver(sentAt: number): number {
    const p = this.profile
    let at = sentAt + p.rttMs / 2 + (this.rand() * 2 - 1) * p.jitterMs
    if (this.rand() < p.loss) at += p.rtoMs ?? Math.max(200, p.rttMs)
    while (at >= this.stallEnd) this.nextStall(this.stallEnd)
    if (at >= this.stallStart) at = this.stallEnd
    this.last = Math.max(this.last, at)
    return this.last
  }
}

/** Messages in flight on one link, delivered in order once their time comes. */
export class LinkQueue<T> {
  private items: { at: number; msg: T }[] = []

  constructor(readonly link: TcpLink) {}

  send(now: number, msg: T): void {
    this.items.push({ at: this.link.deliver(now), msg })
  }

  /** Everything that has arrived by `now`, in order. */
  *arrived(now: number): Generator<T> {
    while (this.items.length && this.items[0]!.at <= now) yield this.items.shift()!.msg
  }

  get size(): number {
    return this.items.length
  }
}
