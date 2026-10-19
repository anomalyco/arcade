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
 *     - `eye` (optional, unused now): the body decides where its eyes are; put the camera at `body.seatEye(out)`.
 *     - `wheel.object`: the steering-wheel group, origin at the hub on the column axis (PlayerCar.steering);
 *       `wheel.radius`: radius to the centre of the rim tube (m; intro car 0.147: 0.163 outer − its 0.016 tube);
 *       `wheel.tube`: the rim tube's radius (m, default 0.016); `wheel.axis`: column direction in the object's frame,
 *       pointing from the driver to the dash (default: `object.userData.axis`, which PlayerCar sets).
 *     - `doorHandle`: Object3D at the inner door handle (child of the door group, so it swings with it).
 *     - `doorEdge`: Object3D on the inner door panel where the palm pushes it open (child of the door group).
 *
 *   body.seatEye(out): boolean
 *     Seated: writes the head's eye point (world) and returns true. The driver sits on the H-point in the Mixamo
 *     driving pose, reclined as far as the arms still reach the rim with bent elbows; put the first-person camera
 *     here every frame (it rides the car), so the hands and arms are seen at their real distance.
 *
 *   body.steer(angle)
 *     The steering-wheel angle each frame (rad, + = turned left; PlayerCar's wheel angle). The hands keep the driving
 *     clip's grip moved to ten to two on the real rim, and follow the wheel's turn softly up to ~±25°; past that the
 *     rim slides through loosely held hands. No hand-over-hand.
 *
 *   body.reachDoor(t)
 *     t 0→1 drives the door move with the left hand: 0–0.3 off the wheel to the handle, 0.3–0.5 pulling the handle,
 *     0.5–0.65 to the door panel, 0.65–0.9 the palm pushing it out (it follows `doorEdge`). Swing the door to match:
 *     unlatch at t ≈ 0.45, push it ~25° open over t 0.6–0.9 (PlayerCar.doorAmount ≈ 0.1), then let it swing free to
 *     its check (t 0.9–1). From t = 0.9 the palm lets it go and the hand returns to the lap
 *     (the palm stops at arm's length if the door gets ahead of it). 0 = both hands on the wheel. The right hand stays on the wheel.
 *
 *   body.exitCar(t): number | null
 *     The door beat and step-out from the Mixamo driving-exit-car clip, `t` seconds in (0..5.8; call each frame, the
 *     body must be seated). The left hand reaches the door at ~0.35 s and opens it; the driver swings out and ends
 *     standing ~1.8 m left of the seat, facing about where the car points. Returns the door's opening angle (rad,
 *     never decreasing) the hand implies, or null before the hand gets there: drive the door from it
 *     (PlayerCar.doorAmount from the angle). `body.seatEye(out)` follows the head through it. Then `unseat()`.
 *     (Replaces reachDoor for the door beat; reachDoor stays for compatibility.)
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
  poseIdle(dt: number, clip?: string): void
  /** Poses one clip alone at time t (s). */
  clipPose?(clip: string, t: number): void
  /** A one-shot's removed root path at time t: x (left), z (forward), yaw (rad), scaled to the character. */
  clipRoot?(clip: string, t: number): { x: number; z: number; yaw: number }
  /** Slerps one hand's fingers towards the torch-idle fist by `w` (the right hand mirrored). */
  fist(side: "Left" | "Right", w: number): void
  atOrigin<T>(fn: () => T): T
  ik(a: THREE.Object3D, b: THREE.Object3D, c: THREE.Object3D, target: THREE.Vector3, pole: THREE.Vector3): void
}

type Fit = { pos: THREE.Vector3; quat: THREE.Quaternion; palmPos: THREE.Vector3; knuckle: THREE.Vector3; fingers: THREE.Vector3; thumb: THREE.Vector3 }

/** The seated base pose (anims.glb; the breathing idle if it is missing). */
const DRIVE_CLIP = "driving-idle"
/** The head's eyes relative to the Head bone (m, body frame): up and ahead. */
const EYE_UP = 0.07
const EYE_AHEAD = 0.09
/** The hands turn with the wheel up to this (rad); past it the rim slides through them (no hand-over-hand). */
/** The hands follow the wheel's turn up to about this much (rad), softly (see `turn` in update). */
const HOLD = (24 * Math.PI) / 180
/** The step-out clip, its length (s) and when the left hand reaches the door (s). */
export const EXIT_CLIP = "driving-exit-car"
export const EXIT_S = 5.8
const EXIT_TOUCH = 0.35
/** Where the hands hold the rim (rad from 12 o'clock): ten to two, in view from the driver's eyes. */
const GRIP_CLOCK = (58 * Math.PI) / 180
/** Shoulder-to-wrist reach allowed (× arm length): ~0.93 keeps the elbows ~40° bent. */
const REACH_MAX = 0.93
/** How far short of the rim's plane the seat leaves the clip's fists (m), so the arms reach with bent elbows. */
const SLIDE_SLACK = 0.05

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
  private angle = 0
  readonly debug: Record<string, unknown> = {}
  private door = 0
  private released = 0
  /** Torso recline (rad) for this seat, found on the first frame. */
  private recline: number | null = null
  /** Seat travel forward (m) for this seat, found on the first frame. */
  private slide: number | null = null
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

  /**
   * The head's eyes (world), where the first-person camera belongs while seated. Kept in the car's frame (measured
   * on the last pose, relative to the wheel's parent), so it is current for this frame's car placement even when read
   * before the body updates.
   */
  eye(out: THREE.Vector3) {
    const frame = this.opts.wheel.object.parent!
    frame.updateWorldMatrix(true, false)
    return out.copy(this.eyeLocal).applyMatrix4(frame.matrixWorld)
  }
  private eyeLocal = new THREE.Vector3()
  /** This frame's grip targets on the rim and where the fists actually are (world). */
  readonly targets = { Left: new THREE.Vector3(), Right: new THREE.Vector3() }
  readonly fists = { Left: new THREE.Vector3(), Right: new THREE.Vector3() }
  private markers: THREE.Mesh[] | null = null
  /**
   * Debug (`?introRig`): bright dots, drawn over everything: yellow = grip targets on the rim, cyan = where the
   * fists are, white = the rim circle itself (from the wheel's world matrix).
   */
  showMarkers(scene: THREE.Object3D) {
    if (this.markers) return
    const geo = new THREE.SphereGeometry(0.012, 8, 6)
    const mk = (c: number) => {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicNodeMaterial({ color: c, depthTest: false }))
      m.renderOrder = 11
      m.frustumCulled = false
      scene.add(m)
      return m
    }
    this.markers = [mk(0xffee00), mk(0xffee00), mk(0x00ffff), mk(0x00ffff), ...Array.from({ length: 12 }, () => mk(0xffffff))]
  }
  private placeMarkers(hub: THREE.Vector3, up: THREE.Vector3, right: THREE.Vector3, r: number, turn: THREE.Quaternion) {
    const m = this.markers
    if (!m) return
    m[0]!.position.copy(this.targets.Left)
    m[1]!.position.copy(this.targets.Right)
    m[2]!.position.copy(this.fists.Left)
    m[3]!.position.copy(this.fists.Right)
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2
      m[4 + i]!.position.copy(up).multiplyScalar(Math.cos(a) * r).addScaledVector(right, Math.sin(a) * r).applyQuaternion(turn).add(hub)
    }
  }

  /** Shoulder-to-wrist distance the rim needs over the arm's length (worst hand), in the current base pose. */
  private reachRatio() {
    const B = this.host.bones()
    this.host.root.updateMatrixWorld(true)
    let worst = 0
    for (const side of ["Left", "Right"] as const) {
      const P = (n: string) => B[n]!.getWorldPosition(new THREE.Vector3())
      const A = P(`${side}Arm`)
      const W = this.wristOnRim(side)
      const len = A.distanceTo(P(`${side}ForeArm`)) + P(`${side}ForeArm`).distanceTo(P(`${side}Hand`))
      worst = Math.max(worst, A.distanceTo(W) / len)
    }
    return worst
  }

  /** The wrist position that puts the current pose's fist on the real rim (unturned wheel). */
  private wristOnRim(side: "Left" | "Right") {
    const B = this.host.bones()
    const w = this.opts.wheel
    const wheel = w.object
    wheel.updateWorldMatrix(true, false)
    const hub = wheel.getWorldPosition(new THREE.Vector3())
    const axisL = (w.axis ?? (wheel.userData.axis as THREE.Vector3 | undefined) ?? new THREE.Vector3(0, 0, -1)).clone().normalize()
    const parentQ = wheel.parent!.getWorldQuaternion(new THREE.Quaternion())
    const nW = axisL.clone().applyQuaternion(parentQ)
    const P0 = B[`${side}Hand`]!.getWorldPosition(new THREE.Vector3())
    const G0 = this.fistCentre(side)
    const up = new THREE.Vector3(0, 1, 0).addScaledVector(axisL, -axisL.y).normalize().applyQuaternion(parentQ)
    const right = new THREE.Vector3().crossVectors(nW, up)
    const clock = side === "Left" ? -GRIP_CLOCK : GRIP_CLOCK
    const g = G0.clone().sub(hub)
    g.addScaledVector(nW, -g.dot(nW))
    const roll = new THREE.Quaternion().setFromAxisAngle(nW, -(clock - Math.atan2(g.dot(right), g.dot(up))))
    const S = hub.clone().addScaledVector(up, Math.cos(clock) * w.radius).addScaledVector(right, Math.sin(clock) * w.radius)
    return S.sub(G0.sub(P0).applyQuaternion(roll))
  }

  private fistCentre(side: "Left" | "Right") {
    const B = this.host.bones()
    const G0 = new THREE.Vector3()
    for (const f of ["Index", "Middle", "Ring", "Pinky"]) G0.add(B[`${side}Hand${f}1`]!.getWorldPosition(new THREE.Vector3()).lerp(B[`${side}Hand${f}2`]!.getWorldPosition(new THREE.Vector3()), 0.6))
    return G0.multiplyScalar(0.25)
  }

  /**
   * The step-out (driving-exit-car), `t` seconds into the clip (0..EXIT_S): the body follows the clip's root path in
   * the car's frame, its hips starting on the H-point and its feet ending on the ground. Returns the door's opening
   * angle the left hand implies (rad, monotonic), or null before it touches the door.
   */
  exit(t: number) {
    this.exitT = Math.max(0, Math.min(EXIT_S, t))
    return this.exitDoor
  }
  private exitT = -1
  /** 0 seated in the cabin, 1 stood clear of the car (stepping out). */
  outside() {
    return this.exitT < 0 ? 0 : smooth(1.6, 3.4, this.exitT)
  }
  private exitDoor: number | null = null
  private exitStart: { hips: THREE.Vector3; foot: number } | null = null

  private updateExit() {
    const host = this.host
    const B = host.bones()
    const o = this.opts
    const t = this.exitT
    const frame = o.wheel.object.parent!
    frame.updateWorldMatrix(true, false)
    const root = host.root
    // Clip frame 0, measured once: its hips (model space) and its lowest foot.
    if (!this.exitStart) {
      this.exitStart = host.atOrigin(() => {
        host.clipPose!(EXIT_CLIP, 0)
        host.model()!.updateMatrixWorld(true)
        const hips = B.Hips!.getWorldPosition(new THREE.Vector3())
        const foot = Math.min(B.LeftToeBase!.getWorldPosition(_v).y, B.RightToeBase!.getWorldPosition(_v).y)
        return { hips, foot }
      })
    }
    const st = this.exitStart
    const path = host.clipRoot!(EXIT_CLIP, t)
    host.clipPose!(EXIT_CLIP, t)
    // Car frame: model space with the model's +Z = the car's forward (-Z), +X = the driver's left (-X car).
    const H = worldOf(o.hip, new THREE.Vector3())
    const Hl = frame.worldToLocal(H.clone())
    // Ground under the car (car body frame y of the wheels' contact = the car root's origin).
    const ground = frame.worldToLocal(frame.parent ? frame.parent.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3()).y
    // The clip's own frame (frame-0 root at its origin, +Z forward, +X the driver's left) is placed in the car turned
    // by π (the car's forward is -Z), so a clip point v lands at Hl + Rπ(v − hips0). Root path: T(x, 0, z)·Ry(yaw).
    // Height: the seated start puts the clip's hips on the H-point; standing, the clip's floor (y = 0) is the ground.
    const stand = smooth(1.4, 3.6, t)
    const ySeat = Hl.y - st.hips.y
    const y = ySeat + (ground - ySeat) * stand
    const local = new THREE.Vector3(Hl.x + st.hips.x - path.x, y, Hl.z + st.hips.z - path.z)
    const rq = new THREE.Quaternion().setFromAxisAngle(_v.set(0, 1, 0), Math.PI + path.yaw)
    root.position.copy(frame.localToWorld(local))
    root.quaternion.copy(frame.getWorldQuaternion(new THREE.Quaternion())).multiply(rq)
    root.updateMatrixWorld(true)
    // The door: the left hand's angle about the hinge once it is out past the closed door's inner face.
    const door = o.doorHandle.parent
    if (door && t < 3.6) {
      const hinge = door.getWorldPosition(new THREE.Vector3())
      const handL = frame.worldToLocal(B.LeftHand!.getWorldPosition(new THREE.Vector3()))
      const hl = frame.worldToLocal(hinge.clone())
      const handleL = frame.worldToLocal(o.doorHandle.getWorldPosition(new THREE.Vector3()))
      // Closed door direction from the hinge (towards the handle); the hand's direction; opening = outward (-x).
      const a0 = Math.atan2(-(handleL.x - hl.x), handleL.z - hl.z)
      const a1 = Math.atan2(-(handL.x - hl.x), handL.z - hl.z)
      const ang = THREE.MathUtils.clamp(a1 - a0, 0, 1.2)
      // The hand pushes it; as the legs swing out it must be well open (they push it on with the knee and hip).
      if (t > EXIT_TOUCH) this.exitDoor = Math.max(this.exitDoor ?? 0, ang, 0.95 * smooth(1.3, 2.3, t))
    }
    const e = B.Head!.getWorldPosition(new THREE.Vector3()).addScaledVector(_v.set(0, 1, 0).applyQuaternion(root.quaternion), EYE_UP).addScaledVector(_v.set(0, 0, 1).applyQuaternion(root.quaternion), EYE_AHEAD)
    this.eyeLocal.copy(frame.worldToLocal(e))
    this.debug.exit = { t: +t.toFixed(2), door: this.exitDoor === null ? null : +this.exitDoor.toFixed(2), local: local.toArray().map((v) => +v.toFixed(2)), Hl: Hl.toArray().map((v) => +v.toFixed(2)), hips0: st.hips.toArray().map((v) => +v.toFixed(2)), path: [+path.x.toFixed(2), +path.z.toFixed(2), +path.yaw.toFixed(2)] } as never
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
    if (this.exitT >= 0 && host.clipPose) return this.updateExit()
    // Base pose: the Mixamo driving clip (arms, hands and fingers on a wheel, legs to the pedals).
    host.poseIdle(dt, DRIVE_CLIP)

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
    // Hips on the H-point; the torso reclined into the seat back as far as the arms still reach the rim with the
    // elbows comfortably bent (found once per seat), the head turned back level. The camera belongs at the head's eyes
    // (`seatEye`), so the arms are seen from where they really are.
    const place = (recline: number) => {
      root.position.copy(H)
      root.updateMatrixWorld(true)
      root.position.add(H.clone().sub(B.Hips!.getWorldPosition(_v))).addScaledVector(F, this.slide ?? 0)
      root.updateMatrixWorld(true)
      const per = recline / 3
      for (const n of ["Spine", "Spine1", "Spine2"]) turnWorld(B[n]!, R, per)
      if (B.Neck) turnWorld(B.Neck, R, -recline * 0.5)
      if (B.Head) turnWorld(B.Head, R, -recline * 0.5)
    }
    if (this.slide === null) {
      // The seat slid forward (or back) so the clip's fists come to the rim's plane: the clip was taken on a wheel
      // nearer the chest than this car's.
      this.slide = 0
      host.poseIdle(0, DRIVE_CLIP)
      place(0)
      const w = o.wheel
      w.object.updateWorldMatrix(true, false)
      const hub = w.object.getWorldPosition(new THREE.Vector3())
      const axisL = (w.axis ?? (w.object.userData.axis as THREE.Vector3 | undefined) ?? new THREE.Vector3(0, 0, -1)).clone().normalize()
      const nW = axisL.applyQuaternion(w.object.parent!.getWorldQuaternion(new THREE.Quaternion()))
      const d = (this.fistCentre("Left").sub(hub).dot(nW) + this.fistCentre("Right").sub(hub).dot(nW)) / 2
      // Distance along the car's forward that moves the fists d onto the plane, leaving a little elbow bend.
      this.slide = THREE.MathUtils.clamp((-d - SLIDE_SLACK) / Math.max(0.3, nW.dot(F)), -0.05, 0.2)
    }
    if (this.recline === null) {
      this.recline = 0
      for (const deg of [26, 22, 18, 14, 10, 6, 2]) {
        host.poseIdle(0, DRIVE_CLIP)
        place((deg * Math.PI) / 180)
        if (this.reachRatio() <= REACH_MAX) {
          this.recline = (deg * Math.PI) / 180
          break
        }
      }
      host.poseIdle(0, DRIVE_CLIP)
    }
    place(this.recline)
    this.debug.place = { reclineDeg: +((this.recline * 180) / Math.PI).toFixed(0), slide: +(this.slide ?? 0).toFixed(3) } as never

    // The wheel: hub, column axis (towards the dash), the turn since rest (world rotation about the hub).
    const w = o.wheel
    const wheel = w.object
    wheel.updateWorldMatrix(true, false)
    const hub = wheel.getWorldPosition(new THREE.Vector3())
    const axisL = (w.axis ?? (wheel.userData.axis as THREE.Vector3 | undefined) ?? new THREE.Vector3(0, 0, -1)).clone().normalize()
    const parentQ = wheel.parent!.getWorldQuaternion(new THREE.Quaternion())
    const wq = wheel.getWorldQuaternion(new THREE.Quaternion())
    const nW = axisL.clone().applyQuaternion(parentQ)
    const upW = new THREE.Vector3(0, 1, 0).addScaledVector(axisL, -axisL.y).normalize().applyQuaternion(parentQ)
    const rightW = new THREE.Vector3().crossVectors(nW, upW)
    // The hands follow the rim up to ±MAX_TURN; beyond that the rim slides through them.
    // The hands' share of the turn: the wheel's signed angle about the column, softly capped (HOLD·tanh(a/HOLD)): they
    // follow small corrections fully, then the rim slides through loosely held hands, so neither arm reaches up over
    // the top of the wheel on a sharp bend (the route's turn-off and parking go to ±230°).
    const tq = wq.clone().multiply(parentQ.clone().invert())
    if (tq.w < 0) tq.set(-tq.x, -tq.y, -tq.z, -tq.w)
    const signed = 2 * Math.atan2(_v.set(tq.x, tq.y, tq.z).dot(nW), tq.w)
    const follow = HOLD * Math.tanh(signed / HOLD)
    const turn = new THREE.Quaternion().setFromAxisAngle(nW, follow)

    const fits = this.fits!
    for (const side of ["Left", "Right"] as const) {
      const fit = fits[side]
      const hand = B[`${side}Hand`]!
      const fore = B[`${side}ForeArm`]!
      const arm = B[`${side}Arm`]!
      const P = (n: string) => B[n]!.getWorldPosition(new THREE.Vector3())
      // The clip's grip: the fist's centre (between the fingers' first and second segments, a little to the palm).
      const P0 = P(`${side}Hand`)
      const Q0 = hand.getWorldQuaternion(new THREE.Quaternion())
      const G0 = this.fistCentre(side)
      // Snapped onto the real rim (nearest point of the rim circle), then turned with the wheel.
      const g = G0.clone().sub(hub)
      const gp = g.clone().addScaledVector(nW, -g.dot(nW))
      const clipClock = Math.atan2(gp.dot(rightW), gp.dot(upW))
      // Hands at ten to two (the clip holds ~9 and 3, which from the driver's eyes is below the bottom of the frame):
      // the clip's hand rolled round the hub to the target clock position, then turned with the wheel.
      const clock = side === "Left" ? -GRIP_CLOCK : GRIP_CLOCK
      const roll = new THREE.Quaternion().setFromAxisAngle(nW, -(clock - clipClock))
      const S0 = hub.clone().addScaledVector(upW, Math.cos(clock) * w.radius).addScaledVector(rightW, Math.sin(clock) * w.radius)
      const G = S0.clone().sub(hub).applyQuaternion(turn).add(hub)
      const rot = turn.clone().multiply(roll)
      let handQ = rot.clone().multiply(Q0)
      let wrist = G.clone().sub(G0.clone().sub(P0).applyQuaternion(rot))
      let fistW = 0
      const E0 = P(`${side}ForeArm`)
      const A0 = P(`${side}Arm`)
      let pole = E0.clone().sub(A0.clone().add(P0).multiplyScalar(0.5))
      this.debug[side] = { clipClockDeg: +((clipClock * 180) / Math.PI).toFixed(0), clockDeg: +((clock * 180) / Math.PI).toFixed(0) } as never
      this.targets[side].copy(G)

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
        const A = arm.getWorldPosition(new THREE.Vector3())
        const reach = (A.distanceTo(fore.getWorldPosition(new THREE.Vector3())) + fore.getWorldPosition(new THREE.Vector3()).distanceTo(P0)) * 0.97
        if (t >= 0.9) this.released = Math.min(1, this.released + dt / 0.45)
        else this.released = 0
        const lap = H.clone().addScaledVector(F, 0.3).addScaledVector(U, 0.12).addScaledVector(R, -0.12)
        const qLap = this.palmQuat(U.clone().negate(), F.clone(), fit, side)
        const held = A.clone().add(atPanel.clone().sub(A).clampLength(0, reach))
        wrist = toHandle.lerp(held, b).lerp(lap, smooth(0, 1, this.released))
        handQ = handQ.clone().slerp(qh, a).slerp(qp, b).slerp(qLap, smooth(0, 1, this.released))
        fistW = Math.max(0, 1 - b) * (a < 0.5 ? 1 - Math.sin(Math.PI * a) * 0.7 : 1)
        pole = U.clone().multiplyScalar(-1).addScaledVector(R, -0.3).addScaledVector(F, -0.3)
      }

      // Reach: the shoulder blade comes forward towards the rim (up to ~25°) when the arm alone would straighten.
      const sh = B[`${side}Shoulder`]
      if (sh) {
        const A = arm.getWorldPosition(new THREE.Vector3())
        const len = A.distanceTo(E0) + E0.distanceTo(P0)
        const need = A.distanceTo(wrist) - len * REACH_MAX
        if (need > 0) {
          const base = sh.getWorldPosition(new THREE.Vector3())
          const a = A.clone().sub(base)
          const b = wrist.clone().sub(base)
          const ax = new THREE.Vector3().crossVectors(a, b)
          if (ax.lengthSq() > 1e-10) turnWorld(sh, ax, Math.min(0.45, a.angleTo(b), need / Math.max(0.05, a.length())))
        }
      }
      host.ik(arm, fore, hand, wrist, pole)
      // Half the hand's twist taken by the forearm (no candy-wrapped wrist), the rest by the hand.
      const local = fore.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(handQ)
      const tw = new THREE.Quaternion(0, local.y, 0, local.w).normalize()
      fore.quaternion.multiply(new THREE.Quaternion().slerp(tw, 0.5))
      fore.updateWorldMatrix(false, true)
      setWorldQuat(hand, handQ)
      if (fistW > 1e-3) host.fist(side, fistW)
    }
    model.updateMatrixWorld(true)
    // Automation/debug: where each fist ended up relative to its target (m), and the markers.
    for (const side of ["Left", "Right"] as const) {
      const f = this.fistCentre(side)
      ;(this.debug[side] as Record<string, number>).miss = +f.distanceTo(this.targets[side]).toFixed(3)
      this.fists[side].copy(f)
    }
    this.placeMarkers(hub, upW, rightW, w.radius, turn)
    // The eyes, in the car's frame (breathing included).
    const e = B.Head!.getWorldPosition(new THREE.Vector3()).addScaledVector(U, EYE_UP).addScaledVector(F, EYE_AHEAD)
    this.eyeLocal.copy(wheel.parent!.worldToLocal(e))
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
