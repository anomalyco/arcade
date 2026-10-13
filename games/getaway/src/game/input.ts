import type { Input } from "../../shared/sim/vehicle"

/** Keyboard and gamepad driving controls. Steering is relative to the car, so A always turns the car to its left. */
export class Controls {
  private keys = new Set<string>()
  /** The character each held key produced when it went down. */
  private chars = new Map<string, string>()
  private dvorak = false
  private steer = 0
  readonly mux = new URLSearchParams(location.search).has("mux") && parent !== window
  readonly muxRun = new URLSearchParams(location.search).get("muxRun") ?? ""
  readonly parentOrigin = document.referrer ? new URL(document.referrer).origin : location.origin
  /** While true (chat open) the car gets neutral input. */
  paused = false
  mouse = { nx: 0.5, ny: 0.5, buttons: 0 }

  constructor() {
    const mux = this.mux
    addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.code === "Escape") return
      if (mux) {
        if (!e.repeat) this.forward({ type: "mux-key", kind: "keydown", code: e.code, key: e.key, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey })
        e.preventDefault()
        return
      }
      this.key("keydown", e.code, e.key)
      if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault()
    })
    addEventListener("keyup", (e) => {
      if (mux) {
        this.forward({ type: "mux-key", kind: "keyup", code: e.code, key: e.key, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey })
        return
      }
      this.key("keyup", e.code, e.key)
    })
    addEventListener("blur", () => {
      this.release()
      if (mux) this.forward({ type: "mux-release" })
    })
    const canvas = document.getElementById("view")
    if (canvas) {
      canvas.tabIndex = -1
      for (const type of ["mousemove", "mousedown", "mouseup"] as const) canvas.addEventListener(type, (event) => {
        if (type === "mousedown") canvas.focus({ preventScroll: true })
        const message = { type: "mux-mouse", nx: event.clientX / innerWidth, ny: event.clientY / innerHeight, buttons: event.buttons }
        if (mux) this.forward(message)
        else this.pointer(message)
      })
    }
  }

  pointer(message: { nx: number; ny: number; buttons?: number }) {
    this.mouse = { nx: Math.max(0, Math.min(1, message.nx)), ny: Math.max(0, Math.min(1, message.ny)), buttons: message.buttons ?? 0 }
  }

  accepts(event: MessageEvent) { return this.mux && event.source === parent && event.origin === this.parentOrigin && event.data?.run === this.muxRun }
  forward(message: object) { if (this.mux) parent.postMessage({ ...message, run: this.muxRun }, this.parentOrigin) }

  key(kind: "keydown" | "keyup", code: string, key: string) {
    const lower = key.toLowerCase()
    if (kind === "keyup") {
      // Release the character seen on press: Shift or Option can change e.key before the key comes up (Dvorak "," -> "<").
      this.keys.delete(code)
      const down = this.chars.get(code)
      if (down !== undefined) this.keys.delete(down)
      this.chars.delete(code)
      // macOS drops keyups for other keys while Cmd is held.
      if (code === "MetaLeft" || code === "MetaRight") this.release()
      return
    }
    if (this.keys.has(code)) return
    if (lower === "," || lower === "<" || lower === "o" || lower === "'" || lower === '"' || (code === "KeyD" && lower === "e")) this.dvorak = true
    else if (lower === "w" || lower === "s") this.dvorak = false
    this.keys.add(code)
    this.keys.add(lower)
    this.chars.set(code, lower)
  }

  pressed(code: string) {
    return this.keys.has(code)
  }

  /** Lets go of every held key, e.g. when a text field takes focus. */
  release() {
    this.keys.clear()
    this.chars.clear()
    this.steer = 0
    this.mouse.buttons = 0
  }

  read(dt: number): Input {
    if (this.paused) {
      this.keys.clear()
      this.steer = 0
      return { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false, gadget: null, engine: false }
    }
    const k = this.keys
    const up = k.has("KeyW") || k.has("ArrowUp") || k.has("w") || k.has(",") || k.has("<")
    const down = k.has("KeyS") || k.has("ArrowDown") || k.has("s") || k.has("o")
    const left = k.has("KeyA") || k.has("ArrowLeft") || k.has("a")
    const right = k.has("KeyD") || k.has("ArrowRight") || k.has("d") || k.has("e")
    let throttle = up ? 1 : 0
    let brake = 0
    if (down) {
      throttle = up ? throttle : -1
      brake = up ? 1 : 0
    }
    let target = (left ? 1 : 0) - (right ? 1 : 0)
    let handbrake = k.has("Space") || k.has(" ")
    let boost = k.has("ShiftLeft") || k.has("ShiftRight") || k.has("shift")
    const pad = navigator.getGamepads?.().find((p) => p && p.connected)
    if (pad) {
      const ax = pad.axes[0] ?? 0
      if (Math.abs(ax) > 0.15) target = -ax
      const rt = pad.buttons[7]?.value ?? 0
      const lt = pad.buttons[6]?.value ?? 0
      if (rt > 0.05) throttle = rt
      if (lt > 0.05) throttle = rt > 0.05 ? throttle : -lt
      if (pad.buttons[0]?.pressed || pad.buttons[5]?.pressed) handbrake = true
      if (pad.buttons[1]?.pressed || pad.buttons[2]?.pressed) boost = true
    }
    // Keyboard steering ramps in so taps make small corrections and holds make full turns.
    const rate = target === 0 ? 10 : Math.sign(target) !== Math.sign(this.steer) ? 12 : 6
    this.steer += Math.max(-rate * dt, Math.min(rate * dt, target - this.steer))
    if (pad && Math.abs(pad.axes[0] ?? 0) > 0.15) this.steer = target
    const g0 = k.has("KeyQ") || k.has("q") || k.has("'") || k.has('"') || k.has("Quote")
    const g1 = k.has(".") || k.has(">") || k.has("Period") || (!this.dvorak && k.has("KeyE"))
    let gadget: 0 | 1 | null = g0 ? 0 : g1 ? 1 : null
    if (pad?.buttons[4]?.pressed) gadget = 0
    if (pad?.buttons[3]?.pressed) gadget = 1
    const engine = k.has("KeyH") || k.has("h") || !!pad?.buttons[9]?.pressed
    return { throttle, brake, steer: this.steer, handbrake, boost, gadget, engine }
  }
}
