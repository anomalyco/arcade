// Keyboard + mouse input.
// Direct style (default, Daxship-like): mouse movement = smoothed steering-rate commands (aim = null).
// Mouse-aim style (optional): mouse steers a free world-space aim direction the autopilot follows.
// Gunner seats always aim the turret with the mouse (aim vector).
import type { FlightInput, SeatInput, Vec3 } from "./sim/types"
import { settings } from "./ui/settings"

export type InputAction = "seat1" | "seat2" | "view" | "chat" | "menu"
export type MouseMode = "direct" | "aim"

const AIM_SENS = 0.0021
/** Direct steering: radians of commanded rotation per mouse pixel (before sensitivity). */
const DIRECT_RAD_PER_PX = 0.0018
/** Nominal full-deflection rates used to normalise mouse rate commands to -1..1. */
const DIRECT_PITCH_RATE = 1.6
const DIRECT_YAW_RATE = 1.1
const MAX_PITCH = 1.5

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

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
  /** Smoothed direct-steering axes (−1..1), updated by sampleSteering(). */
  steerYaw = 0
  steerPitch = 0
  steerRoll = 0
  private mouseX = 0
  private mouseY = 0
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
  private arrowYaw() { return this.held("ArrowLeft") || this.held("ArrowRight") }
  private arrowPitch() { return this.held("ArrowUp") || this.held("ArrowDown") }

  /**
   * Once per frame while piloting in direct mode: converts accumulated mouse motion into smoothed
   * rate commands (Daxship-style). Held arrows own their axis.
   */
  sampleSteering(seconds: number, heli: boolean): void {
    const dt = clamp(Number.isFinite(seconds) ? seconds : 0, 1 / 240, 0.05)
    const blend = 1 - Math.exp(-dt / 0.035)
    const s = DIRECT_RAD_PER_PX * settings.sensitivity
    const inv = settings.invertY ? -1 : 1
    const ty = this.arrowYaw() ? (this.held("ArrowRight") ? 1 : 0) - (this.held("ArrowLeft") ? 1 : 0)
      : clamp((this.mouseX * s) / (dt * DIRECT_YAW_RATE), -1, 1)
    // Arrows are inverted (Up = nose down). Mouse up (negative movementY) = nose up unless inverted.
    const tp = this.arrowPitch() ? (this.held("ArrowDown") ? 1 : 0) - (this.held("ArrowUp") ? 1 : 0)
      : clamp((-this.mouseY * inv * s) / (dt * DIRECT_PITCH_RATE), -1, 1)
    const qe = (this.held("KeyE") ? 1 : 0) - (this.held("KeyQ") ? 1 : 0)
    const ad = (this.held("KeyD") ? 1 : 0) - (this.held("KeyA") ? 1 : 0)
    const tr = heli ? clamp(ad + qe, -1, 1) : qe
    this.steerYaw += (ty - this.steerYaw) * blend
    this.steerPitch += (tp - this.steerPitch) * blend
    this.steerRoll += (tr - this.steerRoll) * blend
    if (Math.abs(this.steerYaw) < 1e-3) this.steerYaw = 0
    if (Math.abs(this.steerPitch) < 1e-3) this.steerPitch = 0
    if (Math.abs(this.steerRoll) < 1e-3) this.steerRoll = 0
    this.mouseX = this.mouseY = 0
  }

  /**
   * Piloting input for one tick. `aim` is only used in mouse-aim mode. `throttleAxis` overrides W/S
   * (e.g. wheel fine-throttle pulses) when non-null.
   */
  flightInput(aim: Vec3 | null, heli: boolean, throttleAxis: number | null, out: FlightInput): FlightInput {
    const ws = (this.held("KeyW") ? 1 : 0) - (this.held("KeyS") ? 1 : 0)
    out.throttle = ws !== 0 || throttleAxis === null ? ws : throttleAxis
    out.boost = this.held("ShiftLeft", "ShiftRight")
    out.brake = this.down("KeyX")
    const ad = (this.held("KeyD") ? 1 : 0) - (this.held("KeyA") ? 1 : 0)
    if (this.mouseMode === "direct") {
      out.aim = null
      out.pitch = this.steerPitch
      out.yaw = heli ? this.steerYaw : clamp(this.steerYaw + ad, -1, 1)
      out.roll = this.steerRoll
    } else {
      out.aim = aim
      const qe = (this.held("KeyE") ? 1 : 0) - (this.held("KeyQ") ? 1 : 0)
      out.pitch = (this.held("ArrowDown") ? 1 : 0) - (this.held("ArrowUp") ? 1 : 0)
      const arrowsYaw = (this.held("ArrowRight") ? 1 : 0) - (this.held("ArrowLeft") ? 1 : 0)
      out.yaw = heli ? arrowsYaw : clamp(arrowsYaw + ad, -1, 1)
      out.roll = heli ? clamp(ad + qe, -1, 1) : qe
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
    this.mouseX = this.mouseY = 0
    this.steerYaw = this.steerPitch = this.steerRoll = 0
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
      if (code.startsWith("Arrow")) {
        if (this.arrowYaw()) this.mouseX = 0
        if (this.arrowPitch()) this.mouseY = 0
      }
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
      // Bounded accumulation (no destination to chase), consumed by sampleSteering().
      if (!this.arrowYaw()) this.mouseX = clamp(this.mouseX + dx, -80, 80)
      if (!this.arrowPitch()) this.mouseY = clamp(this.mouseY + dy, -80, 80)
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
