/**
 * Client-side prediction and reconciliation for the local player.
 *
 * Each fixed-tick command gets a sequence number, is applied locally at once, and is kept until the server's
 * snapshot acknowledges it. On a snapshot: restore the server's state for the local player, then replay every
 * command the server has not applied yet. `Smoother` turns the resulting correction into a decaying visual offset.
 */
export type Pending<C> = { seq: number; cmd: C }

export class Predictor<C> {
  private pending: Pending<C>[] = []
  private next = 0
  /** Last acknowledged sequence. */
  ack = -1

  get unacked(): readonly Pending<C>[] {
    return this.pending
  }

  /** Assigns the next sequence number and keeps the command for replay. */
  record(cmd: C): number {
    const seq = this.next++
    this.pending.push({ seq, cmd })
    // A client that stops hearing from the server must not grow without bound.
    if (this.pending.length > 600) this.pending.shift()
    return seq
  }

  /**
   * Up to `max` unacknowledged commands immediately preceding the latest recorded command, in sequence order.
   * Bundling these with an upstream intent packet fills gaps if an earlier frame was dropped or coalesced.
   */
  prevCommands(max = 2): C[] {
    const end = this.pending.length - 1
    if (end <= 0 || max <= 0) return []
    const start = Math.max(0, end - max)
    const out: C[] = []
    for (let i = start; i < end; i++) out.push(this.pending[i]!.cmd)
    return out
  }

  /**
   * Applies the server's acknowledgement: `restore` resets local state to the snapshot (which already includes
   * every command up to `ack`), then `replay` re-applies the rest in order. Returns how many were replayed.
   */
  reconcile(ack: number, restore: () => void, replay: (cmd: C, seq: number) => void): number {
    if (ack < this.ack) return 0
    this.ack = ack
    let drop = 0
    while (drop < this.pending.length && this.pending[drop]!.seq <= ack) drop++
    if (drop) this.pending.splice(0, drop)
    restore()
    for (const p of this.pending) replay(p.cmd, p.seq)
    return this.pending.length
  }

  reset(): void {
    this.pending.length = 0
    this.ack = -1
  }
}

/** Decaying 2D render offset that hides reconciliation corrections; large errors snap. */
export class Smoother {
  x = 0
  y = 0

  constructor(
    public rate = 12,
    public snap = 2.5,
  ) {}

  /** Call with the position before and after a correction. */
  correct(beforeX: number, beforeY: number, afterX: number, afterY: number): void {
    this.x += beforeX - afterX
    this.y += beforeY - afterY
    if (Math.hypot(this.x, this.y) > this.snap) this.x = this.y = 0
  }

  step(dt: number): void {
    const k = Math.exp(-dt * this.rate)
    this.x *= k
    this.y *= k
    if (Math.abs(this.x) < 1e-4) this.x = 0
    if (Math.abs(this.y) < 1e-4) this.y = 0
  }
}
