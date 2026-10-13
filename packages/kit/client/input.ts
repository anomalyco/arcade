/**
 * Keyboard and mouse. WASD or arrows move on screen axes, the mouse aims, hold right click to look further ahead,
 * hold left click to fire, hold Shift to sprint, R reloads, G or
 * middle click throws or plants your equipment, V swings melee (where the mode allows), F gets in or out of a vehicle
 * (H honks at the wheel), 1/2/3 pick a gun and 4/5 frag or claymore for your next life, Tab shows the scores.
 */
export type MuxState = { x: number; y: number; vx: number; vy: number; aim: number; tx: number; ty: number }
export type MuxKey = { type: "mux-key"; kind: "keydown" | "keyup"; code: string; key: string; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }
export type MuxMouse = { type: "mux-mouse"; nx: number; ny: number; buttons?: number; down?: number; up?: number; wheel?: number }

export class Input<Selection extends string = string> {
  spellMode = false
  castSpell: (() => Selection) | null = null
  private casts: { x: number; y: number; spell: Selection }[] = []
  takeCast() { const click = this.casts.shift(); return this.enabled ? click : undefined }
  private keys = new Set<string>()
  /** The character each held key produced when it went down. */
  private chars = new Map<string, string>()
  private reloadPressed = false
  private equipPressed = false
  private meleePressed = false
  private enterPressed = false
  private seatPressed = false
  mouse = { x: innerWidth / 2, y: innerHeight / 2 }
  firing = false
  /** One pending edge, never a queue of shots. Expire it across stalls or focus changes. */
  private firePressedAt = -Infinity
  /** Right mouse held: push the camera further toward the cursor. */
  looking = false
  private gameplayEnabled = false
  get enabled(): boolean { return this.gameplayEnabled }
  set enabled(value: boolean) {
    if (!value) {
      this.firing = false
      this.firePressedAt = -Infinity
    }
    this.gameplayEnabled = value
  }
  onKey: ((code: string) => void) | null = null
  onWheel: ((delta: number) => void) | null = null
  readonly mux = new URLSearchParams(location.search).has("mux") && parent !== window
  readonly parentOrigin = document.referrer ? new URL(document.referrer).origin : location.origin
  readonly muxRun = new URLSearchParams(location.search).get("muxRun") ?? ""

  constructor(canvas: HTMLElement, private interactCodes = ["KeyF", "KeyE"]) {
    canvas.tabIndex = -1
    window.addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.code === "Tab") e.preventDefault()
      if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault()
      const msg: MuxKey = { type: "mux-key", kind: "keydown", code: e.code, key: e.key, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey }
      if (this.mux) { if (!e.repeat) this.forward(msg) }
      else this.key(msg)
    })
    window.addEventListener("keyup", (e) => {
      const msg: MuxKey = { type: "mux-key", kind: "keyup", code: e.code, key: e.key, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey }
      if (this.mux) this.forward(msg)
      else this.key(msg)
    })
    window.addEventListener("blur", () => {
      if (this.mux) this.forward({ type: "mux-release" })
      this.release()
    })
    window.addEventListener("mousemove", (e) => {
      this.mouseEvent(e)
    })
    canvas.addEventListener("mousedown", (e) => {
      e.preventDefault()
      canvas.focus({ preventScroll: true })
      this.mouseEvent(e, { down: e.button })
    })
    window.addEventListener("mouseup", (e) => {
      this.mouseEvent(e, { up: e.button })
    })
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault()
      this.mouseEvent(e, { wheel: e.deltaY })
    }, { passive: false })
    canvas.addEventListener("contextmenu", (e) => e.preventDefault())
    window.addEventListener("message", (e) => {
      if (!this.accepts(e)) return
      const m = e.data
      if (m?.type === "mux-key" && (m.kind === "keydown" || m.kind === "keyup") && typeof m.code === "string" && typeof m.key === "string") this.key(m)
      if (m?.type === "mux-mouse" && Number.isFinite(m.nx) && Number.isFinite(m.ny)) this.pointer(m)
      if (m?.type === "mux-release" || m?.type === "mux-reset") this.release()
    })
  }

  accepts(e: MessageEvent): boolean { return this.mux && e.source === parent && e.origin === this.parentOrigin && e.data?.run === this.muxRun }

  forward(message: object): void { if (this.mux) parent.postMessage({ ...message, run: this.muxRun }, this.parentOrigin) }

  release(): void {
    this.casts = []
    this.keys.clear()
    this.chars.clear()
    this.firePressedAt = -Infinity
    this.firing = this.looking = this.reloadPressed = this.equipPressed = this.meleePressed = this.enterPressed = this.seatPressed = false
  }

  private key(e: MuxKey): void {
    const k = e.key.toLowerCase()
    if (e.kind === "keyup") {
      // Release the character seen on press: Shift or Option can change e.key before the key comes up (Dvorak "," -> "<").
      this.keys.delete(e.code)
      const down = this.chars.get(e.code)
      if (down !== undefined) this.keys.delete(down)
      this.chars.delete(e.code)
      // macOS drops keyups for other keys while Cmd is held.
      if (e.code === "MetaLeft" || e.code === "MetaRight") this.release()
      return
    }
    const repeat = this.keys.has(e.code)
    this.keys.add(e.code)
    if (!repeat) {
      this.keys.add(k)
      this.chars.set(e.code, k)
    }
    if (!repeat) this.onKey?.(k === "t" ? "KeyT" : k === "m" ? "KeyM" : k === "b" ? "KeyB" : e.code)
    if (e.code === "KeyR" || k === "r") this.reloadPressed = true
    if ((e.code === "KeyG" || k === "g") && !repeat) this.equipPressed = true
    if ((e.code === "KeyV" || k === "v") && !repeat) this.meleePressed = true
    if ((this.interactCodes.includes(e.code) && (!this.spellMode || e.code !== "KeyE") || this.interactCodes.includes("KeyF") && k === "f") && !repeat) this.enterPressed = true
    if (e.code === "KeyC" && !repeat) this.seatPressed = true
  }

  private mouseEvent(e: MouseEvent, buttons: Partial<MuxMouse> = {}): void {
    const msg: MuxMouse = { type: "mux-mouse", nx: e.clientX / innerWidth, ny: e.clientY / innerHeight, ...buttons }
    if (this.mux) this.forward(msg)
    else this.pointer(msg)
  }

  private pointer(m: MuxMouse): void {
    this.mouse.x = Math.max(0, Math.min(1, m.nx)) * innerWidth
    this.mouse.y = Math.max(0, Math.min(1, m.ny)) * innerHeight
    // Canvas presses are edges, independent of mouseup and the fixed simulation clock.
    // Do not derive these from held buttons: dragging out of a Lab control must not cast.
    if (this.spellMode && this.enabled && m.down === 0 && this.casts.length < 8 && this.castSpell) this.casts.push({ ...this.mouse, spell: this.castSpell() })
    if (Number.isInteger(m.buttons)) {
      this.setFire((m.buttons! & 1) !== 0)
      this.looking = (m.buttons! & 2) !== 0
    }
    if (m.down === 0) this.setFire(true)
    if (m.down === 2) this.looking = true
    if (m.down === 1) this.equipPressed = true
    if (m.up === 0) this.setFire(false)
    if (m.up === 2) this.looking = false
    if (Number.isFinite(m.wheel)) this.onWheel?.(m.wheel!)
  }

  private setFire(down: boolean): void {
    if (down && !this.firing && this.enabled) this.firePressedAt = performance.now()
    this.firing = down && this.enabled
  }

  /** Consume on every input tick, even when dead. Weapon gates decide this tick; they never retain the edge. */
  takeFirePress(): boolean {
    const pressed = this.enabled && performance.now() - this.firePressedAt <= 100
    this.firePressedAt = -Infinity
    return pressed
  }

  held(code: string): boolean {
    return this.keys.has(code) || (code === "KeyF" && this.keys.has("f"))
  }

  move(): { mx: number; my: number } {
    if (!this.enabled) return { mx: 0, my: 0 }
    let mx = 0
    let my = 0
    if (this.held("KeyW") || this.held("Comma") || this.held(",") || this.held("ArrowUp")) my -= 1
    if (this.held("KeyS") || this.held("KeyO") || this.held("o") || this.held("ArrowDown")) my += 1
    if (this.held("KeyA") || this.held("a") || this.held("ArrowLeft")) mx -= 1
    if (this.held("KeyD") || this.held("KeyE") || this.held("e") || this.held("ArrowRight")) mx += 1
    return { mx, my }
  }

  get sprinting(): boolean {
    return this.enabled && (this.held("ShiftLeft") || this.held("ShiftRight"))
  }

  takeEquip(): boolean {
    const r = this.equipPressed
    this.equipPressed = false
    return r && this.enabled
  }

  /** V: a melee swing, in modes that have one. */
  takeMelee(): boolean {
    const r = this.meleePressed
    this.meleePressed = false
    return r && this.enabled
  }

  /** C: next free seat in the vehicle you're riding. */
  takeSeat(): boolean {
    const r = this.seatPressed
    this.seatPressed = false
    return r && this.enabled
  }

  /** F (or E): get in or out of a vehicle. */
  takeEnter(): boolean {
    const r = this.enterPressed
    this.enterPressed = false
    return r && this.enabled
  }

  takeReload(): boolean {
    const r = this.reloadPressed
    this.reloadPressed = false
    return r && this.enabled
  }
}
