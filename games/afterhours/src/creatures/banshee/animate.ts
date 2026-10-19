import * as THREE from "three/webgpu"
import { Spring, aimBone, worldQuat } from "../kit/ik"
import type { CreatureRig } from "../kit/runtime"

// Procedural motion for the Banshee. It never touches the ground: it hangs upside down in the air.
//   hang    hovering in place: a slow bob and pendulum sway, shallow breaths, the head lolling and then snapping
//           to the target, fingers curling one at a time; hair and shroud hang under gravity and drift.
//   drift   glides toward the target (or straight ahead), leaning into the motion, arms trailing, hair streaming
//           back; small stutters, as if pulled on a string.
//   scream  the jaw drops impossibly wide, the head shakes, the body jerks back, arms flung wide with fingers splayed,
//           hair and shroud whipped out.
//   lunge   lurches at the target, both arms reaching, claws spread, jaw open; stops ~1.5 m short.
//   freeze  nothing moves.
// The head looks at `target` in every mode (it's upside down, so a turn is about world up).

export type BansheeMode = "hang" | "drift" | "scream" | "lunge" | "freeze"
type Upd = { mode: BansheeMode; target?: THREE.Vector3; velocity?: THREE.Vector3 }

const DRIFT_SPEED = 0.9
/** Forward tip of the whole body about the hips (rad). */
export const TIP = -0.5
const LUNGE_SPEED = 5
const _v = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _p = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _q2 = new THREE.Quaternion()
const _q3 = new THREE.Quaternion()
const _e = new THREE.Euler()
const _fwd = new THREE.Vector3()
const _side = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)
const _down = new THREE.Vector3(0, -1, 0)

export class BansheeAnimator {
  time = 0
  mode: BansheeMode = "hang"
  modeTime = 0
  sway: { value: number }[] = []
  private b: Record<string, number> = {}
  private vel = new THREE.Vector3()
  private selfVel = new THREE.Vector3()
  /** Trailing velocity for hair and cloth (they lag the body). */
  private lag = new THREE.Vector3()
  private scream = new Spring(0, 9)
  private reach = new Spring(0, 10)
  private lean = new Spring(0, 3)
  private jaw = new Spring(0.4, 12)
  private lookYaw = new Spring(0, 4)
  private lookPitch = new Spring(0, 4)
  private snap = { yaw: new Spring(0, 30), roll: new Spring(0, 30), tYaw: 0, tRoll: 0, next: 1.5, hold: 0 }
  private curl = new Float32Array(10)
  private curlNext = 0.5
  private rng: () => number
  private initialised = false

  constructor(
    public rig: CreatureRig,
    public root: THREE.Object3D,
    seed = 3,
  ) {
    rig.bones.forEach((bn, i) => (this.b[bn.name] = i))
    let s = seed * 9301 + 49297
    this.rng = () => ((s = (s * 9301 + 49297) % 233280) / 233280)
  }

  private bone(n: string) {
    return this.rig.bones[this.b[n]!]!
  }
  private rot(n: string, x: number, y: number, z: number) {
    this.bone(n).quaternion.multiply(_q.setFromEuler(_e.set(x, y, z, "YXZ")))
  }
  private rotWorld(n: string, axis: THREE.Vector3, angle: number) {
    const bn = this.bone(n)
    bn.parent!.updateMatrixWorld(true)
    worldQuat(bn.parent!, _q2)
    _q3.copy(_q2).invert().multiply(_q.setFromAxisAngle(axis, angle)).multiply(_q2)
    bn.quaternion.premultiply(_q3)
    bn.updateMatrixWorld(true)
  }

  update(dt: number, u: Upd) {
    if (u.mode !== this.mode) {
      this.mode = u.mode
      this.modeTime = 0
    }
    if (u.mode === "freeze" && this.initialised) return
    this.initialised = true
    dt = Math.min(dt, 1 / 20)
    this.time += dt
    this.modeTime += dt
    const mode = u.mode === "freeze" ? "hang" : u.mode
    const t = this.time
    const mt = this.modeTime
    const rig = this.rig
    const root = this.root
    const scale = rig.root.scale.x
    for (const s of this.sway) s.value += dt * (mode === "scream" ? 3.5 : mode === "drift" || mode === "lunge" ? 1.6 : 1)

    // ------------------------------------------------------------ locomotion
    _fwd.set(0, 0, 1).applyQuaternion(root.quaternion)
    if (u.velocity) this.vel.copy(u.velocity)
    else {
      let speed = 0
      if (mode === "drift") speed = DRIFT_SPEED * scale * (0.55 + 0.45 * Math.max(0, Math.sin(t * 2.3)) + (Math.sin(t * 7.1) > 0.92 ? 0.8 : 0))
      if (mode === "lunge") speed = mt > 0.15 && mt < 0.6 ? LUNGE_SPEED * scale : 0
      if (u.target) {
        _v.subVectors(u.target, root.position).setY(0)
        const dist = _v.length()
        const want = Math.atan2(_v.x, _v.z)
        const have = Math.atan2(_fwd.x, _fwd.z)
        const d = Math.atan2(Math.sin(want - have), Math.cos(want - have))
        const rate = mode === "drift" ? 0.8 : mode === "lunge" ? (mt < 0.15 ? 8 : 0) : 0.3
        root.rotateY(Math.sign(d) * Math.min(Math.abs(d), rate * dt))
        _fwd.set(0, 0, 1).applyQuaternion(root.quaternion)
        if (dist < (mode === "lunge" ? 1.5 : 2.2) * scale) speed = 0
      }
      _v.copy(_fwd).multiplyScalar(speed)
      this.selfVel.lerp(_v, Math.min(1, dt * (mode === "lunge" ? 14 : 2.5)))
      this.vel.copy(this.selfVel)
      root.position.addScaledVector(this.vel, dt)
    }
    this.lag.lerp(this.vel, Math.min(1, dt * 1.5))
    root.updateMatrixWorld(true)

    // ------------------------------------------------------------ posture parameters
    const scream = this.scream.step(mode === "scream" ? 1 : 0, dt)
    const reach = this.reach.step(mode === "lunge" && mt > 0.08 ? 1 : 0, dt)
    const speedF = Math.min(1, this.vel.length() / (DRIFT_SPEED * scale))
    const lean = this.lean.step(speedF * 0.25 + (mode === "lunge" && mt < 0.7 ? 0.35 : 0), dt)
    const jaw = this.jaw.step(mode === "scream" ? 1 + 0.12 * Math.sin(t * 31) : mode === "lunge" ? 0.85 : 0.35 + 0.12 * Math.sin(t * 0.8), dt)

    for (let i = 0; i < rig.bones.length; i++) {
      const bn = rig.bones[i]!
      bn.position.copy(rig.rest[i]!)
      bn.quaternion.identity()
      bn.scale.set(1, 1, 1)
    }
    // Hover: slow bob, pendulum sway; the scream jerks the body back.
    const bob = Math.sin(t * 0.7) * 0.05 + Math.sin(t * 1.9) * 0.012
    const hips = this.bone("hips")
    hips.position.y += bob + scream * 0.08
    hips.position.z += -scream * 0.08
    const swayX = Math.sin(t * 0.53) * 0.04 + Math.sin(t * 1.31) * 0.015
    const swayZ = Math.sin(t * 0.41 + 1) * 0.03
    // Base posture: the body tips forward so the back runs diagonally down toward the viewer (concept), the head
    // hanging out in front; the hips pivot is above, so the shroud's peak stays high and back.
    this.rot("hips", TIP + lean - scream * 0.2, swayZ, swayX)
    // Keep it centred over its spot and its hair tips just above the ground once tipped.
    hips.position.z -= 0.25
    hips.position.y -= 0.3
    const breath = Math.sin(t * (mode === "scream" ? 9 : 1.1))
    for (const [i, n] of ["spine1", "spine2", "spine3"].entries()) this.rot(n, (lean * 0.25 - scream * 0.12) * (i + 1) * 0.5 + breath * 0.01, swayZ * 0.5, -swayX * 0.6)
    this.bone("ribs").scale.set(1 + breath * 0.03, 1 + breath * 0.02, 1 + breath * 0.03)

    // ------------------------------------------------------------ head
    this.updateSnaps(dt, mode)
    let yaw = 0
    let pitch = 0
    if (u.target) {
      rig.root.updateMatrixWorld(true)
      this.bone("head").getWorldPosition(_p)
      _v.copy(u.target).sub(_p)
      _q.copy(root.quaternion).invert()
      _v.applyQuaternion(_q)
      yaw = THREE.MathUtils.clamp(Math.atan2(_v.x, _v.z), -1.2, 1.2)
      pitch = THREE.MathUtils.clamp(Math.atan2(_v.y, Math.hypot(_v.x, _v.z)), -0.6, 0.6)
    }
    const ly = this.lookYaw.step(yaw, dt, mode === "lunge" || mode === "scream" ? 12 : 3.5)
    const lp = this.lookPitch.step(pitch, dt, 3.5)
    const shake = scream * (Math.sin(t * 37) * 0.06 + Math.sin(t * 23) * 0.04)
    this.rot("neck1", -scream * 0.15, 0, 0)
    this.rot("neck2", -scream * 0.1, 0, 0)
    this.rot("head", -lp * 0.6 - TIP * 0.7, 0, Math.sin(t * 0.33) * 0.12 + this.snap.roll.x + shake)
    _v.set(0, 1, 0)
    this.rotWorld("neck2", _v, ly * 0.4)
    this.rotWorld("head", _v, ly * 0.6 + this.snap.yaw.x + shake * 0.5)
    // Jaw opens up and forward (the face is upside down).
    this.rot("jaw", -jaw * 0.5, 0, 0)
    rig.root.updateMatrixWorld(true)

    // ------------------------------------------------------------ arms
    _side.set(1, 0, 0).applyQuaternion(root.quaternion)
    for (const [k, n] of ["L", "R"].entries()) {
      const s = k === 0 ? 1 : -1
      const ph = t * 0.9 + k * 1.7
      // Hang: elbows splayed, hands drifting; trail back when drifting.
      const trail = speedF * 0.35
      const hang = (x: number, y: number, z: number) => _v.set(s * x, y, z - trail).normalize().applyQuaternion(root.quaternion)
      const spread = (x: number, y: number, z: number) => _v2.set(s * x, y, z).normalize().applyQuaternion(root.quaternion)
      const pose = (h: THREE.Vector3, sp: THREE.Vector3, reachDir: THREE.Vector3) => h.lerp(sp, scream).lerp(reachDir, reach).normalize()
      const rf = (x: number, y: number) => _p.copy(_fwd).addScaledVector(_side, s * x).addScaledVector(_up, y).normalize()
      aimBone(rig, this.b[`uarm${n}`]!, pose(hang(0.85 + Math.sin(ph) * 0.06, -0.75, 0.45), spread(1, 0.25, 0.2), rf(0.25, 0.15)))
      aimBone(rig, this.b[`farm${n}`]!, pose(hang(0.12 + Math.sin(ph + 1) * 0.05, -1, 0.4 + Math.sin(ph * 0.7) * 0.1), spread(0.9, -0.2, 0.5), rf(0.08, 0.05)))
      aimBone(rig, this.b[`hand${n}`]!, pose(hang(0, -1, 0.15), spread(0.6, -0.5, 0.6), rf(0, -0.1)))
      // Fingers: curl at rest (one at a time), splay when screaming or reaching.
      const splay = Math.max(scream, reach)
      for (let f = 0; f < 4; f++) {
        for (let j = 0; j < 3; j++) {
          const bi = this.b[`f${f}${n}${j}`]!
          // Curl about the hand's lateral axis (bind frame x): positive curls the claws forward and in.
          const amt = (0.08 + this.curl[k * 5 + f]! * 0.5) * (1 - splay) - splay * 0.15
          this.rig.bones[bi]!.quaternion.multiply(_q.setFromAxisAngle(_v2.set(1, 0, 0), -amt * (j === 0 ? 0.5 : 1)))
        }
      }
    }
    rig.root.updateMatrixWorld(true)

    // ------------------------------------------------------------ hair and shroud: hang under gravity, trail motion
    const gust = scream * 0.6
    const trailV = _p.copy(this.lag).multiplyScalar(-0.35)
    const hangDir = (i: number, amp: number) =>
      _v
        .copy(_down)
        .add(trailV)
        .addScaledVector(_side, (Math.sin(t * 0.8 + i * 0.9) * 0.05 + Math.sin(t * 13 + i) * gust * 0.15) * amp)
        .addScaledVector(_fwd, (Math.sin(t * 0.6 + i * 1.3) * 0.04 - gust * 0.25) * amp)
        .normalize()
    for (const [i, n] of ["hair1", "hair2", "hair3"].entries()) aimBone(rig, this.b[n]!, hangDir(i, 1 + i * 0.6))
    // The upper shroud links ride the body (they drape over the arched back); the lower links hang free.
    for (const [i, n] of ["clothB2", "clothL2", "clothR2"].entries()) {
      const bi = this.b[n]!
      // Keep each panel's rest lean, then add gravity, trailing and gusts.
      _v2.copy(rig.dir[bi]!)
      _v2.y = 0
      aimBone(rig, bi, hangDir(i + 3, 1.6).addScaledVector(_v2.applyQuaternion(root.quaternion), 1).normalize())
    }
  }

  private updateSnaps(dt: number, mode: BansheeMode) {
    const s = this.snap
    const r = this.rng
    s.next -= dt
    s.hold -= dt
    if (s.next <= 0 && (mode === "hang" || mode === "drift")) {
      s.tYaw = (r() - 0.5) * 0.8
      s.tRoll = (r() - 0.5) * 1.2
      s.hold = 0.2 + r() * 0.9
      s.next = s.hold + 1 + r() * 3.5
    }
    const back = s.hold <= 0
    s.yaw.step(back ? 0 : s.tYaw, dt, back ? 2.5 : 40)
    s.roll.step(back ? 0 : s.tRoll, dt, back ? 2.5 : 40)
    this.curlNext -= dt
    if (this.curlNext <= 0) {
      this.curlNext = 0.25 + r() * 1.2
      this.curl[Math.floor(r() * 10)] = r()
    }
    for (let i = 0; i < 10; i++) this.curl[i]! *= Math.exp(-dt * 0.8)
  }
}
