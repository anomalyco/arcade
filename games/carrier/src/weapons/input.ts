/**
 * Weapon controls while flying, Battlefield-style (BF3/BF4 jets fire on Space + LMB and pick weapons with 1/2 or a
 * switch key; here F is taken by flares, BF's countermeasure key being X, which is our free look):
 * - Space or left mouse (under Pointer Lock): fire the selected weapon (hold for the cannon).
 * - 1, 2, 3: select the aircraft's first, second, third weapon (only those it has). Mouse wheel or V: cycle them.
 * - F: flares.
 *
 * Keys match by physical position (`e.code`) and by character (`e.key`), so any layout works; the character a key
 * produced on press is the one released, and everything releases on Cmd-up and on blur. Digits match by code too, so
 * AZERTY's unshifted digit row works. None of Space, 1-3, V, F or the wheel is a movement key on QWERTY, AZERTY or
 * Dvorak (V is Dvorak's K position, Dvorak's V is on QWERTY's period).
 */
export class WeaponInput {
  /** Off: nothing is read (not flying, menus, debug panel). */
  enabled = true
  private keys = new Set<string>()
  private chars = new Map<string, string>()
  private downs = new Set<string>()
  private mouseFire = false
  private wheel = 0
  private wheelAt = 0
  /** Test hook: when set, overrides the trigger. */
  trigger: boolean | null = null

  constructor(private canvas: HTMLCanvasElement) {
    addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.code === "Space") e.preventDefault()
      if (this.keys.has(e.code)) return
      const k = e.key.toLowerCase()
      this.keys.add(e.code)
      this.keys.add(k)
      this.chars.set(e.code, k)
      this.downs.add(e.code)
      this.downs.add(k)
    })
    addEventListener("keyup", (e) => {
      this.keys.delete(e.code)
      const down = this.chars.get(e.code)
      if (down !== undefined) this.keys.delete(down)
      this.chars.delete(e.code)
      if (e.code === "MetaLeft" || e.code === "MetaRight") this.release()
    })
    addEventListener("blur", () => this.release())
    canvas.addEventListener("mousedown", (e) => {
      // Left mouse fires only once the pointer is locked: the first click captures it (flight/input.ts).
      if (e.button === 0 && document.pointerLockElement === canvas) this.mouseFire = true
    })
    addEventListener("mouseup", (e) => {
      if (e.button === 0) this.mouseFire = false
    })
    document.addEventListener("pointerlockchange", () => {
      if (document.pointerLockElement !== canvas) this.mouseFire = false
    })
    addEventListener(
      "wheel",
      (e) => {
        if (!this.enabled || e.target !== canvas) return
        // One notch per step, however the device scales deltas; a trackpad's stream is rate-limited.
        const now = performance.now()
        if (now - this.wheelAt < 120 || Math.abs(e.deltaY) < 1) return
        this.wheelAt = now
        this.wheel += Math.sign(e.deltaY)
      },
      { passive: true },
    )
  }

  release(): void {
    this.keys.clear()
    this.chars.clear()
    this.downs.clear()
    this.mouseFire = false
  }

  private any(...k: string[]): boolean {
    for (const x of k) if (this.keys.has(x)) return true
    return false
  }

  private pressed(...k: string[]): boolean {
    for (const x of k) if (this.downs.has(x)) return true
    return false
  }

  /** Trigger held (Space or left mouse). */
  get fire(): boolean {
    if (!this.enabled) return false
    if (this.trigger !== null) return this.trigger
    return this.mouseFire || this.any("Space", " ")
  }

  /** Slot picked this frame by a number key (0-based), or -1. */
  get select(): number {
    if (!this.enabled) return -1
    if (this.pressed("Digit1", "Numpad1")) return 0
    if (this.pressed("Digit2", "Numpad2")) return 1
    if (this.pressed("Digit3", "Numpad3")) return 2
    return -1
  }

  /** Cycle steps this frame: wheel notches (down = next) and V. */
  get cycle(): number {
    if (!this.enabled) return 0
    return this.wheel + (this.pressed("KeyV", "v") ? 1 : 0)
  }

  /** Flares asked for this frame. */
  get flares(): boolean {
    return this.enabled && this.pressed("KeyF", "f")
  }

  endFrame(): void {
    this.downs.clear()
    this.wheel = 0
  }
}
