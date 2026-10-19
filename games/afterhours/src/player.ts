import type * as THREE from "three/webgpu"
import { isEditableEventTarget } from "@arcade/kit/client/controls"
import type { Floor, Ladder, WorldContext } from "./world/context"
import { heightAt } from "./world/height"
import { VIEWPOINTS, type ViewpointName } from "./world/layout"
import { GameAudio } from "./audio/game"
import { weather } from "./world/weather"

const RADIUS = 0.3
/** Standing and crouched eye heights above the feet (m). */
const EYE = 1.65
const EYE_CROUCH = 1.2
/** Top of the head above the eye. */
const CROWN = 0.1
/** Body top when fully crouched (head bent forward): crawl spaces are modelled at 1.15 m and up. Under anything lower
 *  than the crouched eye, the eye ducks to stay 8 cm under it. */
const TOP_CROUCH = 1.15
/** Movement speeds (m/s), measured from the body's animation clips (src/playerb) so the cadence matches: walk is the
 *  Lab's Walk speed (1.6); Shift runs (4.5, the default Run style) or jogs (2.4); crouch-walk; backwards and sideways
 *  go 0.68×. Speeding up into a run eases in over about 0.7 s. */
const RUN = 4.5
const JOG = 2.4
const CROUCH_SPEED = 1.3
const WALK_REF = 1.6
const OFF_AXIS = 0.68
/** Tallest step the body walks up (and the highest collider it steps over) / drop it follows down without falling. */
const STEP_UP = 0.45
const STEP_DOWN = 0.5
const GRAVITY = 9.81
/** Jump apex 0.62 m (was 0.48); the fall pulls 1.25× harder so the higher jump doesn't float. */
const JUMP_APEX = 0.62
const JUMP_V = Math.sqrt(2 * GRAVITY * JUMP_APEX)
const FALL_G = 1.25
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
  /**
   * The ladder being climbed, or null: `normal` is the rung plane's outward unit normal (towards the climber) and
   * `plane` its offset, so the rungs are the points p with normal·p = plane.
   */
  ladder: { normal: readonly [number, number, number]; plane: number } | null
  /**
   * A mantle (climbing up onto a ledge) in progress, or null. `t` runs 0..1 over `duration` s; `from` is where the feet
   * were when it started, `to` where they end up on top; `height` = to.y − from.y; `crouch` when the headroom on top
   * only allows a crouch. The player has no control while it plays (hands on the ledge, pull up, knee over, stand).
   */
  mantle: { t: number; duration: number; height: number; from: readonly [number, number, number]; to: readonly [number, number, number]; crouch: boolean } | null
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
  trace: { t: number; dt: number; x: number; z: number; y: number; eye: number; offset: number; base: number; crouch: number; grounded: boolean }[] | null = null
  private keys = new Set<string>()
  private stepListeners: ((e: StepEvent) => void)[] = []
  private grounded = true
  private coyote = 0
  private jumpBuffer = 0
  /** Feet height when last on the ground (mid-jump ledge heights are measured from it). */
  private groundY = 0
  private mantle: NonNullable<PlayerState["mantle"]> & { face: readonly [number, number, number] } | null = null
  private mantlePitch = 0
  private crouchToggled = false
  private crouch = 0
  private crouchWanted = false
  private eyeOffset = 0
  private eyeOffsetV = 0
  /** Eye base: the ground box-filtered along the walking direction (a ramp on stairs), or the feet in the air. */
  private base = 0
  private lastY = 0
  private wasGrounded = true
  /** Body snaps this frame (ladder top, landing) that the eye should ease through. */
  private snap = 0
  private near: Floor[] = []
  private cutsX: number[] = []
  private cutsZ: number[] = []
  private phase = 0
  private bobAmp = 0
  private roll = 0
  private stairs = 0
  private time = 0
  private foot = 0
  private floor: Floor | null = null
  /** Eye limit under a low ceiling (smoothed); 3 m (no limit) when nothing is overhead. */
  private duck = 3
  private ladderOn: Ladder | null = null
  private ladderFace: PlayerState["ladder"] = null
  /** The game's audio (src/audio/game.ts): only with input enabled, so never in `?shot` mode. */
  readonly audio: GameAudio | null = null

  constructor(
    private camera: THREE.PerspectiveCamera,
    private canvas: HTMLCanvasElement,
    private ctx: WorldContext,
    enabled: boolean,
  ) {
    ctx.settings["player.crouchMode"] ??= 0
    ctx.settings["player.bob"] ??= 1
    ctx.settings["player.runStyle"] ??= 0
    ctx.settings["player.mantle"] ??= 1
    ctx.settings["player.mantleMin"] ??= 0.4
    ctx.settings["player.mantleMax"] ??= 1.4
    ctx.settings["player.mantleMaxAir"] ??= 1.7
    ctx.controls.push(
      { key: "player.crouchMode", label: "Crouch key", group: "Player", type: "select", options: [{ value: 0, label: "Hold" }, { value: 1, label: "Toggle" }] },
      { key: "player.bob", label: "Head bob", group: "Player", unit: "×", min: 0, max: 2, step: 0.05 },
      { key: "player.runStyle", label: "Run style", group: "Player", type: "select", options: [{ value: 0, label: "Run 4.5 m/s" }, { value: 1, label: "Jog 2.4 m/s" }] },
      { key: "player.mantle", label: "Climb onto ledges (Space)", group: "Player", type: "toggle", on: 1, off: 0 },
      { key: "player.mantleMin", label: "Climb: lowest ledge", group: "Player", unit: "m", min: 0.3, max: 0.8, step: 0.05 },
      { key: "player.mantleMax", label: "Climb: highest ledge", group: "Player", unit: "m", min: 0.8, max: 1.6, step: 0.05 },
      { key: "player.mantleMaxAir", label: "Climb: highest ledge mid-jump", group: "Player", unit: "m", min: 1.2, max: 2.0, step: 0.05 },
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
      ladder: null,
      mantle: null,
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
    // Weather (src/world/weather.ts): Lab controls always; the automatic storm only with input (never in `?shot`).
    weather.install(ctx, enabled)
    ;(globalThis as { __afterhoursPlayer?: Player }).__afterhoursPlayer = this
    if (!enabled) return
    ;(this as { audio: GameAudio | null }).audio = new GameAudio(ctx, this)
    // Audio unlocks on the first input (a click or a key), never before.
    canvas.addEventListener("click", () => {
      this.audio?.unlock()
      canvas.requestPointerLock()
    })
    document.addEventListener("mousemove", (e) => {
      if (document.pointerLockElement !== canvas) return
      const sens = Number(ctx.settings["player.sensitivity"] ?? 1) * 0.0022
      this.yaw -= e.movementX * sens
      this.pitch = Math.min(1.45, Math.max(-1.45, this.pitch - e.movementY * sens))
    })
    window.addEventListener("keydown", (e) => {
      if (isEditableEventTarget(e.target)) return
      if (e.code === "Space") e.preventDefault()
      this.audio?.unlock()
      this.keys.add(e.code)
      if (e.repeat) return
      if (e.code === "KeyF") {
        this.flashlight = !this.flashlight
        this.audio?.flashlight()
      }
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
    this.coyote = 0
    // Snap the feet to the floor at the new position (a teleport may set y a little above it), then rebuild the eye
    // base around the new feet: the filter judges heights against the previous base, which may be storeys away.
    const g = this.groundAt(this.pos.x, this.pos.z, this.pos.y + STEP_UP)
    if (g >= this.pos.y - STEP_DOWN) this.pos.y = g
    this.wasGrounded = false
    this.grounded = true
    this.base = this.pos.y
    this.base = this.filteredGround()
    this.wasGrounded = true
    this.lastY = this.pos.y
  }

  private get eyeHeight() {
    const c = this.crouch * this.crouch * (3 - 2 * this.crouch)
    return Math.min(EYE + (EYE_CROUCH - EYE) * c, this.duck)
  }

  /** Top of the body above the feet (collisions, headroom): 1.75 standing, 1.15 crouched. */
  private get bodyTop() {
    const c = this.crouch * this.crouch * (3 - 2 * this.crouch)
    return EYE + CROWN + (TOP_CROUCH - EYE - CROWN) * c
  }

  /**
   * Looks for a ledge to climb onto along (dx, dz): the nearest collider face within 0.6 m of the body whose top is
   * `player.mantleMin`..`player.mantleMax` above the feet (`mantleMaxAir` above the ground left, mid-jump) and which
   * rises from below the knees (not a shelf or a beam overhead); stacked boxes count as one. On top there must be
   * support (a collider or floor at that height) and room to stand, or at least to crouch; the column the body rises
   * through and its way over the edge must be clear. Starts the mantle and returns true when all of that holds.
   * Doors aren't colliders, and the perimeter fence is too high, so neither is ever climbed.
   */
  private tryMantle(dx: number, dz: number, air: boolean) {
    const set = this.ctx.settings
    if (Number(set["player.mantle"] ?? 1) === 0) return false
    const minH = Number(set["player.mantleMin"] ?? 0.4)
    const maxH = Number(set[air ? "player.mantleMaxAir" : "player.mantleMax"] ?? (air ? 1.7 : 1.4))
    const { x, y, z } = this.pos
    const ref = air ? this.groundY : y
    const reach = RADIUS + 0.6
    let faceT = Infinity
    let top = -Infinity
    for (const b of this.ctx.colliders) {
      const t = b.max[1]
      if (t - ref < minH || t - ref > maxH || t <= y + STEP_UP || b.min[1] > y + STEP_UP) continue
      const hit = ray2(x, z, dx, dz, b)
      if (hit < 0 || hit > reach) continue
      if (hit < faceT - 0.02 || (Math.abs(hit - faceT) <= 0.02 && t > top)) {
        faceT = Math.min(faceT, hit)
        top = t
      }
    }
    if (faceT === Infinity) return false
    // Stacked boxes: climb to the top of the stack at the face.
    const fx = x + dx * (faceT + 0.05)
    const fz = z + dz * (faceT + 0.05)
    for (let pass = 0; pass < 3; pass++)
      for (const b of this.ctx.colliders)
        if (fx >= b.min[0] && fx <= b.max[0] && fz >= b.min[2] && fz <= b.max[2] && b.min[1] <= top + 0.05 && b.max[1] > top) top = b.max[1]
    if (top - ref > maxH) return false
    // Room to rise at the start (from the head now to a crouch above the ledge).
    if (!this.clearColumn(x, z, y + this.bodyTop - 0.02, top + TOP_CROUCH, 0.25)) return false
    for (const inset of [0.35, 0.25, 0.15]) {
      const tx = x + dx * (faceT + inset)
      const tz = z + dz * (faceT + inset)
      if (!this.supportAt(tx, tz, top)) continue
      const stand = this.clearColumn(tx, tz, top + 0.05, top + EYE + CROWN, 0.22)
      if (!stand && !this.clearColumn(tx, tz, top + 0.05, top + TOP_CROUCH, 0.22)) continue
      // The way over the edge: nothing standing up out of the top between the face and the spot.
      let way = true
      for (let i = 0; i <= 3 && way; i++) {
        const u = faceT + (inset * i) / 3
        way = this.clearColumn(x + dx * u, z + dz * u, top + 0.05, top + TOP_CROUCH, 0.18)
      }
      if (!way) continue
      const height = top - y
      const duration = 0.5 + 0.6 * Math.max(0, Math.min(1, (height - 0.4) / 1.0))
      const near = Math.max(0, faceT - 0.32)
      this.mantle = {
        t: 0,
        duration,
        height,
        from: [x, y, z],
        to: [tx, top, tz],
        face: [x + dx * near, y, z + dz * near],
        crouch: !stand,
      }
      this.vel.x = this.vel.y = this.vel.z = 0
      this.grounded = false
      this.jumpBuffer = 0
      this.coyote = 0
      // Hands on the ledge: a small dip as the arms take the weight.
      this.eyeOffsetV -= 0.35
      this.emit("jump", 0, 0.3)
      return true
    }
    return false
  }

  /** One frame of a mantle: rise beside the face, then over the edge onto the spot; the view dips and pitches. */
  private stepMantle(dt: number) {
    const m = this.mantle!
    m.t = Math.min(1, m.t + dt / m.duration)
    const u = m.t
    const ss = (v: number) => {
      const c = Math.max(0, Math.min(1, v))
      return c * c * (3 - 2 * c)
    }
    // Up first (done by 70%), with the knee-over hump just above the ledge; across in two parts: to just short of the
    // face while rising, then over the top once level with it.
    const rise = ss(u / 0.7)
    this.pos.y = m.from[1] + m.height * rise + 0.06 * Math.sin(Math.PI * ss((u - 0.55) / 0.45))
    const a = ss(u / 0.6)
    const b = ss((u - 0.62) / 0.38)
    const px = m.from[0] + (m.face[0] - m.from[0]) * a
    const pz = m.from[2] + (m.face[2] - m.from[2]) * a
    this.pos.x = px + (m.to[0] - m.face[0]) * b
    this.pos.z = pz + (m.to[2] - m.face[2]) * b
    // Knee over: a half crouch through the middle; a full one on top when the headroom needs it.
    const want = m.crouch ? (u > 0.45 ? 1 : 0.5 * ss(u / 0.45)) : 0.55 * Math.sin(Math.PI * ss((u - 0.3) / 0.6))
    this.crouch += (want - this.crouch) * (1 - Math.exp(-dt / 0.08))
    this.mantlePitch = -0.22 * Math.sin(Math.PI * u)
    if (u >= 1) {
      this.pos.x = m.to[0]
      this.pos.y = m.to[1]
      this.pos.z = m.to[2]
      this.mantle = null
      this.mantlePitch = 0
      this.grounded = true
      this.groundY = this.pos.y
      this.emit("land", 0, 0.25)
    }
    this.finish(dt, 0, false)
  }

  /** Something to stand on at (x, z) at height `top` (± 6 cm): a collider top or a floor. */
  private supportAt(x: number, z: number, top: number) {
    for (const b of this.ctx.colliders) if (x >= b.min[0] && x <= b.max[0] && z >= b.min[2] && z <= b.max[2] && Math.abs(b.max[1] - top) < 0.06) return true
    for (const f of this.ctx.floors) if (x >= f.min[0] && x <= f.max[0] && z >= f.min[1] && z <= f.max[1] && Math.abs(f.y - top) < 0.06) return true
    return false
  }

  /** No collider (circle of radius `r` vs box) and no floor slab overhead between heights `lo` and `hi` at (x, z). */
  private clearColumn(x: number, z: number, lo: number, hi: number, r: number) {
    if (hi <= lo) return true
    const r2 = r * r
    for (const b of this.ctx.colliders) {
      if (b.min[1] >= hi || b.max[1] <= lo) continue
      const cx = Math.max(b.min[0], Math.min(x, b.max[0]))
      const cz = Math.max(b.min[2], Math.min(z, b.max[2]))
      if ((x - cx) ** 2 + (z - cz) ** 2 < r2) return false
    }
    for (const f of this.ctx.floors) {
      const under = f.y - 0.25
      if (f.y <= lo + 0.3 || under >= hi) continue
      if (x >= f.min[0] && x <= f.max[0] && z >= f.min[1] && z <= f.max[1]) return false
    }
    return true
  }

  /** Lowest underside overhead within the body's footprint, above the feet (m; Infinity when clear to 1.8 m). */
  private ceiling() {
    const { x, y, z } = this.pos
    const r2 = (RADIUS - 0.02) ** 2
    let c = Infinity
    for (const b of this.ctx.colliders) {
      const u = b.min[1] - y
      if (u < 0.9 || u >= c || u > 1.8 || b.max[1] <= b.min[1]) continue
      const cx = Math.max(b.min[0], Math.min(x, b.max[0]))
      const cz = Math.max(b.min[2], Math.min(z, b.max[2]))
      if ((x - cx) ** 2 + (z - cz) ** 2 < r2) c = u
    }
    return c
  }

  update(dt: number) {
    this.ctx.doors.update(dt)
    weather.update(dt)
    this.audio?.update(dt, this.camera)
    this.time += dt
    const k = this.keys
    const fwd = (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0) - (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0)
    const side = (k.has("KeyD") || k.has("ArrowRight") ? 1 : 0) - (k.has("KeyA") || k.has("ArrowLeft") ? 1 : 0)
    const run = k.has("ShiftLeft") || k.has("ShiftRight")
    const walk = Number(this.ctx.settings["player.walk"] ?? WALK_REF)
    const len = Math.hypot(fwd, side) || 1
    const sin = Math.sin(this.yaw)
    const cos = Math.cos(this.yaw)
    const wx = (-sin * fwd + cos * side) / len
    const wz = (-cos * fwd - sin * side) / len
    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt)

    if (this.mantle && !this.fly) {
      this.stepMantle(dt)
      return
    }

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
    // (No forced crouch on a ladder: its volume is the climbing column, hatch frames and cages included.)
    const forced = !this.ladderAt() && !this.headroom(this.pos.x, this.pos.z, this.pos.y + EYE + CROWN)
    const target = this.crouchWanted || forced ? 1 : 0
    this.crouch += (target - this.crouch) * (1 - Math.exp(-dt / 0.09))
    if (Math.abs(target - this.crouch) < 0.002) this.crouch = target

    // Ladders. Inside a ladder volume the body is on the rungs: W climbs (or descends while looking well down), S
    // descends, whatever the facing, and there is no forward drift off the rungs; A/D shift a little along them,
    // kept inside the volume. At the bottom, S or no input is ordinary walking (step off backwards); at the top, W
    // steps forward off the ladder onto the landing.
    const ladder = this.ladderAt()
    const climb = fwd > 0 ? (this.pitch < -0.6 ? -1 : 1) : fwd < 0 ? -1 : 0
    const footing = ladder ? this.groundAt(this.pos.x, this.pos.z, this.pos.y + 0.05) : 0
    const onRungs = ladder && !(this.pos.y <= footing + 0.02 && climb <= 0)
    if (ladder !== this.ladderOn) this.ladderFace = ladder ? this.faceOf(ladder) : null
    this.ladderOn = ladder ?? null
    if (ladder && onRungs) {
      this.vel.x = this.vel.y = this.vel.z = 0
      this.grounded = false
      this.coyote = 0
      this.jumpBuffer = 0
      const y0 = this.pos.y
      const top = ladder.max[1]
      // Onto the rungs: the body eases to the ladder's centre line (it may have walked in at the volume's edge, against
      // a rail or the cage), so the climb and the step off at the top are clear.
      const cx = (ladder.min[0] + ladder.max[0]) / 2
      const cz = (ladder.min[2] + ladder.max[2]) / 2
      const pull = Math.min(1, 2.5 * dt)
      const dismounting = this.pos.y >= top - 0.01 && climb > 0
      if (!side && !dismounting) {
        this.pos.x += (cx - this.pos.x) * pull
        this.pos.z += (cz - this.pos.z) * pull
      }
      if (this.pos.y >= top - 0.01 && climb > 0) {
        // Dismount at the top: step forward; the first floor within a step takes the feet.
        this.pos.y = top
        const sx = this.pos.x
        const sz = this.pos.z
        this.move(wx * walk * 0.6 * dt, 0)
        this.move(0, wz * walk * 0.6 * dt)
        const g = this.groundAt(this.pos.x, this.pos.z, this.pos.y + STEP_UP)
        if (g >= this.pos.y - STEP_DOWN && (!this.ladderAt() || g >= this.pos.y - 0.2)) {
          this.snap += g - this.pos.y
          this.pos.y = g
          this.grounded = true
        }
        this.finish(dt, Math.hypot(this.pos.x - sx, this.pos.z - sz), !this.grounded)
        return
      }
      const ny = Math.min(top, this.pos.y + climb * 1.25 * dt)
      // A floor inside the column (a parapet coping, a step) lifts the feet onto it; the eye eases through.
      if (ny < footing) this.snap += footing - ny
      this.pos.y = Math.max(footing, ny)
      if (side) {
        const c = Math.cos(this.yaw)
        const sn = Math.sin(this.yaw)
        const m = 0.6 * dt * side
        const nx = Math.max(ladder.min[0] + 0.02, Math.min(ladder.max[0] - 0.02, this.pos.x + c * m))
        const nz = Math.max(ladder.min[2] + 0.02, Math.min(ladder.max[2] - 0.02, this.pos.z - sn * m))
        this.move(nx - this.pos.x, 0)
        this.move(0, nz - this.pos.z)
      }
      if (this.pos.y <= footing + 1e-3) this.grounded = true
      // Rungs: a hand-and-foot step every 0.3 m climbed.
      this.finish(dt, Math.abs(this.pos.y - y0) / 0.6, true)
      return
    }

    // Duck under anything lower than the crouched eye (a 1.15 m crawl space): the eye stays 8 cm under it.
    const ceil = this.ceiling()
    const duckTo = ceil < EYE + CROWN ? Math.max(0.95, ceil - 0.08) : 3
    this.duck += (duckTo - this.duck) * (1 - Math.exp(-dt / (duckTo < this.duck ? 0.1 : 0.2)))

    // Horizontal: accelerate towards the wished velocity; friction when there's no input; little air control.
    // Speeds follow the body's clips: walk, jog or sprint (Lab "Run style"), crouch-walk; backwards and sideways
    // go 0.68× forward, blended by the input direction.
    const scale = walk / WALK_REF
    const runSpeed = Number(this.ctx.settings["player.runStyle"] ?? 0) === 1 ? JOG : RUN
    const base = this.crouch > 0.5 ? CROUCH_SPEED * scale : run ? runSpeed * scale : walk
    const ahead = Math.max(0, fwd / len)
    const dirK = OFF_AXIS + (1 - OFF_AXIS) * ahead * ahead
    const stairK = this.stairs > 0 ? 0.75 : 1
    const wish = (fwd || side ? 1 : 0) * base * dirK * stairK
    // Into a run the body takes a moment to get going (a short ramp, not a snap); walking and stopping stay crisp.
    const speeding = wish > walk * 1.3 && wish > Math.hypot(this.vel.x, this.vel.z) + 0.05
    const rate = this.grounded ? (fwd || side ? (speeding ? 3.2 : 9) : 11) : 1.2
    const a = 1 - Math.exp(-rate * dt)
    this.vel.x += (wx * wish - this.vel.x) * a
    this.vel.z += (wz * wish - this.vel.z) * a
    const x0 = this.pos.x
    const z0 = this.pos.z
    if (!this.move(this.vel.x * dt, 0)) this.vel.x *= 0.3
    if (!this.move(0, this.vel.z * dt)) this.vel.z *= 0.3
    const moved = Math.hypot(this.pos.x - x0, this.pos.z - z0)

    // Space at a ledge climbs onto it (mantle) instead of jumping: towards where the player is walking, else where
    // they face; mid-jump it reaches higher ledges.
    if (this.grounded) this.groundY = this.pos.y
    if (this.jumpBuffer > 0) {
      const dl = fwd > 0 || side ? Math.hypot(wx, wz) || 1 : 0
      const mx = dl && fwd >= 0 ? wx / dl : -sin
      const mz = dl && fwd >= 0 ? wz / dl : -cos
      if (this.tryMantle(mx, mz, !this.grounded && this.coyote <= 0)) {
        this.finish(dt, 0, false)
        return
      }
    }

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
        // A discrete step (stairs, a kerb) slows the walk a little; the eye follows the filtered ground, not this snap.
        if (Math.abs(d) > 0.03 + 0.9 * moved) this.stairs = 0.4
        this.pos.y = g
        this.vel.y = 0
      } else {
        this.grounded = false
        this.vel.y = 0
      }
    }
    if (!this.grounded) {
      this.vel.y -= GRAVITY * (this.vel.y < 0 ? FALL_G : 1) * dt
      const ny = this.pos.y + this.vel.y * dt
      const crown = this.bodyTop
      if (this.vel.y > 0 && !this.headroom(this.pos.x, this.pos.z, ny + crown)) this.vel.y = 0
      else this.pos.y = ny
      const g = this.groundAt(this.pos.x, this.pos.z, Math.max(this.pos.y, this.pos.y - this.vel.y * dt) + 0.02)
      if (this.vel.y <= 0 && this.pos.y <= g) {
        const impact = -this.vel.y
        this.snap += g - this.pos.y
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
    // Eye base. On the ground it is the floor averaged over ±0.3 m around the feet (exact, so a flight of 0.28 m treads
    // becomes a straight ramp with no per-tread step); any jump left in it (a tall step, taking off, landing) goes into
    // the eye offset, which a critically damped spring brings back to zero.
    const base = this.fly ? this.pos.y : this.grounded && !ladder ? this.filteredGround() : this.pos.y
    const db = base - this.base
    if (this.fly) this.eyeOffset = this.eyeOffsetV = 0
    else if (this.grounded && this.wasGrounded && !ladder) {
      if (Math.abs(db) > 0.03 + 0.9 * stride) this.eyeOffset -= db
      // Stairs (the smoothed ground climbs or falls steeply underfoot): walk a little slower, from the first tread.
      else if (stride > 1e-3 && Math.abs(db) > 0.3 * stride) this.stairs = 0.4
    } else this.eyeOffset -= db - (this.pos.y - this.lastY - this.snap)
    this.base = base
    this.lastY = this.pos.y
    this.wasGrounded = this.grounded
    this.snap = 0
    if (dt > 0) {
      const w = EYE_OMEGA
      this.eyeOffsetV += (-w * w * this.eyeOffset - 2 * w * this.eyeOffsetV) * dt
      this.eyeOffset += this.eyeOffsetV * dt
      this.eyeOffset = Math.max(-0.7, Math.min(0.7, this.eyeOffset))
    }
    const speed = Math.hypot(this.vel.x, this.vel.z)
    const running = speed > Number(this.ctx.settings["player.walk"] ?? WALK_REF) * 1.25
    // Gait: one cycle = two footfalls.
    if (stride > 0 && (this.grounded || ladder)) {
      const len = ladder ? 0.6 : running ? STRIDE_RUN : STRIDE_WALK
      const before = this.phase
      this.phase = (this.phase + stride / (2 * len)) % 1
      const crossed = Math.floor(before * 2) !== Math.floor(this.phase * 2) || stride / (2 * len) >= 0.5
      if (crossed && (speed > 0.35 || ladder)) this.emit("step", speed, ladder ? 0.4 : Math.min(1, 0.25 + speed / 5))
    }
    const moving = this.grounded && !this.fly && speed > 0.2 ? 1 : 0
    // On stairs the body rises with the treads instead of bobbing over level strides: half the bob.
    this.bobAmp += (moving * Math.min(speed, 4.5) * (this.stairs > 0 ? 0.5 : 1) - this.bobAmp) * (1 - Math.exp(-dt * 6))
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
    s.ladder = ladder ? this.ladderFace : null
    s.stepPhase = this.phase
    s.mantle = this.mantle
    s.speed = speed
    this.apply()
    if (this.trace) this.trace.push({ t: this.time, dt, x: this.pos.x, z: this.pos.z, y: this.pos.y, eye: this.camera.position.y, offset: this.eyeOffset, base: this.base, crouch: this.crouch, grounded: this.grounded })
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
    const eyeY = this.base + this.eyeHeight + this.eyeOffset + bobY
    const cx = this.pos.x + Math.cos(this.yaw) * sway
    const cz = this.pos.z - Math.sin(this.yaw) * sway
    this.camera.position.set(cx, eyeY, cz)
    this.camera.rotation.set(this.pitch + this.mantlePitch, this.yaw, this.roll + sway * 0.25, "YXZ")
    const e = this.state.eye as { x: number; y: number; z: number }
    e.x = cx
    e.y = eyeY
    e.z = cz
  }

  /**
   * Rung plane of a ladder: its own `normal` if set; else the axis the body walked in along (the climber faces the
   * rungs), pointing back towards where it came from; with no motion, the volume's thinner axis towards the body.
   */
  private faceOf(l: Ladder): { normal: readonly [number, number, number]; plane: number } {
    const cx = (l.min[0] + l.max[0]) / 2
    const cz = (l.min[2] + l.max[2]) / 2
    let nx: number
    let nz: number
    const vx = this.vel.x
    const vz = this.vel.z
    if (l.normal) {
      const len = Math.hypot(l.normal[0], l.normal[1]) || 1
      nx = l.normal[0] / len
      nz = l.normal[1] / len
    } else if (Math.hypot(vx, vz) > 0.2) {
      nx = Math.abs(vx) >= Math.abs(vz) ? -Math.sign(vx) : 0
      nz = Math.abs(vx) >= Math.abs(vz) ? 0 : -Math.sign(vz)
    } else if (l.max[0] - l.min[0] <= l.max[2] - l.min[2]) {
      nx = this.pos.x >= cx ? 1 : -1
      nz = 0
    } else {
      nx = 0
      nz = this.pos.z >= cz ? 1 : -1
    }
    return { normal: [nx, 0, nz], plane: nx * cx + nz * cz }
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
    // The tops of solid things count too (a crate, a bookcase, the dock): what a mantle puts the feet on, and what a
    // low box (under a step) is walked up onto. Thin ones (rails, fence wire) are never stood on.
    for (const b of this.ctx.colliders) {
      const t = b.max[1]
      if (t > maxY || t <= g || !standable(b) || x < b.min[0] || x > b.max[0] || z < b.min[2] || z > b.max[2]) continue
      g = t
      floor = topOf(b)
    }
    this.floor = floor
    return g
  }

  /**
   * Walkable height under the feet smoothed with a 2D tent kernel (±0.3 m, up to ±0.5 m at a run), integrated exactly
   * over the floor rectangles (all axis-aligned), so a flight of treads becomes an even ramp with no per-tread kink and
   * no lag, whatever the walking direction. Heights more than 0.75 m from the current base (the flight on the other
   * side of the well) and, when standing on a floor, places with no floor (inside a wall) are left out and the
   * remaining weights renormalised, so only the treads underfoot shape the ramp.
   */
  private filteredGround() {
    // Wider at a run, so the climb eases in over the same time at the foot of a flight (a straight ramp is unchanged).
    const H = 0.3 + 0.2 * Math.max(0, Math.min(1, (Math.hypot(this.vel.x, this.vel.z) - WALK_REF) / 2.5))
    const { x, z } = this.pos
    // Heights are judged against the previous eye base (continuous), not the snapping feet: a tread entering or
    // leaving the window when the body steps would otherwise kink the ramp for a frame.
    const ref = this.wasGrounded ? this.base : this.pos.y
    const maxY = ref + 0.75
    const near = this.near
    const xs = this.cutsX
    const zs = this.cutsZ
    near.length = xs.length = zs.length = 0
    xs.push(-H, H)
    zs.push(-H, H)
    for (const f of this.ctx.floors) {
      if (f.y > maxY || f.max[0] < x - H || f.min[0] > x + H || f.max[1] < z - H || f.min[1] > z + H) continue
      near.push(f)
      for (const v of [f.min[0] - x, f.max[0] - x]) if (v > -H && v < H) xs.push(v)
      for (const v of [f.min[1] - z, f.max[1] - z]) if (v > -H && v < H) zs.push(v)
    }
    // Standable collider tops near the feet (inside a wall's footprint never counts: see `standable`).
    for (const b of this.ctx.colliders) {
      if (b.max[1] > maxY || b.max[1] < ref - 0.75 || b.max[0] < x - H || b.min[0] > x + H || b.max[2] < z - H || b.min[2] > z + H || !standable(b)) continue
      near.push(topOf(b))
      for (const v of [b.min[0] - x, b.max[0] - x]) if (v > -H && v < H) xs.push(v)
      for (const v of [b.min[2] - z, b.max[2] - z]) if (v > -H && v < H) zs.push(v)
    }
    xs.sort((a, b) => a - b)
    zs.sort((a, b) => a - b)
    // Tent antiderivative on [-H, H] (total weight 1).
    const F = (q: number) => (H * q - (Math.sign(q) * q * q) / 2) / (H * H)
    // On a floor, cells with no floor (inside a wall, the void beside a stair) don't count; the rest are renormalised.
    const indoors = this.floor !== null
    let sum = 0
    let total = 0
    for (let i = 1; i < xs.length; i++) {
      const wx = F(xs[i]!) - F(xs[i - 1]!)
      if (wx <= 1e-9) continue
      const px = x + (xs[i]! + xs[i - 1]!) / 2
      for (let j = 1; j < zs.length; j++) {
        const wz = F(zs[j]!) - F(zs[j - 1]!)
        if (wz <= 1e-9) continue
        const pz = z + (zs[j]! + zs[j - 1]!) / 2
        let g = -Infinity
        for (const f of near) if (px >= f.min[0] && px <= f.max[0] && pz >= f.min[1] && pz <= f.max[1] && f.y > g) g = f.y
        if (g === -Infinity) {
          if (indoors) continue
          g = heightAt(px, pz)
        } else g = Math.max(g, heightAt(px, pz))
        if (Math.abs(g - ref) > 0.75) continue
        sum += g * wx * wz
        total += wx * wz
      }
    }
    return total > 0.05 ? sum / total : this.pos.y
  }

  /**
   * True when a body standing at (x, z) on the current feet height has room up to `top`: no collider (circle vs box)
   * and no floor slab overhead (a slab's underside is taken as 0.25 m below its walking surface).
   */
  private headroom(x: number, z: number, top: number) {
    const from = this.pos.y + this.bodyTop - 0.02
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
    const head = this.pos.y + this.bodyTop
    for (const b of this.ctx.colliders) {
      if (b.max[1] < feet || b.min[1] > head) continue
      const cx = Math.max(b.min[0], Math.min(nx, b.max[0]))
      const cz = Math.max(b.min[2], Math.min(nz, b.max[2]))
      const d2 = (nx - cx) ** 2 + (nz - cz) ** 2
      if (d2 >= RADIUS * RADIUS) continue
      // Already overlapping (a ladder top, a teleport): moving further out is allowed, so nothing can trap the body.
      const ox = Math.max(b.min[0], Math.min(this.pos.x, b.max[0]))
      const oz = Math.max(b.min[2], Math.min(this.pos.z, b.max[2]))
      if (d2 <= (this.pos.x - ox) ** 2 + (this.pos.z - oz) ** 2 + 1e-9) return false
    }
    // Door leaves: block, or yield to the body (pushing an ajar door open slows the walk by its weight).
    const k = this.ctx.doors.push(this.pos.x, this.pos.z, nx, nz, feet, head, RADIUS)
    if (k <= 0) return false
    this.pos.x += dx * k
    this.pos.z += dz * k
    return true
  }
}

/** Distance along the ray (x, z) + t·(dx, dz) to where it enters box `b` in plan, or −1 (already inside counts as 0). */
function ray2(x: number, z: number, dx: number, dz: number, b: { min: readonly number[]; max: readonly number[] }) {
  let t0 = 0
  let t1 = Infinity
  for (const [o, d, lo, hi] of [
    [x, dx, b.min[0]!, b.max[0]!],
    [z, dz, b.min[2]!, b.max[2]!],
  ] as const) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return -1
      continue
    }
    let a = (lo - o) / d
    let c = (hi - o) / d
    if (a > c) [a, c] = [c, a]
    t0 = Math.max(t0, a)
    t1 = Math.min(t1, c)
    if (t0 > t1) return -1
  }
  return t0
}

/** A collider whose top can be stood on: at least 20 cm across both ways. */
function standable(b: { min: readonly number[]; max: readonly number[] }) {
  return b.max[0]! - b.min[0]! >= 0.2 && b.max[2]! - b.min[2]! >= 0.2
}

const tops = new WeakMap<object, Floor>()
/** A collider's top as a floor (cached per collider). */
function topOf(b: { min: readonly number[]; max: readonly number[] }): Floor {
  let f = tops.get(b)
  if (!f || f.y !== b.max[1]) {
    f = { min: [b.min[0]!, b.min[2]!], max: [b.max[0]!, b.max[2]!], y: b.max[1]! }
    tops.set(b, f)
  }
  return f
}
