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
  /** How long a click's lock request waits after the player's Esc, and before its one retry (tests shorten them). */
  relockMs?: { afterEsc: number; retry: number }
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
  /** Settings was opened from play (a HUD gear or speaker button): closing it plays again instead of showing the pause card. */
  private settingsFromPlay = false
  /** When the pointer lock last went: an Escape right after it is the one that released it, not a second press. */
  private lostAt = -Infinity
  /** The player let go of the lock (Esc, a Cmd-Tab), not the shell: the browser refuses a new lock for a moment. */
  private userLost = false
  /** The shell is releasing the lock itself (pause, Leave), which the browser doesn't hold against the next lock. */
  private releasing = false
  private _lockRefused = false
  /** A click's lock request, held until the browser's cooldown after Esc is over. */
  private pending: ReturnType<typeof setTimeout> | null = null
  /** When the click asked for the lock, and whether its one quiet retry is spent. */
  private askedAt = -Infinity
  private retried = false
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
      // Refused (still the browser's cooldown): the click's activation lasts a few seconds, so ask once more quietly.
      if (!this.retried && now() - this.askedAt < RETRY_WITHIN_MS && this.target) {
        this.retried = true
        this.schedule(this.o.relockMs?.retry ?? RETRY_AFTER_MS)
        return
      }
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

  /** The browser refused the last lock request even after waiting; the menu stays and says to click again. */
  get lockRefused(): boolean {
    return this._lockRefused
  }

  /** A click asked for the lock and the shell is waiting out the browser's cooldown after Esc to take it. */
  get arming(): boolean {
    return this.pending !== null
  }

  /** Has the player left the title since the page (or the last Leave)? */
  get started(): boolean {
    return this.begun
  }

  /** From the title: start playing (takes the pointer lock in pointer-lock games; call it from a click). */
  play(): void {
    this._settingsOpen = false
    this.settingsFromPlay = false
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
      if (this.locked) this.release()
    } else this.pausedFlag = true
    this.emit()
  }

  /** Back to play from the pause menu (or Settings over it). Call it from a click in pointer-lock games. */
  resume(): void {
    this._settingsOpen = false
    this.settingsFromPlay = false
    this._lockRefused = false
    if (!this.begun) return this.play()
    if (this.target) this.lock()
    else this.pausedFlag = false
    this.emit()
  }

  /** Back to the title (the game leaves its room or run in `onLeave`). */
  leave(): void {
    this.settingsFromPlay = false
    this.begun = false
    this.pausedFlag = false
    this._settingsOpen = false
    this.cancelLock()
    if (this.target && this.locked) this.release()
    this.emit()
  }

  /** Opens or closes Settings. Opened in play, it pauses; closing it then plays again (not in pointer-lock games, whose lock needs a click on Resume). */
  openSettings(open = true): void {
    if (open) {
      this.settingsFromPlay = this.screen === "playing" && !this.target
      if (this.screen === "playing") this.pause()
    }
    this._settingsOpen = open
    if (!open && this.settingsFromPlay) {
      this.settingsFromPlay = false
      this.resume()
      return
    }
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
    this.cancelLock()
    for (const off of this.abort) off()
    this.listeners.clear()
  }

  private get locked(): boolean {
    return this.target !== null && this.doc.pointerLockElement === this.target
  }

  /** Asks for the lock from a click. Right after the player's own Esc the browser refuses it, so the request waits out that cooldown (well inside the click's activation): one click is always enough. */
  private lock(): void {
    if (!this.target) return
    this.askedAt = now()
    this.retried = false
    this.schedule(this.userLost ? this.lostAt + (this.o.relockMs?.afterEsc ?? RELOCK_AFTER_MS) - now() : 0)
  }

  private schedule(wait: number): void {
    this.cancelLock()
    const target = this.target
    if (!target) return
    const ask = () => {
      this.pending = null
      if (this.begun && this.locked) return
      ;(this.o.requestLock ?? defaultLock)(target)
      this.emit()
    }
    if (wait <= 0) return ask()
    this.pending = setTimeout(ask, wait)
    this.emit()
  }

  private cancelLock(): void {
    if (this.pending === null) return
    clearTimeout(this.pending)
    this.pending = null
  }

  private release(): void {
    this.releasing = true
    this.doc.exitPointerLock?.()
  }

  private lockChanged(): void {
    if (this.locked) {
      this.begun = true
      this._settingsOpen = false
      this._lockRefused = false
      this.cancelLock()
    } else {
      this.lostAt = now()
      this.userLost = !this.releasing
    }
    this.releasing = false
    this.emit()
  }

  private key(e: KeyboardEvent): void {
    if (e.code !== "Escape" || e.repeat || e.defaultPrevented || this.o.escapeOwned?.()) return
    if (isTextEntry(e.target)) {
      ;(e.target as HTMLElement).blur?.()
      return
    }
    if (this._settingsOpen && this.screen !== "playing") return this.openSettings(false)
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
/** Chrome refuses a lock for about a second after the player's Esc (crbug 40779661); a click's activation lasts 5 s. */
const RELOCK_AFTER_MS = 1100
const RETRY_AFTER_MS = 500
const RETRY_WITHIN_MS = 4000

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

/** Inputs that take no typing: a volume slider or checkbox keeps focus after use, and M and Escape must still work. */
const NON_TEXT_INPUTS = new Set(["range", "checkbox", "radio", "button", "submit", "reset", "color", "file", "image"])

/** Is the key going into a text field (where M is a letter and Escape only leaves the field)? */
export function isTextEntry(t: unknown): boolean {
  const el = t as { tagName?: string; type?: string; isContentEditable?: boolean } | null
  const tag = el?.tagName?.toUpperCase() ?? ""
  if (tag === "INPUT") return !NON_TEXT_INPUTS.has((el?.type ?? "text").toLowerCase())
  return Boolean(el?.isContentEditable) || tag === "TEXTAREA" || tag === "SELECT"
}
