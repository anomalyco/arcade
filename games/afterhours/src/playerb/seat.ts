import * as THREE from "three/webgpu"

/**
 * Seated driving mode for the player body (src/playerb/body.ts), for the intro cutscene (src/game/intro).
 *
 * API (on the CharacterBody; `createGameBody(...).body` in the game, `__afterhoursBody.body` for automation):
 *
 *   body.seat({ hip, eye?, wheel: { object, radius, axis? }, doorHandle, doorEdge })
 *     Sits the body down. Call once (again to change seat); the body then ignores the controller's PlayerState and
 *     is posed from these objects every frame, so they may move with the car.
 *     - `hip`: Object3D (child of the car body, so it rides the suspension) at the driver's hip joints (H-point), its
 *       -Z the car's forward and +Y up; or a world Vector3 (then the car frame comes from the wheel's parent).
 *       Intro car: (-0.37, 0.53, 0.08) in car model space.
 *     - `eye` (optional, recommended): Object3D / world Vector3 where the first-person camera is. The spine leans so
 *       the head's eyes land there (the head itself is hidden from the view camera); without it the torso just
 *       reclines.
 *     - `wheel.object`: the steering-wheel group, origin at the hub on the column axis (PlayerCar.steering);
 *       `wheel.radius`: radius to the centre of the rim tube (m; intro car 0.147: 0.163 outer − its 0.016 tube);
 *       `wheel.tube`: the rim tube's radius (m, default 0.016); `wheel.axis`: column direction in the object's frame,
 *       pointing from the driver to the dash (default: `object.userData.axis`, which PlayerCar sets).
 *     - `doorHandle`: Object3D at the inner door handle (child of the door group, so it swings with it).
 *     - `doorEdge`: Object3D on the inner door panel where the palm pushes it open (child of the door group).
 *
 *   body.steer(angle)
 *     The steering-wheel angle each frame (rad, + = turned left; PlayerCar's wheel angle). The hands hold the rim at
 *     9 and 3 (palm on the rim's outer face, fingers curled round behind it, thumb along the front) and turn with it (they follow the wheel object, so pass what the wheel shows); past ~60° from its
 *     side a hand lets go and re-grips at its home position (push-pull steering), one hand at a time.
 *
 *   body.reachDoor(t)
 *     t 0→1 drives the door move with the left hand: 0–0.3 off the wheel to the handle, 0.3–0.5 pulling the handle,
 *     0.5–0.65 to the door panel, 0.65–0.9 the palm pushing it out (it follows `doorEdge`). Swing the door to match:
 *     unlatch at t ≈ 0.45, push it ~25° open over t 0.6–0.9 (PlayerCar.doorAmount ≈ 0.1), then let it swing free to
 *     its check (t 0.9–1). From t = 0.9 the palm lets it go and the hand returns to the lap
 *     (the palm stops at arm's length if the door gets ahead of it). 0 = both hands on the wheel. The right hand stays on the wheel.
 *
 *   body.unseat()
 *     Back to the standing body driven by the PlayerState (for the step-out).
 *
 * The flashlight is put away while seated (and the intro's borrowed headlamp beam is unaffected). The body must be
 * shown and updated while seated: the game body updates a seated body even when `body.show` is off.
 */
export type SeatOptions = {
  hip: THREE.Object3D | THREE.Vector3
  eye?: THREE.Object3D | THREE.Vector3
  wheel: { object: THREE.Object3D; radius: number; tube?: number; axis?: THREE.Vector3 }
  doorHandle: THREE.Object3D
  doorEdge: THREE.Object3D
}

/** What the seat needs from the body (src/playerb/body.ts `seatHost`). */
export type SeatHost = {
  root: THREE.Group
  torch: THREE.Object3D
  bones(): Record<string, THREE.Bone>
  model(): THREE.Object3D | null
  /** Poses the idle (breathing) clip alone, `dt` advancing it. */
  poseIdle(dt: number): void
  /** Slerps one hand's fingers towards the torch-idle fist by `w` (the right hand mirrored). */
  fist(side: "Left" | "Right", w: number): void
  atOrigin<T>(fn: () => T): T
  ik(a: THREE.Object3D, b: THREE.Object3D, c: THREE.Object3D, target: THREE.Vector3, pole: THREE.Vector3): void
}

type Fit = { pos: THREE.Vector3; quat: THREE.Quaternion; palmPos: THREE.Vector3; knuckle: THREE.Vector3; fingers: THREE.Vector3; thumb: THREE.Vector3 }
type HandState = { clock: number; regrip: { t: number; from: THREE.Vector3 } | null }

const HOME = { Left: (-88 * Math.PI) / 180, Right: (88 * Math.PI) / 180 }
/** Comfortable world clock range per hand (rad, clockwise from 12 as the driver sees it). */
// Push-pull steering: a hand that has ridden ~60° from its side lets go and takes the rim at home again.
const RANGE = { Left: [(-150 * Math.PI) / 180, (-30 * Math.PI) / 180], Right: [(30 * Math.PI) / 180, (150 * Math.PI) / 180] }
/** Wheel grip curl per finger joint (rad): knuckle, middle, tip; wraps a ~16 mm tube. */
const CURL: Record<string, [number, number, number]> = {
  Index: [0.95, 1.25, 0.7],
  Middle: [1.0, 1.3, 0.7],
  Ring: [1.05, 1.3, 0.7],
  Pinky: [1.1, 1.25, 0.65],
}
/** The head (and so the shoulders) sits this far ahead of the camera anchor (m): a driver leans towards the wheel. */
const LEAN = 0.07
const REGRIP_S = 0.32
const RECLINE = (16 * Math.PI) / 180

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

const _q = new THREE.Quaternion()
const _q2 = new THREE.Quaternion()
const _m = new THREE.Matrix4()
const _v = new THREE.Vector3()

function turnWorld(bone: THREE.Object3D, axis: THREE.Vector3, angle: number) {
  if (Math.abs(angle) < 1e-6) return
  const pq = bone.parent!.getWorldQuaternion(new THREE.Quaternion()).invert()
  bone.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(axis.clone().normalize().applyQuaternion(pq), angle))
  bone.updateWorldMatrix(false, true)
}

function setWorldQuat(bone: THREE.Object3D, q: THREE.Quaternion, w = 1) {
  const local = bone.parent!.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(q)
  bone.quaternion.slerp(local, w)
  bone.updateWorldMatrix(false, true)
}

const worldOf = (o: THREE.Object3D | THREE.Vector3, out: THREE.Vector3) => ((o as THREE.Object3D).isObject3D ? (o as THREE.Object3D).getWorldPosition(out) : out.copy(o as THREE.Vector3))

export class SeatRig {
  private hands: Record<"Left" | "Right", HandState> = { Left: { clock: HOME.Left, regrip: null }, Right: { clock: HOME.Right, regrip: null } }
  private angle = 0
  readonly debug: Record<string, { grip: number; wrist: number }> = {}
  private door = 0
  private released = 0
  private fits: Record<"Left" | "Right", Fit> | null = null
  private fitModel: THREE.Object3D | null = null
  /** Model-space rest orientations from the idle pose: head and feet (kept level while the body sits). */
  private rest = new Map<string, THREE.Quaternion>()

  constructor(
    private host: SeatHost,
    public opts: SeatOptions,
  ) {}

  steer(angle: number) {
    this.angle = angle
  }

  reachDoor(t: number) {
    this.door = Math.min(1, Math.max(0, t))
  }

  /** Grip frames (relative to each hand bone) with the fist closed, the palm and finger directions (hand-local). */
  private fit() {
    const model = this.host.model()
    if (!model || (this.fits && this.fitModel === model)) return
    this.fitModel = model
    const B = this.host.bones()
    this.fits = this.host.atOrigin(() => {
      this.host.poseIdle(0)
      model.updateMatrixWorld(true)
      for (const n of ["Head", "LeftFoot", "RightFoot"]) this.rest.set(n, B[n]!.getWorldQuaternion(new THREE.Quaternion()))
      const out = {} as Record<"Left" | "Right", Fit>
      for (const side of ["Left", "Right"] as const) {
        this.host.fist(side, 1)
        model.updateMatrixWorld(true)
        const P = (n: string) => B[`${side}Hand${n}`]!.getWorldPosition(new THREE.Vector3())
        const hand = B[`${side}Hand`]!
        const H = hand.getWorldPosition(new THREE.Vector3())
        const mid = (f: string) => P(`${f}1`).lerp(P(`${f}2`), 0.5)
        const idx = mid("Index")
        const pky = mid("Pinky")
        const centre = idx.clone().add(mid("Middle")).add(mid("Ring")).add(pky).multiplyScalar(0.25)
        const axis = idx.clone().sub(pky).normalize()
        const toPalm = H.clone().sub(centre)
        toPalm.addScaledVector(axis, -toPalm.dot(axis)).normalize()
        centre.addScaledVector(toPalm, 0.012)
        // Grip frame: -Z along the barrel (index side), +Y towards the palm.
        const z = axis.clone().negate()
        const y = toPalm.clone()
        const x = new THREE.Vector3().crossVectors(y, z)
        const M = new THREE.Matrix4().makeBasis(x, y, z).setPosition(centre).premultiply(hand.matrixWorld.clone().invert())
        const pos = new THREE.Vector3()
        const quat = new THREE.Quaternion()
        M.decompose(pos, quat, new THREE.Vector3())
        // Open hand directions (idle fingers): fingers, thumb side, palm normal; hand-local.
        this.host.poseIdle(0)
        model.updateMatrixWorld(true)
        const inv = hand.matrixWorld.clone().invert()
        const toLocal = (v: THREE.Vector3) => v.transformDirection(inv)
        const f = P("Middle1").sub(H).normalize()
        const a = P("Index1").sub(P("Pinky1")).normalize()
        const palm = side === "Left" ? new THREE.Vector3().crossVectors(f, a) : new THREE.Vector3().crossVectors(a, f)
        // The palm's centre: a third of the way from the wrist to the middle knuckle, a little to the palm side.
        const palmCentre = H.clone().lerp(P("Middle1"), 0.55).addScaledVector(palm.clone().normalize(), 0.015)
        out[side] = {
          pos,
          quat,
          palmPos: palmCentre.applyMatrix4(inv),
          knuckle: P("Middle1").lerp(P("Ring1"), 0.3).applyMatrix4(inv),
          fingers: toLocal(f.clone()).normalize(),
          thumb: toLocal(a.clone()).normalize(),
        }
      }
      return out
    })
  }

  update(dt: number) {
    const host = this.host
    const model = host.model()
    if (!model) return
    this.fit()
    const B = host.bones()
    const o = this.opts
    host.torch.visible = false
    host.poseIdle(dt)

    // Car frame (world): forward F, up U, the driver's right R.
    const carQ = (o.hip as THREE.Object3D).isObject3D ? (o.hip as THREE.Object3D).getWorldQuaternion(new THREE.Quaternion()) : o.wheel.object.parent!.getWorldQuaternion(new THREE.Quaternion())
    const F = new THREE.Vector3(0, 0, -1).applyQuaternion(carQ)
    const U = new THREE.Vector3(0, 1, 0).applyQuaternion(carQ)
    const R = new THREE.Vector3(1, 0, 0).applyQuaternion(carQ)
    const root = host.root
    // The model faces +Z: turn it to the car's -Z.
    root.quaternion.copy(carQ).multiply(_q.setFromAxisAngle(_v.set(0, 1, 0), Math.PI))
    const H = worldOf(o.hip, new THREE.Vector3())
    root.position.copy(H)
    root.updateMatrixWorld(true)
    root.position.add(H.clone().sub(B.Hips!.getWorldPosition(_v)))
    root.updateMatrixWorld(true)
    const rootQ = root.quaternion

    // Pelvis reclined into the seat back.
    turnWorld(B.Hips!, R, RECLINE)

    // Legs: thighs along the cushion, knees up, feet on the floor at the pedals (right on the gas, left resting).
    for (const [side, dx] of [
      ["Left", -0.15],
      ["Right", 0.13],
    ] as const) {
      const foot = H.clone().addScaledVector(F, 0.74).addScaledVector(U, -0.36).addScaledVector(R, dx)
      const pole = U.clone().multiplyScalar(0.7).addScaledVector(F, 0.7).addScaledVector(R, dx * 2)
      host.ik(B[`${side}UpLeg`]!, B[`${side}Leg`]!, B[`${side}Foot`]!, foot, pole)
      const fr = this.rest.get(`${side}Foot`)
      if (fr) {
        // The foot as it stands, toes tipped up onto the pedal.
        setWorldQuat(B[`${side}Foot`]!, _q.copy(rootQ).multiply(fr).premultiply(_q2.setFromAxisAngle(R, side === "Right" ? 0.3 : 0.2)))
      }
    }

    // Spine: lean so the eyes land at the camera (the head's eyes ~7 cm above and 9 cm ahead of the Head bone).
    if (o.eye) {
      const eye = worldOf(o.eye, new THREE.Vector3())
      const goal = eye.addScaledVector(U, -0.07).addScaledVector(F, -0.09 + LEAN)
      for (const n of ["Spine", "Spine1", "Spine2"]) {
        const bone = B[n]!
        const base = bone.getWorldPosition(new THREE.Vector3())
        const head = B.Head!.getWorldPosition(new THREE.Vector3())
        const a = head.sub(base)
        const b = goal.clone().sub(base)
        const ang = Math.min(a.angleTo(b), 0.6) / 2
        const ax = new THREE.Vector3().crossVectors(a, b)
        if (ax.lengthSq() > 1e-10) turnWorld(bone, ax, ang)
      }
    } else turnWorld(B.Spine!, R, -RECLINE * 0.5)
    // Head level, looking down the road: half from the neck, the rest from the head.
    const hr = this.rest.get("Head")
    if (hr && B.Neck) {
      const want = _q.copy(rootQ).multiply(hr)
      const cur = B.Head!.getWorldQuaternion(new THREE.Quaternion())
      const delta = want.clone().multiply(cur.invert())
      setWorldQuat(B.Neck, _q2.identity().slerp(delta, 0.5).multiply(B.Neck.getWorldQuaternion(new THREE.Quaternion())))
      setWorldQuat(B.Head!, want)
    }

    // Hands.
    const w = o.wheel
    const wheel = w.object
    wheel.updateWorldMatrix(true, false)
    const axis = (w.axis ?? (wheel.userData.axis as THREE.Vector3 | undefined) ?? new THREE.Vector3(0, 0, -1)).clone().normalize()
    const upL = new THREE.Vector3(0, 1, 0).addScaledVector(axis, -axis.y).normalize()
    const rightL = new THREE.Vector3().crossVectors(axis, upL)
    const wq = wheel.getWorldQuaternion(new THREE.Quaternion())
    const nW = axis.clone().applyQuaternion(wq)
    const rim = (clock: number, out: THREE.Vector3) => out.copy(upL).multiplyScalar(Math.cos(clock) * w.radius).addScaledVector(rightL, Math.sin(clock) * w.radius).applyMatrix4(wheel.matrixWorld)
    const tangent = (clock: number) => upL.clone().multiplyScalar(-Math.sin(clock)).addScaledVector(rightL, Math.cos(clock)).applyQuaternion(wq).normalize()
    const radial = (clock: number) => upL.clone().multiplyScalar(Math.cos(clock)).addScaledVector(rightL, Math.sin(clock)).applyQuaternion(wq).normalize()

    // A wheel-local clock position as the driver sees it in the car (the column's frame, unturned).
    const pq = wheel.parent!.getWorldQuaternion(new THREE.Quaternion())
    const pInv = pq.clone().invert()
    const worldClock = (clock: number) => {
      const v = rim(clock, new THREE.Vector3()).sub(wheel.getWorldPosition(_v)).applyQuaternion(pInv)
      return Math.atan2(v.dot(rightL), v.dot(upL))
    }
    // Re-grips: a hand past its range lets go and takes the rim again at home (one hand at a time).
    for (const side of ["Left", "Right"] as const) {
      const h = this.hands[side]
      const other = this.hands[side === "Left" ? "Right" : "Left"]
      if (h.regrip) {
        h.regrip.t += dt / REGRIP_S
        if (h.regrip.t >= 1) h.regrip = null
        continue
      }
      const wc = worldClock(h.clock)
      const [lo, hi] = RANGE[side]
      if ((wc < lo! || wc > hi!) && !other.regrip && !(side === "Left" && this.door > 0)) {
        // From where the knuckles are now to the rim at the hand's home position in the car (9 or 3 o'clock).
        h.regrip = { t: 0, from: B[`${side}Hand`]!.localToWorld(this.fits!.Left && this.fits![side].knuckle.clone()) }
        h.clock = HOME[side] + (h.clock - worldClock(h.clock))
      }
    }

    const fits = this.fits!
    for (const side of ["Left", "Right"] as const) {
      const h = this.hands[side]
      const fit = fits[side]
      const hand = B[`${side}Hand`]!
      const fore = B[`${side}ForeArm`]!
      const arm = B[`${side}Arm`]!
      const sign = side === "Left" ? 1 : -1
      // Wheel grip: the palm on the rim's outer face (a little behind it, towards the driver), facing the hub and the
      // dash; the knuckle line along the rim, index towards 12 o'clock; the fingers then curl round behind the tube
      // (wheelFingers) and the thumb lies along its front.
      const tubeR = w.tube ?? 0.016
      const C = rim(h.clock, new THREE.Vector3())
      const out = radial(h.clock)
      const palmN = out.clone().multiplyScalar(-0.8).addScaledVector(nW, 0.6).normalize()
      const up12 = tangent(h.clock).multiplyScalar(side === "Left" ? 1 : -1)
      // Fingers (open hand, wrist → knuckles) square to the knuckle line and the palm normal, towards the dash side.
      const fingers = new THREE.Vector3().crossVectors(up12, palmN)
      if (fingers.dot(nW) < 0) fingers.negate()
      const q = this.palmQuat(palmN, fingers, fit, side)
      // The tube lies across the base of the fingers, just past the knuckles, against the palm side.
      const knuckleAt = C.clone().addScaledVector(palmN, -(tubeR + 0.013)).addScaledVector(fingers, -0.016)
      let gripW = 1
      if (h.regrip) {
        const u = smooth(0, 1, h.regrip.t)
        knuckleAt.lerpVectors(h.regrip.from, knuckleAt, u).addScaledVector(nW, 0.03 * Math.sin(Math.PI * h.regrip.t)).addScaledVector(out, 0.04 * Math.sin(Math.PI * h.regrip.t))
        gripW = 1 - 0.85 * Math.sin(Math.PI * h.regrip.t)
      }
      let wrist = knuckleAt.clone().sub(fit.knuckle.clone().multiplyScalar(hand.getWorldScale(_v).x).applyQuaternion(q))
      let handQ = q
      let fistW = 0

      // The door: left hand to the handle, then the palm onto the panel and out with it.
      if (side === "Left" && this.door > 0) {
        const t = this.door
        const handle = o.doorHandle.getWorldPosition(new THREE.Vector3())
        // At the handle: a fist round the lever (barrel along the car's forward axis), the wrist inboard.
        const qh = this.gripQuat(F.clone(), R.clone().multiplyScalar(0.8).addScaledVector(U, -0.3), fit)
        const atHandle = handle.clone().sub(fit.pos.clone().multiplyScalar(hand.getWorldScale(_v).x).applyQuaternion(qh))
        // On the panel: the open palm facing out of the car, fingers up and forward.
        const edge = o.doorEdge.getWorldPosition(new THREE.Vector3())
        const out = R.clone().negate()
        const fingers = U.clone().multiplyScalar(0.55).addScaledVector(F, 0.8)
        const qp = this.palmQuat(out, fingers, fit, side)
        const atPanel = edge.clone().addScaledVector(out, -0.01).sub(fit.palmPos.clone().multiplyScalar(hand.getWorldScale(_v).x).applyQuaternion(qp))
        const a = smooth(0, 0.3, t)
        const b = smooth(0.5, 0.65, t)
        const toHandle = wrist.clone().lerp(atHandle, a)
        // Arc out of the wheel's way: back towards the driver on the way to the handle.
        toHandle.addScaledVector(F, -0.1 * Math.sin(Math.PI * a))
        // The palm stays on the panel (at arm's length if the door gets ahead); from t = 0.9 it lets the door swing on
        // to its check and the hand comes back to the lap.
        const A = B.LeftArm!.getWorldPosition(new THREE.Vector3())
        const reach = (B.LeftArm!.getWorldPosition(_v).distanceTo(fore.getWorldPosition(new THREE.Vector3())) + fore.getWorldPosition(new THREE.Vector3()).distanceTo(hand.getWorldPosition(new THREE.Vector3()))) * 0.97
        if (t >= 0.9) this.released = Math.min(1, this.released + dt / 0.45)
        else this.released = 0
        const lap = H.clone().addScaledVector(F, 0.3).addScaledVector(U, 0.12).addScaledVector(R, -0.12)
        const qLap = this.palmQuat(U.clone().negate(), F.clone(), fit, side)
        const held = A.clone().add(atPanel.clone().sub(A).clampLength(0, reach))
        wrist = toHandle.lerp(held, b).lerp(lap, smooth(0, 1, this.released))
        handQ = q.clone().slerp(qh, a).slerp(qp, b).slerp(qLap, smooth(0, 1, this.released))
        fistW = Math.max(0, 1 - b) * (a < 0.5 ? 1 - Math.sin(Math.PI * a) * 0.7 : 1)
        gripW *= 1 - smooth(0, 0.15, t)
      }

      // Elbows down and a little out, shoulders relaxed.
      // Reach: the shoulder blade comes forward towards the target (up to ~20°) when the arm alone falls short.
      const sh = B[`${side}Shoulder`]
      if (sh) {
        const A = arm.getWorldPosition(new THREE.Vector3())
        const len = A.distanceTo(fore.getWorldPosition(_v)) + fore.getWorldPosition(_v).distanceTo(hand.getWorldPosition(new THREE.Vector3()))
        const need = A.distanceTo(wrist) - len * 0.97
        if (need > 0) {
          const base = sh.getWorldPosition(new THREE.Vector3())
          const a = A.clone().sub(base)
          const b = wrist.clone().sub(base)
          const ax = new THREE.Vector3().crossVectors(a, b)
          if (ax.lengthSq() > 1e-10) turnWorld(sh, ax, Math.min(0.5, need / Math.max(0.05, a.length())))
        }
      }
      const elbowPole = U.clone().multiplyScalar(-1).addScaledVector(R, -0.15 * sign).addScaledVector(F, -0.35)
      host.ik(arm, fore, hand, wrist, elbowPole)
      // Half the hand's twist taken by the forearm (no candy-wrapped wrist), the rest by the hand.
      const local = fore.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(handQ)
      const tw = new THREE.Quaternion(0, local.y, 0, local.w).normalize()
      fore.quaternion.multiply(new THREE.Quaternion().slerp(tw, 0.5))
      fore.updateWorldMatrix(false, true)
      setWorldQuat(hand, handQ)
      host.fist(side, fistW)
      if (gripW > 1e-3) this.wheelFingers(side, palmN, gripW, up12)
      model.updateMatrixWorld(true)
      // Automation: the closest finger joint to the rim tube's centre (m; ~tube radius = wrapped) and the wrist error.
      let near = Infinity
      for (const f of ["Index", "Middle", "Ring", "Pinky"])
        for (const i of [2, 3]) near = Math.min(near, B[`${side}Hand${f}${i}`]!.getWorldPosition(new THREE.Vector3()).distanceTo(C))
      this.debug[side] = { grip: +near.toFixed(3), wrist: +hand.getWorldPosition(new THREE.Vector3()).distanceTo(wrist).toFixed(3) }
    }
    model.updateMatrixWorld(true)
  }

  /**
   * Curls the fingers round the rim tube: each joint turned towards the palm side about the axis square to its own
   * direction and the palm normal (CURL angles × w); the thumb lies along the front of the rim, slightly bent.
   */
  private wheelFingers(side: "Left" | "Right", palmN: THREE.Vector3, w: number, up12?: THREE.Vector3) {
    const B = this.host.bones()
    const seg = (b: THREE.Object3D, next: THREE.Object3D, ang: number, towards: THREE.Vector3) => {
      const d = next.getWorldPosition(new THREE.Vector3()).sub(b.getWorldPosition(_v))
      const ax = new THREE.Vector3().crossVectors(d, towards)
      if (ax.lengthSq() > 1e-12) turnWorld(b, ax, ang * w)
    }
    for (const [f, angs] of Object.entries(CURL)) {
      for (let i = 1; i <= 3; i++) {
        const b = B[`${side}Hand${f}${i}`]
        const n = B[`${side}Hand${f}${i + 1}`]
        if (b && n) seg(b, n, angs[i - 1]!, palmN)
      }
    }
    // Thumb: swung from pointing at the hub to lying along the front of the rim (towards 12), joints a little bent.
    const t1 = B[`${side}HandThumb1`]
    const t2 = B[`${side}HandThumb2`]
    if (t1 && t2 && up12) {
      const d = t2.getWorldPosition(new THREE.Vector3()).sub(t1.getWorldPosition(_v))
      const want = up12.clone().addScaledVector(d.clone().normalize(), 0.6).normalize()
      const ax = new THREE.Vector3().crossVectors(d, want)
      if (ax.lengthSq() > 1e-12) turnWorld(t1, ax, Math.min(1.0, d.angleTo(want)) * w)
    }
    for (let i = 1; i <= 3; i++) {
      const b = B[`${side}HandThumb${i}`]
      const n = B[`${side}HandThumb${i + 1}`]
      if (b && n) seg(b, n, [0.2, 0.45, 0.4][i - 1]!, palmN)
    }
  }

  /** Hand world rotation that puts the fist's grip frame (-Z = barrel, +Y = palm side) on `lens` / `toPalm`. */
  private gripQuat(lens: THREE.Vector3, toPalm: THREE.Vector3, fit: Fit) {
    const z = lens.clone().negate().normalize()
    const y = toPalm.clone().addScaledVector(z, -toPalm.dot(z)).normalize()
    const x = new THREE.Vector3().crossVectors(y, z)
    _m.makeBasis(x, y, z)
    return new THREE.Quaternion().setFromRotationMatrix(_m).multiply(fit.quat.clone().invert())
  }

  /** Hand world rotation with the open palm facing `palm` and the fingers along `fingers`. */
  private palmQuat(palm: THREE.Vector3, fingers: THREE.Vector3, fit: Fit, side: "Left" | "Right") {
    const f = fit.fingers.clone()
    const pl = side === "Left" ? new THREE.Vector3().crossVectors(fit.fingers, fit.thumb) : new THREE.Vector3().crossVectors(fit.thumb, fit.fingers)
    pl.normalize()
    const al = new THREE.Vector3().crossVectors(pl, f).normalize()
    const fl = new THREE.Vector3().crossVectors(al, pl).normalize()
    const P = palm.clone().normalize()
    const Fw = fingers.clone().addScaledVector(P, -fingers.dot(P)).normalize()
    const A = new THREE.Vector3().crossVectors(P, Fw)
    const L = new THREE.Matrix4().makeBasis(fl, al, pl)
    const W = new THREE.Matrix4().makeBasis(Fw, A, P)
    return new THREE.Quaternion().setFromRotationMatrix(W.multiply(L.transpose()))
  }
}
