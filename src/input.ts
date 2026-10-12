// Keyboard + mouse input.
// Default "point & turn" scheme (same logic for every aircraft, aim = null):
//   mouse ←/→ = turn (jets: coordinated auto-bank turn; heli: pedal turn) · mouse ↑/↓ = nose up/down
//   (mouse away = nose up; "Invert mouse Y" flips) · arrows ↑ nose down, ↓ nose up, ←/→ turn ·
//   A/D = roll (jets) / strafe (heli) · Q/E = rudder / extra pedal · W/S throttle·collective ·
//   Shift boost · X brake / auto-hover.
// Optional schemes: "battlefield" (mouse X = roll, A/D·Q/E = yaw, mouse forward = nose down) and
// "aim" (War Thunder mouse-aim cursor). The mouse acts like a spring-centred stick: deflection ∝ recent
// mouse velocity, easing back to centre with a short time constant once the mouse stops.
import type { FlightInput, SeatInput, Vec3 } from "./sim/types"
import { settings, updateSettings } from "./ui/settings"

export type InputAction = "seat1" | "seat2" | "view" | "chat" | "menu"
export type MouseMode = "direct" | "aim"

/** Pilot control schemes (settings key `controlScheme`; "aim" also sets `controlStyle: "aim"`). */
export const CONTROL_SCHEMES = ["point", "battlefield", "aim"] as const
export type ControlScheme = (typeof CONTROL_SCHEMES)[number]
export const CONTROL_SCHEME_LABELS: Record<ControlScheme, string> = {
  point: "Point & turn",
  battlefield: "Battlefield (mouse = roll)",
  aim: "Mouse-aim cursor",
}

/** Current pilot scheme (default "point"). */
export function controlScheme(): ControlScheme {
  if (settings.controlStyle === "aim") return "aim"
  const s = (settings as unknown as { controlScheme?: string }).controlScheme
  return s === "battlefield" ? "battlefield" : "point"
}

/** Persist a scheme (keeps the legacy `controlStyle` flag in sync for game.ts). */
export function setControlScheme(scheme: ControlScheme): void {
  updateSettings({ controlStyle: scheme === "aim" ? "aim" : "direct", controlScheme: scheme } as Partial<typeof settings>)
}

const AIM_SENS = 0.0021
const MAX_PITCH = 1.5
/** Mouse speed (px/s at sensitivity 1) that gives full stick deflection. */
export const STICK_FULL_SPEED = 500
/** Stick time constant (s): how fast deflection follows the mouse and re-centres when it stops. */
export const STICK_TAU = 0.07
/** Single mouse events larger than this (px) are clamped (pointer-lock spikes). */
const STICK_EVENT_CLAMP = 120

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/** Held keys ramp a full deflection in over this long (s), and release twice as fast. */
export const KEY_RAMP = 0.25

/**
 * Spring-centred virtual stick fed by mouse motion. Linear: deflection = mouse speed / full speed,
 * low-passed with STICK_TAU. Held keys add a deflection that ramps in over KEY_RAMP. DOM-free (testable).
 */
export class SteerStick {
  value = 0
  private mouse = 0
  private key = 0
  private px = 0
  feed(px: number): void {
    if (Number.isFinite(px)) this.px += clamp(px, -STICK_EVENT_CLAMP, STICK_EVENT_CLAMP)
  }
  /** Advance by one frame of `seconds`; returns the deflection in [-1, 1]. */
  sample(seconds: number, sensitivity = 1, key = 0): number {
    const dt = clamp(Number.isFinite(seconds) ? seconds : 0, 1 / 500, 0.1)
    const target = clamp((this.px / dt) * sensitivity / STICK_FULL_SPEED, -1, 1)
    this.mouse += (target - this.mouse) * (1 - Math.exp(-dt / STICK_TAU))
    if (target === 0 && Math.abs(this.mouse) < 1e-3) this.mouse = 0
    const d = key - this.key
    const rampIn = key !== 0 && key * this.key >= 0 && Math.abs(key) > Math.abs(this.key)
    const step = (rampIn ? 1 : 2) * dt / KEY_RAMP
    this.key += d > step ? step : d < -step ? -step : d
    this.value = clamp(this.mouse + this.key, -1, 1)
    this.px = 0
    return this.value
  }
  reset(): void {
    this.value = this.mouse = this.key = this.px = 0
  }
}

export class Input {
  aimYaw = 0
  aimPitch = 0
  /** Free-look offsets applied on top of the view (camera only). */
  lookYaw = 0
  lookPitch = 0
  freeLook = false
  scoreboard = false
  zoomHeld = false
  locked = false
  /** Pointer lock refused (headless, iframe policy…): fall back to raw mouse deltas without lock. */
  lockFailed = false
  mouseMode: MouseMode = "direct"
  /** Direct-steering stick deflections sent to flight (−1..1). */
  steerYaw = 0
  steerPitch = 0
  steerRoll = 0
  /** Mouse X (+ its keys): turn in point & turn, roll in battlefield. */
  private mouseXStick = new SteerStick()
  private pitchStick = new SteerStick()
  /** Keyboard-only axis: roll/strafe (A/D) in point & turn, yaw in battlefield. */
  private keyStick = new SteerStick()
  private wheel = 0
  private keys = new Set<string>()
  /** Presses since the last seatInput() read, so taps shorter than one tick still register. */
  private latched = new Set<string>()
  private mouseL = false
  private mouseR = false
  private actions: InputAction[] = []
  private enabled = false
  private attached = true
  /** Drop the first delta after enabling / lock changes (browsers report accumulated jumps). */
  private skipMove = true
  private disposers: (() => void)[] = []

  constructor(private canvas: HTMLCanvasElement) {
    const on = <K extends keyof WindowEventMap>(t: K, f: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      window.addEventListener(t, f as EventListener, opts)
      this.disposers.push(() => window.removeEventListener(t, f as EventListener, opts))
    }
    const docOn = (t: string, f: EventListener) => {
      document.addEventListener(t, f)
      this.disposers.push(() => document.removeEventListener(t, f))
    }
    on("keydown", e => this.onKey(e, true))
    on("keyup", e => this.onKey(e, false))
    on("blur", () => this.clear())
    on("mousemove", e => this.onMove(e))
    on("mousedown", e => this.onButton(e, true))
    on("mouseup", e => this.onButton(e, false))
    on("contextmenu", e => { if (this.enabled) e.preventDefault() })
    on("wheel", e => {
      if (!this.enabled || !(this.locked || this.lockFailed)) return
      const px = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1)
      this.wheel += clamp(px, -160, 160)
    }, { passive: true })
    docOn("pointerlockchange", () => {
      const was = this.locked
      this.locked = document.pointerLockElement === this.canvas
      this.skipMove = true
      if (this.locked) this.lockFailed = false
      if (!this.locked && was) { this.clear(); if (this.enabled) this.actions.push("menu") }
    })
    docOn("pointerlockerror", () => { this.lockFailed = true })
  }

  setEnabled(v: boolean): void {
    if (v && !this.enabled) this.skipMove = true
    this.enabled = v
    if (!v) this.clear()
  }

  requestLock(): void {
    if (document.pointerLockElement === this.canvas) return
    const fail = () => { this.lockFailed = true }
    const plain = () => {
      try {
        const r = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined
        if (r && typeof r.catch === "function") r.catch(fail)
      } catch { fail() }
    }
    try {
      const r = this.canvas.requestPointerLock({ unadjustedMovement: true }) as unknown as Promise<void> | undefined
      if (r && typeof r.catch === "function") r.catch(plain)
    } catch { plain() }
  }

  releaseLock(): void {
    if (document.pointerLockElement) document.exitPointerLock()
  }

  /** Point the aim along a world direction (e.g. on spawn / entering the gunner seat). */
  setAim(dir: Vec3): void {
    const h = Math.hypot(dir[0], dir[2])
    this.aimYaw = Math.atan2(-dir[0], -dir[2])
    this.aimPitch = Math.atan2(dir[1], h)
    this.lookYaw = this.lookPitch = 0
  }

  aimDir(out: Vec3): Vec3 {
    return dirFromAngles(this.aimYaw, this.aimPitch, out)
  }

  /** Mouse-aim / gunner camera direction (aim + free-look offset). */
  lookDir(out: Vec3): Vec3 {
    return dirFromAngles(this.aimYaw + this.lookYaw, clamp(this.aimPitch + this.lookPitch, -MAX_PITCH, MAX_PITCH), out)
  }

  takeActions(): InputAction[] {
    if (!this.actions.length) return this.actions
    const a = this.actions
    this.actions = []
    return a
  }

  /** Wheel pixels since last read (positive = scrolled down). */
  takeWheel(): number {
    const w = this.wheel
    this.wheel = 0
    return w
  }

  private down(...codes: string[]): boolean {
    for (const c of codes) if (this.keys.has(c) || this.latched.has(c)) return true
    return false
  }
  private held(...codes: string[]): boolean {
    for (const c of codes) if (this.keys.has(c)) return true
    return false
  }
  private axis(neg: string[], pos: string[]): number {
    return (this.held(...pos) ? 1 : 0) - (this.held(...neg) ? 1 : 0)
  }

  /**
   * Once per frame while piloting in direct mode: turns accumulated mouse motion + held keys into stick
   * deflections. Identical for every aircraft (`heli` is accepted for API compatibility).
   */
  sampleSteering(seconds: number, heli = false): void {
    const sens = settings.sensitivity
    const pitchKeys = this.axis(["ArrowUp"], ["ArrowDown"]) // ↑ = nose down, ↓ = nose up
    const ad = this.axis(["KeyA"], ["KeyD"]), qe = this.axis(["KeyQ"], ["KeyE"]), lr = this.axis(["ArrowLeft"], ["ArrowRight"])
    if (controlScheme() === "battlefield") {
      this.steerRoll = this.mouseXStick.sample(seconds, sens, lr)
      this.steerYaw = this.keyStick.sample(seconds, sens, clamp(ad + qe, -1, 1))
    } else {
      this.steerYaw = this.mouseXStick.sample(seconds, sens, clamp(lr + qe, -1, 1))
      this.steerRoll = this.keyStick.sample(seconds, sens, ad)
    }
    this.steerPitch = this.pitchStick.sample(seconds, sens, pitchKeys)
  }

  /**
   * Piloting input for one tick. `aim` is only used in mouse-aim mode. `throttleAxis` overrides W/S
   * (e.g. wheel fine-throttle pulses) when non-null.
   */
  flightInput(aim: Vec3 | null, heli: boolean, throttleAxis: number | null, out: FlightInput): FlightInput {
    const ws = this.axis(["KeyS"], ["KeyW"])
    out.throttle = ws !== 0 || throttleAxis === null ? ws : throttleAxis
    out.boost = this.held("ShiftLeft", "ShiftRight")
    out.brake = this.down("KeyX")
    if (this.mouseMode === "direct") {
      out.aim = null
      out.pitch = this.steerPitch
      out.yaw = this.steerYaw
      out.roll = this.steerRoll
    } else {
      out.aim = aim
      out.pitch = this.axis(["ArrowUp"], ["ArrowDown"])
      out.yaw = clamp(this.axis(["KeyQ", "ArrowLeft"], ["KeyE", "ArrowRight"]), -1, 1)
      out.roll = this.axis(["KeyA"], ["KeyD"])
    }
    return out
  }

  seatInput(aim: Vec3 | null, out: SeatInput): SeatInput {
    out.aim = aim
    out.firePrimary = this.mouseL || this.down("Space", "Mouse0")
    out.fireSecondary = this.mouseR || this.down("KeyV", "Mouse2")
    out.flares = this.down("KeyF")
    out.ability = this.down("KeyR")
    this.latched.clear()
    return out
  }

  dispose(): void {
    this.attached = false
    this.disposers.forEach(d => d())
    this.releaseLock()
  }

  private clear(): void {
    this.keys.clear()
    this.latched.clear()
    this.mouseL = this.mouseR = false
    this.zoomHeld = false
    this.steerYaw = this.steerPitch = this.steerRoll = 0
    this.mouseXStick.reset(); this.pitchStick.reset(); this.keyStick.reset()
    this.freeLook = false
    this.lookYaw = this.lookPitch = 0
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return
    const code = e.code
    // The scoreboard works in every in-match state (dead, spawning, paused).
    if (code === "Tab" && this.attached) { e.preventDefault(); this.scoreboard = down; return }
    if (!this.enabled) return
    if (code === "Space" || code.startsWith("Arrow") || code === "AltLeft" || code === "AltRight") e.preventDefault()
    if (code === "KeyZ") { this.zoomHeld = down; return }
    if (code === "KeyC") {
      // Hold to free-look.
      if (down !== this.freeLook) { this.freeLook = down; this.lookYaw = this.lookPitch = 0 }
      return
    }
    if (down) {
      if (e.repeat) return
      this.keys.add(code)
      this.latched.add(code)
      switch (code) {
        case "Digit1": this.actions.push("seat1"); break
        case "Digit2": this.actions.push("seat2"); break
        case "KeyT": this.actions.push("view"); break
        case "Enter": e.preventDefault(); this.actions.push("chat"); break
        case "Escape": if (!this.locked) this.actions.push("menu"); break
      }
    } else {
      this.keys.delete(code)
    }
  }

  private onMove(e: MouseEvent): void {
    if (!this.enabled || !(this.locked || this.lockFailed)) return
    if (this.skipMove) { this.skipMove = false; return }
    const dx = clamp(e.movementX, -300, 300)
    const dy = clamp(e.movementY, -300, 300)
    if (this.freeLook) {
      const s = AIM_SENS * settings.sensitivity
      this.lookYaw -= dx * s
      this.lookPitch = clamp(this.lookPitch - dy * s, -MAX_PITCH, MAX_PITCH)
    } else if (this.mouseMode === "aim") {
      const s = AIM_SENS * settings.sensitivity
      const inv = settings.invertY ? -1 : 1
      this.aimYaw -= dx * s
      this.aimPitch = clamp(this.aimPitch - dy * inv * s, -MAX_PITCH, MAX_PITCH)
    } else {
      // Mouse X feeds the turn (point) or roll (battlefield) stick. Mouse Y: point & turn is shooter
      // style (mouse away / negative movementY = nose up); battlefield is flight-sim style (away = nose
      // down). "Invert mouse Y" flips either.
      this.mouseXStick.feed(dx)
      const awayIsUp = controlScheme() !== "battlefield"
      this.pitchStick.feed((awayIsUp ? -dy : dy) * (settings.invertY ? -1 : 1))
    }
  }

  private onButton(e: MouseEvent, down: boolean): void {
    if (!this.enabled) return
    if (!this.locked && !this.lockFailed) {
      if (down && e.target === this.canvas) this.requestLock()
      return
    }
    if (!this.locked && e.target !== this.canvas && down) return
    if (e.button === 0) this.mouseL = down
    else if (e.button === 2) this.mouseR = down
    if (down) this.latched.add(`Mouse${e.button}`)
  }
}

export function dirFromAngles(yaw: number, pitch: number, out: Vec3): Vec3 {
  const cp = Math.cos(pitch)
  out[0] = -Math.sin(yaw) * cp
  out[1] = Math.sin(pitch)
  out[2] = -Math.cos(yaw) * cp
  return out
}
