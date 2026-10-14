import { KeyStateTracker, requestCanvasPointerLock } from "@arcade/kit/client/controls"

/**
 * Keyboard and mouse. Physical WASD (`KeyW`, `KeyA`, `KeyS`, `KeyD`) or arrows drive the ship or pan the free camera,
 * Shift pans faster, the wheel zooms the free camera.
 *
 * The mouse looks around, Battlefield-vehicle style: while `lockable` (the game sets it: aboard, not in the free camera,
 * no menu), a left click on the canvas takes Pointer Lock and from then on plain mouse movement is the look delta
 * (`dragX`/`dragY`), no button held. The same lock is the flight stick in the air (src/flight/input.ts reads it from
 * the same canvas), so ship ↔ jet hand-offs keep it. Esc releases it (the browser's own); the next click takes it
 * again. Menus `suspend()` it and `resume()` it on close, only if it was held when they opened. Without Pointer Lock
 * (denied, unsupported, the free camera) dragging still looks.
 */
export class Input {
  private readonly tracker: KeyStateTracker
  private drag = false
  private dx = 0
  private dy = 0
  private wheelDelta = 0
  private locked = false
  /** A menu took the lock away and should hand it back when it closes. */
  private resumeLock = false
  /** Whether a click on the canvas takes Pointer Lock (set by the game every frame). */
  lockable = false

  constructor(private canvas: HTMLElement) {
    canvas.tabIndex = -1
    this.tracker = new KeyStateTracker({ onRelease: () => (this.drag = false) })
    canvas.addEventListener("mousedown", (e) => {
      e.preventDefault()
      canvas.focus({ preventScroll: true })
      this.drag = true
      if (e.button === 0 && this.lockable && !this.locked) this.lock()
    })
    // Updated on the event, so a menu that exits the lock just before calling `suspend` still sees it as held.
    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === canvas
    })
    addEventListener("mouseup", () => {
      this.drag = false
    })
    addEventListener("mousemove", (e) => {
      if (!this.drag && !this.locked) return
      this.dx += e.movementX
      this.dy += e.movementY
    })
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault()
        this.wheelDelta += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
      },
      { passive: false },
    )
    canvas.addEventListener("contextmenu", (e) => e.preventDefault())
  }

  /** Takes Pointer Lock (raw mouse movement where the browser allows it). Needs a click, or a lock a menu suspended. */
  lock(): void {
    requestCanvasPointerLock(this.canvas)
  }

  /** Lets go of Pointer Lock for good (the free camera); the next click on the canvas takes it again. */
  unlock(): void {
    this.resumeLock = false
    if (document.pointerLockElement === this.canvas) document.exitPointerLock()
  }

  /** A menu opened: free the cursor, remembering whether to take the lock back when it closes. */
  suspend(): void {
    if (this.locked) this.resumeLock = true
    if (document.pointerLockElement === this.canvas) document.exitPointerLock()
  }

  /**
   * Every menu closed: take the lock back if a menu took it (browsers allow it without a click after the page itself
   * released it; if one refuses, the next click on the canvas does it). Waits while the game isn't `lockable`.
   */
  resume(): void {
    if (!this.resumeLock || !this.lockable) return
    this.resumeLock = false
    if (!this.locked) this.lock()
  }

  /** Pointer Lock is held: plain mouse movement looks. */
  get pointerLocked(): boolean {
    return this.locked
  }

  release(): void {
    this.tracker.release()
    this.drag = false
  }

  held(code: string): boolean {
    return this.tracker.held(code)
  }

  /** Whether any of these physical codes went down since the last `endFrame`. */
  pressed(...codes: string[]): boolean {
    return this.tracker.pressed(...codes)
  }

  /** Pan intent to the right, -1..1. */
  get right(): number {
    return (this.tracker.any("KeyD", "ArrowRight") ? 1 : 0) - (this.tracker.any("KeyA", "ArrowLeft") ? 1 : 0)
  }

  /** Pan intent ahead, -1..1. */
  get ahead(): number {
    return (this.tracker.any("KeyW", "ArrowUp") ? 1 : 0) - (this.tracker.any("KeyS", "ArrowDown") ? 1 : 0)
  }

  get fast(): boolean {
    return this.tracker.any("ShiftLeft", "ShiftRight")
  }

  /** Mouse movement under Pointer Lock, or while dragging, since the last `endFrame`, in CSS pixels. */
  get dragX(): number {
    return this.dx
  }

  get dragY(): number {
    return this.dy
  }

  /** Wheel delta in pixels since the last `endFrame`. */
  get wheel(): number {
    return this.wheelDelta
  }

  /** Mouse button held on the canvas. */
  get dragging(): boolean {
    return this.drag
  }

  /** Clears the per-frame drag, wheel and key-press accumulators. */
  endFrame(): void {
    this.dx = this.dy = this.wheelDelta = 0
    this.tracker.clearDowns()
  }
}
