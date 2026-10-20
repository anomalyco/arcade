import * as THREE from "three/webgpu"
import { Stepper } from "../kit/gait"
import { Spring, aimBone, smooth01, twoBoneIK, worldQuat } from "../kit/ik"
import type { CreatureRig } from "../kit/runtime"
import { limbPoints } from "./anatomy"

// Procedural motion for the Wendigo. Everything is computed from the bind pose each frame:
//   stalk   a lateral-sequence quadruped walk (LH, LF, RH, RF) on planted feet: each leg snatches up high, hangs and
//           stabs down, then the body surges and holds — a slow, jerky, insect cadence. Shoulder blades pump, the
//           spine rolls toward the planted side, the head hangs low and keeps the target.
//   idle    standing on all fours: breathing ribs and belly, slow head tilt, sudden head snaps, fingers that flex.
//   freeze  nothing moves at all, mid-step included.
//   lunge   a crouch, then a jerky burst forward with the forelimbs thrown out reaching and the jaw wide.
//   rear    rises onto the hind legs to its full ~3.5 m, arms spread wide, fingers splayed, jaw open, trembling,
//           then returns to the stance it had.
//   stalk-upright  walks on its backward-bent hind legs, ~3.3 m to the antler tips, hunched forward with the head
//           hung low; each leg snatches high and stabs down with a hitch between steps, and the long arms hang past
//           the knees, swinging slowly against the stride.
//   rise / drop  smooth transitions from all fours up to the upright stance and back down; the forefeet peel off
//           the ground (or reach down and plant) as the torso pivots about the hips.
// Stance: `stance` ("quad" | "biped") picks the posture for idle, stalk, freeze and lunge. Omit it to keep the
// current stance; rise, stalk-upright and drop change it. The head always looks at `target`, within the neck's reach.

export type WendigoMode = "idle" | "stalk" | "freeze" | "lunge" | "rear" | "stalk-upright" | "rise" | "drop"
export type WendigoStance = "quad" | "biped"

/** `ceiling`: world Y of the ceiling over it (indoors). It stoops / crouches so its antlers stay under it. */
type Upd = { mode: WendigoMode; stance?: WendigoStance; target?: THREE.Vector3; velocity?: THREE.Vector3; ceiling?: number }

const STALK_SPEED = 0.55
/**
 * The upright stance, in numbers (radians / metres). Measured targets (creature frame, upright walk): hips 1.6–1.8 m,
 * torso leaning 20–35° from vertical, shoulders ~2.6 m, skull hanging forward of the chest at 2.8–3 m, hands near the
 * knees and outside the legs.
 */
export const BIPED = {
  /** Hip lift above the bind pose (m). */
  hipLift: 0.39,
  /** Torso pitch up about the hips (rad; the bind torso is level). */
  pitch: 1.18,
  /** Extra forward curl of the upper back (rad, spine3 and spine4 each). */
  hunch: 0.12,
  /** Neck pitch per neck bone (rad; negative lifts). */
  neck: -0.03,
  /** Head pitch (rad; positive hangs the snout down). */
  head: 0.16,
  /** Hind feet: lateral squeeze and forward shift of their homes (m). */
  footX: 0.85,
  footZ: 0.3,
  /** How far the hock rakes back behind the ball of the foot (m). */
  hockBack: 0.08,
  /** Arm hang directions (creature frame, before swing): splay out, forward. */
  armOut: 0.3,
  armFwd: 0.12,
}
/** The stoop under a low ceiling, added to BIPED at `stoop` = 1 (fits the antlers under ~2.9 m). */
export const STOOP = { hipDrop: 0.3, lean: 0.3, hunch: 0.15, neck: 0.25, head: 0.8 }
const UPRIGHT_SPEED = 0.62
const LUNGE_SPEED = 5.5
const _v = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _t = new THREE.Vector3()
const _p = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _q2 = new THREE.Quaternion()
const _q3 = new THREE.Quaternion()
const _e = new THREE.Euler()
const _m4 = new THREE.Matrix4()
const _fwd = new THREE.Vector3()
const _side = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)

export class WendigoAnimator {
  time = 0
  mode: WendigoMode = "idle"
  modeTime = 0
  private b: Record<string, number> = {}
  private stepper: Stepper
  private vel = new THREE.Vector3()
  private selfVel = new THREE.Vector3()
  private rear = new Spring(0, 3.2)
  /** 0 on all fours, 1 upright. */
  private up = new Spring(0, 2.4)
  private armSwing = new Spring(0, 2.6)
  private armTarget = 0
  private bipedGait = false
  private homes: THREE.Vector3[] = []
  /** Current stance (changes when a rise or drop completes, or when `stance` is passed). */
  stance: WendigoStance = "quad"
  private crouch = new Spring(0, 7)
  private reach = new Spring(0, 14)
  private jaw = new Spring(0.12, 10)
  private bodyLow = new Spring(0, 6)
  private lookYaw = new Spring(0, 5)
  private lookPitch = new Spring(0, 5)
  private snap = { yaw: new Spring(0, 30), pitch: new Spring(0, 30), roll: new Spring(0, 30), tYaw: 0, tPitch: 0, tRoll: 0, next: 2, hold: 0 }
  private fingerTwitch = new Float32Array(10)
  private fingerTarget = new Float32Array(10)
  private yawRate = 0
  /** Follow-through: low-passed local rotations of the body, neck and head bones (and the hips position). */
  private smoothQ = new Map<number, THREE.Quaternion>()
  private smoothHip = new THREE.Vector3()
  private smoothInit = false
  private fingerNext = 1
  private rng: () => number
  private initialised = false
  /** 0..1: stoop under a low ceiling while upright (a 2.9 m room fits at 1). */
  stoop = 0
  /** Stoop the ceiling asks for (0..1.4), eased; the pose uses max(stoop, ceilStoop). */
  private ceilStoop = new Spring(0, 7)
  private ceilWant = 0
  /** Antler extremities in the head bone's frame (tips: what meets a ceiling first). */
  private antlerPts: Float32Array | null = null
  /** Highest antler point last frame, metres above the root (automation / tuning). */
  antlerTop = 0
  /** How close the lunge brings the skull to its target (m). 3 stops short; a kill goes into the lens. */
  lungeStop = 3
  /** The material's sway clock (tendrils); frozen with the creature. */
  sway: { value: number } | null = null
  private frontIK: { uarm: number; farm: number; hand: number; f: number[][]; side: number }[] = []
  private hindIK: { thigh: number; shin: number; meta: number; t: number[][]; side: number }[] = []

  constructor(
    public rig: CreatureRig,
    public root: THREE.Object3D,
    public ground: (x: number, z: number) => number,
    seed = 1,
  ) {
    rig.bones.forEach((bn, i) => (this.b[bn.name] = i))
    let s = seed * 9301 + 49297
    this.rng = () => ((s = (s * 9301 + 49297) % 233280) / 233280)
    for (const [side, n] of [
      [1, "L"],
      [-1, "R"],
    ] as const) {
      this.frontIK.push({ uarm: this.b[`uarm${n}`]!, farm: this.b[`farm${n}`]!, hand: this.b[`hand${n}`]!, f: [0, 1, 2, 3].map((f) => [0, 1, 2, 3].map((j) => this.b[`f${f}${n}${j}`]!)), side })
      this.hindIK.push({ thigh: this.b[`thigh${n}`]!, shin: this.b[`shin${n}`]!, meta: this.b[`meta${n}`]!, t: [0, 1, 2, 3].map((f) => [0, 1, 2].map((j) => this.b[`t${f}${n}${j}`]!)), side })
    }
    const L = limbPoints(1)
    const R = limbPoints(-1)
    // Legs: 0 LF, 1 RF, 2 LH, 3 RH. Homes are the knuckle / ball joints projected to the ground.
    this.stepper = new Stepper(
      [
        { home: new THREE.Vector3(L.M[0], 0, L.M[2]), lift: 0.3 },
        { home: new THREE.Vector3(R.M[0], 0, R.M[2]), lift: 0.3 },
        { home: new THREE.Vector3(L.F[0], 0, L.F[2]), lift: 0.22 },
        { home: new THREE.Vector3(R.F[0], 0, R.F[2]), lift: 0.22 },
      ],
      [2, 0, 3, 1],
      ground,
    )
    this.homes = this.stepper.legs.map((l) => l.spec.home.clone())
    this.stepper.stride = 1.05
    this.stepper.stepTime = 0.7
    this.stepper.pause = 0
  }

  private bone(n: string) {
    return this.rig.bones[this.b[n]!]!
  }

  /** Rotate a bone about a world axis (keeps a look-at yaw a yaw however the torso is pitched). */
  private rotWorld(n: string, axis: THREE.Vector3, angle: number) {
    const bn = this.bone(n)
    bn.parent!.updateMatrixWorld(true)
    worldQuat(bn.parent!, _q2)
    _q3.copy(_q2).invert().multiply(_q.setFromAxisAngle(axis, angle)).multiply(_q2)
    bn.quaternion.premultiply(_q3)
    bn.updateMatrixWorld(true)
  }

  private rot(n: string, x: number, y: number, z: number) {
    const bn = this.bone(n)
    bn.quaternion.multiply(_q.setFromEuler(_e.set(x, y, z, "YXZ")))
  }

  update(dt: number, u: Upd) {
    if (u.mode !== this.mode) {
      this.mode = u.mode
      this.modeTime = 0
    }
    if (u.stance && u.mode !== "rise" && u.mode !== "drop" && u.mode !== "stalk-upright") this.stance = u.stance
    if (u.mode === "rise" || u.mode === "stalk-upright") this.stance = "biped"
    if (u.mode === "drop") this.stance = "quad"
    // Freeze: not a muscle, not a breath.
    if (u.mode === "freeze" && this.initialised) return
    dt = Math.min(dt, 1 / 20)
    this.time += dt
    if (this.sway) this.sway.value += dt * (u.mode === "lunge" ? 2.2 : u.mode === "stalk" || u.mode === "stalk-upright" ? 1.3 : 1)
    this.modeTime += dt
    const t = this.time
    const raw = u.mode === "freeze" ? "idle" : u.mode
    // Biped stalking is stalk in the upright stance; rise and drop idle while the posture changes.
    const mode: WendigoMode = raw === "stalk-upright" ? "stalk" : raw === "rise" || raw === "drop" ? "idle" : raw
    const root = this.root
    const rig = this.rig
    const scale = rig.root.scale.x
    if (!this.initialised) {
      this.stepper.reset(root)
      this.initialised = true
    }

    // ------------------------------------------------------------ locomotion
    _fwd.set(0, 0, 1).applyQuaternion(root.quaternion)
    let lungeT = mode === "lunge" ? this.modeTime : 99
    if (u.velocity) this.vel.copy(u.velocity)
    else {
      let target = 0
      if (mode === "stalk") {
        // A steady, gliding pace: the body never surges or stops between steps.
        target = (this.bipedGait ? UPRIGHT_SPEED : STALK_SPEED) * scale
      } else if (mode === "lunge") {
        target = lungeT > 0.2 && lungeT < 0.7 ? LUNGE_SPEED * scale : 0
      }
      // Turn toward the target while stalking or idling.
      if (u.target && mode !== "rear") {
        _v.subVectors(u.target, root.position)
        const want = Math.atan2(_v.x, _v.z)
        const have = Math.atan2(_fwd.x, _fwd.z)
        let d = want - have
        d = Math.atan2(Math.sin(d), Math.cos(d))
        // Turn rate eases in and out (no step changes in angular velocity).
        const max = mode === "stalk" ? 0.5 : mode === "lunge" ? (lungeT < 0.25 ? 2.5 : 0) : Math.abs(d) > 0.6 ? 0.35 : 0
        const wantRate = THREE.MathUtils.clamp(d * 1.5, -max, max)
        this.yawRate += (wantRate - this.yawRate) * Math.min(1, dt * 4)
        root.rotateY(this.yawRate * dt)
        _fwd.set(0, 0, 1).applyQuaternion(root.quaternion)
        if (u.target && mode === "stalk" && _v.setY(0).length() < 5.5 * scale) target = 0
        // The lunge pulls up short with the skull ~3 m from the target, braking ahead of time so it lands there.
        if (u.target && mode === "lunge") {
          this.bone("head").getWorldPosition(_p)
          const skullDist = Math.hypot(u.target.x - _p.x, u.target.z - _p.z)
          const brake = Math.max(0, skullDist - this.lungeStop * scale) / (0.25 * LUNGE_SPEED * scale)
          target *= Math.min(1, brake)
        }
      }
      const k = mode === "lunge" ? 6 : 2.2
      _v.copy(_fwd).multiplyScalar(target)
      this.selfVel.lerp(_v, Math.min(1, dt * k))
      this.vel.copy(this.selfVel)
      root.position.addScaledVector(this.vel, dt)
    }
    if (u.velocity && this.vel.lengthSq() > 0.01) {
      const want = Math.atan2(this.vel.x, this.vel.z)
      const have = Math.atan2(_fwd.x, _fwd.z)
      const d = Math.atan2(Math.sin(want - have), Math.cos(want - have))
      root.rotateY(Math.sign(d) * Math.min(Math.abs(d), 1.5 * dt))
    }
    root.position.y = this.ground(root.position.x, root.position.z)
    root.updateMatrixWorld(true)

    // ------------------------------------------------------------ stance and gait
    const upTarget = mode === "rear" || this.stance === "biped" ? 1 : 0
    const upX = this.up.step(upTarget, dt, raw === "rise" || raw === "drop" ? 2.2 : 2.8)
    const up = THREE.MathUtils.clamp(upX, 0, 1)
    const wantBiped = this.bipedGait ? up > 0.45 : up > 0.6
    if (wantBiped !== this.bipedGait) this.setGait(wantBiped, root)

    // Upright, the forefeet's IK targets glide along with the body at their home spots, so the IK half of the arm
    // blend is continuous and there's nothing to snap back to when it drops onto all fours.
    if (this.bipedGait) {
      for (let i = 0; i < 2; i++) {
        const l = this.stepper.legs[i]!
        this.stepper.homeWorld(i, root, _v.set(0, 0, 0), 0, l.planted)
        l.foot.copy(l.planted)
        l.swing = -1
      }
    }
    const urgency = mode === "lunge" ? 1 : 0
    this.stepper.update(dt, root, this.vel, urgency)

    // ------------------------------------------------------------ posture parameters
    // Rear: the arms-spread scare pose on top of the upright stance.
    const rear = this.rear.step(mode === "rear" ? 1 : 0, dt)
    const crouchTarget = mode === "lunge" ? (lungeT < 0.2 ? 1 : lungeT < 0.62 ? 0.2 : 0.7) : mode === "stalk" ? 0.35 : 0
    const crouch = this.crouch.step(crouchTarget, dt, mode === "lunge" ? 9 : 4)
    const reach = this.reach.step(mode === "lunge" && lungeT > 0.1 && lungeT < 0.9 ? 1 : 0, dt, 6)
    const jaw = this.jaw.step(mode === "rear" ? 0.75 + 0.05 * Math.sin(t * 9) : mode === "lunge" ? (lungeT > 0.15 ? 0.85 : 0.3) : 0.1 + 0.06 * Math.max(0, Math.sin(t * 0.7)), dt)
    const low = this.bodyLow.step(crouch, dt)

    // ------------------------------------------------------------ reset and body
    for (let i = 0; i < rig.bones.length; i++) {
      const bn = rig.bones[i]!
      bn.position.copy(rig.rest[i]!)
      bn.quaternion.identity()
      bn.scale.set(1, 1, 1)
    }
    const legs = this.stepper.legs
    // Body height follows the feet's ground; pitch follows front vs hind ground.
    const gF = (legs[0]!.planted.y + legs[1]!.planted.y) / 2 - root.position.y
    const gH = (legs[2]!.planted.y + legs[3]!.planted.y) / 2 - root.position.y
    const pitchG = Math.atan2(gF - gH, 1.05 * scale)
    const breath = Math.sin(t * 1.25) * (mode === "stalk" ? 0.6 : 1)
    // Weight shift, continuous with the legs' swing phases: the body rolls away from the lifted side.
    const ph = (l: (typeof legs)[number]) => (l.swing >= 0 ? Math.sin(Math.PI * l.swing) : 0)
    const sway = (ph(legs[2]!) + ph(legs[0]!) * 0.6 - ph(legs[3]!) - ph(legs[1]!) * 0.6) * 0.03 * (1 + up * 1.2)
    // Upright: the arms swing against the stride (slowly, lagging the legs).
    this.armTarget = ph(legs[2]!) - ph(legs[3]!)
    const arm = this.armSwing.step(this.bipedGait && mode === "stalk" ? this.armTarget : this.armTarget * 0.25, dt)
    const St = Math.max(this.stoop, this.ceilStoop.step(this.ceilWant, dt, this.ceilWant > this.ceilStoop.x ? 12 : 3))
    const hips = this.bone("hips")
    const gY = (gF * (1 - up) + gH * (1 + up)) / 2
    hips.position.y += -(1 - up) * St * 0.12 + gY / scale - low * 0.22 * (1 - up * 0.7) + up * (BIPED.hipLift - St * STOOP.hipDrop) - rear * 0.06 + breath * 0.006
    hips.position.z += -up * 0.02 - rear * 0.05 + (mode === "lunge" && lungeT < 0.2 ? -0.08 * smooth01(lungeT / 0.2) : 0)
    hips.position.x += sway * 0.5
    // Standing pivots the whole body up about the hips: hunched when upright, nearly vertical when rearing.
    this.rot("hips", -up * (BIPED.pitch - St * STOOP.lean) - rear * 0.25 - pitchG * (1 - up) - reach * 0.12, sway * 0.5 * (1 + up), sway * 2)
    for (const [i, n] of ["spine1", "spine2", "spine3", "spine4"].entries()) {
      // Upright: the upper back curls forward into a hunch.
      const hunch = up * (1 - rear) * (i < 2 ? -0.02 : BIPED.hunch + St * STOOP.hunch)
      this.rot(n, -rear * 0.07 + hunch + (i < 2 ? 1 : -1) * low * 0.06 + breath * 0.008, -sway * (i - 1.5) * 0.6, sway * 0.8)
    }
    // Ribs heave; belly sucks in on the in-breath.
    const ribs = this.bone("ribs")
    ribs.scale.set(1 + breath * 0.035, 1 + breath * 0.025, 1 + breath * 0.02)
    this.bone("belly").scale.set(1 - breath * 0.05, 1 - breath * 0.03, 1)
    // Shoulder blades pump with the forelimbs.
    for (const [k, n] of ["scapL", "scapR"].entries()) {
      const l = legs[k]!
      const push = l.swing >= 0 ? Math.sin(Math.PI * l.swing) : 0
      const sc = this.bone(n)
      sc.position.y += (0.03 * push - 0.02 * low) * (1 - up) + 0.04 * rear + 0.02 * up
    }
    // Tail strings swing with the body.
    this.rot("tail1", 0.2 * rear + 0.5 * up + Math.sin(t * 1.3) * 0.05, sway * 3 + Math.sin(t * 0.9) * 0.08, 0)
    this.rot("tail2", Math.sin(t * 1.7 + 1) * 0.08, Math.sin(t * 1.1) * 0.1, 0)

    // ------------------------------------------------------------ neck, head, look-at
    this.updateSnaps(dt, mode)
    let yaw = 0
    let pitch = 0
    if (u.target) {
      rig.root.updateMatrixWorld(true)
      this.bone("neck1").getWorldPosition(_p)
      _v.copy(u.target).sub(_p)
      // Into the root frame.
      _q.copy(root.quaternion).invert()
      _v.applyQuaternion(_q)
      yaw = THREE.MathUtils.clamp(Math.atan2(_v.x, _v.z), -1.5, 1.5)
      pitch = THREE.MathUtils.clamp(Math.atan2(_v.y + 0.5, Math.hypot(_v.x, _v.z)), -0.7, 0.9)
    }
    const ly = this.lookYaw.step(yaw, dt, mode === "lunge" ? 14 : 4)
    const lp = this.lookPitch.step(pitch, dt, mode === "lunge" ? 14 : 4)
    // Upright, the neck still juts forward and the skull hangs: it bends down to cancel most of the torso's pitch.
    // On all fours the stoop drops the head and neck and sinks the forequarters.
    const neckLift = up * (BIPED.neck + St * STOOP.neck) - (1 - up) * St * 0.3 + rear * 0.18 - low * 0.12
    const share = [0.25, 0.3, 0.25]
    for (const [i, n] of ["neck1", "neck2", "neck3"].entries()) {
      this.rot(n, -lp * share[i]! * 0.8 + neckLift + Math.sin(t * 0.4 + i) * 0.015, 0, Math.sin(t * 0.31) * 0.05 * (i + 1) * (mode === "idle" ? 1 : 0.4))
    }
    // Yaw about the world up axis, after the pitches, so it stays a turn of the head whatever the stance.
    _v.set(0, 1, 0)
    for (const [i, n] of ["neck1", "neck2", "neck3"].entries()) this.rotWorld(n, _v, ly * share[i]!)
    const tilt = mode === "idle" ? Math.sin(t * 0.37) * 0.22 : Math.sin(t * 0.5) * 0.06
    this.rot("head", -lp * 0.2 + this.snap.pitch.x - rear * 0.1 - reach * 0.2 + up * (BIPED.head + St * STOOP.head) + (1 - up) * St * 0.35, 0, tilt + this.snap.roll.x)
    this.rotWorld("head", _v.set(0, 1, 0), ly * 0.2 + this.snap.yaw.x)
    this.rot("jaw", jaw * 0.55, 0, Math.sin(t * 13) * 0.01 * jaw)

    // Follow-through: each body bone eases toward its pose; the neck lags the spine and the head (with its antlers)
    // lags the neck, so turns and mode changes cross-fade over ~0.3–0.6 s instead of snapping.
    this.followThrough(dt)
    this.fitCeiling(u.ceiling, root)
    rig.root.updateMatrixWorld(true)

    // ------------------------------------------------------------ legs
    _side.set(1, 0, 0).applyQuaternion(root.quaternion)
    // Hind: hock bends backward, knee forward. The metatarsus stays near vertical, raking back as the foot lifts.
    for (const [k, h] of this.hindIK.entries()) {
      const l = legs[2 + k]!
      const sw = l.swing >= 0 ? Math.sin(Math.PI * l.swing) : 0
      _t.copy(l.foot).addScaledVector(_up, 0.07 * scale)
      // Hock target: above the ball, tilted back.
      // Upright the hock rakes further back, and further still as the leg snatches up (the high, wrong-way step).
      const back = Math.max(0, 0.24 + 0.12 * sw - up * (0.24 - BIPED.hockBack - 0.1 * sw) + rear * 0.03)
      const mlen = rig.length[h.meta]!
      _v.copy(_up).multiplyScalar(Math.sqrt(Math.max(0.01, mlen * mlen - back * back)) * scale).addScaledVector(_fwd, -back * scale)
      _p.copy(_t).add(_v)
      _v2.copy(_fwd).addScaledVector(_side, h.side * 0.15)
      twoBoneIK(rig, h.thigh, h.shin, _p, _v2)
      aimBone(rig, h.meta, _v.subVectors(_t, rig.bones[h.meta]!.getWorldPosition(_v2)))
      // Toes lie along the ground however steep the metatarsus stands (they curl from there).
      for (const chain of h.t) aimBone(rig, chain[0]!, _v.copy(rig.dir[chain[0]!]!).applyQuaternion(root.quaternion))
      this.curlDigits(h.t, sw * (0.9 + up * 0.5) + rear * 0.1, sw)
    }
    // Fore: elbow points back. Hand (metacarpus) leans forward over the fingers.
    for (const [k, f] of this.frontIK.entries()) {
      const l = legs[k]!
      const sw = l.swing >= 0 ? Math.sin(Math.PI * l.swing) : 0
      const fk = Math.max(up, reach)
      // Solve the planted forefoot, then blend toward the FK arm pose (hang, spread or reach) by `fk`.
      _t.copy(l.foot).addScaledVector(_up, 0.07 * scale)
      _v.copy(_up).multiplyScalar(0.34 * scale).addScaledVector(_fwd, (-0.1 - 0.15 * sw) * scale)
      _p.copy(_t).add(_v)
      _v2.copy(_fwd).multiplyScalar(-1).addScaledVector(_side, f.side * 0.25).addScaledVector(_up, 0.2)
      if (fk < 0.999) {
        twoBoneIK(rig, f.uarm, f.farm, _p, _v2)
        aimBone(rig, f.hand, _v.subVectors(_t, rig.bones[f.hand]!.getWorldPosition(_v2)))
      }
      if (fk > 0.001) {
        const s = f.side
        const tremble = Math.sin(t * 11 + s) * 0.02 * rear + Math.sin(t * 2.3 + s * 2) * 0.012 * up
        // Hang: arms dangle past the knees, swinging slowly against the stride (left arm with the right leg).
        const a = -arm * s
        const wReach = reach
        const wSpread = rear * (1 - reach)
        const wHang = Math.max(0, up - rear) * (1 - reach) + 1e-4
        const pose = (hang: [number, number, number], spread: [number, number, number], fwdUp: number, fwdSide: number) => {
          _v.set(hang[0], hang[1], hang[2]).normalize().multiplyScalar(wHang)
          _v2.set(spread[0], spread[1] + tremble, spread[2]).normalize()
          _v.addScaledVector(_v2, wSpread)
          _v.applyQuaternion(root.quaternion)
          _v2.copy(_fwd).addScaledVector(_up, fwdUp).addScaledVector(_side, s * fwdSide).normalize()
          return _v.addScaledVector(_v2, wReach).normalize()
        }
        aimBone(rig, f.uarm, pose([s * BIPED.armOut, -1, BIPED.armFwd + 0.1 + 0.25 * a], [s * 0.85, 0.45, 0.3], 0.25, 0.25), fk)
        aimBone(rig, f.farm, pose([s * BIPED.armOut * 0.45, -1, BIPED.armFwd + 0.05 + 0.3 * a], [s * 0.7, 0.05, 0.75], 0.1, 0.1), fk)
        aimBone(rig, f.hand, pose([s * BIPED.armOut * 0.3, -1, BIPED.armFwd - 0.05 + 0.25 * a + tremble], [s * 0.35, -0.35, 0.85], -0.15, 0), fk)
      }
      // Hanging: the fingers dangle along the hand (in the bind pose they lie flat, forward), then curl loosely.
      const dangle = Math.max(0, up - rear) * (1 - reach)
      if (dangle > 0.001) {
        const hb = rig.bones[f.hand]!
        hb.updateMatrixWorld(true)
        _q.setFromRotationMatrix(_m4.extractRotation(hb.matrixWorld))
        _t.copy(rig.dir[f.hand]!).applyQuaternion(_q).normalize()
        for (const chain of f.f) {
          aimBone(rig, chain[0]!, _t, dangle)
          for (let j = 1; j < chain.length; j++) aimBone(rig, chain[j]!, rig.bones[chain[j - 1]!]!.getWorldDirection(_v2).copy(_t), dangle * 0.6)
        }
      }
      this.curlDigits(f.f, sw * 1.1 * (1 - up) + rear * 0.55 + dangle * 0.35 - reach * 0.2, sw, k)
    }
  }

  private static FOLLOW: [string, number][] = [
    ["hips", 9],
    ["spine1", 8],
    ["spine2", 8],
    ["spine3", 7],
    ["spine4", 7],
    ["ribs", 10],
    ["belly", 10],
    ["neck1", 6],
    ["neck2", 5.5],
    ["neck3", 5],
    ["head", 4.5],
    ["jaw", 8],
    ["scapL", 8],
    ["scapR", 8],
    ["tail1", 4],
    ["tail2", 3],
  ]

  private followThrough(dt: number) {
    const hips = this.bone("hips")
    if (!this.smoothInit) {
      this.smoothInit = true
      this.smoothHip.copy(hips.position)
      for (const [n] of WendigoAnimator.FOLLOW) this.smoothQ.set(this.b[n]!, this.bone(n).quaternion.clone())
      return
    }
    this.smoothHip.lerp(hips.position, 1 - Math.exp(-dt * 8))
    hips.position.copy(this.smoothHip)
    for (const [n, rate] of WendigoAnimator.FOLLOW) {
      const q = this.smoothQ.get(this.b[n]!)!
      const bn = this.bone(n)
      q.slerp(bn.quaternion, 1 - Math.exp(-dt * rate))
      bn.quaternion.copy(q)
    }
  }

  /**
   * Measures the antlers' highest point this frame and, under a ceiling, works out the stoop that keeps them ~6 cm
   * below it (about 1 m of antler drop per unit of stoop), for next frame's pose (eased, quick to duck, slow to rise).
   */
  private fitCeiling(ceiling: number | undefined, root: THREE.Object3D) {
    if (!this.antlerPts) this.antlerPts = antlerTips(this.rig)
    const head = this.bone("head")
    head.updateMatrixWorld(true)
    const e = head.matrixWorld.elements
    const pts = this.antlerPts
    let top = -Infinity
    for (let i = 0; i < pts.length; i += 3) {
      const y = e[1]! * pts[i]! + e[5]! * pts[i + 1]! + e[9]! * pts[i + 2]! + e[13]!
      if (y > top) top = y
    }
    this.antlerTop = top - root.position.y
    if (ceiling === undefined) {
      this.ceilWant = 0
      return
    }
    const over = top - (ceiling - 0.06)
    // Proportional step on the current stoop; hysteresis so it doesn't hunt at the limit.
    if (over > 0 || over < -0.15) this.ceilWant = Math.min(1.4, Math.max(0, this.ceilStoop.x + over * 1.05 + (over > 0 ? 0.03 : 0.05)))
  }

  /** Switch the stepper between four-legged and two-legged gaits. */
  private setGait(biped: boolean, root: THREE.Object3D) {
    const st = this.stepper
    // Upright, the hind feet move forward under the torso's weight and a little closer together.
    for (let i = 2; i < 4; i++) {
      const h = st.legs[i]!.spec.home
      h.copy(this.homes[i]!)
      if (biped) h.set(h.x * BIPED.footX, 0, h.z + BIPED.footZ)
    }
    this.bipedGait = biped
    st.next = 0
    st.wait = 0.15
    if (biped) {
      // Hind legs only: long, high, snatching strides with a hitch between steps.
      st.order = [2, 3]
      st.stride = 1.3
      st.stepTime = 0.95
      st.pause = 0
      for (const l of st.legs.slice(2)) l.spec.lift = 0.42
    } else {
      st.order = [2, 0, 3, 1]
      st.stride = 1.05
      st.stepTime = 0.7
      st.pause = 0
      for (const l of st.legs.slice(2)) l.spec.lift = 0.22
      // The forefeet were gliding at home while upright: they simply stay planted there.
      void root
    }
  }

  /** Curl a set of digit chains: + curls the claws under, − splays them back. Plus small random twitches. */
  private curlDigits(chains: number[][], amount: number, swing: number, hand = -1) {
    const rig = this.rig
    chains.forEach((chain, ci) => {
      const tw = hand >= 0 ? this.fingerTwitch[hand * 5 + ci]! : 0
      chain.forEach((bi, j) => {
        const a = amount * (j === 0 ? 0.2 : 0.45) + tw * (j + 1) * 0.15 + Math.sin(this.time * 4 + ci) * 0.05 * swing
        if (Math.abs(a) < 1e-4) return
        const bn = rig.bones[bi]!
        // Curl about the digit's own lateral axis (perpendicular to it, horizontal).
        _v.copy(rig.dir[bi]!)
        _v2.crossVectors(_v, _up).normalize()
        if (_v2.lengthSq() < 1e-6) return
        _q.setFromAxisAngle(_v2, -a)
        bn.quaternion.multiply(_q)
        bn.updateMatrixWorld(true)
      })
    })
  }

  private updateSnaps(dt: number, mode: WendigoMode) {
    const s = this.snap
    s.next -= dt
    s.hold -= dt
    const r = this.rng
    // Slow, deliberate head turns and tilts (not twitches).
    if (s.next <= 0 && (mode === "idle" || mode === "stalk" || mode === "stalk-upright")) {
      s.tYaw = (r() - 0.5) * 0.7
      s.tPitch = (r() - 0.5) * 0.3
      s.tRoll = (r() - 0.5) * 0.6
      s.hold = 0.25 + r() * 1.1
      s.next = s.hold + 1.2 + r() * 4
    }
    const back = s.hold <= 0
    const w = back ? 2 : 5
    s.yaw.step(back ? 0 : s.tYaw, dt, w)
    s.pitch.step(back ? 0 : s.tPitch, dt, w)
    s.roll.step(back ? 0 : s.tRoll, dt, w)
    // Fingers: one flexes now and then.
    this.fingerNext -= dt
    if (this.fingerNext <= 0) {
      this.fingerNext = 0.3 + r() * 1.6
      this.fingerTarget[Math.floor(r() * 10)] = (r() - 0.3) * 0.8
    }
    for (let i = 0; i < 10; i++) {
      this.fingerTarget[i]! *= Math.exp(-dt * 1.5)
      this.fingerTwitch[i]! += (this.fingerTarget[i]! - this.fingerTwitch[i]!) * Math.min(1, dt * 5)
    }
  }
}

/** The 48 antler vertices farthest from the head joint, in the head bone's frame (bind pose has no bone rotation). */
function antlerTips(rig: CreatureRig): Float32Array {
  const d = rig.data
  const part = d.parts.find((p) => p.name === "antlers")
  const hi = rig.bones.findIndex((b) => b.name === "head")
  const h = d.bones[hi]!.head
  if (!part) return new Float32Array(0)
  const seen = new Set<number>()
  const cand: [number, number][] = []
  for (let k = part.start; k < part.start + part.count; k++) {
    const v = d.indices[k]!
    if (seen.has(v)) continue
    seen.add(v)
    const x = d.positions[v * 3]! - h[0]
    const y = d.positions[v * 3 + 1]! - h[1]
    const z = d.positions[v * 3 + 2]! - h[2]
    cand.push([v, x * x + y * y + z * z])
  }
  // Farthest points, plus the highest in the bind pose (the beam's upper curve).
  cand.sort((a, b) => b[1] - a[1])
  const pick = new Set(cand.slice(0, 40).map((c) => c[0]))
  ;[...seen].sort((a, b) => d.positions[b * 3 + 1]! - d.positions[a * 3 + 1]!).slice(0, 24).forEach((v) => pick.add(v))
  const out = new Float32Array(pick.size * 3)
  let i = 0
  for (const v of pick) {
    out[i++] = d.positions[v * 3]! - h[0]
    out[i++] = d.positions[v * 3 + 1]! - h[1]
    out[i++] = d.positions[v * 3 + 2]! - h[2]
  }
  return out
}
