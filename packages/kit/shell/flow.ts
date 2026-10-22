/** What the shell is showing: the title (before play and after Leave), play, or the pause menu. */
export type ShellScreen = "title" | "playing" | "paused"

type Doc = Pick<Document, "addEventListener" | "removeEventListener"> & {
  readonly pointerLockElement: Element | null
  readonly hidden?: boolean
  exitPointerLock?(): void
}
type Win = Pick<Window, "addEventListener" | "removeEventListener">

export type ShellFlowOptions = {
  /**
   * A pointer-lock game's canvas. Play then means holding the lock: Play and Resume request it, and losing it (Esc,
   * which the browser eats while locked, a Cmd-Tab, the Lab panel) opens the pause menu.
   */
  pointerLock?: HTMLElement | null
  /** Hides the shell's overlays without changing the screen, e.g. while the Lab panel is open. */
  blocked?: () => boolean
  /** Something else owns Escape right now (an open game menu, chat, the Lab panel's focus): the shell ignores it. */
  escapeOwned?: () => boolean
  /** Non-pointer-lock games: open the pause menu when the tab is hidden (solo games). */
  pauseOnHidden?: boolean
  /** Starts on the title (default) or straight in play (`?room=` deep links, automation). */
  start?: "title" | "playing"
  /** Requests the lock (tests swap it out); `requestCanvasPointerLock` by default. */
  requestLock?: (el: HTMLElement) => void
  doc?: Doc
  win?: Win
}

/**
 * The shell's one state machine: title → play → pause → play, Leave back to the title, with a Settings view over
 * the title or the pause menu. Escape opens pause and steps back out (Settings → menu → play); pointer-lock games
 * pause whenever the lock goes and resume by taking it again from a click. It is never possible to get stuck: Resume
 * and a click outside the card always try again, and a refused lock leaves the menu up with `lockRefused` set.
 */
export class ShellFlow {
  private begun: boolean
  private pausedFlag = false
  private _settingsOpen = false
  /** When the pointer lock last went: an Escape right after it is the one that released it, not a second press. */
  private lostAt = -Infinity
  private _lockRefused = false
  private readonly listeners = new Set<() => void>()
  private readonly doc: Doc
  private readonly win: Win
  private readonly target: HTMLElement | null
  private readonly abort: (() => void)[] = []

  constructor(private readonly o: ShellFlowOptions = {}) {
    this.doc = o.doc ?? document
    this.win = o.win ?? window
    this.target = o.pointerLock ?? null
    this.begun = o.start === "playing"
    this.on(this.doc, "pointerlockchange", () => this.lockChanged())
    this.on(this.doc, "pointerlockerror", () => {
      this._lockRefused = true
      this.emit()
    })
    this.on(this.win, "keydown", (e) => this.key(e as KeyboardEvent))
    this.on(this.doc, "visibilitychange", () => {
      if (this.doc.hidden && this.o.pauseOnHidden && !this.target && this.screen === "playing") this.pause()
    })
  }

  get screen(): ShellScreen {
    if (!this.begun) return "title"
    if (this.target) return this.locked ? "playing" : "paused"
    return this.pausedFlag ? "paused" : "playing"
  }

  /** The card to draw: the title or pause menu, or nothing (in play, or hidden by `blocked`). */
  get overlay(): "title" | "paused" | null {
    const s = this.screen
    if (s === "playing" || this.o.blocked?.()) return null
    return s
  }

  get settingsOpen(): boolean {
    return this._settingsOpen && this.screen !== "playing"
  }

  /** The browser refused the last lock request (too soon after Esc); the menu stays and says to click again. */
  get lockRefused(): boolean {
    return this._lockRefused
  }

  /** Has the player left the title since the page (or the last Leave)? */
  get started(): boolean {
    return this.begun
  }

  /** From the title: start playing (takes the pointer lock in pointer-lock games; call it from a click). */
  play(): void {
    this._settingsOpen = false
    this._lockRefused = false
    if (this.target) {
      if (this.locked) {
        this.begun = true
        this.emit()
        return
      }
      this.lock()
      this.emit()
      return
    }
    this.begun = true
    this.pausedFlag = false
    this.emit()
  }

  /** Opens the pause menu (releases the pointer lock). */
  pause(): void {
    if (!this.begun) return
    if (this.target) {
      if (this.locked) this.doc.exitPointerLock?.()
    } else this.pausedFlag = true
    this.emit()
  }

  /** Back to play from the pause menu (or Settings over it). Call it from a click in pointer-lock games. */
  resume(): void {
    this._settingsOpen = false
    this._lockRefused = false
    if (!this.begun) return this.play()
    if (this.target) this.lock()
    else this.pausedFlag = false
    this.emit()
  }

  /** Back to the title (the game leaves its room or run in `onLeave`). */
  leave(): void {
    this.begun = false
    this.pausedFlag = false
    this._settingsOpen = false
    if (this.target && this.locked) this.doc.exitPointerLock?.()
    this.emit()
  }

  openSettings(open = true): void {
    if (open && this.screen === "playing") this.pause()
    this._settingsOpen = open
    this.emit()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Re-check `blocked` and redraw (call when the Lab panel opens or closes). */
  changed(): void {
    this.emit()
  }

  dispose(): void {
    for (const off of this.abort) off()
    this.listeners.clear()
  }

  private get locked(): boolean {
    return this.target !== null && this.doc.pointerLockElement === this.target
  }

  private lock(): void {
    if (!this.target) return
    ;(this.o.requestLock ?? defaultLock)(this.target)
  }

  private lockChanged(): void {
    if (this.locked) {
      this.begun = true
      this._settingsOpen = false
      this._lockRefused = false
    } else this.lostAt = now()
    this.emit()
  }

  private key(e: KeyboardEvent): void {
    if (e.code !== "Escape" || e.repeat || e.defaultPrevented || this.o.escapeOwned?.()) return
    if (isEditable(e.target)) {
      ;(e.target as HTMLElement).blur?.()
      return
    }
    if (this._settingsOpen && this.screen !== "playing") {
      this._settingsOpen = false
      this.emit()
      return
    }
    const s = this.screen
    if (this.target && now() - this.lostAt < 300) return
    if (s === "playing") this.pause()
    // In pointer-lock games Escape while paused tries to take the lock back; a refusal leaves the menu up.
    else if (s === "paused" && !this.o.blocked?.()) this.resume()
  }

  private on(t: Pick<EventTarget, "addEventListener" | "removeEventListener">, type: string, fn: (e: Event) => void): void {
    t.addEventListener(type, fn)
    this.abort.push(() => t.removeEventListener(type, fn))
  }

  private emit(): void {
    for (const l of this.listeners) l()
  }
}

const now = () => (typeof performance === "undefined" ? Date.now() : performance.now())

function defaultLock(el: HTMLElement): void {
  const c = el as HTMLElement & { requestPointerLock(o?: { unadjustedMovement?: boolean }): Promise<void> | void }
  const plain = () => {
    try {
      void Promise.resolve(c.requestPointerLock()).catch(() => {})
    } catch {}
  }
  try {
    const p = c.requestPointerLock({ unadjustedMovement: true })
    if (p) void p.catch(plain)
  } catch {
    plain()
  }
}

function isEditable(t: EventTarget | null): boolean {
  const el = t as { tagName?: string; isContentEditable?: boolean } | null
  const tag = el?.tagName?.toUpperCase() ?? ""
  return Boolean(el?.isContentEditable) || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT"
}
