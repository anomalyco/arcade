// Keyboard + mouse input.
// Default scheme "battlefield" (BF3/BF4-style): mouse Y pitch (away = nose up), mouse X roll, W/S throttle
//   (S also airbrake for jets), A/D yaw, Q/E roll, Space flares, LMB/RMB fire, hold C free-look.
//   Heli: W/S collective, A/D yaw (pedals), mouse pitch/roll. The mouse acts like a spring-centred stick.
// Optional schemes: "aim" (instructor flies toward a mouse cursor), "keys" (keyboard flight + body-relative
// gun reticle clamped to the gimbal cone) and "point" (point & turn).
import type { FlightInput, SeatInput, Vec3 } from "./sim/types"
import { HELI_STRAFE_ROLL } from "./sim/flight"
import { GUN_GIMBAL } from "./sim/combat"
import { settings, updateSettings } from "./ui/settings"

export { HELI_STRAFE_ROLL }
export type InputAction = "seat1" | "seat2" | "view" | "chat" | "menu"
export type MouseMode = "direct" | "aim"

/** Pilot control schemes (settings key `controlScheme`). */
export const CONTROL_SCHEMES = ["battlefield", "aim", "keys", "point"] as const
export type ControlScheme = (typeof CONTROL_SCHEMES)[number]
export const CONTROL_SCHEME_LABELS: Record<ControlScheme, string> = {
  battlefield: "Battlefield (default)",
  aim: "Mouse-aim (instructor)",
  keys: "Keyboard flight + mouse aim",
  point: "Point & turn",
}

/** Current pilot scheme (default "battlefield"). */
export function controlScheme(): ControlScheme {
  const s = (settings as unknown as { controlScheme?: string }).controlScheme
  return s === "aim" || s === "keys" || s === "point" ? s : "battlefield"
}

/** Persist a scheme (keeps the legacy `controlStyle` flag in sync). */
export function setControlScheme(scheme: ControlScheme): void {
  updateSettings({ controlStyle: scheme === "aim" || scheme === "point" ? "aim" : "direct", controlScheme: scheme } as Partial<typeof settings>)
}

const AIM_SENS = 0.0021
const MAX_PITCH = 1.5
/** Point & turn: aim lead (rad) relative to the nose at full stick, horizontal / vertical. */
const POINT_LEAD_YAW = 0.7
const POINT_LEAD_PITCH = 0.5
/** Mouse speed (px/s at sensitivity 1) that gives full stick deflection. */
export const STICK_FULL_SPEED = 500
/** Stick time constant (s): how fast deflection follows the mouse and re-centres when it stops. */
export const STICK_TAU = 0.07
/** Single mouse events larger than this (px) are clamped (pointer-lock spikes). */
const STICK_EVENT_CLAMP = 120

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/** Held keys ramp a full deflection in over this long (s), and release twice as fast. */
export const KEY_RAMP = 0.25
/** Keyboard-flight scheme: snappier key ramp (s). */
export const KEY_RAMP_FAST = 0.12
/** Gun reticle gimbal half-angle (rad): combat's GUN_GIMBAL (pilot guns fire inside this cone). */
export const RETICLE_LIMIT = GUN_GIMBAL
/** Bomb sight cone half-angle around straight down (rad) and the initial forward lead. */
export const BOMBSIGHT_CONE = 72 * Math.PI / 180
const BOMBSIGHT_DEFAULT_FWD = 20 * Math.PI / 180
/** Bomb camera cursor half-range (rad). */
export const BOMBCAM_CURSOR_LIMIT = 0.45
/** Soft steering assist starts when the reticle is past this fraction of the cone. */
export const RETICLE_ASSIST_START = 0.7
/** Assist deflection at the cone edge (pitch / yaw, −1..1 units added to the keys). */
const RETICLE_ASSIST = 0.6

/**
 * Spring-centred virtual stick fed by mouse motion. Linear: deflection = mouse speed / full speed,
 * low-passed with STICK_TAU. Held keys add a deflection that ramps in over KEY_RAMP. DOM-free (testable).
 */
export class SteerStick {
  value = 0
  /** Key ramp time (s). */
  ramp = KEY_RAMP
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
    const step = (rampIn ? 1 : 2) * dt / this.ramp
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
  /** Stick deflections sent to flight (−1..1): keys always, plus the mouse in manual/battlefield. */
  steerYaw = 0
  steerPitch = 0
  steerRoll = 0
  /** M toggles manual (direct mouse pitch/roll) on top of the aim scheme; Alt holds it. */
  manualToggle = false
  private mouseXStick = new SteerStick()
  private mouseYStick = new SteerStick()
  private rollKeys = new SteerStick()
  private pitchKeys = new SteerStick()
  private yawKeys = new SteerStick()
  /** Pilot nose direction (yaw/pitch) for point & turn, and whether the pilot uses it this frame. */
  private noseYaw = 0
  private nosePitch = 0
  private pointActive = false
  /** Keyboard-flight scheme: body-relative gun reticle (rad; x = right, y = up), clamped to the cone. */
  reticleX = 0
  reticleY = 0
  private reticleActive = false
  /** Bombardier bomb sight: stabilized aim offsets from straight down (rad; fwd = toward the nose). */
  bombFwd = 0
  bombSide = 0
  private bombsightActive = false
  /** Bomb steering (TV-guided style): cursor over the bomb camera (rad from its centre; x right, y up). */
  bombCursorX = 0
  bombCursorY = 0
  /** Latest steering direction bomb → cursor ground point (set by the camera helper each frame). */
  bombAim: Vec3 = [0, -1, 0]
  private bombFalling = false
  private bombardier = false
  private bombToggle = false
  private wasSteering = false
  /** Pilot: level heading held by the instructor while steering a bomb. */
  private holdHeading: Vec3 = [0, 0, -1]
  private heliPilot = false
  /** Pilot orientation (for the body-relative reticle). */
  private pose: [number, number, number, number] = [0, 0, 0, 1]
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

  /** Pilot's current nose direction (call each frame while piloting; used by point & turn). */
  setNose(dir: Vec3): void {
    this.noseYaw = Math.atan2(-dir[0], -dir[2])
    this.nosePitch = Math.atan2(dir[1], Math.hypot(dir[0], dir[2]))
    if (this.pointActive) {
      // Point & turn: the aim sits ahead of the nose, offset by the mouse stick (back on the nose when still).
      this.aimYaw = this.noseYaw - this.mouseXStick.value * POINT_LEAD_YAW
      this.aimPitch = clamp(this.nosePitch + this.mouseYStick.value * POINT_LEAD_PITCH, -MAX_PITCH, MAX_PITCH)
    }
  }

  /** Pilot orientation quaternion (call each frame while piloting; the reticle rides with it). */
  setPose(q: readonly number[]): void {
    this.pose[0] = q[0]; this.pose[1] = q[1]; this.pose[2] = q[2]; this.pose[3] = q[3]
  }

  /** World direction of the gun reticle (keyboard-flight scheme). */
  reticleDir(out: Vec3): Vec3 {
    // Body frame: nose −Z, right +X, up +Y.
    const x = Math.sin(this.reticleX) * Math.cos(this.reticleY), y = Math.sin(this.reticleY)
    const z = -Math.cos(this.reticleX) * Math.cos(this.reticleY)
    const [qx, qy, qz, qw] = this.pose
    const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x)
    out[0] = x + qw * tx + (qy * tz - qz * ty)
    out[1] = y + qw * ty + (qz * tx - qx * tz)
    out[2] = z + qw * tz + (qx * ty - qy * tx)
    return out
  }

  /** Reticle offset as a fraction of the gimbal cone (0 = on the nose, 1 = at the edge). */
  get reticleFrac(): number {
    return Math.hypot(this.reticleX, this.reticleY) / RETICLE_LIMIT
  }

  /** True while the keyboard-flight reticle owns the mouse (pilot seat, keys scheme, not free-look). */
  get reticleMode(): boolean {
    return this.reticleActive
  }

  /** True while flying manually (direct mouse pitch/roll) under the aim/point schemes. */
  get manual(): boolean {
    return this.manualToggle || this.held("AltLeft", "AltRight")
  }

  /** Mouse role for the pilot seat: "direct" in Battlefield or while manual, else "aim". */
  pilotMouseMode(isPilot = true): MouseMode {
    const scheme = controlScheme()
    const direct = isPilot && (scheme === "battlefield" || scheme === "keys" || this.manual)
    this.pointActive = isPilot && !direct && scheme === "point"
    this.reticleActive = isPilot && scheme === "keys" && !this.manual
    return direct ? "direct" : "aim"
  }

  /** Bomb sight on/off (bombardier seat). The sight is stabilized: it uses only the nose heading. */
  setBombsight(active: boolean): void {
    if (active && !this.bombsightActive) { this.bombFwd = BOMBSIGHT_DEFAULT_FWD; this.bombSide = 0 }
    this.bombsightActive = active
  }

  get bombsight(): boolean {
    return this.bombsightActive && !this.steeringBomb
  }

  /**
   * Call each frame with whether this seat has a falling (steerable) bomb. The bombardier steers it
   * automatically until impact; a pilot steers while holding RMB (or after toggling with B).
   */
  setFallingBomb(falling: boolean, isBombardier: boolean): void {
    if (!falling) this.bombToggle = false
    this.bombFalling = falling
    this.bombardier = isBombardier
    const steering = this.steeringBomb
    if (steering && !this.wasSteering) {
      this.bombCursorX = this.bombCursorY = 0
      // Pilot hands-off: hold wings level on the current heading (instructor on a level aim).
      const h = Math.hypot(Math.sin(this.noseYaw), Math.cos(this.noseYaw))
      this.holdHeading = [-Math.sin(this.noseYaw) / h, 0, -Math.cos(this.noseYaw) / h]
    }
    this.wasSteering = steering
  }

  /** True while this seat is steering a falling bomb (send SeatInput.steerBomb, use bombAim). */
  get steeringBomb(): boolean {
    return this.bombFalling && (this.bombardier || this.mouseR || this.bombToggle)
  }

  /** Bomb camera helper result: steering direction for SeatInput.aim. */
  setBombAim(dir: Vec3): void {
    this.bombAim[0] = dir[0]; this.bombAim[1] = dir[1]; this.bombAim[2] = dir[2]
  }

  aimDir(out: Vec3): Vec3 {
    if (this.steeringBomb) { out[0] = this.bombAim[0]; out[1] = this.bombAim[1]; out[2] = this.bombAim[2]; return out }
    if (this.bombsightActive) return this.bombDir(out)
    return dirFromAngles(this.aimYaw, this.aimPitch, out)
  }

  /** Bomb-sight direction: straight down tilted forward/sideways in the heading frame (no roll/pitch). */
  private bombDir(out: Vec3): Vec3 {
    const sy = Math.sin(this.noseYaw), cy = Math.cos(this.noseYaw)
    const tf = Math.tan(this.bombFwd), ts = Math.tan(this.bombSide)
    // heading forward (-sin, 0, -cos), heading right (cos, 0, -sin)
    const x = -sy * tf + cy * ts, y = -1, z = -cy * tf - sy * ts
    const n = 1 / Math.sqrt(x * x + y * y + z * z)
    out[0] = x * n; out[1] = y * n; out[2] = z * n
    return out
  }

  /** Mouse-aim / gunner camera direction (aim + free-look offset). */
  lookDir(out: Vec3): Vec3 {
    if (this.steeringBomb) { out[0] = this.bombAim[0]; out[1] = this.bombAim[1]; out[2] = this.bombAim[2]; return out }
    if (this.bombsightActive) return this.bombDir(out)
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
   * Once per frame while piloting: held keys (ramped) + mouse (manual/battlefield/point) → deflections.
   */
  sampleSteering(seconds: number, heli = false): void {
    const sens = settings.sensitivity
    if (this.reticleActive) { this.sampleKeyFlight(seconds, heli); return }
    for (const st of [this.rollKeys, this.pitchKeys, this.yawKeys]) st.ramp = KEY_RAMP
    const ad = this.axis(["KeyA"], ["KeyD"]), qe = this.axis(["KeyQ"], ["KeyE"]), lr = this.axis(["ArrowLeft"], ["ArrowRight"])
    const roll = clamp(qe + lr, -1, 1)
    const mx = this.mouseXStick.sample(seconds, sens)
    const my = this.mouseYStick.sample(seconds, sens)
    // Heli: A/D strafe = a partial roll (a sideways tilt); Q/E/←→ = full roll (flips). Jets: A/D rudder.
    const r = this.rollKeys.sample(seconds, sens, heli && roll === 0 ? ad * HELI_STRAFE_ROLL : roll)
    const p = this.pitchKeys.sample(seconds, sens, this.axis(["ArrowUp"], ["ArrowDown"])) // ↑ = nose down
    const y = this.yawKeys.sample(seconds, sens, heli && controlScheme() !== "battlefield" ? 0 : ad)
    const stick = this.mouseMode === "direct"
    this.steerRoll = clamp(r + (stick ? mx : 0), -1, 1)
    this.steerPitch = clamp(p + (stick ? my : 0), -1, 1)
    this.steerYaw = y
  }

  /** Keyboard flight: keys fly (fast ramp); the reticle past 70% of the cone adds a soft assist. */
  private sampleKeyFlight(seconds: number, heli: boolean): void {
    this.heliPilot = heli
    for (const st of [this.rollKeys, this.pitchKeys, this.yawKeys]) st.ramp = KEY_RAMP_FAST
    const ws = this.axis(["KeyW", "ArrowUp"], ["KeyS", "ArrowDown"]) // W = nose down (pitch −1)
    const ad = this.axis(["KeyA"], ["KeyD"]), qe = this.axis(["KeyQ"], ["KeyE"]), lr = this.axis(["ArrowLeft"], ["ArrowRight"])
    // Heli: A/D strafe (partial roll), ←/→ full roll (flips). Jets: A/D or ←/→ roll.
    const rollKey = heli ? (lr !== 0 ? lr : ad * HELI_STRAFE_ROLL) : clamp(ad + lr, -1, 1)
    const r = this.rollKeys.sample(seconds, 1, rollKey)
    const p = this.pitchKeys.sample(seconds, 1, ws)
    const y = this.yawKeys.sample(seconds, 1, qe)
    // Soft assist toward the reticle once it's pushed past RETICLE_ASSIST_START of the cone.
    const frac = this.reticleFrac
    let ap = 0, ay = 0
    if (frac > RETICLE_ASSIST_START && !this.freeLook) {
      const k = Math.min(1, (frac - RETICLE_ASSIST_START) / (1 - RETICLE_ASSIST_START)) * RETICLE_ASSIST / frac / RETICLE_LIMIT
      ay = this.reticleX * k
      ap = heli ? 0 : this.reticleY * k
    }
    this.steerRoll = r
    this.steerPitch = clamp(p + (ws === 0 ? ap : 0), -1, 1)
    this.steerYaw = clamp(y + (qe === 0 ? ay : 0), -1, 1)
  }

  /**
   * Piloting input for one tick. `aim` is only used in mouse-aim mode. `throttleAxis` overrides W/S
   * (e.g. wheel fine-throttle pulses) when non-null.
   */
  flightInput(aim: Vec3 | null, heli: boolean, throttleAxis: number | null, out: FlightInput): FlightInput {
    if (this.steeringBomb && !this.bombardier) {
      // Pilot steering a bomb: hands off — the instructor holds wings level on the entry heading, throttle kept.
      out.throttle = 0; out.boost = false; out.brake = false
      out.aim = [this.holdHeading[0], this.holdHeading[1], this.holdHeading[2]]
      out.pitch = out.yaw = out.roll = 0
      return out
    }
    // Keyboard flight: Shift = throttle up (+ boost), Z = throttle down; heli collective Space up / Z down.
    const ws = this.reticleActive
      ? (heli ? this.axis(["KeyZ"], ["Space"]) : this.axis(["KeyZ"], ["ShiftLeft", "ShiftRight"]))
      : this.axis(["KeyS"], ["KeyW"])
    out.throttle = ws !== 0 || throttleAxis === null ? ws : throttleAxis
    out.boost = this.held("ShiftLeft", "ShiftRight")
    // Battlefield: holding S (throttle down) also deploys the airbrake for jets.
    out.brake = this.down("KeyX") || (!heli && !this.reticleActive && controlScheme() === "battlefield" && this.held("KeyS"))
    out.aim = this.mouseMode === "direct" ? null : aim
    out.pitch = this.steerPitch
    out.yaw = this.steerYaw
    out.roll = this.steerRoll
    return out
  }

  seatInput(aim: Vec3 | null, out: SeatInput): SeatInput {
    out.aim = aim
    // Space is the heli's collective in keyboard flight, so it doesn't fire there.
    out.firePrimary = this.mouseL || this.down("Mouse0") || (!(this.reticleActive && this.heliPilot) && this.down("Space"))
    // RMB steers a falling bomb for the pilot instead of firing.
    const steer = this.steeringBomb
    out.fireSecondary = steer && !this.bombardier ? false : this.mouseR || this.down("KeyV", "Mouse2")
    ;(out as SeatInput & { steerBomb?: boolean }).steerBomb = steer
    if (steer) out.aim = [this.bombAim[0], this.bombAim[1], this.bombAim[2]]
    // Battlefield: Space = flares (and never fires); F always drops flares.
    const bf = controlScheme() === "battlefield"
    out.flares = this.down("KeyF") || (bf && this.down("Space"))
    if (bf && !this.mouseL && !this.down("Mouse0")) out.firePrimary = false
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
    for (const st of [this.mouseXStick, this.mouseYStick, this.rollKeys, this.pitchKeys, this.yawKeys]) st.reset()
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
    if (code === "KeyZ") this.zoomHeld = down // also a flight key (throttle / collective down)
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
        case "KeyM": this.manualToggle = !this.manualToggle; break
        case "KeyB": if (this.bombFalling) this.bombToggle = !this.bombToggle; break
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
    } else if (this.steeringBomb) {
      // Bomb camera cursor (mouse away = up the screen), clamped to the view.
      const s = AIM_SENS * settings.sensitivity * 0.5
      this.bombCursorX = clamp(this.bombCursorX + dx * s, -BOMBCAM_CURSOR_LIMIT, BOMBCAM_CURSOR_LIMIT)
      this.bombCursorY = clamp(this.bombCursorY - dy * s * (settings.invertY ? -1 : 1), -BOMBCAM_CURSOR_LIMIT, BOMBCAM_CURSOR_LIMIT)
    } else if (this.bombsightActive) {
      // Bomb sight: mouse away = aim further ahead; clamped to the sight cone.
      const s = AIM_SENS * settings.sensitivity * 0.6
      let f = this.bombFwd - dy * s * (settings.invertY ? -1 : 1), sd = this.bombSide + dx * s
      const r = Math.hypot(f, sd)
      if (r > BOMBSIGHT_CONE) { f *= BOMBSIGHT_CONE / r; sd *= BOMBSIGHT_CONE / r }
      this.bombFwd = f; this.bombSide = sd
    } else if (this.reticleActive) {
      // Gun reticle: body-relative, clamped to the gimbal cone (mouse away = up unless inverted).
      const s = AIM_SENS * settings.sensitivity * 0.5
      let x = this.reticleX + dx * s, y = this.reticleY - dy * s * (settings.invertY ? -1 : 1)
      const r = Math.hypot(x, y)
      if (r > RETICLE_LIMIT) { x *= RETICLE_LIMIT / r; y *= RETICLE_LIMIT / r }
      this.reticleX = x; this.reticleY = y
    } else if (this.mouseMode === "aim" && !this.pointActive) {
      const s = AIM_SENS * settings.sensitivity
      const inv = settings.invertY ? -1 : 1
      this.aimYaw -= dx * s
      this.aimPitch = clamp(this.aimPitch - dy * inv * s, -MAX_PITCH, MAX_PITCH)
    } else {
      // Sticks: mouse X = roll (manual/battlefield) or aim lead (point). Mouse Y: mouse away (negative
      // movementY) = nose up, like Battlefield's default; "Invert mouse Y" flips it.
      this.mouseXStick.feed(dx)
      this.mouseYStick.feed(-dy * (settings.invertY ? -1 : 1))
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
