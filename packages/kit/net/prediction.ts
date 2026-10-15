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

/**
 * One optimistically predicted action ("predict the feedback, confirm the outcome").
 * Cosmetic feedback fires on the press frame (`seq`); when the server acknowledges `seq` (or sends a matching
 * event), the prediction is either confirmed (suppressing duplicate local feedback) or rejected (invoking `rollback`
 * to quietly ease local state back without a pop). While `seq > ack`, `reapply` keeps optimistic world overlays
 * active across intermediate snapshots.
 */
export type OptimisticEvent<K extends string = string, P = unknown> = {
  id: number
  seq: number
  kind: K
  key?: string
  payload: P
  reapply?: () => void
  rollback?: (event: OptimisticEvent<K, P>) => void
  confirm?: (event: OptimisticEvent<K, P>) => void
}

export class OptimisticEvents<K extends string = string, P = unknown> {
  private pending: OptimisticEvent<K, P>[] = []
  private nextId = 0
  readonly stats = { predicted: 0, confirmed: 0, rejected: 0 }

  get entries(): readonly OptimisticEvent<K, P>[] {
    return this.pending
  }

  get mispredictionRate(): number {
    const resolved = this.stats.confirmed + this.stats.rejected
    return resolved > 0 ? this.stats.rejected / resolved : 0
  }

  /** Records a new optimistic action on the press frame and returns its assigned event (with monotonic `id`). */
  predict(init: Omit<OptimisticEvent<K, P>, "id">): OptimisticEvent<K, P> {
    if (init.key !== undefined) {
      const idx = this.pending.findIndex((e) => e.key === init.key)
      if (idx >= 0) this.pending.splice(idx, 1)
    }
    const ev: OptimisticEvent<K, P> = { ...init, id: ++this.nextId }
    this.stats.predicted++
    this.pending.push(ev)
    if (this.pending.length > 256) this.pending.shift()
    return ev
  }

  /** Confirms and removes the oldest pending event matching `match` (for example when a server event arrives). */
  confirmWhere(match: (event: OptimisticEvent<K, P>) => boolean): OptimisticEvent<K, P> | undefined {
    const idx = this.pending.findIndex(match)
    if (idx < 0) return undefined
    const [ev] = this.pending.splice(idx, 1)
    if (!ev) return undefined
    this.stats.confirmed++
    ev.confirm?.(ev)
    return ev
  }

  /** Confirms and removes a pending event by its `key`. */
  confirmByKey(key: string): OptimisticEvent<K, P> | undefined {
    return this.confirmWhere((e) => e.key === key)
  }

  /**
   * Resolves all pending events with `seq <= ackSeq`: each event is confirmed if `isConfirmed(ev)` returns true,
   * or rejected (calling `ev.rollback`) otherwise. Remaining in-flight events (`seq > ackSeq`) run `ev.reapply()`.
   */
  reconcile(
    ackSeq: number,
    isConfirmed?: (event: OptimisticEvent<K, P>) => boolean,
  ): { confirmed: OptimisticEvent<K, P>[]; rejected: OptimisticEvent<K, P>[] } {
    const confirmed: OptimisticEvent<K, P>[] = []
    const rejected: OptimisticEvent<K, P>[] = []
    let i = 0
    while (i < this.pending.length) {
      const ev = this.pending[i]!
      if (ev.seq <= ackSeq) {
        this.pending.splice(i, 1)
        if (isConfirmed?.(ev)) {
          this.stats.confirmed++
          ev.confirm?.(ev)
          confirmed.push(ev)
        } else {
          this.stats.rejected++
          ev.rollback?.(ev)
          rejected.push(ev)
        }
      } else {
        i++
      }
    }
    for (const ev of this.pending) ev.reapply?.()
    return { confirmed, rejected }
  }

  hasPending(kind?: K, key?: string): boolean {
    return this.pending.some((e) => (kind === undefined || e.kind === kind) && (key === undefined || e.key === key))
  }

  findPending(match: (event: OptimisticEvent<K, P>) => boolean): OptimisticEvent<K, P> | undefined {
    return this.pending.find(match)
  }

  reset(): void {
    this.pending.length = 0
  }
}
