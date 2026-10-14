export const TICK_HZ = 60
export const TICK_DT = 1 / TICK_HZ
export const TICK_MS = 1000 / TICK_HZ
/** Maximum fixed-tick substeps executed in a single frame callback (200 ms at 60 Hz). */
export const MAX_SUBSTEPS = 12
/** Maximum retained visible hitch debt (500 ms); larger stalls clamp to avoid catch-up spirals. */
export const MAX_HITCH_SECONDS = 0.5
export const MAX_HITCH_MS = MAX_HITCH_SECONDS * 1000

export type MoveSample = { mx: number; my: number; sprint?: boolean }
export type TimedSubstep = { dt: number; mx: number; my: number; sprint: boolean; interact: boolean; cycle: boolean; jump: boolean }

type MoveTransition = { atMs: number; mx: number; my: number; sprint: boolean }

/**
 * Deterministic fixed-tick accumulator with bounded hitch recovery and timestamped input transitions.
 *
 * - Ordinary visible wall time is accumulated in 1/60 s ticks rather than clamped and discarded at 50 ms.
 * - Single callbacks run at most MAX_SUBSTEPS ticks; remaining hitch debt up to MAX_HITCH_SECONDS recovers on
 *   subsequent callbacks without an unbounded catch-up spiral.
 * - Pause, blur, and hidden-tab transitions reset the time anchor so resuming never replays hidden wall time.
 * - Input changes recorded with their wall timestamp apply from the tick covering that timestamp onward, never
 *   retroactively across an earlier elapsed interval.
 */
export class FrameClock {
  private lastMs: number | null = null
  private accMs = 0
  private simCursorMs = 0
  private activeMove: { mx: number; my: number; sprint: boolean } = { mx: 0, my: 0, sprint: false }
  private latestMove: { mx: number; my: number; sprint: boolean } = { mx: 0, my: 0, sprint: false }
  private transitions: MoveTransition[] = []

  reset(nowMs: number | null = null, move: MoveSample = { mx: 0, my: 0 }): void {
    this.lastMs = nowMs
    this.accMs = 0
    this.simCursorMs = nowMs ?? 0
    this.activeMove = { mx: move.mx, my: move.my, sprint: Boolean(move.sprint) }
    this.latestMove = { mx: move.mx, my: move.my, sprint: Boolean(move.sprint) }
    this.transitions.length = 0
  }

  pause(nowMs: number | null = null): void {
    this.lastMs = nowMs
    this.accMs = 0
    this.simCursorMs = nowMs ?? 0
    this.activeMove = { ...this.latestMove }
    this.transitions.length = 0
  }

  /** Record a movement transition at its wall-clock timestamp so substeps do not replay it across earlier time. */
  recordMove(atMs: number, move: MoveSample): void {
    const sprint = Boolean(move.sprint)
    if (move.mx === this.latestMove.mx && move.my === this.latestMove.my && sprint === this.latestMove.sprint) return
    this.latestMove = { mx: move.mx, my: move.my, sprint }
    if (this.lastMs === null) {
      this.activeMove = { mx: move.mx, my: move.my, sprint }
      return
    }
    const clampedAt = Math.max(this.simCursorMs, atMs)
    const prev = this.transitions.at(-1)
    if (prev && Math.abs(prev.atMs - clampedAt) <= 1e-4) {
      prev.mx = move.mx
      prev.my = move.my
      prev.sprint = sprint
    } else {
      this.transitions.push({ atMs: clampedAt, mx: move.mx, my: move.my, sprint })
    }
  }

  get remainderAlpha(): number {
    return Math.max(0, Math.min(1, this.accMs / TICK_MS))
  }

  get retainedDebtSeconds(): number {
    return this.accMs / 1000
  }

  /** Whether advancing to nowMs will execute at least one fixed 60 Hz simulation step. */
  readyForStep(nowMs: number): boolean {
    if (this.lastMs === null) return true
    const elapsedMs = Math.max(0, nowMs - this.lastMs)
    return this.accMs + elapsedMs + 1e-4 >= TICK_MS
  }

  /** Milliseconds remaining until at least one fixed 60 Hz simulation step is due. */
  msUntilNextStep(nowMs: number): number {
    if (this.lastMs === null) return 0
    const elapsedMs = Math.max(0, nowMs - this.lastMs)
    return Math.max(0, TICK_MS - (this.accMs + elapsedMs))
  }

  frame(
    nowMs: number,
    liveMove: MoveSample,
    takeInteract?: () => boolean,
    takeCycle?: () => boolean,
    takeJump?: () => boolean,
  ): TimedSubstep[] {
    if (this.lastMs === null) {
      this.reset(nowMs, liveMove)
      return []
    }
    this.recordMove(nowMs, liveMove)
    const elapsedMs = Math.max(0, nowMs - this.lastMs)
    this.lastMs = nowMs

    const totalAccMs = this.accMs + elapsedMs
    if (totalAccMs > MAX_HITCH_MS) {
      const droppedMs = totalAccMs - MAX_HITCH_MS
      this.accMs = MAX_HITCH_MS
      this.simCursorMs += droppedMs
      while (this.transitions.length && this.transitions[0]!.atMs <= this.simCursorMs) {
        const t = this.transitions.shift()!
        this.activeMove = { mx: t.mx, my: t.my, sprint: t.sprint }
      }
    } else {
      this.accMs = totalAccMs
    }

    const steps = Math.min(MAX_SUBSTEPS, Math.floor((this.accMs + 1e-4) / TICK_MS))
    if (steps <= 0) return []

    const out: TimedSubstep[] = []
    const interact = takeInteract ? takeInteract() : false
    const cycle = takeCycle ? takeCycle() : false
    const jump = takeJump ? takeJump() : false
    for (let i = 0; i < steps; i++) {
      this.accMs = Math.max(0, this.accMs - TICK_MS)
      const tickStart = this.simCursorMs
      const tickEnd = tickStart + TICK_MS
      this.simCursorMs = tickEnd

      while (this.transitions.length && this.transitions[0]!.atMs <= tickStart + 1e-4) {
        const t = this.transitions.shift()!
        this.activeMove = { mx: t.mx, my: t.my, sprint: t.sprint }
      }

      let stepMove = this.activeMove
      let impulseMove: { mx: number; my: number; sprint: boolean } | null = null
      while (this.transitions.length && this.transitions[0]!.atMs <= tickEnd + 1e-4) {
        const t = this.transitions.shift()!
        if ((t.mx !== 0 || t.my !== 0) && !impulseMove) {
          impulseMove = { mx: t.mx, my: t.my, sprint: t.sprint }
        }
        if (tickEnd - t.atMs >= TICK_MS * 0.5 - 1e-4) {
          stepMove = { mx: t.mx, my: t.my, sprint: t.sprint }
        }
        this.activeMove = { mx: t.mx, my: t.my, sprint: t.sprint }
      }
      if (stepMove.mx === 0 && stepMove.my === 0 && impulseMove) {
        stepMove = impulseMove
      }

      out.push({
        dt: TICK_DT,
        mx: stepMove.mx,
        my: stepMove.my,
        sprint: stepMove.sprint,
        interact: i === 0 ? interact : false,
        cycle: i === 0 ? cycle : false,
        jump: i === 0 ? jump : false,
      })
    }
    return out
  }
}
