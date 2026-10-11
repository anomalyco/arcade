// Keyboard + mouse-aim input. The aim is a free world-space direction (yaw/pitch) steered by mouse
// movement; the flight autopilot flies the nose toward it (War Thunder style).
import type { FlightInput, SeatInput, Vec3 } from "./sim/types"
import { settings } from "./ui/settings"

export type InputAction = "seat1" | "seat2" | "freelook" | "view" | "chat" | "menu" | "scoreboard"

const BASE_SENS = 0.0021
const MAX_PITCH = 1.5

export class Input {
  aimYaw = 0
  aimPitch = 0
  /** Free-look offsets applied on top of the aim (camera only). */
  lookYaw = 0
  lookPitch = 0
  freeLook = false
  scoreboard = false
  zoomHeld = false
  /** Accumulated wheel delta since last read (positive = zoom out). */
  wheel = 0
  locked = false
  /** Pointer lock refused (headless, iframe policy…): fall back to raw mouse deltas without lock. */
  lockFailed = false
  private keys = new Set<string>()
  /** Presses since the last seatInput() read, so taps shorter than one send interval still register. */
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
      this.wheel += Math.sign(e.deltaY) * Math.min(3, Math.abs(e.deltaY) / 60 || 1)
    }, { passive: true })
    docOn("pointerlockchange", () => {
      const was = this.locked
      this.locked = document.pointerLockElement === this.canvas
      this.skipMove = true
      if (this.locked) this.lockFailed = false
      if (!this.locked && was) { this.mouseL = this.mouseR = false; if (this.enabled) this.actions.push("menu") }
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

  /** Point the aim along a world direction (e.g. on spawn). */
  setAim(dir: Vec3): void {
    const h = Math.hypot(dir[0], dir[2])
    this.aimYaw = Math.atan2(-dir[0], -dir[2])
    this.aimPitch = Math.atan2(dir[1], h)
    this.lookYaw = this.lookPitch = 0
  }

  aimDir(out: Vec3): Vec3 {
    return dirFromAngles(this.aimYaw, this.aimPitch, out)
  }

  /** Camera look direction (aim + free-look offset). */
  lookDir(out: Vec3): Vec3 {
    return dirFromAngles(this.aimYaw + this.lookYaw, clamp(this.aimPitch + this.lookPitch, -MAX_PITCH, MAX_PITCH), out)
  }

  takeActions(): InputAction[] {
    if (!this.actions.length) return this.actions
    const a = this.actions
    this.actions = []
    return a
  }

  takeWheel(): number {
    const w = this.wheel
    this.wheel = 0
    return w
  }

  private down(...codes: string[]): boolean {
    for (const c of codes) if (this.keys.has(c) || this.latched.has(c)) return true
    return false
  }

  flightInput(aim: Vec3 | null, out: FlightInput): FlightInput {
    out.aim = aim
    out.throttle = (this.down("KeyW") ? 1 : 0) - (this.down("KeyS") ? 1 : 0)
    out.roll = (this.down("KeyD") ? 1 : 0) - (this.down("KeyA") ? 1 : 0)
    out.yaw = (this.down("KeyE") ? 1 : 0) - (this.down("KeyQ") ? 1 : 0)
    const inv = settings.invertY ? -1 : 1
    out.pitch = ((this.down("ArrowUp") ? 1 : 0) - (this.down("ArrowDown") ? 1 : 0)) * inv
    out.boost = this.down("ShiftLeft", "ShiftRight")
    out.brake = this.down("KeyX")
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
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return
    const code = e.code
    // The scoreboard works in every in-match state (dead, spawning, paused).
    if (code === "Tab" && this.attached) { e.preventDefault(); this.scoreboard = down; return }
    if (!this.enabled) return
    if (code === "Tab" || code === "Space" || code.startsWith("Arrow") || code === "AltLeft" || code === "AltRight") e.preventDefault()
    if (code === "Tab") { this.scoreboard = down; return }
    if (code === "KeyZ") { this.zoomHeld = down; return }
    if (down) {
      if (e.repeat) return
      this.keys.add(code)
      this.latched.add(code)
      switch (code) {
        case "Digit1": this.actions.push("seat1"); break
        case "Digit2": this.actions.push("seat2"); break
        case "KeyC":
          this.freeLook = !this.freeLook
          this.lookYaw = this.lookPitch = 0
          this.actions.push("freelook")
          break
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
    const s = BASE_SENS * settings.sensitivity
    const dx = Math.max(-300, Math.min(300, e.movementX))
    const dy = Math.max(-300, Math.min(300, e.movementY)) * (settings.invertY ? -1 : 1)
    if (this.freeLook) {
      this.lookYaw -= dx * s
      this.lookPitch = clamp(this.lookPitch - dy * s, -MAX_PITCH * 2, MAX_PITCH * 2)
    } else {
      this.aimYaw -= dx * s
      this.aimPitch = clamp(this.aimPitch - dy * s, -MAX_PITCH, MAX_PITCH)
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

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export function dirFromAngles(yaw: number, pitch: number, out: Vec3): Vec3 {
  const cp = Math.cos(pitch)
  out[0] = -Math.sin(yaw) * cp
  out[1] = Math.sin(pitch)
  out[2] = -Math.cos(yaw) * cp
  return out
}
