import { groundAt, LADDER, ladderAt } from "./stage"

// A small stand-in for the game's Player controller (src/player.ts) for the Body Lab: same speeds, acceleration,
// step-up/step-down, gravity, jump, crouch eye height, eye spring and ladder climb, and the same PlayerState fields the
// body reads. On the treadmill it keeps its place while its velocity runs (the belt).

const EYE = 1.65
const EYE_CROUCH = 1.05
const STEP_UP = 0.45
const STEP_DOWN = 0.5
const GRAVITY = 9.81
const JUMP_V = Math.sqrt(2 * GRAVITY * 0.48)

export type WalkInput = { fwd: number; side: number; run: boolean; crouch: boolean; jump: boolean; yawRate: number; pitchRate: number }

export class LabWalker {
  readonly pos = { x: 0, y: 0, z: 0 }
  readonly vel = { x: 0, y: 0, z: 0 }
  readonly eye = { x: 0, y: EYE, z: 0 }
  yaw = 0
  pitch = 0
  crouch = 0
  grounded = true
  onLadder = false
  flashlight = false
  fly = false
  running = false
  treadmill = false
  walk = 1.9
  readonly input: WalkInput = { fwd: 0, side: 0, run: false, crouch: false, jump: false, yawRate: 0, pitchRate: 0 }
  private eyeOff = 0
  private eyeV = 0

  place(x: number, z: number, yaw: number, y = 99) {
    this.pos.x = x
    this.pos.z = z
    this.pos.y = groundAt(x, z, y)
    this.yaw = yaw
    this.vel.x = this.vel.y = this.vel.z = 0
    this.grounded = true
    this.onLadder = false
    this.eyeOff = 0
    this.eyeV = 0
    this.syncEye()
  }

  update(dt: number) {
    const k = this.input
    this.yaw += k.yawRate * dt
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + k.pitchRate * dt))
    this.crouch += ((k.crouch ? 1 : 0) - this.crouch) * (1 - Math.exp(-10 * dt))
    const len = Math.hypot(k.fwd, k.side) || 1
    const s = Math.sin(this.yaw)
    const c = Math.cos(this.yaw)
    const wx = (-s * k.fwd + c * k.side) / len
    const wz = (-c * k.fwd - s * k.side) / len
    const y0 = this.pos.y

    // Ladder: forward climbs while inside the ladder volume; at the top, step off onto the platform.
    if (this.onLadder || (ladderAt(this.pos.x, this.pos.y, this.pos.z) && k.fwd > 0 && Math.abs(Math.sin(this.yaw)) < 0.5)) {
      this.onLadder = true
      this.vel.x = this.vel.z = 0
      this.vel.y = k.fwd * 1.25
      this.pos.y += this.vel.y * dt
      if (this.pos.y <= 0) {
        this.pos.y = 0
        this.onLadder = k.fwd > 0
      }
      if (this.pos.y >= LADDER.top) {
        this.pos.y = LADDER.top
        this.pos.z = LADDER.z - 0.5
        this.eyeOff -= 0.0
        this.onLadder = false
        this.vel.y = 0
      }
      this.grounded = !this.onLadder
      this.running = false
      this.syncEye(dt)
      return
    }

    const wish = (k.fwd || k.side ? 1 : 0) * this.walk * (k.run && this.crouch < 0.5 ? 2.3 : 1) * (1 - 0.55 * this.crouch)
    const rate = this.grounded ? (k.fwd || k.side ? 9 : 11) : 1.2
    const a = 1 - Math.exp(-rate * dt)
    this.vel.x += (wx * wish - this.vel.x) * a
    this.vel.z += (wz * wish - this.vel.z) * a
    this.running = k.run && wish > this.walk * 1.5
    if (!this.treadmill) {
      const nx = this.pos.x + this.vel.x * dt
      const nz = this.pos.z + this.vel.z * dt
      // The only solid in the room: the ladder's platform block (walk up to it, climb it by the ladder).
      const blocked = this.pos.y < LADDER.top - 0.1 && nx > LADDER.x0 - 1.3 && nx < LADDER.x1 + 1.3 && nz < LADDER.z - 0.15 + 0.3 && nz > LADDER.z - 1.9
      if (!blocked) {
        this.pos.x = nx
        this.pos.z = nz
      } else {
        this.vel.x = this.vel.z = 0
      }
    }
    if (this.grounded && k.jump) {
      this.vel.y = JUMP_V
      this.grounded = false
    }
    k.jump = false
    const g = groundAt(this.pos.x, this.pos.z, this.pos.y + STEP_UP)
    if (this.grounded) {
      if (g >= this.pos.y - STEP_DOWN) {
        this.eyeOff -= g - this.pos.y
        this.pos.y = g
        this.vel.y = 0
      } else this.grounded = false
    }
    if (!this.grounded) {
      this.vel.y -= GRAVITY * dt
      this.pos.y += this.vel.y * dt
      if (this.pos.y <= g) {
        this.eyeOff -= g - this.pos.y
        this.pos.y = g
        this.vel.y = 0
        this.grounded = true
      }
    }
    void y0
    this.syncEye(dt)
  }

  /** Eye at the crouch-blended height above the feet; step snaps go into a critically damped offset. */
  private syncEye(dt = 0) {
    const w = 12
    if (dt > 0) {
      const acc = -w * w * this.eyeOff - 2 * w * this.eyeV
      this.eyeV += acc * dt
      this.eyeOff += this.eyeV * dt
    }
    this.eyeOff = Math.max(-0.5, Math.min(0.5, this.eyeOff))
    this.eye.x = this.pos.x
    this.eye.z = this.pos.z
    this.eye.y = this.pos.y + EYE + (EYE_CROUCH - EYE) * this.crouch + this.eyeOff
  }
}
