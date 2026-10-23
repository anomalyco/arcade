/**
 * Asks "Leave site?" before the tab closes while `active()` says leaving would lose something (a room, a run, story
 * progress). Ctrl/Cmd+W can't be stopped from a page, only asked about (docs/controls.md, "Ctrl and Cmd+W"). Never
 * armed under automation, so captures and smoke runs can close their pages.
 */
export class LeaveGuard {
  private readonly handler = (e: BeforeUnloadEvent) => {
    if (!this.armed) return
    e.preventDefault()
    e.returnValue = ""
  }
  private readonly automated: boolean
  private readonly win: Pick<Window, "addEventListener" | "removeEventListener"> | null

  constructor(
    private readonly active: () => boolean,
    o: { automated?: boolean; win?: Pick<Window, "addEventListener" | "removeEventListener"> } = {},
  ) {
    this.automated = o.automated ?? (typeof navigator !== "undefined" && Boolean(navigator.webdriver))
    this.win = o.win ?? (typeof window === "undefined" ? null : window)
    this.win?.addEventListener("beforeunload", this.handler as EventListener)
  }

  get armed(): boolean {
    return !this.automated && this.active()
  }

  dispose(): void {
    this.win?.removeEventListener("beforeunload", this.handler as EventListener)
  }
}

/** Play time after which a solo game asks before closing (Outbreak's 30 s, playtest Oct 21). */
export const LEAVE_GUARD_AFTER_MS = 30_000

export type LoadingStage = { id: string; label: string; weight: number; fraction: number }

/**
 * Load progress, headless: weighted stages that report their own fraction, so the bar only moves on real work.
 * The shell's default view draws it as a bar under the title; a game with its own loading art (Night Shift's boot
 * screen, `@arcade/kit/client/boot-screen`) keeps it and skips this.
 */
export class ShellLoading {
  readonly stages: LoadingStage[] = []
  label = ""
  error: string | null = null
  finished = false
  private readonly listeners = new Set<() => void>()

  constructor(plan: Record<string, number> = {}) {
    for (const [id, weight] of Object.entries(plan)) this.stages.push({ id, label: id, weight, fraction: 0 })
  }

  /** 0..1 across the plan's weights. */
  get progress(): number {
    const total = this.stages.reduce((n, s) => n + s.weight, 0)
    return total > 0 ? this.stages.reduce((n, s) => n + s.weight * s.fraction, 0) / total : this.finished ? 1 : 0
  }

  /** Starts (or relabels) a stage; returns a setter for its fraction. */
  stage(id: string, label: string, weight = 1): (fraction: number) => void {
    let s = this.stages.find((x) => x.id === id)
    if (!s) this.stages.push((s = { id, label, weight, fraction: 0 }))
    s.label = label
    this.label = label
    this.emit()
    const stage = s
    return (fraction) => {
      stage.fraction = Math.max(stage.fraction, Math.min(1, fraction))
      this.emit()
    }
  }

  done(id: string): void {
    const s = this.stages.find((x) => x.id === id)
    if (s) s.fraction = 1
    this.emit()
  }

  /** Everything is loaded; the view fades out. */
  finish(): void {
    for (const s of this.stages) s.fraction = 1
    this.finished = true
    this.emit()
  }

  fail(message: string): void {
    this.error = message
    this.emit()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    for (const l of this.listeners) l()
  }
}
