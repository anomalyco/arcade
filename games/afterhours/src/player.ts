import type * as THREE from "three/webgpu"
import { isEditableEventTarget } from "@arcade/kit/client/controls"
import type { Floor, WorldContext } from "./world/context"
import { heightAt } from "./world/height"
import { VIEWPOINTS, type ViewpointName } from "./world/layout"

const RADIUS = 0.3
/** Standing and crouched eye heights above the feet (m). */
const EYE = 1.65
const EYE_CROUCH = 1.05
/** Top of the head above the eye. */
const CROWN = 0.1
/** Tallest step the body walks up (and the highest collider it steps over) / drop it follows down without falling. */
const STEP_UP = 0.45
const STEP_DOWN = 0.5
const GRAVITY = 9.81
/** Jump apex ≈ 0.48 m. */
const JUMP_V = Math.sqrt(2 * GRAVITY * 0.48)
const COYOTE = 0.12
const JUMP_BUFFER = 0.15
/** Eye spring (critically damped, rad/s): absorbs step snaps and landings without lagging on slopes. */
const EYE_OMEGA = 12
/** Stride per footstep at a walk / at a run (m). */
const STRIDE_WALK = 0.72
const STRIDE_RUN = 1.05

export type StepEvent = {
  /** `Floor.surface` under the foot, "ground" on terrain, "ladder" on a ladder. */
  surface: string
  kind: "step" | "land" | "jump"
  foot: "left" | "right"
  /** Horizontal speed (m/s). */
  speed: number
  /** 0..1: how hard the foot comes down (a run, a landing). */
  intensity: number
}

/**
 * The walker's public state, updated in place every frame (read-only for other modules; fields are stable).
 * `pos` is the feet (the body, which snaps to floors); `eye` is the smoothed camera position.
 */
export type PlayerState = {
  readonly pos: { x: number; y: number; z: number }
  readonly vel: { x: number; y: number; z: number }
  readonly eye: { x: number; y: number; z: number }
  readonly yaw: number
  readonly pitch: number
  /** Current (smoothed) eye height above the feet, 1.65 standing → 1.05 crouched. */
  eyeHeight: number
  /** 0 standing … 1 fully crouched (smoothed). */
  crouch: number
  /** Crouch held/toggled (may stay crouched under a low ceiling even when released). */
  crouching: boolean
  grounded: boolean
  running: boolean
  onLadder: boolean
  /** Gait cycle 0..1: a left footfall at 0, a right at 0.5. */
  stepPhase: number
  /** Horizontal speed (m/s). */
  speed: number
  readonly flashlight: boolean
  readonly fly: boolean
}

/**
 * First-person walker. Bindings by physical key (docs/controls.md): WASD/arrows move, Shift run, C crouch (hold, or
 * toggle in the Lab), Space jump, E doors (`ctx.doors`), F flashlight, N fly (Space up, Q down), digits viewpoints.
 *
 * The body (`pos`) snaps to floors: it walks up steps ≤ 0.45 m and follows steps down ≤ 0.5 m without falling. The
 * camera does not: each snap goes into an eye offset that a critically damped spring brings back to zero, so stairs
 * read as a smooth climb instead of a jolt per tread, and landings dip the view. Movement has acceleration, friction
 * and limited air control; head bob, sway and footsteps follow the gait cycle. Door leaves block or yield to the body.
 */
export class Player {
  readonly pos = { x: 0, y: 0, z: 0 }
  readonly vel = { x: 0, y: 0, z: 0 }
  readonly state: PlayerState
  yaw = 0
  pitch = 0
  flashlight = false
  fly = false
  /** Automation only: when an array, every update pushes a sample (time, dt, feet, eye). */
  trace: { t: number; dt: number; y: number; eye: number; crouch: number; grounded: boolean }[] | null = null
  private keys = new Set<string>()
  private stepListeners: ((e: StepEvent) => void)[] = []
  private grounded = true
  private coyote = 0
  private jumpBuffer = 0
  private crouchToggled = false
  private crouch = 0
  private crouchWanted = false
  private eyeOffset = 0
  private eyeOffsetV = 0
  private phase = 0
  private bobAmp = 0
  private roll = 0
  private stairs = 0
  private time = 0
  private foot = 0
  private floor: Floor | null = null

  constructor(
    private camera: THREE.PerspectiveCamera,
    private canvas: HTMLCanvasElement,
    private ctx: WorldContext,
    enabled: boolean,
  ) {
    ctx.settings["player.crouchMode"] ??= 0
    ctx.settings["player.bob"] ??= 1
    ctx.controls.push(
      { key: "player.crouchMode", label: "Crouch key", group: "Player", type: "select", options: [{ value: 0, label: "Hold" }, { value: 1, label: "Toggle" }] },
      { key: "player.bob", label: "Head bob", group: "Player", unit: "×", min: 0, max: 2, step: 0.05 },
    )
    const self = this
    this.state = {
      pos: this.pos,
      vel: this.vel,
      eye: { x: 0, y: 0, z: 0 },
      get yaw() {
        return self.yaw
      },
      get pitch() {
        return self.pitch
      },
      eyeHeight: EYE,
      crouch: 0,
      crouching: false,
      grounded: true,
      running: false,
      onLadder: false,
      stepPhase: 0,
      speed: 0,
      get flashlight() {
        return self.flashlight
      },
      get fly() {
        return self.fly
      },
    } as PlayerState
    ctx.doors.attach(ctx, { pos: this.pos, camera })
    ;(globalThis as { __afterhoursPlayer?: Player }).__afterhoursPlayer = this
    if (!enabled) return
    canvas.addEventListener("click", () => canvas.requestPointerLock())
    document.addEventListener("mousemove", (e) => {
      if (document.pointerLockElement !== canvas) return
      const sens = Number(ctx.settings["player.sensitivity"] ?? 1) * 0.0022
      this.yaw -= e.movementX * sens
      this.pitch = Math.min(1.45, Math.max(-1.45, this.pitch - e.movementY * sens))
    })
    window.addEventListener("keydown", (e) => {
      if (isEditableEventTarget(e.target)) return
      if (e.code === "Space") e.preventDefault()
      this.keys.add(e.code)
      if (e.repeat) return
      if (e.code === "KeyF") this.flashlight = !this.flashlight
      if (e.code === "KeyE") ctx.doors.use()
      if (e.code === "KeyN") this.fly = !this.fly
      if (e.code === "Space") this.jumpBuffer = JUMP_BUFFER
      if (e.code === "KeyC") this.crouchToggled = !this.crouchToggled
      const views = Object.keys(VIEWPOINTS) as ViewpointName[]
      const digit = e.code.startsWith("Digit") ? Number(e.code.slice(5)) : 0
      if (digit >= 1 && digit <= views.length) this.teleport(views[digit - 1]!)
    })
    window.addEventListener("keyup", (e) => {
      this.keys.delete(e.code)
      // macOS swallows other keyups while Cmd is held.
      if (e.code === "MetaLeft" || e.code === "MetaRight") this.keys.clear()
    })
    window.addEventListener("blur", () => this.keys.clear())
    document.addEventListener("visibilitychange", () => document.hidden && this.keys.clear())
  }

  /** Footstep / landing / jump events (for footstep audio and the body). Returns an unsubscribe function. */
  onStep(listener: (e: StepEvent) => void) {
    this.stepListeners.push(listener)
    return () => {
      this.stepListeners = this.stepListeners.filter((l) => l !== listener)
    }
  }

  release() {
    this.keys.clear()
  }

  teleport(name: ViewpointName) {
    const v = VIEWPOINTS[name]
    this.pos.x = v.pos[0]
    this.pos.z = v.pos[2]
    this.pos.y = v.pos[1] - EYE + this.groundAt(this.pos.x, this.pos.z, 99)
    this.yaw = v.yaw
    this.pitch = v.pitch
    this.resetMotion()
    this.apply()
  }

  /** Clears velocity, the eye spring and air state (after any externally set position). */
  resetMotion() {
    this.vel.x = this.vel.y = this.vel.z = 0
    this.eyeOffset = this.eyeOffsetV = 0
    this.grounded = true
    this.coyote = 0
  }

  private get eyeHeight() {
    const c = this.crouch * this.crouch * (3 - 2 * this.crouch)
    return EYE + (EYE_CROUCH - EYE) * c
  }

  update(dt: number) {
    this.ctx.doors.update(dt)
    this.time += dt
    const k = this.keys
    const fwd = (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0) - (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0)
    const side = (k.has("KeyD") || k.has("ArrowRight") ? 1 : 0) - (k.has("KeyA") || k.has("ArrowLeft") ? 1 : 0)
    const run = k.has("ShiftLeft") || k.has("ShiftRight")
    const walk = Number(this.ctx.settings["player.walk"] ?? 1.9)
    const len = Math.hypot(fwd, side) || 1
    const sin = Math.sin(this.yaw)
    const cos = Math.cos(this.yaw)
    const wx = (-sin * fwd + cos * side) / len
    const wz = (-cos * fwd - sin * side) / len
    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt)

    if (this.fly) {
      const sp = (fwd || side ? 1 : 0) * walk * 6 * (run ? 8 : 1)
      const a = 1 - Math.exp(-8 * dt)
      this.vel.x += (wx * sp - this.vel.x) * a
      this.vel.z += (wz * sp - this.vel.z) * a
      const up = (k.has("Space") ? 1 : 0) - (k.has("KeyQ") ? 1 : 0)
      const h = Math.hypot(this.vel.x, this.vel.z)
      this.vel.y += (up * walk * 6 * (run ? 8 : 1) + Math.sin(this.pitch) * fwd * h - this.vel.y) * a
      this.pos.x += this.vel.x * dt
      this.pos.y += this.vel.y * dt
      this.pos.z += this.vel.z * dt
      this.grounded = false
      this.jumpBuffer = 0
      this.eyeOffset = this.eyeOffsetV = 0
      this.finish(dt, 0, false)
      return
    }

    // Crouch: held (default) or toggled; standing up needs headroom.
    const toggle = Number(this.ctx.settings["player.crouchMode"] ?? 0) === 1
    this.crouchWanted = toggle ? this.crouchToggled : k.has("KeyC")
    if (!toggle) this.crouchToggled = false
    const target = this.crouchWanted || !this.headroom(this.pos.x, this.pos.z, this.pos.y + EYE + CROWN) ? 1 : 0
    this.crouch += (target - this.crouch) * (1 - Math.exp(-dt / 0.09))
    if (Math.abs(target - this.crouch) < 0.002) this.crouch = target

    const ladder = this.ladderAt()
    if (ladder) {
      this.vel.x = this.vel.y = this.vel.z = 0
      const y0 = this.pos.y
      this.pos.y = Math.min(Math.max(this.pos.y + fwd * 1.4 * dt, ladder.min[1] - 0.05), ladder.max[1])
      this.move(wx * walk * 0.4 * dt * Math.abs(fwd || side), 0)
      this.move(0, wz * walk * 0.4 * dt * Math.abs(fwd || side))
      const top = this.groundAt(this.pos.x, this.pos.z, this.pos.y + STEP_UP)
      if (this.pos.y < top) {
        this.eyeOffset -= top - this.pos.y
        this.pos.y = top
      }
      this.grounded = true
      this.coyote = 0
      this.jumpBuffer = 0
      // Rungs: a hand-and-foot step every 0.3 m climbed.
      const climbed = Math.abs(this.pos.y - y0)
      this.finish(dt, climbed / 0.6, true)
      return
    }

    // Horizontal: accelerate towards the wished velocity; friction when there's no input; little air control.
    const crouchK = 1 - 0.55 * this.crouch
    const stairK = this.stairs > 0 ? 0.88 : 1
    const wish = (fwd || side ? 1 : 0) * walk * (run && this.crouch < 0.5 ? 2.3 : 1) * crouchK * stairK
    const rate = this.grounded ? (fwd || side ? 9 : 11) : 1.2
    const a = 1 - Math.exp(-rate * dt)
    this.vel.x += (wx * wish - this.vel.x) * a
    this.vel.z += (wz * wish - this.vel.z) * a
    const x0 = this.pos.x
    const z0 = this.pos.z
    if (!this.move(this.vel.x * dt, 0)) this.vel.x *= 0.3
    if (!this.move(0, this.vel.z * dt)) this.vel.z *= 0.3
    const moved = Math.hypot(this.pos.x - x0, this.pos.z - z0)

    // Jump (buffered; coyote time after walking off an edge). Not while crouched under something.
    this.coyote = this.grounded ? COYOTE : Math.max(0, this.coyote - dt)
    if (this.jumpBuffer > 0 && this.coyote > 0 && this.headroom(this.pos.x, this.pos.z, this.pos.y + EYE + CROWN + 0.2)) {
      this.vel.y = JUMP_V
      this.grounded = false
      this.coyote = 0
      this.jumpBuffer = 0
      this.emit("jump", Math.hypot(this.vel.x, this.vel.z), 0.5)
    }

    // Vertical: the body snaps up steps and follows steps down; the eye offset absorbs each snap.
    this.stairs = Math.max(0, this.stairs - dt)
    if (this.grounded) {
      const g = this.groundAt(this.pos.x, this.pos.z, this.pos.y + STEP_UP)
      const d = g - this.pos.y
      if (d >= -STEP_DOWN) {
        // Continuous ground (slopes, a moving lift floor) is followed directly; a discrete step is smoothed.
        if (Math.abs(d) > 0.03 + 0.9 * moved) {
          this.eyeOffset -= d
          this.stairs = 0.4
        }
        this.pos.y = g
        this.vel.y = 0
      } else {
        this.grounded = false
        this.vel.y = 0
      }
    }
    if (!this.grounded) {
      this.vel.y -= GRAVITY * dt
      const ny = this.pos.y + this.vel.y * dt
      const crown = this.eyeHeight + CROWN
      if (this.vel.y > 0 && !this.headroom(this.pos.x, this.pos.z, ny + crown)) this.vel.y = 0
      else this.pos.y = ny
      const g = this.groundAt(this.pos.x, this.pos.z, Math.max(this.pos.y, this.pos.y - this.vel.y * dt) + 0.02)
      if (this.vel.y <= 0 && this.pos.y <= g) {
        const impact = -this.vel.y
        this.eyeOffset -= g - this.pos.y
        this.pos.y = g
        this.vel.y = 0
        this.grounded = true
        // Landing: the knees take it, the view dips and recovers.
        this.eyeOffsetV -= Math.min(2.2, impact * 0.32)
        if (impact > 1.2) this.emit("land", Math.hypot(this.vel.x, this.vel.z), Math.min(1, impact / 6))
      }
    }
    this.finish(dt, this.grounded ? moved : 0, false)
  }

  /** Eye spring, gait cycle, footsteps, bob/sway/roll and the camera. `stride` is the distance walked this frame. */
  private finish(dt: number, stride: number, ladder: boolean) {
    // Critically damped spring on the eye offset.
    if (dt > 0) {
      const w = EYE_OMEGA
      this.eyeOffsetV += (-w * w * this.eyeOffset - 2 * w * this.eyeOffsetV) * dt
      this.eyeOffset += this.eyeOffsetV * dt
      this.eyeOffset = Math.max(-0.7, Math.min(0.7, this.eyeOffset))
    }
    const speed = Math.hypot(this.vel.x, this.vel.z)
    const running = speed > Number(this.ctx.settings["player.walk"] ?? 1.9) * 1.4
    // Gait: one cycle = two footfalls.
    if (stride > 0 && (this.grounded || ladder)) {
      const len = ladder ? 0.6 : running ? STRIDE_RUN : STRIDE_WALK
      const before = this.phase
      this.phase = (this.phase + stride / (2 * len)) % 1
      const crossed = Math.floor(before * 2) !== Math.floor(this.phase * 2) || stride / (2 * len) >= 0.5
      if (crossed && (speed > 0.35 || ladder)) this.emit("step", speed, ladder ? 0.4 : Math.min(1, 0.25 + speed / 5))
    }
    const moving = this.grounded && !this.fly && speed > 0.2 ? 1 : 0
    this.bobAmp += (moving * Math.min(speed, 4.5) - this.bobAmp) * (1 - Math.exp(-dt * 6))
    // Strafe roll: lean slightly into a sideways move.
    const right = this.vel.x * Math.cos(this.yaw) - this.vel.z * Math.sin(this.yaw)
    this.roll += (-right * 0.007 - this.roll) * (1 - Math.exp(-dt * 6))

    const s = this.state
    s.eyeHeight = this.eyeHeight
    s.crouch = this.crouch
    s.crouching = this.crouchWanted
    s.grounded = this.grounded
    s.running = running
    s.onLadder = ladder
    s.stepPhase = this.phase
    s.speed = speed
    this.apply()
    if (this.trace) this.trace.push({ t: this.time, dt, y: this.pos.y, eye: this.camera.position.y, crouch: this.crouch, grounded: this.grounded })
  }

  private emit(kind: StepEvent["kind"], speed: number, intensity: number) {
    if (!this.stepListeners.length) return
    const f = this.floor
    const surface = this.state.onLadder ? "ladder" : f ? (f.surface ?? "floor") : "ground"
    const e: StepEvent = { surface, kind, foot: this.foot++ % 2 ? "right" : "left", speed, intensity }
    for (const l of this.stepListeners) l(e)
  }

  private apply() {
    const knob = Number(this.ctx.settings["player.bob"] ?? 1)
    const amp = this.bobAmp * 0.011 * knob
    const p = this.phase * Math.PI * 2
    // Lowest at each footfall (phase 0 and 0.5), highest mid-stride; a slight sway towards the planted foot.
    const bobY = -amp * (0.5 + 0.5 * Math.cos(2 * p))
    const sway = amp * 0.35 * Math.sin(p)
    const eyeY = this.pos.y + this.eyeHeight + this.eyeOffset + bobY
    const cx = this.pos.x + Math.cos(this.yaw) * sway
    const cz = this.pos.z - Math.sin(this.yaw) * sway
    this.camera.position.set(cx, eyeY, cz)
    this.camera.rotation.set(this.pitch, this.yaw, this.roll + sway * 0.25, "YXZ")
    const e = this.state.eye as { x: number; y: number; z: number }
    e.x = cx
    e.y = eyeY
    e.z = cz
  }

  private ladderAt() {
    const p = this.pos
    return this.ctx.ladders.find(
      (l) => p.x >= l.min[0] && p.x <= l.max[0] && p.z >= l.min[2] && p.z <= l.max[2] && p.y + 0.3 >= l.min[1] && p.y <= l.max[1],
    )
  }

  /** Highest walkable surface at (x, z) that is no higher than `maxY` (and remembers which floor it is). */
  private groundAt(x: number, z: number, maxY: number) {
    let g = heightAt(x, z)
    let floor: Floor | null = null
    for (const f of this.ctx.floors) {
      if (x >= f.min[0] && x <= f.max[0] && z >= f.min[1] && z <= f.max[1] && f.y <= maxY && f.y > g) {
        g = f.y
        floor = f
      }
    }
    this.floor = floor
    return g
  }

  /**
   * True when a body standing at (x, z) on the current feet height has room up to `top`: no collider (circle vs box)
   * and no floor slab overhead (a slab's underside is taken as 0.25 m below its walking surface).
   */
  private headroom(x: number, z: number, top: number) {
    const from = this.pos.y + this.eyeHeight + CROWN - 0.02
    if (top <= from) return true
    const r2 = (RADIUS - 0.02) ** 2
    for (const b of this.ctx.colliders) {
      if (b.min[1] >= top || b.max[1] <= from) continue
      const cx = Math.max(b.min[0], Math.min(x, b.max[0]))
      const cz = Math.max(b.min[2], Math.min(z, b.max[2]))
      if ((x - cx) ** 2 + (z - cz) ** 2 < r2) return false
    }
    for (const f of this.ctx.floors) {
      const under = f.y - 0.25
      if (f.y <= this.pos.y + STEP_UP || under >= top || under <= from - 0.3) continue
      if (x >= f.min[0] && x <= f.max[0] && z >= f.min[1] && z <= f.max[1]) return false
    }
    return true
  }

  /** Moves the body horizontally against the world and the door leaves; false when fully blocked. */
  private move(dx: number, dz: number) {
    if (!dx && !dz) return true
    const nx = this.pos.x + dx
    const nz = this.pos.z + dz
    const feet = this.pos.y + STEP_UP
    const head = this.pos.y + this.eyeHeight + CROWN
    for (const b of this.ctx.colliders) {
      if (b.max[1] < feet || b.min[1] > head) continue
      const cx = Math.max(b.min[0], Math.min(nx, b.max[0]))
      const cz = Math.max(b.min[2], Math.min(nz, b.max[2]))
      if ((nx - cx) ** 2 + (nz - cz) ** 2 < RADIUS * RADIUS) return false
    }
    // Door leaves: block, or yield to the body (pushing an ajar door open slows the walk by its weight).
    const k = this.ctx.doors.push(this.pos.x, this.pos.z, nx, nz, feet, head, RADIUS)
    if (k <= 0) return false
    this.pos.x += dx * k
    this.pos.z += dz * k
    return true
  }
}
